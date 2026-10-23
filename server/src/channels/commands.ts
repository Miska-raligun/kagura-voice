// IM 里的斜杠命令：在飞书 / QQ 里直接管服务端，不用回电脑开管理界面。
//
//   所有人：/help  /reset（/new）
//   只有主人（渠道白名单里标了 owner 的人）：
//     /status            服务端状态：版本、运行时长、模型、设备、今日用量、渠道、定时任务
//     /model [序号|服务商/模型|default]   看 / 切换这个聊天所用 agent 的模型
//     /agent [id]        看 / 切换这个聊天由哪个 agent 回复
//     /jobs              定时任务一览；/jobs run <id> 立即运行一个
//     /compact           压缩本会话（较早的对话总结成摘要）
//     /restart           重启服务端（重启完会在这个聊天里说一声）
//     /home  /away       告诉服务端「我在家 / 我出门了」（在家时私聊回复会同时在设备上播语音）
// 不认识的 /xxx 照常交给 agent（可能是它自己的约定）。
import os from "node:os";
import type { Runtime } from "../agent/runtime.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import type { Scheduler } from "../agent/scheduler.ts";
import type { ChannelStore } from "./store.ts";
import type { InboundMessage } from "./types.ts";

export interface CommandDeps {
  rt: Runtime;
  agents: AgentRegistry;
  store: ChannelStore;
  version: string;
  scheduler: () => Scheduler | null;
  /** 设备在线情况等一行行的摘要 */
  devices: () => string[];
  channelStatus: () => { id: string; kind: string; state: string; detail?: string }[];
  /** 安排重启（先回复再重启）；notice = 重启后在哪说一声 */
  restart: (notice: { account: string; chatId: string }) => void;
  /** 在家状态：读 / 写（主人手动纠正设备蓝牙没感知到的情况） */
  presence?: { text(): string; set(status: "home" | "away"): void };
  /** 角色表要跟着 agent 变（换绑 agent 后设备角色不受影响，这里不用；换模型不影响角色） */
  onAgentChanged?: () => void;
}

export interface CommandCtx { m: InboundMessage; owner: boolean; agentId: string; sessionKey: string }

const HELP_ALL = "/help 看命令  /reset 开始新对话";
const HELP_OWNER = [
  "/status 服务端状态",
  "/model 看模型；/model 2 或 /model 服务商/模型 切换；/model default 恢复默认",
  "/agent 看谁在回复；/agent <id> 换一个",
  "/jobs 定时任务；/jobs run <id> 立即运行",
  "/compact 压缩本会话",
  "/restart 重启服务端",
  "/home 我在家（回复同时在设备上播语音）；/away 我出门了",
];

