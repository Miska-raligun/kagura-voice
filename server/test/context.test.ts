// 上下文预算：系统提示 / 工具定义算进去、按 token 留最近的、旧工具结果截短、超长自动重试、压缩时顺手记记忆、回复后后台预压缩
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeRuntime } from "./helpers.ts";
import { pruneToolResults, msgTokens, OLD_TOOL_CHARS, TOOL_RESULT_MAX_CHARS } from "../src/agent/runtime.ts";

const dev = { kind: "main" as const, channel: "device", trusted: true };
const tr = (text: string) => ({ role: "toolResult", toolCallId: "x", toolName: "web_fetch", content: [{ type: "text", text }], isError: false, timestamp: 0 });
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

/** 把模型的窗口改小（假模型默认 12.8 万） */
function smallWindow(rt: any, contextWindow: number, maxTokens = 1000) {
  const orig = rt.models.resolve.bind(rt.models);
  rt.models.resolve = (ref: string) => ({ ...orig(ref), contextWindow, maxTokens });
}

describe("上下文预算", () => {
  it("工具结果截短：之前几轮的只留开头；这一轮单条有上限；总量超了从这一轮最早的截", () => {
    const big = "字".repeat(30_000);
    const msgs = [user("先查"), tr(big), user("再查"), tr(big), tr(big)];
    const out = pruneToolResults(msgs);
    expect((out[1] as any).content[0].text.length).toBeLessThan(OLD_TOOL_CHARS + 80);
    expect((out[3] as any).content[0].text.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 80);
    expect((msgs[1] as any).content[0].text.length).toBe(30_000);          // 不改原数组（库里存的是原文）
    const tight = pruneToolResults(msgs, 20_000);
    expect((tight[3] as any).content[0].text.length).toBeLessThan(OLD_TOOL_CHARS + 80);   // 这一轮最早那条也截了
    expect((tight[4] as any).content[0].text.length).toBeGreaterThan(10_000);
    expect(tight.reduce((n, m) => n + msgTokens(m), 0)).toBeLessThanOrEqual(20_000);
  });

  it("系统提示算进预算：人设很长、窗口小，历史没到 agent 设置的阈值也会压缩", async () => {
    const { rt, reg, fake } = makeRuntime();
    smallWindow(rt, 20_000);
    fs.writeFileSync(path.join(reg.get("main")!.workspace, "USER.md"), "记".repeat(12_000));
    const key = "main:main";
    for (let i = 0; i < 4; i++) { fake.queue.push("好的".repeat(400)); await rt.run({ ...dev, agentId: "main", sessionKey: key, text: `第${i}句`.repeat(300) }); }
    fake.queue.push("摘要", "嗯");
    await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "还在吗" });
    expect(rt.store("main").getSession(key)?.summary).toBe("摘要");
    expect(reg.get("main")!.compaction.max_tokens).toBe(60_000);       // agent 设置没动，是窗口算出来的阈值触发的
  });

  it("按 token 留最近的：上一轮工具结果再大，压缩后也不会还超阈值", async () => {
    const { rt, reg, fake } = makeRuntime();
    reg.update("main", { compaction: { max_tokens: 3000, keep_messages: 30 } });
    const key = "main:main";
    for (let i = 0; i < 3; i++) {
      fake.queue.push({ tool_calls: [{ name: "memory_search", args: { query: "x" } }], then: "查完了".repeat(200) });
      await rt.run({ ...dev, agentId: "main", sessionKey: key, text: `第${i}个问题`.repeat(200) });
    }
    fake.queue.push("摘要", "好");
    await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "嗯" });
    const left = rt.store("main").history(key);
    expect(left.reduce((n, h) => n + msgTokens(h.msg), 0)).toBeLessThan(3000);
    expect(left[0].msg.role).toBe("user");                         // 从用户消息处切开，工具调用和结果不拆开
  });

  it("服务商报上下文超长：狠压一次再重试一次，这一轮照常回复", async () => {
    const { rt, fake } = makeRuntime();
    const key = "main:main";
    for (let i = 0; i < 3; i++) { fake.queue.push(`回复${i}`); await rt.run({ ...dev, agentId: "main", sessionKey: key, text: `问题${i}` }); }
    fake.queue.push({ error: "This model's maximum context length is 8192 tokens" }, "摘要", "压完再答");
    const r = await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "最新的问题" });
    expect(r.text).toBe("压完再答");
    expect(rt.store("main").getSession(key)?.summary).toBe("摘要");
    // 别的错误不重试
    fake.queue.push({ error: "invalid api key" });
    await expect(rt.run({ ...dev, agentId: "main", sessionKey: key, text: "再问" })).rejects.toThrow(/api key/);
  });

  it("压缩时顺手挑要记住的事：长期进 MEMORY.md、今天的进当天笔记；不再另跑整段上下文的冲刷", async () => {
    const { rt, reg, fake } = makeRuntime();
    const a = reg.get("main")!;
    rt.remember = (ag, target, text) => {
      const f = target === "long" ? path.join(ag.workspace, "MEMORY.md") : target === "user" ? path.join(ag.workspace, "USER.md") : path.join(ag.workspace, "memory", "today.md");
      fs.appendFileSync(f, `- ${text}\n`);
    };
    reg.update("main", { compaction: { max_tokens: 30, keep_messages: 2 } });
    const key = "main:main";
    for (let i = 0; i < 3; i++) { fake.queue.push(`回复${i}，`.repeat(5)); await rt.run({ ...dev, agentId: "main", sessionKey: key, text: `第${i}句话`.repeat(3) }); }
    const calls = fake.calls.length;
    fake.queue.push("主人在问问题。\n【记住】\n- 主人：女儿叫朵朵\n- 长期：主人喜欢乌龙茶\n- 今天：下午去了公园\n", "好");
    await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "嗯" });
    expect(rt.store("main").getSession(key)?.summary).toBe("主人在问问题。");
    expect(fs.readFileSync(path.join(a.workspace, "MEMORY.md"), "utf8")).toContain("主人喜欢乌龙茶");
    expect(fs.readFileSync(path.join(a.workspace, "memory", "today.md"), "utf8")).toContain("下午去了公园");
    expect(fs.readFileSync(path.join(a.workspace, "USER.md"), "utf8")).toContain("女儿叫朵朵");
    expect(fake.calls.length - calls).toBe(2);                   // 摘要 + 回复，没有额外的冲刷调用
  });

  it("回复后接近阈值就在后台先压，下一轮不用等", async () => {
    const { rt, reg, fake } = makeRuntime();
    rt.backgroundCompact = true;
    reg.update("main", { compaction: { max_tokens: 200, keep_messages: 4 } });
    const key = "main:main";
    fake.queue.push("好".repeat(60));
    await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "问".repeat(60) });
    fake.queue.push("好".repeat(60), "后台摘要");
    await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "再问".repeat(30) });
    for (let i = 0; i < 50 && !rt.store("main").getSession(key)?.summary; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rt.store("main").getSession(key)?.summary).toBe("后台摘要");
  });
});
