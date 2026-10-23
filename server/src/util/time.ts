// Python time.strftime / datetime 的最小等价物（都按服务端本地时区）。
const p2 = (n: number) => String(n).padStart(2, "0");

/** strftime 的子集：%Y %m %d %H %M %S */
export function strftime(fmt: string, d: Date = new Date()): string {
  return fmt.replace(/%([YmdHMS])/g, (_, c: string) => {
    switch (c) {
      case "Y": return String(d.getFullYear());
      case "m": return p2(d.getMonth() + 1);
      case "d": return p2(d.getDate());
      case "H": return p2(d.getHours());
      case "M": return p2(d.getMinutes());
      default: return p2(d.getSeconds());
    }
  });
}

/** 当前 Unix 时间（秒，带小数），对应 Python time.time() */
export const now = (): number => Date.now() / 1000;

/** 解析设备 X-Local-Time（YYYY-MM-DD HH:MM[:SS]），失败回退服务端本地时间。 */
export function parseLocalTime(s: string | undefined | null): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s ?? "");
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
    // 与 strptime 一致：月日时分越界视为解析失败
    if (d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] && +m[4] < 24 && +m[5] < 60) return d;
  }
  return new Date();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
