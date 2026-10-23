// 内置 agent 系统的装配：注册表 + 模型 + 运行时 + 各工具模块。main.ts 只调这里。
import { HB_SILENT_SECS } from "../heartbeat.ts";
import { applyBudgets } from "./soul.ts";
import { VERSION } from "../cli.ts";
import { restartSelf } from "../util/restart.ts";
import type { Config, Dirs } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { AgentRegistry } from "./registry.ts";
import { ModelRegistry, FAKE_MODEL, type FakeLlm } from "./models.ts";
import { Runtime } from "./runtime.ts";
import { deviceTools } from "./tools/device.ts";
import { Memories } from "./tools/memory.ts";
import { OpenAIEmbedder } from "./memory.ts";
import { Scheduler } from "./scheduler.ts";
import { cronTools } from "./tools/cron.ts";
import { A2A } from "./a2a.ts";
import { Skills } from "./skills.ts";
import { execTools } from "./tools/exec.ts";
import { webTools } from "./tools/web.ts";
import { McpManager } from "./mcp.ts";
import { Extensions, extensionTools, setExtAgentDir } from "./extensions.ts";
import { PackageManager } from "./packages.ts";
import { Outbox } from "./outbox.ts";
import { proxiedFetch } from "../util/proxy.ts";
import { ChannelStore } from "../channels/store.ts";
import { ChannelManager } from "../channels/manager.ts";
import path from "node:path";

export interface AgentSystem {
  registry: AgentRegistry;
  models: ModelRegistry;
  runtime: Runtime;
  memories: Memories;
  scheduler: Scheduler | null;
  a2a: A2A;
  skills: Skills;
  channels: ChannelManager;
  mcp: McpManager;
  extensions: Extensions;
  packages: PackageManager;
  outbox?: Outbox;
}

export function createAgentSystem(cfg: Config, dirs: Dirs, fake: FakeLlm | null): AgentSystem {
  applyBudgets(cfg.promptBudgets);
  const registry = new AgentRegistry(dirs.agents);
  registry.load(cfg.roles);
  // 假服务商模式：所有 agent 都用按脚本回复的假模型
  const models = new ModelRegistry(fake ? { ...cfg.models, default: FAKE_MODEL, cheap: FAKE_MODEL } : cfg.models);
  if (fake) {
    models.enableFake(fake);
    for (const a of registry.list()) if (a.model) registry.update(a.id, { model: "" });
  }
  const runtime = new Runtime(registry, models, cfg.runtime);
  const memories = new Memories(runtime, cfg.embedding && !fake ? new OpenAIEmbedder(cfg.embedding) : null);
  runtime.addTools(memories.tools());
  runtime.beforeCompact = (agent, key) => memories.flush(agent, key);
  const skills = new Skills(dirs.skills);
  runtime.skillCatalog = (a) => skills.catalog(a);
  runtime.addTools(skills.tools());
  const a2a = new A2A(dirs.systemDb, runtime, registry, cfg.a2a);
  runtime.addTools(a2a.tools());
  // 执行命令（只给可信会话）+ 联网搜索 / 读网页。cfg.tools 由管理界面就地更新，改了立即生效
  runtime.addTools(execTools(cfg.tools));
  runtime.addTools(webTools(cfg.tools));
  // 扩展（pi 格式，agent 也能自己写）与 MCP 服务器；启动后由 main 在后台加载 / 连接（startPlugins）
  const mcp = new McpManager(path.join(cfg.dataDir, "mcp.json"), { fetch: proxiedFetch, cwd: cfg.dataDir, version: VERSION });
  const extensions = new Extensions(dirs.extensions, registry);
  extensions.onMcpServers = (list) => { mcp.setExtensionServers(list); mcp.reload().catch((e) => console.log(`[mcp] ⚠️  ${e.message}`)); };
  // pi 扩展包（pi.dev/packages 即 npm 上带 pi-package 关键字的包、git、本地、上传）：其中的扩展当全局扩展、技能当全局技能
  const packages = new PackageManager(dirs.packages, { fetch: proxiedFetch });
  extensions.packages = packages;
  packages.onChange = async () => { await extensions.reloadAll(); };
  skills.extraRoots = () => packages.enabled().flatMap((x) => x.res.skillRoots.map((root) => ({ root, pkg: x.rec.id })));
  setExtAgentDir(path.join(cfg.dataDir, "pi-agent"));
  runtime.addTools(extensionTools(extensions));
  runtime.addTools(extensions.tools(), { plugin: true });
  runtime.addTools(mcp.tools(), { plugin: true });
  const channels = new ChannelManager(new ChannelStore(path.join(cfg.dataDir, "channels.json")), runtime, registry);
  return { registry, models, runtime, memories, scheduler: null, a2a, skills, channels, mcp, extensions, packages };
}

