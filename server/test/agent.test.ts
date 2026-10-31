// M3：agent 运行时的系统层测试（假模型脚本驱动）
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { deviceTools } from "../src/agent/tools/device.ts";
import { Runtime } from "../src/agent/runtime.ts";
import { AgentRegistry } from "../src/agent/registry.ts";
import { Memories } from "../src/agent/tools/memory.ts";
import { buildSystemPrompt, clip, applyBudgets, BUDGETS, applyLoadout, LOADOUT, DEFAULT_LOADOUT, sceneOf } from "../src/agent/soul.ts";
import { PiBrain } from "../src/brain/pi.ts";
import { Type } from "@earendil-works/pi-ai";

function withDevice(rt: Runtime) {
  const pushed: any[] = [];
  const sched: any = { list: () => [], add: () => ({}), update: () => null, remove: () => false };
  rt.addTools(deviceTools({
    announce: async (text, agentId, dev) => { pushed.push({ text, dev, agentId }); return { played: true }; },
    captureAndWait: async () => [null, "离线"],
    presence: () => "在家",
    setPresence: () => {},
    schedules: sched,
    defaultDevice: () => "cores3",
  }));
  return pushed;
}

const dev = { kind: "main" as const, channel: "device", deviceId: "cores3", spokenTo: "cores3" };

describe("内置工具", () => {
  it("take_photo 在设备对话里：本轮立即结束 + needPhoto，下一条带图", async () => {
    const { rt, fake } = makeRuntime();
    withDevice(rt);
    const brain = new PiBrain(rt);
    fake.queue.push({ text: "我看看", tool_calls: [{ name: "take_photo", args: { question: "这是什么" } }] }, "是一只猫");
    const meta: any = {};
    const r = await brain.chat({ message: "这是什么", sessionId: "x", agent: "main", deviceId: "cores3", spoken: true, meta });
    expect(r).toBe("我看看");
    expect(meta.needPhoto).toBe(true);
    expect(fake.calls.length).toBe(1);   // terminate：工具之后不再调模型
    const img = path.join(fs.mkdtempSync("/tmp/kimg-"), "a.jpg");
    fs.writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    const r2 = await brain.chat({ message: "这是什么", sessionId: "x", agent: "main", deviceId: "cores3", spoken: true, imagePath: img });
    expect(r2).toBe("是一只猫");
    expect(fake.calls[1].image).toBe(true);
    // 历史里图片换成文字引用、图片存进工作目录 uploads/，不把 base64 存进库
    const raw = rt.store("main").db.prepare("SELECT data FROM messages").all().map((x: any) => x.data).join("");
    const ref = /\[图片 (uploads\/[^\]]+)\]/.exec(raw);
    expect(ref).toBeTruthy();
    expect(fs.readFileSync(path.join(rt.agents.get("main")!.workspace, ref![1]))).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    expect(raw).not.toContain("/9j/");
  });

  it("消息已经带着照片：这一轮没有 take_photo，模型直接看图回答，不会再让设备拍一次", async () => {
    const { rt, fake } = makeRuntime();
    withDevice(rt);
    const brain = new PiBrain(rt);
    const img = path.join(fs.mkdtempSync("/tmp/kimg-"), "a.jpg");
    fs.writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    // 模型还是想调 take_photo：工具不存在，它拿到报错后照常作答
    fake.queue.push({ tool_calls: [{ name: "take_photo", args: { question: "这是什么" } }], then: "是一只猫" });
    const meta: any = {};
    const r = await brain.chat({ message: "这是什么", sessionId: "x", agent: "main", deviceId: "cores3", spoken: true, imagePath: img, meta });
    expect(meta.needPhoto).toBeUndefined();
    expect(r).toBe("是一只猫");
    expect(fake.calls[0].image).toBe(true);
    // 没带照片的普通一轮，take_photo 还在
    fake.queue.push({ text: "我看看", tool_calls: [{ name: "take_photo", args: { question: "这是什么" } }] });
    const meta2: any = {};
    await brain.chat({ message: "这是什么", sessionId: "y", agent: "main", deviceId: "cores3", spoken: true, meta: meta2 });
    expect(meta2.needPhoto).toBe(true);
  });

  it("set_volume → meta.volume；没有 speak 工具（说不说出声由系统决定）", async () => {
    const { rt, fake } = makeRuntime();
    withDevice(rt);
    fake.queue.push({ tool_calls: [{ name: "set_volume", args: { direction: "up" } }, { name: "speak", args: { text: "嗨" } }], then: "调大了" });
    const r = await rt.run({ ...dev, agentId: "mio", sessionKey: "mio:main", text: "大声点" });
    expect(r.text).toBe("调大了");
    expect(r.meta.volume).toBe("up");
    const tr = rt.store("mio").history("mio:main").map((h) => h.msg).filter((m) => m.role === "toolResult") as any[];
    expect(tr.find((m) => m.toolName === "speak")?.isError).toBe(true);
  });

  it("工具白名单：agent.tools 之外的工具模型看不到也调不了", async () => {
    const { rt, reg, fake } = makeRuntime();
    withDevice(rt);
    reg.update("main", { tools: ["get_presence"] });
    fake.queue.push({ tool_calls: [{ name: "set_volume", args: { direction: "up" } }], then: "好" });
    const r = await rt.run({ ...dev, agentId: "main", sessionKey: "main:main", text: "说话" });
    const tr = rt.store("main").history("main:main").map((h) => h.msg).find((m) => m.role === "toolResult") as any;
    expect(tr.isError).toBe(true);
    expect(r.text).toBe("好");
  });
});

