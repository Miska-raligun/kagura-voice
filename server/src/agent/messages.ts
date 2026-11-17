// 消息的整形：取给人看的文字、去掉系统附的回忆 / 备注、发给模型前合成一段、落盘前把图片换成引用。从 runtime.ts 拆出来的纯函数。
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";

/** 一条消息里给人看的那段话：用户消息取最后一段文字（前面那段是系统自动附的 [时间…]），助手消息取正文 */
export function plainOf(m: any): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  const texts = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => String(c.text));
  return (m.role === "user" ? texts.at(-1) ?? "" : texts.join("")).trim();
}

export function messageText(m: any): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content ?? []).map((c: any) => {
    if (c.type === "text") return c.text;
    if (c.type === "toolCall") return `[调用 ${c.name} ${JSON.stringify(c.arguments)}]`;
    if (c.type === "image") return "[图片]";
    return "";
  }).join("");
}

/** 自动回忆附在用户消息里的那一段（开头这几个字认它，落盘前去掉） */
export const RECALL_TAG = "[相关记忆（系统按这句话自动检索的，不是主人说的，可能不全）]";
export const RECALL_WAIT_MS = 2000;
/** 系统每轮附的备注（见 Runtime.turnNotes），落盘前和自动回忆一起去掉 */
export const TURN_NOTE_TAG = "[系统备注：你这边正在后台进行的事（系统自动附的，不是主人说的）]";
export function stripRecall(m: Message): Message {
  if (m.role !== "user" || !Array.isArray(m.content)) return m;
  const content = m.content.filter((c: any) => !(c.type === "text" && (String(c.text).startsWith(RECALL_TAG) || String(c.text).startsWith(TURN_NOTE_TAG))));
  return content.length === m.content.length ? m : { ...m, content } as Message;
}

/** 合成一段时，系统附的参考和这条消息之间的分隔（只在有自动回忆 / 系统备注时加） */
export const MSG_DIVIDER = "（以上是系统附的参考，不是这条消息的内容。下面才是这条消息：）";

/**
 * 发给模型前，把一条用户消息里的几段文字合成一段（LRN 2026-11-07，症状「她说正文消息是空的，然后从记忆里找到了我发的话」）。
 * 一轮的用户消息是好几段拼的：[时间…]、自动回忆、系统备注、最后才是主人说的话。按多段格式发出去，有的兼容 OpenAI 的服务商
 * 只认第一段（只看到时间 → 「正文是空的」），有的把几段首尾直接粘起来（主人的话贴在记忆列表最后一条后面 → 当成记忆里的内容）。
 * 合成一段、空行隔开，有参考块时再明确标出哪部分才是这条消息；图片照常放前面。库里存的还是分段的（落盘前去掉回忆 / 备注靠分段）
 */
export function flattenUser<T extends { role: string; content?: any }>(msgs: T[]): T[] {
  return msgs.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const texts = m.content.filter((c: any) => c.type === "text" && String(c.text).trim()).map((c: any) => String(c.text));
    if (texts.length < 2) return m;
    const others = m.content.filter((c: any) => c.type !== "text");
    const ctx = texts.slice(0, -1);
    const refs = ctx.some((t) => t.startsWith(RECALL_TAG) || t.startsWith(TURN_NOTE_TAG));
    const text = [...ctx, ...(refs ? [MSG_DIVIDER] : []), texts.at(-1)!].join("\n\n");
    return { ...m, content: [...others, { type: "text", text }] };
  });
}

/**
 * 落盘前把图片换成文字引用：base64 图片进库会让每轮上下文都背着几百 KB。
 * 图片本身存进 agent 工作目录 uploads/<日期>/img-<哈希>.<扩展名>（同一张只存一份），记录里留「[图片 路径]」——
 * 管理界面凭路径显示，agent 以后也能用 exec 处理它。存不下来就退回「[图片]」。
 */
export const IMAGE_REF_RE = /^\[图片 (uploads\/[^\]]+)\]$/;
export function stripImages(m: Message, workspace?: string): Message {
  if ((m.role === "user" || m.role === "toolResult") && Array.isArray(m.content)) {
    return { ...m, content: m.content.map((c: any) => (c.type === "image" ? { type: "text", text: saveImageRef(c, workspace) } : c)) } as Message;
  }
  return m;
}

