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
import { USER_AUTO_HEAD, USER_AUTO_MAX, USER_ITEM_MAX } from "./memory.ts";
import { ownExtra, sharedPath } from "./persona.ts";
import { inActiveHours } from "./cron.ts";
import { health } from "./health.ts";

/** 整理后条目总字数至少是原来的这么多，否则当成模型删过头、不写 */
export const MIN_KEEP = 0.4;
/** MEMORY.md 超过这么多字就不整理（一次交给模型太多容易截断），报告让主人先看看 */
export const TIDY_MAX_CHARS = 30_000;
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

const PROMPT = `你在帮一个 AI 助手整理它的长期记忆。给你两部分：
A. USER.md 的「自动记录」：关于主人本人的稳定信息（称呼、家人、生日、作息、口味、习惯、喜好），每轮都会常驻在它的上下文里，所以要少而精。
B. MEMORY.md：其它长期记忆（事实、约定、项目结论、计划、偏好），按需检索。

请整理：
1. 合并重复、意思相同的条目，保留信息更全、更新的说法；前后矛盾的以更新的为准（看不出先后就都留着）。
2. 删掉已经过时的：已经过去的一次性安排、「明天 / 下周」之类已经过期的、某天发生了什么的流水账（带时刻、日期的记录）、明显的临时状态。今天是 {TODAY}。
3. 关于主人本人的稳定信息放进 A，其它放进 B；A 每条一句短话（不超过 ${USER_ITEM_MAX} 字），A 总共不超过 ${Math.floor(USER_AUTO_MAX * 0.8)} 字。
4. 拿不准的就留着。别编造、别改写意思，只做合并、删除、挪动和必要的精简措辞。
5. MEMORY.md 原有的标题层次尽量保留。

只输出一个 JSON，不要别的文字：
{"user": ["A 的每一条"], "memory_md": "整理后 MEMORY.md 的完整内容（Markdown，条目用「- 」开头）", "removed": [{"text": "删掉的原文", "why": "为什么删（过时 / 重复 / 流水）"}], "summary": "一句话说做了什么"}
没什么要改的就原样输出，removed 留空。`;

export function parseTidy(raw: string): { user: string[]; memory_md: string; removed: { text: string; why: string }[]; summary: string } | null {
  const t = stripThinkText(raw).trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1));
    if (!Array.isArray(o.user) || typeof o.memory_md !== "string") return null;
    return {
      user: o.user.map((x: any) => String(x).trim().replace(/^[-*•]\s+/, "")).filter(Boolean),
      memory_md: o.memory_md,
      removed: Array.isArray(o.removed) ? o.removed.map((r: any) => ({ text: String(r?.text ?? "").trim(), why: String(r?.why ?? "").trim() })).filter((r: any) => r.text) : [],
      summary: String(o.summary ?? "").trim(),
    };
  } catch { return null; }
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
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const len = (s: string) => Array.from(s.replace(/\s+/g, "")).length;
const dayOf = (now: number) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const worst = (parts: Status[]): Status => parts.includes("done") ? "done" : parts.includes("failed") ? "failed" : parts.includes("skipped") ? "skipped" : "nochange";

