// 系统提示组装（§6.3）：workspace 里的人设文件按固定顺序拼起来，每个文件有字数预算，
// 超了截断注入（磁盘上的文件不动）。再附上时间、在家状态、渠道提示、会话摘要、技能目录。
import fs from "node:fs";
import path from "node:path";
import type { AgentInfo } from "./registry.ts";
import { parseLocalTime, strftime } from "../util/time.ts";

/** 每个文件注入的字数上限（字符数，中文一个字算一个） */
// 每个人设文件最多注入多少字（超出部分截掉，文件本身不动）。默认与 OpenClaw 的 bootstrapMaxChars 一致：每个文件 2 万字。
// config.json 里 "prompt_budgets": { "SOUL.md": 30000, "daily": 10000 } 可以单独调。
export const DEFAULT_BUDGETS: Record<string, number> = {
  "SOUL.md": 20000, "IDENTITY.md": 20000, "USER.md": 20000, "AGENTS.md": 20000, "TOOLS.md": 20000,
  "MEMORY.md": 20000, "HEARTBEAT.md": 20000, daily: 8000,
  // 近况：别的会话 / 别的 agent 最近跟主人说过的话（字数上限；0 = 不注入）
  recent: 4000,
};
export const BUDGETS: Record<string, number> = { ...DEFAULT_BUDGETS };

/** 用配置覆盖注入上限（只认已知的键和正整数） */
export function applyBudgets(over: Record<string, unknown> | undefined) {
  Object.assign(BUDGETS, DEFAULT_BUDGETS);
  for (const [k, v] of Object.entries(over ?? {})) {
    const n = Math.trunc(Number(v));
    if (k in DEFAULT_BUDGETS && n > 0) BUDGETS[k] = n;
  }
}

export type SessionKind = "main" | "chat" | "isolated" | "sub";

/**
 * 按场景加载人设文件（LRN 2026-10-27）：以前除了子任务一律全量注入，群聊陌生人也拿到主人的 USER / MEMORY / 笔记，
 * 待办、定时任务这类干活的场景也背着整篇性格和记忆。现在每个场景只带它用得上的，其余需要时用 memory_get / memory_search 现读。
 * config.json 的 prompt_files 可改（管理界面 Agents → 人设文件 → 加载场景）；guest 永远拿不到 PRIVATE_FILES。
 */
export type Scene = "owner" | "guest" | "heartbeat" | "cron" | "task" | "sub" | "a2a";
/** 注入顺序。daily = 今天和昨天的每日笔记 */
export const PROMPT_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md", "daily"] as const;
export const SCENES: { id: Scene; label: string; desc: string }[] = [
  { id: "owner", label: "主人对话", desc: "设备、手机、网页、主人的 IM 私聊" },
  { id: "guest", label: "群聊 / 陌生人", desc: "IM 群聊、配对来的人：不给主人的私人信息" },
  { id: "heartbeat", label: "Heartbeat", desc: "例行检查、主动开口" },
  { id: "cron", label: "定时任务", desc: "到点提醒、播报" },
  { id: "task", label: "待办", desc: "夜间干活" },
  { id: "sub", label: "子任务", desc: "派出去的分身" },
  { id: "a2a", label: "agent 间对话", desc: "别的 agent 找她" },
];
/** 主人的私人信息：群聊、陌生人的会话里无论怎么配都不加载 */
export const PRIVATE_FILES = new Set(["USER.md", "MEMORY.md", "daily"]);
export const DEFAULT_LOADOUT: Record<Scene, string[]> = {
  owner: ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "daily"],
  guest: ["SOUL.md", "IDENTITY.md", "AGENTS.md"],
  heartbeat: ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md", "daily"],
  cron: ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md"],
  task: ["IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md"],
  sub: ["IDENTITY.md", "AGENTS.md", "TOOLS.md"],
  a2a: ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md"],
};
export const LOADOUT: Record<Scene, string[]> = structuredClone(DEFAULT_LOADOUT);

/** 用配置覆盖各场景的文件（只认已知的场景和文件；guest 去掉私人文件） */
export function applyLoadout(over: Record<string, unknown> | undefined) {
  Object.assign(LOADOUT, structuredClone(DEFAULT_LOADOUT));
  for (const [k, v] of Object.entries(over ?? {})) {
    if (!(k in DEFAULT_LOADOUT) || !Array.isArray(v)) continue;
    LOADOUT[k as Scene] = (PROMPT_FILES as readonly string[]).filter((f) => v.includes(f) && !(k === "guest" && PRIVATE_FILES.has(f)));
  }
}

/** 这一轮算哪个场景。不可信的一律 guest（陌生人建的定时任务、从群聊派出的子任务也是） */
export function sceneOf(r: { trusted: boolean; purpose: string; kind: string; channel: string }): Scene {
  if (!r.trusted) return "guest";
  if (r.purpose === "heartbeat") return "heartbeat";
  if (r.purpose === "task") return "task";
  if (r.purpose === "cron") return "cron";
  if (r.kind === "sub") return "sub";
  if (r.channel === "a2a") return "a2a";
  return "owner";
}

export function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max).join("") + `\n…（已截断，全文 ${chars.length} 字，需要时用 memory_get 读全文）`;
}

const readSafe = (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };

export function dailyNotePath(ws: string, d = new Date()) {
  return path.join(ws, "memory", `${strftime("%Y-%m-%d", d)}.md`);
}

