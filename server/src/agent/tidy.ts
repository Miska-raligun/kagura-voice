// 记忆整理（LRN 2026-11-10，症状「USER.md 的自动记录满了、MEMORY.md 里过时 / 重复 / 流水账越积越多，旧信息被当成现在的事实，她就显得糊涂」）：
// 定期（默认每 7 天、在待办的静默时段、她空闲时）或按需（管理界面「立即整理」、她的 memory_tidy 工具），
// 用这个 agent 自己的主模型读 USER.md 的「自动记录」一节和 MEMORY.md，合并重复、删掉过时和流水、该常驻的挪进 USER.md、不该常驻的挪出来。
// 保底：USER.md 手写部分一个字不动；写之前整份备份（.persona-backup-<时间>/）；删掉的不真删，进 MEMORY.archive.md（不注入、不自动回忆，她能 read_file）；
// 一次删得太多（剩下的不到原来的 MIN_KEEP）就不写，只报告；输出不是合法 JSON、超长也不写。
import fs from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import path from "node:path";
import type { AgentInfo, AgentRegistry } from "./registry.ts";
import type { ModelRegistry } from "./models.ts";
import { stripThinkText } from "./models.ts";
import { USER_AUTO_HEAD, USER_AUTO_MAX, USER_ITEM_MAX } from "./memory.ts";
import { sharedPath } from "./persona.ts";
import { inActiveHours } from "./cron.ts";
import { health } from "./health.ts";

/** 整理后条目总字数至少是原来的这么多，否则当成模型删过头、不写 */
export const MIN_KEEP = 0.4;
/** MEMORY.md 超过这么多字就不整理（一次交给模型太多容易截断），报告让主人先看看 */
export const TIDY_MAX_CHARS = 30_000;
export const ARCHIVE_FILE = "MEMORY.archive.md";

/** 她自己的工具：主人说「整理一下记忆」时当场跑一次 */
export function tidyTools(t: MemoryTidy) {
  return (scope: import("./scope.ts").RunScope, agent: AgentInfo): import("@earendil-works/pi-agent-core").AgentTool<any>[] => {
    if (!scope.trusted || scope.kind === "sub") return [];
    return [{
      name: "memory_tidy", label: "整理记忆",
      description: "把 USER.md 的自动记录和 MEMORY.md 整理一遍：合并重复、删掉过时和流水账、该常驻的挪进 USER.md。删掉的进 MEMORY.archive.md，不真删；改之前会备份。"
        + "主人让你整理记忆、或者你发现记忆里重复 / 过时的很多时用，要一两分钟。系统每周也会自动整理。",
      parameters: Type.Object({}),
      async execute() {
        const r = await t.run(agent.id, "agent");
        return r.status === "failed" ? { content: [{ type: "text", text: describe(r) }], details: {}, isError: true } : { content: [{ type: "text", text: describe(r) }], details: { status: r.status } };
      },
    } as any];
  };
}

