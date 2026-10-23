// 每个 agent 一个 agent.sqlite：会话、消息、用量（记忆索引表在 memory.ts 里建，同一个库）。
// 按 agent 分库就是隔离本身：这里没有任何跨 agent 的查询（§6.1）。
import { DatabaseSync } from "node:sqlite";
import type { Message } from "@earendil-works/pi-ai";

export interface SessionRow {
  key: string; kind: string; channel: string; created: number; updated: number;
  summary: string; messages: number;
}
export interface UsageRow { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

export class AgentStore {
  db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, channel TEXT NOT NULL,
        created REAL NOT NULL, updated REAL NOT NULL, summary TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, ts REAL NOT NULL,
        role TEXT NOT NULL, data TEXT NOT NULL, compacted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session, compacted, id);
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, session TEXT NOT NULL, purpose TEXT NOT NULL,
        model TEXT NOT NULL, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL);
      CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
    `);
  }

  close() { try { this.db.close(); } catch { /* 已关 */ } }

  touchSession(key: string, kind: string, channel: string) {
    const t = Date.now() / 1000;
    this.db.prepare(`INSERT INTO sessions(key, kind, channel, created, updated) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET updated = excluded.updated`).run(key, kind, channel, t, t);
  }

  getSession(key: string): SessionRow | undefined {
    const r = this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session = s.key) AS messages
      FROM sessions s WHERE key = ?`).get(key) as any;
    return r ?? undefined;
  }

  listSessions(limit = 100): SessionRow[] {
    return this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session = s.key) AS messages
      FROM sessions s ORDER BY updated DESC LIMIT ?`).all(limit) as any[];
  }

  /** 当前上下文：未压缩的消息，按时间顺序 */
  history(key: string): { id: number; msg: Message }[] {
    return (this.db.prepare("SELECT id, data FROM messages WHERE session = ? AND compacted = 0 ORDER BY id").all(key) as any[])
      .map((r) => ({ id: r.id, msg: JSON.parse(r.data) }));
  }

  /** 完整记录（含已压缩的），给管理 UI 看 */
  transcript(key: string, limit = 200): { id: number; ts: number; role: string; compacted: number; msg: Message }[] {
    return (this.db.prepare("SELECT * FROM (SELECT * FROM messages WHERE session = ? ORDER BY id DESC LIMIT ?) ORDER BY id").all(key, limit) as any[])
      .map((r) => ({ id: r.id, ts: r.ts, role: r.role, compacted: r.compacted, msg: JSON.parse(r.data) }));
  }

  append(key: string, msgs: Message[]) {
    const ins = this.db.prepare("INSERT INTO messages(session, ts, role, data) VALUES (?, ?, ?, ?)");
    const t = Date.now() / 1000;
    this.db.exec("BEGIN");
    try {
      for (const m of msgs) ins.run(key, t, m.role, JSON.stringify(m));
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    this.db.prepare("UPDATE sessions SET updated = ? WHERE key = ?").run(t, key);
  }

  /** 压缩：id ≤ upto 的消息标记为已压缩，摘要替换 */
  compact(key: string, uptoId: number, summary: string) {
    this.db.prepare("UPDATE messages SET compacted = 1 WHERE session = ? AND id <= ?").run(key, uptoId);
    this.db.prepare("UPDATE sessions SET summary = ? WHERE key = ?").run(summary, key);
  }

  /** 重置会话：消息全部标记压缩、摘要清空（记录保留在库里可查） */
  /** 彻底删除一个会话（消息和摘要都删；用量记录保留，统计不受影响） */
  remove(key: string): boolean {
    this.db.prepare("DELETE FROM messages WHERE session = ?").run(key);
    return this.db.prepare("DELETE FROM sessions WHERE key = ?").run(key).changes > 0;
  }

  /** 会话标题：第一条用户消息的正文（去掉每轮自动附的 [时间…] 行），截 40 字 */
  title(key: string): string {
    const r = this.db.prepare("SELECT data FROM messages WHERE session = ? AND role = 'user' ORDER BY id LIMIT 1").get(key) as any;
    if (!r) return "";
    try {
      const m = JSON.parse(r.data);
      const parts = typeof m.content === "string" ? [m.content] : (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text);
      const t = parts.filter((x: string) => !/^\[时间 [^\]]*\]$/.test(x)).join(" ").replace(/\s+/g, " ").trim();
      return Array.from(t).slice(0, 40).join("");
    } catch { return ""; }
  }

  reset(key: string) {
    this.db.prepare("UPDATE messages SET compacted = 1 WHERE session = ?").run(key);
    this.db.prepare("UPDATE sessions SET summary = '' WHERE key = ?").run(key);
  }

  recordUsage(session: string, purpose: string, u: UsageRow) {
    this.db.prepare(`INSERT INTO usage(ts, session, purpose, model, input, output, cache_read, cache_write, cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Date.now() / 1000, session, purpose, u.model, u.input, u.output, u.cacheRead, u.cacheWrite, u.cost);
  }

  /** 按天汇总用量（本地时区） */
  usageByDay(days = 30) {
    const since = Date.now() / 1000 - days * 86400;
    return this.db.prepare(`SELECT date(ts, 'unixepoch', 'localtime') AS day, COUNT(*) AS calls,
        SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cost) AS cost
      FROM usage WHERE ts >= ? GROUP BY day ORDER BY day`).all(since);
  }
}