describe("超时：按「没有进展」算，不按总时长", () => {
  const slowTool = (ms: number) => () => [{
    name: "slow", label: "慢", description: "慢工具", parameters: Type.Object({}),
    async execute() { await new Promise((r) => setTimeout(r, ms)); return { content: [{ type: "text" as const, text: "ok" }], details: {} }; },
  }] as any;

  it("工具在执行就不算卡住：连续几个慢工具累计超过无进展超时也能跑完", async () => {
    const { rt, fake } = makeRuntime();
    rt.setLimits({ timeoutSecs: 0.4, maxSecs: 10 });
    rt.addTools(slowTool(300));
    fake.queue.push({ tool_calls: [{ name: "slow" }, { name: "slow" }, { name: "slow" }], then: "做完了" });
    const r = await rt.run({ ...dev, agentId: "main", sessionKey: "main:main", text: "干活" });
    expect(r.text).toBe("做完了");
  });

  it("模型很久不出字 → 无进展超时；工具一直不返回 → 总时长上限", async () => {
    const { rt, fake } = makeRuntime();
    rt.setLimits({ timeoutSecs: 0.3, maxSecs: 60 });
    fake.queue.push({ text: "慢慢说", tps: 1 });
    await expect(rt.run({ ...dev, agentId: "main", sessionKey: "main:a", text: "说" })).rejects.toThrow(/没有任何进展/);
    rt.setLimits({ timeoutSecs: 0.3, maxSecs: 0.8 });
    rt.addTools(slowTool(5000));
    fake.queue.push({ tool_calls: [{ name: "slow" }], then: "x" });
    await expect(rt.run({ ...dev, agentId: "main", sessionKey: "main:b", text: "卡住" })).rejects.toThrow(/总时长上限/);
  });
});

describe("顺带朗读的语音版本", () => {
  it("短回复去掉格式直接念，不调模型；长回复用便宜模型压到 agent 的语音字数", async () => {
    const { rt, reg, fake } = makeRuntime();
    reg.update("main", { voice_max_chars: 20 });
    expect(await rt.spoken("main", "**好的**，明天晴")).toBe("好的，明天晴");
    expect(fake.calls.length).toBe(0);
    fake.queue.push("明天晴，二十五度，适合出门。");
    const long = "## 天气\n" + "- 明天晴，最高二十五度，最低十五度，东南风二级\n".repeat(5);
    expect(await rt.spoken("main", long)).toBe("明天晴，二十五度，适合出门");
    expect(fake.calls.at(-1)!.purpose).toBe("voice");
    expect(fake.calls.at(-1)!.system).toContain("不超过 20 字");
  });

  it("模型失败时退回截断", async () => {
    const { rt, reg, fake } = makeRuntime();
    reg.update("main", { voice_max_chars: 10 });
    fake.queue.push({ error: "boom" } as any);
    const out = await rt.spoken("main", "第一句话很长很长很长。第二句话也很长很长。第三句。");
    expect(Array.from(out).length).toBeLessThan(30);
    expect(out.endsWith("详细的我发在消息里了。")).toBe(true);
  });
});

