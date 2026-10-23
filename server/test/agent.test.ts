// M3：agent 运行时的系统层测试（假模型脚本驱动）
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { deviceTools } from "../src/agent/tools/device.ts";
import { Runtime } from "../src/agent/runtime.ts";
import { AgentRegistry } from "../src/agent/registry.ts";
import { buildSystemPrompt, clip, applyBudgets, BUDGETS } from "../src/agent/soul.ts";
import { PiBrain } from "../src/brain/pi.ts";

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
    const main = buildSystemPrompt({ agent: a, kind: "main", channel: "device" });
    expect(main).toContain("乌龙茶");
    expect(main).toContain("今天去了公园");
    expect(main).toContain("已截断");
    expect(main).toContain("不超过 80 字");
    // 5000 字在默认上限内不截断；配置调小之后才截
    fs.writeFileSync(path.join(a.workspace, "SOUL.md"), "灵".repeat(5000));
    expect(buildSystemPrompt({ agent: a, kind: "main", channel: "device" })).not.toContain("已截断");
    applyBudgets({ "SOUL.md": 1000, bogus: 5 });
    expect(BUDGETS["SOUL.md"]).toBe(1000);
    expect("bogus" in BUDGETS).toBe(false);
    expect(buildSystemPrompt({ agent: a, kind: "main", channel: "device" })).toContain("已截断");
    applyBudgets({});
    expect(BUDGETS["SOUL.md"]).toBe(20000);
    const sub = buildSystemPrompt({ agent: a, kind: "sub", channel: "a2a" });
    expect(sub).not.toContain("乌龙茶");
    expect(sub).not.toContain("<USER.md>");
    expect(sub).not.toContain("今天去了公园");
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
      { id: "", name: "神乐", agent: "main", per: 111, aliases: [] },
      { id: "mio", name: "小澪", agent: "mio", per: 4, aliases: [] },
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
