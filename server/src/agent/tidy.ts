// 记忆整理（LRN 2026-11-10，症状「USER.md 的自动记录满了、MEMORY.md 里过时 / 重复 / 流水账越积越多，旧信息被当成现在的事实，她就显得糊涂」）：
// 定期（默认每 7 天、在待办的静默时段、她空闲时）或按需（管理界面「立即整理」、她的 memory_tidy 工具），
// 用这个 agent 自己的主模型读 USER.md 的「自动记录」一节和 MEMORY.md，合并重复、删掉过时和流水、该常驻的挪进 USER.md、不该常驻的挪出来。
// 同一趟也整理守则类文件 AGENTS.md / TOOLS.md / HEARTBEAT.md（她自己往里记教训、规矩，一样会重复和过时；共享那份和 agent 自己的补充各整理各的）。
// SOUL.md / IDENTITY.md 是主人写的设定，不动。守则文件上次整理后没变过、或者内容很少（不到 DOC_MIN_CHARS）就跳过，不调模型。
// 保底：USER.md 手写部分一个字不动；写之前整份备份（.persona-backup-<时间>/）；删掉的不真删，进 MEMORY.archive.md（不注入、不自动回忆，她能 read_file）；
// 一次删得太多（剩下的不到原来的 MIN_KEEP）就不写，只报告；输出不是合法 JSON、超长也不写。
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import path from "node:path";
import type { AgentInfo, AgentRegistry } from "./registry.ts";
import type { ModelRegistry } from "./models.ts";
import { stripThinkText } from "./models.ts";
import { USER_AUTO_HEAD, USER_AUTO_MAX, USER_ITEM_MAX, STALE_RECALLS } from "./memory.ts";
import { stripProv, stripAlias, provOf, pinnedOf, PINNED_HEAD, PINNED_MAX, TOPICS_DIR, topicName } from "./memfmt.ts";
import { parseFiles, numbered, cleanOps, applyOps, batches } from "./tidy-ops.ts";
import { ownExtra, sharedPath } from "./persona.ts";
import { inActiveHours } from "./cron.ts";
import { health } from "./health.ts";

/** 整理后条目总字数至少是原来的这么多，否则当成模型删过头、不写 */
export const MIN_KEEP = 0.4;
/** MEMORY.md（连同主题页）超过这么多字就不整理，报告让主人先看看。按编号改、分段整理之后，输出不再随文件变大，这道线只防真的失控 */
export const TIDY_MAX_CHARS = 200_000;
/** 条目超过这么多字就分段整理（一段一次模型调用），每次给模型看的不至于太长 */
export const TIDY_BATCH_CHARS = 12_000;
/** 整理时一次模型调用最多等多久 */
export const TIDY_CALL_MS = 300_000;
/** 整理后条目总字数最多是原来的这么多倍（补别称会多一点；再多就是在编，或者主题页把内容抄了两份） */
export const MAX_GROW = 1.3;
/** 一次最多拿多少条记忆去对照原文核对（每条带几段原文，太多会撑爆这次调用） */
export const VERIFY_MAX = 20;
/** 核对过的条目（按出处）多少天内不再核对 */
export const VERIFY_DAYS = 30;
/** 每日笔记提炼：第一次（还没提炼过）往回看多少天；更早的照旧留着、能搜 */
export const DAILY_BACKLOG_DAYS = 60;
/** 每次交给模型的笔记量（字） */
export const DAILY_CHUNK_CHARS = 12_000;
/** 一趟整理最多提炼几段（积压多的分几周做完） */
export const DAILY_MAX_CALLS = 4;
/** 一趟最多从笔记里记下几条 */
export const DISTILL_MAX_ITEMS = 30;

const DISTILL_PROMPT = `你在帮一个 AI 助手回顾它这几天的每日笔记（N 是第几行），把以后还用得上的挑出来记进长期记忆。每日笔记只在当天和第二天带着，过后就不会再主动想起；没被挑出来的仍然留在笔记里、能搜到。

挑这些（判据：过几天、几周再读到还成立吗？以后用得上吗？）：
- 主人新说的偏好、习惯、约定、计划（计划写清楚是哪天的事）
- 试过管用 / 不管用的做法、踩过的坑、查证过的结论
- 还没做完、以后要接着做的事
- 关于主人本人的稳定信息（称呼、家人、生日、作息、口味）放进 user，每条一句短话
不要：当天的经过和心情、heartbeat / 定时任务的例行记录、随时查得到的状态（设备 / 打印机 / 天气 / 在不在家）、已经过去的一次性安排、「相关的已有记忆」里已经有的。
宁缺毋滥：没什么值得记的就输出空数组。每条写成脱离当天也看得懂的一句话（别写「今天」「刚才」，要写就写日期），不超过 100 字。今天是 {TODAY}。

只输出一个 JSON：{"long": [{"text": "…", "from": "笔记日期 YYYY-MM-DD", "how": "主人说的 / 查过 / 推测"}], "user": [{"text": "…", "from": "YYYY-MM-DD"}], "summary": "一句话"}`;

/** MEMORY.md + 主题页超过这么多字，才考虑把同一件事的条目挪进主题页 */
export const TOPIC_SPLIT_CHARS = 2500;
export const ARCHIVE_FILE = "MEMORY.archive.md";
/** 一起整理的守则类文件（SOUL / IDENTITY 是主人写的设定，不动） */
export const DOC_FILES = ["AGENTS.md", "TOOLS.md", "HEARTBEAT.md"] as const;
const DOC_DESC: Record<string, string> = {
  "AGENTS.md": "行为守则：它做事要遵守的规矩、主人提过的要求、它自己记下的教训",
  "TOOLS.md": "工具与环境备注：这台电脑上的路径、命令怎么跑、查东西去哪、用工具踩过的坑",
  "HEARTBEAT.md": "定时自查清单：它每隔一段时间被叫醒时要检查、要主动做的事",
};
/** 守则文件内容少于这么多字就不整理（没什么可整理的，省一次模型调用） */
export const DOC_MIN_CHARS = 150;
/** 守则文件整理后至少留原来的这么多，否则不写（删规矩比删记忆更要小心） */
export const DOC_MIN_KEEP = 0.5;
export const DOC_MAX_CHARS = 20_000;
/** 守则文件里移出的条目放这里（和文件同一个目录） */
export const DOC_ARCHIVE = "PERSONA.archive.md";
export type TidyScope = "all" | "memory" | "docs";

