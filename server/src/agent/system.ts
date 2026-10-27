// 内置 agent 系统的装配：注册表 + 模型 + 运行时 + 各工具模块。main.ts 只调这里。
import { HB_SILENT_SECS } from "../heartbeat.ts";
import { applyBudgets, applyLoadout } from "./soul.ts";
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
import { roleVoice } from "../roles.ts";
import { proxiedFetch } from "../util/proxy.ts";
import { ChannelStore } from "../channels/store.ts";
import { ChannelManager } from "../channels/manager.ts";
import path from "node:path";
import { TaskQueue } from "./tasks.ts";
import { taskTools } from "./tools/tasks.ts";

export interface AgentSystem {
  registry: AgentRegistry;
  models: ModelRegistry;
  runtime: Runtime;
  memories: Memories;
  scheduler: Scheduler | null;
  tasks: TaskQueue | null;
  a2a: A2A;
  skills: Skills;
  channels: ChannelManager;
  mcp: McpManager;
  extensions: Extensions;
  packages: PackageManager;
  outbox?: Outbox;
  /** 已经以文字发出去的回复顺带念一遍（网页聊天用） */
  mirror?: (agentId: string, text: string, source: string, meta?: { announced?: boolean }) => Promise<void>;
}

export function createAgentSystem(cfg: Config, dirs: Dirs, fake: FakeLlm | null): AgentSystem {
  applyBudgets(cfg.promptBudgets);
  applyLoadout(cfg.promptFiles);
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
  const channels = new ChannelManager(new ChannelStore(path.join(cfg.dataDir, "channels.json")), runtime, registry, undefined, path.join(cfg.dataDir, "channels_seen.json"));
  return { registry, models, runtime, memories, scheduler: null, tasks: null, a2a, skills, channels, mcp, extensions, packages };
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
  // 出口：agent 说给主人听的每一句话都经它，播不播、播到哪由系统定（agent 没有 speak 工具，也不用管）
  const presence = () => (ctx.presence?.status === "home" ? "home" as const : ctx.presence?.status === "away" ? "away" as const : null);
  // 在线 = 心跳没断的设备 + 页面开着（SSE 连着）的手机。手机没开页面推了也收不到，就不算
  const online = () => {
    const t = Date.now() / 1000;
    const devs = [...ctx.hb.devices.entries()].filter(([, r]) => t - r.ts < HB_SILENT_SECS).map(([d]) => d);
    const phones = (ctx.clients?.list() ?? []).map((c) => c.id).filter((id) => ctx.clients!.online(id));
    return [...devs, ...phones];
  };
  ctx.agentVoice = (id) => { const a = registry.get(id); return a ? roleVoice(a) : undefined; };
  const outbox = new Outbox({
    policy: () => ctx.cfg.voicePush ?? "presence",
    rolePush: () => ctx.cfg.rolePush ?? "hold",
    presence, onlineDevices: online,
    knownDevices: () => [...ctx.hb.devices.keys(), ...(ctx.clients?.list() ?? []).map((c) => c.id)],
    portable: (dev) => !!ctx.clients?.list().some((c) => c.id === dev),
    roleAgent: (dev) => ctx.roles.get(dev).agent,
    hasRole: (agentId) => ctx.roles.all().some((r) => r.agent === agentId),
    busy: (dev) => (ctx.activeChats.get(dev) ?? 0) > 0,
    push: (text, dev, agentId) => ctx.sendPush(text, dev, agentId),
  }, path.join(ctx.cfg.dataDir, "held_messages.json"));
  ctx.outbox = outbox;
  sys.outbox = outbox;
  // 设备切到某个角色（问候之后）：把留给它的话播出来
  ctx.onRoleSwitch = (dev) => outbox.flush(dev);
  /**
   * 已经以文字发出去的回复（IM、网页、投到 IM 的任务）顺带念一遍：短的去掉格式直接念，长的用便宜模型压成口语（按 agent 的语音字数）。
   * 这一轮已经用 announce 传过话的不再念，免得播两遍；按策略本来就不播的不去调模型。
   */
  const mirror = async (agentId: string, text: string, source: string, meta?: { announced?: boolean }) => {
    if (meta?.announced || !text || !outbox.allowed()) return;
    try {
      const said = await runtime.spoken(agentId, text);
      if (said) await outbox.say({ text: said, agentId, mirror: true, source });
    } catch (e: any) { console.log(`[outbox] ⚠️  顺带朗读失败: ${e.message}`); }
  };
  sys.channels.voice = { say: (agentId, text, meta) => mirror(agentId, text, "im", meta) };
  sys.mirror = mirror;
  const scheduler = new Scheduler(ctx.dirs.systemDb, runtime, registry, {
    async deliver(agentId, delivery, text, meta) {
      if (delivery.startsWith("device:")) {
        // 只投设备：按策略不播记为「静音」、角色不对记为「留言」，都不算失败
        const r = await outbox.say({ text, agentId, device: delivery.slice("device:".length), source: "job" });
        return r.played ? `device:${r.device}` : r.held ? `held:${r.device}` : r.reason === "away" || r.reason === "policy" ? `muted:${r.reason}` : "";
      }
      const ok = delivery === "webchat" || (await sys.channels.deliver(delivery, text));   // webchat：运行记录里就是投递内容
      if (ok) await mirror(agentId, text, "job", meta);
      return ok ? delivery : "";
    },
    busy(agentId, delivery) {
      const dev = delivery.startsWith("device:") ? delivery.slice("device:".length) : "";
      return (dev !== "" && (ctx.activeChats.get(dev) ?? 0) > 0) || runtime.busy(agentId, `${agentId}:main`);
    },
  });
  sys.scheduler = scheduler;
  // 待办：夜间静默时段一件件做，早上按来源汇报
  const report = async (agentId: string, origin: string, text: string): Promise<string> => {
    if (origin.startsWith("device:")) {
      const said = await runtime.spoken(agentId, text).catch(() => text);
      const r = await outbox.say({ text: said || text, agentId, device: origin.slice("device:".length), source: "task" });
      return r.played ? origin : r.held ? `held:${r.device}` : r.reason ? `muted:${r.reason}` : "";
    }
    if (/^(feishu|qq|onebot):/.test(origin)) {
      const ok = await sys.channels.deliver(origin, text);
      if (ok) await mirror(agentId, text, "task");
      return ok ? origin : "";
    }
    // 网页聊天 / 管理界面记的：送到 agent 的 heartbeat 投递目标（没设就只在管理界面看）
    const d = registry.get(agentId)?.heartbeat.delivery ?? "";
    return d && d !== "none" && d !== "webchat" && d !== origin ? report(agentId, d, text) : "";
  };
  const tasks = new TaskQueue(ctx.dirs.systemDb, registry, { run: (req) => runtime.run(req), report });
  sys.tasks = tasks;
  runtime.addTools(taskTools(tasks));
  // 后台子任务的结果回到发起方后，按消息来源转达：设备 → 推送语音；IM → 发回原聊天并顺带念
  sys.a2a.announce = async (scope, text) => {
    const o = scope.origin ?? "";
    if (o.startsWith("device:")) await outbox.say({ text, agentId: scope.agentId, device: o.slice("device:".length), source: "subtask" });
    else if (/^(feishu|qq|onebot):/.test(o) && (await sys.channels.deliver(o, text))) await mirror(scope.agentId, text, "subtask");
  };
  scheduler.syncHeartbeats();
  runtime.addTools(cronTools(scheduler));
  runtime.presence = () => ctx.presenceText();
  runtime.addTools(deviceTools({
    announce: (text, agentId, device) => outbox.say({ text, agentId, device, relay: true, source: "announce" }),
    captureAndWait: (dev) => ctx.captureAndWait(dev),
    presence: () => ctx.presenceText(),
    setPresence: (status) => ctx.setPresence(status, ctx.presence?.dev ?? "cores3", "chat"),
    schedules: ctx.schedules,
    defaultDevice: () => [...ctx.hb.devices.keys()][0] ?? "cores3",
  }));
}
