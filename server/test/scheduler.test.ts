// M5：调度器、cron、heartbeat、cron_* 工具、OpenClaw 导入
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeRuntime, tmpdir } from "./helpers.ts";
import { parseCron, nextCron, inActiveHours, parseDuration } from "../src/agent/cron.ts";
import { Scheduler, computeNext, MISS_WINDOW } from "../src/agent/scheduler.ts";
import { cronTools, parseAt } from "../src/agent/tools/cron.ts";
import { importOpenClaw, convertSchedule } from "../src/agent/import-openclaw.ts";

const TZ = "Asia/Shanghai";
const sh = (s: string) => Date.parse(s + "+08:00");          // 上海墙上时间 → 毫秒
const fmt = (ms: number | null) => (ms === null ? null : new Date(ms + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " "));

describe("cron 表达式", () => {
  it("常见写法的下一次触发（上海时区）", () => {
    const n = (e: string, from: string) => fmt(nextCron(parseCron(e, TZ), sh(from)));
    expect(n("0 8 * * *", "2026-10-23T07:59")).toBe("2026-10-23 08:00");
    expect(n("0 8 * * *", "2026-10-23T08:00")).toBe("2026-10-24 08:00");   // 严格晚于
    expect(n("*/15 9-10 * * *", "2026-10-23T10:50")).toBe("2026-10-24 09:00");
    expect(n("30 7 * * mon-fri", "2026-10-24T00:00")).toBe("2026-10-26 07:30");  // 10-24 周六
    expect(n("0 0 1 jan *", "2026-10-23T00:00")).toBe("2027-01-01 00:00");
    expect(n("0 12 * * 7", "2026-10-23T00:00")).toBe("2026-10-25 12:00");   // 7 = 周日
    expect(n("0 12 13 * 5", "2026-10-24T00:00")).toBe("2026-10-30 12:00");  // 日和周都限定 → 或
    expect(nextCron(parseCron("0 0 30 2 *", TZ), sh("2026-01-01T00:00"))).toBeNull();
  });
  it("非法表达式与时区报错", () => {
    expect(() => parseCron("0 8 * *")).toThrow();
    expect(() => parseCron("61 8 * * *")).toThrow();
    expect(() => parseCron("0 8 * * *", "Mars/Base")).toThrow();
  });
  it("活跃时段（含跨午夜）、间隔、一次性时间解析", () => {
    expect(inActiveHours("08:00-23:00", sh("2026-10-23T07:59"), TZ)).toBe(false);
    expect(inActiveHours("08:00-23:00", sh("2026-10-23T08:00"), TZ)).toBe(true);
    expect(inActiveHours("22:00-07:00", sh("2026-10-23T03:00"), TZ)).toBe(true);
    expect(inActiveHours("22:00-07:00", sh("2026-10-23T12:00"), TZ)).toBe(false);
    expect(inActiveHours("", 0)).toBe(true);
    expect([parseDuration("30m"), parseDuration("2h"), parseDuration("1d"), parseDuration("90")]).toEqual([1800, 7200, 86400, 90]);
    const now = new Date(2026, 9, 23, 9, 0);
    expect(parseAt("+20m", now)).toBe(now.getTime() / 1000 + 1200);
    expect(new Date(parseAt("08:00", now) * 1000).getDate()).toBe(24);   // 今天 8 点过了 → 明天
    expect(new Date(parseAt("2026-10-25 07:30", now) * 1000).getHours()).toBe(7);
    expect(computeNext({ kind: "every", every_secs: 600, anchor: 1000 }, 1000)).toBe(1600);
    expect(computeNext({ kind: "every", every_secs: 600, anchor: 1000 }, 2300)).toBe(2800);
  });
});

function setup() {
  const env = makeRuntime();
  const delivered: any[] = [];
  let busy = false;
  const sched = new Scheduler(path.join(env.root, "system.sqlite"), env.rt, env.reg, {
    async deliver(agent, d, text) { delivered.push({ agent, d, text }); return d; },
    busy: () => busy,
  });
  env.rt.addTools(cronTools(sched));
  return { ...env, sched, delivered, setBusy: (b: boolean) => { busy = b; } };
}