export interface TidyResult {
  agent: string; at: number; trigger: string;
  /** done = 写进去了；nochange = 模型看过觉得不用改；skipped / failed 带原因 */
  status: "done" | "nochange" | "skipped" | "failed";
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

export interface TidyHost {
  /** 每几天整理一次；0 = 不自动整理（按需照样能用） */
  everyDays(): number;
  /** 什么时段可以自动整理（同待办的静默时段） */
  window(): string;
  /** 这个 agent 正忙（有一轮在跑）就先不整理 */
  busy(agentId: string): boolean;
  /** 整理完告诉主人（自动整理才发；按需的结果直接返回给调用方） */
  report(agentId: string, text: string): Promise<void>;
}

export class MemoryTidy {
  private state: Record<string, TidyResult> = {};
  private running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private reg: AgentRegistry, private models: ModelRegistry, private host: TidyHost, private stateFile: string | null = null) {
    try { if (stateFile) this.state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* 还没有 */ }
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

  async run(agentId: string, trigger: string, now = Date.now()): Promise<TidyResult> {
    const agent = this.reg.get(agentId);
    const base = { agent: agentId, at: now / 1000, trigger };
    if (!agent) return { ...base, status: "failed", why: `没有 agent ${agentId}` };
    if (this.running.has(agentId)) return { ...base, status: "skipped", why: "正在整理中" };
    this.running.add(agentId);
    let r: TidyResult;
    try { r = await this.tidy(agent, base, now); }
    catch (e: any) { r = { ...base, status: "failed", why: String(e?.message ?? e).slice(0, 300) }; }
    finally { this.running.delete(agentId); }
    this.state[agentId] = r;
    if (this.stateFile) { try { fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 1)); } catch { /* 存不下就算了 */ } }
    console.log(`[tidy] 🧹 ${agentId}（${trigger}）${describe(r).split("\n")[0]}`);
    health.record({ kind: "memory_tidy", ok: r.status === "done" || r.status === "nochange", agent: agentId, detail: { status: r.status, why: r.why, removed: r.removed?.length ?? 0 } });
    return r;
  }

  private async tidy(agent: AgentInfo, base: { agent: string; at: number; trigger: string }, now: number): Promise<TidyResult> {
    const userFile = sharedPath("USER.md") || path.join(agent.workspace, "USER.md");
    const memFile = path.join(agent.workspace, "MEMORY.md");
    const userText = fs.existsSync(userFile) ? fs.readFileSync(userFile, "utf8") : "";
    const memText = fs.existsSync(memFile) ? fs.readFileSync(memFile, "utf8") : "";
    const at = userText.indexOf(USER_AUTO_HEAD);
    const hand = at >= 0 ? userText.slice(0, at) : userText;
    const autoItems = at >= 0 ? items(userText.slice(at + USER_AUTO_HEAD.length)) : [];
    const memItems = items(memText);
    const before = chars(autoItems) + chars(memItems);
    if (!autoItems.length && !memItems.length) return { ...base, status: "nochange", why: "没有要整理的记忆" };
    if (Array.from(memText).length > TIDY_MAX_CHARS) return { ...base, status: "skipped", why: `MEMORY.md 太长（超过 ${TIDY_MAX_CHARS} 字），一次整理不了，先在管理界面手动删一些` };

    const today = new Date(now);
    const model = this.models.resolve(agent.model || this.models.defaultRef());
    const res = await this.models.quick(model, {
      systemPrompt: PROMPT.replace("{TODAY}", `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`),
      messages: [{ role: "user", content: `A. USER.md 的「自动记录」：\n${autoItems.map((x) => `- ${x}`).join("\n") || "（空）"}\n\nB. MEMORY.md：\n${memText.trim() || "（空）"}`, timestamp: now }],
    } as any, { maxTokens: Math.max(model.maxTokens || 0, 16_000), signal: AbortSignal.timeout(240_000), think: true });
    if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage || "模型调用失败");
    if (res.stopReason === "length") return { ...base, status: "failed", why: "模型输出被截断了（记忆太多），没写入" };
    const out = parseTidy(res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""));
    if (!out) return { ...base, status: "failed", why: "模型没按格式输出，没写入" };

    // USER 那边超长 / 超量的放回 MEMORY，别撑爆常驻的 USER.md
    let user = out.user.filter((x) => Array.from(x).length <= USER_ITEM_MAX);
    const overflow = out.user.filter((x) => Array.from(x).length > USER_ITEM_MAX);
    while (user.length && chars(user) > USER_AUTO_MAX) overflow.push(user.pop()!);
    let memOut = out.memory_md.trim();
    if (overflow.length) memOut += "\n" + overflow.map((x) => `- ${x}`).join("\n");
    const memNew = items(memOut);
    const after = chars(user) + chars(memNew);
    const result = { user: { before: chars(autoItems), after: chars(user) }, memory: { before: memItems.length, after: memNew.length } };
    if (before > 0 && after < before * MIN_KEEP) return { ...base, ...result, status: "skipped", removed: out.removed, why: `一次删得太多（整理后只剩原来的 ${Math.round((after / before) * 100)}%），没写入，先看看是不是删错了` };
    const same = JSON.stringify(user) === JSON.stringify(autoItems) && memOut === memText.trim();
    if (same) return { ...base, ...result, status: "nochange", summary: out.summary || "看过了，不用改" };

    const stamp = stampOf(new Date(now));
    const backups = [backup(userFile, stamp), backup(memFile, stamp)].filter(Boolean);
    fs.writeFileSync(userFile, hand.replace(/\n*$/, hand.trim() ? "\n\n" : "") + USER_AUTO_HEAD + "\n" + user.map((x) => `- ${x}`).join("\n") + (user.length ? "\n" : ""));
    fs.writeFileSync(memFile, memOut + "\n");
    if (out.removed.length) {
      const arch = path.join(agent.workspace, ARCHIVE_FILE);
      const head = fs.existsSync(arch) ? "" : "# 整理时移出长期记忆的条目（不会注入、不会自动想起；需要时可以翻）\n";
      fs.appendFileSync(arch, `${head}\n## ${new Date(now).toLocaleString("zh-CN", { hour12: false })}（${base.trigger}）\n${out.removed.map((r) => `- ${r.text}${r.why ? `（${r.why}）` : ""}`).join("\n")}\n`);
    }
    return { ...base, ...result, status: "done", removed: out.removed, summary: out.summary, backups };
  }
}

/** 给主人看的一段话 */
export function describe(r: TidyResult): string {
  if (r.status === "failed") return `记忆整理没做成：${r.why}`;
  if (r.status === "skipped") return `记忆整理先没动：${r.why}`;
  if (r.status === "nochange") return `整理了一遍记忆，没什么要改的${r.summary && r.summary !== "看过了，不用改" ? `（${r.summary}）` : ""}`;
  const lines = [`整理了一遍记忆：${r.summary || ""}`.trim(),
    `MEMORY.md ${r.memory?.before} → ${r.memory?.after} 条，USER.md 自动记录 ${r.user?.before} → ${r.user?.after} 字`];
  if (r.removed?.length) {
    lines.push(`移出了 ${r.removed.length} 条（放在 ${ARCHIVE_FILE}，没真删）：`);
    lines.push(...r.removed.slice(0, 8).map((x) => `- ${x.text.slice(0, 50)}${x.why ? `（${x.why}）` : ""}`));
    if (r.removed.length > 8) lines.push(`- ……还有 ${r.removed.length - 8} 条`);
  }
  return lines.join("\n");
}