describe("会话与压缩", () => {
  it("重启后从 agent.sqlite 恢复上下文", async () => {
    const { root, rt, models, fake } = makeRuntime();
    fake.queue.push("记住了");
    await rt.run({ ...dev, agentId: "main", sessionKey: "main:main", text: "我叫小明" });
    rt.close();
    const reg2 = new AgentRegistry(path.join(root, "agents"));
    reg2.load(null);
    const rt2 = new Runtime(reg2, models, { maxConcurrency: 2, timeoutSecs: 5 });
    expect(rt2.store("main").history("main:main").length).toBe(2);
  });

  it("超过阈值：先冲刷、再用便宜模型总结较早部分，保留最近几条", async () => {
    const { rt, reg, fake } = makeRuntime();
    reg.update("main", { compaction: { max_tokens: 30, keep_messages: 2 } });
    let flushed = 0;
    rt.beforeCompact = async () => { flushed++; };
    const key = "main:main";
    for (let i = 0; i < 4; i++) { fake.queue.push(`回复${i}，`.repeat(5)); await rt.run({ ...dev, agentId: "main", sessionKey: key, text: `第${i}句话`.repeat(3) }); }
    // 第 4 轮开始前历史已超阈值；摘要那次调用排在第 4 轮之前
    expect(flushed).toBeGreaterThan(0);
    const s = rt.store("main").getSession(key)!;
    expect(s.summary).toBeTruthy();
    expect(rt.store("main").history(key).length).toBeLessThan(8);
    expect(fake.calls.some((c) => c.purpose === "compact")).toBe(true);
    // 摘要进下一轮的系统提示
    fake.queue.push("嗯");
    await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "继续" });
    expect(fake.calls.at(-1).system).toContain("earlier_conversation_summary");
  });

  it("压缩时摘要模型卡住：有时限，这轮照常回复，会话不会被永远锁住", async () => {
    const { rt, reg, fake } = makeRuntime();
    rt.setLimits({ timeoutSecs: 1 });                        // 压缩上限 = 2 × timeoutSecs
    reg.update("main", { compaction: { max_tokens: 30, keep_messages: 2 } });
    const key = "main:main";
    for (let i = 0; i < 3; i++) { fake.queue.push(`回复${i}，`.repeat(5)); await rt.run({ ...dev, agentId: "main", sessionKey: key, text: `第${i}句话`.repeat(3) }); }
    fake.queue.push({ text: "摘要", tps: 0.001 }, "这轮照常回复");   // 摘要那次：1000 秒才吐一个字，也不理中止
    const t0 = Date.now();
    const r = await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "还在吗" });
    expect(r.text).toBe("这轮照常回复");
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(rt.busy("main", key)).toBe(false);
    fake.queue.push("摘要", "下一轮也正常");                    // 上次没压成，这轮再压一次（这回正常）
    expect((await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "嗯" })).text).toBe("下一轮也正常");
  }, 20_000);

  it("压缩中途取消：立刻结束、放开会话锁", async () => {
    const { rt, reg, fake } = makeRuntime();
    reg.update("main", { compaction: { max_tokens: 30, keep_messages: 2 } });
    const key = "main:main";
    for (let i = 0; i < 3; i++) { fake.queue.push(`回复${i}，`.repeat(5)); await rt.run({ ...dev, agentId: "main", sessionKey: key, text: `第${i}句话`.repeat(3) }); }
    fake.queue.push({ text: "摘要", tps: 0.001 });
    const ac = new AbortController();
    const p = rt.run({ ...dev, agentId: "main", sessionKey: key, text: "还在吗", signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toThrow("已取消");
    fake.queue.push("摘要", "好的");
    expect((await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "嗯" })).text).toBe("好的");
  }, 20_000);

  it("历史很长：分块滚动摘要（每块带上一版摘要）；某块摘要为空就记要点照样压掉，不再每轮重试", async () => {
    const { rt, reg, fake } = makeRuntime();
    reg.update("main", { compaction: { max_tokens: 1_000_000, keep_messages: 2 } });
    const key = "main:main";
    const long = (i: number) => `第${i}件事：` + "很长的细节".repeat(600);    // 每条约 3000 字
    for (let i = 0; i < 6; i++) { fake.queue.push("记下了"); await rt.run({ ...dev, agentId: "main", sessionKey: key, text: long(i) }); }
    reg.update("main", { compaction: { max_tokens: 10_000, keep_messages: 2 } });
    // 约 1.8 万字 → 超过阈值；要压的 5 轮每条截到 1500 字，约 7500 字 → 按 5000 一块分成两块
    (rt as any).compactChunk = 5000;                                     // 单测里把块调小
    fake.queue.push("摘要一：前几件事", "", "", "这轮照常");           // 第二块模型两次都给了空正文（第一次空的会再要一次）
    const r = await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "还记得吗" });
    expect(r.text).toBe("这轮照常");
    const compacts = fake.calls.filter((c) => c.purpose === "compact");
    expect(compacts.length).toBe(3);
    expect(compacts[1].message).toContain("此前的摘要：\n摘要一：前几件事");
    expect(compacts[2].message).toContain("务必先写【摘要】");
    expect(compacts[1].message).toContain("（第 2/2 段）");
    const s = rt.store("main").getSession(key)!;
    expect(s.summary).toContain("摘要一：前几件事");
    expect(s.summary).toContain("没能总结");
    expect(s.summary).toMatch(/- 第\d件事/);
    expect(rt.store("main").history(key).length).toBeLessThanOrEqual(4);
    fake.queue.push("好");
    await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "嗯" });
    expect(fake.calls.filter((c) => c.purpose === "compact").length).toBe(3);   // 已经压下去了，不再重试
  }, 20_000);

  it("管理界面看得到正在跑的轮次和排队数，能手动终止，排着的消息接着处理", async () => {
    const { rt, fake } = makeRuntime();
    rt.addTools(() => [{
      name: "slow_script", label: "慢脚本", description: "x", parameters: Type.Object({}),
      execute: () => new Promise(() => {}),              // 永远不结束、也不理中止
    } as any]);
    const key = "main:main";
    fake.queue.push({ tool_calls: [{ name: "slow_script", args: {} }] });
    const stuck = rt.run({ ...dev, agentId: "main", sessionKey: key, text: "跑脚本", purpose: "heartbeat", channel: "system" } as any);
    stuck.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    fake.queue.push("在的");
    const next = rt.run({ ...dev, agentId: "main", sessionKey: key, text: "在吗" });
    await new Promise((r) => setTimeout(r, 50));
    const [run] = rt.activeRuns();
    expect(run).toMatchObject({ key: "main|main:main", agent: "main", session: key, purpose: "heartbeat", stage: "执行工具", tool: "slow_script", queued: 1 });
    expect(rt.cancelRun(run.key)).toBe(true);
    await expect(stuck).rejects.toThrow("已在管理界面终止");
    expect((await next).text).toBe("在的");
    expect(rt.activeRuns()).toEqual([]);
    expect(rt.cancelRun(run.key)).toBe(false);
  }, 15_000);

  it("同一会话串行：两条并发消息按到达顺序执行，历史不交错", async () => {
    const { rt, fake } = makeRuntime();
    fake.queue.push("一", "二");
    await Promise.all([
      rt.run({ ...dev, agentId: "main", sessionKey: "k", text: "A" }),
      rt.run({ ...dev, agentId: "main", sessionKey: "k", text: "B" }),
    ]);
    const roles = rt.store("main").history("k").map((h) => (h.msg as any).role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("设备会话默认并入 main；关掉后按设备分开", () => {
    const { rt, reg } = makeRuntime();
    expect(rt.sessionKey("main", "device", "cores3")).toBe("main:main");
    reg.update("main", { device_in_main: false });
    expect(rt.sessionKey("main", "device", "cores3")).toBe("main:device:cores3");
    expect(rt.sessionKey("main", "webchat", "owner")).toBe("main:webchat:owner");
  });
});

describe("soul 组装", () => {
  it("按会话种类注入：子 agent 不给 USER / MEMORY；超预算截断；今天的笔记带上", () => {
    const { reg } = makeRuntime();
    const a = reg.get("main")!;
    fs.writeFileSync(path.join(a.workspace, "MEMORY.md"), "主人喜欢乌龙茶");
    fs.writeFileSync(path.join(a.workspace, "SOUL.md"), "灵".repeat(25000));
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    fs.writeFileSync(path.join(a.workspace, "memory", `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`), "今天去了公园");
    const main = buildSystemPrompt({ agent: a, scene: "owner", channel: "device" });
    expect(main).not.toContain("乌龙茶");                        // 长期记忆改成每轮自动检索，不整篇放
    expect(main).toContain("<memory>");
    expect(main).toContain("今天去了公园");
    expect(main).toContain("已截断");
    expect(main).toContain("不超过 80 字");
    // 5000 字在默认上限内不截断；配置调小之后才截
    fs.writeFileSync(path.join(a.workspace, "SOUL.md"), "灵".repeat(5000));
    expect(buildSystemPrompt({ agent: a, scene: "owner", channel: "device" })).not.toContain("已截断");
    applyBudgets({ "SOUL.md": 1000, bogus: 5 });
    expect(BUDGETS["SOUL.md"]).toBe(1000);
    expect("bogus" in BUDGETS).toBe(false);
    expect(buildSystemPrompt({ agent: a, scene: "owner", channel: "device" })).toContain("已截断");
    applyBudgets({});
    expect(BUDGETS["SOUL.md"]).toBe(20000);
    const sub = buildSystemPrompt({ agent: a, scene: "sub", channel: "a2a" });
    expect(sub).not.toContain("乌龙茶");
    expect(sub).not.toContain("<USER.md>");
    expect(sub).not.toContain("今天去了公园");
  });

  it("按场景加载人设文件：陌生人拿不到主人的私人信息，干活的场景不背整篇性格和记忆", () => {
    const { reg } = makeRuntime();
    const a = reg.get("main")!;
    fs.writeFileSync(path.join(a.workspace, "SOUL.md"), "性格温柔");
    fs.writeFileSync(path.join(a.workspace, "USER.md"), "主人叫小明");
    fs.writeFileSync(path.join(a.workspace, "MEMORY.md"), "主人喜欢乌龙茶");
    fs.writeFileSync(path.join(a.workspace, "HEARTBEAT.md"), "检查天气");
    fs.writeFileSync(path.join(a.workspace, "TOOLS.md"), "# 工具备忘\n\n## 家里的设备\nNAS 地址 10.0.0.5\n\n## 账号\n快递用手机号\n");
    fs.writeFileSync(path.join(a.workspace, "memory", `${new Date().toISOString().slice(0, 10)}.md`), "今天去了公园");
    const p = (scene: any) => buildSystemPrompt({ agent: a, scene, channel: "feishu" });
    const owner = p("owner");
    expect(owner).toContain("小明"); expect(owner).not.toContain("乌龙茶"); expect(owner).not.toContain("检查天气");
    expect(owner).not.toContain("<not_loaded>");
    // TOOLS.md 只放目录：标题和行号在，正文不在
    expect(owner).toContain('<TOOLS.md only="目录">');
    expect(owner).toContain("家里的设备（第 3 行）");
    expect(owner).not.toContain("10.0.0.5");
    expect(p("heartbeat")).toContain("乌龙茶");
    const guest = p("guest");
    for (const x of ["小明", "乌龙茶", "公园", "<not_loaded>", "<TOOLS.md>"]) expect(guest).not.toContain(x);
    expect(guest).toContain("性格温柔");
    expect(p("heartbeat")).toContain("检查天气");
    const task = p("task");
    expect(task).not.toContain("性格温柔"); expect(task).not.toContain("乌龙茶"); expect(task).toContain("小明");
    expect(task).toMatch(/<not_loaded>[\s\S]*SOUL\.md[\s\S]*每日笔记/);
    expect(task).toContain("10.0.0.5");
    // 配置能改，但群聊陌生人永远拿不到私人文件
    applyLoadout({ guest: ["SOUL.md", "USER.md", "MEMORY.md", "daily"], task: ["MEMORY.md"], bogus: ["x"] });
    expect(p("guest")).not.toContain("小明");
    expect(p("task")).toContain("乌龙茶");
    expect(LOADOUT.guest).toEqual(["SOUL.md"]);
    applyLoadout({});
    expect(LOADOUT.task).toEqual(DEFAULT_LOADOUT.task);
    // 目录模式能配；旧版整表保存过的默认（含 MEMORY 全文）当成没改过，跟新默认走
    applyLoadout({ owner: ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "daily"], task: ["AGENTS.md:toc", "TOOLS.md", "daily:toc", "SOUL.md"] });
    expect(LOADOUT.owner).toEqual(DEFAULT_LOADOUT.owner);
    expect(LOADOUT.task).toEqual(["SOUL.md", "AGENTS.md:toc", "TOOLS.md"]);
    applyLoadout({});
    // 场景判定：不可信的一律 guest
    const sc = (x: any) => sceneOf({ trusted: true, purpose: "chat", kind: "main", channel: "device", ...x });
    expect([sc({}), sc({ trusted: false, purpose: "cron" }), sc({ purpose: "heartbeat" }), sc({ purpose: "task" }), sc({ purpose: "cron" }), sc({ kind: "sub" }), sc({ channel: "a2a" })])
      .toEqual(["owner", "guest", "heartbeat", "task", "cron", "sub", "a2a"]);
  });

  it("记忆工具只给可信会话；memory_get 能读没加载的人设文件", async () => {
    const { rt, reg } = makeRuntime();
    const mem = new Memories(rt, null);
    const a = reg.get("main")!;
    fs.writeFileSync(path.join(a.workspace, "USER.md"), "主人叫小明");
    const scope = (trusted: boolean): any => ({ agentId: "main", sessionKey: "main:main", kind: "chat", channel: "feishu", purpose: "chat", hop: 0, chain: [], meta: {}, trusted });
    expect(mem.tools()(scope(false), a)).toHaveLength(0);
    const get = mem.tools()(scope(true), a).find((t) => t.name === "memory_get")!;
    const r: any = await get.execute("1", { path: "USER.md" }, undefined as any);
    expect(r.content[0].text).toContain("小明");
    const bad: any = await get.execute("2", { path: "../agent.json" }, undefined as any);
    expect(JSON.stringify(bad)).toMatch(/只能读/);
  });

  it("clip 按字截断", () => {
    expect(clip("一二三四五", 3).startsWith("一二三\n…")).toBe(true);
    expect(clip("一二", 3)).toBe("一二");
  });
});

