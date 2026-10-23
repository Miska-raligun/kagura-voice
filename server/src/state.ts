// 共享服务端状态：会话 / 限流 / 拍照结果 / 快捷指令上下文（对应 ServerState）。
import { now } from "./util/time.ts";

export interface PhotoResult { status: "pending" | "done" | "error"; image_path?: string; error?: string; _ts: number }

export class ServerState {
  sessions = new Map<string, string>();     // 会话 key → session_id（Map 保持插入顺序，满了淘汰最早的）
  rateBuckets = new Map<string, [number, number]>();
  photoResults = new Map<string, PhotoResult>();
  lastQuick = new Map<string, [string, string]>();

  constructor(public maxSessions = 100, public rateWindow = 60, public rateMax = 20) {}

  setLastQuick(sid: string, q: string, a: string) { this.lastQuick.set(sid, [q, a]); }
  popLastQuick(sid: string) { const v = this.lastQuick.get(sid); this.lastQuick.delete(sid); return v; }

  getSession(key: string): string {
    let s = this.sessions.get(key);
    if (!s) {
      if (this.sessions.size >= this.maxSessions) this.sessions.delete(this.sessions.keys().next().value!);
      s = crypto.randomUUID();
      this.sessions.set(key, s);
      console.log(`[新设备] ${key} → session ${s.slice(0, 8)}...`);
    }
    return s;
  }

  /** 每设备 + bucket 维度的固定窗口限流（与 Python 版同一算法） */
  checkRate(dev: string, bucket = "chat", limit?: number): boolean {
    const max = limit ?? this.rateMax;
    const key = `${bucket}:${dev}`;
    const t = now();
    const w = this.rateBuckets.get(key);
    if (!w || t - w[0] > this.rateWindow) { this.rateBuckets.set(key, [t, 1]); return true; }
    if (w[1] >= max) return false;
    this.rateBuckets.set(key, [w[0], w[1] + 1]);
    return true;
  }
}
