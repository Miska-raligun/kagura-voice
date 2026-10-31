// 朗读版写在最前：流式里一写完就交出去念，正文 / 落盘 / 实时页里拆掉
import { describe, it, expect } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { VoiceTap, stripVoice } from "../src/agent/runtime.ts";

describe("VoiceTap", () => {
  it("开头的 <voice> 不放行、闭合就回调；后面的正文照常放行（标签被切碎也认得）", () => {
    const got: string[] = [];
    const tap = new VoiceTap((v) => got.push(v));
    const out = ["  <vo", "ice>今天晴，", "适合出门。</vo", "ice>\n\n## 详细天气\n- 上午 20 度"].map((d) => tap.feed(d)).join("") + tap.end();
    expect(got).toEqual(["今天晴，适合出门。"]);
    expect(out).toBe("## 详细天气\n- 上午 20 度");
  });

  it("不是 <voice> 开头的照常放行；一直没闭合的到消息结尾原样放出去（去掉开头的标签）", () => {
    const got: string[] = [];
    const a = new VoiceTap((v) => got.push(v));
    expect(a.feed("<") + a.feed("好的") + a.end()).toBe("<好的");
    const b = new VoiceTap((v) => got.push(v));
    expect(b.feed("<voice>忘了闭合") + b.end()).toBe("忘了闭合");
    expect(got).toEqual([]);
  });

  it("stripVoice 去掉所有 <voice> 段", () => {
    expect(stripVoice("<voice>念的</voice>\n正文")).toBe("正文");
    expect(stripVoice("正文")).toBe("正文");
  });
});

describe("会被念的回复先写朗读版", () => {
  it("一写完就回调、正文和落盘里都没有它，系统提示里有写法说明；没要求的轮次不加说明", async () => {
    const { rt, fake } = makeRuntime();
    const voiced: { v: string; at: number }[] = [];
    const t0 = Date.now();
    fake.queue.push({ text: "<voice>明天晴，记得防晒。</voice>\n明天的详细天气：" + "上午多云转晴，最高 28 度。".repeat(30), tps: 400 });
    const r = await rt.run({ kind: "chat", channel: "webchat", agentId: "main", sessionKey: "main:webchat:x", text: "明天天气", trusted: true,
      onVoice: (v) => voiced.push({ v, at: Date.now() - t0 }) });
    expect(voiced.map((x) => x.v)).toEqual(["明天晴，记得防晒。"]);
    expect(voiced[0].at).toBeLessThan(Date.now() - t0 - 200);       // 正文还在写的时候就交出去了
    expect(r.voice).toBe("明天晴，记得防晒。");
    expect(r.text.startsWith("明天的详细天气")).toBe(true);
    expect(JSON.stringify(rt.store("main").history("main:webchat:x").map((h) => h.msg))).not.toContain("<voice>");
    expect(fake.calls.at(-1).system).toContain("<voice_first>");
    fake.queue.push("好");
    await rt.run({ kind: "chat", channel: "webchat", agentId: "main", sessionKey: "main:webchat:x", text: "嗯", trusted: true });
    expect(fake.calls.at(-1).system).not.toContain("<voice_first>");
  });

  it("只写了 <voice> 没写正文：朗读版本身当回复", async () => {
    const { rt, fake } = makeRuntime();
    fake.queue.push("<voice>好的，记下了。</voice>");
    const r = await rt.run({ kind: "chat", channel: "webchat", agentId: "main", sessionKey: "main:webchat:y", text: "记一下", trusted: true, onVoice: () => {} });
    expect(r.text).toBe("好的，记下了。");
    expect(rt.store("main").history("main:webchat:y").length).toBe(2);
  });
});
