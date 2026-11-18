// 记忆整理（LRN 2026-11-10，症状「USER.md 的自动记录满了、MEMORY.md 里过时 / 重复 / 流水账越积越多，旧信息被当成现在的事实，她就显得糊涂」）：
// 定期（默认每 7 天、在待办的静默时段、她空闲时）或按需（管理界面「立即整理」、她的 memory_tidy 工具），
// 用这个 agent 自己的主模型读 USER.md 的「自动记录」一节和 MEMORY.md，合并重复、删掉过时和流水、该常驻的挪进 USER.md、不该常驻的挪出来。
// 同一趟也整理守则类文件 AGENTS.md / TOOLS.md / HEARTBEAT.md（她自己往里记教训、规矩，一样会重复和过时；共享那份和 agent 自己的补充各整理各的）。
// SOUL.md / IDENTITY.md 是主人写的设定，不动。守则文件上次整理后没变过、或者内容很少（不到 DOC_MIN_CHARS）就跳过，不调模型。
// 保底：USER.md 手写部分一个字不动；写之前整份备份（.persona-backup-<时间>/）；删掉的不真删，进 MEMORY.archive.md（不注入、不自动回忆，她能 read_file）；
// 一次删得太多（剩下的不到原来的 MIN_KEEP）就不写，只报告；输出不是合法 JSON、超长也不写。
// 记忆和守则文件都「按编号改」：模型只说第几条 / 第几块做什么，输出跟文件多大无关（tidy-ops.ts）；长的分段，一段一次调用。
// 断点续做（2026-11，主人「跑了一年，人设文件都非常长……中断了要能断点续做、自动接着做」）：一段没整理成就切半、关思考重试；
// 还不行就停下，进度（看过哪些、拿到哪些操作，按内容指纹）存在 memory_tidy.json 的 jobs，RESUME_GAP_MS 后自动接着做，全看完才一次写进文件。
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import path from "node:path";
import type { AgentInfo, AgentRegistry } from "./registry.ts";
import type { ModelRegistry } from "./models.ts";
import { stripThinkText } from "./models.ts";
import { USER_AUTO_HEAD, USER_AUTO_MAX, USER_ITEM_MAX, STALE_RECALLS } from "./memory.ts";
import { stripProv, stripAlias, provOf, pinnedOf, PINNED_HEAD, PINNED_MAX, TOPICS_DIR, topicName } from "./memfmt.ts";
import { parseFiles, numbered, cleanOps, applyOps, batches, parseDocUnits, numberedDoc, cleanDocOps, applyDocOps, docBatches, halves } from "./tidy-ops.ts";
import { ownExtra, sharedPath } from "./persona.ts";
import { inActiveHours } from "./cron.ts";
import { health } from "./health.ts";

/** 整理后条目总字数至少是原来的这么多，否则当成模型删过头、不写 */
export const MIN_KEEP = 0.4;
/** MEMORY.md（连同主题页）超过这么多字就不整理，报告让主人先看看。按编号改、分段整理之后，输出不再随文件变大，这道线只防真的失控 */
export const TIDY_MAX_CHARS = 200_000;
/** 条目超过这么多字就分段整理（一段一次模型调用），每次给模型看的不至于太长 */
export const TIDY_BATCH_CHARS = 12_000;
/**
 * 整理时一次模型调用多久没有任何输出就掐（推理型模型想得久，但一直在出 token；以前按总时长 4~5 分钟掐，常常「This operation was aborted」）。
 * 不比以前的总时限短：有的服务商思考时不往回发东西
 */
export const TIDY_IDLE_MS = 300_000;
/** 一次模型调用的总时长上限 */
export const TIDY_CALL_MS = 20 * 60_000;
/** 一段整理失败（超时 / 截断 / 格式不对）就切半、关思考重试，切到这么小（字）为止 */
export const MIN_SPLIT_CHARS = 1_500;
/** 没做完的整理隔多久自动接着做 */
export const RESUME_GAP_MS = 20 * 60_000;
/** 连着这么多次没做成就不再自动接着做，等主人 */
export const RESUME_MAX = 6;
/** 没做完的整理放这么多天还没做完就作废、重新来 */
export const JOB_TTL_DAYS = 14;
/** 整理后条目总字数最多是原来的这么多倍（补别称会多一点；再多就是在编，或者主题页把内容抄了两份） */
export const MAX_GROW = 1.3;
/** 一次最多拿多少条记忆去对照原文核对（每条带几段原文，太多会撑爆这次调用） */
export const VERIFY_MAX = 20;
/** 核对过的条目（按出处）多少天内不再核对 */
export const VERIFY_DAYS = 30;
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
/** 守则文件一段多少字（一段一次模型调用） */
export const DOC_BATCH_CHARS = 8_000;
/** 守则文件不超过这么多字时，分段整理也把整份带上当参考（找别的节里重复的）；更长的只给目录 */
export const DOC_CONTEXT_CHARS = 30_000;
/** 守则文件里移出的条目放这里（和文件同一个目录） */
export const DOC_ARCHIVE = "PERSONA.archive.md";
export type TidyScope = "all" | "memory" | "docs";

/** memory_tidy 工具在这一轮里最多等多久，等不到就转后台 */
export const TOOL_WAIT_MS = 90_000;