describe("调度器", () => {
  it("到点运行 isolated 任务：投递到设备、记运行记录、排下一次；每次全新上下文", async () => {
    const { sched, fake, delivered, rt } = setup();
    const j = sched.add({ agent: "main", name: "早报", schedule: { kind: "every", every_secs: 3600 }, message: "讲今天的新闻", delivery: "device:cores3" });
    fake.queue.push("今天的新闻是……", "明天的新闻");
    const t = j.next_run! + 1;
    expect(await sched.tick(t)).toEqual([j.id]);
    await sched.idle();
    expect(delivered).toEqual([{ agent: "main", d: "device:cores3", text: "今天的新闻是……" }]);
    const after = sched.get(j.id)!;
    expect(after.last_status).toBe("ok");
    expect(after.next_run).toBeGreaterThan(t);
    expect(sched.runs(j.id)[0]).toMatchObject({ status: "ok", output: "今天的新闻是……", delivered: "device:cores3" });
    expect(fake.calls[0]).toMatchObject({ message: "讲今天的新闻", session: `main:cron:${j.id}`, purpose: "cron" });
    expect(fake.calls[0].system).toContain("语音");     // 投递到设备 → 语音口径
    await sched.tick(after.next_run! + 1); await sched.idle();
    expect(rt.store("main").history(`main:cron:${j.id}`).length).toBe(2);   // 上一次被重置
  });

  it("活跃时段外跳过；at 任务跑完停用；失败按指数退避重试，超过次数等下一次", async () => {
    const { sched, fake, delivered } = setup();
    const night = sched.add({ agent: "main", name: "夜里", schedule: { kind: "every", every_secs: 3600 }, message: "x", delivery: "device:c", active_hours: "08:00-09:00" });
    // 用本地时区判活跃时段：挑一个肯定不在 8~9 点的时刻
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(3, 0, 0, 0);   // 明天凌晨 3 点：一定晚于 next_run
    await sched.tick(d.getTime() / 1000); await sched.idle();
    expect(sched.runs(night.id)[0].status).toBe("skipped");
    expect(delivered).toEqual([]);
    sched.remove(night.id);

    const at = sched.add({ agent: "main", name: "一次", schedule: { kind: "at", at: Date.now() / 1000 + 100 }, message: "提醒喝水", delivery: "device:c" });
    fake.queue.push("该喝水啦");
    await sched.tick(at.next_run! + 1); await sched.idle();
    expect(sched.get(at.id)).toMatchObject({ enabled: false, next_run: null, last_status: "ok" });

    const bad = sched.add({ agent: "main", name: "会挂", schedule: { kind: "every", every_secs: 3600 }, message: "x", max_retries: 2 });
    const t0 = bad.next_run! + 1;
    fake.queue.push({ error: "e1" }, { error: "e2" }, { error: "e3" });
    await sched.tick(t0); await sched.idle();
    let j = sched.get(bad.id)!;
    expect([j.fail_count, j.retry_at! - j.last_run!]).toEqual([1, 30]);
    await sched.tick(j.retry_at! + 1); await sched.idle();
    j = sched.get(bad.id)!;
    expect([j.fail_count, Math.round(j.retry_at! - j.last_run!)]).toEqual([2, 60]);
    await sched.tick(j.retry_at! + 1); await sched.idle();
    j = sched.get(bad.id)!;
    expect(j.fail_count).toBe(3);
    expect(j.retry_at).toBeNull();
    expect(j.next_run).toBeGreaterThan(j.last_run!);
  });

  it("idleOnly：设备正在对话时延后，不算失败", async () => {
    const { sched, setBusy } = setup();
    const j = sched.add({ agent: "main", name: "等空闲", schedule: { kind: "every", every_secs: 3600 }, message: "x", idle_only: true });
    setBusy(true);
    await sched.tick(j.next_run! + 1); await sched.idle();
    expect(sched.runs(j.id)[0].status).toBe("deferred");
    expect(sched.get(j.id)!.fail_count).toBe(0);
  });

  it("heartbeat：回 HEARTBEAT_OK 不投递、不进历史；有事才投递；带上 HEARTBEAT.md 清单", async () => {
    const { sched, reg, fake, delivered, rt } = setup();
    fs.writeFileSync(path.join(reg.get("main")!.workspace, "HEARTBEAT.md"), "- 检查主人是否喝水");
    reg.update("main", { heartbeat: { enabled: true, every_minutes: 30, active_hours: "", delivery: "device:cores3" } });
    sched.syncHeartbeats();
    const hb = sched.get("hb-main")!;
    expect(hb).toMatchObject({ enabled: true, kind: "heartbeat", schedule: { kind: "every", every_secs: 1800 } });
    expect(sched.get("hb-mio")!.enabled).toBe(false);
    fake.queue.push("HEARTBEAT_OK", "该喝水啦");
    await sched.tick(hb.next_run! + 1); await sched.idle();
    expect(delivered).toEqual([]);
    expect(sched.runs("hb-main")[0].status).toBe("silent");
    expect(rt.store("main").history("main:main")).toEqual([]);
    expect(fake.calls[0].system).toContain("检查主人是否喝水");
    expect(fake.calls[0].purpose).toBe("heartbeat");
    await sched.tick(sched.get("hb-main")!.next_run! + 1); await sched.idle();
    expect(delivered.map((d) => d.text)).toEqual(["该喝水啦"]);
    expect(rt.store("main").history("main:main").length).toBe(2);
    // 改配置后同步：关掉
    reg.update("main", { heartbeat: { enabled: false } as any });
    sched.syncHeartbeats();
    expect(sched.get("hb-main")!.enabled).toBe(false);
  });

  it("重启恢复：定义还在；错过太久的不补跑，排到下一次", async () => {
    const { sched, root, rt, reg } = setup();
    const j = sched.add({ agent: "main", name: "x", schedule: { kind: "every", every_secs: 3600 }, message: "x" });
    sched.db.prepare("UPDATE jobs SET data = ? WHERE id = ?").run(JSON.stringify({ ...j, next_run: Date.now() / 1000 - MISS_WINDOW - 100 }), j.id);
    const s2 = new Scheduler(path.join(root, "system.sqlite"), rt, reg, { deliver: async () => "", busy: () => false });
    s2.start(3600);
    s2.stop();
    expect(s2.get(j.id)!.next_run).toBeGreaterThan(Date.now() / 1000);
  });
});

