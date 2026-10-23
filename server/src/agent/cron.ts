// 5 段 cron 表达式（分 时 日 月 周）+ 时区。支持 * , - / 和英文月份/星期名；
// 日与周都受限时按标准 cron 取「或」。下一次触发时间按「天 → 时 → 分」跳着找，不逐分钟遍历。

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOWS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface Field { set: Set<number>; any: boolean }
export interface Cron { minute: Field; hour: Field; dom: Field; month: Field; dow: Field; tz: string }

function parseField(src: string, min: number, max: number, names?: string[]): Field {
  const set = new Set<number>();
  const val = (s: string) => {
    const i = names ? names.indexOf(s.toLowerCase().slice(0, 3)) : -1;
    const n = i >= 0 ? i + (names === MONTHS ? 1 : 0) : Number(s);
    if (!Number.isInteger(n)) throw new Error(`cron 字段不合法: ${s}`);
    return n;
  };
  for (const part of src.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 步长不合法: ${part}`);
    let lo: number, hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range.includes("-")) { const [a, b] = range.split("-"); [lo, hi] = [val(a), val(b)]; }
    else { lo = val(range); hi = stepS === undefined ? lo : max; }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron 字段越界: ${part}`);
    // 星期 7 = 周日（= 0）
    for (let v = lo; v <= hi; v += step) set.add(max === 7 ? v % 7 : v);
  }
  return { set, any: src === "*" };
}

export function parseCron(expr: string, tz?: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("cron 表达式要 5 段：分 时 日 月 周");
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  new Intl.DateTimeFormat("en-US", { timeZone: zone });   // 时区不合法会在这里抛错
  return {
    minute: parseField(f[0], 0, 59), hour: parseField(f[1], 0, 23), dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12, MONTHS), dow: parseField(f[4], 0, 7, DOWS), tz: zone,
  };
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** 某时刻在时区里的墙上时间 */
export function zoned(ms: number, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, dow: DOWS.indexOf(p.weekday.toLowerCase().slice(0, 3)) };
}

function dayMatches(c: Cron, z: ReturnType<typeof zoned>) {
  if (!c.month.set.has(z.month)) return false;
  const d = c.dom.set.has(z.day), w = c.dow.set.has(z.dow);
  if (c.dom.any && c.dow.any) return true;
  if (c.dom.any) return w;
  if (c.dow.any) return d;
  return d || w;
}

/** 严格晚于 afterMs 的下一次触发（毫秒）。两年内找不到返回 null（比如 2 月 30 日） */
export function nextCron(c: Cron, afterMs: number): number | null {
  const MIN = 60_000;
  let t = Math.floor(afterMs / MIN) * MIN + MIN;
  const limit = afterMs + 2 * 366 * 86400_000;
  while (t < limit) {
    const z = zoned(t, c.tz);
    if (!dayMatches(c, z)) { t += ((23 - z.hour) * 60 + (60 - z.minute)) * MIN; continue; }   // 跳到当地次日 0 点
    if (!c.hour.set.has(z.hour)) { t += (60 - z.minute) * MIN; continue; }                     // 跳到下一个整点
    if (!c.minute.set.has(z.minute)) { t += MIN; continue; }
    return t;
  }
  return null;
}

/** "08:00-23:00"（可跨午夜，如 "22:00-07:00"）是否覆盖该时刻。空串 = 全天 */
export function inActiveHours(spec: string, ms: number, tz?: string): boolean {
  if (!spec) return true;
  const m = spec.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return true;
  const z = zoned(ms, tz || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const cur = z.hour * 60 + z.minute, a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

/** "30m" / "2h" / "1d" / "90s" / 纯数字（秒）→ 秒 */
export function parseDuration(s: string | number): number {
  if (typeof s === "number") return s;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)?s?$/i);
  if (!m) throw new Error(`时间间隔格式不对: ${s}（例：30m、2h、1d）`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase()[0];
  return Math.round(n * ({ s: 1, m: 60, h: 3600, d: 86400 } as any)[unit]);
}
