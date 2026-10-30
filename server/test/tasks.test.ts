// 待办：静默时段才自动做、一次一件、定了时间到点做、早上汇报、撤销 / 重新排队、重启恢复、agent 工具
import { describe, it, expect } from "vitest";
import path from "node:path";
import { makeRuntime } from "./helpers.ts";
import { TaskQueue, nextWindowStart, verdictOf, MAX_ROUNDS, type TaskHost } from "../src/agent/tasks.ts";
import { taskTools, parseWhen } from "../src/agent/tools/tasks.ts";
import type { RunScope } from "../src/agent/scope.ts";

/** 今天本地时间 hh:mm 的秒数 */
const at = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() / 1000; };

function setup(hostPatch: Partial<TaskHost> = {}) {
  const { root, reg, rt, fake } = makeRuntime();
  const runs: any[] = [], reports: any[] = [];
  let release: (() => void) | null = null;
  const host: TaskHost = {
    run: async (req) => { runs.push(req); if (hostPatch.run) return hostPatch.run(req); return { text: `做完了：${req.sessionKey}\n状态：完成`, meta: {}, toolCalls: [], usage: { input: 10, output: 5, cost: 0.01 } }; },
    report: async (agentId, origin, text) => { reports.push({ agentId, origin, text }); return origin || ""; },
  };
  const q = new TaskQueue(path.join(root, "system.sqlite"), reg, host);
  return { q, reg, rt, fake, runs, reports, root, host, release };
}

