// 调度器（§6.5）：定时任务 + heartbeat 共用一个，定义与运行记录存 system.sqlite，重启后按定义恢复。
//
//   schedule  at（一次性）/ every（间隔）/ cron（5 段 + 时区）
//   kind      agentTurn（发提示词让 agent 干活）/ systemEvent（往 main 会话注入一条事件，可以不回）/ heartbeat
//   session   main（共享主会话上下文）/ isolated（每次全新上下文：早报这类不需要聊天历史的任务）
//   delivery  device:<id>（合成语音推到设备）/ webchat / none
//   activeHours 时段外跳过；idleOnly 设备正在对话时延后；失败指数退避重试
//
// 设备提醒（reminders.ts，走短路链不经 LLM）与每日定时拍照保持原样，不并进来（§4.2）。
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseCron, nextCron, inActiveHours } from "./cron.ts";
import type { Runtime, RunResult } from "./runtime.ts";
import type { AgentRegistry } from "./registry.ts";

export type Schedule =
  | { kind: "at"; at: number }               // 秒
  | { kind: "every"; every_secs: number; anchor?: number }
  | { kind: "cron"; expr: string; tz?: string };

export interface Job {
  id: string; agent: string; name: string; enabled: boolean;
  schedule: Schedule;
  kind: "agentTurn" | "systemEvent" | "heartbeat";
  session: "main" | "isolated";
  message: string;
  delivery: string;
  active_hours: string;
  idle_only: boolean;
  max_retries: number;
  /** 可选：这个任务用的模型（heartbeat 默认便宜模型） */
  model: string;
  source: string;
  /** 在不可信会话里创建的（见 RunScope.trusted） */
  untrusted?: boolean;
  created: number; updated: number;
  next_run: number | null; last_run: number | null; last_status: string;
  fail_count: number; retry_at: number | null;
}

export interface RunRecord {
  id: number; job: string; agent: string; started: number; finished: number | null;
  status: string; output: string; error: string; tokens_in: number; tokens_out: number; cost: number; delivered: string;
}

export interface SchedulerHost {
  /** 投递回复。返回实际投递到哪（空串 = 没投递） */
  deliver(agentId: string, delivery: string, text: string): Promise<string>;
  /** 设备或会话正忙（idleOnly 用） */
  busy(agentId: string, delivery: string): boolean;
}

/** 回复里只有这些就算「没事、不打扰」 */
export const SILENT_RE = /^\s*(HEARTBEAT_OK|NO_REPLY)\s*[。.!！]?\s*$/i;
/** 错过多久以内还补跑（服务端晚启动）。超过就跳到下一次，不在白天补一串错过的任务 */
export const MISS_WINDOW = 15 * 60;
const BUSY_DELAY = 60;

export const HEARTBEAT_PROMPT = "[heartbeat] 现在是例行检查时间。按 HEARTBEAT.md 的清单看看有没有需要主动告诉主人的事。"
  + "有就直接说那句话（会被投递给主人）；没有就只回 HEARTBEAT_OK，不要寒暄。";

const nowS = () => Date.now() / 1000;

export function computeNext(s: Schedule, after: number): number | null {
  if (s.kind === "at") return s.at > after ? s.at : null;
  if (s.kind === "every") {
    const iv = Math.max(60, s.every_secs);
    const anchor = s.anchor ?? after;
    const k = Math.floor((after - anchor) / iv) + 1;
    return anchor + Math.max(1, k) * iv;
  }
  const n = nextCron(parseCron(s.expr, s.tz), after * 1000);
  return n === null ? null : n / 1000;
}

export function validateSchedule(s: any): Schedule {
  if (!s || typeof s !== "object") throw new Error("schedule 缺失");
  if (s.kind === "at") {
    const at = Number(s.at);
    if (!Number.isFinite(at) || at <= 0) throw new Error("at 需要时间戳（秒）");
    return { kind: "at", at };
  }
  if (s.kind === "every") {
    const v = Number(s.every_secs);
    if (!Number.isFinite(v) || v < 60) throw new Error("every 间隔至少 60 秒");
    return { kind: "every", every_secs: Math.round(v), ...(s.anchor ? { anchor: Number(s.anchor) } : {}) };
  }
  if (s.kind === "cron") {
    parseCron(String(s.expr ?? ""), s.tz);
    return { kind: "cron", expr: String(s.expr).trim(), ...(s.tz ? { tz: String(s.tz) } : {}) };
  }
  throw new Error("schedule.kind 只能是 at / every / cron");
}

