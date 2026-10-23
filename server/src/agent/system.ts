// 内置 agent 系统的装配：注册表 + 模型 + 运行时 + 各工具模块。main.ts 只调这里。
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
import { Extensions, extensionTools } from "./extensions.ts";
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
  runtime.addTools(extensionTools(extensions));
  runtime.addTools(extensions.tools());
  runtime.addTools(mcp.tools());
  const channels = new ChannelManager(new ChannelStore(path.join(cfg.dataDir, "channels.json")), runtime, registry);
  return { registry, models, runtime, memories, scheduler: null, a2a, skills, channels, mcp, extensions };
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
    restart: (n) => {
      const kind = sys.channels.store.account(n.account)?.kind ?? "";
      restartSelf(ctx.cfg.dataDir, { ...n, from: kind });
    },
  };
  const scheduler = new Scheduler(ctx.dirs.systemDb, runtime, registry, {
    async deliver(agentId, delivery, text) {
      if (delivery.startsWith("device:")) {
        const dev = delivery.slice("device:".length);
        const ok = await ctx.sendPush(text, dev, registry.get(agentId)?.per);
        return ok ? delivery : "";
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
    if (o.startsWith("device:")) await ctx.sendPush(text, o.slice("device:".length), registry.get(scope.agentId)?.per);
    else if (/^(feishu|qq|onebot):/.test(o)) await sys.channels.deliver(o, text);
  };
  scheduler.syncHeartbeats();
  runtime.addTools(cronTools(scheduler));
  runtime.presence = () => ctx.presenceText();
  runtime.addTools(deviceTools({
    push: (text, dev, per) => ctx.sendPush(text, dev, per),
    captureAndWait: (dev) => ctx.captureAndWait(dev),
    presence: () => ctx.presenceText(),
    schedules: ctx.schedules,
    defaultDevice: () => [...ctx.hb.devices.keys()][0] ?? "cores3",
  }));
}
