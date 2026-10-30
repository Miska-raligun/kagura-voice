// M6：agent 间通信（白名单、跳数、限频、死锁、子 agent 限制）与技能加载
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { A2A } from "../src/agent/a2a.ts";
import { Skills, parseFrontMatter } from "../src/agent/skills.ts";
import { Memories } from "../src/agent/tools/memory.ts";

function setup(cfg = { enabled: true, maxHops: 3, perPairPerMin: 10 }) {
  const env = makeRuntime();
  const a2a = new A2A(path.join(env.root, "system.sqlite"), env.rt, env.reg, cfg);
  env.rt.addTools(a2a.tools());
  env.rt.addTools(new Memories(env.rt, null).tools());
  const announced: any[] = [];
  a2a.announce = async (scope, text) => { announced.push({ agent: scope.agentId, dev: scope.deviceId, text }); };
  return { ...env, a2a, announced };
}
const chat = { kind: "main" as const, channel: "device", deviceId: "cores3", spokenTo: "cores3" };
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const t = Date.now();
  while (!cond()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

describe("sessions_send", () => {
  it("等对方回复：对方在这次交互的会话里收（不进它的 main），回复交回发起方；记进 a2a_log", async () => {
    const { rt, fake, a2a } = setup();
    fake.queue.push(
      { tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "明天天气怎么样？" } }], then: "小澪说明天晴" },
      "明天晴，25 度",                         // mio 的回复
    );
    const r = await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "问问小澪明天天气" });
    expect(r.text).toBe("小澪说明天晴");
    expect(fake.calls[1]).toMatchObject({ agent: "mio", purpose: "a2a" });
    expect(fake.calls[1].session).toMatch(/^mio:a2a:main:\w+$/);
    expect(fake.calls[1].message).toContain("来自 神乐");
    expect(rt.store("mio").history(fake.calls[1].session).length).toBe(2);
    expect(rt.store("mio").history("mio:main").length).toBe(0);
    const tr = rt.store("main").history("main:main").map((h) => h.msg as any).find((m) => m.role === "toolResult");
    expect(tr.content[0].text).toContain("明天晴，25 度");
    const [log] = a2a.log() as any[];
    expect(log).toMatchObject({ kind: "send", from_agent: "main", to_agent: "mio", status: "ok", hop: 1, reply: "明天晴，25 度" });
  });

  it("白名单：没权限就拒绝且对方完全没被调用", async () => {
    const { rt, reg, fake, a2a } = setup();
    reg.update("main", { a2a: { allow: [] } });
    fake.queue.push({ tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "hi" } }], then: "找不到她" });
    await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "x" });
    expect(fake.calls.length).toBe(1);
    expect((a2a.log() as any[])[0].status).toBe("rejected");
  });

  it("两个各自在跑的主会话同时互相 sessions_send：各进对方的 a2a 会话，不再互等，两边都拿到回复", async () => {
    const { rt, fake } = setup();
    // 以前两边都进对方的 main：A 拿着 main:main 等 mio:main，B 拿着 mio:main 等 main:main，只能拒掉一边
    fake.queue.push(
      { tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "在吗" } }], then: "A 结束" },
      { tool_calls: [{ name: "sessions_send", args: { agent: "main", message: "你在吗" } }], then: "B 结束" },
      "在", "在",
    );
    const a = rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "heartbeat A", kind: "main", channel: "heartbeat" });
    const b = rt.run({ ...chat, agentId: "mio", sessionKey: "mio:main", text: "heartbeat B", kind: "main", channel: "heartbeat" });
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.text, rb.text]).toEqual(["A 结束", "B 结束"]);
    const results = ["main", "mio"].flatMap((id) => rt.store(id).history(`${id}:main`).map((h) => h.msg as any).filter((m) => m.role === "toolResult").map((m) => m.content[0].text));
    expect(results.length).toBe(2);
    expect(results.some((t) => /互相等|正忙/.test(t))).toBe(false);
  }, 15_000);

  it("同一次交互里来回几次是同一个会话；下一次发起才开新会话", async () => {
    const { rt, fake } = setup();
    fake.queue.push(
      { tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "暗号是蓝莓" } }],
        then: { tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "刚才的暗号是什么" } }], then: "好" } },
      "收到", "蓝莓",
    );
    await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "x" });
    fake.queue.push({ tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "暗号是什么" } }], then: "好" }, "不知道");
    await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "y" });
    const mio = fake.calls.filter((c) => c.agent === "mio");
    expect(mio.length).toBe(3);
    expect(mio[1].session).toBe(mio[0].session);
    expect(rt.store("mio").history(mio[0].session).length).toBe(4);     // 第二问是接着第一问说的
    expect(mio[2].session).not.toBe(mio[0].session);
    expect(rt.store("mio").history(mio[2].session).length).toBe(2);
  });

  it("死锁防护：B 被 A 问的时候反过来等 A → 拒绝（提示直接回复）", async () => {
    const { rt, fake } = setup();
    fake.queue.push(
      { tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "在吗" } }], then: "她说在" },
      { tool_calls: [{ name: "sessions_send", args: { agent: "main", message: "你先说" } }], then: "在的" },
    );
    const r = await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "x" });
    expect(r.text).toBe("她说在");
    const tr = rt.store("mio").history(fake.calls.find((c) => c.agent === "mio").session).map((h) => h.msg as any).find((m) => m.role === "toolResult");
    expect(tr.isError).toBe(true);
    expect(tr.content[0].text).toContain("正在等你的回复");
  });

  it("跳数上限：A→B→C 超过 max_hops 拒绝", async () => {
    const { rt, reg, fake, a2a } = setup({ enabled: true, maxHops: 1, perPairPerMin: 10 });
    reg.create("c", { name: "丙" });
    reg.update("mio", { a2a: { allow: ["c", "main"] } });
    fake.queue.push(
      { tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "帮我问丙" } }], then: "问不到" },
      { tool_calls: [{ name: "sessions_send", args: { agent: "c", message: "?" } }], then: "转不过去" },
    );
    await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "x" });
    const logs = a2a.log() as any[];
    expect(logs.find((l) => l.to_agent === "c").status).toBe("rejected");
    expect(logs.find((l) => l.to_agent === "c").reply).toContain("跳");
  });

  it("同一对 agent 每分钟调用上限", async () => {
    const { rt, fake, a2a } = setup({ enabled: true, maxHops: 3, perPairPerMin: 2 });
    const calls = [1, 2, 3].map((i) => ({ name: "sessions_send", args: { agent: "mio", message: `hi${i}`, wait: false } }));
    fake.queue.push({ tool_calls: calls, then: "好" });
    await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "x" });
    await waitFor(() => (a2a.log() as any[]).filter((l) => l.status === "ok").length === 2);
    const st = (a2a.log() as any[]).map((l) => l.status).sort();
    expect(st).toEqual(["ok", "ok", "rejected"]);
  });

  it("全局开关关掉：sessions_* 工具整个不出现", async () => {
    const { rt, fake } = setup({ enabled: false, maxHops: 3, perPairPerMin: 10 });
    fake.queue.push({ tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "hi" } }], then: "" });
    await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "x" });
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].system).not.toContain("你可以联系的其他 agent");
  });
});

