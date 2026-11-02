// 借鉴 DeepSeek Super-agent 的几处（2026-11）：插话、给子任务补充、后台命令、监工、IM 连发合并、近况编号
import path from "node:path";
import { describe, it, expect } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { makeRuntime } from "./helpers.ts";
import { A2A } from "../src/agent/a2a.ts";
import { TURN_NOTE_TAG } from "../src/agent/runtime.ts";
import { BgJobs, BG_DONE_TAG, execTools } from "../src/agent/tools/exec.ts";
import { parseToolsConfig } from "../src/config.ts";
import { Watchdog, WATCHDOG_TAG, digestOf } from "../src/agent/watchdog.ts";
import { ChannelStore } from "../src/channels/store.ts";
import { ChannelManager } from "../src/channels/manager.ts";
import type { ChannelAdapter, InboundMessage } from "../src/channels/types.ts";

const isWin = process.platform === "win32";
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!cond()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

/** 一个会卡住、等测试放行的工具 */
function slowTool() {
  let release: () => void = () => {};
  let gate = new Promise<void>((r) => (release = r));
  const tool = {
    name: "slow", label: "慢工具", description: "慢", parameters: Type.Object({}),
    execute: async () => { await gate; return { content: [{ type: "text", text: "慢工具做完了" }], details: {} }; },
  };
  return { provider: () => [tool as any], release: () => { release(); gate = new Promise<void>((r) => (release = r)); } };
}
const toolRunning = (rt: any, name = "slow") => () => rt.activeRuns().some((r: any) => r.tool === name);

describe("插话（Runtime.steer）", () => {
  it("正在跑的那一轮里插一句：她下一次调模型就看到，一轮里接着回；空闲的会话插不进去", async () => {
    const { rt, fake } = makeRuntime();
    const slow = slowTool();
    rt.addTools(slow.provider);
    expect(rt.steer("main", "main:main", "x")).toBe(false);
    fake.queue.push({ tool_calls: [{ name: "slow" }], then: "不该用到" }, "收到，顺便也查了价格");
    const p = rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "帮我查下航班" });
    await waitFor(toolRunning(rt));
    expect(rt.steer("main", "main:main", "[主人补充] 顺便查一下价格")).toBe(true);
    slow.release();
    const r = await p;
    expect(r.text).toBe("收到，顺便也查了价格");
    expect(fake.calls.at(-1).message).toBe("[主人补充] 顺便查一下价格");
    const users = rt.store("main").history("main:main").map((h) => h.msg as any).filter((m) => m.role === "user");
    expect(users.length).toBe(2);
  });
});

describe("给后台子任务补充（sessions_steer）", () => {
  it("子任务在跑时主会话每轮看得到它；sessions_steer 插进子任务，子任务按补充做完、结果交回", async () => {
    const env = makeRuntime();
    const { rt, fake } = env;
    const a2a = new A2A(path.join(env.root, "system.sqlite"), rt, env.reg, { enabled: true, maxHops: 3, perPairPerMin: 10 });
    rt.addTools(a2a.tools());
    rt.turnNotes.push((s) => a2a.note(s.agentId));
    const slow = slowTool();
    rt.addTools(slow.provider);
    fake.queue.push(
      { tool_calls: [{ name: "sessions_spawn", args: { task: "查明天去上海的航班" } }], then: "已经安排了" },
      { tool_calls: [{ name: "slow" }], then: "不该用到" },      // 子任务先卡在慢工具里
    );
    const r1 = await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "帮我查航班" });
    expect(r1.text).toBe("已经安排了");
    await waitFor(toolRunning(rt));
    const subKey = [...a2a.subs.keys()][0];
    expect(subKey).toMatch(/^main:sub:/);
    fake.queue.push({ tool_calls: [{ name: "sessions_steer", args: { session: subKey, message: "只要上午的" } }], then: "跟它说了" });
    const r2 = await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "只要上午的" });
    expect(r2.text).toBe("跟它说了");
    // 主会话这一轮看到了正在跑的子任务；落盘时备注去掉
    expect(fake.calls.at(-1).full).toContain(TURN_NOTE_TAG);
    expect(fake.calls.at(-1).full).toContain(subKey);
    expect(JSON.stringify(rt.store("main").history("main:main"))).not.toContain(TURN_NOTE_TAG);
    fake.queue.push("上午只有 MU5101", "NO_REPLY");
    slow.release();
    await waitFor(() => (a2a.log() as any[]).some((l) => l.kind === "spawn" && l.status === "ok"));
    const sub = fake.calls.find((c) => c.session === subKey && c.message.includes("补充"));
    expect(sub.message).toBe("[来自发起方 神乐 的补充] 只要上午的");
    expect((a2a.log() as any[]).find((l) => l.kind === "spawn").reply).toBe("上午只有 MU5101");
    // 做完了：不再是正在跑的子任务，再补充就失败
    await waitFor(() => a2a.subs.size === 0);
    fake.queue.push({ tool_calls: [{ name: "sessions_steer", args: { session: subKey, message: "x" } }], then: "好" });
    await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "再补一句" });
    const tr = rt.store("main").history("main:main").map((h) => h.msg as any).filter((m) => m.role === "toolResult").at(-1);
    expect(tr.isError).toBe(true);
  });
});

