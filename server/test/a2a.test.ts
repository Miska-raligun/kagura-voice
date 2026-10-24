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
  it("等对方回复：消息进对方 main 会话，回复交回发起方；记进 a2a_log", async () => {
    const { rt, fake, a2a } = setup();
    fake.queue.push(
      { tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "明天天气怎么样？" } }], then: "小澪说明天晴" },
      "明天晴，25 度",                         // mio 的回复
    );
    const r = await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "问问小澪明天天气" });
    expect(r.text).toBe("小澪说明天晴");
    expect(fake.calls[1]).toMatchObject({ agent: "mio", session: "mio:main", purpose: "a2a" });
    expect(fake.calls[1].message).toContain("来自 神乐");
    expect(rt.store("mio").history("mio:main").length).toBe(2);
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

  it("死锁防护：两个各自在跑的会话互相 sessions_send 等对方 → 后来的那个立刻失败，两边都能结束", async () => {
    const { rt, fake } = setup();
    // A：main:main（比如 heartbeat）问 mio；B：mio:main（比如它自己的 heartbeat）同时问 main。两条调用链互不知道对方
    fake.queue.push(
      { tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "在吗" } }], then: "A 结束" },
      { tool_calls: [{ name: "sessions_send", args: { agent: "main", message: "你在吗" } }], then: "B 结束" },
      "mio 回复：在",
    );
    const a = rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "heartbeat A", kind: "main", channel: "heartbeat" });
    const b = rt.run({ ...chat, agentId: "mio", sessionKey: "mio:main", text: "heartbeat B", kind: "main", channel: "heartbeat" });
    const t0 = Date.now();
    const [ra, rb] = await Promise.all([a, b]);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(ra.text).toBe("A 结束");
    expect(rb.text).toBe("B 结束");
    const tr = rt.store("mio").history("mio:main").map((h) => h.msg as any).find((m) => m.role === "toolResult");
    expect(tr.content[0].text).toMatch(/互相等/);
    expect(rt.busy("main", "main:main") || rt.busy("mio", "mio:main")).toBe(false);
  }, 15_000);

  it("对方会话一直被占着：sessions_send 等锁有上限，不会把自己也卡住", async () => {
    const { rt, fake } = setup();
    rt.lockWaitMs.a2a = 300;
    let release: () => void = () => {};
    const hold = (rt as any).serial("mio|mio:main", () => new Promise<void>((r) => (release = r)));   // 模拟 mio 在跑一个长任务
    fake.queue.push({ tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "在吗" } }], then: "她在忙" });
    const r = await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "x" });
    expect(r.text).toBe("她在忙");
    const tr = rt.store("main").history("main:main").map((h) => h.msg as any).find((m) => m.role === "toolResult");
    expect(tr.content[0].text).toMatch(/正忙/);
    release(); await hold;
    fake.queue.push("我在");
    expect((await rt.run({ ...chat, agentId: "mio", sessionKey: "mio:main", text: "y" })).text).toBe("我在");   // 排过队的位置没有插队、也没卡住
  }, 15_000);

  it("死锁防护：B 被 A 问的时候反过来等 A → 拒绝（提示直接回复）", async () => {
    const { rt, fake } = setup();
    fake.queue.push(
      { tool_calls: [{ name: "sessions_send", args: { agent: "mio", message: "在吗" } }], then: "她说在" },
      { tool_calls: [{ name: "sessions_send", args: { agent: "main", message: "你先说" } }], then: "在的" },
    );
    const r = await rt.run({ ...chat, agentId: "main", sessionKey: "main:main", text: "x" });
    expect(r.text).toBe("她说在");
    const tr = rt.store("mio").history("mio:main").map((h) => h.msg as any).find((m) => m.role === "toolResult");
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
    const calls = [1, 2, 3].map(() => ({ name: "sessions_send", args: { agent: "mio", message: "hi", wait: false } }));
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
