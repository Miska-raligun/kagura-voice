// 链式召回：截短留指针、摘要注出处、按编号读原文（read_ref）
import { describe, it, expect } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { makeRuntime } from "./helpers.ts";
import { pruneToolResults, OLD_TOOL_CHARS } from "../src/agent/runtime.ts";
import { recallTools, READ_MAX } from "../src/agent/tools/recall.ts";
import { buildSystemPrompt } from "../src/agent/soul.ts";

const scopeOf = (o: any = {}): any => ({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", purpose: "chat", hop: 0, chain: [], meta: {}, trusted: true, ...o });
const text = (r: any) => r.content[0].text as string;

function setup() {
  const env = makeRuntime();
  env.rt.addTools(recallTools(env.rt, env.reg));
  const big = "开头" + "很长的网页内容。".repeat(2500) + "结尾的关键数字 42";
  env.rt.addTools(() => [{ name: "fetch_big", label: "大", description: "大", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: big }], details: {} }) } as any]);
  const read = (args: any, scope = scopeOf()) => recallTools(env.rt, env.reg)(scope, env.reg.get("main")!)[0].execute("t", args) as Promise<any>;
  return { ...env, big, read };
}

describe("截短的工具结果留指针", () => {
  it("有 read_ref 时截短提示写 ref=tool:<调用编号>；没有时照旧提示重跑", () => {
    const msgs: any[] = [
      { role: "user", content: [{ type: "text", text: "查" }] },
      { role: "toolResult", toolCallId: "call_7", content: [{ type: "text", text: "x".repeat(OLD_TOOL_CHARS + 100) }] },
      { role: "user", content: [{ type: "text", text: "再说" }] },
    ];
    expect(pruneToolResults(msgs, Infinity, true)[1].content[0].text).toContain("read_ref 读 ref=tool:call_7");
    expect(pruneToolResults(msgs)[1].content[0].text).toContain("再调一次工具");
  });

  it("read_ref 读 tool:<编号>：之前几轮的从库里拿原文（不重跑工具），长的分页；这一轮的从内存里拿", async () => {
    const { rt, fake, big, read } = setup();
    fake.queue.push({ tool_calls: [{ name: "fetch_big" }], then: "看完了" });
    await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "读一下那个网页" });
    const tr = rt.store("main").history("main:main").map((h) => h.msg as any).find((m) => m.role === "toolResult");
    const r1 = text(await read({ ref: `tool:${tr.toolCallId}` }));
    expect(r1.startsWith("开头")).toBe(true);
    expect(r1).toMatch(/还有 \d+ 字，用 offset=12000 接着读/);
    expect(text(await read({ ref: `tool:${tr.toolCallId}`, offset: READ_MAX }))).toContain("结尾的关键数字 42");
    const inTurn = scopeOf({ toolOriginals: new Map([["c_now", "这一轮刚拿到的原文"]]) });
    expect(text(await read({ ref: "tool:c_now" }, inTurn))).toBe("这一轮刚拿到的原文");
    expect((await read({ ref: "tool:nope" })).isError).toBe(true);
    expect(big.length).toBeGreaterThan(READ_MAX);
  });
});

describe("压缩摘要注出处", () => {
  it("交给摘要模型的每条对话带 [#m编号]、要求在要点后注出处；摘要失败的兜底也带编号；原文压缩后照样能按编号读、能搜", async () => {
    const { rt, reg, fake, read } = setup();
    for (const q of ["车停在 B2 层 17 号", "明天十点开会", "提醒我买牛奶"]) { fake.queue.push("记下了"); await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: q }); }
    reg.update("main", { compaction: { ...reg.get("main")!.compaction, keep_messages: 2 } });
    fake.queue.push({ error: "摘要服务挂了" });
    expect(await rt.compact("main", "main:main")).toBe(true);
    const prompt = fake.calls.find((c) => c.purpose === "compact")!.message;
    expect(prompt).toMatch(/\[#m\d+\] 用户：.*B2 层 17 号/);
    const summary = rt.store("main").getSession("main:main")!.summary;
    const m = summary.match(/B2 层 17 号（#m(\d+)）/);
    expect(m).not.toBeNull();
    // 按出处读：那条原文 + 前后各两条，已经压缩了也在
    const around = text(await read({ ref: `#m${m![1]}` }));
    expect(around).toMatch(new RegExp(`→ \\[#m${m![1]} .*用户\\] .*B2 层 17 号`));
    expect(around).toContain("明天十点开会");
    // 一段
    expect(text(await read({ ref: `m${m![1]}-m${Number(m![1]) + 3}` })).split("\n").length).toBe(4);
    // 搜：已压缩的也找得到
    const hit = text(await read({ query: "B2 17" }));
    expect(hit).toContain("B2 层 17 号");
    expect(hit).toContain("（已压缩）");
    expect(text(await read({ query: "火星" }))).toContain("没找到");
  });

  it("系统提示里的摘要带 #m 出处时，提示她可以用 read_ref 读", () => {
    const { reg } = makeRuntime();
    const p = (tools: string[]) => buildSystemPrompt({ agent: reg.get("main")!, scene: "owner", channel: "webchat", summary: "- 车停在 B2（#m12）", tools });
    expect(p(["read_ref"])).toContain("#m数字 是原话出处");
    expect(p([])).not.toContain("#m数字 是原话出处");
  });
});

describe("统一编号", () => {
  it("session:<会话> 读最近几条（别的 agent 要有联系权限）；task: 等交给登记的解析函数；不认识的前缀说明认得哪些", async () => {
    const { rt, reg, fake, read } = setup();
    fake.queue.push("好的", "嗯");
    await rt.run({ agentId: "main", sessionKey: "main:webchat:a", kind: "chat", channel: "webchat", text: "我明天出差" });
    await rt.run({ agentId: "mio", sessionKey: "mio:main", kind: "main", channel: "webchat", text: "小澪你好" });
    expect(text(await read({ ref: "session:main:webchat:a" }))).toContain("我明天出差");
    reg.update("main", { a2a: { allow: [] } });
    expect((await read({ ref: "session:mio:main" })).isError).toBe(true);
    rt.refs.set("task", (agent, id) => (id === "t1" && agent.id === "main" ? "待办「整理照片」做完了" : null));
    expect(text(await read({ ref: "task:t1" }))).toContain("整理照片");
    expect((await read({ ref: "task:t2" })).isError).toBe(true);
    expect(text(await read({ ref: "foo:1" }))).toContain("task:");
  });

  it("主动说的话记进会话时带上来龙去脉的编号；陌生人没有 read_ref", async () => {
    const { rt, reg } = setup();
    await rt.note("main", "main:main", "待办汇报", "照片整理好了", "task:t1");
    const u = rt.store("main").history("main:main")[0].msg as any;
    expect(u.content[0].text).toContain("来龙去脉见 task:t1");
    expect(recallTools(rt, reg)(scopeOf({ trusted: false }), reg.get("main")!)).toEqual([]);
  });
});
