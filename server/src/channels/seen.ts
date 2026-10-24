// IM 消息去重：同一条消息（按渠道账号 + 消息 id）只处理一次，重启后也记得。
//
// 为什么（LRN 2026-10-24，症状「升级完她把之前那几条又回了一遍」）：飞书事件是「至少投递一次」——
// 投给断掉的旧连接、或者没来得及确认的，过后会重投；QQ 重连也会补发。以前不认 message_id，重投一次就回一遍。
import fs from "node:fs";

const KEEP_MS = 3 * 86_400_000;
const MAX = 3000;

export class SeenMessages {
  private map = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private file: string | null) {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, number>;
      const t = Date.now();
      for (const [k, v] of Object.entries(raw)) if (t - v < KEEP_MS) this.map.set(k, v);
    } catch { /* 没有或坏了：从空开始 */ }
  }

  /** 第一次见到返回 true 并记下；见过返回 false。没有消息 id 的一律当新的 */
  first(account: string, messageId: string): boolean {
    if (!messageId) return true;
    const k = `${account}|${messageId}`;
    if (this.map.has(k)) return false;
    this.map.set(k, Date.now());
    if (this.map.size > MAX) for (const old of [...this.map.keys()].slice(0, this.map.size - MAX)) this.map.delete(old);
    this.save();
    return true;
  }

  private save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1000);
    this.timer.unref?.();
  }

  flush() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map))); } catch { /* 写不了下次再写 */ }
  }
}