describe("cron_* 工具", () => {
  it("agent 自己建任务（默认投递到当前设备），只能管自己的", async () => {
    const { rt, sched, fake } = setup();
    fake.queue.push({ tool_calls: [{ name: "cron_add", args: { name: "早报", kind: "cron", value: "0 8 * * *", message: "讲新闻" } }], then: "好的，每天八点讲" });
    const r = await rt.run({ kind: "main", channel: "device", deviceId: "cores3", spokenTo: "cores3", agentId: "main", sessionKey: "main:main", text: "每天八点给我讲新闻" });
    expect(r.text).toBe("好的，每天八点讲");
    const [j] = sched.list("main");
    expect(j).toMatchObject({ name: "早报", delivery: "device:cores3", session: "isolated", source: "agent" });
    // mio 删不了 main 的任务
    fake.queue.push({ tool_calls: [{ name: "cron_remove", args: { id: j.id } }], then: "删不了" });
    await rt.run({ kind: "main", channel: "webchat", agentId: "mio", sessionKey: "mio:webchat:owner", text: "删掉" });
    expect(sched.get(j.id)).toBeTruthy();
  });
});

describe("从 OpenClaw 导入", () => {
  it("人设/记忆原样拷贝；任务转换后默认暂停", () => {
    const { reg, sched } = setup();
    const oc = tmpdir("oc");
    fs.mkdirSync(path.join(oc, "workspace", "memory"), { recursive: true });
    fs.writeFileSync(path.join(oc, "workspace", "SOUL.md"), "我是从 OpenClaw 来的神乐");
    fs.writeFileSync(path.join(oc, "workspace", "memory", "2026-10-01.md"), "旧笔记");
    fs.mkdirSync(path.join(oc, "workspace-mio"), { recursive: true });
    fs.writeFileSync(path.join(oc, "workspace-mio", "IDENTITY.md"), "小澪");
    fs.mkdirSync(path.join(oc, "cron"));
    fs.writeFileSync(path.join(oc, "cron", "jobs.json"), JSON.stringify({ version: 1, jobs: [
      { id: "morning", name: "早报", agentId: "main", schedule: { kind: "cron", expr: "0 8 * * *", tz: TZ }, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "用 cores3-speak 讲新闻" } },
      { id: "water", name: "喝水", agentId: "mio", schedule: { kind: "every", everyMs: 7200000 }, payload: { kind: "systemEvent", text: "提醒喝水" } },
      { id: "bad", name: "坏的", schedule: { kind: "weird" }, payload: { kind: "agentTurn", message: "x" } },
    ] }));
    const rep = importOpenClaw(oc, reg, sched);
    expect(fs.readFileSync(path.join(reg.get("main")!.workspace, "SOUL.md"), "utf8")).toContain("OpenClaw");
    expect(fs.existsSync(path.join(reg.get("main")!.workspace, "memory", "2026-10-01.md"))).toBe(true);
    expect(fs.readFileSync(path.join(reg.get("mio")!.workspace, "IDENTITY.md"), "utf8")).toBe("小澪");
    expect(rep.jobs.imported.map((j) => j.id)).toEqual(["oc-morning", "oc-water"]);
    expect(rep.jobs.skipped.map((s) => s.name)).toEqual(["坏的"]);
    expect(sched.get("oc-morning")).toMatchObject({ enabled: false, session: "isolated", schedule: { kind: "cron", expr: "0 8 * * *", tz: TZ } });
    expect(sched.get("oc-water")).toMatchObject({ agent: "mio", kind: "systemEvent", session: "main", schedule: { kind: "every", every_secs: 7200 } });
    // 再导一次不重复
    expect(importOpenClaw(oc, reg, sched).jobs.skipped.filter((s) => s.reason === "已导入过").length).toBe(2);
    expect(convertSchedule({ kind: "at", at: "2026-10-24T08:00:00+08:00" })).toEqual({ kind: "at", at: sh("2026-10-24T08:00") / 1000 });
  });
});
