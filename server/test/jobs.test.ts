// 移植自 tests/test_reminders.py（调度部分）、test_photo_schedules.py、test_roles.py（匹配与持久化部分）
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Reminders, MAX_ATTEMPTS, RETRY_DELAY } from "../src/jobs/reminders.ts";
import { PhotoSchedules, normalizeTime } from "../src/jobs/photoSchedules.ts";
import { Roles } from "../src/roles.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kagura-test-"));
const ts = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;

describe("提醒调度", () => {
  let file: string, sent: [string, string][], rem: Reminders;
  beforeEach(() => {
    file = path.join(tmp(), "reminders.json");
    sent = [];
    rem = new Reminders(file, (t, d) => { sent.push([t, d]); return true; });
  });
  it("到期发送并移除，未到期保留", async () => {
    rem.schedule(1000, "关火", "cores3");
    rem.schedule(2000, "开会", "cores3");
    expect(await rem.fireDue(1500)).toBe(1);
    expect(sent).toEqual([["叮咚，提醒时间到：关火", "cores3"]]);
    expect(rem.pendingCount()).toBe(1);
  });
  it("没到期不发", async () => {
    rem.schedule(9999, "x", "d");
    expect(await rem.fireDue(100)).toBe(0);
    expect(sent).toEqual([]);
  });
  it("失败重试，超限丢弃", async () => {
    const r = new Reminders(file, () => false);
    r.schedule(1000, "任务", "d");
    let t = 1000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) { expect(await r.fireDue(t)).toBe(0); t += RETRY_DELAY + 1; }
    expect(r.pendingCount()).toBe(0);
  });
  it("持久化往返", () => {
    rem.schedule(1234, "持久化", "d1");
    const r2 = new Reminders(file);
    r2.load();
    expect(r2.pendingCount()).toBe(1);
    expect(r2.items[0].task).toBe("持久化");
  });
  it("无内容的提醒文案", async () => {
    rem.schedule(1, "", "d");
    await rem.fireDue(2);
    expect(sent[0][0]).toBe("叮咚，你设置的提醒时间到了。");
  });
});

describe("定时拍照", () => {
  let file: string, runs: string[], ps: PhotoSchedules;
  const arm = () => ps.items.forEach((it) => (it.last_fired = null));
  beforeEach(() => {
    file = path.join(tmp(), "photo_schedules.json");
    runs = [];
    ps = new PhotoSchedules(file, async (it) => { runs.push(it.id); return { ok: true }; });
  });

  it.each([["08:00", "08:00"], ["8:05", "08:05"], [" 23:59 ", "23:59"], ["0:00", "00:00"]])("时间归一 %s", (raw, want) => expect(normalizeTime(raw)).toBe(want));
  it.each(["24:00", "08:60", "8点", "", "0800", null, "-1:00", "9:5"])("拒绝 %s", (raw) => expect(normalizeTime(raw)).toBeNull());

  it("新增归一化并落盘", () => {
    const it0 = ps.add("9:05", "cores3", " 看看猫在干嘛 ");
    expect(it0.time).toBe("09:05");
    expect(it0.prompt).toBe("看看猫在干嘛");
    expect(it0.enabled).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).map((s: any) => s.id)).toEqual([it0.id]);
  });
  it("坏时间与上限", () => {
    expect(() => ps.add("25:00")).toThrow();
    ps.max = 2;
    ps.add("08:00"); ps.add("09:00");
    expect(() => ps.add("10:00")).toThrow();
  });
  it("按时间排序", () => {
    ps.add("22:00"); ps.add("07:30");
    expect(ps.list().map((s) => s.time)).toEqual(["07:30", "22:00"]);
  });
  it("改与删", () => {
    const sid = ps.add("08:00").id;
    expect(ps.update(sid, { enabled: false, prompt: "换个问法" })!.enabled).toBe(false);
    expect(ps.get(sid)!.prompt).toBe("换个问法");
    expect(ps.remove(sid)).toBe(true);
    expect(ps.remove(sid)).toBe(false);
    expect(ps.list()).toEqual([]);
  });
  it("改坏时间不生效", () => {
    const sid = ps.add("08:00").id;
    expect(() => ps.update(sid, { time: "99:99" })).toThrow();
    expect(ps.get(sid)!.time).toBe("08:00");
  });
  it("改时间清掉 last_fired", () => {
    const sid = ps.add("08:00").id;
    ps.items[0].last_fired = "2026-08-09";
    ps.update(sid, { time: "20:00" });
    expect(ps.get(sid)!.last_fired).toBeNull();
  });
  it("未知 id", () => {
    expect(ps.get("nope")).toBeNull();
    expect(ps.update("nope", { enabled: false })).toBeNull();
  });
  it("到点触发 / 不到点不触发", async () => {
    const sid = ps.add("08:00").id; arm();
    expect(await ps.fireDue(ts(2026, 8, 9, 7, 59))).toBe(0);
    expect(await ps.fireDue(ts(2026, 8, 9, 8, 0) + 30)).toBe(1);
    expect(runs).toEqual([sid]);
  });
  it("一天只触发一次，换天再触发", async () => {
    ps.add("08:00"); arm();
    for (const [h, m] of [[8, 0], [8, 5], [23, 0]]) await ps.fireDue(ts(2026, 8, 9, h, m));
    expect(runs.length).toBe(1);
    await ps.fireDue(ts(2026, 8, 10, 8, 1));
    expect(runs.length).toBe(2);
  });
  it("错过窗口：记账但不补拍", async () => {
    ps.add("08:00"); arm();
    expect(await ps.fireDue(ts(2026, 8, 9, 23, 30))).toBe(0);
    expect(runs).toEqual([]);
    expect(ps.items[0].last_fired).toBe("2026-08-09");
  });
  it("窗口内仍触发", async () => {
    ps.add("08:00"); arm();
    expect(await ps.fireDue(ts(2026, 8, 9, 8, 10))).toBe(1);
  });
  it("停用不触发", async () => {
    const sid = ps.add("08:00").id;
    ps.update(sid, { enabled: false }); arm();
    expect(await ps.fireDue(ts(2026, 8, 9, 8, 1))).toBe(0);
  });
  it("过了时间才建的计划不当场触发", async () => {
    const t = ts(2026, 8, 9, 9, 0);
    ps.add("08:00", "cores3", "", true, t);
    expect(await ps.fireDue(t)).toBe(0);
  });
  it("执行异常记进 last_result", async () => {
    const p2 = new PhotoSchedules(file, async () => { throw new Error("设备离线"); });
    const sid = p2.add("08:00").id;
    p2.items[0].last_fired = null;
    await p2.fireDue(ts(2026, 8, 9, 8, 1));
    const last = p2.get(sid)!.last_result!;
    expect(last.ok).toBe(false);
    expect(last.error).toContain("设备离线");
  });
  it("试跑不看也不改 last_fired", async () => {
    const sid = ps.add("08:00").id;
    const before = ps.get(sid)!.last_fired;
    await ps.runNow(sid);
    expect(runs).toEqual([sid]);
    expect(ps.get(sid)!.last_fired).toBe(before);
    expect(await ps.runNow("nope")).toBeNull();
  });
  it("加载时丢掉坏条目、补默认值", () => {
    fs.writeFileSync(file, JSON.stringify([{ id: "good", time: "7:00", device_id: "cores3" }, { id: "bad", time: "99:99" }, "not-a-dict"]));
    ps.load();
    const items = ps.list();
    expect(items.map((i) => i.id)).toEqual(["good"]);
    expect(items[0].time).toBe("07:00");
    expect(items[0].enabled).toBe(true);
  });
  it("JSON 坏了不崩", () => {
    fs.writeFileSync(file, "{ not json");
    ps.load();
    expect(ps.list()).toEqual([]);
  });
});