/** 她自己的工具：主人说「整理一下记忆」时当场跑一次 */
export function tidyTools(t: MemoryTidy) {
  return (scope: import("./scope.ts").RunScope, agent: AgentInfo): import("@earendil-works/pi-agent-core").AgentTool<any>[] => {
    if (!scope.trusted || scope.kind === "sub") return [];
    return [{
      name: "memory_tidy", label: "整理记忆和守则",
      description: "整理你的记忆和守则文件：memory = USER.md 的自动记录 + MEMORY.md（合并重复、删掉过时和流水账、该常驻的挪进 USER.md）；"
        + "docs = AGENTS.md / TOOLS.md / HEARTBEAT.md（合并重复的规矩、删掉过时的）；all = 都整理（默认）。删掉的进归档文件，不真删；改之前会备份。"
        + "主人让你整理、或者你发现里面重复 / 过时的很多时用，要一两分钟。系统每周也会自动整理。SOUL.md / IDENTITY.md 不归它管。",
      parameters: Type.Object({ scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("memory"), Type.Literal("docs")])) }),
      async execute(_id: string, p: any) {
        const r = await t.run(agent.id, "agent", Date.now(), p?.scope === "memory" || p?.scope === "docs" ? p.scope : "all");
        return r.status === "failed" ? { content: [{ type: "text", text: describe(r) }], details: {}, isError: true } : { content: [{ type: "text", text: describe(r) }], details: { status: r.status } };
      },
    } as any];
  };
}

type Status = "done" | "nochange" | "skipped" | "failed";
/** 一份守则文件的整理结果。scope：shared = 全家共用那份，own = 这个 agent 自己的（补充） */
export interface DocResult {
  file: string; scope: "shared" | "own"; status: Status; why?: string;
  before?: number; after?: number;
  removed?: { text: string; why: string }[];
  summary?: string; backup?: string;
}
export interface TidyResult {
  agent: string; at: number; trigger: string;
  /** 整趟的结果：有一处写进去了就是 done；nochange = 都看过不用改；skipped / failed 带原因 */
  status: Status;
  /** 记忆那部分（USER 自动记录 + MEMORY）的结果；这趟没整理记忆就没有 */
  memStatus?: Status;
  /** 守则文件的结果（跳过没看的不列） */
  docs?: DocResult[];
  why?: string;
  user?: { before: number; after: number };
  memory?: { before: number; after: number };
  removed?: { text: string; why: string }[];
  /** 对照原文改过的条目 */
  corrected?: { text: string; why: string }[];
  /** 这次拿原文核对了几条 */
  verified?: number;
  /** 「常用」一节多少字 */
  pinned?: number;
  /** 这次新建 / 改过的主题页 */
  topics?: string[];
  /** 每日笔记提炼：记进长期记忆 / USER.md 几条、看了哪几天、还剩几天没看（积压多的下次接着） */
  daily?: { long: number; user: number; days: string[]; left: number; why?: string };
  summary?: string;
  backups?: string[];
}

const items = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => /^[-*•]\s+/.test(l)).map((l) => l.replace(/^[-*•]\s+/, "").trim()).filter(Boolean);
const chars = (a: string[]) => a.reduce((n, x) => n + Array.from(x).length, 0);
const stampOf = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

