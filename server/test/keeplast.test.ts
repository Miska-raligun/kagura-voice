// heartbeat 会话只留最近几条：不能切在「工具调用」和「工具结果」之间；历史里万一有没配对的，发给模型前去掉
import { describe, it, expect } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { makeRuntime } from "./helpers.ts";
import { repairHistory } from "../src/agent/runtime.ts";
import { ok } from "../src/agent/tools/device.ts";

const u = (t: string): any => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 0 });
const a = (t: string, calls: string[] = []): any => ({ role: "assistant", content: [...(t ? [{ type: "text", text: t }] : []), ...calls.map((id) => ({ type: "toolCall", id, name: "x", arguments: {} }))], timestamp: 0 });
const r = (id: string): any => ({ role: "toolResult", toolCallId: id, toolName: "x", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 });

describe("keepLast", () => {
  it("只在用户消息处切：工具调用和结果不会被拆开；最近一轮太长就整轮留着", () => {
    const { rt } = makeRuntime();
    const st = rt.store("main");
    st.touchSession("main:heartbeat", "isolated", "system");
    // 第一轮 4 条（含一次工具），第二轮 4 条
    st.append("main:heartbeat", [u("hb1"), a("", ["c1"]), r("c1"), a("好")]);
    st.append("main:heartbeat", [u("hb2"), a("", ["c2"]), r("c2"), a("嗯")]);
    st.keepLast("main:heartbeat", 3);            // 按条数会切在 c2 的调用和结果之间
    const left = st.history("main:heartbeat").map((h) => h.msg as any);
    expect(left.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(left[0].content[0].text).toBe("hb2");
    st.keepLast("main:heartbeat", 6);            // 窗口够大：不动
    expect(st.history("main:heartbeat").length).toBe(4);
  });

  it("历史里没配对的工具调用 / 结果在发给模型前去掉（老库里已经坏掉的会话也能自己好）", () => {
    const fixed = repairHistory([r("gone"), a("好"), u("再来"), a("我查查", ["c9"]), u("算了"), a("好")] as any);
    expect(fixed.map((m: any) => m.role)).toEqual(["assistant", "user", "assistant", "user", "assistant"]);
    expect((fixed[2] as any).content).toEqual([{ type: "text", text: "我查查" }]);
  });

  it("heartbeat 会话被切过之后照常能跑（以前下一轮直接 400）", async () => {
    const { rt, fake } = makeRuntime();
    rt.addTools(() => [{ name: "look", label: "看", description: "看", parameters: Type.Object({}), execute: async () => ok("没事") } as any]);
    for (let i = 0; i < 4; i++) {
      fake.queue.push({ tool_calls: [{ name: "look" }], then: "HEARTBEAT_OK" });
      await rt.run({ agentId: "main", sessionKey: "main:heartbeat", kind: "isolated", channel: "system", purpose: "heartbeat", text: `[heartbeat] ${i}` });
      rt.store("main").keepLast("main:heartbeat", 10);
    }
    const msgs = rt.store("main").history("main:heartbeat").map((h) => h.msg as any);
    expect(msgs[0].role).toBe("user");
    const calls = new Set(msgs.flatMap((m) => (m.role === "assistant" ? m.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.id) : [])));
    expect(msgs.filter((m) => m.role === "toolResult").every((m) => calls.has(m.toolCallId))).toBe(true);
  });
});