const DELIVERY_RE = /^(none|webchat|device:[A-Za-z0-9_-]{1,32}|(feishu|qq|onebot):.+)$/;

export class Scheduler {
  db: DatabaseSync;
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(file: string, private rt: Runtime, private agents: AgentRegistry, private host: SchedulerHost) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, agent TEXT NOT NULL, started REAL NOT NULL, finished REAL,
        status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost REAL DEFAULT 0, delivered TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS runs_job ON runs(job, id);
    `);
  }

  // ── 存取 ──

  list(agent?: string): Job[] {
    const all = (this.db.prepare("SELECT data FROM jobs").all() as any[]).map((r) => JSON.parse(r.data) as Job);
    return all.filter((j) => !agent || j.agent === agent).sort((a, b) => (a.next_run ?? Infinity) - (b.next_run ?? Infinity) || a.created - b.created);
  }
  get(id: string): Job | undefined {
    const r = this.db.prepare("SELECT data FROM jobs WHERE id = ?").get(id) as any;
    return r ? JSON.parse(r.data) : undefined;
  }
  private save(j: Job) { this.db.prepare("INSERT OR REPLACE INTO jobs(id, data) VALUES (?, ?)").run(j.id, JSON.stringify(j)); }

  add(input: Partial<Job> & { agent: string; schedule: any; message?: string }): Job {
    if (!this.agents.get(input.agent)) throw new Error(`没有 agent ${input.agent}`);
    const t = nowS();
    const j: Job = {
      id: input.id || crypto.randomUUID().slice(0, 8),
      agent: input.agent, name: String(input.name || "未命名任务").slice(0, 80),
      enabled: input.enabled ?? true,
      schedule: validateSchedule(input.schedule),
      kind: input.kind ?? "agentTurn",
      session: input.session ?? (input.kind === "heartbeat" || input.kind === "systemEvent" ? "main" : "isolated"),
      message: String(input.message ?? ""),
      delivery: input.delivery ?? "none",
      active_hours: input.active_hours ?? "",
      idle_only: input.idle_only ?? false,
      max_retries: input.max_retries ?? 2,
      model: input.model ?? "",
      source: input.source ?? "user",
      ...(input.untrusted ? { untrusted: true } : {}),
      created: t, updated: t, next_run: null, last_run: null, last_status: "", fail_count: 0, retry_at: null,
    };
    this.check(j);
    if (this.get(j.id)) throw new Error(`任务 ${j.id} 已存在`);
    // 间隔任务锚定在创建时刻：每次都按固定的格点触发，不会因为运行耗时越漂越晚
    if (j.schedule.kind === "every" && !j.schedule.anchor) j.schedule.anchor = t;
    j.next_run = j.enabled ? computeNext(j.schedule, t) : null;
    this.save(j);
    return j;
  }

  private check(j: Job) {
    if (!["agentTurn", "systemEvent", "heartbeat"].includes(j.kind)) throw new Error("kind 只能是 agentTurn / systemEvent / heartbeat");
    if (!["main", "isolated"].includes(j.session)) throw new Error("session 只能是 main / isolated");
    if (!DELIVERY_RE.test(j.delivery)) throw new Error("delivery 只能是 none / webchat / device:<设备id> / feishu|qq|onebot:<账号>:<聊天id>");
    if (j.kind !== "heartbeat" && !j.message.trim()) throw new Error("message 不能为空");
    if (j.active_hours && !/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(j.active_hours)) throw new Error("active_hours 格式：08:00-23:00");
  }

  update(id: string, patch: Partial<Job>): Job | null {
    const j = this.get(id);
    if (!j) return null;
    const next: Job = { ...j };
    // untrusted 只能被设上、不能被 agent 摘掉（管理界面编辑会显式传 false）
    for (const k of ["name", "enabled", "kind", "session", "message", "delivery", "active_hours", "idle_only", "max_retries", "model", "untrusted"] as const) {
      if (k in patch && (patch as any)[k] !== undefined) (next as any)[k] = (patch as any)[k];
    }
    if (patch.schedule) {
      next.schedule = validateSchedule(patch.schedule);
      if (next.schedule.kind === "every" && !next.schedule.anchor) next.schedule.anchor = nowS();
    }
    this.check(next);
    next.updated = nowS();
    if (patch.schedule || "enabled" in patch) {
      next.next_run = next.enabled ? computeNext(next.schedule, nowS()) : null;
      next.retry_at = null; next.fail_count = 0;
    }
    this.save(next);
    return next;
  }

  remove(id: string) {
    const r = this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
    return Number(r.changes) > 0;
  }

  runs(job?: string, limit = 50): RunRecord[] {
    return (job
      ? this.db.prepare("SELECT * FROM runs WHERE job = ? ORDER BY id DESC LIMIT ?").all(job, limit)
      : this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit)) as any[];
  }

  // ── heartbeat：按 agent.json 的 heartbeat 配置维护一条 hb-<agent> 任务 ──

  syncHeartbeats() {
    for (const a of this.agents.list()) {
      const id = `hb-${a.id}`;
      const hb = a.heartbeat;
      const every = Math.max(5, Number(hb.every_minutes) || 30) * 60;
      const cur = this.get(id);
      const fields = { enabled: !!hb.enabled, delivery: hb.delivery || "none", active_hours: hb.active_hours || "" };
      if (!cur) {
        try { this.add({ id, agent: a.id, name: `${a.name} 的 heartbeat`, kind: "heartbeat", session: "main", schedule: { kind: "every", every_secs: every }, idle_only: true, max_retries: 0, source: "heartbeat", ...fields }); }
        catch (e: any) { console.log(`[scheduler] ⚠️  ${a.id} heartbeat 配置无效: ${e.message}`); }
      } else if (cur.enabled !== fields.enabled || cur.delivery !== fields.delivery || cur.active_hours !== fields.active_hours
        || (cur.schedule.kind === "every" && cur.schedule.every_secs !== every)) {
        try { this.update(id, { ...fields, schedule: { kind: "every", every_secs: every } }); }
        catch (e: any) { console.log(`[scheduler] ⚠️  ${a.id} heartbeat 配置无效: ${e.message}`); }
      }
    }
    // agent 被删掉了：它的任务一并清掉
    for (const j of this.list()) if (!this.agents.get(j.agent)) this.remove(j.id);
  }

  // ── 运行 ──

  /** 启动：错过太久的不补跑，直接排到下一次 */
  start(tickSecs: number) {
    const t = nowS();
    for (const j of this.list()) {
      if (!j.enabled || j.next_run === null) continue;
      if (j.next_run < t - MISS_WINDOW) {
        j.next_run = j.schedule.kind === "at" ? null : computeNext(j.schedule, t);
        if (j.schedule.kind === "at") { j.enabled = false; j.last_status = "missed"; }
        this.save(j);
        console.log(`[scheduler] ${j.name}：服务端没运行期间错过了，${j.next_run ? "排到下一次" : "不再补跑"}`);
      }
    }
    this.timer = setInterval(() => { this.tick().catch((e) => console.log(`[scheduler] ⚠️  ${e.message}`)); }, tickSecs * 1000);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** 跑所有到期的任务（不等它们跑完）。返回启动了哪些 */
  async tick(t = nowS()): Promise<string[]> {
    const started: string[] = [];
    for (const j of this.list()) {
      if (!j.enabled || this.running.has(j.id)) continue;
      const due = j.retry_at !== null ? j.retry_at <= t : j.next_run !== null && j.next_run <= t;
      if (!due) continue;
      started.push(j.id);
      void this.execute(j.id, "schedule", t);
    }
    return started;
  }

  /** 立即运行（管理 UI / cron_run 工具），不影响下一次的排期 */
  async runNow(id: string): Promise<RunRecord> {
    const j = this.get(id);
    if (!j) throw new Error("没有这个任务");
    if (this.running.has(id)) throw new Error("这个任务正在运行");
    return this.execute(id, "manual", nowS());
  }

  /** 等所有正在运行的任务结束（测试用） */
  async idle() { while (this.running.size) await new Promise((r) => setTimeout(r, 10)); }

  private async execute(id: string, trigger: "schedule" | "manual", t: number): Promise<RunRecord> {
    const j = this.get(id)!;
    this.running.add(id);
    const finish = (status: string, patch: Partial<RunRecord>) => {
      const res = this.db.prepare(`INSERT INTO runs(job, agent, started, finished, status, output, error, tokens_in, tokens_out, cost, delivered)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(j.id, j.agent, t, nowS(), status, patch.output ?? "", patch.error ?? "",
        patch.tokens_in ?? 0, patch.tokens_out ?? 0, patch.cost ?? 0, patch.delivered ?? "");
      return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(Number(res.lastInsertRowid)) as unknown as RunRecord;
    };
    try {
      const agent = this.agents.get(j.agent);
      if (!agent) throw new Error(`agent ${j.agent} 不存在`);
      if (trigger === "schedule") {
        if (!inActiveHours(j.active_hours, t * 1000)) {
          this.reschedule(j, t, "skipped");
          return finish("skipped", { error: `不在活跃时段 ${j.active_hours}` });
        }
        if (j.idle_only && this.host.busy(j.agent, j.delivery)) {
          const cur = this.get(id)!;
          cur.retry_at = t + BUSY_DELAY;     // 正在对话：一分钟后再看，不算失败
          this.save(cur);
          return finish("deferred", { error: "设备正在对话，稍后再试" });
        }
      }
      const r = await this.runAgent(j);
      const silent = SILENT_RE.test(r.text) || !r.text;
      let delivered = "";
      if (!silent && j.delivery !== "none") delivered = await this.host.deliver(j.agent, j.delivery, r.text);
      if (trigger === "schedule") this.reschedule(j, t, silent ? "silent" : "ok");
      else this.mark(j.id, { last_run: t, last_status: silent ? "silent" : "ok" });
      return finish(silent ? "silent" : "ok", { output: r.text, tokens_in: r.usage.input, tokens_out: r.usage.output, cost: r.usage.cost, delivered });
    } catch (e: any) {
      const msg = String(e.message || e);
      console.log(`[scheduler] ⚠️  ${j.name} 失败: ${msg}`);
      if (trigger === "schedule") {
        const cur = this.get(id);
        if (cur) {
          cur.fail_count++;
          cur.last_run = t; cur.last_status = "error";
          if (cur.fail_count <= cur.max_retries) cur.retry_at = t + Math.min(3600, 30 * 2 ** (cur.fail_count - 1));
          else { cur.retry_at = null; cur.next_run = computeNext(cur.schedule, t); if (cur.schedule.kind === "at") cur.enabled = false; }
          this.save(cur);
        }
      }
      return finish("error", { error: msg });
    } finally {
      this.running.delete(id);
    }
  }

  private mark(id: string, patch: Partial<Job>) {
    const cur = this.get(id);
    if (cur) this.save({ ...cur, ...patch });
  }

  private reschedule(j: Job, t: number, status: string) {
    const cur = this.get(j.id);
    if (!cur) return;
    cur.last_run = t; cur.last_status = status; cur.retry_at = null;
    if (status !== "skipped") cur.fail_count = 0;
    cur.next_run = computeNext(cur.schedule, t);
    if (cur.schedule.kind === "at") { cur.enabled = false; cur.next_run = null; }
    this.save(cur);
  }

  private async runAgent(j: Job): Promise<RunResult> {
    const agent = this.agents.get(j.agent)!;
    const voice = j.delivery.startsWith("device:");
    const dev = voice ? j.delivery.slice("device:".length) : undefined;
    const main = `${agent.id}:main`;
    const base = {
      agentId: agent.id, channel: "system", deviceId: dev, spokenTo: dev, voiceDelivery: voice,
      purpose: j.kind === "heartbeat" ? "heartbeat" : "cron",
      // 不可信的会话（IM 陌生人）里让 agent 建的任务，跑起来也不可信——不能借定时任务绕过执行命令的限制
      trusted: !j.untrusted,
    };
    if (j.kind === "heartbeat") {
      const list = this.agents.readFile(agent.id, "HEARTBEAT.md").trim();
      return this.rt.run({
        ...base, sessionKey: `${agent.id}:main`, kind: "main",
        text: j.message || HEARTBEAT_PROMPT, extraSystem: list ? [`<HEARTBEAT.md>\n${list}\n</HEARTBEAT.md>`] : [],
        model: j.model || agent.cheap_model || this.rt.models.cheapRef(),
        keepIf: (text) => !SILENT_RE.test(text) && !!text,
      });
    }
    if (j.session === "main") {
      const text = j.kind === "systemEvent" ? `[系统事件] ${j.message}\n（不需要回复就只回 NO_REPLY）` : `[定时任务「${j.name}」] ${j.message}`;
      return this.rt.run({ ...base, sessionKey: main, kind: "main", text, model: j.model || undefined, keepIf: (t) => !SILENT_RE.test(t) });
    }
    // isolated：每次全新上下文（上一次的记录留在库里可查）
    const key = `${agent.id}:cron:${j.id}`;
    this.rt.store(agent.id).reset(key);
    return this.rt.run({ ...base, sessionKey: key, kind: "isolated", text: j.message, model: j.model || undefined });
  }
}
