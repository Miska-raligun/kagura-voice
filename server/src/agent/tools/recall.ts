// 链式召回（借鉴 DeepSeek Super-agent 的 Chain of Recall，2026-11）：上下文里放不下的东西不硬塞，留一个编号，
// 她要细节时用 read_ref 按编号去取原文。编号从哪来：
//   - 截短的工具结果：「…读 ref=tool:<调用编号>」（这一轮的在内存里，之前的在库里，原文都没丢）
//   - 压缩摘要里的出处：「（#m123）」= 第 123 条消息（压缩只是打标记，原文还在库里）；读的时候连带前后几条
//   - 近况的会话编号：session:<会话>
//   - 记进会话的系统事件：task:<待办> / job:<定时任务> / a2a:<通信记录>（system.ts 登记解析函数，Runtime.refs）
// 再配一个 query：在当前会话的全部记录（含已压缩的）里按关键词找，摘要里没标出处时用。
// 只给可信会话（同 memory_get：陌生人不能借它翻主人的聊天）。别的 agent 的会话要有联系权限。
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Runtime } from "../runtime.ts";
import { messageText, TOOL_REF } from "../runtime.ts";
import type { RunScope } from "../scope.ts";
import type { AgentInfo, AgentRegistry } from "../registry.ts";
import { ok, fail } from "./device.ts";

/** 一次最多返回多少字（长的用 offset 接着读） */
export const READ_MAX = 12_000;
const ONE_MAX = 2000;

const when = (ts: number) => new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ROLE: Record<string, string> = { user: "用户", assistant: "她", toolResult: "工具结果" };
const line = (r: { id: number; ts: number; role: string; msg: any }, max = ONE_MAX) => {
  const t = messageText(r.msg).replace(/\s+\n/g, "\n").trim();
  const a = Array.from(t);
  return `[#m${r.id} ${when(r.ts)} ${ROLE[r.role] ?? r.role}] ${a.length > max ? a.slice(0, max).join("") + `…（这条共 ${a.length} 字，读 ref=m${r.id} 看全文）` : t}`;
};
/** 长文本分页 */
function page(text: string, offset: number): string {
  const a = Array.from(text);
  const from = Math.max(0, Math.min(offset, a.length));
  const part = a.slice(from, from + READ_MAX).join("");
  const rest = a.length - from - READ_MAX;
  return part + (rest > 0 ? `\n…（还有 ${rest} 字，用 offset=${from + READ_MAX} 接着读）` : "");
}

export function recallTools(rt: Runtime, agents: AgentRegistry) {
  return (scope: RunScope, agent: AgentInfo): AgentTool<any>[] => {
    if (!scope.trusted) return [];
    /** 会话 key 属于谁、能不能看 */
    const owner = (key: string) => { const a = key.slice(0, key.indexOf(":")); return a === agent.id || agents.canContact(agent.id, a) ? a : null; };
    return [{
      name: "read_ref", label: "按编号读原文",
      description: "按编号读原文：截短的工具结果（tool:…）、摘要里注的出处（#m123 或 m123，连带前后几条；m100-m130 读一段）、"
        + "近况里的会话（session:…）、系统记下的事（task:… / job:… / a2a:…）。只记得大概、编号又找不到时，用 query 在这个会话的全部记录（含已压缩的）里按关键词找。",
      parameters: Type.Object({
        ref: Type.Optional(Type.String({ description: "编号，如 tool:call_1、m123、m100-m130、session:main:main、task:abc" })),
        query: Type.Optional(Type.String({ description: "关键词（空格分开，都要出现），在当前会话的全部记录里找" })),
        offset: Type.Optional(Type.Number({ description: "长原文从第几个字接着读" })),
      }),
      async execute(_id, p: any) {
        const store = rt.store(agent.id);
        const offset = Math.max(0, Number(p.offset) || 0);
        const q = String(p.query ?? "").trim();
        if (q) {
          const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
          const hits = store.search(scope.sessionKey, words);
          return ok(hits.length ? hits.reverse().map((h) => line(h, 300) + (h.compacted ? "（已压缩）" : "")).join("\n") + "\n要前后文就读 ref=m<编号>" : `这个会话里没找到同时含「${words.join("」「")}」的记录`);
        }
        const ref = String(p.ref ?? "").trim().replace(/^#/, "");
        if (!ref) return fail("要给 ref（编号）或 query（关键词）");
        // 工具结果原文：这一轮的在内存里，之前的在库里
        if (ref.startsWith(TOOL_REF)) {
          const callId = ref.slice(TOOL_REF.length);
          const mem = scope.toolOriginals?.get(callId);
          if (mem !== undefined) return ok(page(mem, offset));
          const r = store.toolResult(scope.sessionKey, callId);
          if (!r) return fail(`这个会话里没有工具结果 ${ref}`);
          return ok(page(messageText(r.msg), offset));
        }
        // 一段消息 m100-m130
        let m = ref.match(/^m(\d+)\s*-\s*#?m?(\d+)$/);
        if (m) {
          const a = store.message(Number(m[1]));
          if (!a) return fail(`没有消息 m${m[1]}`);
          const rows = store.range(a.session, Number(m[1]), Number(m[2]), 40);
          return ok(page(rows.map((r) => line(r)).join("\n") + (rows.length >= 40 ? "\n（一次最多 40 条，后面的换个起点再读）" : ""), offset));
        }
        // 一条消息：带上前后各 2 条，看得出上下文
        m = ref.match(/^m(\d+)$/);
        if (m) {
          const r = store.message(Number(m[1]));
          if (!r) return fail(`没有消息 ${ref}`);
          if (offset || Array.from(messageText(r.msg)).length > ONE_MAX) return ok(page(`[#m${r.id} ${when(r.ts)} ${ROLE[r.role] ?? r.role}] ${messageText(r.msg)}`, offset));
          return ok(store.around(r.session, r.id, 2).map((x) => (x.id === r.id ? "→ " : "  ") + line(x)).join("\n"));
        }
        if (ref.startsWith("session:")) {
          const key = ref.slice("session:".length);
          const who = owner(key);
          if (!who) return fail(`没有权限看会话 ${key}`);
          const rows = rt.store(who).transcript(key, 12).filter((r) => r.role !== "toolResult");
          return ok(rows.length ? page(rows.map((r) => line(r as any, 500)).join("\n"), offset) : `会话 ${key} 是空的`);
        }
        const i = ref.indexOf(":");
        const fn = i > 0 ? rt.refs.get(ref.slice(0, i)) : undefined;
        if (!fn) return fail(`不认识的编号 ${ref}（认得 tool: / m数字 / session: / ${[...rt.refs.keys()].map((k) => k + ":").join(" / ")}）`);
        const out = fn(agent, ref.slice(i + 1), scope);
        return out === null ? fail(`没有 ${ref}（或者不是你的）`) : ok(page(out, offset));
      },
    }];
  };
}