export const CHANNEL_HINTS: Record<string, string> = {
  device: "你正在通过桌上的 CoreS3 设备用语音和主人说话：回复会被合成语音播放。要口语化、简短（一般不超过 {max} 字），"
    + "不要用 markdown、列表、表情符号、括号注释，不要念网址。"
    + "主人的话是语音识别转的文字，可能有同音错字、漏字：按上下文理解本意，实在拿不准再简短确认一句。",
  webchat: "你正在网页聊天窗口里和主人打字聊天，可以用 markdown，可以长一点。",
  system: "这是一次后台任务，没有人在实时等你回复。",
  a2a: "这条消息来自另一个 agent，不是主人。回复会原样交给对方。",
  feishu: "你正在飞书上和人聊天，可以用 markdown，长短看需要。群聊消息前的 [名字] 是发言人。",
  qq: "你正在 QQ 上和人聊天：QQ 不渲染 markdown，用纯文本，别太长。群聊消息前的 [名字] 是发言人。",
  onebot: "你正在 QQ 上和人聊天：QQ 不渲染 markdown，用纯文本，别太长。群聊消息前的 [名字] 是发言人。",
};

export interface SoulOpts {
  agent: AgentInfo;
  scene: Scene;
  channel: string;
  summary?: string;
  /** 额外段落（heartbeat 清单、任务说明等） */
  extra?: string[];
  skills?: { name: string; description: string }[];
  /** 可以联系的其他 agent */
  peers?: { id: string; name: string }[];
  /** 投递目标是设备时按语音口径回复（定时任务播报） */
  voiceDelivery?: boolean;
}

export function buildSystemPrompt(o: SoulOpts): string {
  const ws = o.agent.workspace;
  const parts: string[] = [];
  const want = new Set(LOADOUT[o.scene].filter((f) => !(o.scene === "guest" && PRIVATE_FILES.has(f))));
  const skipped: string[] = [];
  for (const f of PROMPT_FILES) {
    if (f === "daily") continue;
    const t = want.has(f) ? readSafe(path.join(ws, f)).trim() : "";
    if (t) parts.push(`<${f}>\n${clip(t, BUDGETS[f])}\n</${f}>`);
    else if (!want.has(f) && f !== "HEARTBEAT.md" && fs.existsSync(path.join(ws, f))) skipped.push(f);
  }
  // 今天和昨天的笔记：新会话也能接上最近发生的事
  if (want.has("daily")) {
    const today = new Date();
    const yest = new Date(today.getTime() - 86400_000);
    const notes = [yest, today].map((d) => {
      const t = readSafe(dailyNotePath(ws, d)).trim();
      return t ? `## ${strftime("%Y-%m-%d", d)}\n${t}` : "";
    }).filter(Boolean).join("\n\n");
    if (notes) parts.push(`<recent_notes>\n${clip(notes, BUDGETS.daily)}\n</recent_notes>`);
  }
  if (o.skills?.length) {
    parts.push("<skills>\n可用技能（需要时用 skill_read 读全文再照做；要跑的脚本用 exec 执行）：\n"
      + o.skills.map((s) => `- ${s.name}：${s.description}`).join("\n") + "\n</skills>");
  }
  if (o.peers?.length) {
    parts.push("<agents>\n你可以联系的其他 agent（sessions_send / sessions_spawn）：\n"
      + o.peers.map((p) => `- ${p.id}（${p.name}）`).join("\n") + "\n</agents>");
  }
  // 没加载的告诉她一声，需要时自己去读（群聊陌生人那边不提：她在那里本来就不该去翻主人的东西）
  if (o.scene !== "guest" && (skipped.length || !want.has("daily"))) {
    const list = [...skipped, ...(want.has("daily") ? [] : ["每日笔记（memory/）"])];
    parts.push(`<not_loaded>\n这次没加载：${list.join("、")}。用到时用 memory_get 读、memory_search 搜。\n</not_loaded>`);
  }
  if (o.summary) parts.push(`<earlier_conversation_summary>\n${o.summary}\n</earlier_conversation_summary>`);
  for (const e of o.extra ?? []) if (e) parts.push(e);

  const ctx: string[] = [];
  const hint = CHANNEL_HINTS[o.voiceDelivery ? "device" : o.channel] ?? "";
  if (hint) ctx.push(hint.replace("{max}", String(o.agent.voice_max_chars)));
  if (o.voiceDelivery && o.channel !== "device") ctx.push("你的回复会被直接播报到设备上，只写要说的话本身。");
  ctx.push("每条用户消息前的 [时间…] 是系统自动附上的当时情况，不是用户说的话。");
  parts.push(`<context>\n${ctx.join("\n")}\n</context>`);
  return parts.join("\n\n");
}

/**
 * 每条用户消息前附的一行当时情况（时间、在家状态）。放在消息里而不是系统提示里：
 * 系统提示一变，服务商侧的前缀缓存就全部失效，而时间每分钟都在变。
 */
export function turnContext(localTime?: string, presence?: string): string {
  // 设备带了 X-Local-Time 就用设备的时间（与快捷指令口径一致）
  const d = parseLocalTime(localTime);
  const bits = [`时间 ${strftime("%Y-%m-%d %H:%M", d)} 周${"日一二三四五六"[d.getDay()]}`];
  if (presence) bits.push(`主人${presence}`);
  return `[${bits.join("｜")}]`;
}
