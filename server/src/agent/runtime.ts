// Agent 运行时（§5 runtime）：每轮 = 组装上下文（soul + 历史 + 摘要）→ pi Agent 跑一轮 → 工具执行 → 落盘。
//
// - 会话落 agent.sqlite，服务端重启不丢上下文
// - 每会话串行（同一会话的消息排队），全局并发上限可配（默认 4）；嵌套调用（a2a 等待对方回复）
//   不占全局名额，否则 4 个互相等待的 agent 就能把系统锁死
// - 历史超过阈值先做「记忆冲刷」再用便宜模型把较早的部分总结成摘要（§6.2）
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message } from "@earendil-works/pi-ai";
import type { AgentRegistry, AgentInfo } from "./registry.ts";
import { stripThinkText, type ModelRegistry } from "./models.ts";
import { AgentStore } from "./store.ts";
import { toSpoken } from "../util/text.ts";
import { BUDGETS, buildSystemPrompt, loadMode, sceneOf, turnContext, type PromptTrace, type SessionKind } from "./soul.ts";
import { toolAllowed, guestLocked } from "./toolpolicy.ts";
import { runScope, withScope, type RunScope } from "./scope.ts";

/** IM 渠道：消息可能来自陌生人，默认不可信（主人私聊由渠道层显式标 trusted） */
export const IM_CHANNELS = new Set(["feishu", "qq", "onebot"]);

export interface RunRequest {
  agentId: string;
  sessionKey: string;
  kind: SessionKind;
  channel: string;
  text: string;
  images?: ImageContent[];
  deviceId?: string;
  /** 消息来源（见 RunScope.origin） */
  origin?: string;
  /** 回复会被直接播报到这台设备（见 RunScope.spokenTo） */
  spokenTo?: string;
  localTime?: string;
  purpose?: string;
  /** false = 不落盘（记忆冲刷、试跑） */
  persist?: boolean;
  extraSystem?: string[];
  /** 回复会被播报到设备（定时任务投递到设备时） */
  voiceDelivery?: boolean;
  /** 在 agent 白名单之上再收窄一层 */
  toolAllow?: (name: string) => boolean;
  timeoutSecs?: number;
  /** 这一轮的总时长上限（秒），覆盖全局 max_secs（待办可以跑得比对话久） */
  maxSecs?: number;
  /** 外部取消（设备上点屏幕取消正在等的回复） */
  signal?: AbortSignal;
  /** 不在消息前附 [时间…]（a2a 转述等） */
  noTurnContext?: boolean;
  /** 覆盖 agent 的模型（heartbeat 用便宜模型） */
  model?: string;
  /** 脱离调用方运行（后台子任务）时显式带上跳数与调用链，防循环 */
  lineage?: { hop: number; chain: string[]; trusted?: boolean };
  /** a2a 会话 id 与引起这一轮的那次调用（见 RunScope.trace / a2aCall） */
  trace?: string;
  a2aCall?: number;
  /** 可信度（见 RunScope.trusted）。不传：嵌套调用沿用上层；IM 渠道默认不可信，其它渠道可信 */
  trusted?: boolean;
  /** 直接用调用方给的对象当本轮 meta（边生成边播要在运行中途读到 needPhoto/volume） */
  meta?: RunScope["meta"];
  /** 逐字输出等事件（边生成边播用） */
  onEvent?: (e: AgentStreamEvent) => void;
  /** 落盘前最后一道判断：返回 false 就不落盘（heartbeat 回 HEARTBEAT_OK 时不让它撑大历史） */
  keepIf?: (text: string) => boolean;
  /**
   * 这条回复写完会顺带在家里的设备上念（主人 IM 私聊 / 网页聊天，且按策略会播）：让她在最终回复最前面先写 <voice>朗读版</voice>，
   * 一写完就回调（不等后面的正文），正文里拆掉。没写就由调用方事后走 spoken() 兜底
   */
  onVoice?: (text: string) => void;
}

/** 给边生成边播的事件：文本增量；一条助手消息结束（带不带工具调用）；一次工具执行结束 */
export type AgentStreamEvent =
  | { type: "text"; delta: string }
  | { type: "message_end"; toolCalls: number; toolNames: string[] }
  | { type: "tool_end"; name: string }
  | { type: "tool_start"; name: string; args: unknown };

export interface RunResult {
  text: string;
  meta: RunScope["meta"];
  toolCalls: string[];
  usage: { input: number; output: number; cost: number };
  /** 最后一条回复为什么停：stop / toolUse / length（输出到了上限被截断）… */
  stopReason?: string;
  /** 她顺带写的朗读版（已经交给 onVoice 了） */
  voice?: string;
}

export type ToolProvider = (scope: RunScope, agent: AgentInfo) => AgentTool<any>[];

/** 粗估 token：中日韩字符按 1 个，其余按 4 字符 1 个。只用来判断要不要压缩，不用精确 */
export function estimateTokens(text: string): number {
  let cjk = 0, other = 0;
  for (const ch of text) (/[　-鿿豈-﫿＀-￯]/.test(ch) ? cjk++ : other++);
  return cjk + Math.ceil(other / 4);
}

