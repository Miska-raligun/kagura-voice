// 上下文大小的估算与修整：token 估算、截短工具结果、去掉没配对的工具调用。从 runtime.ts 拆出来的，都是不碰会话状态的纯函数。
import type { Message } from "@earendil-works/pi-ai";

/** 粗估 token：中日韩字符按 1 个，其余按 4 字符 1 个。只用来判断要不要压缩，不用精确 */
export function estimateTokens(text: string): number {
  let cjk = 0, other = 0;
  for (const ch of text) (/[　-鿿豈-﫿＀-￯]/.test(ch) ? cjk++ : other++);
  return cjk + Math.ceil(other / 4);
}

/** 一个工具的定义占多少 token（估算）：每次调模型都要带上 */
export const toolTokens = (t: { name: string; description: string; parameters: unknown }) => estimateTokens(JSON.stringify([t.name, t.description, t.parameters]));

/**
 * 发给模型前把历史里没配对的工具调用 / 结果去掉：服务商要求每条工具结果都能找到前面那次调用、每次调用都有结果，
 * 缺一边就整个请求 400（2026-10-30 heartbeat 会话被按条数硬切后就是这样，之后每轮都失败）。库里不动，只是这次不发
 */
export function repairHistory(msgs: Message[], label = ""): Message[] {
  const calls = new Set<string>(), results = new Set<string>();
  for (const m of msgs as any[]) {
    if (m.role === "assistant") for (const c of m.content ?? []) if (c.type === "toolCall") calls.add(c.id);
    if (m.role === "toolResult") results.add(m.toolCallId);
  }
  let fixed = 0;
  const out: Message[] = [];
  for (const m of msgs as any[]) {
    if (m.role === "toolResult" && !calls.has(m.toolCallId)) { fixed++; continue; }
    if (m.role === "assistant" && (m.content ?? []).some((c: any) => c.type === "toolCall" && !results.has(c.id))) {
      const content = m.content.filter((c: any) => !(c.type === "toolCall" && !results.has(c.id)));
      fixed++;
      if (content.length) out.push({ ...m, content });
      continue;
    }
    out.push(m);
  }
  if (fixed) console.log(`[agent] 🩹 ${label} 历史里有 ${fixed} 处工具调用 / 结果没配对，这次发给模型时先去掉`);
  return out;
}

/**
 * 上下文预算（LRN 2026-10-30，症状「compact 不生效、上下文爆了不回复、回复很慢」）：
 *   ① 以前只拿「历史」跟阈值比，系统提示（人设 + 记忆 + 近况，几万字）、工具定义、输出预留都没算——历史没到阈值，整个请求已经超了模型窗口；
 *   ② 压缩后按条数留最近 30 条：一轮干活十几次工具调用就 20 多条，留下的几条大工具结果（网页 1.2 万字、命令输出）本身就超阈值，压了等于没压；
 *   ③ 一轮里工具调来调去，上下文在这一轮中途就撑爆，回复前的压缩管不到。
 * 现在：阈值 = min(agent 设置, (窗口 − 系统提示 − 工具定义 − 输出预留) × 85%)；压缩后按 token 留最近的（KEEP_RATIO）；
 * 每次调模型前（transformContext）把之前几轮的工具结果截到开头一段、这一轮的单条也有上限，还超就从这一轮最早的开始截；
 * 服务商报「上下文超长」就压一次再重试一次；回复后接近阈值的在后台先压，下一轮不用等。
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** 压缩后留下的最近消息最多占阈值的多少 */
export const KEEP_RATIO = 0.3;
/** 之前几轮的工具结果在上下文里只留开头这么多字（她当时已经看过，结论在回复里；要细节就重新调） */
export const OLD_TOOL_CHARS = 600;
/** 这一轮里单条工具结果最多带多少字进上下文 */
export const TOOL_RESULT_MAX_CHARS = 16_000;

/** 一条消息算多少 token：含思考内容（有的服务商会把它原样发回去） */
export function msgTokens(m: any): number {
  if (!m) return 0;
  if (typeof m.content === "string") return estimateTokens(m.content);
  let n = 0;
  for (const c of m.content ?? []) {
    if (c.type === "text") n += estimateTokens(String(c.text ?? ""));
    else if (c.type === "thinking") n += estimateTokens(String(c.thinking ?? ""));
    else if (c.type === "toolCall") n += estimateTokens(JSON.stringify(c.arguments ?? {})) + 10;
    else if (c.type === "image") n += 1500;
  }
  return n;
}

/**
 * 截短工具结果。readable = 这一轮有 read_ref：留一个指回原文的编号（tool:<调用编号>），她要细节就去读，
 * 不用把工具再跑一遍（有的工具重跑有副作用、要花钱；原文本来就在库里 / 这一轮的在内存里）——链式召回的「溢出留指针」
 */
export const TOOL_REF = "tool:";
const clipText = (m: any, max: number, readable = false) => ({
  ...m,
  content: (m.content ?? []).map((c: any) => c.type === "text" && String(c.text).length > max
    ? { ...c, text: `${String(c.text).slice(0, max)}\n…（工具结果已截短，原文 ${String(c.text).length} 字；`
      + (readable && m.toolCallId ? `要细节用 read_ref 读 ref=${TOOL_REF}${m.toolCallId}，不用重跑工具）` : "要细节就再调一次工具）") } : c),
});

/** 进上下文前截短工具结果：之前几轮的只留开头；这一轮的单条有上限，总量还超 budget 就从这一轮最早的开始截 */
export function pruneToolResults<T extends { role: string }>(msgs: T[], budget = Infinity, readable = false): T[] {
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { lastUser = i; break; }
  const out = msgs.map((m, i) => (m.role === "toolResult" && Array.isArray((m as any).content) ? clipText(m, i < lastUser ? OLD_TOOL_CHARS : TOOL_RESULT_MAX_CHARS, readable) : m)) as T[];
  if (budget === Infinity) return out;
  let size = out.reduce((n, m) => n + msgTokens(m), 0);
  for (let i = Math.max(0, lastUser); i < out.length && size > budget; i++) {
    if (out[i].role !== "toolResult") continue;
    const before = msgTokens(out[i]);
    out[i] = clipText(out[i], OLD_TOOL_CHARS, readable) as T;
    size -= before - msgTokens(out[i]);
  }
  return out;
}

/** 服务商报的「上下文超长」 */
export const OVERFLOW_RE = /context[_ ]?(length|window)|maximum context|prompt is too long|too many tokens|input (length|tokens?)|token limit|exceed(s|ed)? .*(context|token)|上下文.*(超|长)|超长|超出.*(长度|限制)/i;