describe("后台命令（exec background）", () => {
  const scope = (o: any = {}): any => ({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", purpose: "chat", hop: 0, chain: [], meta: {}, trusted: true, ...o });

  it.skipIf(isWin)("立刻返回编号，跑完把结果交回发起的会话；exec_jobs 能看、能停（停掉的不再交回）；主人叫停发起那一轮也一起停", async () => {
    const { reg } = makeRuntime();
    const jobs = new BgJobs();
    const notes: { scope: any; text: string }[] = [];
    const tools = execTools(parseToolsConfig({}), { jobs, notify: async (s, text) => { notes.push({ scope: s, text }); } })(scope(), reg.get("main")!);
    const [exec, ctl] = tools;
    expect(ctl.name).toBe("exec_jobs");
    const r: any = await exec.execute("t", { command: "sleep 0.2; echo built", background: true });
    expect(r.content[0].text).toContain("bg1");
    expect(jobs.note("main")).toContain("bg1");
    await waitFor(() => notes.length === 1);
    expect(notes[0].text.startsWith(BG_DONE_TAG)).toBe(true);
    expect(notes[0].text).toContain("built");
    expect(notes[0].scope.sessionKey).toBe("main:main");
    expect(jobs.jobs.get("bg1")!.status).toBe("done");

    await exec.execute("t", { command: "sleep 5", background: true });
    expect(((await ctl.execute("t", { action: "list" })) as any).content[0].text).toMatch(/bg2 running/);
    await ctl.execute("t", { action: "stop", id: "bg2" });
    await waitFor(() => jobs.jobs.get("bg2")!.status === "stopped");

    const ac = new AbortController();
    const [exec2] = execTools(parseToolsConfig({}), { jobs, notify: async (s, text) => { notes.push({ scope: s, text }); } })(scope({ cancel: ac.signal }), reg.get("main")!);
    await exec2.execute("t", { command: "sleep 5", background: true });
    ac.abort();
    await waitFor(() => jobs.jobs.get("bg3")!.status === "stopped");
    await new Promise((r) => setTimeout(r, 50));
    expect(notes.length).toBe(1);
  });

  it("子任务、待办里没有后台模式（结果交回来没人接）", () => {
    const { reg } = makeRuntime();
    const mk = (o: any) => execTools(parseToolsConfig({}), { jobs: new BgJobs(), notify: async () => {} })(scope(o), reg.get("main")!);
    expect(mk({ kind: "sub" }).map((t) => t.name)).toEqual(["exec"]);
    expect(mk({ purpose: "task" }).map((t) => t.name)).toEqual(["exec"]);
    expect(JSON.stringify(mk({ kind: "sub" })[0].parameters)).not.toContain("background");
    expect(mk({}).map((t) => t.name)).toEqual(["exec", "exec_jobs"]);
  });
});

describe("监工（Watchdog）", () => {
  it("把最近几步交给便宜模型判断；连着两次判兜圈子才软停，叫停原因带监工标记", async () => {
    const { rt, fake, models } = makeRuntime();
    const slow = slowTool();
    rt.addTools(slow.provider);
    fake.queue.push({ tool_calls: [{ name: "slow" }], then: "做到一半，卡在编译" });
    const p = rt.run({ agentId: "main", sessionKey: "main:task:1", kind: "isolated", channel: "system", purpose: "task", text: "修一下编译" });
    await waitFor(toolRunning(rt));
    const dog = new Watchdog(rt, models, () => true, { afterMs: 0, everyMs: 0 });
    fake.queue.push("推进", "兜圈子：一直重复同一条命令", "兜圈子：还是同一条命令");
    expect(await dog.tick()).toEqual([]);           // 推进
    expect(await dog.tick()).toEqual([]);           // 第一次兜圈子：记一次
    expect(await dog.tick()).toEqual(["main|main:task:1"]);
    expect(fake.calls.at(-1).message).toContain("[调用] slow");
    slow.release();
    const r = await p;
    expect(r.guard?.startsWith(WATCHDOG_TAG)).toBe(true);
    expect(r.text).toBe("做到一半，卡在编译");
  });

  it("摘要：用户消息、她说的话、工具调用和结果（出错标出来）", () => {
    const d = digestOf([
      { role: "user", content: [{ type: "text", text: "修编译" }] },
      { role: "assistant", content: [{ type: "text", text: "我试试" }, { type: "toolCall", name: "exec", arguments: { command: "make" } }] },
      { role: "toolResult", isError: true, content: [{ type: "text", text: "error: x" }] },
    ]);
    expect(d.split("\n")).toEqual(["[任务/消息] 修编译", "[它说] 我试试", '[调用] exec {"command":"make"}', "[结果·出错] error: x"]);
  });
});

class FakeAdapter implements ChannelAdapter {
  readonly kind: any = "feishu";
  sent: { chatId: string; text: string; opts: any }[] = [];
  events: string[] = [];
  constructor(readonly accountId: string) {}
  async start() {}
  async stop() {}
  async send(chatId: string, text: string, opts: any = {}) { this.sent.push({ chatId, text, opts }); }
  async react(id: string) { this.events.push(`react:${id}`); return async () => { this.events.push(`unreact:${id}`); }; }
  status() { return { state: "online" as const, detail: "", since: 0 }; }
}
const msg = (o: Partial<InboundMessage> = {}): InboundMessage => ({
  kind: "feishu", account: "fs", chatType: "dm", chatId: "oc_dm1", sender: "ou_1", text: "你好", images: [], mentionedMe: false, messageId: "om1", ...o,
});

describe("IM 连发合并", () => {
  it("她在回第一条时又来了两条：等她空下来合成一轮、只回一次（回复挂在最后一条上），三条的表情都撤掉", async () => {
    const env = makeRuntime();
    const store = new ChannelStore(path.join(env.root, "channels.json"));
    let ad!: FakeAdapter;
    const mgr = new ChannelManager(store, env.rt, env.reg, (a) => (ad = new FakeAdapter(a.id)));
    store.upsertAccount({ id: "fs", kind: "feishu", credentials: { app_id: "a", app_secret: "s" }, dm_policy: "allowlist" });
    store.allow("fs", "ou_1", "主人", true);
    await mgr.startAll();
    const slow = slowTool();
    env.rt.addTools(slow.provider);
    env.fake.queue.push({ tool_calls: [{ name: "slow" }], then: "第一条的回复" }, "两条一起回了");
    const p1 = mgr.handle(msg({ messageId: "om1", text: "帮我看下日程" }));
    await waitFor(toolRunning(env.rt));
    const p2 = mgr.handle(msg({ messageId: "om2", text: "还有明天的" }));
    const p3 = mgr.handle(msg({ messageId: "om3", text: "和后天的" }));
    await p3;                                       // 交给前一条了，立刻返回
    slow.release();
    await Promise.all([p1, p2]);
    expect(ad.sent.map((s) => s.text)).toEqual(["第一条的回复", "两条一起回了"]);
    expect(ad.sent[1].opts.replyTo).toBe("om3");
    const merged = env.fake.calls.at(-1).message;
    expect(merged).toContain("连着收到 2 条");
    expect(merged).toContain("还有明天的\n和后天的");
    await new Promise((r) => setTimeout(r, 10));
    for (const id of ["om1", "om2", "om3"]) expect(ad.events).toContain(`unreact:${id}`);
  });
});

describe("近况编号", () => {
  it("每个会话一个编号，末尾列出编号对应的会话，要前后文时用 sessions_history 去查；没有这个工具就不编号", async () => {
    const { rt, reg, fake } = makeRuntime();
    fake.queue.push("好的，一路顺风", "记住了");
    await rt.run({ agentId: "main", sessionKey: "main:webchat:a", kind: "chat", channel: "webchat", text: "我明天出差" });
    await rt.run({ agentId: "main", sessionKey: "main:webchat:b", kind: "chat", channel: "webchat", text: "帮我记一下车牌" });
    const ra = rt.recentActivity(reg.get("main")!, "main:webchat:c", true);
    expect(ra).toMatch(/\[网页 #\d\] 主人：我明天出差/);
    expect(ra).toContain("session main:webchat:a");
    expect(ra).toContain("session main:webchat:b");
    expect(ra).toContain("sessions_history");
    const plain = rt.recentActivity(reg.get("main")!, "main:webchat:c");
    expect(plain).toContain("[网页] 主人：我明天出差");
    expect(plain).not.toContain("sessions_history");
  });
});
