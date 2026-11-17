// 近况：从库里摘最近别处（本 agent 的其它会话 + 其他 agent）跟主人的往来，放进系统提示。从 runtime.ts 拆出来的。
import type { AgentRegistry, AgentInfo } from "./registry.ts";
import type { AgentStore } from "./store.ts";
import { BUDGETS } from "./soul.ts";
import { plainOf } from "./messages.ts";

const SILENT = /^\s*(HEARTBEAT_OK|NO_REPLY)\s*[。.!！]?\s*$/i;
/** 系统替主人发起的那些「用户消息」（heartbeat、定时任务、系统事件、别的 agent 传话）：不是主人说的，近况里不算 */
const NOT_OWNER = /^\s*\[(heartbeat|定时任务|系统事件|来自 |子任务|这条消息是|待办|后台命令|主人补充|通知[：:])/;
const CHANNEL_NAME: Record<string, string> = { device: "设备", webchat: "网页", feishu: "飞书", qq: "QQ", onebot: "QQ", system: "定时", a2a: "agent 间" };
/** 近况看多久以内的 */
export const RECENT_HOURS = 48;

/**
 * 近况（LRN 2026-10-26，症状「heartbeat 主动聊天老问已经说过的事；另一个 agent 又问一遍」）：
 * 每个会话只看得见自己的历史——飞书私聊、网页聊天、独立定时任务、别的 agent 各说各的，跨会话只能靠 agent 自己写记忆文件。
 * 这里直接从库里摘最近 RECENT_HOURS 小时、别处（自己的其它会话 + 其他 agent）跟主人的往来，按时间排好放进系统提示，
 * 并明说「说过的别再问、别再重复」。零额外模型调用；字数上限 BUDGETS.recent（0 = 关）。
 */
export function recentActivity(agents: AgentRegistry, storeOf: (agentId: string) => AgentStore, agent: AgentInfo, currentKey: string, lookup = false): string {
  const budget = BUDGETS.recent ?? 0;
  if (budget <= 0) return "";
  const since = Date.now() / 1000 - RECENT_HOURS * 3600;
  const items: { ts: number; line: string; ref: string }[] = [];
  // 同一句话可能同时在 heartbeat 会话和接收方会话里（主动消息会记进接收方会话），只列一次
  const seenText = new Set<string>();
  for (const a of agents.list()) {
    let rows: ReturnType<AgentStore["recentOwnerMessages"]>;
    try { rows = storeOf(a.id).recentOwnerMessages(since, a.id === agent.id ? currentKey : "", 200); } catch { continue; }
    const mine = a.id === agent.id;
    for (const r of rows) {
      let msg: any;
      try { msg = JSON.parse(r.data); } catch { continue; }
      const text = plainOf(msg).replace(/\s+/g, " ");
      if (!text || SILENT.test(text)) continue;
      if (r.role === "user" && NOT_OWNER.test(text)) continue;
      const where = CHANNEL_NAME[r.channel] ?? r.channel;
      const who = r.role === "user" ? "主人" : mine ? "你" : a.name;
      const dedup = `${a.id}|${r.role}|${text.slice(0, 160)}`;
      if (seenText.has(dedup)) continue;
      seenText.add(dedup);
      const tag = mine ? where : `${a.name}·${where}`;
      const d = new Date(r.ts * 1000);
      const when = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      items.push({ ts: r.ts, line: `- ${when} [${tag}#] ${who}：${Array.from(text).slice(0, 160).join("")}`, ref: `${a.id}\u0000${r.key}` });
    }
  }
  if (!items.length) return "";
  items.sort((x, y) => y.ts - x.ts);
  // 每个会话一个编号（借鉴 DeepSeek Super-agent 的 Chain of Recall）：每条截到 160 字，要前后文时凭编号去查那个会话，
  // 不用把整段对话塞进来。编号按出现先后排，同一会话的几条共用一个
  const refs = new Map<string, number>();
  const out: string[] = [];
  let used = 0;
  for (const it of items) {
    const n = refs.get(it.ref) ?? refs.size + 1;
    const line = lookup ? it.line.replace(/#\]/, ` #${n}]`) : it.line.replace(/#\]/, "]");
    const legend = lookup && !refs.has(it.ref) ? 30 : 0;
    used += line.length + 1 + legend;
    if (used > budget) break;
    refs.set(it.ref, n);
    out.push(line);
  }
  const legend = lookup && refs.size
    ? "\n会话编号（要看前后文就用 read_ref 读 ref=session:<会话>）：" + [...refs.entries()].map(([k, n]) => { const [, key] = k.split("\u0000"); return `#${n} = session:${key}`; }).join("；")
    : "";
  return "<recent_activity>\n最近两天在别的对话里（你在其它渠道、以及家里其他 agent）跟主人的往来，按时间排列、已截断。"
    + "这些都已经发生过：主人说过的事别再问，你或别人已经说过的话别再重复，需要时自然地接上。\n"
    + out.reverse().join("\n") + legend + "\n</recent_activity>";
}