const fmtDur = (s: number) => (s < 3600 ? `${Math.round(s / 60)} 分钟` : s < 86400 ? `${(s / 3600).toFixed(1)} 小时` : `${(s / 86400).toFixed(1)} 天`);
const fmtTime = (t: number | null) => (t ? new Date(t * 1000).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

/** 处理一条斜杠命令。返回要回复的文字；返回 null = 不是命令，交给 agent */
export async function runCommand(text: string, c: CommandCtx, d: CommandDeps): Promise<string | null> {
  const mt = /^\/([a-z]+)\b\s*(.*)$/is.exec(text.trim());
  if (!mt) return null;
  const cmd = mt[1].toLowerCase(), arg = mt[2].trim();
  const ownerOnly = () => "这个命令只有主人能用（在管理界面「渠道 → 白名单」里给自己标上「主人」）。";

  switch (cmd) {
    case "help":
      return c.owner ? ["可用命令：", HELP_ALL, ...HELP_OWNER].join("\n") : `可用命令：${HELP_ALL}`;

    case "reset": case "new":
      d.rt.store(c.agentId).reset(c.sessionKey);
      return "好，我们重新开始吧。";

    case "status": {
      if (!c.owner) return ownerOnly();
      const lines = [`Kagura ${d.version} · 已运行 ${fmtDur(process.uptime())} · 内存 ${Math.round(process.memoryUsage().rss / 1048576)}MB · ${os.hostname()}`];
      const today = new Date().toLocaleDateString("sv-SE");
      let calls = 0, cost = 0;
      for (const a of d.agents.list()) {
        const u = d.rt.store(a.id).usageByDay(1).find((x: any) => x.day === today) as any;
        calls += u?.calls ?? 0; cost += u?.cost ?? 0;
        lines.push(`${a.id === c.agentId ? "▶" : "·"} ${a.name}（${a.id}）模型 ${a.model || `${d.rt.models.defaultRef() || "未配置"}（默认）`}，今天 ${u?.calls ?? 0} 次`);
      }
      lines.push(`今天合计 ${calls} 次调用${cost ? `，约 ¥${cost.toFixed(2)}` : ""}`);
      const dev = d.devices();
      lines.push(dev.length ? `设备：${dev.join("；")}` : "设备：还没连上来过");
      if (d.presence) lines.push(`在家状态：${d.presence.text() || "不知道"}`);
      lines.push(`渠道：${d.channelStatus().map((s) => `${s.id}(${s.kind}) ${s.state}`).join("；") || "无"}`);
      const jobs = d.scheduler()?.list() ?? [];
      const bad = jobs.filter((j) => j.last_status === "error");
      lines.push(`定时任务：${jobs.filter((j) => j.enabled).length} 个启用 / 共 ${jobs.length} 个${bad.length ? `，${bad.length} 个上次失败（${bad.map((j) => j.name).join("、")}）` : ""}`);
      return lines.join("\n");
    }

    case "model": {
      if (!c.owner) return ownerOnly();
      const a = d.agents.get(c.agentId)!;
      const list = d.rt.models.list();
      const cur = a.model || d.rt.models.defaultRef();
      if (!arg) {
        return [`${a.name} 现在用：${cur || "未配置"}${a.model ? "" : "（全局默认）"}`, "可选：",
          ...list.map((m, i) => `${i + 1}. ${m.ref}${m.ref === cur ? " ✓" : ""}${m.input?.includes("image") ? "（能看图）" : ""}`),
          "发 /model 序号 切换，/model default 恢复全局默认"].join("\n");
      }
      if (/^default$|^默认$/i.test(arg)) {
        d.agents.update(a.id, { model: "" });
        return `${a.name} 改回全局默认模型：${d.rt.models.defaultRef() || "未配置"}`;
      }
      const ref = /^\d+$/.test(arg) ? list[Number(arg) - 1]?.ref : arg;
      if (!ref) return `没有第 ${arg} 个，发 /model 看列表`;
      try { d.rt.models.resolve(ref); } catch (e: any) { return e.message; }
      d.agents.update(a.id, { model: ref });
      return `好，${a.name} 之后用 ${ref}（所有渠道、设备上都生效）。`;
    }

    case "agent": {
      if (!c.owner) return ownerOnly();
      const list = d.agents.list();
      if (!arg) {
        return [`这个聊天现在由 ${d.agents.get(c.agentId)?.name}（${c.agentId}）回复。`, "可选：",
          ...list.map((a) => `· ${a.id}（${a.name}）${a.id === c.agentId ? " ✓" : ""}`), "发 /agent <id> 切换"].join("\n");
      }
      const a = d.agents.get(arg) ?? list.find((x) => x.name === arg);
      if (!a) return `没有 agent「${arg}」，发 /agent 看列表`;
      d.store.bind({ account: c.m.account, chatId: c.m.chatId, agent: a.id, label: c.m.chatType === "group" ? "群聊" : (c.m.senderName || c.m.sender) });
      return `好，这个聊天之后由 ${a.name}（${a.id}）回复。`;
    }

    case "jobs": {
      if (!c.owner) return ownerOnly();
      const s = d.scheduler();
      if (!s) return "调度器没在运行";
      const run = /^run\s+(\S+)$/i.exec(arg);
      if (run) {
        const j = s.get(run[1]) ?? s.list().find((x) => x.name === run[1]);
        if (!j) return `没有任务 ${run[1]}`;
        s.runNow(j.id).catch(() => {});
        return `已开始运行「${j.name}」，结果按它的投递设置送达。`;
      }
      const jobs = s.list().filter((j) => j.kind !== "heartbeat");
      if (!jobs.length) return "还没有定时任务";
      return jobs.slice(0, 30).map((j) => `${j.enabled ? "●" : "○"} ${j.name}（${j.id}，${j.agent}）下次 ${fmtTime(j.next_run)}${j.last_status ? `，上次 ${j.last_status === "ok" ? "成功" : j.last_status === "error" ? "失败" : j.last_status}` : ""}`).join("\n")
        + "\n发 /jobs run <id> 立即运行";
    }

    case "compact": {
      if (!c.owner) return ownerOnly();
      const r = await d.rt.compact(c.agentId, c.sessionKey);
      return r ? "压缩好了：较早的对话已总结成摘要。" : "对话还短，不用压缩。";
    }

    case "home": case "away": {
      if (!c.owner) return ownerOnly();
      if (!d.presence) return "在家状态不可用";
      d.presence.set(cmd);
      return cmd === "home" ? "好，记下你在家了。之后在这里聊，我的回复也会在家里设备上念出来。" : "好，记下你出门了，之后只发文字。";
    }

    case "restart":
      if (!c.owner) return ownerOnly();
      d.restart({ account: c.m.account, chatId: c.m.chatId });
      return "正在重启服务端，大约 10 秒后回来，好了我在这里说一声。";

    default:
      return null;
  }
}
