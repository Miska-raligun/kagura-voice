// 共享人设（USER / AGENTS / TOOLS 全家一份）与系统维护的用法守则
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { Memories } from "../src/agent/tools/memory.ts";
import { personaText, ownExtra, setSharedDir, SHARED_TEMPLATES } from "../src/agent/persona.ts";
import { buildSystemPrompt, toolGuide } from "../src/agent/soul.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kagura-shared-"));
afterEach(() => setSharedDir(""));

describe("共享人设", () => {
  it("她看到的 = 共享那份 + 自己补充的（和共享重复的行去掉；只剩模板 / 标题就算没有补充）", () => {
    const d = tmp();
    setSharedDir(d);
    expect(fs.readFileSync(path.join(d, "AGENTS.md"), "utf8")).toBe(SHARED_TEMPLATES["AGENTS.md"]);
    fs.writeFileSync(path.join(d, "USER.md"), "# 主人\n\n- 叫小明\n- 不吃香菜\n");
    const { reg } = makeRuntime();
    const ws = reg.get("main")!.workspace;
    fs.writeFileSync(path.join(ws, "USER.md"), "# 主人\n\n- 叫小明\n");
    expect(personaText(ws, "USER.md")).toBe("# 主人\n\n- 叫小明\n- 不吃香菜");
    fs.writeFileSync(path.join(ws, "USER.md"), "# 主人\n\n- 叫小明\n- 喜欢听神乐唱歌\n");
    const t = personaText(ws, "USER.md");
    expect(t).toContain("不吃香菜");
    expect(t).toContain("## 只对你的补充\n\n- 喜欢听神乐唱歌");
    expect(t.match(/叫小明/g)!.length).toBe(1);
    // SOUL 不共享
    fs.writeFileSync(path.join(ws, "SOUL.md"), "我是神乐");
    expect(personaText(ws, "SOUL.md")).toBe("我是神乐");
    // 系统提示里用的是合起来的
    const p = buildSystemPrompt({ agent: reg.get("main")!, scene: "owner", channel: "webchat" });
    expect(p).toContain("不吃香菜");
    expect(p).toContain("喜欢听神乐唱歌");
    expect(ownExtra("# 守则\n- a\n", "# 守则\n\n（你自己的规矩写在这里）\n- a\n")).toBe("");
  });

  it("记关于主人的事写进共享的 USER.md：谁记的全家都知道；memory_get 读到的是合起来的", async () => {
    const d = tmp();
    setSharedDir(d);
    const env = makeRuntime();
    const mem = new Memories(env.rt, null);
    env.rt.addTools(mem.tools());
    expect(mem.of("main").write("user", "女儿叫朵朵")).toBe("USER.md");
    expect(fs.readFileSync(path.join(d, "USER.md"), "utf8")).toContain("- 女儿叫朵朵");
    mem.of("main").write("user", "女儿叫朵朵");
    expect(fs.readFileSync(path.join(d, "USER.md"), "utf8").match(/朵朵/g)!.length).toBe(1);
    // 用 memory_get 读
    env.fake.queue.push({ tool_calls: [{ name: "memory_get", args: { path: "USER.md" } }], then: "好" });
    await env.rt.run({ kind: "main", channel: "webchat", agentId: "main", sessionKey: "main:main", text: "x", trusted: true });
    const tr = env.rt.store("main").history("main:main").map((h) => h.msg as any).find((m) => m.role === "toolResult");
    expect(tr.content[0].text).toContain("朵朵");
  });
});

describe("系统维护的用法守则", () => {
  it("只写这一轮手上有的工具", () => {
    const g = toolGuide(["task_add", "sessions_send"]);
    expect(g).toContain("task_add");
    expect(g).toContain("sessions_send");
    expect(g).not.toContain("take_photo");
    expect(toolGuide([])).toBe("");
  });

  it("每轮系统提示里带上，陌生人那边只有白名单里的工具对应的几条", async () => {
    const env = makeRuntime();
    env.rt.addTools(new Memories(env.rt, null).tools());
    env.fake.queue.push("好", "好");
    await env.rt.run({ kind: "main", channel: "webchat", agentId: "main", sessionKey: "main:main", text: "x", trusted: true });
    expect(env.fake.calls.at(-1).system).toContain("<how_to>");
    await env.rt.run({ kind: "chat", channel: "feishu", agentId: "main", sessionKey: "main:feishu:g", text: "x", trusted: false });
    expect(env.fake.calls.at(-1).system).not.toContain("memory_write");
  });
});