describe("注册表", () => {
  it("首次启动按角色表建 agent，device_role 对应图片目录，默认互相可通信", () => {
    const { reg } = makeRuntime();
    expect(reg.list().map((a) => a.id)).toEqual(["main", "mio"]);
    expect(reg.roleDefs()).toEqual([
      { id: "", name: "神乐", agent: "main", per: 111, tts_provider: "", tts_voice: "", aliases: [] },
      { id: "mio", name: "小澪", agent: "mio", per: 4, tts_provider: "", tts_voice: "", aliases: [] },
    ]);
    expect(reg.canContact("main", "mio")).toBe(true);
    expect(reg.canContact("mio", "main")).toBe(true);
    expect(reg.canContact("main", "main")).toBe(false);
    reg.update("mio", { a2a: { allow: [] } });
    expect(reg.canContact("mio", "main")).toBe(false);
  });

  it("新建/删除 agent；非法 id 拒绝；删除进回收站", () => {
    const { reg, root } = makeRuntime();
    expect(() => reg.create("../x")).toThrow();
    const a = reg.create("helper", { name: "助手" });
    expect(fs.existsSync(path.join(a.workspace, "SOUL.md"))).toBe(true);
    expect(reg.remove("helper")).toBe(true);
    expect(reg.get("helper")).toBeUndefined();
    expect(fs.readdirSync(path.join(root, "agents", ".trash")).length).toBe(1);
  });
});