describe("角色", () => {
  const ROLES = [
    { id: "", name: "神乐", agent: "main", per: 111, aliases: ["kagura"] },
    { id: "mio", name: "小澪", agent: "mio", per: 4, aliases: ["小玲"] },
  ];
  let file: string, roles: Roles;
  beforeEach(() => { file = path.join(tmp(), "roles_state.json"); roles = new Roles(ROLES, file); });

  it.each([
    ["切换到小澪", "mio"], ["换成小澪吧。", "mio"], ["叫小澪出来", "mio"], ["我想和小玲说话", "mio"], ["换回神乐", ""],
    ["换个话题吧", null], ["让神乐唱首歌", null], ["小澪今天好可爱", null],
  ])("切换匹配 %s", (text, want) => expect(roles.matchSwitch(text)?.id ?? null).toBe(want));
  it("单角色从不切换", () => {
    const r = new Roles(null, file);
    expect(r.matchSwitch("切换到神乐")).toBeNull();
    expect(r.matchList("有哪些角色")).toBeNull();
  });
  it("非法 id 报错", () => expect(() => new Roles([{ id: "小澪", name: "x" }], file)).toThrow());
  it("重复 id 报错", () => expect(() => new Roles([{ id: "a" }, { id: "a" }], file)).toThrow());
  it("重启后保留、会话 key 规则", () => {
    roles.set("d1", "mio");
    const r2 = new Roles(ROLES, file);
    expect(r2.get("d1").id).toBe("mio");
    expect(r2.sessionKey("d1", r2.get("d1"))).toBe("d1~mio");
    expect(r2.sessionKey("d1", r2.default())).toBe("d1");
  });
  it("循环切换与问候", () => {
    expect(roles.next("d2").id).toBe("mio");
    roles.set("d2", "mio");
    expect(roles.next("d2").id).toBe("");
    expect(roles.greeting(roles.find("mio")!)).toBe("我是小澪，有什么事吗？");
    expect(roles.matchList("都有谁这些人")).toBeNull();
    expect(roles.matchList("有哪些角色")).toContain("神乐、小澪");
  });
});
