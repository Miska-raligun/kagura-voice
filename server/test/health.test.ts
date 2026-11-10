// 运行状况：每轮结果、兜底动作记进统计，按天汇总、列出最近异常
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { health, errorClass } from "../src/agent/health.ts";

afterEach(() => health.close());

describe("运行状况", () => {
  it("失败按类归", () => {
    expect(errorClass("429 Too Many Requests")).toBe("限流 429");
    expect(errorClass("模型连着两次返回了空回复")).toBe("空回复");
    expect(errorClass("已在管理界面终止")).toBe("被取消");
    expect(errorClass("fetch failed")).toBe("网络");
    expect(errorClass("503 Service Unavailable")).toBe("服务商出错");
  });

  it("每轮成功 / 失败、催说话都记下来，按天汇总，异常列表只列有问题的", async () => {
    health.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kh-")), "system.sqlite"));
    const { rt, fake } = makeRuntime();
    fake.queue.push("好的");
    await rt.run({ kind: "main", channel: "webchat", agentId: "main", sessionKey: "main:main", text: "x", trusted: true });
    fake.queue.push("", "说了");                       // 想完没说话 → 催一句
    await rt.run({ kind: "main", channel: "webchat", agentId: "main", sessionKey: "main:main", text: "y", trusted: true });
    fake.queue.push({ error: "429 rate limit exceeded" });
    await rt.run({ kind: "main", channel: "webchat", agentId: "main", sessionKey: "main:main", text: "z", trusted: true }).catch(() => {});
    const [today] = health.summary(1);
    expect(today.turns).toBe(3);
    expect(today.ok).toBe(2);
    expect(today.errors["限流 429"]).toBe(1);
    expect(today.events.nudge).toBe(1);
    const recent = health.recent(10);
    expect(recent.map((e: any) => e.kind)).toEqual(["turn", "nudge"]);
    expect(recent[0].detail.error).toBe("限流 429");
  });

  it("链式召回看得出有没有在用：每次 read_ref 记一条（找到 / 没找到、按哪种编号），压缩记下摘要带了几处出处；顺利的压缩不算兜底", async () => {
    health.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kh-")), "system.sqlite"));
    const { rt, reg, fake } = makeRuntime();
    const { recallTools, refType } = await import("../src/agent/tools/recall.ts");
    const scope: any = { agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", purpose: "chat", hop: 0, chain: [], meta: {}, trusted: true };
    const read = (args: any) => recallTools(rt, reg)(scope, reg.get("main")!)[0].execute("t", args) as Promise<any>;
    for (const q of ["车停在 B2 层 17 号", "明天十点开会", "提醒我买牛奶"]) { fake.queue.push("记下了"); await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: q }); }
    reg.update("main", { compaction: { ...reg.get("main")!.compaction, keep_messages: 2 } });
    const firstId = rt.store("main").history("main:main")[0].id;
    fake.queue.push(`【摘要】\n- 车停在 B2 层 17 号（#m${firstId}）\n- 明天十点开会`);
    expect(await rt.compact("main", "main:main")).toBe(true);
    expect(rt.store("main").events("main:main").at(-1)!.data.refs).toBe(1);

    expect((await read({ ref: `#m${firstId}` })).isError).toBeFalsy();     // 找到
    expect((await read({ ref: "tool:nope" })).isError).toBe(true);          // 没找到
    await read({ query: "B2 17" });                                         // 搜到
    await read({ query: "火星基地" });                                      // 没搜到
    expect([{ ref: "m1-m9" }, { ref: "session:main:main" }, { ref: "task:abc" }, { ref: "???" }].map(refType)).toEqual(["range", "session", "task", "unknown"]);

    const [today] = health.summary(1);
    expect(today.recall).toEqual({ reads: 4, miss: 2, types: { msg: 1, tool: 1, query: 2 }, compacts: 1, cited: 1, refs: 1 });
    expect(today.events.compact).toBeUndefined();                           // 顺利的压缩不计进「压缩有段没总结成」
    // 异常列表只列没找到的
    const rec = health.recent(20, "recall");
    expect(rec.map((e: any) => [e.ok, e.detail.type])).toEqual([[false, "query"], [false, "tool"]]);
    expect(rec[0].detail.ref).toBe("搜「火星基地」");

    // 摘要没带出处的压缩：算进压缩次数，不算带出处
    for (const q of ["再说一件事", "还有一件"]) { fake.queue.push("好"); await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: q }); }
    fake.queue.push("【摘要】\n- 聊了几件事");
    expect(await rt.compact("main", "main:main")).toBe(true);
    const r2 = health.summary(1)[0].recall;
    expect([r2.compacts, r2.cited]).toEqual([2, 1]);
  });
});