function saveImageRef(c: { data: string; mimeType: string }, workspace?: string): string {
  if (!workspace || !c.data) return "[图片]";
  try {
    const buf = Buffer.from(c.data, "base64");
    const ext = /png/.test(c.mimeType) ? "png" : /webp/.test(c.mimeType) ? "webp" : /gif/.test(c.mimeType) ? "gif" : "jpg";
    const rel = `uploads/${new Date().toLocaleDateString("sv-SE")}/img-${createHash("sha1").update(buf).digest("hex").slice(0, 12)}.${ext}`;
    const abs = path.join(workspace, ...rel.split("/"));
    if (!fs.existsSync(abs)) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, buf); }
    return `[图片 ${rel}]`;
  } catch { return "[图片]"; }
}

/** 一条助手消息只有思考、没有正文也没调工具 */
export function silentMsg(m: any): boolean {
  const c = m?.content ?? [];
  return !c.some((x: any) => (x.type === "text" && String(x.text).trim()) || x.type === "toolCall");
}
export const NUDGE_TEXT = "[系统] 你刚才只在心里想了，没有说出来，主人什么都没收到。现在直接把要对主人说的话写出来（不用再想，也不要再调工具）。";

/**
 * 回复写到一半撞上输出上限（借鉴 deepseek-ai/chat-demo 的「继续生成」，2026-11）：最后一条助手消息 stopReason = length、
 * 写了正文、没调工具。以前这半截原样交出去，主人收到的话断在半句上。现在在同一轮里让她从断开处接着写，最多 CONTINUE_MAX 次，
 * 接上的正文并回那条消息（催的那句不进历史）。chat-demo 用的是 Anthropic 接口的「末尾助手消息 = 续写前缀」，
 * OpenAI 兼容接口各家不一（DeepSeek 要 beta 地址 + prefix 字段），所以这里用一句系统提示，哪家都能用。
 * 调工具时被截断的不接（工具参数写了一半，接不上）。
 */
export const CONTINUE_MAX = 2;
export function truncatedMsg(m: any): boolean {
  if (m?.role !== "assistant" || m.stopReason !== "length") return false;
  const c = m.content ?? [];
  return !c.some((x: any) => x.type === "toolCall") && c.some((x: any) => x.type === "text" && String(x.text).trim());
}
export function continueText(m: any): string {
  const text = (m?.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
  const tail = Array.from(text.trimEnd()).slice(-30).join("");
  return `[系统] 你上一条回复写到输出长度上限被截断了，最后几个字是「${tail}」。从断开的地方直接接着写，别重复已经写过的、别解释、别打招呼（不用再想，也不要调工具）。`;
}
function addUsage(a: any, b: any): any {
  if (!a || !b) return a ?? b;
  const n = (k: string) => (a[k] ?? 0) + (b[k] ?? 0);
  const cost: any = {};
  for (const k of new Set([...Object.keys(a.cost ?? {}), ...Object.keys(b.cost ?? {})])) cost[k] = (a.cost?.[k] ?? 0) + (b.cost?.[k] ?? 0);
  return { ...a, input: n("input"), output: n("output"), cacheRead: n("cacheRead"), cacheWrite: n("cacheWrite"), totalTokens: n("totalTokens"), cost };
}
/** 截断的那条 + 「接着写」+ 接上的那条 → 一条（接上的又调了工具就不并，那句提示照常留在历史里） */
export function mergeContinued(msgs: Message[]): Message[] {
  const out = [...msgs];
  for (let i = out.findIndex((m: any) => m.kcont); i >= 0; i = out.findIndex((m: any) => m.kcont)) {
    const prev: any = out[i - 1], next: any = out[i + 1];
    const { kcont, ...plain } = out[i] as any;
    if (prev?.role === "assistant" && next?.role === "assistant" && !(next.content ?? []).some((c: any) => c.type === "toolCall")) {
      const merged = { ...prev, content: [...prev.content, ...(next.content ?? []).filter((c: any) => c.type === "text")], stopReason: next.stopReason, usage: addUsage(prev.usage, next.usage) };
      out.splice(i - 1, 3, merged);
    } else if (next) out[i] = plain as Message;
    else out.splice(i, 1);
  }
  return out;
}

/** 模型正常结束却一个字没说、也没调工具（上下文快满时有的服务商会这样直接收尾）：execute 抛这个，run 压一压再试一次 */
export const EMPTY_RE = /^空回复：/;