describe("sessions_spawn", () => {
  it("后台子任务：全新 sub 会话、不带 MEMORY；完成后结果投回发起方并转达到设备", async () => {
    const { rt, reg, fake, announced } = setup();
    fs.writeFileSync(path.join(reg.get("mio")!.workspace, "MEMORY.md"), "小澪的秘密日记");
    fake.queue.push(
      { tool_calls: [{ name: "sessions_spawn", args: { agent: "mio", task: "查一下周末电影" } }], then: "我让小澪去查了" },
      "周末有三部新片",                        // 子 agent
      "小澪查到周末有三部新片哦",               // 发起方收到结果后的转述
    );
    const r = await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "周末有什么电影" });
    expect(r.text).toBe("我让小澪去查了");
    await waitFor(() => announced.length === 1);
    expect(announced[0]).toEqual({ agent: "main", dev: "cores3", text: "小澪查到周末有三部新片哦" });
    const sub = fake.calls.find((c) => c.session.startsWith("mio:sub:"));
    expect(sub.system).not.toContain("秘密日记");
    expect(sub.system).not.toContain("<USER.md>");
    expect(fake.calls.at(-1).message).toContain("周末有三部新片");
    expect(fake.calls.at(-1).session).toBe("main:main");
  });

  it("子 agent 不能再 spawn / send、不能写记忆；wait=true 直接拿结果", async () => {
    const { rt, fake, reg } = setup();
    fake.queue.push(
      { tool_calls: [{ name: "sessions_spawn", args: { task: "算一下", wait: true } }], then: "算好了" },
      { tool_calls: [{ name: "sessions_spawn", args: { task: "再分" } }, { name: "memory_write", args: { target: "long", text: "x" } }], then: "42" },
    );
    const r = await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "x" });
    expect(r.text).toBe("算好了");
    const subKey = rt.store("main").listSessions().find((s) => s.key.startsWith("main:sub:"))!.key;
    const results = rt.store("main").history(subKey).map((h) => h.msg as any).filter((m) => m.role === "toolResult");
    expect(results.every((m: any) => m.isError)).toBe(true);
    expect(fs.readFileSync(path.join(reg.get("main")!.workspace, "MEMORY.md"), "utf8")).not.toContain("- x");
    const tr = rt.store("main").history("main:main").map((h) => h.msg as any).find((m) => m.role === "toolResult");
    expect(tr.content[0].text).toContain("42");
  });
});