describe("内部小任务关思考", () => {
  it("按地址认出怎么关；去掉正文里的 <think>；服务商不认就去掉重试、之后不再发", async () => {
    const { autoNoThinking, stripThinkText, ModelRegistry } = await import("../src/agent/models.ts");
    expect(autoNoThinking("https://api.minimaxi.com/v1")).toEqual({ thinking: { type: "disabled" } });
    expect(autoNoThinking("https://api.deepseek.com/v1")).toEqual({ thinking: { type: "disabled" } });
    expect(autoNoThinking("https://open.bigmodel.cn/api/paas/v4")).toEqual({ thinking: { type: "disabled" } });
    expect(autoNoThinking("https://dashscope.aliyuncs.com/compatible-mode/v1")).toEqual({ enable_thinking: false });
    expect(autoNoThinking("https://api.openai.com/v1", "openai", "gpt-x")).toEqual({ reasoning_effort: "minimal" });
    expect(autoNoThinking("https://example.com/v1")).toBeUndefined();
    expect(stripThinkText("<think>想了很久</think>摘要正文")).toBe("摘要正文");
    expect(stripThinkText("<think>想到一半被截断")).toBe("");

    const reg = new ModelRegistry({ providers: [{ id: "mm", api: "openai-completions", base_url: "https://api.minimaxi.com/v1", models: [{ id: "MiniMax-M3" }] }], default: "mm/MiniMax-M3", cheap: "" } as any);
    const m = reg.resolve("mm/MiniMax-M3");
    expect(m.maxTokens).toBe(8192);
    const seen: any[] = [];
    let reject = true;
    (reg.models as any).completeSimple = async (_m: any, _c: any, o: any) => {
      seen.push(o.samplingParams);
      if (o.samplingParams && reject) return { stopReason: "error", errorMessage: "400 unrecognized field: thinking", content: [] };
      return { stopReason: "stop", content: [{ type: "text", text: "<think>嗯</think>好的" }] };
    };
    const r = await reg.quick(m, { messages: [] } as any);
    expect((r.content[0] as any).text).toBe("好的");
    expect(seen).toEqual([{ thinking: { type: "disabled" } }, undefined]);      // 被拒 → 去掉重试
    await reg.quick(m, { messages: [] } as any);
    expect(seen.at(-1)).toBeUndefined();                                         // 之后不再发
    // 手动指定：false = 不发
    const reg2 = new ModelRegistry({ providers: [{ id: "ds", api: "openai-completions", base_url: "https://api.deepseek.com", no_thinking: false, models: [{ id: "v4" }] }], default: "ds/v4", cheap: "" } as any);
    expect(reg2.noThinkingParams(reg2.resolve("ds/v4"))).toBeUndefined();
  });
});