const SILENT = /^\s*(HEARTBEAT_OK|NO_REPLY)\s*[。.!！]?\s*$/i;
/** 系统替主人发起的那些「用户消息」（heartbeat、定时任务、系统事件、别的 agent 传话）：不是主人说的，近况里不算 */
const NOT_OWNER = /^\s*\[(heartbeat|定时任务|系统事件|来自 |子任务|这条消息是|待办)/;
const CHANNEL_NAME: Record<string, string> = { device: "设备", webchat: "网页", feishu: "飞书", qq: "QQ", onebot: "QQ", system: "定时", a2a: "agent 间" };
/** 近况看多久以内的 */
export const RECENT_HOURS = 48;

/** 一条消息里给人看的那段话：用户消息取最后一段文字（前面那段是系统自动附的 [时间…]），助手消息取正文 */
function plainOf(m: any): string {
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

/**
 * 落盘前把图片换成文字引用：base64 图片进库会让每轮上下文都背着几百 KB。
 * 图片本身存进 agent 工作目录 uploads/<日期>/img-<哈希>.<扩展名>（同一张只存一份），记录里留「[图片 路径]」——
 * 管理界面凭路径显示，agent 以后也能用 exec 处理它。存不下来就退回「[图片]」。
 */
export const DEFAULT_MAX_TOOL_CALLS = 40;
/** 单轮 token 上限的默认值（含缓存读写，每次调模型都重发整段上下文，所以涨得快）；配置填 0 = 不限 */
export const DEFAULT_MAX_TURN_TOKENS = 2_000_000;
/** 叫停之后还容她几次模型调用（用来写汇报）；还在调工具就强制中止 */
const GUARD_GRACE = 2;
/** 同一工具同样参数在一轮里第几次就拒绝 */
const REPEAT_LIMIT = 3;

/**
 * 单轮上限（LRN 2026-10-30）：模型兜圈子时（同一条命令反复跑、换着花样试却一直不回复），以前只有超时管它——
 * 「无进展超时」被每次工具调用刷新，总时长上限又有半小时，这期间每次调模型都把整段上下文重发一遍，token 烧得飞快。
 * 三道闸：工具调用次数、本轮 token（含缓存读写）、同参数重复调用。到了先「软停」：之后的工具调用一律返回
 * 「别再调工具，直接告诉主人做到哪了」，让她自己收尾回复；再给 GUARD_GRACE 次还在调工具就强制中止。
 */
export class TurnGuard {
  calls = 0;
  tokens = 0;
  reason = "";
  private seen = new Map<string, number>();
  private afterStop = 0;
  constructor(private maxCalls: number, private maxTokens: number, private label: string) {}

  private halt(why: string) {
    if (this.reason) return;
    this.reason = why;
    console.log(`[agent] 🔁 ${this.label} ${why}，叫她停手汇报`);
  }

  wrap<T extends AgentTool<any>>(t: T): T {
    return Object.assign(Object.create(Object.getPrototypeOf(t)), t, {
      execute: async (id: string, params: any, ...rest: any[]) => {
        this.calls++;
        if (this.calls > this.maxCalls) this.halt(`本轮工具调用超过 ${this.maxCalls} 次`);
        if (this.reason) return { content: [{ type: "text", text: `[系统] ${this.reason}，已叫停。不要再调用任何工具，直接用文字告诉主人：做到哪了、卡在哪、接下来打算怎么办。` }], details: { guard: true }, isError: true } as any;
        const key = `${t.name}:${JSON.stringify(params ?? {})}`;
        const n = (this.seen.get(key) ?? 0) + 1;
        this.seen.set(key, n);
        if (n >= REPEAT_LIMIT) {
          return { content: [{ type: "text", text: `[系统] 这一轮你已经用完全相同的参数调过 ${t.name} ${n - 1} 次了，结果不会变。换个思路，或者直接回复主人现在的情况。` }], details: { guard: true }, isError: true } as any;
        }
        return (t.execute as any).call(t, id, params, ...rest);
      },
    });
  }

  /** 每次模型回复后调用；返回 true = 该强制中止了 */
  afterModel(u: any, hasCalls: boolean): boolean {
    if (u) this.tokens += (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    if (this.reason) return hasCalls && ++this.afterStop > GUARD_GRACE;
    if (this.tokens > this.maxTokens) this.halt(`本轮已用 ${Math.round(this.tokens / 1000)}k token，超过上限 ${Math.round(this.maxTokens / 1000)}k`);
    return false;
  }
}

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

/** 会话页实时看到的一轮：已完成的消息 + 正在生成的思考 / 正文 + 正在执行的工具 */
export interface LiveRun { purpose: string; channel: string; since: number; messages: any[]; partial: { thinking: string; text: string }; tools: string[]; trace?: string }
export type LiveEvent =
  | { type: "idle" } | { type: "start"; run: LiveRun } | { type: "end"; error?: string }
  | { type: "delta"; kind: "text" | "thinking"; delta: string } | { type: "message"; message: any } | { type: "tool"; name: string; running: boolean };
const LIVE_TEXT_MAX = 8000;
/** 推给页面的消息：去掉自动回忆、图片只留占位、超长工具结果截短 */
/** 落盘 / 给实时页的助手消息去掉 <voice> 段（只剩朗读版的就留朗读版当正文） */
function unvoice(m: any, fired?: string): any {
  if (m?.role !== "assistant" || !Array.isArray(m.content) || !m.content.some((c: any) => c.type === "text" && String(c.text).includes("<voice>"))) return m;
  const content = m.content.map((c: any) => (c.type === "text" ? { ...c, text: stripVoice(String(c.text)) } : c));
  const empty = !content.some((c: any) => (c.type === "text" && c.text.trim()) || c.type === "toolCall");
  return { ...m, content: empty && fired ? [{ type: "text", text: fired }] : content };
}

function liveMessage(m: any): any {
  m = unvoice(m);
  const x = stripRecall(m) as any;
  if (!Array.isArray(x.content)) return x;
  return {
    ...x,
    content: x.content.map((c: any) => c.type === "image" ? { type: "image", mimeType: c.mimeType }
      : c.type === "text" && x.role === "toolResult" && c.text.length > LIVE_TEXT_MAX ? { ...c, text: c.text.slice(0, LIVE_TEXT_MAX) + `\n…（共 ${c.text.length} 字）` } : c),
  };
}

/** 自动回忆附在用户消息里的那一段（开头这几个字认它，落盘前去掉） */
export const RECALL_TAG = "[相关记忆（系统按这句话自动检索的，不是主人说的，可能不全）]";
export const RECALL_WAIT_MS = 2000;
function stripRecall(m: Message): Message {
  if (m.role !== "user" || !Array.isArray(m.content)) return m;
  const content = m.content.filter((c: any) => !(c.type === "text" && String(c.text).startsWith(RECALL_TAG)));
  return content.length === m.content.length ? m : { ...m, content } as Message;
}

export const IMAGE_REF_RE = /^\[图片 (uploads\/[^\]]+)\]$/;
function stripImages(m: Message, workspace?: string): Message {
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

interface RunInfo { purpose: string; channel: string; since: number; tool: string; stage: string; abort: () => void; cancelled: boolean }

/** 压缩时每次交给摘要模型的对话量（估算 token）；太大推理型模型会把输出额度全花在思考上 */
export const COMPACT_CHUNK_TOKENS = 16_000;
/** 摘要那次调用的输出额度下限（含思考）：模型配置的 max_tokens 更大就用模型的 */
export const COMPACT_MAX_OUTPUT = 8192;

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

const clipText = (m: any, max: number) => ({
  ...m,
  content: (m.content ?? []).map((c: any) => c.type === "text" && String(c.text).length > max
    ? { ...c, text: `${String(c.text).slice(0, max)}\n…（工具结果已截短，原文 ${String(c.text).length} 字；要细节就再调一次工具）` } : c),
});

/** 进上下文前截短工具结果：之前几轮的只留开头；这一轮的单条有上限，总量还超 budget 就从这一轮最早的开始截 */
export function pruneToolResults<T extends { role: string }>(msgs: T[], budget = Infinity): T[] {
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { lastUser = i; break; }
  const out = msgs.map((m, i) => (m.role === "toolResult" && Array.isArray((m as any).content) ? clipText(m, i < lastUser ? OLD_TOOL_CHARS : TOOL_RESULT_MAX_CHARS) : m)) as T[];
  if (budget === Infinity) return out;
  let size = out.reduce((n, m) => n + msgTokens(m), 0);
  for (let i = Math.max(0, lastUser); i < out.length && size > budget; i++) {
    if (out[i].role !== "toolResult") continue;
    const before = msgTokens(out[i]);
    out[i] = clipText(out[i], OLD_TOOL_CHARS) as T;
    size -= before - msgTokens(out[i]);
  }
  return out;
}

/** 服务商报的「上下文超长」 */
/**
 * 拆开摘要模型的输出：【摘要】正文 + 【记住】要记的事（每条 "主人|长期|今天\n内容"）。
 * 不认顺序：模型偶尔把【记住】写在最前，以前按「【记住】之前的才是摘要」切，正文就成了空，整段对话只剩兜底的十几句用户原话。
 */
export function parseCompactOutput(raw: string): { summary: string; remembered: string[] } {
  const remembered: string[] = [];
  const parts: string[] = [];
  const loose: string[] = [];      // 【记住】段里不像「长期：…」的行：模型先写【记住】再接着写的摘要正文多半在这

  // 按标记切段：标记前的（没写【摘要】时）也算摘要
  const re = /【(摘要|记住)】/g;
  let kind = "摘要", last = 0, m: RegExpExecArray | null;
  const take = (k: string, body: string) => {
    if (k === "摘要") { if (body.trim()) parts.push(body.trim()); return; }
    for (const ln of body.split("\n")) {
      const mm = /^\s*[-*·\d.、]*\s*(主人|长期|今天)\s*[:：]\s*(.+)$/.exec(ln);
      if (mm) { if (!/^无[。.]?$/.test(mm[2].trim())) remembered.push(`${mm[1]}\n${mm[2].trim()}`); }
      else if (ln.trim() && !/^\s*[-*·]?\s*无[。.]?\s*$/.test(ln)) loose.push(ln.trim());
    }
  };
  while ((m = re.exec(raw))) { take(kind, raw.slice(last, m.index)); kind = m[1]; last = m.index + m[0].length; }
  take(kind, raw.slice(last));
  return { summary: (parts.join("\n").trim() || loose.join("\n")).trim(), remembered };
}

/**
 * 朗读版（LRN 2026-10-31，症状「飞书 / 网页的长回复要等全写完、再找便宜模型压成口语，20 秒压不完就截断着念」）：
 * 会被顺带念的回复，让她在最终回复最前面先写 <voice>口语版</voice>。流式里一写完就交出去播（不等后面的正文、不再调模型），
 * 正文、落盘、实时页里都拆掉这段。
 */
export const VOICE_RE = /<voice>([\s\S]*?)<\/voice>\s*/g;
export function stripVoice(t: string): string {
  return t.replace(VOICE_RE, "").replace(/^\s*<voice>\s*/, "");
}
export function voicePrompt(max: number): string {
  return `<voice_first>\n这条回复写完会在家里的设备上念给主人听。回复会超过约 ${max} 字时，在最终回复的最开头先写一段 <voice>念给主人听的口语版</voice>，再接着写正文：`
    + `口语版不超过 ${max} 字，保留结论和关键数字，不要 markdown、列表、表情、网址、代码；内容放不下就在最后说一句「详细的我发在消息里了」。`
    + "短回复不用写，系统会直接念正文；先说一句再去调工具的那种过渡句也不用写。<voice> 这段主人在文字里看不到。\n</voice_first>";
}
/**
 * 流式过滤：一条助手消息开头是 <voice> 就把这段扣下来（不给实时页 / 调用方看），一闭合就回调；其余照常放行。
 * 开头还看不出是不是 <voice> 时先攒着；到消息结尾还没闭合就当普通正文放出去。
 */
export class VoiceTap {
  private buf = "";
  private mode: "undecided" | "pass" | "inside" = "undecided";
  fired = "";
  constructor(private onVoice: (t: string) => void) {}
  /** 喂一段增量，返回应该放行给下游的文字 */
  feed(d: string): string {
    if (this.mode === "pass") return d;
    this.buf += d;
    if (this.mode === "undecided") {
      const t = this.buf.replace(/^\s+/, "");
      if (t.startsWith("<voice>")) this.mode = "inside";
      else if ("<voice>".startsWith(t)) return "";
      else { this.mode = "pass"; const out = this.buf; this.buf = ""; return out; }
    }
    if (this.mode === "inside") {
      const end = this.buf.indexOf("</voice>");
      if (end < 0) return "";
      const voice = this.buf.slice(this.buf.indexOf("<voice>") + 7, end).trim();
      const rest = this.buf.slice(end + 8).replace(/^\s+/, "");
      this.buf = "";
      this.mode = "pass";
      if (voice && !this.fired) { this.fired = voice; try { this.onVoice(voice); } catch { /* 回调出错不影响这一轮 */ } }
      return rest;
    }
    return d;
  }
  /** 一条消息结束：没闭合的 / 还没判断出来的原样放出去，下一条消息重新判断 */
  end(): string {
    const out = this.mode === "pass" ? "" : this.buf.replace(/^\s*<voice>\s*/, "");
    this.buf = "";
    this.mode = "undecided";
    return out;
  }
}

/** 模型正常结束却一个字没说、也没调工具（上下文快满时有的服务商会这样直接收尾）：execute 抛这个，run 压一压再试一次 */
export const EMPTY_RE = /^空回复：/;
export const OVERFLOW_RE = /context[_ ]?(length|window)|maximum context|prompt is too long|too many tokens|input (length|tokens?)|token limit|exceed(s|ed)? .*(context|token)|上下文.*(超|长)|超长|超出.*(长度|限制)/i;

/** 一个工具最多执行多久（工具自己不理超时、卡在网络上时的兜底；exec 自己的上限是 10 分钟） */
export const TOOL_MAX_MS = 15 * 60_000;

class Semaphore {
  private queue: (() => void)[] = [];
  constructor(private n: number) {}
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise<void>((r) => this.queue.push(r));
  }
  release() {
    const next = this.queue.shift();
    if (next) next(); else this.n++;
  }
}

export class Runtime {
  private stores = new Map<string, AgentStore>();
  private locks = new Map<string, Promise<unknown>>();
  /** 正在跑（且手里拿着会话锁）的一轮在等哪个会话：「拿着 key 的那一轮 → 在等的会话」，查互相等待用 */
  private waitsFor = new Map<string, string>();
  /** 在别的会话里发起、要等这个会话的锁（a2a 等对方回复）最多等多久。拿着自己的锁干等别人，等久了谁都动不了 */
  lockWaitMs = { a2a: 90_000 };
  /** 压缩时每块交给摘要模型的对话量（单测可调小） */
  compactChunk = COMPACT_CHUNK_TOKENS;
  /** 每个会话正在跑的那一轮：卡住时日志里说清楚是谁占着 */
  private running = new Map<string, RunInfo>();
  /** 正在跑的每一轮的实时记录（管理界面会话页订阅，见 watchLive） */
  private live = new Map<string, LiveRun>();
  private liveSubs = new Map<string, Set<(e: LiveEvent) => void>>();

  /**
   * 订阅一个会话的实时过程（LRN 2026-10-30，症状「网页上只有发消息的那个窗口看得到过程，切走再回来、或者飞书 / 设备触发的，只剩『回复中』」）。
   * 以前过程只沿着发消息那个请求的流推，而且只推正文和工具名。现在每轮都留一份实时记录（已完成的消息 + 正在生成的思考 / 正文 + 正在执行的工具），
   * 谁打开会话页谁订阅：先给快照，之后推增量，这一轮结束推 end（落盘的历史这时才有这一轮）。返回取消订阅。
   */
  watchLive(agentId: string, sessionKey: string, fn: (e: LiveEvent) => void): () => void {
    const key = `${agentId}|${sessionKey}`;
    let set = this.liveSubs.get(key);
    if (!set) this.liveSubs.set(key, (set = new Set()));
    set.add(fn);
    const cur = this.live.get(key);
    fn(cur ? { type: "start", run: cur } : { type: "idle" });
    return () => { set!.delete(fn); if (!set!.size) this.liveSubs.delete(key); };
  }
  private emitLive(key: string, e: LiveEvent) {
    for (const fn of this.liveSubs.get(key) ?? []) { try { fn(e); } catch { /* 页面断开了 */ } }
  }
  /** 每个会话后面排着几轮 */
  private queued = new Map<string, number>();

  /** 管理界面「正在运行」：每个会话正在跑的那一轮、后面排着几轮、它在等谁 */
  activeRuns() {
    const t = Date.now();
    return [...this.running.entries()].map(([key, r]) => {
      const [agent, session] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
      const w = this.waitsFor.get(key);
      return { key, agent, session, purpose: r.purpose, channel: r.channel, stage: r.stage, tool: r.tool, secs: Math.round((t - r.since) / 1000),
        queued: this.queued.get(key) ?? 0, waiting_for: w ? w.slice(w.indexOf("|") + 1) : "", cancelling: r.cancelled };
    }).sort((a, b) => b.secs - a.secs);
  }
  /** 终止某个会话正在跑的那一轮（同取消：中止模型和工具，最多再等 2 秒就放开会话锁） */
  cancelRun(key: string) {
    const r = this.running.get(key);
    if (!r) return false;
    r.cancelled = true;
    r.abort();
    console.log(`[agent] 🛑  ${key} 被手动终止（${r.purpose}/${r.channel}，${r.stage}${r.tool ? `：${r.tool}` : ""}）`);
    return true;
  }
  private sem: Semaphore;
  private providers: ToolProvider[] = [];
  /** 扩展 / 扩展包 / MCP 的工具：排在所有内置工具后面，重名时内置的赢（不管谁先注册） */
  private pluginProviders: ToolProvider[] = [];
  /** 压缩前的记忆冲刷（memory 模块注入） */
  beforeCompact: ((agent: AgentInfo, sessionKey: string) => Promise<void>) | null = null;
  /** 压缩时顺手挑出来的要记住的事（长期 → MEMORY.md，今天 → 当天笔记）。以前压缩前要用整段上下文另跑一轮「记忆冲刷」，很费 */
  remember: ((agent: AgentInfo, target: "long" | "daily" | "user", text: string) => void) | null = null;
  /** 自动回忆（memory 模块注入）：按这句话检索长期记忆，返回要附上的几条（「路径：内容」）。skip = 已整篇在提示里的文件 */
  recall: ((agent: AgentInfo, text: string) => Promise<{ line: string; why: string }[]>) | null = null;
  /** 每个会话上一轮算出来的压缩阈值（回复后在后台压缩时用） */
  private compactLimit = new Map<string, number>();
  /** 回复后在后台预先压缩（测试里关掉，免得和假模型的回复队列抢） */
  backgroundCompact = true;
  /** 系统提示里的技能目录（skills 模块注入） */
  skillCatalog: (agent: AgentInfo) => { name: string; description: string }[] = () => [];
  /** 当前在家状态（presence 路由更新） */
  presence: () => string = () => "";

  constructor(public agents: AgentRegistry, public models: ModelRegistry, private opts: { maxConcurrency: number; timeoutSecs: number; maxSecs?: number; maxToolCalls?: number; maxTurnTokens?: number }) {
    this.sem = new Semaphore(Math.max(1, opts.maxConcurrency));
  }

  /** 管理界面改了超时：就地生效（下一轮起） */
  setLimits(l: { timeoutSecs?: number; maxSecs?: number; maxToolCalls?: number; maxTurnTokens?: number }) {
    if (l.timeoutSecs && l.timeoutSecs > 0) this.opts.timeoutSecs = l.timeoutSecs;
    if (l.maxSecs && l.maxSecs > 0) this.opts.maxSecs = l.maxSecs;
    if (l.maxToolCalls && l.maxToolCalls > 0) this.opts.maxToolCalls = l.maxToolCalls;
    if (l.maxTurnTokens !== undefined && l.maxTurnTokens >= 0) this.opts.maxTurnTokens = l.maxTurnTokens;
  }

  addTools(p: ToolProvider, opts: { plugin?: boolean } = {}) { (opts.plugin ? this.pluginProviders : this.providers).push(p); }
  private allProviders() { return [...this.providers, ...this.pluginProviders]; }
  /** 内置工具的名字（扩展里重名的会被挡掉，管理界面要标出来） */
  builtinToolNames(agent: AgentInfo): Set<string> {
    const scope: RunScope = { agentId: agent.id, sessionKey: `${agent.id}:main`, kind: "main", channel: "webchat", purpose: "list", hop: 0, chain: [], meta: {}, trusted: true };
    return new Set(this.providers.flatMap((p) => p(scope, agent)).map((t) => t.name));
  }

  store(agentId: string): AgentStore {
    let s = this.stores.get(agentId);
    if (!s) {
      const a = this.agents.get(agentId);
      if (!a) throw new Error(`没有 agent ${agentId}`);
      s = new AgentStore(path.join(a.dir, "agent.sqlite"));
      this.stores.set(agentId, s);
    }
    return s;
  }

  closeStore(agentId: string) { this.stores.get(agentId)?.close(); this.stores.delete(agentId); }
  close() { for (const id of [...this.stores.keys()]) this.closeStore(id); }

  /** 会话 key：<agent>:<channel>:<peer>；设备会话默认并入 main（单人家用） */
  sessionKey(agentId: string, channel: string, peer: string) {
    const a = this.agents.get(agentId);
    if (channel === "device" && a?.device_in_main) return `${agentId}:main`;
    return `${agentId}:${channel}:${peer}`;
  }

  /** 同一会话串行。前面那轮迟迟不完就打一行日志，说清楚是谁占着（以前这种情况一声不吭，看起来就是「这个 agent 不理人了」） */
  private serial<T>(key: string, fn: () => Promise<T>, waitMs = 0, busyMsg = ""): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    if (this.locks.has(key)) {
      this.queued.set(key, (this.queued.get(key) ?? 0) + 1);
      prev.catch(() => {}).finally(() => { const n = (this.queued.get(key) ?? 1) - 1; if (n > 0) this.queued.set(key, n); else this.queued.delete(key); });
      const t = setTimeout(() => {
        const r = this.running.get(key);
        const who = r ? `${r.purpose}/${r.channel}，已跑 ${Math.round((Date.now() - r.since) / 1000)} 秒，${r.stage}${r.tool ? `：${r.tool}` : ""}` : "未知";
        console.log(`[agent] ⏳  ${key} 在排队：上一轮还没结束（${who}）`);
      }, 20_000);
      t.unref?.();
      prev.finally(() => clearTimeout(t));
    }
    const gate = prev.catch(() => {});
    let run: Promise<T>;
    let tail: Promise<unknown>;
    if (waitMs > 0 && this.locks.has(key)) {
      // 等锁有上限：等不到就放弃，但排着的这个位置要等前面真的完了才让给下一个，不然后面的会插队、两轮同时跑
      let gaveUp = false, timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((r) => { timer = setTimeout(() => { gaveUp = true; r(); }, waitMs); });
      run = Promise.race([gate, limit]).then(() => {
        clearTimeout(timer);
        if (gaveUp) throw new Error(busyMsg || `会话 ${key} 正忙，等了 ${Math.round(waitMs / 1000)} 秒还没轮到`);
        return fn();
      });
      tail = Promise.all([gate, run.catch(() => {})]);
    } else {
      run = gate.then(fn);
      tail = run.catch(() => {});
    }
    this.locks.set(key, tail);
    tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }

  /**
   * 把一句主动说的话（heartbeat、定时任务、待办汇报）记进接收方那个会话：主人在飞书 / 设备上接话时，上一句就在历史里，
   * 不用靠近况去猜（LRN 2026-10-30：heartbeat 搬出主会话以后，主人回它的话题对不上）。
   * 记成一对「[来源] 用户消息 + 助手消息」（有的服务商不接受连着两条助手消息）；排在这个会话的队里，不打断正在跑的那轮
   */
  note(agentId: string, sessionKey: string, tag: string, text: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent || !text.trim()) return Promise.resolve();
    const store = this.store(agentId);
    const t = Date.now();
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    return this.serial(`${agentId}|${sessionKey}`, async () => {
      store.touchSession(sessionKey, sessionKey.endsWith(":main") ? "main" : "chat", sessionKey.split(":")[1] ?? "system");
      store.append(sessionKey, [
        { role: "user", content: [{ type: "text", text: `[${tag}]（你主动开口，下面是你发出去的话）` }], timestamp: t, ksrc: { channel: "system", purpose: "note", tag } } as any,
        { role: "assistant", content: [{ type: "text", text: text.trim() }], api: "openai-completions", provider: "kagura", model: "note", usage: zero, stopReason: "stop", timestamp: t } as any,
      ]);
    }).catch((e) => console.log(`[agent] ⚠️  记进会话 ${sessionKey} 失败: ${e.message}`));
  }

  /** 会话是否正有一轮在跑（调度器的 idleOnly 用） */
  busy(agentId: string, sessionKey: string) { return this.locks.has(`${agentId}|${sessionKey}`); }

  async run(req: RunRequest): Promise<RunResult> {
    const parent = runScope();
    const nested = !!parent;          // 在另一轮运行里发起的（a2a 等待对方回复）：发起方手里还拿着自己的会话锁
    const key = `${req.agentId}|${req.sessionKey}`;
    const from = parent ? `${parent.agentId}|${parent.sessionKey}` : "";
    if (from && from !== key) {
      // 互相等待：两条各自在跑的调用链（比如两个 agent 的 heartbeat 同时 sessions_send 对方）——调用链里看不出来，
      // 要顺着「谁拿着锁在等谁」走一圈。成环就立刻失败，否则两边都永远等下去，后面这两个会话的消息全排不上
      const mine = new Set([...parent!.chain, from]);
      const path: string[] = [];
      for (let k: string | undefined = key; k && !path.includes(k); k = this.waitsFor.get(k)) {
        path.push(k);
        if (mine.has(k)) {
          console.log(`[agent] 🔁  互相等待：${from} → ${path.join(" → ")}，拒绝这次等待`);
          throw new Error(`${req.agentId} 那边正在等你这边（互相等待会一起卡死），这次没发过去——先直接回答，或者用 wait=false 发`);
        }
      }
      this.waitsFor.set(from, key);
    }
    try {
      const res = await this.serial(key, async () => {
        if (!nested) await this.sem.acquire();
        try {
          try { return await this.execute(req); }
          catch (e: any) {
            // 服务商说上下文超长：狠狠压一次（只留最近一轮）再试一次。这一轮出错时什么都没落盘，重试不会重复
            const msg = String(e?.message ?? "");
            const empty = EMPTY_RE.test(msg);
            if (req.persist === false || !(empty || OVERFLOW_RE.test(msg))) throw e;
            const agent = this.agents.get(req.agentId);
            if (!agent) throw e;
            if (empty) {
              // 空回复多半是上下文快满了：历史超过阈值一半就先压（不像超长那样压到只剩一轮），然后再试一次
              console.log(`[agent] 🫥 ${key} ${msg}，压一压再试一次`);
              await this.maybeCompact(agent, this.store(agent.id), req.sessionKey, req.signal, { limit: Math.floor(agent.compaction.max_tokens / 2), trigger: "empty" });
              try { return await this.execute(req); }
              catch (e2: any) { throw EMPTY_RE.test(String(e2?.message ?? "")) ? new Error("模型连着两次返回了空回复，换个说法再试，或者在管理界面压缩一下这个会话") : e2; }
            }
            console.log(`[agent] 📏 ${key} 上下文超长（${msg.slice(0, 120)}），压缩后重试`);
            await this.maybeCompact(agent, this.store(agent.id), req.sessionKey, req.signal, { limit: 0, keepTokens: 0, trigger: "overflow" });
            return await this.execute(req);
          }
        }
        finally { if (!nested) this.sem.release(); }
      }, nested ? this.lockWaitMs.a2a : 0, nested ? `${req.agentId} 正忙（它在处理别的事），等了 ${Math.round(this.lockWaitMs.a2a / 1000)} 秒还没空，稍后再试或者用 wait=false 发` : "");
      this.compactAfterReply(req);
      return res;
    } finally {
      if (from && this.waitsFor.get(from) === key) this.waitsFor.delete(from);
    }
  }

  /** 真正跑一轮。调用方负责串行（run 或压缩流程里的冲刷） */
  private async execute(req: RunRequest): Promise<RunResult> {
    const agent = this.agents.get(req.agentId);
    if (!agent) throw new Error(`没有 agent ${req.agentId}`);
    const store = this.store(agent.id);
    const persist = req.persist !== false;
    const lockKey = `${agent.id}|${req.sessionKey}`;
    const nestedRun = this.running.has(lockKey);          // 冲刷等内部运行：别覆盖外面那一轮的登记
    // 自己的中止信号：调用方取消（req.signal）和管理界面「终止」都走它
    const ac = new AbortController();
    const signal = ac.signal;
    const onOuter = () => ac.abort();
    if (req.signal?.aborted) ac.abort(); else req.signal?.addEventListener("abort", onOuter, { once: true });
    const info: RunInfo = { purpose: req.purpose ?? "chat", channel: req.channel, since: Date.now(), tool: "", stage: "准备", abort: () => ac.abort(), cancelled: false };
    if (!nestedRun) this.running.set(lockKey, info);
    // a2a 会话 id（见 RunScope.trace）：先算出来，实时记录里也带上——会话页据此弹出这一轮的 Agent 通信实时动画
    const traceId = req.trace ?? runScope()?.trace ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const liveRun: LiveRun | null = nestedRun ? null : { purpose: info.purpose, channel: req.channel, since: info.since, messages: [], partial: { thinking: "", text: "" }, tools: [], trace: traceId };
    if (liveRun) { this.live.set(lockKey, liveRun); this.emitLive(lockKey, { type: "start", run: liveRun }); }
    let liveError = "";
    try {
    if (persist) store.touchSession(req.sessionKey, req.kind, req.channel);
    const parent = runScope();
    const scope: RunScope = {
      agentId: agent.id, sessionKey: req.sessionKey, kind: req.kind, channel: req.channel,
      deviceId: req.deviceId, spokenTo: req.spokenTo, origin: req.origin ?? (req.channel === "device" && req.deviceId ? `device:${req.deviceId}` : parent?.origin), localTime: req.localTime, purpose: req.purpose ?? "chat",
      hop: parent ? parent.hop + (parent.agentId !== agent.id ? 1 : 0) : (req.lineage?.hop ?? 0),
      chain: [...(parent?.chain ?? req.lineage?.chain ?? []), `${agent.id}|${req.sessionKey}`],
      meta: req.meta ?? {},
      trusted: req.trusted ?? parent?.trusted ?? req.lineage?.trusted ?? !IM_CHANNELS.has(req.channel),
      trace: traceId,
      a2aCall: req.a2aCall,
    };
    const model = this.models.resolve(req.model || agent.model);
    // 单轮上限（LRN 2026-10-30，症状「等她回复，她一直在 exec 兜圈子，把 token 烧光了」）：见 TurnGuard
    const guard = new TurnGuard(
      (this.opts.maxToolCalls || DEFAULT_MAX_TOOL_CALLS) * (scope.purpose === "task" ? 3 : 1),
      this.opts.maxTurnTokens === 0 ? Infinity : (this.opts.maxTurnTokens || DEFAULT_MAX_TURN_TOKENS) * (scope.purpose === "task" ? 3 : 1),
      `${agent.id} ${req.sessionKey}`,
    );
    const tools = this.toolsFor(scope, agent, req).map((t) => guard.wrap(t));
    const peers = this.agents.list().filter((p) => this.agents.canContact(agent.id, p.id)).map((p) => ({ id: p.id, name: p.name }));
    if (persist && scope.trusted) store.markOwner(req.sessionKey);
    // 近况：这个会话看不到的、最近在别处跟主人说过的话。只给可信的会话（主人本人），陌生人 / 群聊不给
    const recent = scope.trusted && req.kind !== "sub" && req.purpose !== "flush" ? this.recentActivity(agent, req.sessionKey) : "";
    const promptOf = (summary?: string, trace?: PromptTrace) => buildSystemPrompt({
      agent, scene: sceneOf(scope), channel: req.channel, summary, trace,
      extra: [...(req.extraSystem ?? []), recent, req.onVoice ? voicePrompt(agent.voice_max_chars || 80) : ""], skills: this.skillCatalog(agent), voiceDelivery: req.voiceDelivery,
      peers: tools.some((t) => t.name.startsWith("sessions_")) ? peers : [], tools: tools.map((t) => t.name),
    });
    // 上下文预算：窗口减去系统提示、工具定义、输出预留，剩下的才是历史（含摘要）能用的
    const ctxWin = model.contextWindow || DEFAULT_CONTEXT_WINDOW;
    const fixedSys = estimateTokens(promptOf(""));
    const fixedTools = estimateTokens(JSON.stringify(tools.map((t) => [t.name, t.description, t.parameters])));
    const reserve = (model.maxTokens || 8192) + 4096;
    const histBudget = Math.max(2000, ctxWin - fixedSys - fixedTools - reserve);
    const limit = Math.min(agent.compaction.max_tokens, Math.floor(histBudget * 0.85));
    this.compactLimit.set(lockKey, limit);
    if (persist) {
      info.stage = "压缩历史";
      await this.maybeCompact(agent, store, req.sessionKey, signal, { limit });
      if (signal.aborted) throw new Error(info.cancelled ? "已在管理界面终止" : "已取消");
    }
    info.stage = "生成回复";
    // kctx 是存在助手消息上的「这一轮上下文构成」统计，只给管理界面看，别发给模型
    const history = repairHistory(store.history(req.sessionKey).map((h) => { const { kctx: _k, ksrc: _s, ...m } = h.msg as any; return m as Message; }),
      `${agent.id} ${req.sessionKey}`);
    const session = store.getSession(req.sessionKey);
    const trace: PromptTrace = { scene: sceneOf(scope), files: [], notLoaded: [], daily: 0, skills: 0, peers: 0, summary: 0 };
    const systemPrompt = promptOf(session?.summary, trace);
    const prunedHist = pruneToolResults(history);
    const histSize = estimateTokens(session?.summary ?? "") + prunedHist.reduce((n, m) => n + msgTokens(m), 0);
    const pruned = prunedHist.filter((m, i) => m !== history[i]).length;
    if (fixedSys + fixedTools + histSize > ctxWin * 0.5) {
      console.log(`[agent] 📏 ${agent.id} ${req.sessionKey} 上下文≈ 系统提示 ${fixedSys} + 工具 ${fixedTools} + 历史 ${histSize} token（窗口 ${ctxWin}，压缩阈值 ${limit}）`);
    }

    const content: any[] = [];
    if (!req.noTurnContext) content.push({ type: "text", text: turnContext(req.localTime, this.presence()) });
    if (req.images?.length) {
      if (model.input.includes("image")) content.push(...req.images);
      else content.push({ type: "text", text: "[用户发来了图片，但当前模型不支持看图，请如实告诉用户]" });
    }
    const recalled = await this.recallFor(agent, scope, req);
    if (recalled.text) content.push({ type: "text", text: recalled.text });
    content.push({ type: "text", text: req.text });

    const pi = new Agent({
      initialState: { systemPrompt, model, tools, messages: history as any },
      streamFn: this.models.chatStream,              // 按模型配置的思考等级加字段、给思考预留
      sessionId: `${agent.id}:${req.sessionKey}`,
      toolExecution: "sequential",
      // 每次调模型前截短工具结果，一轮里调很多次工具也撑不爆上下文（库里存的还是原文）
      transformContext: async (msgs) => { try { return pruneToolResults(msgs as any[], histBudget) as any; } catch { return msgs; } },
    });
    const start = pi.state.messages.length;
    const toolCalls: string[] = [];
    // 超时按「多久没有进展」算，不按一轮总时长：模型在出字、工具在执行都算在干活，长任务不会被半路掐掉。
    // 工具执行期间不计时（命令有自己的超时）；另有总时长上限兜底，防卡死、防死循环
    const idleMs = (req.timeoutSecs ?? this.opts.timeoutSecs) * 1000;
    const maxMs = Math.max(idleMs, (req.maxSecs ?? this.opts.maxSecs ?? 1800) * 1000);
    let timedOut: "" | "idle" | "max" | "cancel" | "budget" = "";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let toolsRunning = 0;
    // 超时后先 abort；有的工具不理会中止信号（卡在网络、扩展写得不好），给 2 秒宽限就不再等它
    let giveUp: () => void = () => {};
    const gaveUp = new Promise<void>((r) => (giveUp = r));
    const stop = (why: "idle" | "max" | "cancel" | "budget") => {
      if (timedOut) return;
      timedOut = why;
      pi.abort();
      setTimeout(giveUp, 2000).unref?.();
    };
    // 工具执行期间不按 idleMs 算（命令可以跑好几分钟），但也不能无限等：工具自己不理超时的话，最多等 toolMs
    const toolMs = Math.max(idleMs, TOOL_MAX_MS);
    let toolStuck = "";
    const kick = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = timedOut ? null
        : toolsRunning > 0 ? setTimeout(() => { toolStuck = info.tool; stop("idle"); }, toolMs)
        : setTimeout(() => stop("idle"), idleMs);
    };
    // 这一轮已经说出口的字（被打断时记进历史用；中止时那条没说完的消息内容会被清空，只能自己攒）
    let spoken = "";
    // 朗读版：开头的 <voice>…</voice> 扣下来一写完就交出去，实时页 / 调用方 / 已说出口的字里都不带它
    const tap = req.onVoice ? new VoiceTap((v) => {
      scope.meta.voice = v;
      console.log(`[agent] 🗣️  ${agent.id} 朗读版写好了（开始这一轮后 ${((Date.now() - info.since) / 1000).toFixed(1)}s，${Array.from(v).length} 字），先拿去念`);
      req.onVoice!(v);
    }) : null;
    pi.subscribe((e: any) => {
      const rawDelta = e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta" ? String(e.assistantMessageEvent.delta ?? "") : null;
      const textDelta = rawDelta === null ? null : tap ? tap.feed(rawDelta) : rawDelta;
      const tail = tap && e.type === "message_end" && e.message?.role === "assistant" ? tap.end() : "";
      if (textDelta) spoken += textDelta;
      if (tail) spoken += tail;
      if (e.type === "message_end" && e.message?.role === "assistant" && spoken && !spoken.endsWith("\n")) spoken += "\n";
      if (liveRun) {
        try {
          if (tail) { liveRun.partial.text += tail; this.emitLive(lockKey, { type: "delta", kind: "text", delta: tail }); }
          if (e.type === "message_update") {
            const ev = e.assistantMessageEvent;
            const kind = ev?.type === "text_delta" ? "text" : ev?.type === "thinking_delta" ? "thinking" : "";
            const delta = kind === "text" ? textDelta : ev?.delta;
            if (kind && delta) { liveRun.partial[kind] += delta; this.emitLive(lockKey, { type: "delta", kind, delta }); }
          } else if (e.type === "message_end" && ["user", "assistant", "toolResult"].includes(e.message?.role)) {
            const m = liveMessage(e.message);
            liveRun.messages.push(m);
            liveRun.partial = { thinking: "", text: "" };
            this.emitLive(lockKey, { type: "message", message: m });
          } else if (e.type === "tool_execution_start") {
            liveRun.tools.push(e.toolName);
            this.emitLive(lockKey, { type: "tool", name: e.toolName, running: true });
          } else if (e.type === "tool_execution_end") {
            const i = liveRun.tools.indexOf(e.toolName);
            if (i >= 0) liveRun.tools.splice(i, 1);
            this.emitLive(lockKey, { type: "tool", name: e.toolName, running: false });
          }
        } catch { /* 实时记录出错不影响这一轮 */ }
      }
      if (e.type === "message_end" && e.message?.role === "assistant") {
        const hasCalls = (e.message.content ?? []).some((c: any) => c.type === "toolCall");
        if (guard.afterModel(e.message.usage, hasCalls)) stop("budget");
      }
      if (e.type === "tool_execution_start") { toolCalls.push(e.toolName); toolsRunning++; info.tool = e.toolName; info.stage = "执行工具"; }
      else if (e.type === "tool_execution_end") { toolsRunning = Math.max(0, toolsRunning - 1); if (!toolsRunning) { info.tool = ""; info.stage = "生成回复"; } }
      kick();
      if (!req.onEvent) return;
      try {
        if (tail) req.onEvent({ type: "text", delta: tail });
        if (textDelta) req.onEvent({ type: "text", delta: textDelta });
        else if (e.type === "message_end" && e.message?.role === "assistant") {
          const calls = (e.message.content ?? []).filter((c: any) => c.type === "toolCall");
          req.onEvent({ type: "message_end", toolCalls: calls.length, toolNames: calls.map((c: any) => String(c.name)) });
        }
        else if (e.type === "tool_execution_end") req.onEvent({ type: "tool_end", name: e.toolName });
        else if (e.type === "tool_execution_start") req.onEvent({ type: "tool_start", name: e.toolName, args: e.args });
      } catch (err: any) { console.log(`[agent] ⚠️  onEvent 出错: ${err.message}`); }
    });

    kick();
    const hardTimer = setTimeout(() => stop("max"), maxMs);
    const onCancel = () => stop("cancel");
    if (signal.aborted) onCancel(); else signal.addEventListener("abort", onCancel, { once: true });
    try {
      const work = withScope(scope, async () => {
        await pi.prompt({ role: "user", content, timestamp: Date.now() } as any);
        await pi.waitForIdle();
      });
      work.catch(() => {});                          // 放弃等待之后它再报错也别变成未处理的 rejection
      await Promise.race([work, gaveUp]);
    } finally { clearTimeout(hardTimer); if (idleTimer) clearTimeout(idleTimer); idleTimer = null; signal.removeEventListener("abort", onCancel); }

    const fresh = pi.state.messages.slice(start).filter((m: any) => ["user", "assistant", "toolResult"].includes(m.role)) as Message[];
    const assistants = fresh.filter((m) => m.role === "assistant") as AssistantMessage[];
    const last = assistants.at(-1);
    const why = timedOut as "" | "idle" | "max" | "cancel" | "budget";      // 在回调里赋值，TS 看不出来
    if (why === "budget") throw new Error(`agent 停下了：${guard.reason}，叫她停手汇报也没停（多半在兜圈子）`);
    if (why === "cancel") {
      // 主人手动终止（管理界面「停止」/「停止并发送」）：问题和已经说出口的那部分照样记进历史，注明被打断——
      // 不然紧接着发的新消息她不知道刚才在聊什么。工具调用和结果不留（没配对的 toolCall 下一轮服务商会拒）
      if (info.cancelled && persist) {
        try {
          const user = fresh.find((m) => m.role === "user");
          const said = spoken.trim();
          if (user) {
            const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
            store.append(req.sessionKey, [
              stripImages(stripRecall(user), agent.workspace),
              { role: "assistant", content: [{ type: "text", text: `${said ? said + "\n" : ""}（这一轮被主人打断了，没说完）` }], api: "openai-completions", provider: "kagura", model: "interrupted", usage: zero, stopReason: "stop", timestamp: Date.now() } as any,
            ]);
          }
        } catch (e: any) { console.log(`[agent] ⚠️  记下被打断的那一轮失败: ${e.message}`); }
      }
      throw new Error(info.cancelled ? "已在管理界面终止" : "已取消");
    }
    if (why === "idle") throw new Error(toolStuck ? `agent 超时（工具 ${toolStuck} 执行超过 ${Math.round(toolMs / 60000)} 分钟没有结束）` : `agent 超时（${idleMs / 1000} 秒没有任何进展）`);
    if (why === "max") throw new Error(`agent 超时（这一轮超过总时长上限 ${Math.round(maxMs / 60000)} 分钟）`);
    if (!last) throw new Error(pi.state.errorMessage || "模型没有返回内容");
    if (last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last.errorMessage || `模型调用失败（${last.stopReason}）`);

    const usage = { input: 0, output: 0, cost: 0 };
    for (const a of assistants) {
      const u = a.usage;
      if (!u) continue;
      usage.input += u.input; usage.output += u.output; usage.cost += u.cost?.total ?? 0;
      store.recordUsage(req.sessionKey, scope.purpose, {
        model: `${a.provider}/${a.model}`, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total ?? 0,
      });
    }
    const textOf = (a: AssistantMessage) => stripVoice(a.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")).trim();
    // 只写了 <voice> 没写正文：朗读版本身就当回复
    const text = textOf(last) || assistants.map(textOf).filter(Boolean).join("\n") || (tap?.fired ?? "");
    // 一个字没说也没调工具：不落盘（库里不留空的助手消息），交给 run 压一压重试。调过工具的不重试——会把工具再执行一遍
    if (!text && !toolCalls.length) throw new Error(`空回复：模型没说话就结束了（${last.stopReason}，输出 ${last.usage?.output ?? "?"} token）`);
    if (persist && (!req.keepIf || req.keepIf(text))) {
      const out = fresh.map((m) => unvoice(stripImages(stripRecall(m), agent.workspace), tap?.fired));
      // 这一轮的上下文构成（估算）记在最后一条助手消息上：会话页每轮下面显示 token 明细用
      const li = out.map((m) => m.role).lastIndexOf("assistant");
      // 这条消息从哪来（同一个会话里可能混着设备、飞书、网页的消息，比如主会话）：会话页标在「用户」旁边
      const ui = out.findIndex((m) => m.role === "user");
      if (ui >= 0) out[ui] = { ...out[ui], ksrc: { channel: req.channel, purpose: scope.purpose, ...(req.deviceId ? { device: req.deviceId } : {}) } } as any;
      if (li >= 0) out[li] = { ...out[li], kctx: {
        sys: fixedSys, tools: fixedTools, hist: histSize, win: ctxWin, calls: assistants.length, limit, toolCount: tools.length, a2a: toolCalls.some((n) => n === "sessions_send" || n === "sessions_spawn") ? scope.trace : undefined,
        // 系统层对上下文做了什么：加载了哪些文件、近况、摘要、自动回忆、截短了几条旧工具结果、单轮上限有没有叫停
        trace, recent: { chars: Array.from(recent).length, items: recent.split("\n").filter((l) => /^\s*-\s/.test(l)).length },
        recall: { hits: recalled.hits, ms: recalled.ms, why: recalled.why }, pruned, guard: guard.reason || undefined,
      } } as any;
      store.append(req.sessionKey, out);
    }
    return { text, meta: scope.meta, toolCalls, usage, stopReason: String(last.stopReason ?? ""), voice: tap?.fired || undefined };
    } catch (e: any) { liveError = OVERFLOW_RE.test(String(e?.message ?? "")) || EMPTY_RE.test(String(e?.message ?? "")) ? "" : String(e?.message ?? e); throw e; }
    finally {
      if (!nestedRun) this.running.delete(lockKey);
      req.signal?.removeEventListener("abort", onOuter);
      if (liveRun && this.live.get(lockKey) === liveRun) { this.live.delete(lockKey); this.emitLive(lockKey, { type: "end", ...(liveError ? { error: liveError } : {}) }); }
    }
  }

  /**
   * 自动回忆（LRN 2026-10-30）：长期记忆不再整篇放进系统提示，改成每轮拿主人这句话检索，相关的几条附在这一轮消息上。
   * 附在消息里而不是系统提示里：系统提示不变，服务商的前缀缓存才命中；落盘前去掉（stripRecall），历史里不留、也不重复占地方。
   * 只给可信、场景里没整篇加载 MEMORY.md 的轮次；检索本地几毫秒，配了嵌入接口时多一次嵌入请求，最多等 RECALL_WAIT_MS。
   */
  private async recallFor(agent: AgentInfo, scope: RunScope, req: RunRequest): Promise<{ text: string; hits: string[]; ms: number; why: string }> {
    const none = (why: string) => ({ text: "", hits: [], ms: 0, why });
    if (!this.recall || !scope.trusted || req.noTurnContext || !req.text?.trim()) return none(!scope.trusted ? "群聊 / 陌生人不检索" : "");
    const scene = sceneOf(scope);
    if (scene === "guest") return none("群聊 / 陌生人不检索");
    if (loadMode(scene, "MEMORY.md") === "full") return none("这个场景整篇加载了 MEMORY.md");
    const t0 = Date.now();
    let late = false;
    try {
      const hits = await Promise.race([
        this.recall(agent, req.text),
        new Promise<{ line: string; why: string }[]>((r) => setTimeout(() => { late = true; r([]); }, RECALL_WAIT_MS).unref?.()),
      ]);
      const ms = Date.now() - t0;
      // 发给模型的只有记忆本身；会话页 ⓘ 里多显示一句是哪些词让它被挑中的
      return { text: hits.length ? `${RECALL_TAG}\n${hits.map((h) => `- ${h.line}`).join("\n")}` : "", hits: hits.map((h) => h.why ? `${h.line}（命中：${h.why}）` : h.line), ms, why: late ? `超过 ${RECALL_WAIT_MS / 1000} 秒没检索完，这轮不附` : hits.length ? "" : "没有相关的" };
    } catch (e: any) {
      console.log(`[agent] ⚠️  ${agent.id} 自动回忆失败（这轮不附）: ${e.message}`);
      return { ...none(`检索失败：${e.message}`), ms: Date.now() - t0 };
    }
  }

  /**
   * 近况（LRN 2026-10-26，症状「heartbeat 主动聊天老问已经说过的事；另一个 agent 又问一遍」）：
   * 每个会话只看得见自己的历史——飞书私聊、网页聊天、独立定时任务、别的 agent 各说各的，跨会话只能靠 agent 自己写记忆文件。
   * 这里直接从库里摘最近 RECENT_HOURS 小时、别处（自己的其它会话 + 其他 agent）跟主人的往来，按时间排好放进系统提示，
   * 并明说「说过的别再问、别再重复」。零额外模型调用；字数上限 BUDGETS.recent（0 = 关）。
   */
  recentActivity(agent: AgentInfo, currentKey: string): string {
    const budget = BUDGETS.recent ?? 0;
    if (budget <= 0) return "";
    const since = Date.now() / 1000 - RECENT_HOURS * 3600;
    const items: { ts: number; line: string }[] = [];
    // 同一句话可能同时在 heartbeat 会话和接收方会话里（主动消息会记进接收方会话），只列一次
    const seenText = new Set<string>();
    for (const a of this.agents.list()) {
      let rows: ReturnType<AgentStore["recentOwnerMessages"]>;
      try { rows = this.store(a.id).recentOwnerMessages(since, a.id === agent.id ? currentKey : "", 200); } catch { continue; }
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
        items.push({ ts: r.ts, line: `- ${when} [${tag}] ${who}：${Array.from(text).slice(0, 160).join("")}` });
      }
    }
    if (!items.length) return "";
    items.sort((x, y) => y.ts - x.ts);
    const out: string[] = [];
    let used = 0;
    for (const it of items) {
      used += it.line.length + 1;
      if (used > budget) break;
      out.push(it.line);
    }
    return "<recent_activity>\n最近两天在别的对话里（你在其它渠道、以及家里其他 agent）跟主人的往来，按时间排列、已截断。"
      + "这些都已经发生过：主人说过的事别再问，你或别人已经说过的话别再重复，需要时自然地接上。\n"
      + out.reverse().join("\n") + "\n</recent_activity>";
  }

  /** 某个 agent 在普通会话里能看到的全部内置工具（管理界面白名单用，不过滤白名单本身） */
  allToolNames(agent: AgentInfo): { name: string; label: string; description: string; plugin: boolean; guest_source: boolean; guest_locked: boolean }[] {
    const scope: RunScope = { agentId: agent.id, sessionKey: `${agent.id}:main`, kind: "main", channel: "webchat", purpose: "list", hop: 0, chain: [], meta: {}, trusted: true };
    const seen = new Set<string>();
    const plugin = new Set(this.pluginProviders.flatMap((p) => p(scope, agent)).map((t) => t.name));
    // 扩展 / MCP 里哪些是标了「陌生人也能用」的：拿不可信的上下文问一遍提供者
    const guestSource = new Set(this.pluginProviders.flatMap((p) => p({ ...scope, trusted: false }, agent)).map((t) => t.name));
    return this.allProviders().flatMap((p) => p(scope, agent)).filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)))
      .map((t) => ({ name: t.name, label: t.label, description: t.description, plugin: plugin.has(t.name), guest_source: guestSource.has(t.name), guest_locked: !plugin.has(t.name) && guestLocked(t.name) }));
  }

  private toolsFor(scope: RunScope, agent: AgentInfo, req: RunRequest): AgentTool<any>[] {
    // 同名工具只留第一个：内置的先注册，扩展 / MCP 起了重名也盖不掉内置工具
    const seen = new Set<string>();
    const tag = (plugin: boolean) => (p: ToolProvider) => p(scope, agent).map((t) => ({ t, plugin }));
    const all = [...this.providers.flatMap(tag(false)), ...this.pluginProviders.flatMap(tag(true))]
      .filter(({ t }) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
    const allow = agent.tools.includes("*") ? null : new Set(agent.tools);
    // 按场景的工具权限（toolpolicy.ts）：群聊 / 陌生人只给白名单
    const scene = sceneOf(scope);
    // 这条消息已经带着照片（设备取景拍照 / 「看看这是什么」拍完发来的 / 手机发的图）：这一轮不给 take_photo。
    // 不然模型看到「这是什么」就又去调拍照，设备对话里拍照工具只会说「下一条再拍」然后结束这一轮，
    // 可设备刚拍完、不会再拍——对话就断在「我看看」上（2026-10-25 真机）
    const hasImage = !!req.images?.length;
    return all.filter(({ t, plugin }) => toolAllowed(scene, t.name, plugin)).map(({ t }) => t)
      .filter((t) => (!allow || allow.has(t.name)) && (!req.toolAllow || req.toolAllow(t.name)) && !(hasImage && t.name === "take_photo"));
  }

  // ── 压缩 ──

  /**
   * 回复之前顺带做的压缩：有时限、能取消。它在会话锁里跑——以前摘要那次模型调用既没超时也不理取消，
   * 接口一卡住，这个 agent 的这个会话就永远排不上队（症状「某个 agent 不理人了，换个 agent 正常」）。
   * 超时 / 失败就跳过，这轮照常回复，下轮再试。
   */
  private async maybeCompact(agent: AgentInfo, store: AgentStore, key: string, signal?: AbortSignal, o: { limit: number; keepTokens?: number; trigger?: string } = { limit: agent.compaction.max_tokens }) {
    const hist = store.history(key);
    const summary = store.getSession(key)?.summary ?? "";
    // 按「进上下文时的样子」算：旧工具结果反正会被截短，别拿原文的大小去触发压缩
    const size = estimateTokens(summary) + pruneToolResults(hist.map((h) => h.msg)).reduce((n, m) => n + msgTokens(m), 0);
    if (size <= o.limit) return;
    // 摘要按块各一次（见 compactNow），每次最多 timeoutSecs
    const ms = this.opts.timeoutSecs * 1000 * Math.min(8, 1 + Math.ceil(size / this.compactChunk));
    const ac = new AbortController();
    let why = "";
    const onAbort = () => { why ||= "已取消"; ac.abort(); };
    if (signal?.aborted) return;
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { why ||= `超过 ${ms / 1000} 秒`; ac.abort(); }, ms);
    const aborted = new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error(why)), { once: true }));
    const work = this.compactNow(agent, store, key, ac.signal, o.keepTokens ?? Math.floor(o.limit * KEEP_RATIO), o.trigger ?? "before", { size, limit: o.limit });
    work.catch(() => {});                                     // 放弃等待之后它再报错也别变成未处理的 rejection
    try { await Promise.race([work, aborted]); }
    catch (e: any) {
      console.log(`[agent] ⚠️  ${agent.id} 压缩${why === "已取消" ? "被取消" : "失败"}（下轮再试）: ${e.message}`);
      try { store.addEvent(key, "compact_failed", { trigger: o.trigger ?? "before", error: e.message, size, limit: o.limit }); } catch { /* 记不下就算了 */ }
    }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
  }

  /**
   * 回复之后：历史已经接近阈值（七成）就在后台先压，下一轮来的时候不用先等压缩。
   * 排在这个会话的队里（serial），跟下一轮不会同时改历史；不占全局并发名额（只调便宜模型）
   */
  private compactAfterReply(req: RunRequest) {
    if (!this.backgroundCompact || req.persist === false || req.kind === "sub" || runScope()) return;
    const agent = this.agents.get(req.agentId);
    const key = `${req.agentId}|${req.sessionKey}`;
    const limit = this.compactLimit.get(key);
    if (!agent || !limit) return;
    const store = this.store(agent.id);
    const size = estimateTokens(store.getSession(req.sessionKey)?.summary ?? "") + pruneToolResults(store.history(req.sessionKey).map((h) => h.msg)).reduce((n, m) => n + msgTokens(m), 0);
    if (size <= limit * 0.7) return;
    void this.serial(key, () => this.maybeCompact(agent, store, req.sessionKey, undefined, { limit: Math.floor(limit * 0.7), keepTokens: Math.floor(limit * KEEP_RATIO), trigger: "background" }))
      .catch((e) => console.log(`[agent] ⚠️  ${agent.id} 后台压缩失败: ${e.message}`));
  }

  /** 手动或自动压缩 */
  async compact(agentId: string, key: string) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`没有 agent ${agentId}`);
    const limit = this.compactLimit.get(`${agentId}|${key}`) ?? agent.compaction.max_tokens;
    return this.serial(`${agentId}|${key}`, () => this.compactNow(agent, this.store(agentId), key, undefined, Math.floor(limit * KEEP_RATIO), "manual"));
  }

  /**
   * 压缩：留下最近的消息（按 token，最多 keepTokens、最多 keep_messages 条，至少留最近一轮），其余总结成摘要。
   * 从一条用户消息处切开，不把工具调用和它的结果拆开
   */
  private async compactNow(agent: AgentInfo, store: AgentStore, key: string, signal?: AbortSignal, keepTokens = Math.floor(agent.compaction.max_tokens * KEEP_RATIO),
    trigger = "manual", why?: { size: number; limit: number }): Promise<boolean> {
    const t0 = Date.now();
    const hist = store.history(key);
    const eff = pruneToolResults(hist.map((h) => h.msg));
    const userIdx = hist.map((h, i) => (h.msg.role === "user" ? i : -1)).filter((i) => i >= 0);
    if (!userIdx.length) return false;
    const lastUser = userIdx.at(-1)!;
    // 从后往前攒，超了 keepTokens 或 keep_messages 就停；切点挪到其后第一条用户消息（宁可少留），但至少留最近一轮
    let used = 0, start = hist.length;
    for (let i = hist.length - 1; i >= 0; i--) {
      used += msgTokens(eff[i]);
      if (used > keepTokens || hist.length - i > agent.compaction.keep_messages) break;
      start = i;
    }
    const cut = Math.min(userIdx.find((i) => i >= start) ?? lastUser, lastUser);
    if (cut <= 0) return false;
    const old = hist.slice(0, cut);
    if (this.beforeCompact) {
      try { await this.beforeCompact(agent, key); }
      catch (e: any) { console.log(`[agent] ⚠️  ${agent.id} 记忆冲刷失败: ${e.message}`); }
      if (signal?.aborted) throw new Error("已取消");
    }
    // 分块滚动摘要：把要压的对话切成每块 COMPACT_CHUNK_TOKENS 左右，「上一版摘要 + 这一块」→ 新摘要。
    // 以前一次塞几万 token 进去：推理型模型（MiniMax-M3 等）把输出额度花在思考上，正文为空 → 「摘要为空」，
    // 而且每轮重试、历史越积越大（2026-10-24 真机：冲刷那次输入 6.9 万 token，连着两轮空摘要）
    const lines = old.map((h) => {
      const who = h.msg.role === "user" ? "用户" : h.msg.role === "assistant" ? agent.name : "工具结果";
      return `${who}：${messageText(h.msg).slice(0, h.msg.role === "toolResult" ? 600 : 1500)}`;
    });
    const chunks: string[][] = [[]];
    let size = 0;
    for (const ln of lines) {
      const n = estimateTokens(ln);
      if (size + n > this.compactChunk && chunks.at(-1)!.length) { chunks.push([]); size = 0; }
      chunks.at(-1)!.push(ln); size += n;
    }
    const model = this.models.resolve(agent.cheap_model || this.models.cheapRef() || agent.model);
    const perCall = this.opts.timeoutSecs * 1000;
    let summary = store.getSession(key)?.summary ?? "";
    let failed = 0;
    // 顺手挑出要记住的事：给摘要模型看一眼已有的长期记忆（结尾一段），免得重复记
    const tail = (f: string, n: number) => Array.from(this.agents.readFile(agent.id, f).trim()).slice(-n).join("");
    const memTail = this.remember ? [tail("USER.md", 1500), tail("MEMORY.md", 1500)].filter(Boolean).join("\n…\n") : "";
    const remembered: string[] = [];
    for (const [i, chunk] of chunks.entries()) {
      if (signal?.aborted) throw new Error("已取消");
      let text = "";
      try {
        // 只写了【记住】没写摘要（模型偶尔把【记住】放最前）：记住的那几条拿来当摘要；一条都没有就再要一次，还不行才走兜底
        for (let attempt = 0; ; attempt++) {
        const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(perCall)]) : AbortSignal.timeout(perCall);
        const res = await withScope({ agentId: agent.id, sessionKey: key, kind: "isolated", channel: "system", purpose: "compact", hop: 0, chain: [], meta: {}, trusted: false },
          () => this.models.quick(model, {
            systemPrompt: "你负责把一段对话压缩成摘要，供之后继续对话时参考。保留：人物、约定、待办、偏好、未解决的问题、重要事实与数字。"
              + "省略寒暄与重复。用第三人称、中文、条目式，不超过 800 字。直接输出，不要思考过程。"
              + (this.remember ? "\n先写「【摘要】」和摘要正文；摘要之后另起一行写「【记住】」，下面每行一条这段对话里新出现、以后还用得着的事："
                + "大多数以「长期：」开头（约定、经历过的事、计划与进展、项目、重要日子）；只跟今天有关的以「今天：」开头；"
                + "只有主人本人的稳定个人信息（称呼、家人、生日、长期作息、口味与忌口、习惯和喜好）才以「主人：」开头，这类很少，拿不准就写成「长期：」。"
                + "已有记忆里有的别重复，没有就写「无」。" : ""),
            messages: [{ role: "user", content: (memTail && i === 0 ? `已有的记忆（节选，别重复）：\n${memTail}\n\n` : "") + (summary ? `此前的摘要：\n${summary}\n\n` : "") + `需要并进摘要的对话${chunks.length > 1 ? `（第 ${i + 1}/${chunks.length} 段）` : ""}：\n${chunk.join("\n")}`
              + (attempt ? "\n\n（上一次只写了【记住】、没写摘要正文。这次务必先写【摘要】和正文。）" : ""), timestamp: Date.now() }],
          }, { signal: sig, maxTokens: Math.max(model.maxTokens || 0, COMPACT_MAX_OUTPUT) }));
        if (signal?.aborted) throw new Error("已取消");          // 放弃等待之后才回来：别再改历史（下一轮可能已经在用了）
        const u = res.usage;
        if (u) store.recordUsage(key, "compact", { model: `${res.provider}/${res.model}`, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total ?? 0 });
        if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage || "摘要模型调用失败");
        const parsed = parseCompactOutput(stripThinkText(res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")));
        text = parsed.summary;
        if (!text && parsed.remembered.length) {
          console.log(`[agent] ⚠️  ${agent.id} 摘要第 ${i + 1}/${chunks.length} 段只有【记住】没有正文，拿记住的 ${parsed.remembered.length} 条当摘要`);
          text = parsed.remembered.map((r) => `- ${r.split("\n")[1]}`).join("\n");
        }
        if (text || attempt >= 1) { remembered.push(...parsed.remembered); break; }
        console.log(`[agent] ⚠️  ${agent.id} 摘要第 ${i + 1}/${chunks.length} 段为空（${res.stopReason}），再要一次`);
        }
        if (!text) throw new Error("摘要为空（两次都没写出正文）");
      } catch (e: any) {
        if (signal?.aborted) throw new Error("已取消");
        failed++;
        console.log(`[agent] ⚠️  ${agent.id} 摘要第 ${i + 1}/${chunks.length} 段失败，这段改记要点: ${e.message}`);
        // 兜底：不再每轮重试、让历史越积越大——留下这段里用户说过的话（各截一点），照样压掉
        const said = chunk.filter((l) => l.startsWith("用户：")).map((l) => "- " + Array.from(l.slice(3).replace(/^\[[^\]]*\]\s*/, "")).slice(0, 60).join("")).slice(-12);
        text = [summary, `（有一段较早的对话没能总结，用户当时说过：）`, ...said].filter(Boolean).join("\n");
      }
      summary = text;
    }
    if (failed === chunks.length && !summary.trim()) throw new Error("摘要为空");
    store.compact(key, old.at(-1)!.id, summary);
    const wrote: { target: string; text: string }[] = [];
    for (const r of remembered.slice(0, 20)) {
      const [t, text] = r.split("\n");
      const target = t === "主人" ? "user" : t === "长期" ? "long" : "daily";
      wrote.push({ target, text });
      try { this.remember?.(agent, target, text); } catch (e: any) { console.log(`[agent] ⚠️  ${agent.id} 记忆写入失败: ${e.message}`); }
    }
    console.log(`[agent] 🗜️  ${agent.id} ${key} 压缩 ${old.length} 条（${chunks.length} 段${failed ? `，${failed} 段没总结成` : ""}）→ 摘要 ${Array.from(summary).length} 字${remembered.length ? `，记下 ${remembered.length} 条` : ""}`);
    // 会话页「系统事件」：什么时候、为什么压的，压了多少、剩多少，顺手记进了哪些记忆
    try {
      const sum = (a: Message[]) => a.reduce((n, m) => n + msgTokens(m), 0);
      store.addEvent(key, "compact", {
        trigger, size: why?.size, limit: why?.limit, ms: Date.now() - t0, model: `${model.provider}/${model.id}`,
        messages: old.length, oldTokens: sum(eff.slice(0, cut)), kept: hist.length - cut, keptTokens: sum(eff.slice(cut)),
        chunks: chunks.length, failed, summary: Array.from(summary).length, remembered: wrote,
      });
    } catch { /* 记不下就算了 */ }
    return true;
  }

  /**
   * 已经以文字发出去的回复（IM、网页、投到 IM 的任务）要顺带念时，转成适合朗读的一段。
   * 去掉格式后不超过 agent 的语音字数（voice_max_chars，留两成余量）就直接念；更长的交给便宜模型压成口语，
   * 失败或超时退回截断。
   */
  async spoken(agentId: string, text: string): Promise<string> {
    const agent = this.agents.get(agentId);
    const max = agent?.voice_max_chars || 80;
    const plain = toSpoken(text, 100_000);
    if (!plain || Array.from(plain).length <= max * 1.2 || !agent) {
      if (plain) console.log(`[agent] 🔈 ${agentId} 回复不长（${Array.from(plain).length} 字），直接念`);
      return plain;
    }
    const t0 = Date.now();
    let modelRef = "";
    // 不开思考 20 秒；按模型设置开着思考的给 60 秒（文字早就发出去了，等的只是这段语音）
    let limit = 20_000;
    try {
      const model = this.models.resolve(this.models.voiceRef() || agent.cheap_model || this.models.cheapRef() || agent.model);
      modelRef = `${model.provider}/${model.id}`;
      const lv = this.models.thinkingOf(model);
      const think = !!lv && lv !== "off";
      if (think) limit = 60_000;
      console.log(`[agent] 🔈 ${agentId} 回复 ${Array.from(plain).length} 字、没写朗读版，用 ${modelRef}${think ? `（思考：${lv}）` : ""}压成口语…`);
      const res = await Promise.race([
        withScope({ agentId, sessionKey: `${agentId}:voice`, kind: "isolated", channel: "system", purpose: "voice", hop: 0, chain: [], meta: {}, trusted: false },
          () => this.models.quick(model, {
            systemPrompt: `你是${agent.name}。下面是你刚用文字发给主人的回复，现在要在家里的设备上用语音念出来。`
              + `把它改写成适合朗读的口语，不超过 ${max} 字：保留结论和关键数字，省略细节、列表、代码和网址；`
              + "不要用 markdown、表情符号；内容放不下时最后说一句「详细的我发在消息里了」。只输出要念的话本身。",
            messages: [{ role: "user", content: text.slice(0, 6000), timestamp: Date.now() }],
          }, { signal: AbortSignal.timeout(limit), think })),           // 到时真的中止请求，别在后台接着想
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("超时")), limit)),
      ]);
      if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage || "模型调用失败");
      const out = toSpoken(res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""), max * 2);
      const u = res.usage;
      if (u) this.store(agentId).recordUsage(`${agentId}:voice`, "voice", { model: `${res.provider}/${res.model}`, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total ?? 0 });
      if (out) {
        console.log(`[agent] 🔈 ${agentId} 压成口语 ${Array.from(out).length} 字（${modelRef}，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
        return out;
      }
      throw new Error(`模型没写出正文（${res.stopReason}）`);
    } catch (e: any) {
      const ms = Date.now() - t0;
      // 到时请求被中止，服务商那边报的是「This operation was aborted」，这里写明白是超时
      const why = ms >= limit - 500 ? `超时（${limit / 1000} 秒没写完${/abort/i.test(String(e.message)) ? "，请求已中止" : ""}）` : e.message;
      console.log(`[agent] ⚠️  ${agentId} 语音摘要失败，改为截断（${modelRef || "?"}，${(ms / 1000).toFixed(1)}s）: ${why}`);
    }
    return toSpoken(text, max);
  }

  /** 冲刷等内部运行：不加锁（调用方已在会话锁里） */
  runUnlocked(req: RunRequest) { return this.execute(req); }
}
