// 移植自 tests/test_quick_commands.py、test_reminders.py（解析与音量部分）、test_roles.py（免手模式匹配）
import { describe, it, expect } from "vitest";
import { match, matchVolume, matchReminder, isFiller, matchContExit } from "../src/shortcut/quick.ts";

const LT = "2026-05-15 14:23";      // 星期五
const BASE = new Date(2026, 4, 15, 14, 23).getTime() / 1000;
const abs = (day: number, h: number, m: number) => new Date(2026, 4, day, h, m).getTime() / 1000;

describe("快捷指令", () => {
  it.each(["现在几点", "现在几点了", "几点了", "请问几点了", "报时", "当前时间"])("报时 %s", (t) => {
    expect(match(t, LT)).toBe("现在是下午2点23分。");
  });
  it.each(["今天几号", "今天日期是多少"])("日期 %s", (t) => expect(match(t, LT)).toBe("今天是2026年5月15日。"));
  it.each(["今天星期几", "今天周几", "星期几"])("星期 %s", (t) => expect(match(t, LT)).toBe("今天是星期五。"));
  it.each(["你好吗", "明天天气怎么样", "讲个笑话", "帮我拍张照片", ""])("不命中 %s", (t) => expect(match(t, LT)).toBeNull());
  it("时段与整点", () => {
    expect(match("几点了", "2026-05-15 08:00")).toBe("现在是上午8点整。");
    expect(match("几点了", "2026-05-15 12:30")).toBe("现在是中午12点30分。");
    expect(match("几点了", "2026-05-15 21:05")).toBe("现在是晚上9点5分。");
  });
  it("非法本地时间回退服务端时钟", () => expect(match("现在几点", "not-a-time")).toMatch(/^现在是/));
  it("带秒的本地时间", () => expect(match("几点了", "2026-05-15 14:23:59")).toBe("现在是下午2点23分。"));
});

describe("提醒解析", () => {
  it.each([
    ["三分钟后提醒我关火", 180, "关火"], ["3分钟后提醒我关火", 180, "关火"], ["过10秒提醒我", 10, ""],
    ["半小时后叫我", 1800, ""], ["一小时后提醒我开会", 3600, "开会"], ["两个小时后提醒我吃药", 7200, "吃药"],
    ["十五分钟后提醒一下泡面好了", 900, "泡面好了"],
  ] as const)("相对 %s", (text, delta, task) => {
    const [ts, t, reply] = matchReminder(text, LT)!;
    expect(ts).toBeCloseTo(BASE + delta, 3);
    expect(t).toBe(task);
    expect(reply.startsWith("好的")).toBe(true);
  });
  it.each([
    ["下午3点半提醒我开会", 15, 15, 30, "开会"], ["晚上八点提醒我追剧", 15, 20, 0, "追剧"],
    ["明天早上八点叫我起床", 16, 8, 0, "起床"], ["早上8点叫我", 16, 8, 0, ""], ["下午2点50分提醒我", 15, 14, 50, ""],
  ] as const)("绝对 %s", (text, d, h, m, task) => {
    const [ts, t] = matchReminder(text, LT)!;
    expect(ts).toBeCloseTo(abs(d, h, m), 3);
    expect(t).toBe(task);
  });
  it.each(["现在几点", "提醒我一下下", "帮我拍张照片", "音量大一点", ""])("不命中 %s", (t) => expect(matchReminder(t, LT)).toBeNull());
  it("回复文案与 Python 版一致", () => {
    expect(matchReminder("5秒后提醒我关火", LT)![2]).toBe("好的，5秒后提醒你关火。");
    expect(matchReminder("一小时半后提醒我", LT)![2]).toBe("好的，1.5小时后提醒你。");
    expect(matchReminder("明天早上八点叫我起床", LT)![2]).toBe("好的，明天8点00分提醒你起床。");
    expect(matchReminder("3秒后提醒我", LT)).toBeNull();          // 少于 5 秒不接
  });
});

describe("音量", () => {
  it.each([["小声一点", "down"], ["声音小一点", "down"], ["音量调小", "down"], ["大声一点", "up"], ["声音大一点", "up"], ["音量调大", "up"]])(
    "%s", (t, d) => { const [dir, reply] = matchVolume(t)!; expect(dir).toBe(d); expect(reply.startsWith("好的")).toBe(true); });
  it("不命中", () => expect(matchVolume("今天天气怎么样")).toBeNull());
});

describe("免手模式", () => {
  it("语气词", () => {
    expect(isFiller("嗯。")).toBe(true);
    expect(isFiller("哦哦")).toBe(true);
    expect(isFiller("嗯，几点了")).toBe(false);
  });
  it("口头退出", () => {
    expect(matchContExit("不聊了")).toBe(true);
    expect(matchContExit("退出连续对话")).toBe(true);
    expect(matchContExit("我们先这样安排明天的行程然后再说别的")).toBe(false);
  });
});
