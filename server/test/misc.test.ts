// 移植自 tests/test_oc_utils.py、test_server_state.py、test_touch.py（摘要解析部分）
import { describe, it, expect, vi, afterEach } from "vitest";
import { extractJson, stripMarkdown, b64Header } from "../src/util/text.ts";
import { ServerState } from "../src/state.ts";
import { touchBackground, withTouch } from "../src/shortcut/touch.ts";

describe("extractJson", () => {
  it("ANSI 噪声", () => {
    const d = extractJson('\x1b[32m[info]\x1b[0m starting\n{"status": "ok", "result": {"payloads": [{"text": "你好"}]}}\ntrailing log');
    expect(d.status).toBe("ok");
    expect(d.result.payloads[0].text).toBe("你好");
  });
  it("嵌套", () => expect(extractJson('x {"a": {"b": {"c": 1}}} y')).toEqual({ a: { b: { c: 1 } } }));
  it("没有 JSON 抛错", () => expect(() => extractJson("plain log output without json")).toThrow());
  it("字符串里的括号不错位", () => expect(extractJson('log {invalid} more {"status": "ok", "text": "这里有个}括号{哈哈"} tail').text).toBe("这里有个}括号{哈哈"));
  it("跳过非 JSON 的括号噪声", () => expect(extractJson('\x1b[33m{warn}\x1b[0m\n{"a": 1}')).toEqual({ a: 1 }));
});

describe("stripMarkdown", () => {
  it("常见标记", () => {
    const out = stripMarkdown("# 标题\n**加粗** 和 *斜体*，`代码`，[链接](http://x.com)\n- 列表项\n1. 有序项");
    for (const bad of ["**", "#", "`", "http://x.com"]) expect(out).not.toContain(bad);
    for (const good of ["加粗", "斜体", "链接", "列表项", "有序项"]) expect(out).toContain(good);
  });
  it("代码块整段去掉", () => {
    const out = stripMarkdown("看代码：\n```python\nprint(1)\n```\n结束");
    expect(out).not.toContain("print");
    expect(out).toContain("看代码");
  });
  it("分隔线", () => {
    const out = stripMarkdown("🌙 晚安简报\n========================================\n今晚天气：雷暴\n----\n晚安！");
    expect(out).not.toContain("=");
    expect(out).not.toContain("----");
    expect(out).toContain("今晚天气：雷暴");
  });
  it("行内符号串", () => {
    const out = stripMarkdown("标题====结尾");
    expect(out).not.toContain("==");
  });
});

it("b64Header 按字符裁剪，不切坏汉字", () => {
  const h = b64Header("好".repeat(100));
  expect(Buffer.from(h, "base64").toString("utf8")).toBe("好".repeat(60));
});

describe("ServerState", () => {
  afterEach(() => vi.useRealTimers());
  it("会话按设备稳定", () => {
    const st = new ServerState();
    const a = st.getSession("dev-a");
    expect(st.getSession("dev-a")).toBe(a);
    expect(st.getSession("dev-b")).not.toBe(a);
  });
  it("会话 LRU 淘汰", () => {
    const st = new ServerState(2);
    const first = st.getSession("d1");
    st.getSession("d2");
    st.getSession("d3");
    expect(st.sessions.has("d1")).toBe(false);
    expect(st.getSession("d1")).not.toBe(first);
  });
  it("按设备限流", () => {
    const st = new ServerState(100, 60, 3);
    expect([1, 2, 3].every(() => st.checkRate("dev"))).toBe(true);
    expect(st.checkRate("dev")).toBe(false);
    expect(st.checkRate("other-dev")).toBe(true);
  });
  it("窗口滚动", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const st = new ServerState(100, 60, 1);
    expect(st.checkRate("dev")).toBe(true);
    expect(st.checkRate("dev")).toBe(false);
    vi.setSystemTime(1_000_000 + 61_000);
    expect(st.checkRate("dev")).toBe(true);
  });
  it("桶互相独立 + 单独上限", () => {
    const st = new ServerState(100, 60, 1);
    expect(st.checkRate("dev", "chat")).toBe(true);
    expect(st.checkRate("dev", "upload", 5)).toBe(true);
    expect(st.checkRate("dev", "chat")).toBe(false);
    const st2 = new ServerState(100, 60, 1);
    expect(st2.checkRate("dev", "upload", 2)).toBe(true);
    expect(st2.checkRate("dev", "upload", 2)).toBe(true);
    expect(st2.checkRate("dev", "upload", 2)).toBe(false);
  });
});

describe("X-Touch 摘要", () => {
  it("空/坏头", () => {
    expect(touchBackground("")).toBe("");
    expect(touchBackground("stroke")).toBe("");
    expect(touchBackground("stroke=abc")).toBe("");
  });
  it("抚摸", () => {
    const bg = touchBackground("stroke=12,strokes=1");
    expect(bg.startsWith("[身体感觉：") && bg.endsWith("]")).toBe(true);
    expect(bg).toContain("12 秒");
    expect(touchBackground("stroke=20,strokes=3")).toContain("3 次");
  });
  it("组合", () => {
    const bg = touchBackground("stroke=8,strokes=1,taps=2,pickups=1");
    for (const s of ["；", "8 秒", "2 下", "拿起来"]) expect(bg).toContain(s);
  });
  it("安静按分钟", () => expect(touchBackground("quiet=1830")).toContain("30 分钟"));
  it("短暂端着不报", () => {
    expect(touchBackground("carry=2")).toBe("");
    expect(touchBackground("carry=10")).toContain("10 秒");
  });
  it("超长头忽略", () => expect(touchBackground("stroke=1," + "x".repeat(300))).toBe(""));
  it("坏键值跳过", () => expect(touchBackground("junk,stroke=5,=,also=bad!")).toContain("5 秒"));
  it("withTouch", () => {
    expect(withTouch("你在干嘛", "stroke=6,strokes=1")).toMatch(/^\[身体感觉：[\s\S]*你在干嘛$/);
    expect(withTouch("你在干嘛", "")).toBe("你在干嘛");
  });
});
