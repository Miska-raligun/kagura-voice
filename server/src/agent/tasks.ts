// 待办（延迟执行）：白天遇到改代码、整理资料这类又大又不急的活，先记成待办，夜间静默时段再一件件做，
// 做完的结果第二天早上统一汇报。订阅制的额度按时段算（比如 5 小时一窗），白天留给对话，夜里空着的额度拿来干活。
//
//   排队   agent 用 task_add 记（只在可信会话里有），管理界面也能新建；run_at 空 = 等下一个静默时段，有值 = 到点就做
//   执行   一次只做一件（不跟白天的对话抢额度），全新上下文（执行时看不到当时的聊天，所以 detail 要写清楚），
//          单件最长 max_minutes；管理界面可以立即执行、撤销、改开始时间、改内容
//   汇报   做完不马上说（半夜别出声）：不在静默时段且过了 report_at（默认早上 8 点）才按来源汇报，同一来源的合成一条
//
// 存 system.sqlite 的 tasks 表（导出时跟着「定时任务」那一项走），设置存同库的 task_settings。
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { inActiveHours } from "./cron.ts";
import type { RunRequest, RunResult } from "./runtime.ts";
import type { AgentRegistry } from "./registry.ts";

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: string; agent: string; title: string; detail: string;
  status: TaskStatus;
  /** 秒；null = 等下一个静默时段 */
  run_at: number | null;
  /** 结果汇报到哪：device:<id> / feishu:<账号>:<聊天> / webchat / ""（只在管理界面看） */
  origin: string;
  trusted: boolean;
  source: "agent" | "admin";
  created: number; updated: number; started: number | null; finished: number | null;
  result: string; error: string;
  tokens_in: number; tokens_out: number; cost: number;
  attempts: number;
  /** 结果汇报过了没有；汇报到哪 */
  reported: boolean; delivered: string;
}

export interface TaskSettings {
  /** 静默时段：没定时间的待办在这段时间里自动做 */
  window: string;
  /** 夜里做完的结果几点汇报；空 = 做完就报（不在静默时段时） */
  report_at: string;
  /** 单件最长分钟数（总时长上限，防死循环） */
  max_minutes: number;
  /** false = 静默时段不自动做，只能手动执行 / 到点执行 */
  auto: boolean;
}

export const DEFAULT_TASK_SETTINGS: TaskSettings = { window: "01:00-06:00", report_at: "08:00", max_minutes: 60, auto: true };
const HM = /^(\d{1,2}):(\d{2})$/;
const WINDOW = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

export interface TaskHost {
  run(req: RunRequest): Promise<RunResult>;
  /** 把汇报送到来源；返回实际送到哪（空 = 没送出去，只在管理界面看得到） */
  report(agentId: string, origin: string, text: string): Promise<string>;
}

const nowS = () => Date.now() / 1000;
const minutesOf = (ms: number) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };

/** 下一个静默时段开始的时刻（秒）；现在就在时段里 = 现在 */
export function nextWindowStart(window: string, t = nowS()): number {
  const m = window.match(WINDOW);
  if (!m) return t;
  if (inActiveHours(window, t * 1000)) return t;
  const d = new Date(t * 1000);
  d.setHours(+m[1], +m[2], 0, 0);
  if (d.getTime() / 1000 <= t) d.setDate(d.getDate() + 1);
  return d.getTime() / 1000;
}

export function checkSettings(s: Partial<TaskSettings>): TaskSettings {
  const out = { ...DEFAULT_TASK_SETTINGS, ...s };
  out.window = String(out.window ?? "").trim();
  if (!WINDOW.test(out.window)) throw new Error("静默时段格式：01:00-06:00");
  out.report_at = String(out.report_at ?? "").trim();
  if (out.report_at && !HM.test(out.report_at)) throw new Error("汇报时间格式：08:00（留空 = 做完就报）");
  out.max_minutes = Math.max(5, Math.min(600, Math.trunc(Number(out.max_minutes) || 60)));
  out.auto = out.auto !== false;
  return out;
}