export class MemoryTidy {
  private state: Record<string, TidyResult> = {};
  /** 守则文件上次整理完的内容指纹（文件路径 → sha1）：没变过就不再看 */
  private docHash: Record<string, string> = {};
  private running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private reg: AgentRegistry, private models: ModelRegistry, private host: TidyHost, private stateFile: string | null = null) {
    try {
      if (stateFile) { const j = JSON.parse(fs.readFileSync(stateFile, "utf8")); this.state = j.agents ?? {}; this.docHash = j.docs ?? {}; }
    } catch { /* 还没有 */ }
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
    let r: TidyResult = { ...base, status: "nochange" };
    try {
      if (scope !== "docs") {
        let m: Omit<TidyResult, "agent" | "at" | "trigger">;
        try { m = await this.tidyMemory(agent, trigger, now); }
        catch (e: any) { m = { status: "failed", why: String(e?.message ?? e).slice(0, 300) }; }
        r = { ...r, ...m, memStatus: m.status };
      }
      if (scope !== "memory") r.docs = await this.tidyDocs(agent, trigger, now);
      r.status = worst([...(r.memStatus ? [r.memStatus] : []), ...(r.docs ?? []).map((d) => d.status)]);
    } finally { this.running.delete(agentId); }
    this.state[agentId] = r;
    if (this.stateFile) { try { fs.writeFileSync(this.stateFile, JSON.stringify({ agents: this.state, docs: this.docHash }, null, 1)); } catch { /* 存不下就算了 */ } }
    console.log(`[tidy] 🧹 ${agentId}（${trigger}）${describe(r).split("\n").join("｜").slice(0, 300)}`);
    health.record({ kind: "memory_tidy", ok: r.status === "done" || r.status === "nochange", agent: agentId,
      detail: { status: r.status, why: r.why, removed: (r.removed?.length ?? 0) + (r.docs ?? []).reduce((n, d) => n + (d.removed?.length ?? 0), 0), docs: (r.docs ?? []).map((d) => `${d.scope === "shared" ? "共享 " : ""}${d.file}:${d.status}`) } });
    return r;
  }

  private async ask(agent: AgentInfo, system: string, user: string, now: number): Promise<{ text: string; cut: boolean }> {
    const model = this.models.resolve(agent.model || this.models.defaultRef());
    const res = await this.models.quick(model, { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: now }] } as any,
      { maxTokens: Math.max(model.maxTokens || 0, 16_000), signal: AbortSignal.timeout(240_000), think: true });
    if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage || "模型调用失败");
    return { text: res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""), cut: res.stopReason === "length" };
  }

  private async tidyMemory(agent: AgentInfo, trigger: string, now: number): Promise<Omit<TidyResult, "agent" | "at" | "trigger">> {
    const userFile = sharedPath("USER.md") || path.join(agent.workspace, "USER.md");
    const memFile = path.join(agent.workspace, "MEMORY.md");
    const userText = fs.existsSync(userFile) ? fs.readFileSync(userFile, "utf8") : "";
    const memText = fs.existsSync(memFile) ? fs.readFileSync(memFile, "utf8") : "";
    const at = userText.indexOf(USER_AUTO_HEAD);
    const hand = at >= 0 ? userText.slice(0, at) : userText;
    const autoItems = at >= 0 ? items(userText.slice(at + USER_AUTO_HEAD.length)) : [];
    const memItems = items(memText);
    const before = chars(autoItems) + chars(memItems);
    if (!autoItems.length && !memItems.length) return { status: "nochange", why: "没有要整理的记忆" };
    if (Array.from(memText).length > TIDY_MAX_CHARS) return { status: "skipped", why: `MEMORY.md 太长（超过 ${TIDY_MAX_CHARS} 字），一次整理不了，先在管理界面手动删一些` };

    const res = await this.ask(agent, PROMPT.replace("{TODAY}", dayOf(now)),
      `A. USER.md 的「自动记录」：\n${autoItems.map((x) => `- ${x}`).join("\n") || "（空）"}\n\nB. MEMORY.md：\n${memText.trim() || "（空）"}`, now);
    if (res.cut) return { status: "failed", why: "模型输出被截断了（记忆太多），没写入" };
    const out = parseTidy(res.text);
    if (!out) return { status: "failed", why: "模型没按格式输出，没写入" };

    // USER 那边超长 / 超量的放回 MEMORY，别撑爆常驻的 USER.md
    const user = out.user.filter((x) => Array.from(x).length <= USER_ITEM_MAX);
    const overflow = out.user.filter((x) => Array.from(x).length > USER_ITEM_MAX);
    while (user.length && chars(user) > USER_AUTO_MAX) overflow.push(user.pop()!);
    let memOut = out.memory_md.trim();
    if (overflow.length) memOut += "\n" + overflow.map((x) => `- ${x}`).join("\n");
    const memNew = items(memOut);
    const after = chars(user) + chars(memNew);
    const result = { user: { before: chars(autoItems), after: chars(user) }, memory: { before: memItems.length, after: memNew.length } };
    if (before > 0 && after < before * MIN_KEEP) return { ...result, status: "skipped", removed: out.removed, why: `一次删得太多（整理后只剩原来的 ${Math.round((after / before) * 100)}%），没写入，先看看是不是删错了` };
    const same = JSON.stringify(user) === JSON.stringify(autoItems) && memOut === memText.trim();
    if (same) return { ...result, status: "nochange", summary: out.summary || "看过了，不用改" };

    const stamp = stampOf(new Date(now));
    const backups = [backup(userFile, stamp), backup(memFile, stamp)].filter(Boolean);
    fs.writeFileSync(userFile, hand.replace(/\n*$/, hand.trim() ? "\n\n" : "") + USER_AUTO_HEAD + "\n" + user.map((x) => `- ${x}`).join("\n") + (user.length ? "\n" : ""));
    fs.writeFileSync(memFile, memOut + "\n");
    if (out.removed.length) {
      const arch = path.join(agent.workspace, ARCHIVE_FILE);
      const head = fs.existsSync(arch) ? "" : "# 整理时移出长期记忆的条目（不会注入、不会自动想起；需要时可以翻）\n";
      fs.appendFileSync(arch, `${head}\n## ${new Date(now).toLocaleString("zh-CN", { hour12: false })}（${trigger}）\n${out.removed.map((r) => `- ${r.text}${r.why ? `（${r.why}）` : ""}`).join("\n")}\n`);
    }
    return { ...result, status: "done", removed: out.removed, summary: out.summary, backups };
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
    if (r.removed?.length) lines.push(`移出了 ${r.removed.length} 条（放在 ${ARCHIVE_FILE}，没真删）：`, ...listRemoved(r.removed, 8));
  }
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