/** 她自己的工具：主人说「整理一下记忆」时当场跑一次 */
export function tidyTools(t: MemoryTidy) {
  return (scope: import("./scope.ts").RunScope, agent: AgentInfo): import("@earendil-works/pi-agent-core").AgentTool<any>[] => {
    if (!scope.trusted || scope.kind === "sub") return [];
    return [{
      name: "memory_tidy", label: "整理记忆和守则",
      description: "整理你的记忆和守则文件：memory = USER.md 的自动记录 + MEMORY.md（合并重复、删掉过时和流水账、该常驻的挪进 USER.md）；"
        + "docs = AGENTS.md / TOOLS.md / HEARTBEAT.md（合并重复的规矩、删掉过时的）；all = 都整理（默认）。删掉的进归档文件，不真删；改之前会备份。"
        + "主人让你整理、或者你发现里面重复 / 过时的很多时用；内容多的分段整理，要一阵子，等不及的会转到后台、做完把结果告诉主人。系统每周也会自动整理，中途断了会自动接着做。SOUL.md / IDENTITY.md 不归它管。",
      parameters: Type.Object({ scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("memory"), Type.Literal("docs")])) }),
      async execute(_id: string, p: any, signal?: AbortSignal) {
        // 内容多的要整理好一阵：这一轮最多等 TOOL_WAIT_MS，等不到就让它在后台接着做、做完告诉主人（别一直占着会话锁）
        const job = t.run(agent.id, "agent", Date.now(), p?.scope === "memory" || p?.scope === "docs" ? p.scope : "all");
        const later = Symbol("later");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const r = await Promise.race([job, new Promise<typeof later>((res) => { timer = setTimeout(() => res(later), TOOL_WAIT_MS); signal?.addEventListener("abort", () => res(later), { once: true }); })]);
        clearTimeout(timer);
        if (r === later) {
          void job.then((x) => t.notify(agent.id, describe(x))).catch(() => {});
          return { content: [{ type: "text", text: "内容比较多，整理转到后台接着做了（分段整理，中途断了会自动接着做），做完系统会把结果告诉主人。你先跟主人说一声就行。" }], details: { background: true } };
        }
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
  /** 没做完：看完了几块 / 一共几块（进度存着，会接着做） */
  resume?: { done: number; total: number };
  /** 这次是接着上次没做完的做完的 */
  resumed?: boolean;
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
  summary?: string;
  backups?: string[];
  /** 没做完：看完了几条 / 一共几条（进度存着，会接着做） */
  resume?: { done: number; total: number };
  /** 这次是接着上次没做完的做完的 */
  resumed?: boolean;
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
文件拆成了一块块（清单的一项、一段话、一张表、一段代码），每块前面有 [编号]；标题没有编号、不用管。

你不用重写文件，只输出要对哪几块做什么；没提到的块原样保留。能用的操作：
- {"op":"delete","n":编号,"why":"原因"}：删掉（不真删，进归档）
- {"op":"merge","n":编号,"into":另一块编号,"text":"合并后那块的新写法（可省）","why":"原因"}：和另一块重复、意思相同，并进去
- {"op":"edit","n":编号,"text":"新写法"}：精简措辞、把前后矛盾的改成更新的说法（清单项不用写开头的「- 」）

规则：
1. 合并重复、意思相同的，保留更完整、更新的说法；前后矛盾的以更新的为准（看不出先后就都留着，别猜）。
2. 删掉明显过时的：已经过去的一次性安排、只针对某一天的临时说明、明显已经不适用的内容。
3. 「参考」里已经有的内容（共享那份里写过的、系统每轮自动告诉它的用法），这份文件里不用再写一遍。
4. 这是规矩和经验，删错了会改变它的行为：拿不准的一律留着。别编造、别加新规矩、别改变意思。
5. 只对「要整理的」里出现的编号输出操作。

只输出一个 JSON，不要别的文字：
{"ops": [ … ], "summary": "一句话说做了什么；没什么要改的就写「不用改」"}`;

export function parseDocOps(raw: string): { ops: unknown[]; summary: string } | null {
  const t = stripThinkText(raw).trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1));
    if (!Array.isArray(o.ops)) return null;
    return { ops: o.ops, summary: String(o.summary ?? "").trim() };
  } catch { return null; }
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
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const len = (s: string) => Array.from(s.replace(/\s+/g, "")).length;
const dayOf = (now: number) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const worst = (parts: Status[]): Status => parts.includes("done") ? "done" : parts.includes("failed") ? "failed" : parts.includes("skipped") ? "skipped" : "nochange";

/**
 * 没做完的一趟整理（断点续做，2026-11，主人「系统跑了一年，人设文件都非常长……如果由于模型各种输入输出限制导致中断，需要断点续做和自动恢复续做」）。
 * 每整理完一段就存一次：哪些条目 / 块看过了、拿到了哪些操作。条目按内容指纹认（不按编号）——中间她又记了新的、主人改过几条，编号会变，
 * 内容指纹不变；没看过的（新记的、被改过的）下次接着看。全看完了才一次性落到文件上（删太多 / 变太多的保底照旧按整份算）
 */
interface TidyJob {
  kind: "memory" | "doc";
  agent: string;
  /** 最初是谁发起的：auto 只在静默时段接着做；手动 / 她自己叫的随时接着做 */
  trigger: string;
  file?: string;
  started: number;
  /** 上次动手的时刻（秒） */
  tried: number;
  /** 连着没做成几次 */
  fails: number;
  lastError?: string;
  /** 看过的条目 / 块（内容指纹） */
  reviewed: string[];
  /** 已经拿到的操作：n / into 换成了内容指纹 */
  ops: any[];
  /** 记忆：A（USER.md 自动记录）整理过了没有、结果 */
  userDone?: boolean;
  user?: string[] | null;
  /** 整理 A 时 A 原来是什么样（接着做时 A 变过：新加的补上、主人删掉的去掉） */
  userBase?: string[];
  topicIndex?: Record<string, string>;
  /** 记忆：这一趟拿原文核对过的出处（做完才记进 verified） */
  checked?: string[];
  summaries: string[];
}
const ukey = (t: string) => sha(t.trim()).slice(0, 16);
const errText = (e: any) => String(e?.message ?? e).slice(0, 200);

export class MemoryTidy {
  private state: Record<string, TidyResult> = {};
  /** 守则文件上次整理完的内容指纹（文件路径 → sha1）：没变过就不再看 */
  private docHash: Record<string, string> = {};
  /** 核对过原文的出处（agent|出处编号 → 时刻）：VERIFY_DAYS 天内不再核对 */
  private verified: Record<string, number> = {};
  /** 没做完的整理：mem|<agent> / doc|<文件路径> → 进度 */
  private jobs: Record<string, TidyJob> = {};
  private running = new Set<string>();
  /**
   * 所有 agent 的整理排成一队、一次只做一个（2026-11，主人「共享文件是否存在多 agent 的读写并发问题」）：
   * 共享的 USER.md / AGENTS.md / TOOLS.md 每个 agent 整理时都会动，进度（jobs）也按文件共用一份——两个 agent 同时整理，
   * 会往同一份进度里各塞一遍操作、后写的被「整理期间被改过」挡掉白做。手动点的、她自己叫的、自动的都排这一个队
   */
  private queue: Promise<void> = Promise.resolve();
  /** 队尾是谁（排队的显示「等 X 整理完」） */
  private tail = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private reg: AgentRegistry, private models: ModelRegistry, private host: TidyHost, private stateFile: string | null = null) {
    try {
      if (stateFile) { const j = JSON.parse(fs.readFileSync(stateFile, "utf8")); this.state = j.agents ?? {}; this.docHash = j.docs ?? {}; this.verified = j.verified ?? {}; this.jobs = j.jobs ?? {}; }
    } catch { /* 还没有 */ }
  }

  private save() {
    if (!this.stateFile) return;
    try { fs.writeFileSync(this.stateFile, JSON.stringify({ agents: this.state, docs: this.docHash, verified: this.verified, jobs: this.jobs }, null, 1)); } catch { /* 存不下就算了 */ }
  }

  /** 正在整理的 agent → 做到哪一步了（管理界面轮询显示进度） */
  private prog = new Map<string, { stage: string; since: number; started: number; scope: TidyScope }>();
  progress() { return Object.fromEntries([...this.prog].map(([k, v]) => [k, { ...v }])); }
  private stage(agentId: string, stage: string) {
    const p = this.prog.get(agentId);
    if (p) { p.stage = stage; p.since = Date.now(); }
  }

  last(agentId: string): TidyResult | undefined { return this.state[agentId]; }
  /** 转到后台的整理做完了：按 heartbeat 的投递方式告诉主人 */
  async notify(agentId: string, text: string) { await this.host.report(agentId, text).catch((e) => console.log(`[tidy] ⚠️  ${agentId} 整理结果没送出去: ${e.message}`)); }
  all() { return this.state; }
  /** 这个 agent 没做完的整理（管理界面显示「上次没做完，会接着做」） */
  pending(agentId: string): { key: string; kind: string; file?: string; reviewed: number; fails: number; lastError?: string; tried: number }[] {
    return Object.entries(this.jobs).filter(([, j]) => j.agent === agentId)
      .map(([key, j]) => ({ key, kind: j.kind, file: j.file, reviewed: j.reviewed.length, fails: j.fails, lastError: j.lastError, tried: j.tried }));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 5 * 60_000);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /**
   * 到期的 agent 依次整理（一次只整理一个，别一起占模型）。
   * 有没做完的整理：隔 RESUME_GAP_MS 自动接着做（自动发起的只在静默时段；手动发起的随时），连着 RESUME_MAX 次没做成就停下等主人
   */
  async tick(now = Date.now()): Promise<string[]> {
    const days = this.host.everyDays();
    const inWindow = inActiveHours(this.host.window(), now);
    const done: string[] = [];
    for (const a of this.reg.list()) {
      if (this.host.busy(a.id) || this.running.size) continue;
      const jobs = Object.values(this.jobs).filter((j) => j.agent === a.id);
      if (jobs.length) {
        const ready = jobs.filter((j) => j.fails < RESUME_MAX && now - j.tried * 1000 >= RESUME_GAP_MS && (j.trigger !== "auto" || inWindow));
        if (!ready.length) continue;
        const hasMem = ready.some((j) => j.kind === "memory"), hasDoc = ready.some((j) => j.kind === "doc");
        const r = await this.run(a.id, "resume", now, hasMem && hasDoc ? "all" : hasMem ? "memory" : "docs");
        done.push(a.id);
        // 接着做完了才告诉主人；还没做完的不吵，接着试——试到上限还不行再说
        const stuck = Object.values(this.jobs).some((j) => j.agent === a.id && j.fails >= RESUME_MAX);
        if (r.status === "done" || r.status === "skipped" || (r.status === "failed" && stuck)) {
          await this.host.report(a.id, describe(r)).catch((e) => console.log(`[tidy] ⚠️  ${a.id} 整理结果没送出去: ${e.message}`));
        }
        continue;
      }
      if (days <= 0 || !inWindow) continue;
      const prev = this.state[a.id];
      // 上次没做成（又不能接着做）的第二天再试，别等一整个周期
      const gap = (prev?.status === "failed" ? 1 : days) * 86400;
      if (now / 1000 - (prev?.at ?? 0) < gap) continue;
      const r = await this.run(a.id, "auto", now);
      done.push(a.id);
      const resumable = Object.values(this.jobs).some((j) => j.agent === a.id);
      if (r.status === "done" || r.status === "skipped" || (r.status === "failed" && !resumable)) {
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
    const ahead = this.tail && this.tail !== agentId && this.running.has(this.tail) ? this.tail : "";
    this.prog.set(agentId, { stage: ahead ? `排队：等 ${ahead} 整理完` : "开始", since: Date.now(), started: Date.now(), scope });
    this.tail = agentId;
    const prev = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((res) => { release = res; });
    try { await prev; } catch { /* 前一个怎么结束的不管 */ }
    this.stage(agentId, "开始");
    // 主人手动点的：上次卡住的重新开始计数
    if (trigger !== "auto" && trigger !== "resume") for (const j of Object.values(this.jobs)) if (j.agent === agentId) j.fails = 0;
    // 放太久的没做完的整理作废（文件早变了，重新来）
    for (const [k, j] of Object.entries(this.jobs)) if (now / 1000 - j.started > JOB_TTL_DAYS * 86400) delete this.jobs[k];
    let r: TidyResult = { ...base, status: "nochange" };
    try {
      if (scope !== "docs") {
        let m: Omit<TidyResult, "agent" | "at" | "trigger">;
        try { m = await this.tidyMemory(agent, trigger, now); }
        catch (e: any) { m = { status: "failed", why: errText(e) }; }
        r = { ...r, ...m, memStatus: m.status };
      }
      if (scope !== "memory") r.docs = await this.tidyDocs(agent, trigger, now);
      r.status = worst([...(r.memStatus ? [r.memStatus] : []), ...(r.docs ?? []).map((d) => d.status)]);
    } finally { this.running.delete(agentId); this.prog.delete(agentId); if (this.tail === agentId) this.tail = ""; release(); }
    this.state[agentId] = r;
    this.save();
    console.log(`[tidy] 🧹 ${agentId}（${trigger}）${describe(r).split("\n").join("｜").slice(0, 300)}`);
    health.record({ kind: "memory_tidy", ok: r.status === "done" || r.status === "nochange", agent: agentId,
      detail: { status: r.status, why: r.why, trigger, removed: (r.removed?.length ?? 0) + (r.docs ?? []).reduce((n, d) => n + (d.removed?.length ?? 0), 0), docs: (r.docs ?? []).map((d) => `${d.scope === "shared" ? "共享 " : ""}${d.file}:${d.status}`) } });
    return r;
  }

  /**
   * 调一次模型。按「多久没有任何输出」掐（TIDY_IDLE_MS），另有总时长上限 TIDY_CALL_MS；
   * think = false 时关掉思考（重试时用：推理型模型想得久、又占输出额度，超时和截断多半是它）
   */
  private async ask(agent: AgentInfo, system: string, user: string, now: number, think = true): Promise<{ text: string; cut: boolean }> {
    const model = this.models.resolve(agent.model || this.models.defaultRef());
    const res = await this.models.quick(model, { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: now }] } as any,
      { maxTokens: Math.max(model.maxTokens || 0, 16_000), signal: AbortSignal.timeout(TIDY_CALL_MS), think, idleMs: TIDY_IDLE_MS });
    if (res.stopReason === "error" || res.stopReason === "aborted") {
      const m = res.errorMessage || "模型调用失败";
      throw new Error(/operation was aborted|aborted/i.test(m) && !/秒没有/.test(m) ? `一次调用超过 ${Math.round(TIDY_CALL_MS / 60_000)} 分钟，掐掉了` : m);
    }
    return { text: res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""), cut: res.stopReason === "length" };
  }

  /**
   * 整理一段，带重试：没整理成（超时、截断、格式不对、服务商出错）→ 切成两半、关掉思考再试（输入少一半、不想，快得多，输出也短）；
   * 切到 MIN_SPLIT_CHARS 以下还不行，关思考原样再试一次；还不行就抛错——前面做完的段都已经存进进度，下次从这里接着
   */
  private async solve<T>(agentId: string, g: Set<number>, size: (g: Set<number>) => number, think: boolean,
    call: (g: Set<number>, think: boolean) => Promise<{ ok: true; out: T } | { ok: false; why: string }>,
    done: (g: Set<number>, out: T) => void): Promise<void> {
    let r: { ok: true; out: T } | { ok: false; why: string };
    try { r = await call(g, think); } catch (e: any) { r = { ok: false, why: errText(e) }; }
    if (r.ok) { done(g, r.out); return; }
    const why = r.why;
    if (g.size > 1 && size(g) > MIN_SPLIT_CHARS) {
      console.log(`[tidy] ↘️  ${agentId} 一段（${g.size} 块、${size(g)} 字）没整理成：${why}——切成两半、关思考重试`);
      health.record({ kind: "tidy_retry", ok: true, agent: agentId, detail: { why, how: "split", size: size(g) } });
      const [a, b] = halves(g);
      await this.solve(agentId, a, size, false, call, done);
      await this.solve(agentId, b, size, false, call, done);
      return;
    }
    if (think) {
      console.log(`[tidy] 🔁 ${agentId} 一段（${size(g)} 字）没整理成：${why}——关思考再试一次`);
      let r2: { ok: true; out: T } | { ok: false; why: string };
      try { r2 = await call(g, false); } catch (e: any) { r2 = { ok: false, why: errText(e) }; }
      health.record({ kind: "tidy_retry", ok: r2.ok, agent: agentId, detail: { why, how: "nothink", size: size(g) } });
      if (r2.ok) { done(g, r2.out); return; }
      throw new Error(r2.why);
    }
    health.record({ kind: "tidy_retry", ok: false, agent: agentId, detail: { why, size: size(g) } });
    throw new Error(why);
  }

  /** 没做成时记进进度，返回给主人看的那句「做到哪了、什么时候接着做」 */
  private paused(key: string, e: any, now: number, total: number): string {
    const j = this.jobs[key];
    j.fails++; j.tried = now / 1000; j.lastError = errText(e);
    this.save();
    const when = j.fails >= RESUME_MAX ? `已经连着 ${j.fails} 次没做成，先停下；再点一次「整理」会接着做`
      : j.trigger === "auto" ? `进度存着，${Math.round(RESUME_GAP_MS / 60_000)} 分钟后（静默时段内）自动接着做`
      : `进度存着，${Math.round(RESUME_GAP_MS / 60_000)} 分钟后自动接着做（也可以马上再点一次）`;
    return `${j.lastError}（已经看完 ${j.reviewed.length}/${total} 条，${when}）`;
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
    const jkey = `mem|${agent.id}`;
    if (!autoItems.length && !all.length) { delete this.jobs[jkey]; return { status: "nochange", why: "没有要整理的记忆" }; }
    const total = Array.from(memText).length + [...topicText.values()].reduce((n, t) => n + Array.from(t).length, 0);
    if (total > TIDY_MAX_CHARS) return { status: "skipped", why: `MEMORY.md 和主题页太长（超过 ${TIDY_MAX_CHARS} 字），先在管理界面手动删一些` };

    // 进度：接着上次没做完的，或者新开一趟
    const job: TidyJob = this.jobs[jkey] ??= { kind: "memory", agent: agent.id, trigger, started: now / 1000, tried: now / 1000, fails: 0, reviewed: [], ops: [], summaries: [], topicIndex: {}, checked: [] };
    const resumed = job.reviewed.length > 0;
    job.tried = now / 1000;
    const keyOf = new Map(all.map((it) => [it.n, ukey(it.text)]));
    const nOf = new Map<string, number>();
    for (const it of all) if (!nOf.has(keyOf.get(it.n)!)) nOf.set(keyOf.get(it.n)!, it.n);
    const seen = new Set(job.reviewed);
    const pendingN = new Set(all.filter((it) => !seen.has(keyOf.get(it.n)!)).map((it) => it.n));

    // C：拿出处去读原文核对（只核对这趟还没看过的）。先核对常用的、再核对新的（越靠后越新），核对过的 VERIFY_DAYS 天内不再核对
    const usage = (() => { try { return this.host.usage?.(agent) ?? new Map(); } catch { return new Map(); } })();
    const use = (x: string) => usage.get(stripProv(x)) ?? { recalled: 0, used: 0 };
    const vkey = (refs: string[]) => `${agent.id}|${refs.join("、")}`;
    const toCheck = all.filter((it) => pendingN.has(it.n)).map((it) => ({ it, refs: provOf(it.text).refs }))
      .filter((c) => c.refs.length && now / 1000 - (this.verified[vkey(c.refs)] ?? 0) > VERIFY_DAYS * 86400)
      .sort((p, q) => use(q.it.text).recalled - use(p.it.text).recalled || q.it.n - p.it.n).slice(0, VERIFY_MAX);
    const src = new Map<number, { ex: string; key: string }>();
    for (const [i, c] of toCheck.entries()) {
      this.stage(agent.id, `对照原文核对（${i + 1}/${toCheck.length}）`);
      let ex = "";
      try { ex = this.host.sources?.(agent, c.refs, plainText(c.it.text)) ?? ""; } catch { /* 取不到就不核对这条 */ }
      if (ex.trim()) src.set(c.it.n, { ex: ex.trim(), key: vkey(c.refs) });
    }

    // 分段：条目多的一段一次调用；A（USER.md 自动记录）只在第一段整理。看过的条目不再看
    const groups = batches(parsed, TIDY_BATCH_CHARS).map((g) => new Set([...g].filter((n) => pendingN.has(n)))).filter((g) => g.size);
    const size = (g: Set<number>) => all.filter((it) => g.has(it.n)).reduce((n, it) => n + Array.from(stripProv(it.text)).length + 8, 0);
    const toKey = (o: any) => ({ ...o, n: keyOf.get(o.n), ...(o.into ? { into: keyOf.get(o.into) } : {}) });
    let piece = 0;
    const call = async (g: Set<number>, think: boolean) => {
      const usageLines = all.filter((it) => g.has(it.n)).flatMap((it) => {
        const u = use(it.text);
        return u.used >= 2 ? [`[${it.n}] 想起 ${u.recalled} 次，用上 ${u.used} 次（经常用上）`]
          : u.recalled >= STALE_RECALLS && !u.used ? [`[${it.n}] 想起 ${u.recalled} 次，一次都没用上`] : [];
      });
      const srcLines = [...src].filter(([n]) => g.has(n)).map(([n, s]) => `[${n}]\n${s.ex}`);
      const first = !job.userDone;
      const input = [
        `A. USER.md 的「自动记录」${first ? "" : "（只读，整理在第一段做过了；这里只用来判断哪些该 to_user、别重复）"}：\n${autoItems.map((x) => `- ${x}`).join("\n") || "（空）"}`,
        `B. 长期记忆：\n${parsed.files.map((f) => { const t = numbered(f, g); return t && f.items.some((it) => g.has(it.n)) ? `=== ${f.file} ===\n${t}` : ""; }).filter(Boolean).join("\n\n")}`,
        srcLines.length ? `C. 出处原文（对照核对这些条目）：\n${srcLines.join("\n\n")}` : "",
        usageLines.length ? `U. 使用情况：\n${usageLines.join("\n")}` : "",
      ].filter(Boolean).join("\n\n");
      const batchNote = g.size < all.length ? "记忆比较多，分段整理，这是其中一段：只对这一段里的编号输出操作。" : "";
      const prompt = PROMPT.replace("{TODAY}", dayOf(now)).replace("{BATCH}", batchNote ? `\n${batchNote}\n` : "")
        .replace("{USER_RULE}", first ? "" : "这一段不用输出 user（留空数组）。");
      piece++;
      this.stage(agent.id, `等模型整理${resumed ? "（接着上次）" : ""}：第 ${piece} 段，已看完 ${job.reviewed.length}/${all.length} 条${think ? "" : "（关思考重试）"}`);
      const res = await this.ask(agent, prompt, input, now, think);
      const out = parseTidy(res.text);
      return out ? { ok: true as const, out } : { ok: false as const, why: res.cut ? "模型输出被截断了" : "模型没按格式输出" };
    };
    const done = (g: Set<number>, out: NonNullable<ReturnType<typeof parseTidy>>) => {
      if (!job.userDone) { job.user = out.user; job.userBase = autoItems; job.userDone = true; }
      job.ops.push(...cleanOps(out.ops, g).map(toKey));
      Object.assign(job.topicIndex!, out.topicIndex);
      if (out.summary) job.summaries.push(out.summary);
      for (const n of g) { job.reviewed.push(keyOf.get(n)!); const s = src.get(n); if (s) job.checked!.push(s.key); }
      job.fails = 0;
      this.save();
    };
    try { for (const g of groups) await this.solve(agent.id, g, size, true, call, done); }
    catch (e) { return { status: "failed", why: this.paused(jkey, e, now, all.length), resume: { done: job.reviewed.length, total: all.length } }; }

    // 全看完了：把这一趟拿到的操作（按内容指纹）换回现在的编号，一次落到文件上
    this.stage(agent.id, "写入");
    const valid = new Set(all.map((it) => it.n));
    const ops = cleanOps(job.ops.map((o) => ({ ...o, n: nOf.get(o.n), ...(o.into ? { into: nOf.get(o.into) } : {}) })), valid);
    // A 是第一段整理的，可能是好几天前：这期间她又记了关于主人的（新加的补上）、主人删了的（去掉），别把这些弄丢 / 又加回来
    let user = job.userDone ? job.user ?? null : null;
    if (user && job.userBase) {
      const base = job.userBase;
      user = [...user.filter((x) => !(base.includes(x) && !autoItems.includes(x))), ...autoItems.filter((x) => !base.includes(x) && !user!.includes(x))];
    }
    const finish = () => { delete this.jobs[jkey]; };
    const applied = applyOps(parsed, ops as any, job.topicIndex ?? {});
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
    const checked = [...new Set(job.checked ?? [])];
    const summary = job.summaries.join("；");
    if (before > 0 && after < before * MIN_KEEP) { finish(); return { ...result, status: "skipped", removed, why: `一次删得太多（整理后只剩原来的 ${Math.round((after / before) * 100)}%），没写入，先看看是不是删错了` }; }
    if (before > 0 && after > before * MAX_GROW + 200) { finish(); return { ...result, status: "skipped", why: `整理后反而多了很多（原来的 ${Math.round((after / before) * 100)}%），没写入` }; }
    const changedTopics = [...topicsOut].filter(([n, t]) => (topicText.get(n) ?? "").trim() !== t.trim());
    const same = JSON.stringify(userOut) === JSON.stringify(autoItems) && memOut === memText.trim() && !changedTopics.length;
    if (same) { finish(); for (const k of checked) this.verified[k] = now / 1000; return { ...result, status: "nochange", summary: summary || "看过了，不用改", verified: checked.length }; }

    // 整理要好一阵：这期间她可能又记了几条（memory_write 是直接追加的），或者主人在管理界面改过。
    // 写回之前再读一遍：原来的条目都还在、只是多了新的 → 把新的接到整理结果后面；原来的被删 / 改了 → 不写。
    // 进度留着：下次只看被改过 / 新加的那几条，看过的不用再问模型
    const userNow = read(userFile), memNow = read(memFile);
    const autoNow = (() => { const i = userNow.indexOf(USER_AUTO_HEAD); return i >= 0 ? items(userNow.slice(i + USER_AUTO_HEAD.length)) : []; })();
    const memItemsNow = items(memNow);
    const memItems = items(memText);
    const handNow = (() => { const i = userNow.indexOf(USER_AUTO_HEAD); return i >= 0 ? userNow.slice(0, i) : userNow; })();
    const lost = (a: string[], b: string[]) => a.some((x) => !b.includes(x));
    const topicsMoved = topicFiles.some((f) => read(path.join(topicDir, f)) !== topicText.get(f.slice(0, -3)));
    if (lost(autoItems, autoNow) || lost(memItems, memItemsNow) || handNow !== hand || topicsMoved) {
      if (lost(autoItems, autoNow) || handNow !== hand) job.userDone = false;
      this.save();
      return { ...result, status: "skipped", why: "整理期间记忆被改过（管理界面或者别的 agent），没写入；看过的记着，下次只看改过的那几条" };
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
    finish();
    for (const k of checked) this.verified[k] = now / 1000;
    return { ...result, status: "done", removed, corrected: applied.corrected, verified: checked.length,
      pinned: Array.from(pinnedOf(memOut)).length, topics: changedTopics.map(([n]) => n), summary, backups, resumed: resumed || undefined };
  }

  /**
   * 守则文件：AGENTS / TOOLS 有共享那份时，共享的和这个 agent 自己的补充各整理各的（补充拿共享那份当参考，重复的去掉）；HEARTBEAT 每个 agent 一份。
   * 自动整理时，上次整理后没变过的不看（共享那份在同一晚也只会被第一个 agent 整理一次）；手动 / 她自己叫的都看；没做完的接着做
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
        try { text = fs.readFileSync(t.p, "utf8"); } catch { delete this.jobs[`doc|${t.p}`]; continue; }
        // 自己那份里和共享重复的行本来就不会给她看两遍，只算真正多出来的
        const sharedText = t.ref ? (() => { try { return fs.readFileSync(t.ref, "utf8"); } catch { return ""; } })() : "";
        const body = t.ref ? ownExtra(sharedText, text) : text;
        const job = this.jobs[`doc|${t.p}`];
        if (len(body) < DOC_MIN_CHARS) { if (job) delete this.jobs[`doc|${t.p}`]; continue; }
        if (!job && (trigger === "auto" || trigger === "resume") && this.docHash[t.p] === sha(text)) continue;
        // 共享那份：别的 agent 起的进度也接着用（同一个文件）
        if (job && job.agent !== agent.id && trigger === "resume") continue;
        const base = { file, scope: t.scope, before: len(text) };
        let r: DocResult;
        try { r = { ...base, ...(await this.tidyDoc(agent, file, t, text, sharedText, guide, trigger, now, len(body))) }; }
        catch (e: any) { r = { ...base, status: "failed", why: errText(e) }; }
        out.push(r);
      }
    }
    return out;
  }

  private async tidyDoc(agent: AgentInfo, file: string, t: { p: string; scope: "shared" | "own" }, text: string, sharedText: string, guide: string, trigger: string, now: number, baseLen: number): Promise<Omit<DocResult, "file" | "scope" | "before">> {
    if (Array.from(text).length > TIDY_MAX_CHARS) return { status: "skipped", why: `太长（超过 ${TIDY_MAX_CHARS} 字），先在管理界面手动删一些` };
    const jkey = `doc|${t.p}`;
    const p = parseDocUnits(text);
    const job: TidyJob = this.jobs[jkey] ??= { kind: "doc", agent: agent.id, trigger, file: t.p, started: now / 1000, tried: now / 1000, fails: 0, reviewed: [], ops: [], summaries: [] };
    job.tried = now / 1000;
    const resumed = job.reviewed.length > 0;
    const keyOf = new Map(p.units.map((u) => [u.n!, ukey(u.text)]));
    const nOf = new Map<string, number>();
    for (const u of p.units) if (!nOf.has(keyOf.get(u.n!)!)) nOf.set(keyOf.get(u.n!)!, u.n!);
    const seen = new Set(job.reviewed);
    const skip = new Set(p.units.filter((u) => seen.has(keyOf.get(u.n!)!)).map((u) => u.n!));
    const groups = docBatches(p, DOC_BATCH_CHARS, skip);
    const size = (g: Set<number>) => p.units.filter((u) => g.has(u.n!)).reduce((n, u) => n + Array.from(u.text).length + 6, 0);
    const refs = [sharedText.trim() ? `共享那份 ${file}（所有 agent 都有，这里是只对这个 agent 的补充）：\n${sharedText.trim()}` : "", guide ? `系统每轮自动告诉它的用法：\n${guide}` : ""].filter(Boolean);
    const whole = Array.from(text).length <= DOC_CONTEXT_CHARS;
    const label = `${t.scope === "shared" ? "共享的 " : ""}${file}`;
    let piece = 0;
    const call = async (g: Set<number>, think: boolean) => {
      // 文件不太长：整份带编号给它当参考（找别处重复的）；太长：只给目录
      const context = g.size === p.units.length ? "" : whole
        ? `整份文件（只读，用来找别处重复的；merge 的 into 可以是这里的任何编号）：\n${numberedDoc(p)}\n\n`
        : `整份文件的目录（只读）：\n${p.segs.filter((s) => s.kind === "raw" && /^#{1,6}\s/.test(s.text)).map((s) => s.text).join("\n")}\n\n`;
      const input = `${refs.length ? `参考（只读，别改、别抄进来）：\n${refs.join("\n\n")}\n\n` : ""}${context}要整理的${g.size === p.units.length ? "" : "这一段"}（${file}）：\n${numberedDoc(p, g)}`;
      piece++;
      this.stage(agent.id, `整理守则 ${label}${resumed ? "（接着上次）" : ""}：第 ${piece} 段，已看完 ${job.reviewed.length}/${p.units.length} 块${think ? "" : "（关思考重试）"}`);
      const res = await this.ask(agent, DOC_PROMPT.replace("{FILE}", file).replace("{DESC}", DOC_DESC[file] ?? "").replace("{TODAY}", dayOf(now)), input, now, think);
      const o = parseDocOps(res.text);
      return o ? { ok: true as const, out: o } : { ok: false as const, why: res.cut ? "模型输出被截断了" : "模型没按格式输出" };
    };
    const done = (g: Set<number>, o: NonNullable<ReturnType<typeof parseDocOps>>) => {
      job.ops.push(...cleanDocOps(o.ops, g, p.units.length).map((x: any) => ({ ...x, n: keyOf.get(x.n), ...(x.into ? { into: keyOf.get(x.into) } : {}) })));
      if (o.summary && !/^不用改/.test(o.summary)) job.summaries.push(o.summary);
      for (const n of g) job.reviewed.push(keyOf.get(n)!);
      job.fails = 0;
      this.save();
    };
    try { for (const g of groups) await this.solve(agent.id, g, size, true, call, done); }
    catch (e) { return { status: "failed", why: this.paused(jkey, e, now, p.units.length), resume: { done: job.reviewed.length, total: p.units.length } }; }

    const finish = () => { delete this.jobs[jkey]; };
    const ops = cleanDocOps(job.ops.map((o) => ({ ...o, n: nOf.get(o.n), ...(o.into ? { into: nOf.get(o.into) } : {}) })), new Set(p.units.map((u) => u.n!)), p.units.length);
    const applied = applyDocOps(p, ops);
    const after = len(applied.text);
    const summary = job.summaries.join("；");
    if (!applied.changed) { finish(); this.docHash[t.p] = sha(text); return { status: "nochange", after }; }
    // 按真正多出来的那部分算（自己那份里和共享重复的行删掉不算删得多）
    if (after < baseLen * DOC_MIN_KEEP) { finish(); return { status: "skipped", after, removed: applied.removed, why: `一次删得太多（整理后只剩原来的 ${Math.round((after / Math.max(1, baseLen)) * 100)}%），没写入，先看看是不是删错了` }; }
    if (after > len(text) * MAX_GROW + 200) { finish(); return { status: "skipped", after, why: `整理后反而多了很多（原来的 ${Math.round((after / Math.max(1, len(text))) * 100)}%），没写入` }; }
    // 整理期间文件被改过（主人在管理界面改、她自己记了条规矩）：不写，进度留着，下次只看改过的块
    let cur = "";
    try { cur = fs.readFileSync(t.p, "utf8"); } catch { /* 被删了 */ }
    if (cur !== text) { this.save(); return { status: "skipped", why: "整理期间文件被改过，没写入；看过的记着，下次只看改过的部分" }; }
    const bk = backup(t.p, stampOf(new Date(now)));
    fs.writeFileSync(t.p, applied.text);
    this.docHash[t.p] = sha(applied.text);
    if (applied.removed.length) {
      const arch = path.join(path.dirname(t.p), DOC_ARCHIVE);
      const head = fs.existsSync(arch) ? "" : "# 整理时从守则文件里移出的条目（不会注入；需要时可以翻）\n";
      fs.appendFileSync(arch, `${head}\n## ${new Date(now).toLocaleString("zh-CN", { hour12: false })} ${file}（${trigger}）\n${applied.removed.map((r) => `- ${r.text}${r.why ? `（${r.why}）` : ""}`).join("\n")}\n`);
    }
    finish();
    return { status: "done", after, removed: applied.removed, summary, backup: bk, resumed: resumed || undefined };
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
    lines.push(`整理了一遍记忆${r.resumed ? "（接着上次没做完的）" : ""}：${r.summary || ""}`.trim(), `MEMORY.md ${r.memory?.before} → ${r.memory?.after} 条，USER.md 自动记录 ${r.user?.before} → ${r.user?.after} 字`);
    if (r.corrected?.length) lines.push(`对照当时的对话改了 ${r.corrected.length} 条：`, ...listRemoved(r.corrected, 5));
    else if (r.verified) lines.push(`对照当时的对话核对了 ${r.verified} 条，没发现记错的`);
    if (r.topics?.length) lines.push(`整理出主题页：${r.topics.map((n) => `topics/${n}.md`).join("、")}`);
    if (r.removed?.length) lines.push(`移出了 ${r.removed.length} 条（放在 ${ARCHIVE_FILE}，没真删）：`, ...listRemoved(r.removed, 8));
  }
  const name = (d: DocResult) => `${d.scope === "shared" ? "共享的 " : ""}${d.file}`;
  const docs = r.docs ?? [];
  for (const d of docs) {
    if (d.status === "done") {
      lines.push(`${name(d)} 整理了${d.resumed ? "（接着上次没做完的）" : ""}（${d.before} → ${d.after} 字）${d.summary ? `：${d.summary}` : ""}`);
      if (d.removed?.length) lines.push(`移出了 ${d.removed.length} 条（放在 ${DOC_ARCHIVE}，没真删）：`, ...listRemoved(d.removed, 5));
    } else if (d.status === "failed") lines.push(`${name(d)} 没整理成：${d.why}`);
    else if (d.status === "skipped") lines.push(`${name(d)} 先没动：${d.why}`);
  }
  const quiet = docs.filter((d) => d.status === "nochange").map(name);
  if (quiet.length) lines.push(`${quiet.join("、")} 看过了，不用改`);
  if (r.docs && !docs.length && !r.memStatus) lines.push("守则文件（AGENTS / TOOLS / HEARTBEAT）内容不多或者上次整理后没变过，没什么要整理的");
  return lines.join("\n");
}