function backup(file: string, stamp: string): string {
  if (!fs.existsSync(file)) return "";
  const dir = path.join(path.dirname(file), `.persona-backup-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, path.basename(file)));
  return path.join(dir, path.basename(file));
}

const PROMPT = `你在帮一个 AI 助手整理它的长期记忆。给你几部分：
A. USER.md 的「自动记录」：关于主人本人的稳定信息（称呼、家人、生日、作息、口味、习惯、喜好），每轮都会常驻在它的上下文里，所以要少而精。
B. 长期记忆（MEMORY.md，可能还有 topics/ 下的主题页）：每条前面有 [编号]。MEMORY.md 开头可能有「${PINNED_HEAD}」一节：这一节每轮都带着。
C. 出处原文（可能没有）：部分条目当初是从哪段对话里记下的，按 [编号] 给出原文节选。
U. 使用情况（可能没有）：哪些条目经常被用上、哪些老被想起却从来没用上。
{BATCH}
你不用重写整份记忆，只输出要对哪几条做什么；没提到的条目原样保留。能用的操作：
- {"op":"delete","n":编号,"why":"过时 / 流水 / 随时查得到 / 临时状态"}：删掉（不真删，进归档）
- {"op":"merge","n":编号,"into":另一条编号,"text":"合并后那条的新写法（可省）"}：重复、说的是同一件事，并进另一条
- {"op":"edit","n":编号,"text":"新写法"}：精简措辞、把矛盾的改成更新的说法
- {"op":"correct","n":编号,"text":"按原文改过的写法","why":"原文怎么说"}：对照 C 发现记错了（数字、日期、名字、理解反了、主人后来改口）
- {"op":"guess","n":编号}：对照 C 发现只是它自己的推测、主人没确认过
- {"op":"alias","n":编号,"words":"别称1、别称2"}：主人以后多半会换个说法提起（记的是「妈妈」，问的是「老妈」；记的是「P2S」，问的是「打印机」），写 1~4 个，原文里有的不用写
- {"op":"to_user","n":编号,"text":"一句短话（可省）"}：其实是关于主人本人的稳定信息，挪进 A（不超过 ${USER_ITEM_MAX} 字）
- {"op":"pin","n":编号} / {"op":"unpin","n":编号}：按 U 挪进 / 挪出「${PINNED_HEAD}」（经常用上、又不是关于主人本人的才挪进去，最多 8 条；很久用不上的挪出来）
- {"op":"topic","n":编号,"name":"主题名"}：挪进主题页 topics/<主题名>.md（见第 5 条）

规则：
1. 删掉已经过时的：已经过去的一次性安排、「明天 / 下周」之类已经过期的、某天发生了什么的流水账（带时刻、日期的记录）、明显的临时状态，以及随时能查到的状态（设备 / 打印机现在怎样、主人在不在家、天气、音量）。今天是 {TODAY}。
2. 拿不准的就留着。别编造、别改变意思。
3. 老被想起却从来没用上的，看看是不是过时了，过时就删，没过时就留着。
4. A 整理后完整输出在 user 里（合并重复、删过时的；A 总共不超过 ${Math.floor(USER_AUTO_MAX * 0.8)} 字）。{USER_RULE}
5. 只有记忆很多（B 超过 ${TOPIC_SPLIT_CHARS} 字）时才用主题页：同一件事（一个人、一台设备、一个项目）有 5 条以上才挪，挪过去的条目原样搬；在 topic_index 里给每个新主题页写一句概括（MEMORY.md 里那行索引用）。

只输出一个 JSON，不要别的文字：
{"user": ["A 的每一条"], "ops": [ … ], "topic_index": {"主题名": "一句话概括"}, "summary": "一句话说做了什么"}
没什么要改的就输出空的 ops。`;

export function parseTidy(raw: string): { user: string[] | null; ops: unknown[]; topicIndex: Record<string, string>; summary: string } | null {
  const t = stripThinkText(raw).trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1));
    if (!Array.isArray(o.ops) && !Array.isArray(o.user)) return null;
    const topicIndex: Record<string, string> = {};
    if (o.topic_index && typeof o.topic_index === "object") for (const [k, v] of Object.entries(o.topic_index)) { const n = topicName(String(k)); if (n) topicIndex[n] = String(v ?? "").trim(); }
    return {
      user: Array.isArray(o.user) ? o.user.map((x: any) => stripProv(String(x)).trim().replace(/^[-*•]\s+/, "")).filter(Boolean) : null,
      ops: Array.isArray(o.ops) ? o.ops : [], topicIndex, summary: String(o.summary ?? "").trim(),
    };
  } catch { return null; }
}

/** 「常用」一节超过上限：多出来的条目挪回这一节后面（别让每轮常驻的部分越长越大） */
export function capPinned(md: string): string {
  const lines = md.split("\n");
  const at = lines.findIndex((l) => l.trim() === PINNED_HEAD);
  if (at < 0) return md;
  let end = at + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;
  const keep: string[] = [], over: string[] = [];
  let used = 0;
  for (const l of lines.slice(at + 1, end)) {
    if (!/^[-*•]\s+/.test(l.trim())) { keep.push(l); continue; }
    const n = Array.from(stripProv(l)).length;
    if (used + n <= PINNED_MAX && keep.filter((x) => /^[-*•]\s+/.test(x.trim())).length < 8) { keep.push(l); used += n; } else over.push(l);
  }
  if (!over.length) return md;
  return [...lines.slice(0, at + 1), ...keep, ...lines.slice(end), ...over].join("\n");
}

const DOC_PROMPT = `你在帮一个 AI 助手整理它的一份设定文件 {FILE}——{DESC}。
这份文件会放进它的上下文里，所以要准确、不重复、不过时。今天是 {TODAY}。

请整理：
1. 合并重复、意思相同的条目，保留更完整、更新的说法；前后矛盾的以更新的为准（看不出先后就都留着，别猜）。
2. 删掉明显过时的：已经过去的一次性安排、只针对某一天的临时说明、明显已经不适用的内容。
3. 「参考」里已经有的内容（共享那份里写过的、系统每轮自动告诉它的用法），这份文件里不用再写一遍。
4. 这是规矩和经验，删错了会改变它的行为：拿不准的一律留着。别编造、别加新规矩、别改变意思，只做合并、删除和必要的精简措辞；原有的标题结构尽量保留。

只按下面的格式输出，不要别的文字：
<file>
整理后的完整文件内容
</file>
<removed>
- 删掉或合并掉的原文（原因）
</removed>
<summary>一句话说做了什么；没什么要改的就写「不用改」</summary>
没什么要改的就把原文原样放进 <file>，<removed> 留空。`;

export function parseDoc(raw: string): { content: string; removed: { text: string; why: string }[]; summary: string } | null {
  const t = stripThinkText(raw);
  const m = t.match(/<file>\r?\n?([\s\S]*?)\r?\n?<\/file>/);
  if (!m) return null;
  const removed = (t.match(/<removed>([\s\S]*?)<\/removed>/)?.[1] ?? "").split("\n").map((l) => l.trim()).filter((l) => /^[-*•]\s+/.test(l))
    .map((l) => { const x = l.replace(/^[-*•]\s+/, ""); const w = x.match(/^(.*)（([^（）]*)）$/); return w ? { text: w[1].trim(), why: w[2].trim() } : { text: x, why: "" }; })
    .filter((r) => r.text);
  return { content: m[1].trim(), removed, summary: (t.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? "").trim() };
}

export interface TidyHost {
  /** 每几天整理一次；0 = 不自动整理（按需照样能用） */
  everyDays(): number;
  /** 什么时段可以自动整理（同待办的静默时段） */
  window(): string;
  /** 这个 agent 正忙（有一轮在跑）就先不整理 */
  busy(agentId: string): boolean;
  /** 整理完告诉主人（自动整理才发；按需的结果直接返回给调用方） */
  report(agentId: string, text: string): Promise<void>;
  /** 系统每轮自动告诉她的用法守则（soul.toolGuide）：守则文件里和它重复的可以删 */
  guide?(agent: AgentInfo): string;
  /** 按出处编号取对话原文节选（挑和这条记忆相关的几句）；取不到是空 */
  sources?(agent: AgentInfo, refs: string[], text: string): string;
  /** 自动回忆的使用统计：条目原文（去掉出处）→ 附上过几次、用上过几次 */
  usage?(agent: AgentInfo): Map<string, { recalled: number; used: number }>;
  /** 记一条记忆（提炼每日笔记用；走 memory.write，USER.md 的上限、去重都在那里） */
  write?(agent: AgentInfo, target: "long" | "user", text: string, prov: { ref?: string; how?: string }): string;
  /** 跟这段文字相关的已有长期记忆（几条原文，去重用） */
  related?(agent: AgentInfo, text: string): Promise<string[]>;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const len = (s: string) => Array.from(s.replace(/\s+/g, "")).length;
const dayOf = (now: number) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const worst = (parts: Status[]): Status => parts.includes("done") ? "done" : parts.includes("failed") ? "failed" : parts.includes("skipped") ? "skipped" : "nochange";

export class MemoryTidy {
  private state: Record<string, TidyResult> = {};
  /** 守则文件上次整理完的内容指纹（文件路径 → sha1）：没变过就不再看 */
  private docHash: Record<string, string> = {};
  /** 核对过原文的出处（agent|出处编号 → 时刻）：VERIFY_DAYS 天内不再核对 */
  private verified: Record<string, number> = {};
  /** 每日笔记提炼到哪一天了（agent → YYYY-MM-DD，含这一天） */
  private dailyUpto: Record<string, string> = {};
  private running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private reg: AgentRegistry, private models: ModelRegistry, private host: TidyHost, private stateFile: string | null = null) {
    try {
      if (stateFile) { const j = JSON.parse(fs.readFileSync(stateFile, "utf8")); this.state = j.agents ?? {}; this.docHash = j.docs ?? {}; this.verified = j.verified ?? {}; this.dailyUpto = j.daily ?? {}; }
    } catch { /* 还没有 */ }
  }

  /** 正在整理的 agent → 做到哪一步了（管理界面轮询显示进度） */
  private prog = new Map<string, { stage: string; since: number; started: number; scope: TidyScope }>();
  progress() { return Object.fromEntries([...this.prog].map(([k, v]) => [k, { ...v }])); }
  private stage(agentId: string, stage: string) {
    const p = this.prog.get(agentId);
    if (p) { p.stage = stage; p.since = Date.now(); }
  }

  last(agentId: string): TidyResult | undefined { return this.state[agentId]; }
  all() { return this.state; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 10 * 60_000);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** 到期的 agent 依次整理（一次只整理一个，别一起占模型） */
  async tick(now = Date.now()): Promise<string[]> {
    const days = this.host.everyDays();
    if (days <= 0 || !inActiveHours(this.host.window(), now)) return [];
    const done: string[] = [];
    for (const a of this.reg.list()) {
      const prev = this.state[a.id];
      // 上次没做成（模型出错之类）的第二天再试，别等一整个周期
      const gap = (prev?.status === "failed" ? 1 : days) * 86400;
      if (now / 1000 - (prev?.at ?? 0) < gap || this.host.busy(a.id) || this.running.size) continue;
      const r = await this.run(a.id, "auto", now);
      done.push(a.id);
      if (r.status === "done" || r.status === "skipped" || r.status === "failed") {
        await this.host.report(a.id, describe(r)).catch((e) => console.log(`[tidy] ⚠️  ${a.id} 整理结果没送出去: ${e.message}`));
      }
    }
    return done;
  }

  async run(agentId: string, trigger: string, now = Date.now(), scope: TidyScope = "all"): Promise<TidyResult> {
    const agent = this.reg.get(agentId);
    const base = { agent: agentId, at: now / 1000, trigger };
    if (!agent) return { ...base, status: "failed", why: `没有 agent ${agentId}` };
    if (this.running.has(agentId)) return { ...base, status: "skipped", why: "正在整理中" };
    this.running.add(agentId);
    this.prog.set(agentId, { stage: "开始", since: Date.now(), started: Date.now(), scope });
    let r: TidyResult = { ...base, status: "nochange" };
    try {
      if (scope !== "docs") {
        // 先把每日笔记里还用得上的提炼进长期记忆，再整理（新记下的跟着一起去重、核对）。提炼出错不耽误整理
        let distilled: Awaited<ReturnType<MemoryTidy["distillDaily"]>> = { long: 0, user: 0, days: [], left: 0 };
        try { distilled = await this.distillDaily(agent, now); }
        catch (e: any) { distilled = { long: 0, user: 0, days: [], left: 0, why: String(e?.message ?? e).slice(0, 200) }; }
        let m: Omit<TidyResult, "agent" | "at" | "trigger">;
        try { m = await this.tidyMemory(agent, trigger, now); }
        catch (e: any) { m = { status: "failed", why: String(e?.message ?? e).slice(0, 300) }; }
        r = { ...r, ...m, memStatus: m.status, daily: distilled };
      }
      if (scope !== "memory") r.docs = await this.tidyDocs(agent, trigger, now);
      r.status = worst([...(r.memStatus ? [r.memStatus] : []), ...(r.docs ?? []).map((d) => d.status)]);
      // 只提炼了每日笔记、整理没改：也算做了事
      if (r.status === "nochange" && r.daily && r.daily.long + r.daily.user > 0) r.status = "done";
    } finally { this.running.delete(agentId); this.prog.delete(agentId); }
    this.state[agentId] = r;
    if (this.stateFile) { try { fs.writeFileSync(this.stateFile, JSON.stringify({ agents: this.state, docs: this.docHash, verified: this.verified, daily: this.dailyUpto }, null, 1)); } catch { /* 存不下就算了 */ } }
    console.log(`[tidy] 🧹 ${agentId}（${trigger}）${describe(r).split("\n").join("｜").slice(0, 300)}`);
    health.record({ kind: "memory_tidy", ok: r.status === "done" || r.status === "nochange", agent: agentId,
      detail: { status: r.status, why: r.why, removed: (r.removed?.length ?? 0) + (r.docs ?? []).reduce((n, d) => n + (d.removed?.length ?? 0), 0), docs: (r.docs ?? []).map((d) => `${d.scope === "shared" ? "共享 " : ""}${d.file}:${d.status}`) } });
    return r;
  }

  private async ask(agent: AgentInfo, system: string, user: string, now: number, ms = 240_000): Promise<{ text: string; cut: boolean }> {
    const model = this.models.resolve(agent.model || this.models.defaultRef());
    const res = await this.models.quick(model, { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: now }] } as any,
      { maxTokens: Math.max(model.maxTokens || 0, 16_000), signal: AbortSignal.timeout(ms), think: true });
    if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage || "模型调用失败");
    return { text: res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""), cut: res.stopReason === "length" };
  }

  /**
   * 每日笔记提炼（2026-11，主人「把每日的记忆也利用起来」）：每日笔记只在当天和第二天进提示，以前过后就沉底——一件事只记在笔记里，就只剩她自己想起来去搜这一条路。
   * 整理时把上次提炼以来的笔记（今天的不算，还在写）交给模型，挑出以后还用得上的记进长期记忆 / USER.md，出处是 daily:<日期>。
   * 第一次只往回看 DAILY_BACKLOG_DAYS 天；积压多的一趟最多 DAILY_MAX_CALLS 段，剩下的下次接着。笔记本身不动、照样能搜
   */
  async distillDaily(agent: AgentInfo, now: number): Promise<{ long: number; user: number; days: string[]; left: number; why?: string }> {
    const none = { long: 0, user: 0, days: [] as string[], left: 0 };
    if (!this.host.write) return none;
    const dir = path.join(agent.workspace, "memory");
    const today = dayOf(now);
    const floor = dayOf(now - DAILY_BACKLOG_DAYS * 86400_000);
    const from = this.dailyUpto[agent.id] ?? "";
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => f.slice(0, 10)).sort(); } catch { return none; }
    const days = files.filter((d) => d < today && d > from && d >= floor);
    if (!days.length) return none;
    // 按天攒成段，一段不超过 DAILY_CHUNK_CHARS
    const chunks: { days: string[]; text: string }[] = [];
    for (const d of days) {
      const body = fs.readFileSync(path.join(dir, `${d}.md`), "utf8").split("\n").filter((l) => l.trim() && !/^#\s/.test(l)).map((l, i) => `${i + 1}. ${l.replace(/^[-*•]\s*/, "")}`).join("\n");
      if (!body) continue;
      const block = `=== ${d} ===\n${body}`;
      const last = chunks.at(-1);
      if (last && Array.from(last.text).length + Array.from(block).length <= DAILY_CHUNK_CHARS) { last.days.push(d); last.text += `\n\n${block}`; }
      else chunks.push({ days: [d], text: Array.from(block).slice(0, DAILY_CHUNK_CHARS).join("") });
    }
    const todo = chunks.slice(0, DAILY_MAX_CALLS);
    let nLong = 0, nUser = 0;
    const done: string[] = [];
    for (const [i, c] of todo.entries()) {
      this.stage(agent.id, `提炼每日笔记（${c.days[0]}${c.days.length > 1 ? ` ~ ${c.days.at(-1)}` : ""}${todo.length > 1 ? `，${i + 1}/${todo.length}` : ""}）`);
      // 相关的已有记忆：免得把已经记过的再记一遍
      let related: string[] = [];
      try { related = (await this.host.related?.(agent, c.text)) ?? []; } catch { /* 没有就算了 */ }
      const input = `${related.length ? `相关的已有记忆（已经记过的，别重复）：\n${related.map((x) => `- ${x}`).join("\n")}\n\n` : ""}每日笔记：\n${c.text}`;
      const res = await this.ask(agent, DISTILL_PROMPT.replace("{TODAY}", today), input, now, TIDY_CALL_MS);
      const t = stripThinkText(res.text);
      const a = t.indexOf("{"), b = t.lastIndexOf("}");
      let o: any = null;
      try { o = a >= 0 && b > a ? JSON.parse(t.slice(a, b + 1)) : null; } catch { o = null; }
      if (!o) throw new Error(`提炼每日笔记时模型没按格式输出（${c.days[0]} 起），这几天的下次再提炼`);
      const take = (x: any) => ({ text: stripProv(String(x?.text ?? x ?? "")).replace(/^[-*•]\s*/, "").trim().slice(0, 200), from: /^\d{4}-\d{2}-\d{2}$/.test(String(x?.from)) ? String(x.from) : c.days.at(-1)!, how: String(x?.how ?? "").slice(0, 20) });
      for (const x of (Array.isArray(o.long) ? o.long : []).map(take).filter((x: any) => x.text)) {
        if (nLong + nUser >= DISTILL_MAX_ITEMS) break;
        this.host.write(agent, "long", x.text, { ref: `daily:${x.from}`, how: x.how || "从笔记里整理的" });
        nLong++;
      }
      for (const x of (Array.isArray(o.user) ? o.user : []).map(take).filter((x: any) => x.text)) {
        if (nLong + nUser >= DISTILL_MAX_ITEMS) break;
        this.host.write(agent, "user", x.text, { ref: `daily:${x.from}` });
        nUser++;
      }
      done.push(...c.days);
      // 每段做完就记下进度：后面哪段出错，前面的不用重来
      this.dailyUpto[agent.id] = c.days.at(-1)!;
    }
    const left = chunks.slice(todo.length).reduce((n, c) => n + c.days.length, 0);
    if (nLong + nUser) console.log(`[tidy] 📓 ${agent.id} 从 ${done.length} 天的笔记里记下 ${nLong} 条长期记忆、${nUser} 条关于主人的${left ? `（还有 ${left} 天下次接着）` : ""}`);
    return { long: nLong, user: nUser, days: done, left };
  }

  private async tidyMemory(agent: AgentInfo, trigger: string, now: number): Promise<Omit<TidyResult, "agent" | "at" | "trigger">> {
    const userFile = sharedPath("USER.md") || path.join(agent.workspace, "USER.md");
    const memFile = path.join(agent.workspace, "MEMORY.md");
    const topicDir = path.join(agent.workspace, TOPICS_DIR);
    const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
    this.stage(agent.id, "读取记忆");
    const userText = read(userFile);
    const memText = read(memFile);
    const topicFiles = (() => { try { return fs.readdirSync(topicDir).filter((f) => f.endsWith(".md")).sort(); } catch { return []; } })();
    const topicText = new Map(topicFiles.map((f) => [f.slice(0, -3), read(path.join(topicDir, f))]));
    const at = userText.indexOf(USER_AUTO_HEAD);
    const hand = at >= 0 ? userText.slice(0, at) : userText;
    const autoItems = at >= 0 ? items(userText.slice(at + USER_AUTO_HEAD.length)) : [];
    const parsed = parseFiles([{ file: "MEMORY.md", text: memText || "# 长期记忆\n" }, ...[...topicText].map(([n, t]) => ({ file: `topics/${n}.md`, text: t }))]);
    const all = parsed.items;
    const plainText = (x: string) => stripAlias(stripProv(x));
    const before = chars(autoItems) + chars(all.map((x) => plainText(x.text)));
    if (!autoItems.length && !all.length) return { status: "nochange", why: "没有要整理的记忆" };
    const total = Array.from(memText).length + [...topicText.values()].reduce((n, t) => n + Array.from(t).length, 0);
    if (total > TIDY_MAX_CHARS) return { status: "skipped", why: `MEMORY.md 和主题页太长（超过 ${TIDY_MAX_CHARS} 字），先在管理界面手动删一些` };

    // C：拿出处去读原文核对。先核对常用的、再核对新的（越靠后越新），核对过的 VERIFY_DAYS 天内不再核对
    const usage = (() => { try { return this.host.usage?.(agent) ?? new Map(); } catch { return new Map(); } })();
    const use = (x: string) => usage.get(stripProv(x)) ?? { recalled: 0, used: 0 };
    const vkey = (refs: string[]) => `${agent.id}|${refs.join("、")}`;
    const toCheck = all.map((it) => ({ it, refs: provOf(it.text).refs }))
      .filter((c) => c.refs.length && now / 1000 - (this.verified[vkey(c.refs)] ?? 0) > VERIFY_DAYS * 86400)
      .sort((p, q) => use(q.it.text).recalled - use(p.it.text).recalled || q.it.n - p.it.n).slice(0, VERIFY_MAX);
    const checked: string[] = [];
    const src = new Map<number, string>();
    for (const [i, c] of toCheck.entries()) {
      this.stage(agent.id, `对照原文核对（${i + 1}/${toCheck.length}）`);
      let ex = "";
      try { ex = this.host.sources?.(agent, c.refs, plainText(c.it.text)) ?? ""; } catch { /* 取不到就不核对这条 */ }
      if (!ex.trim()) continue;
      src.set(c.it.n, ex.trim());
      checked.push(vkey(c.refs));
    }

    // 分段：条目多的一段一次调用；A（USER.md 自动记录）只在第一段整理
    const groups = batches(parsed, TIDY_BATCH_CHARS);
    const ops: unknown[] = [];
    const topicIndex: Record<string, string> = {};
    let user: string[] | null = null;
    const summaries: string[] = [];
    for (const [gi, g] of groups.entries()) {
      const part = groups.length > 1 ? `（第 ${gi + 1}/${groups.length} 段）` : "";
      const usageLines = all.filter((it) => g.has(it.n)).flatMap((it) => {
        const u = use(it.text);
        return u.used >= 2 ? [`[${it.n}] 想起 ${u.recalled} 次，用上 ${u.used} 次（经常用上）`]
          : u.recalled >= STALE_RECALLS && !u.used ? [`[${it.n}] 想起 ${u.recalled} 次，一次都没用上`] : [];
      });
      const srcLines = [...src].filter(([n]) => g.has(n)).map(([n, ex]) => `[${n}]\n${ex}`);
      const input = [
        `A. USER.md 的「自动记录」${gi ? "（只读，整理在第一段做过了；这里只用来判断哪些该 to_user、别重复）" : ""}：\n${autoItems.map((x) => `- ${x}`).join("\n") || "（空）"}`,
        `B. 长期记忆${part}：\n${parsed.files.map((f) => { const t = numbered(f, g); return t && f.items.some((it) => g.has(it.n)) ? `=== ${f.file} ===\n${t}` : ""; }).filter(Boolean).join("\n\n")}`,
        srcLines.length ? `C. 出处原文（对照核对这些条目）：\n${srcLines.join("\n\n")}` : "",
        usageLines.length ? `U. 使用情况：\n${usageLines.join("\n")}` : "",
      ].filter(Boolean).join("\n\n");
      const batchNote = groups.length > 1 ? `记忆比较多，分 ${groups.length} 段整理，这是第 ${gi + 1} 段：只对这一段里的编号输出操作。` : "";
      const prompt = PROMPT.replace("{TODAY}", dayOf(now)).replace("{BATCH}", batchNote ? `\n${batchNote}\n` : "")
        .replace("{USER_RULE}", gi ? "这一段不用输出 user（留空数组）。" : "");
      this.stage(agent.id, `等模型整理${groups.length > 1 ? `第 ${gi + 1}/${groups.length} 段` : ""}`);
      const res = await this.ask(agent, prompt, input, now, TIDY_CALL_MS);
      const out = parseTidy(res.text);
      if (!out) return { status: "failed", why: `${res.cut ? "模型输出被截断了" : "模型没按格式输出"}${part}，没写入` };
      if (!gi && out.user) user = out.user;
      ops.push(...cleanOps(out.ops, g));
      Object.assign(topicIndex, out.topicIndex);
      if (out.summary) summaries.push(out.summary);
    }

    this.stage(agent.id, "写入");
    const applied = applyOps(parsed, ops as any, topicIndex);
    // USER：第一段整理过的 A + 各段挪过来的；超长 / 超量的放回 MEMORY，别撑爆常驻的 USER.md
    const userAll = [...(user ?? autoItems)];
    for (const x of applied.toUser) if (!userAll.includes(x)) userAll.push(x);
    const userOut = userAll.filter((x) => Array.from(x).length <= USER_ITEM_MAX);
    const overflow = userAll.filter((x) => Array.from(x).length > USER_ITEM_MAX);
    while (userOut.length && chars(userOut) > USER_AUTO_MAX) overflow.push(userOut.pop()!);
    let memOut = (applied.files.get("MEMORY.md") ?? (memText || "# 长期记忆\n")).trim();
    if (overflow.length) memOut += "\n" + overflow.map((x) => `- ${x}`).join("\n");
    memOut = capPinned(memOut);
    const topicsOut = new Map(topicText);
    for (const [f, t] of applied.files) if (f.startsWith("topics/")) topicsOut.set(f.slice(7, -3), t);
    const memNew = items(memOut);
    const topicNew = [...topicsOut.values()].flatMap(items);
    const after = chars(userOut) + chars(memNew.map(plainText)) + chars(topicNew.map(plainText));
    const result = { user: { before: chars(autoItems), after: chars(userOut) }, memory: { before: all.length, after: memNew.length + topicNew.length } };
    const removed = applied.removed;
    if (before > 0 && after < before * MIN_KEEP) return { ...result, status: "skipped", removed, why: `一次删得太多（整理后只剩原来的 ${Math.round((after / before) * 100)}%），没写入，先看看是不是删错了` };
    if (before > 0 && after > before * MAX_GROW + 200) return { ...result, status: "skipped", why: `整理后反而多了很多（原来的 ${Math.round((after / before) * 100)}%），没写入` };
    const changedTopics = [...topicsOut].filter(([n, t]) => (topicText.get(n) ?? "").trim() !== t.trim());
    const same = JSON.stringify(userOut) === JSON.stringify(autoItems) && memOut === memText.trim() && !changedTopics.length;
    for (const k of checked) this.verified[k] = now / 1000;
    const summary = summaries.join("；");
    if (same) return { ...result, status: "nochange", summary: summary || "看过了，不用改", verified: checked.length };

    // 整理要好几分钟：这期间她可能又记了几条（memory_write 是直接追加的），或者主人在管理界面改过。
    // 写回之前再读一遍：原来的条目都还在、只是多了新的 → 把新的接到整理结果后面；原来的被删 / 改了 → 不写，下次再整理（别把别人的改动盖掉）
    const userNow = read(userFile), memNow = read(memFile);
    const autoNow = (() => { const i = userNow.indexOf(USER_AUTO_HEAD); return i >= 0 ? items(userNow.slice(i + USER_AUTO_HEAD.length)) : []; })();
    const memItemsNow = items(memNow);
    const memItems = items(memText);
    const handNow = (() => { const i = userNow.indexOf(USER_AUTO_HEAD); return i >= 0 ? userNow.slice(0, i) : userNow; })();
    const lost = (a: string[], b: string[]) => a.some((x) => !b.includes(x));
    const topicsMoved = topicFiles.some((f) => read(path.join(topicDir, f)) !== topicText.get(f.slice(0, -3)));
    if (lost(autoItems, autoNow) || lost(memItems, memItemsNow) || handNow !== hand || topicsMoved) {
      return { ...result, status: "skipped", why: "整理期间记忆被改过（管理界面或者别的 agent），没写入，下次再整理" };
    }
    const userFinal = [...userOut, ...autoNow.filter((x) => !autoItems.includes(x) && !userOut.includes(x))];
    const addedMem = memItemsNow.filter((x) => !memItems.includes(x));
    if (addedMem.length) memOut += "\n" + addedMem.map((x) => `- ${x}`).join("\n");

    const stamp = stampOf(new Date(now));
    const backups = [backup(userFile, stamp), backup(memFile, stamp), ...changedTopics.map(([n]) => backup(path.join(topicDir, `${n}.md`), stamp))].filter(Boolean);
    fs.writeFileSync(userFile, hand.replace(/\n*$/, hand.trim() ? "\n\n" : "") + USER_AUTO_HEAD + "\n" + userFinal.map((x) => `- ${x}`).join("\n") + (userFinal.length ? "\n" : ""));
    fs.writeFileSync(memFile, memOut + "\n");
    if (changedTopics.length) fs.mkdirSync(topicDir, { recursive: true });
    for (const [n, t] of changedTopics) fs.writeFileSync(path.join(topicDir, `${n}.md`), t.trim() + "\n");
    if (removed.length) {
      const arch = path.join(agent.workspace, ARCHIVE_FILE);
      const head = fs.existsSync(arch) ? "" : "# 整理时移出长期记忆的条目（不会注入、不会自动想起；需要时可以翻）\n";
      fs.appendFileSync(arch, `${head}\n## ${new Date(now).toLocaleString("zh-CN", { hour12: false })}（${trigger}）\n${removed.map((r) => `- ${r.text}${r.why ? `（${r.why}）` : ""}`).join("\n")}\n`);
    }
    return { ...result, status: "done", removed, corrected: applied.corrected, verified: checked.length,
      pinned: Array.from(pinnedOf(memOut)).length, topics: changedTopics.map(([n]) => n), summary, backups };
  }

  /**
   * 守则文件：AGENTS / TOOLS 有共享那份时，共享的和这个 agent 自己的补充各整理各的（补充拿共享那份当参考，重复的去掉）；HEARTBEAT 每个 agent 一份。
   * 自动整理时，上次整理后没变过的不看（共享那份在同一晚也只会被第一个 agent 整理一次）；手动 / 她自己叫的都看
   */
  private async tidyDocs(agent: AgentInfo, trigger: string, now: number): Promise<DocResult[]> {
    const out: DocResult[] = [];
    const guide = (() => { try { return this.host.guide?.(agent) ?? ""; } catch { return ""; } })();
    for (const file of DOC_FILES) {
      const shared = sharedPath(file);
      const targets: { p: string; scope: "shared" | "own"; ref: string }[] = [];
      if (shared) targets.push({ p: shared, scope: "shared", ref: "" });
      targets.push({ p: path.join(agent.workspace, file), scope: "own", ref: shared });
      for (const t of targets) {
        this.stage(agent.id, `整理守则 ${t.scope === "shared" ? "共享的 " : ""}${file}`);
        let text = "";
        try { text = fs.readFileSync(t.p, "utf8"); } catch { continue; }
        // 自己那份里和共享重复的行本来就不会给她看两遍，只算真正多出来的
        const sharedText = t.ref ? (() => { try { return fs.readFileSync(t.ref, "utf8"); } catch { return ""; } })() : "";
        const body = t.ref ? ownExtra(sharedText, text) : text;
        if (len(body) < DOC_MIN_CHARS) continue;
        if (trigger === "auto" && this.docHash[t.p] === sha(text)) continue;
        const base = { file, scope: t.scope, before: len(text) };
        let r: DocResult;
        try { r = { ...base, ...(await this.tidyDoc(agent, file, t, text, sharedText, guide, trigger, now, len(body))) }; }
        catch (e: any) { r = { ...base, status: "failed", why: String(e?.message ?? e).slice(0, 200) }; }
        out.push(r);
      }
    }
    return out;
  }

  private async tidyDoc(agent: AgentInfo, file: string, t: { p: string; scope: "shared" | "own" }, text: string, sharedText: string, guide: string, trigger: string, now: number, baseLen: number): Promise<Omit<DocResult, "file" | "scope" | "before">> {
    if (Array.from(text).length > DOC_MAX_CHARS) return { status: "skipped", why: `太长（超过 ${DOC_MAX_CHARS} 字），一次整理不了，先在管理界面手动删一些` };
    const refs = [sharedText.trim() ? `共享那份 ${file}（所有 agent 都有，这里是只对这个 agent 的补充）：\n${sharedText.trim()}` : "", guide ? `系统每轮自动告诉它的用法：\n${guide}` : ""].filter(Boolean);
    const res = await this.ask(agent, DOC_PROMPT.replace("{FILE}", file).replace("{DESC}", DOC_DESC[file] ?? "").replace("{TODAY}", dayOf(now)),
      `${refs.length ? `参考（只读，别改、别抄进来）：\n${refs.join("\n\n")}\n\n` : ""}要整理的 ${file}：\n${text.trim()}`, now);
    if (res.cut) return { status: "failed", why: "模型输出被截断了，没写入" };
    const o = parseDoc(res.text);
    if (!o) return { status: "failed", why: "模型没按格式输出，没写入" };
    const after = len(o.content);
    if (o.content === text.trim()) { this.docHash[t.p] = sha(text); return { status: "nochange", after }; }
    // 按真正多出来的那部分算（自己那份里和共享重复的行删掉不算删得多）
    if (after < baseLen * DOC_MIN_KEEP) return { status: "skipped", after, removed: o.removed, why: `一次删得太多（整理后只剩原来的 ${Math.round((after / Math.max(1, baseLen)) * 100)}%），没写入，先看看是不是删错了` };
    const bk = backup(t.p, stampOf(new Date(now)));
    fs.writeFileSync(t.p, o.content + "\n");
    this.docHash[t.p] = sha(o.content + "\n");
    if (o.removed.length) {
      const arch = path.join(path.dirname(t.p), DOC_ARCHIVE);
      const head = fs.existsSync(arch) ? "" : "# 整理时从守则文件里移出的条目（不会注入；需要时可以翻）\n";
      fs.appendFileSync(arch, `${head}\n## ${new Date(now).toLocaleString("zh-CN", { hour12: false })} ${file}（${trigger}）\n${o.removed.map((r) => `- ${r.text}${r.why ? `（${r.why}）` : ""}`).join("\n")}\n`);
    }
    return { status: "done", after, removed: o.removed, summary: o.summary, backup: bk };
  }
}