/** 依赖 Ctx 的部分（设备工具要推送、拍照；调度器要投递）在 Ctx 建好之后接上 */
export function attachAgentSystem(sys: AgentSystem, ctx: Ctx) {
  const { runtime, registry } = sys;
  // IM 斜杠命令（/status /model /restart …）要用到的东西
  sys.channels.commands = {
    version: VERSION,
    scheduler: () => sys.scheduler,
    devices: () => [...ctx.hb.devices.entries()].map(([id, rec]) => {
      const ago = Date.now() / 1000 - rec.ts;
      return `${id} ${ago < 200 ? "在线" : `离线 ${Math.round(ago / 60)} 分钟`}${rec.data.bat != null ? `，电量 ${rec.data.bat}%` : ""}`;
    }),
    channelStatus: () => sys.channels.status(),
    update: () => ctx.updates?.line() ?? "",
    presence: { text: () => ctx.presenceText(), set: (s) => ctx.setPresence(s, ctx.presence?.dev ?? "cores3", "chat") },
    restart: (n) => {
      const kind = sys.channels.store.account(n.account)?.kind ?? "";
      restartSelf(ctx.cfg.dataDir, { ...n, from: kind });
    },
  };
  // 出口：所有说给主人听的话都经它（播不播按 voice_push 策略，由代码判断，不靠提示词）
  const presence = () => (ctx.presence?.status === "home" ? "home" as const : ctx.presence?.status === "away" ? "away" as const : null);
  const online = () => {
    const t = Date.now() / 1000;
    return [...ctx.hb.devices.entries()].filter(([, r]) => t - r.ts < HB_SILENT_SECS).map(([d]) => d);
  };
  ctx.agentPer = (id) => registry.get(id)?.per;
  const outbox = new Outbox({
    policy: () => ctx.cfg.voicePush ?? "presence",
    presence, onlineDevices: online, knownDevices: () => [...ctx.hb.devices.keys()],
    roleAgent: (dev) => ctx.roles.get(dev).agent,
    push: (text, dev, agentId) => ctx.sendPush(text, dev, agentId),
  });
  ctx.outbox = outbox;
  sys.outbox = outbox;
  // 主人在 IM / 网页里的回复顺带在设备上念（念不念、念到哪都由出口定）
  sys.channels.voice = {
    allowed: () => outbox.allowed(),
    device: (agentId) => outbox.pick(agentId) ?? null,
    push: (text, dev, agentId) => ctx.sendPush(text, dev, agentId),
  };
  const scheduler = new Scheduler(ctx.dirs.systemDb, runtime, registry, {
    async deliver(agentId, delivery, text) {
      if (delivery.startsWith("device:")) {
        // 投到设备也要过出口：按策略不播（主人不在家等）记为「静音」，不算失败
        const r = await outbox.say({ text, agentId, device: delivery.slice("device:".length), source: "job" });
        return r.played ? `device:${r.device}` : r.reason === "away" || r.reason === "policy" ? `muted:${r.reason}` : "";
      }
      if (delivery === "webchat") return "webchat";      // 运行记录里就是投递内容；网页聊天页面读取
      return (await sys.channels.deliver(delivery, text)) ? delivery : "";
    },
    busy(agentId, delivery) {
      const dev = delivery.startsWith("device:") ? delivery.slice("device:".length) : "";
      return (dev !== "" && (ctx.activeChats.get(dev) ?? 0) > 0) || runtime.busy(agentId, `${agentId}:main`);
    },
  });
  sys.scheduler = scheduler;
  // 后台子任务的结果回到发起方后，按消息来源转达：设备 → 推送语音；IM → 发回原聊天
  sys.a2a.announce = async (scope, text) => {
    const o = scope.origin ?? "";
    if (o.startsWith("device:")) await outbox.say({ text, agentId: scope.agentId, device: o.slice("device:".length), source: "subtask" });
    else if (/^(feishu|qq|onebot):/.test(o)) await sys.channels.deliver(o, text);
  };
  scheduler.syncHeartbeats();
  runtime.addTools(cronTools(scheduler));
  runtime.presence = () => ctx.presenceText();
  runtime.addTools(deviceTools({
    say: (text, agentId, device) => outbox.say({ text, agentId, device, source: "speak" }),
    captureAndWait: (dev) => ctx.captureAndWait(dev),
    presence: () => ctx.presenceText(),
    setPresence: (status) => ctx.setPresence(status, ctx.presence?.dev ?? "cores3", "chat"),
    schedules: ctx.schedules,
    defaultDevice: () => [...ctx.hb.devices.keys()][0] ?? "cores3",
  }));
}