describe("待办", () => {
  it("没定时间的只在静默时段自动做；定了时间的到点就做；一次只做一件", async () => {
    const { q, runs } = setup();
    const a = q.add({ agent: "main", title: "修 bug", detail: "修好登录页", origin: "feishu:fs:u1" });
    const b = q.add({ agent: "main", title: "整理资料", detail: "整理下载文件夹" });
    expect(await q.tick(at(14))).toBe(null);                  // 白天不做
    expect(await q.tick(at(3))).toBe(a.id);                   // 静默时段：先排的先做
    expect(await q.tick(at(3))).toBe(null);                   // 正在做一件，不并发
    await q.idle();
    expect(q.get(a.id)!.status).toBe("done");
    expect(runs[0]).toMatchObject({ purpose: "task", sessionKey: `main:task:${a.id}`, kind: "isolated", trusted: true, origin: "feishu:fs:u1", maxSecs: 3600 });
    expect(runs[0].toolAllow("task_add")).toBe(false);
    expect(runs[0].toolAllow("exec")).toBe(true);
    expect(runs[0].text).toContain("修好登录页");
    expect(await q.tick(at(3, 30))).toBe(b.id);
    await q.idle();
    expect(q.get(b.id)!.status).toBe("done");
    // 白天定了时间的到点就做
    const c = q.add({ agent: "main", title: "下午跑测试", detail: "跑一遍测试", run_at: at(15) });
    expect(await q.tick(at(14))).toBe(null);
    expect(await q.tick(at(15, 1))).toBe(c.id);
    await q.idle();
    expect(q.get(c.id)!.status).toBe("done");
  });

  it("夜里做完的早上汇报，同一来源合成一条；关掉自动执行后静默时段也不做", async () => {
    const { q, reports } = setup();
    const a = q.add({ agent: "main", title: "A", detail: "a", origin: "device:cores3" });
    const b = q.add({ agent: "main", title: "B", detail: "b", origin: "device:cores3" });
    q.add({ agent: "main", title: "C", detail: "c", origin: "feishu:fs:u1" });
    for (let i = 0; i < 3; i++) { await q.tick(at(2, i)); await q.idle(); }
    expect([a, b].every((x) => q.get(x.id)!.status === "done")).toBe(true);
    expect(await q.report(at(3))).toBe(0);                    // 半夜不出声
    expect(await q.report(at(7))).toBe(0);                    // 还没到汇报时间
    expect(await q.report(at(8, 5))).toBe(3);
    expect(reports).toHaveLength(2);
    const dev = reports.find((r) => r.origin === "device:cores3");
    expect(dev.text).toMatch(/2 件待办[\s\S]*「A」做完了[\s\S]*「B」做完了/);
    expect(dev.text).not.toContain("状态：");               // 状态行是给系统看的，不念给主人
    expect(q.get(a.id)!.reported).toBe(true);
    expect(await q.report(at(9))).toBe(0);                    // 不重复汇报

    q.setSettings({ auto: false });
    const d = q.add({ agent: "main", title: "D", detail: "d" });
    expect(await q.tick(at(3))).toBe(null);
    expect(q.runNow(d.id).status === "running" || q.get(d.id)!.status === "running").toBe(true);   // 手动执行不管时段
    await q.idle();
    expect(q.get(d.id)!.status).toBe("done");
    expect(() => q.setSettings({ window: "1点到6点" })).toThrow(/格式/);
  });

  it("撤销、改时间、重新排队、失败记原因、重启后接着排队", async () => {
    let gate: () => void = () => {};
    const { q, root, reg } = setup({ run: (req) => new Promise((ok, bad) => {
      req.signal?.addEventListener("abort", () => bad(new Error("aborted")));
      gate = () => ok({ text: "ok\n状态：完成", meta: {}, toolCalls: [], usage: { input: 0, output: 0, cost: 0 } });
    }) });
    const a = q.add({ agent: "main", title: "A", detail: "a" });
    const b = q.add({ agent: "main", title: "B", detail: "b" });
    q.update(b.id, { run_at: at(23), detail: "改过的 b" });
    expect(q.get(b.id)).toMatchObject({ run_at: at(23), detail: "改过的 b" });
    await q.tick(at(3));
    expect(q.get(a.id)!.status).toBe("running");
    expect(() => q.update(a.id, { title: "x" })).toThrow(/排队/);
    q.cancel(a.id);                                            // 正在做的：中止
    await q.idle();
    expect(q.get(a.id)!.status).toBe("cancelled");
    q.requeue(a.id);
    expect(q.get(a.id)).toMatchObject({ status: "queued", run_at: null, attempts: 0 });
    q.cancel(b.id);
    expect(q.get(b.id)!.status).toBe("cancelled");

    // 重启：正在做的回到排队
    await q.tick(at(3));
    expect(q.get(a.id)!.status).toBe("running");
    const q2 = new TaskQueue(path.join(root, "system.sqlite"), reg, { run: async () => { throw new Error("模型挂了"); }, report: async () => "" });
    expect(q2.get(a.id)).toMatchObject({ status: "queued" });
    expect(q2.get(a.id)!.error).toMatch(/重启/);
    await q2.tick(at(3)); await q2.idle();
    expect(q2.get(a.id)).toMatchObject({ status: "failed", error: "模型挂了" });
    gate();
  });

  it("agent 工具：只在可信会话里有、执行待办时没有；记下来源和时间", async () => {
    const { q, reg } = setup();
    const agent = reg.get("main")!;
    const scope = (p: Partial<RunScope>): RunScope => ({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "feishu", purpose: "chat", hop: 0, chain: [], meta: {}, trusted: true, ...p });
    expect(taskTools(q)(scope({ trusted: false }), agent)).toHaveLength(0);
    expect(taskTools(q)(scope({ purpose: "task" }), agent)).toHaveLength(0);
    const tools = taskTools(q)(scope({ origin: "feishu:fs:u1" }), agent);
    expect(tools.map((t) => t.name)).toEqual(["task_add", "task_list", "task_update", "task_cancel"]);
    const r: any = await tools[0].execute("1", { title: "重构", detail: "把 foo.ts 拆成两个文件" }, undefined as any);
    expect(r.content[0].text).toContain("已记下");
    const t = q.list()[0];
    expect(t).toMatchObject({ origin: "feishu:fs:u1", run_at: null, trusted: true, source: "agent" });
    const dev = taskTools(q)(scope({ channel: "device", deviceId: "cores3", origin: undefined }), agent);
    await dev[0].execute("2", { title: "x", detail: "y", when: "+2h" }, undefined as any);
    expect(q.list().find((x) => x.title === "x")).toMatchObject({ origin: "device:cores3" });
    expect(parseWhen("tonight")).toBe(null);
    expect(Math.abs(parseWhen("now")! - Date.now() / 1000)).toBeLessThan(2);
    expect(nextWindowStart("01:00-06:00", at(3))).toBe(at(3));
    expect(nextWindowStart("01:00-06:00", at(14))).toBe(at(1) + 86400);
  });

  it("验收：没写状态行 / 被截断就催她接着做；只有「完成」才算完成，其余记没做完、能接着做", async () => {
    const replies: any[] = [];
    const { q, runs } = setup({ run: async () => replies.shift() });
    const R = (text: string, stopReason = "stop") => ({ text, meta: {}, toolCalls: [], usage: { input: 1, output: 1, cost: 0 }, stopReason });
    // 第一轮只说了计划，第二轮被截断，第三轮才真做完
    replies.push(R("我先看看代码，接下来改 login.ts。"), R("改好了一半…\n状态：完成", "length"), R("改好了，测试通过。\n**状态：完成**"));
    const a = q.add({ agent: "main", title: "修 bug", detail: "修登录页" });
    await q.tick(at(3)); await q.idle();
    expect(runs.length).toBe(3);
    expect(runs[1].text).toContain("[继续待办]");
    expect(runs.every((r) => r.sessionKey === `main:task:${a.id}`)).toBe(true);
    expect(q.get(a.id)).toMatchObject({ status: "done", result: "改好了，测试通过。", tokens_in: 3 });

    // 一直不给结论：催满 MAX_ROUNDS 轮记为没做完
    for (let i = 0; i <= MAX_ROUNDS; i++) replies.push(R("我会去做的。"));
    const b = q.add({ agent: "main", title: "整理", detail: "整理资料" });
    await q.tick(at(3, 10)); await q.idle();
    expect(q.get(b.id)!.status).toBe("partial");
    expect(q.get(b.id)!.error).toMatch(/没给出「完成」/);
    expect(runs.length).toBe(3 + 1 + MAX_ROUNDS);

    // 自己说没做完 / 要主人决定
    replies.push(R("改了两个文件，第三个依赖装不上。\n状态：没做完：npm 装不上 sharp"));
    const c = q.add({ agent: "main", title: "升级依赖", detail: "升级依赖" });
    await q.tick(at(3, 20)); await q.idle();
    expect(q.get(c.id)).toMatchObject({ status: "partial", error: "没做完：npm 装不上 sharp", result: "改了两个文件，第三个依赖装不上。" });
    replies.push(R("方案写好了。\n状态：需要主人：选 A 还是 B"));
    const d = q.add({ agent: "main", title: "选型", detail: "对比方案" });
    await q.tick(at(3, 30)); await q.idle();
    expect(q.get(d.id)!.error).toBe("需要你决定：选 A 还是 B");
    expect(verdictOf("嗯\n> 状态：完成").v).toBe("done");
    expect(verdictOf("状态：完成，然后我还要…").v).toBe("done");
    expect(verdictOf("我之前说过状态：完成，但还有事").v).toBe("none");      // 状态行得单独成行

    // 继续做：接着原会话、提示词是「继续待办」；重新开始：清空会话
    const resets: string[] = [];
    (q as any).host.reset = (_a: string, k: string) => resets.push(k);
    q.requeue(c.id);
    expect(q.get(c.id)).toMatchObject({ status: "queued", resume: true });
    replies.push(R("装好了，全部升级完。\n状态：完成"));
    await q.tick(at(3, 40)); await q.idle();
    expect(runs.at(-1).text).toMatch(/^\[继续待办「升级依赖」\]/);
    expect(q.get(c.id)).toMatchObject({ status: "done", resume: false });
    expect(resets).toEqual([]);
    q.requeue(d.id, { resume: false });
    expect(resets).toEqual([`main:task:${d.id}`]);
  });
});