export class TaskQueue {
  db: DatabaseSync;
  private timer: NodeJS.Timeout | null = null;
  private ctl = new Map<string, AbortController>();
  private running: Promise<void> | null = null;

  constructor(file: string, private agents: AgentRegistry, private host: TaskHost) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
    `);
    // 上次退出时还在做的：服务端重启打断了，重新排队（做过两次还没做完就算失败，别每晚都卡在同一件上）
    for (const t of this.list()) {
      if (t.status !== "running") continue;
      if (t.attempts >= 2) this.save({ ...t, status: "failed", finished: nowS(), error: "执行中被打断了两次（服务端重启），不再自动重试" });
      else this.save({ ...t, status: "queued", started: null, error: "上次执行时服务端重启了，重新排队" });
    }
  }

  // ── 设置 ──

  settings(): TaskSettings {
    const r = this.db.prepare("SELECT data FROM task_settings WHERE id = 1").get() as any;
    try { return r ? checkSettings(JSON.parse(r.data)) : { ...DEFAULT_TASK_SETTINGS }; } catch { return { ...DEFAULT_TASK_SETTINGS }; }
  }
  setSettings(patch: Partial<TaskSettings>): TaskSettings {
    const s = checkSettings({ ...this.settings(), ...patch });
    this.db.prepare("INSERT OR REPLACE INTO task_settings(id, data) VALUES (1, ?)").run(JSON.stringify(s));
    return s;
  }

  // ── 存取 ──

  list(agent?: string): Task[] {
    const all = (this.db.prepare("SELECT data FROM tasks").all() as any[]).map((r) => JSON.parse(r.data) as Task);
    const rank: Record<TaskStatus, number> = { running: 0, queued: 1, failed: 2, done: 3, cancelled: 4 };
    return all.filter((t) => !agent || t.agent === agent).sort((a, b) =>
      rank[a.status] - rank[b.status]
      || (a.status === "queued" ? (a.run_at ?? Infinity) - (b.run_at ?? Infinity) || a.created - b.created : (b.finished ?? b.updated) - (a.finished ?? a.updated)));
  }
  get(id: string): Task | undefined {
    const r = this.db.prepare("SELECT data FROM tasks WHERE id = ?").get(id) as any;
    return r ? JSON.parse(r.data) : undefined;
  }
  private save(t: Task) { this.db.prepare("INSERT OR REPLACE INTO tasks(id, data) VALUES (?, ?)").run(t.id, JSON.stringify(t)); }

  add(input: { agent: string; title: string; detail: string; run_at?: number | null; origin?: string; trusted?: boolean; source?: Task["source"] }): Task {
    if (!this.agents.get(input.agent)) throw new Error(`没有 agent ${input.agent}`);
    const title = String(input.title ?? "").trim().slice(0, 80);
    const detail = String(input.detail ?? "").trim();
    if (!title) throw new Error("标题不能为空");
    if (!detail) throw new Error("要写清楚具体做什么（detail）");
    const t = nowS();
    const task: Task = {
      id: crypto.randomUUID().slice(0, 8), agent: input.agent, title, detail: detail.slice(0, 20000),
      status: "queued", run_at: input.run_at ?? null, origin: String(input.origin ?? ""), trusted: input.trusted !== false,
      source: input.source ?? "agent",
      created: t, updated: t, started: null, finished: null, result: "", error: "",
      tokens_in: 0, tokens_out: 0, cost: 0, attempts: 0, reported: false, delivered: "",
    };
    this.save(task);
    return task;
  }

  /** 改内容 / 开始时间：只能改还没开始的 */
  update(id: string, patch: { title?: string; detail?: string; run_at?: number | null }): Task {
    const t = this.need(id);
    if (t.status !== "queued") throw new Error("只能改还在排队的待办");
    const next = { ...t, updated: nowS() };
    if (patch.title !== undefined) { next.title = String(patch.title).trim().slice(0, 80); if (!next.title) throw new Error("标题不能为空"); }
    if (patch.detail !== undefined) { next.detail = String(patch.detail).trim().slice(0, 20000); if (!next.detail) throw new Error("内容不能为空"); }
    if (patch.run_at !== undefined) next.run_at = patch.run_at === null ? null : Number(patch.run_at);
    this.save(next);
    return next;
  }

  /** 撤销：排队的直接撤；正在做的中止 */
  cancel(id: string): Task {
    const t = this.need(id);
    if (t.status === "queued") { const n = { ...t, status: "cancelled" as const, updated: nowS(), reported: true }; this.save(n); return n; }
    if (t.status === "running") { this.ctl.get(id)?.abort(); const n = { ...t, status: "cancelled" as const, updated: nowS(), finished: nowS(), reported: true }; this.save(n); return n; }
    throw new Error("这件已经结束了");
  }

  /** 失败 / 撤销的重新排队（等下一个静默时段） */
  requeue(id: string): Task {
    const t = this.need(id);
    if (t.status === "queued" || t.status === "running") throw new Error("还在排队或正在做");
    const n: Task = { ...t, status: "queued", run_at: null, started: null, finished: null, result: "", error: "", attempts: 0, reported: false, delivered: "", updated: nowS() };
    this.save(n);
    return n;
  }

  remove(id: string) {
    const t = this.need(id);
    if (t.status === "running") throw new Error("正在做，先撤销");
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  private need(id: string): Task {
    const t = this.get(id);
    if (!t) throw Object.assign(new Error("没有这个待办"), { status: 404 });
    return t;
  }

  // ── 执行 ──

  start(tickSecs = 30) {
    this.timer = setInterval(() => { this.tick().catch((e) => console.log(`[tasks] ⚠️  ${e.message}`)); }, tickSecs * 1000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; for (const c of this.ctl.values()) c.abort(); }

  /** 正在做的那件（一次只做一件） */
  busy() { return this.running !== null; }

  /** 到点的开始做（不等它做完）、该汇报的汇报。返回开始做的那件 */
  async tick(t = nowS()): Promise<string | null> {
    await this.report(t);
    if (this.running) return null;
    const s = this.settings();
    const inWindow = inActiveHours(s.window, t * 1000);
    const due = this.list().filter((x) => x.status === "queued" && (x.run_at !== null ? x.run_at <= t : s.auto && inWindow));
    if (!due.length) return null;
    // 明确定了时间的先做，然后按排队先后
    due.sort((a, b) => (a.run_at ?? Infinity) - (b.run_at ?? Infinity) || a.created - b.created);
    this.launch(due[0].id);
    return due[0].id;
  }

  /** 管理界面「立即执行」：不管时段，排在正在做的那件后面（一次只做一件） */
  runNow(id: string): Task {
    const t = this.need(id);
    if (t.status !== "queued") throw new Error("只能执行还在排队的待办");
    const n = { ...t, run_at: nowS() - 1, updated: nowS() };
    this.save(n);
    if (!this.running) this.launch(id);
    return this.get(id)!;
  }

  /** 等正在做的做完（测试用） */
  async idle() { while (this.running) await this.running; }

  private launch(id: string) {
    const p = this.execute(id).catch((e) => console.log(`[tasks] ⚠️  ${e.message}`)).finally(() => {
      if (this.running === p) this.running = null;
      // 一件做完马上看下一件，不用等下一个 tick
      setImmediate(() => { this.tick().catch(() => {}); });
    });
    this.running = p;
  }

  private async execute(id: string) {
    const t0 = this.get(id);
    if (!t0 || t0.status !== "queued") return;
    const agent = this.agents.get(t0.agent);
    if (!agent) { this.save({ ...t0, status: "failed", error: `agent ${t0.agent} 不存在`, finished: nowS(), updated: nowS() }); return; }
    const s = this.settings();
    const t: Task = { ...t0, status: "running", started: nowS(), attempts: t0.attempts + 1, error: "", updated: nowS() };
    this.save(t);
    const ac = new AbortController();
    this.ctl.set(id, ac);
    console.log(`[tasks] 🌙 开始做「${t.title}」（${t.agent}）`);
    try {
      const r = await this.host.run({
        agentId: t.agent, sessionKey: `${t.agent}:task:${t.id}`, kind: "isolated", channel: "system", purpose: "task",
        trusted: t.trusted, origin: t.origin || undefined, signal: ac.signal, maxSecs: s.max_minutes * 60,
        toolAllow: (n) => !n.startsWith("task_"),
        text: `[待办「${t.title}」] ${t.detail}\n\n`
          + "（这是主人之前交代、安排在现在执行的待办。主人多半不在旁边：能自己判断的就直接做完，别停下来等确认；"
          + "删除、付钱、对外发消息这类不可撤回的事不要做，需要主人拍板的地方写进结果里。"
          + "最后用几句话汇报做了什么、结果在哪、还有什么要主人处理——这段汇报会原样转给主人。）",
      });
      if (this.get(id)?.status === "cancelled") return;
      this.save({ ...this.get(id)!, status: "done", result: r.text.trim() || "（没有输出）", finished: nowS(), updated: nowS(),
        tokens_in: r.usage.input, tokens_out: r.usage.output, cost: r.usage.cost });
      console.log(`[tasks] ✅ 「${t.title}」做完了`);
    } catch (e: any) {
      if (this.get(id)?.status === "cancelled") return;
      const msg = String(e?.message || e);
      this.save({ ...this.get(id)!, status: "failed", error: msg, finished: nowS(), updated: nowS() });
      console.log(`[tasks] ⚠️  「${t.title}」失败: ${msg}`);
    } finally {
      this.ctl.delete(id);
    }
  }

  // ── 汇报 ──

  /** 现在能不能汇报：不在静默时段，且过了汇报时间（没设汇报时间 = 随时） */
  canReport(t = nowS()): boolean {
    const s = this.settings();
    if (inActiveHours(s.window, t * 1000)) return false;
    const m = s.report_at.match(HM);
    return !m || minutesOf(t * 1000) >= +m[1] * 60 + +m[2];
  }

  private reporting = false;
  async report(t = nowS()): Promise<number> {
    if (this.reporting || !this.canReport(t)) return 0;
    const pending = this.list().filter((x) => (x.status === "done" || x.status === "failed") && !x.reported)
      .sort((a, b) => (a.finished ?? 0) - (b.finished ?? 0) || a.created - b.created);     // 按做完的先后讲
    if (!pending.length) return 0;
    this.reporting = true;
    try {
      const groups = new Map<string, Task[]>();
      for (const x of pending) {
        const k = `${x.agent}\n${x.origin}`;
        groups.set(k, [...(groups.get(k) ?? []), x]);
      }
      for (const [k, list] of groups) {
        const [agentId, origin] = k.split("\n");
        const line = (x: Task) => x.status === "done" ? `「${x.title}」做完了：${x.result}` : `「${x.title}」没做成：${x.error}`;
        const text = list.length === 1 ? line(list[0]) : `之前记下的 ${list.length} 件待办：\n${list.map((x, i) => `${i + 1}. ${line(x)}`).join("\n")}`;
        let delivered = "";
        try { delivered = await this.host.report(agentId, origin, text); }
        catch (e: any) { console.log(`[tasks] ⚠️  汇报失败: ${e.message}`); }
        // 送没送出去都算报过了：送不出去的在管理界面看，别每分钟重试刷屏
        for (const x of list) { const cur = this.get(x.id); if (cur) this.save({ ...cur, reported: true, delivered }); }
      }
      return pending.length;
    } finally { this.reporting = false; }
  }
}
