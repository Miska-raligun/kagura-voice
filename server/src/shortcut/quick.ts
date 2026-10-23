// 快捷指令：把高频简单查询（时间/日期/星期/音量/提醒）短路掉，不走 LLM。逐条对应 quick_commands.py。
import { parseLocalTime, now as nowSec } from "../util/time.ts";
import { pyLen, stripChars } from "../util/text.ts";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
/** Python weekday()：周一 = 0 */
const pyWeekday = (d: Date) => (d.getDay() + 6) % 7;

function sayTime(d: Date): string {
  const h = d.getHours(), m = d.getMinutes();
  const period = h < 5 ? "凌晨" : h < 12 ? "上午" : h < 14 ? "中午" : h < 18 ? "下午" : "晚上";
  const h12 = h <= 12 ? h : h - 12;
  return m === 0 ? `现在是${period}${h12}点整。` : `现在是${period}${h12}点${m}分。`;
}
const sayDate = (d: Date) => `今天是${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日。`;
const sayWeekday = (d: Date) => `今天是星期${WEEKDAYS[pyWeekday(d)]}。`;

const RULES: [RegExp, (d: Date) => string][] = [
  [/(现在|当前).{0,3}(几点|时间)/, sayTime],
  [/几点了/, sayTime],
  [/报时/, sayTime],
  [/今天.{0,4}(几号|日期)/, sayDate],
  [/今天.{0,4}星期/, sayWeekday],
  [/星期几/, sayWeekday],
  [/周几/, sayWeekday],
];

/** 命中返回快捷回复文本；null 表示应走 LLM。 */
export function match(text: string, localTime = ""): string | null {
  if (!text) return null;
  const d = parseLocalTime(localTime);
  for (const [re, fn] of RULES) if (re.test(text)) return fn(d);
  return null;
}

// ── 音量 ──
const VOL_UP = /(大声|声音大|音量.{0,2}(大|高)|调高音量)/;
const VOL_DOWN = /(小声|声音小|音量.{0,2}(小|低)|调低音量)/;

export function matchVolume(text: string): ["up" | "down", string] | null {
  if (!text) return null;
  if (VOL_DOWN.test(text)) return ["down", "好的，音量调小了。"];
  if (VOL_UP.test(text)) return ["up", "好的，音量调大了。"];
  return null;
}

// ── 提醒解析 ──
const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字 → 整数，支持 1~99 与阿拉伯数字 */
export function cn2int(s: string): number | null {
  if (/^[0-9]+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  if (s.includes("十")) {
    const [head, tail] = [s.slice(0, s.indexOf("十")), s.slice(s.indexOf("十") + 1)];
    const tens = head ? (CN_DIGIT[head] ?? 1) : 1;
    const ones = tail ? (CN_DIGIT[tail] ?? 0) : 0;
    return tens * 10 + ones;
  }
  return s in CN_DIGIT ? CN_DIGIT[s] : null;
}

const NUM = "[0-9]+|[一二两三四五六七八九十]+";
const TRIGGER = "(?:提醒我|提醒一下|叫我|喊我)";
const REL_RE = new RegExp(`(?:过)?(半|${NUM})\\s*(秒钟?|分钟|个?小时|个?钟头)(半)?之?[后後]?\\s*${TRIGGER}(.*)`);
const ABS_RE = new RegExp(`(明天)?(凌晨|早上|上午|中午|下午|晚上)?(${NUM})点(半|(?:${NUM})分?)?\\s*${TRIGGER}(.*)`);

const cleanTask = (raw: string) => stripChars(raw.trim(), "，。,.!！?？ ") || "";
/** Python f"{x:g}" */
const fmtG = (x: number) => String(Number(x.toPrecision(6)));

/** 命中返回 [触发时间戳(秒), 提醒内容, 确认回复]；null 表示未命中 */
export function matchReminder(text: string, localTime = ""): [number, string, string] | null {
  if (!text) return null;
  const now = parseLocalTime(localTime);
  // 没有 X-Local-Time 时 parseLocalTime 取的就是当前时间；有时以设备时间为准
  let m = REL_RE.exec(text);
  if (m) {
    const [, numS, unit, extraHalf, taskRaw] = m;
    let seconds: number;
    if (numS === "半") seconds = unit.includes("时") || unit.includes("钟头") ? 1800 : 30;
    else {
      const n = cn2int(numS);
      if (n === null || n <= 0) return null;
      if (unit.includes("秒")) seconds = n;
      else if (unit.includes("分")) seconds = n * 60;
      else seconds = n * 3600 + (extraHalf ? 1800 : 0);
    }
    if (seconds < 5) return null;
    const task = cleanTask(taskRaw);
    const fire = now.getTime() / 1000 + seconds;
    const when = seconds < 60 ? `${seconds}秒` : seconds < 3600 ? `${Math.floor(seconds / 60)}分钟` : `${fmtG(seconds / 3600)}小时`;
    return [fire, task, task ? `好的，${when}后提醒你${task}。` : `好的，${when}后提醒你。`];
  }
  m = ABS_RE.exec(text);
  if (m) {
    const [, tomorrow, period, hourS, minuteS, taskRaw] = m;
    let hour = cn2int(hourS);
    if (hour === null || hour < 0 || hour > 23) return null;
    let minute = 0;
    if (minuteS === "半") minute = 30;
    else if (minuteS) minute = cn2int(minuteS.replace(/分+$/, "")) || 0;
    if (minute < 0 || minute > 59) return null;
    if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
    if (period === "中午" && hour < 11) hour += 12;
    const fire = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (tomorrow || fire <= now) fire.setDate(fire.getDate() + 1);   // 已过的时刻顺延到明天
    const task = cleanTask(taskRaw);
    const sameDay = fire.getFullYear() === now.getFullYear() && fire.getMonth() === now.getMonth() && fire.getDate() === now.getDate();
    const day = sameDay ? "" : "明天";
    const hm = `${fire.getHours()}点${String(fire.getMinutes()).padStart(2, "0")}分`;
    return [fire.getTime() / 1000, task, task ? `好的，${day}${hm}提醒你${task}。` : `好的，${day}${hm}提醒你。`];
  }
  return null;
}

// ── 免手模式（连续对话 / 声控唤醒）──
const PUNCT_RE = /[\s，。！？、,.!?~～…]+/g;
const FILLER = new Set(Array.from("嗯啊哦呃额唉哎噢喔哈呀诶欸嘿喂唔"));
const EXIT_SHORT = ["不聊了", "先这样", "再见", "拜拜", "没事了", "退下吧", "退下", "停", "别说了", "就这样"];
const EXIT_RE = /(退出|结束|关闭|停止|关掉)(连续)?(对话|聊天|模式)/;

/** 「嗯」「啊」「哦哦」：免手模式下多半是环境声被认成了字 */
export function isFiller(text: string): boolean {
  const t = (text || "").replace(PUNCT_RE, "");
  return !t || pyLen(t) <= 1 || Array.from(t).every((c) => FILLER.has(c));
}

/** 「退出连续对话」「不聊了」「拜拜」→ 结束免手模式。短句才认「再见/不聊了」 */
export function matchContExit(text: string): boolean {
  const t = (text || "").replace(PUNCT_RE, "");
  if (EXIT_RE.test(t)) return true;
  return pyLen(t) <= 6 && EXIT_SHORT.some((k) => t.includes(k));
}

export const _nowForTests = nowSec;