const listRemoved = (rm: { text: string; why: string }[], n: number) => [
  ...rm.slice(0, n).map((x) => `- ${x.text.slice(0, 50)}${x.why ? `（${x.why}）` : ""}`),
  ...(rm.length > n ? [`- ……还有 ${rm.length - n} 条`] : []),
];

/** 给主人看的一段话 */
export function describe(r: TidyResult): string {
  if (!r.memStatus && !r.docs) return r.status === "failed" ? `记忆整理没做成：${r.why}` : r.status === "skipped" ? `记忆整理先没动：${r.why}` : "没有要整理的";
  const lines: string[] = [];
  if (r.memStatus === "failed") lines.push(`记忆整理没做成：${r.why}`);
  else if (r.memStatus === "skipped") lines.push(`记忆整理先没动：${r.why}`);
  else if (r.memStatus === "nochange") lines.push(`整理了一遍记忆，没什么要改的${r.summary && r.summary !== "看过了，不用改" ? `（${r.summary}）` : ""}`);
  else if (r.memStatus === "done") {
    lines.push(`整理了一遍记忆：${r.summary || ""}`.trim(), `MEMORY.md ${r.memory?.before} → ${r.memory?.after} 条，USER.md 自动记录 ${r.user?.before} → ${r.user?.after} 字`);
    if (r.corrected?.length) lines.push(`对照当时的对话改了 ${r.corrected.length} 条：`, ...listRemoved(r.corrected, 5));
    else if (r.verified) lines.push(`对照当时的对话核对了 ${r.verified} 条，没发现记错的`);
    if (r.topics?.length) lines.push(`整理出主题页：${r.topics.map((n) => `topics/${n}.md`).join("、")}`);
    if (r.removed?.length) lines.push(`移出了 ${r.removed.length} 条（放在 ${ARCHIVE_FILE}，没真删）：`, ...listRemoved(r.removed, 8));
  }
  if (r.daily && r.daily.long + r.daily.user) lines.push(`从 ${r.daily.days.length} 天的每日笔记里记下 ${r.daily.long} 条长期记忆${r.daily.user ? `、${r.daily.user} 条关于你的` : ""}${r.daily.left ? `（还有 ${r.daily.left} 天的笔记下次接着看）` : ""}`);
  if (r.daily?.why) lines.push(`每日笔记没提炼成：${r.daily.why}`);
  const name = (d: DocResult) => `${d.scope === "shared" ? "共享的 " : ""}${d.file}`;
  const docs = r.docs ?? [];
  for (const d of docs) {
    if (d.status === "done") {
      lines.push(`${name(d)} 整理了（${d.before} → ${d.after} 字）${d.summary ? `：${d.summary}` : ""}`);
      if (d.removed?.length) lines.push(`移出了 ${d.removed.length} 条（放在 ${DOC_ARCHIVE}，没真删）：`, ...listRemoved(d.removed, 5));
    } else if (d.status === "failed") lines.push(`${name(d)} 没整理成：${d.why}`);
    else if (d.status === "skipped") lines.push(`${name(d)} 先没动：${d.why}`);
  }
  const quiet = docs.filter((d) => d.status === "nochange").map(name);
  if (quiet.length) lines.push(`${quiet.join("、")} 看过了，不用改`);
  if (r.docs && !docs.length && !r.memStatus) lines.push("守则文件（AGENTS / TOOLS / HEARTBEAT）内容不多或者上次整理后没变过，没什么要整理的");
  return lines.join("\n");
}