describe("关思考字段真的进了请求体", () => {
  it("OpenAI 兼容接口：请求里带 thinking: {type: disabled}，max_tokens 按给的", async () => {
    const http = await import("node:http");
    const { ModelRegistry } = await import("../src/agent/models.ts");
    let body: any = null;
    const srv = http.createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
        body = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (o: any) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "MiniMax-M3", ...o })}\n\n`);
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "摘要" }, finish_reason: null }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;
    try {
      const reg = new ModelRegistry({ providers: [{ id: "minimax", api: "openai-completions", base_url: `http://127.0.0.1:${port}/v1`, api_key: "k", models: [{ id: "MiniMax-M3" }] }], default: "minimax/MiniMax-M3", cheap: "" } as any);
      const r = await reg.quick(reg.resolve("minimax/MiniMax-M3"), { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as any, { maxTokens: 8192 });
      expect(r.errorMessage ?? "").toBe("");
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body.max_tokens ?? body.max_completion_tokens).toBe(8192);
    } finally { srv.close(); }
  });
});

describe("模型的思考等级", () => {
  it("各服务商的写法；回复上限之外按等级加思考预留", async () => {
    const http = await import("node:http");
    const { ModelRegistry, thinkingParams } = await import("../src/agent/models.ts");
    expect(thinkingParams("https://api.minimaxi.com/v1", "high")).toEqual({ thinking: { type: "enabled" } });
    expect(thinkingParams("https://api.deepseek.com", "low")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" });
    expect(thinkingParams("https://open.bigmodel.cn/api/paas/v4", "off")).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingParams("https://dashscope.aliyuncs.com/compatible-mode/v1", "medium")).toEqual({ enable_thinking: true, thinking_budget: 6144 });
    expect(thinkingParams("https://example.com/v1", "off")).toBeUndefined();              // 认不出怎么关：不乱发
    expect(thinkingParams("https://example.com/v1", "high")).toEqual({ reasoning_effort: "high" });
    expect(thinkingParams("https://api.minimaxi.com/v1", "")).toBeUndefined();              // 默认：什么都不发

    const bodies: any[] = [];
    const srv = http.createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (o: any) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`);
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "好" }, finish_reason: null }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;
    try {
      const reg = new ModelRegistry({ providers: [{ id: "minimax", api: "openai-completions", base_url: `http://127.0.0.1:${port}/v1`, api_key: "k",
        models: [{ id: "M3", thinking: "high", max_tokens: 4000 }, { id: "flash", thinking: "off" }, { id: "plain" }] }], default: "minimax/M3", cheap: "" } as any);
      const ctx = { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
      for (const id of ["M3", "flash", "plain"]) { const s = reg.chatStream(reg.resolve(`minimax/${id}`), ctx); for await (const _ of s as any) { /* 读完 */ } }
      const mt = (b: any) => b.max_tokens ?? b.max_completion_tokens;
      expect(bodies[0].thinking).toEqual({ type: "enabled" });
      expect(mt(bodies[0])).toBe(4000 + 16384);             // 回复 4000 + 高档思考预留
      expect(bodies[1].thinking).toEqual({ type: "disabled" });
      expect(mt(bodies[1])).toBe(8192);                      // 关思考：不加预留
      expect(bodies[2].thinking).toBeUndefined();            // 默认：不发，服务商自己决定
      expect(mt(bodies[2])).toBe(8192 + 4096);
    } finally { srv.close(); }
  });
});

