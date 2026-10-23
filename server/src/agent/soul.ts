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

/** 会话种类决定注入哪些文件：sub（子 agent）不给 USER/MEMORY，同 OpenClaw */
export type SessionKind = "main" | "chat" | "isolated" | "sub";

const ORDER: [string, (k: SessionKind) => boolean][] = [
  ["SOUL.md", () => true],
  ["IDENTITY.md", () => true],
  ["USER.md", (k) => k !== "sub"],
  ["AGENTS.md", () => true],
  ["TOOLS.md", () => true],
  ["MEMORY.md", (k) => k !== "sub"],
];

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
    + "不要用 markdown、列表、表情符号、括号注释，不要念网址。",
  webchat: "你正在网页聊天窗口里和主人打字聊天，可以用 markdown，可以长一点。",
  system: "这是一次后台任务，没有人在实时等你回复。",
  a2a: "这条消息来自另一个 agent，不是主人。回复会原样交给对方。",
  feishu: "你正在飞书上和人聊天，可以用 markdown，长短看需要。群聊消息前的 [名字] 是发言人。",
  qq: "你正在 QQ 上和人聊天：QQ 不渲染 markdown，用纯文本，别太长。群聊消息前的 [名字] 是发言人。",
  onebot: "你正在 QQ 上和人聊天：QQ 不渲染 markdown，用纯文本，别太长。群聊消息前的 [名字] 是发言人。",
};

export interface SoulOpts {
  agent: AgentInfo;
  kind: SessionKind;
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
  for (const [f, want] of ORDER) {
    if (!want(o.kind)) continue;
    const t = readSafe(path.join(ws, f)).trim();
    if (t) parts.push(`<${f}>\n${clip(t, BUDGETS[f])}\n</${f}>`);
  }
  // 今天和昨天的笔记：新会话也能接上最近发生的事
  if (o.kind !== "sub") {
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
