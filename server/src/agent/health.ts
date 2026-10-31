// 运行状况（LRN 2026-10-31，症状「出了问题只能翻一个大日志文件，也说不清最常出的是哪种问题」）：
// 每一轮的结果（成功 / 哪类失败 / 用时）和系统兜底动作（空回复重试、催她说话、超长重压、单轮叫停、压缩失败、朗读兜底……）
// 各记一行到 system.sqlite 的 health_events，管理界面总览按天汇总、列出最近的异常。只记不改行为；没打开（单测）时什么都不做。
import { DatabaseSync } from "node:sqlite";

export type HealthKind =
  | "turn"            // 一轮结束：ok = 成功；否则 detail.error 是失败类别
  | "empty_retry"     // 空回复，压一压重试
  | "nudge"           // 想完了没说话，催一句（detail.ok = 催完说话了没）
  | "overflow"        // 服务商报上下文超长，狠压一次重试
  | "guard"           // 单轮上限叫停
  | "compact"         // 压缩（detail.failed = 没总结成的段数）
  | "compact_failed"
  | "voice"           // 顺带朗读：detail.via = first（她写了朗读版）/ short（直接念）/ summary（事后压成口语）/ cut（失败截断）
  | "push_failed"     // 推送语音合成失败
  | "sub_cancelled"   // 子任务随发起方一起停了
  | "unclean_exit";   // 上次运行没有正常退出

export interface HealthEvent { ts: number; kind: HealthKind; ok: boolean; agent?: string; session?: string; purpose?: string; ms?: number; detail?: Record<string, unknown> }

/** 一轮失败按什么归类（首页按类计数） */
export function errorClass(msg: string): string {
  const m = msg.toLowerCase();
  if (/429|rate.?limit|too many requests|限流|请求过于频繁/.test(m)) return "限流 429";
  if (/\b5\d\d\b|overload|server error|bad gateway|service unavailable|服务繁忙/.test(m)) return "服务商出错";
  if (/fetch failed|econn|etimedout|enotfound|socket|network|网络/.test(m)) return "网络";
  if (/终止|已取消|cancel/.test(m)) return "被取消";
  if (/超时/.test(m)) return "超时";
  if (/空回复/.test(m)) return "空回复";
  if (/上下文|context|too long|超长/.test(m)) return "上下文超长";
  if (/单轮|兜圈子|停手/.test(m)) return "单轮上限";
  if (/401|403|api.?key|unauthorized|余额|quota|insufficient|欠费/.test(m)) return "Key / 额度";
  return "其它";
}

const KEEP_DAYS = 30;

class Health {
  private db: DatabaseSync | null = null;
  private n = 0;
  open(file: string) {
    try {
      this.db = new DatabaseSync(file);
      this.db.exec(`CREATE TABLE IF NOT EXISTS health_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, kind TEXT NOT NULL, ok INTEGER NOT NULL,
        agent TEXT, session TEXT, purpose TEXT, ms INTEGER, detail TEXT);
        CREATE INDEX IF NOT EXISTS health_ts ON health_events(ts);`);
    } catch (e: any) { console.log(`[health] ⚠️  打不开统计库: ${e.message}`); this.db = null; }
  }
  close() { try { this.db?.close(); } catch { /* 已关 */ } this.db = null; }

  record(e: Omit<HealthEvent, "ts"> & { ts?: number }) {
    if (!this.db) return;
    try {
      this.db.prepare("INSERT INTO health_events(ts, kind, ok, agent, session, purpose, ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(e.ts ?? Date.now() / 1000, e.kind, e.ok ? 1 : 0, e.agent ?? null, e.session ?? null, e.purpose ?? null, e.ms ?? null, e.detail ? JSON.stringify(e.detail) : null);
      if (++this.n % 500 === 0) this.db.prepare("DELETE FROM health_events WHERE ts < ?").run(Date.now() / 1000 - KEEP_DAYS * 86400);
    } catch { /* 记不下不影响运行 */ }
  }

  /** 最近 days 天按天汇总：每天多少轮、成功多少、失败按类、各种兜底动作各几次、平均 / 最慢用时 */
  summary(days = 7) {
    if (!this.db) return [];
    const since = Date.now() / 1000 - days * 86400;
    const rows = this.db.prepare("SELECT ts, kind, ok, ms, detail FROM health_events WHERE ts >= ?").all(since) as any[];
    const byDay = new Map<string, any>();
    for (const r of rows) {
      const d = new Date(r.ts * 1000);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const x = byDay.get(day) ?? { day, turns: 0, ok: 0, errors: {} as Record<string, number>, events: {} as Record<string, number>, ms: [] as number[] };
      byDay.set(day, x);
      if (r.kind === "turn") {
        x.turns++;
        if (r.ok) { x.ok++; if (r.ms) x.ms.push(r.ms); }
        else { const c = (r.detail && JSON.parse(r.detail).error) || "其它"; x.errors[c] = (x.errors[c] ?? 0) + 1; }
      } else {
        const k = r.kind === "voice" ? `voice:${(r.detail && JSON.parse(r.detail).via) || "?"}` : r.ok || r.kind !== "nudge" ? r.kind : "nudge_fail";
        x.events[k] = (x.events[k] ?? 0) + 1;
      }
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).map((x) => {
      const ms = x.ms.sort((a: number, b: number) => a - b);
      return { day: x.day, turns: x.turns, ok: x.ok, errors: x.errors, events: x.events,
        avg_ms: ms.length ? Math.round(ms.reduce((s: number, v: number) => s + v, 0) / ms.length) : null,
        p90_ms: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.9))] : null };
    });
  }

  /** 最近的异常（失败的轮次 + 所有兜底动作），新的在前 */
  recent(limit = 100, kind = "") {
    if (!this.db) return [];
    const rows = this.db.prepare(`SELECT * FROM health_events WHERE (ok = 0 OR kind != 'turn') ${kind ? "AND kind = ?" : ""} AND NOT (kind IN ('voice', 'compact') AND ok = 1) ORDER BY id DESC LIMIT ?`)
      .all(...(kind ? [kind, limit] : [limit])) as any[];
    return rows.map((r) => ({ ...r, ok: !!r.ok, detail: r.detail ? JSON.parse(r.detail) : null }));
  }
}

export const health = new Health();