describe("近况（跨会话 / 跨 agent）", () => {
  it("heartbeat 看得到主人在飞书说过的话；别的 agent 也看得到；陌生人的对话不混进来、陌生人也看不到近况", async () => {
    const { rt, fake } = makeRuntime();
    const im = { kind: "chat" as const, channel: "feishu" };
    fake.queue.push("好的，周六去爬山记下了");
    await rt.run({ ...im, agentId: "main", sessionKey: "main:feishu:oc_owner", text: "我周六要去爬山", trusted: true });
    fake.queue.push("你好呀");
    await rt.run({ ...im, agentId: "main", sessionKey: "main:feishu:oc_stranger", text: "我是路人甲，密码是 123", trusted: false });

    // 神乐的 heartbeat（主会话）
    fake.queue.push("HEARTBEAT_OK");
    await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "system", purpose: "heartbeat", text: "[heartbeat] 检查", trusted: true });
    const hb = fake.calls.at(-1).system as string;
    expect(hb).toContain("<recent_activity>");
    expect(hb).toMatch(/\[飞书\] 主人：我周六要去爬山/);
    expect(hb).toMatch(/\[飞书\] 你：好的，周六去爬山记下了/);
    expect(hb).not.toContain("路人甲");

    // 小澪也知道
    fake.queue.push("嗯");
    await rt.run({ agentId: "mio", sessionKey: "mio:main", kind: "main", channel: "device", deviceId: "cores3", text: "在吗", trusted: true });
    expect(fake.calls.at(-1).system).toMatch(/\[神乐·飞书\] 主人：我周六要去爬山/);

    // 陌生人那边看不到主人的近况
    fake.queue.push("嗯");
    await rt.run({ ...im, agentId: "main", sessionKey: "main:feishu:oc_stranger", text: "他最近干嘛", trusted: false });
    expect(fake.calls.at(-1).system).not.toContain("<recent_activity>");

    // 当前会话自己的历史不重复放进近况
    fake.queue.push("嗯");
    await rt.run({ ...im, agentId: "main", sessionKey: "main:feishu:oc_owner", text: "对了", trusted: true });
    expect(fake.calls.at(-1).system).not.toMatch(/\[飞书\] 主人：我周六要去爬山/);
  });
});

