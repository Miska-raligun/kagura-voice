import { describe, it, expect } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { estimateTokens } from "../src/agent/runtime.ts";

const base = { kind: "main" as const, channel: "device" };

describe("runtime", () => {
  it("一轮对话：回复文本、落盘、下一轮带历史", async () => {
    const { rt, fake } = makeRuntime();
    fake.queue.push("你好呀", "记得，你刚才说了你好");
    const r1 = await rt.run({ ...base, agentId: "main", sessionKey: "main:main", text: "你好" });
    expect(r1.text).toBe("你好呀");
    const r2 = await rt.run({ ...base, agentId: "main", sessionKey: "main:main", text: "我刚才说了什么" });
    expect(r2.text).toBe("记得，你刚才说了你好");
    expect(fake.calls.map((c) => c.message)).toEqual(["你好", "我刚才说了什么"]);
    const hist = rt.store("main").history("main:main");
    expect(hist.map((h) => h.msg.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(fake.calls[0].agent).toBe("main");
    expect(fake.calls[0].system).toContain("神乐");
  });

  it("模型报错 → 抛错且不落盘", async () => {
    const { rt, fake } = makeRuntime();
    fake.queue.push({ error: "boom" });
    await expect(rt.run({ ...base, agentId: "main", sessionKey: "k", text: "hi" })).rejects.toThrow("boom");
    expect(rt.store("main").history("k")).toEqual([]);
  });

  it("estimateTokens 粗估", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});