describe("skills", () => {
  it("全局 + agent 技能（同名覆盖）、白名单、进系统提示、skill_read 读全文，不能越界", async () => {
    const { rt, reg, root, fake } = makeRuntime();
    const g = path.join(root, "skills");
    fs.mkdirSync(path.join(g, "weather"), { recursive: true });
    fs.writeFileSync(path.join(g, "weather", "SKILL.md"), "---\nname: weather\ndescription: \"查天气\"\n---\n用 wttr.in 查");
    fs.mkdirSync(path.join(g, "news"), { recursive: true });
    fs.writeFileSync(path.join(g, "news", "SKILL.md"), "---\nname: news\ndescription: 讲新闻\n---\n全局版");
    const ws = reg.get("main")!.workspace;
    fs.mkdirSync(path.join(ws, "skills", "news"), { recursive: true });
    fs.writeFileSync(path.join(ws, "skills", "news", "SKILL.md"), "---\nname: news\ndescription: 讲新闻（神乐版）\n---\n只讲科技");
    fs.writeFileSync(path.join(ws, "skills", "news", "sources.txt"), "36kr");
    const skills = new Skills(g);
    rt.skillCatalog = (a) => skills.catalog(a);
    rt.addTools(skills.tools());
    expect(skills.list(reg.get("main")!).map((s) => [s.name, s.scope])).toEqual([["news", "agent"], ["weather", "global"]]);
    expect(skills.list(reg.get("mio")!).find((s) => s.name === "news")!.description).toBe("讲新闻");
    reg.update("mio", { skills: ["weather"] });
    expect(skills.list(reg.get("mio")!).map((s) => s.name)).toEqual(["weather"]);
    fake.queue.push({ tool_calls: [{ name: "skill_read", args: { name: "news" } }, { name: "skill_read", args: { name: "news", file: "sources.txt" } }, { name: "skill_read", args: { name: "news", file: "../../agent.json" } }], then: "好" });
    await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "讲新闻" });
    expect(fake.calls[0].system).toContain("news：讲新闻（神乐版）");
    const trs = rt.store("main").history("main:main").map((h) => h.msg as any).filter((m) => m.role === "toolResult");
    expect(trs[0].content[0].text).toContain("只讲科技");
    expect(trs[1].content[0].text).toBe("36kr");
    expect(trs[2].isError).toBe(true);
  });

  it("front-matter 解析", () => {
    expect(parseFrontMatter("---\nname: a\ndescription: 'b c'\n---\nbody")).toEqual({ meta: { name: "a", description: "b c" }, body: "body" });
    expect(parseFrontMatter("no fm").meta).toEqual({});
  });
});

describe("a2a 会话", () => {
  it("一轮对话引出的调用归成一串：嵌套调用记下是由哪次调用引出的；另一轮是另一串", async () => {
    const { rt, fake, a2a } = setup();
    fake.queue.push(
      { tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "帮我查查天气" } }], then: "查好了" },
      { tool_calls: [{ name: "sessions_spawn", args: { task: "查天气", wait: true } }], then: "明天晴" },
      "晴，25 度",
    );
    await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "问问小澪天气" });
    fake.queue.push({ tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "谢谢" } }], then: "好" }, "不客气");
    await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "谢谢她" });
    const convs = a2a.conversations();
    expect(convs.length).toBe(2);
    expect(convs[1]).toMatchObject({ calls: 2, failed: 0, running: 0 });
    expect(convs[1].agents).toEqual(expect.arrayContaining(["main", "mio"]));
    const calls = a2a.conversation(convs[1].trace) as any[];
    expect(calls.map((c) => [c.kind, c.from_agent, c.to_agent])).toEqual([["send", "main", "mio"], ["spawn", "mio", "mio"]]);
    expect(calls[1].parent).toBe(calls[0].id);
    expect(calls[0].parent).toBeNull();
  });
});