describe("摘要输出不认顺序 / 空回复重试", () => {
  it("【记住】写在最前也拆得开：正文照样是摘要；只有【记住】就拿记住的当摘要", async () => {
    const { parseCompactOutput } = await import("../src/agent/runtime.ts");
    expect(parseCompactOutput("【摘要】\n- 主人在改代码\n【记住】\n长期：项目在 D 盘")).toEqual({ summary: "- 主人在改代码", remembered: ["长期\n项目在 D 盘"] });
    expect(parseCompactOutput("【记住】\n长期：项目在 D 盘\n【摘要】\n- 主人在改代码")).toEqual({ summary: "- 主人在改代码", remembered: ["长期\n项目在 D 盘"] });
    expect(parseCompactOutput("【记住】\n- 长期：每次改完要跑测试\n- 主人在改设备代码，约定先备份")).toEqual({ summary: "- 主人在改设备代码，约定先备份", remembered: ["长期\n每次改完要跑测试"] });
    expect(parseCompactOutput("【记住】\n无").summary).toBe("");
    expect(parseCompactOutput("- 只有正文").summary).toBe("- 只有正文");
  });

  it("压缩时模型只写了【记住】：拿记住的几条当摘要，不再退成十几句用户原话", async () => {
    const { rt, reg, fake } = makeRuntime();
    rt.remember = () => {};
    const key = "main:main";
    for (let i = 0; i < 4; i++) { fake.queue.push("好"); await rt.run({ ...dev, agentId: "main", sessionKey: key, text: `约束${i}：` + "细节".repeat(800) }); }
    reg.update("main", { compaction: { max_tokens: 2000, keep_messages: 2 } });
    fake.queue.push("【记住】\n长期：改代码前先备份\n长期：每次改完跑测试", "收到");
    await rt.run({ ...dev, agentId: "main", sessionKey: key, text: "继续" });
    const s = rt.store("main").getSession(key)!;
    expect(s.summary).toContain("改代码前先备份");
    expect(s.summary).not.toContain("没能总结");
  }, 20_000);

  it("模型一个字没说就结束：不落空消息，压一压再试一次；两次都空就报错", async () => {
    const { rt, fake } = makeRuntime();
    fake.queue.push("", "这次说了");
    const r = await rt.run({ ...dev, agentId: "main", sessionKey: "main:main", text: "在吗" });
    expect(r.text).toBe("这次说了");
    const h = rt.store("main").history("main:main").map((x) => x.msg as any);
    expect(h.length).toBe(2);
    expect(h.every((m) => m.role !== "assistant" || JSON.stringify(m.content).includes("这次说了"))).toBe(true);
    fake.queue.push("", "");
    await expect(rt.run({ ...dev, agentId: "main", sessionKey: "main:main", text: "在吗" })).rejects.toThrow(/两次返回了空回复/);
    expect(rt.store("main").history("main:main").length).toBe(2);
  });
});
