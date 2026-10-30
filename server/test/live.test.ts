// 会话页实时过程：任何入口来的一轮，订阅者都能看到开始、思考 / 正文增量、工具、消息、结束
import { describe, it, expect } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { makeRuntime } from "./helpers.ts";
import { ok } from "../src/agent/tools/device.ts";

describe("实时过程", () => {
  it("订阅后看得到这一轮的全过程，结束推 end；中途订阅先拿到快照", async () => {
    const { rt, fake } = makeRuntime();
    rt.addTools(() => [{ name: "look", label: "看看", description: "看看", parameters: Type.Object({}), execute: async () => ok("x".repeat(20000)) } as any]);
    const seen: any[] = [];
    const off = rt.watchLive("main", "main:feishu:dm", (e) => seen.push(e));
    let snap: any = null;
    fake.queue.push({ text: "我看看。", tool_calls: [{ name: "look" }], then: "看完了" });
    const p = rt.run({ agentId: "main", sessionKey: "main:feishu:dm", kind: "chat", channel: "feishu", trusted: true, text: "帮我看看" });
    // 中途来的订阅者：先拿到当前这一轮
    await new Promise((r) => setTimeout(r, 0));
    const off2 = rt.watchLive("main", "main:feishu:dm", (e) => { if (!snap) snap = e; });
    await p;
    off(); off2();
    const types = seen.map((e) => e.type);
    expect(types[0]).toBe("idle");
    expect(types[1]).toBe("start");
    expect(types.at(-1)).toBe("end");
    expect(types).toContain("delta");
    expect(seen.filter((e) => e.type === "tool").map((e) => e.running)).toEqual([true, false]);
    const msgs = seen.filter((e) => e.type === "message").map((e) => e.message);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(msgs[2].content[0].text.length).toBeLessThan(9000);           // 超长工具结果截短
    expect(seen.at(-1).error).toBeUndefined();
    expect(["start", "idle"]).toContain(snap.type);
    expect(rt.store("main").history("main:feishu:dm").length).toBe(4);
  });

  it("出错的一轮 end 带原因", async () => {
    const { rt, fake } = makeRuntime();
    const seen: any[] = [];
    rt.watchLive("main", "main:main", (e) => seen.push(e));
    fake.queue.push({ error: "invalid api key" });
    await expect(rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "hi" })).rejects.toThrow();
    expect(seen.at(-1)).toMatchObject({ type: "end", error: expect.stringContaining("api key") });
  });
});

describe("每轮 token 明细", () => {
  it("最后一条助手消息记上这一轮的上下文构成；再发给模型时去掉", async () => {
    const { rt, fake } = makeRuntime();
    fake.queue.push("好", "嗯");
    await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "你好" });
    const last = rt.store("main").history("main:main").map((h) => h.msg as any).filter((m) => m.role === "assistant").at(-1);
    expect(last.kctx).toMatchObject({ calls: 1 });
    expect(last.kctx.sys).toBeGreaterThan(0);
    expect(last.kctx.win).toBeGreaterThan(0);
    expect(last.usage).toBeTruthy();
    await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "再来" });
    expect(rt.store("main").history("main:main").length).toBe(4);
  });
});

describe("系统处理详情", () => {
  it("每轮记下系统提示的构成和自动回忆；压缩记成会话事件", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { rt, reg, fake } = makeRuntime();
    const a = reg.get("main")!;
    fs.writeFileSync(path.join(a.workspace, "USER.md"), "主人叫小明");
    fs.writeFileSync(path.join(a.workspace, "TOOLS.md"), "# 工具\n## NAS\n地址");
    rt.recall = async () => [{ line: "MEMORY.md#L1：主人爱喝乌龙茶", why: "乌龙、龙茶" }];
    rt.remember = () => {};
    fake.queue.push("好");
    await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "泡杯乌龙茶" });
    const c = (rt.store("main").history("main:main").at(-1)!.msg as any).kctx;
    expect(c.trace.scene).toBe("owner");
    expect(c.trace.files).toEqual(expect.arrayContaining([{ name: "USER.md", mode: "full", chars: 5, clipped: false }, expect.objectContaining({ name: "TOOLS.md", mode: "toc" })]));
    expect(c.recall.hits).toEqual(["MEMORY.md#L1：主人爱喝乌龙茶（命中：乌龙、龙茶）"]);
    // 压缩：手动压一次，事件里有原因、条数、记下的记忆
    for (let i = 0; i < 2; i++) { fake.queue.push(`回复${i}`); await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: `问题${i}` }); }
    reg.update("main", { compaction: { ...a.compaction, keep_messages: 2 } });
    fake.queue.push("主人在聊天。\n【记住】\n- 主人：女儿叫朵朵\n");
    expect(await rt.compact("main", "main:main")).toBe(true);
    const ev = rt.store("main").events("main:main");
    expect(ev.at(-1)).toMatchObject({ kind: "compact", data: { trigger: "manual", remembered: [{ target: "user", text: "女儿叫朵朵" }] } });
    expect(ev.at(-1)!.data.messages).toBeGreaterThan(0);
  });
});

describe("会话来源", () => {
  it("用户消息记下从哪来，发给模型前去掉；主动开口记进来的标成 note", async () => {
    const { rt, fake } = makeRuntime();
    fake.queue.push("好", "嗯");
    await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "device", deviceId: "cores3", text: "你好" });
    await rt.note("main", "main:main", "heartbeat", "该喝水啦");
    await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "feishu", trusted: true, text: "好的" });
    const users = rt.store("main").history("main:main").map((h) => h.msg as any).filter((m) => m.role === "user");
    expect(users.map((m) => m.ksrc)).toEqual([
      { channel: "device", purpose: "chat", device: "cores3" },
      { channel: "system", purpose: "note", tag: "heartbeat" },
      { channel: "feishu", purpose: "chat" },
    ]);
  });
});

describe("打断", () => {
  it("手动终止的一轮：问题和已经说出口的部分记进历史、注明被打断；下一轮照常", async () => {
    const { rt, fake } = makeRuntime();
    fake.queue.push({ text: "我想想啊，这个问题要从很久以前说起，那时候" + "很长很长的故事，".repeat(40), tps: 5 }, "好的，换个话题");
    const p = rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "讲讲历史" });
    // 等她真的说出几个字再打断
    let said = "";
    rt.watchLive("main", "main:main", (e: any) => { if (e.type === "delta" && e.kind === "text") said += e.delta; });
    for (let i = 0; i < 300 && said.length < 4; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rt.cancelRun("main|main:main")).toBe(true);
    await expect(p).rejects.toThrow(/终止/);
    const h = rt.store("main").history("main:main").map((x) => x.msg as any);
    expect(h.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(h[1].content[0].text).toMatch(/^我想想啊.*\n（这一轮被主人打断了，没说完）$/s);
    const r = await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "算了，换个话题" });
    expect(r.text).toBe("好的，换个话题");
    expect(rt.store("main").history("main:main").length).toBe(4);
  });
});
