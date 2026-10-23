// 每日定时拍照调度器（对应 photo_schedules.py）：到点让设备拍一张 → 识别 → 播报。
// 用 last_fired 记日期做当天去重；MISS_WINDOW 避免服务端晚启动时把当天错过的计划补拍一遍。
// 实际执行由注入的 run(schedule) 完成，本模块只管调度与持久化。
import fs from "node:fs";
import { now as nowSec, strftime } from "../util/time.ts";
import { hex } from "../util/text.ts";

export const CHECK_INTERVAL = 20;
export const MISS_WINDOW = 900;
export const MAX_SCHEDULES = 20;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export interface Schedule {
  id: string; time: string; device_id: string; prompt: string; enabled: boolean;
  last_fired: string | null; last_result: Record<string, any> | null;
}
type RunFn = (s: Schedule) => Promise<Record<string, any>>;

export function normalizeTime(raw: unknown): string | null {
  const m = TIME_RE.exec(String(raw ?? "").trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/** now 所在这一天的 hhmm 对应的时间戳（本地时区） */
export function todayTarget(hhmm: string, t: number): number {
  const d = new Date(t * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), +hhmm.slice(0, 2), +hhmm.slice(3, 5), 0).getTime() / 1000;
}
const dayStr = (t: number) => strftime("%Y-%m-%d", new Date(t * 1000));

export class PhotoSchedules {
  items: Schedule[] = [];
  max = MAX_SCHEDULES;
  private timer: NodeJS.Timeout | null = null;
  constructor(private file: string, private run: RunFn | null = null) {}

  private sort() { this.items.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)); }
  private save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2)); }
    catch (e: any) { console.log(`[snapshot] 持久化失败: ${e.message}`); }
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(raw)) throw new Error("photo_schedules.json 顶层应为列表");
      // 同 Python 的 setdefault：缺的字段补默认值，其余原样保留
      this.items = raw.filter((it) => it && typeof it === "object" && normalizeTime(it.time)).map((it) => ({
        last_fired: null, last_result: null, ...it,
        id: it.id ?? hex(8), time: normalizeTime(it.time)!, device_id: it.device_id ?? "cores3",
        prompt: it.prompt ?? "", enabled: it.enabled ?? true,
      }));
      this.sort();
      console.log(`[snapshot] 恢复 ${this.items.length} 条定时拍照计划`);
    } catch (e: any) {
      console.log(`[snapshot] 加载失败: ${e.message}`);
      this.items = [];
    }
  }

  add(hhmm: unknown, device_id = "cores3", prompt = "", enabled = true, t = nowSec()): Schedule {
    const norm = normalizeTime(hhmm);
    if (!norm) throw new Error(`时间格式应为 HH:MM（00:00–23:59），收到 ${JSON.stringify(hhmm)}`);
    if (this.items.length >= this.max) throw new Error(`定时计划最多 ${this.max} 条`);
    const item: Schedule = {
      id: hex(8), time: norm, device_id: device_id || "cores3", prompt: (prompt || "").trim(),
      enabled: !!enabled,
      // 今天的点已经过了就直接记为已触发，避免"刚建好就立刻拍一张"
      last_fired: t >= todayTarget(norm, t) ? dayStr(t) : null,
      last_result: null,
    };
    this.items.push(item);
    this.sort();
    this.save();
    console.log(`[snapshot] 已添加每日 ${norm} 拍照计划 → ${item.device_id}`);
    return { ...item };
  }

  remove(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.save();
    console.log(`[snapshot] 已删除计划 ${id}`);
    return true;
  }

  update(id: string, f: Record<string, any>): Schedule | null {
    const it = this.items.find((x) => x.id === id);
    if (!it) return null;
    if ("time" in f) {
      const norm = normalizeTime(f.time);
      if (!norm) throw new Error(`时间格式应为 HH:MM，收到 ${JSON.stringify(f.time)}`);
      if (norm !== it.time) { it.time = norm; it.last_fired = null; }   // 改了时间，当天可以按新时间再触发
    }
    if ("device_id" in f && f.device_id) it.device_id = String(f.device_id);
    if ("prompt" in f) it.prompt = String(f.prompt || "").trim();
    if ("enabled" in f) it.enabled = !!f.enabled;
    this.sort();
    this.save();
    return { ...it };
  }

  get(id: string) { const it = this.items.find((x) => x.id === id); return it ? { ...it } : null; }
  list() { return this.items.map((x) => ({ ...x })); }

  private setLastResult(id: string, r: Record<string, any>) {
    const it = this.items.find((x) => x.id === id);
    if (it) { it.last_result = r; this.save(); }
  }

  private async fireOne(item: Schedule) {
    console.log(`[snapshot] ⏰ 触发定时拍照 ${item.time} → ${item.device_id}`);
    let result: Record<string, any> = { ok: false, error: "run_fn 未注入" };
    if (this.run) {
      try { result = (await this.run(item)) || {}; }
      catch (e: any) { result = { ok: false, error: String(e.message || e) }; console.log(`[snapshot] ⚠️ 执行异常: ${e.message}`); }
    }
    result.ts ??= nowSec();
    this.setLastResult(item.id, result);
    return result;
  }

  /** 网页「立即试跑」：执行但不动 last_fired */
  async runNow(id: string) {
    const it = this.get(id);
    return it ? this.fireOne(it) : null;
  }

  async fireDue(t = nowSec()): Promise<number> {
    const today = dayStr(t);
    const toRun: Schedule[] = [];
    let changed = false;
    for (const it of this.items) {
      if (!(it.enabled ?? true) || it.last_fired === today) continue;
      const target = todayTarget(it.time, t);
      if (t < target) continue;
      it.last_fired = today;          // 先记账：执行失败也不在当天反复重试
      changed = true;
      if (t - target <= MISS_WINDOW) toRun.push({ ...it });
      else console.log(`[snapshot] ⏭  跳过已错过的计划 ${it.time}（迟 ${Math.floor((t - target) / 60)} 分钟）`);
    }
    if (changed) this.save();
    for (const it of toRun) await this.fireOne(it);
    return toRun.length;
  }

  start(run: RunFn) {
    this.run = run;
    this.load();
    this.timer = setInterval(() => { this.fireDue().catch((e) => console.log(`[snapshot] 调度异常: ${e.message}`)); }, CHECK_INTERVAL * 1000);
    this.timer.unref();
  }
}
