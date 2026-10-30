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
      CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, ts REAL NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session, id);
    `);
    // owner：主人本人参与的会话（可信的那几种：设备、网页、主人私聊）。「近况」只从这些会话里摘，陌生人 / 群聊不混进来
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN owner INTEGER NOT NULL DEFAULT 0"); } catch { /* 已有 */ }
  }

  close() { try { this.db.close(); } catch { /* 已关 */ } }

  touchSession(key: string, kind: string, channel: string) {
    const t = Date.now() / 1000;
    this.db.prepare(`INSERT INTO sessions(key, kind, channel, created, updated) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET updated = excluded.updated`).run(key, kind, channel, t, t);
  }

  /** 这个会话里有主人本人参与（可信的一轮跑过） */
  markOwner(key: string) { this.db.prepare("UPDATE sessions SET owner = 1 WHERE key = ? AND owner = 0").run(key); }

  /**
   * 近况用：since 之后、主人参与的会话里（除了 exclude 这个会话）的用户 / 助手消息，新的在前。
   * 主会话、设备、网页聊天不管标没标 owner 都算（升级前的老会话没标过）；子任务会话不算。
   */
  recentOwnerMessages(since: number, exclude: string, limit = 300): { ts: number; role: string; data: string; channel: string; key: string }[] {
    return this.db.prepare(`SELECT m.ts, m.role, m.data, s.channel, s.key FROM messages m JOIN sessions s ON s.key = m.session
      WHERE m.ts > ? AND m.session != ? AND m.role IN ('user', 'assistant') AND s.key NOT LIKE '%:sub:%'
        AND (s.owner = 1 OR s.channel IN ('device', 'webchat') OR s.key LIKE '%:main')
      ORDER BY m.id DESC LIMIT ?`).all(since, exclude, limit) as any[];
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
    this.db.prepare("DELETE FROM events WHERE session = ?").run(key);
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

  /** 只留最近 n 条（更早的标记为已压缩，记录还在库里）。heartbeat 会话用：记得刚说过什么就够了 */
  // 只在一轮的开头（用户消息）切（LRN 2026-10-30，症状「heartbeat 报 400」）：以前按条数硬切，常常切在「发出工具调用」和「工具结果」之间——
  // 调用被压掉、结果留下，下一轮服务商找不到这条结果对应的调用就拒绝整个请求。最近一轮本身就超过 n 条时整轮留着
  keepLast(key: string, n: number) {
    const rows = this.db.prepare("SELECT id, role FROM messages WHERE session = ? AND compacted = 0 ORDER BY id DESC").all(key) as any[];
    if (rows.length <= n) return;
    let i = n - 1;
    while (i >= 0 && rows[i].role !== "user") i--;                 // 往新的方向找：保留区从一条用户消息开始
    if (i < 0) { i = n - 1; while (i < rows.length && rows[i].role !== "user") i++; }   // 最近一轮就超过 n 条：整轮留着
    if (i >= rows.length - 1) return;                                // 前面没有可压的了
    this.db.prepare("UPDATE messages SET compacted = 1 WHERE session = ? AND compacted = 0 AND id < ?").run(key, rows[i].id);
  }

  reset(key: string) {
    this.db.prepare("UPDATE messages SET compacted = 1 WHERE session = ?").run(key);
    this.db.prepare("UPDATE sessions SET summary = '' WHERE key = ?").run(key);
  }

  /** 会话里的系统事件（压缩等，管理界面会话页按时间穿插显示）。只留每个会话最近 200 条 */
  addEvent(session: string, kind: string, data: unknown) {
    this.db.prepare("INSERT INTO events(session, ts, kind, data) VALUES (?, ?, ?, ?)").run(session, Date.now() / 1000, kind, JSON.stringify(data));
    this.db.prepare("DELETE FROM events WHERE session = ? AND id <= (SELECT id FROM events WHERE session = ? ORDER BY id DESC LIMIT 1 OFFSET 200)").run(session, session);
  }

  events(session: string, since = 0): { id: number; ts: number; kind: string; data: any }[] {
    return (this.db.prepare("SELECT * FROM events WHERE session = ? AND ts >= ? ORDER BY id").all(session, since) as any[])
      .map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, data: JSON.parse(r.data) }));
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
