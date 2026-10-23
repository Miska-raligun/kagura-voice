// 定时提醒调度器（对应 reminders.py）：到点通过推送播报。
// - schedule() 入队并持久化到 reminders.json，服务端重启不丢
// - 每秒检查到期项，调用注入的 send(text, device_id)
// - 发送失败（如 MQTT 暂时不可用）60 秒后重试，最多 3 次
import fs from "node:fs";
import { now, strftime } from "../util/time.ts";

export const MAX_ATTEMPTS = 3;
export const RETRY_DELAY = 60;

interface Item { ts: number; task: string; device_id: string; attempts: number }
type SendFn = (text: string, dev: string) => boolean | Promise<boolean>;

export class Reminders {
  items: Item[] = [];
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private file: string, private send: SendFn | null = null) {}

  private save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.items)); }
    catch (e: any) { console.log(`[reminder] 持久化失败: ${e.message}`); }
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.items = JSON.parse(fs.readFileSync(this.file, "utf8"));
        console.log(`[reminder] 恢复 ${this.items.length} 条未触发提醒`);
      }
    } catch (e: any) {
      console.log(`[reminder] 加载失败: ${e.message}`);
      this.items = [];
    }
  }

  schedule(ts: number, task: string, dev: string) {
    this.items.push({ ts, task, device_id: dev, attempts: 0 });
    this.items.sort((a, b) => a.ts - b.ts);
    this.save();
    console.log(`[reminder] 已安排 ${strftime("%H:%M:%S", new Date(ts * 1000))} → ${dev}: ${task || "(无内容)"}`);
  }

  pendingCount() { return this.items.length; }

  /** 触发所有到期提醒，返回成功发送条数。失败项退避重试，超限丢弃。 */
  async fireDue(t: number): Promise<number> {
    const due = this.items.filter((it) => it.ts <= t);
    if (!due.length) return 0;
    this.items = this.items.filter((it) => it.ts > t);
    let sent = 0;
    const requeue: Item[] = [];
    for (const it of due) {
      const text = it.task ? `叮咚，提醒时间到：${it.task}` : "叮咚，你设置的提醒时间到了。";
      let ok = false;
      if (this.send) {
        try { ok = await this.send(text, it.device_id); }
        catch (e: any) { console.log(`[reminder] 发送异常: ${e.message}`); }
      }
      if (ok) {
        sent++;
        console.log(`[reminder] ✅ 已播报 → ${it.device_id}: ${it.task || "(无内容)"}`);
      } else {
        it.attempts++;
        if (it.attempts < MAX_ATTEMPTS) {
          it.ts = t + RETRY_DELAY;
          requeue.push(it);
          console.log(`[reminder] ⚠️ 发送失败，${RETRY_DELAY}s 后重试 (${it.attempts}/${MAX_ATTEMPTS})`);
        } else console.log(`[reminder] ❌ 重试超限，丢弃: ${it.task}`);
      }
    }
    this.items.push(...requeue);
    this.items.sort((a, b) => a.ts - b.ts);
    this.save();
    return sent;
  }

  start(send: SendFn) {
    this.send = send;
    this.load();
    this.timer = setInterval(async () => {
      if (this.busy) return;          // 上一轮还在发（TTS 慢），别叠加
      this.busy = true;
      try { await this.fireDue(now()); }
      catch (e: any) { console.log(`[reminder] 调度异常: ${e.message}`); }
      finally { this.busy = false; }
    }, 1000);
    this.timer.unref();
  }
}
