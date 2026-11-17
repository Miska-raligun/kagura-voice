// 每日笔记也用起来：自动回忆会看 2~14 天前的笔记（标上日期、跳过后台流水）；整理时把笔记里还用得上的提炼进长期记忆，出处 daily:<日期>
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { Memories } from "../src/agent/tools/memory.ts";
import { MemoryTidy, describe as describeTidy, DAILY_MAX_CALLS } from "../src/agent/tidy.ts";
import { USER_AUTO_HEAD, provOf } from "../src/agent/memory.ts";
import { provShort } from "../src/agent/memfmt.ts";
import { dailyNotePath } from "../src/agent/soul.ts";

const json = (o: any) => JSON.stringify(o);
const DAY = 86400_000;
const ymd = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function setup(host: any = {}) {
  const env = makeRuntime();
  const a = env.reg.get("main")!;
  const mem = new Memories(env.rt, null);
  const tidy = new MemoryTidy(env.reg, env.models, { everyDays: () => 7, window: () => "00:00-23:59", busy: () => false, report: async () => {},
    write: (ag: any, target: string, text: string, prov: any) => mem.of(ag.id).write(target, text, new Date(), "", prov), ...host });
  const note = (daysAgo: number, lines: string[]) => {
    const p = dailyNotePath(a.workspace, new Date(Date.now() - daysAgo * DAY));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `# ${ymd(Date.now() - daysAgo * DAY)}\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
    return ymd(Date.now() - daysAgo * DAY);
  };
  fs.writeFileSync(path.join(a.workspace, "USER.md"), `# 主人\n手写\n\n${USER_AUTO_HEAD}\n- 主人叫小明\n`);
  fs.writeFileSync(path.join(a.workspace, "MEMORY.md"), "# 长期记忆\n- 家里的猫叫团子\n");
  return { ...env, a, mem, tidy, ws: a.workspace, note };
}

describe("自动回忆看每日笔记", () => {
  it("2~14 天前的笔记能想起来，最多 2 条；今天 / 昨天的（已经在提示里）和更早的不算；后台流水跳过", async () => {
    const env = setup();
    env.note(0, ["10:00 主人说滑雪板放在车库"]);
    env.note(1, ["10:00 主人说滑雪板借给了小王"]);
    env.note(5, ["10:00 主人说滑雪板的固定器松了，要拿去修", "11:00 [heartbeat] 滑雪板 例行检查没事"]);
    env.note(9, ["20:00 主人说滑雪板是 2024 年买的"]);
    env.note(30, ["20:00 主人说滑雪板很贵"]);
    const hits = await env.mem.of("main").recallDaily("我的滑雪板怎么了");
    expect(hits.length).toBeLessThanOrEqual(2);
    const all = hits.map((h) => h.text).join("\n");
    expect(all).toContain("固定器松了");
    expect(all).not.toContain("车库");
    expect(all).not.toContain("小王");
    expect(all).not.toContain("很贵");
    expect(all).not.toContain("heartbeat");
    expect(hits.every((h) => h.path.startsWith("memory/"))).toBe(true);
  });

  it("出处 daily:<日期> 认得出来，回忆时显示「出自某天的笔记」", () => {
    expect(provOf("- 主人滑雪 <!-- 出处 daily:2026-11-03；主人说的 -->")).toEqual({ refs: ["daily:2026-11-03"], how: "主人说的" });
    expect(provShort("- 主人滑雪 <!-- 出处 daily:2026-11-03；推测 -->")).toContain("出自 2026-11-03 的笔记");
  });
});

describe("整理时提炼每日笔记", () => {
  it("把上次以来的笔记（不含今天）交给模型，记下的进 MEMORY.md / USER.md 带出处；下次只看新的", async () => {
    const env = setup();
    const d5 = env.note(5, ["20:00 主人说以后周三晚上不要提醒他锻炼，他要加班"]);
    env.note(3, ["21:00 [heartbeat] 例行检查，没事"]);
    env.note(0, ["09:00 今天的，还在写"]);
    env.fake.queue.push(json({ long: [{ text: "周三晚上不提醒主人锻炼（他加班）", from: d5, how: "主人说的" }], user: [{ text: "主人周三晚上加班", from: d5 }], summary: "记下一条约定" }));
    env.fake.queue.push(json({ user: ["主人叫小明", "主人周三晚上加班"], ops: [], summary: "" }));
    const r = await env.tidy.run("main", "manual");
    expect(r.status).toBe("done");
    const distillCall = env.fake.calls[0].full;
    expect(distillCall).toContain(`=== ${d5} ===`);
    expect(distillCall).toContain("不要提醒他锻炼");
    expect(distillCall).not.toContain("还在写");
    expect(fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8")).toContain(`周三晚上不提醒主人锻炼（他加班） <!-- 出处 daily:${d5}；主人说的 -->`);
    expect(fs.readFileSync(path.join(env.ws, "USER.md"), "utf8")).toContain("- 主人周三晚上加班");
    expect(r.daily).toMatchObject({ long: 1, user: 1, left: 0 });
    expect(describeTidy(r)).toContain("天的每日笔记里记下 1 条长期记忆、1 条关于你的");
    // 再整理：没有新笔记，不再问模型提炼
    const n = env.fake.calls.length;
    env.fake.queue.push(json({ user: ["主人叫小明", "主人周三晚上加班"], ops: [], summary: "" }));
    await env.tidy.run("main", "manual");
    expect(env.fake.calls.length).toBe(n + 1);
    expect(env.fake.calls.at(-1).full).not.toContain("每日笔记：");
  });

  it("相关的已有记忆交给模型去重；提炼出错不耽误整理，那几天下次再看", async () => {
    const env = setup({ related: async () => ["家里的猫叫团子"] });
    env.note(4, ["20:00 主人说团子最近挑食，换了鸡肉味猫粮"]);
    env.fake.queue.push("我没看懂");
    env.fake.queue.push(json({ user: ["主人叫小明"], ops: [], summary: "" }));
    const r = await env.tidy.run("main", "manual");
    expect(env.fake.calls[0].full).toContain("相关的已有记忆");
    expect(env.fake.calls[0].full).toContain("- 家里的猫叫团子");
    expect(r.daily!.why).toContain("没按格式");
    expect(describeTidy(r)).toContain("每日笔记没提炼成");
    // 下次再看
    env.fake.queue.push(json({ long: [{ text: "团子挑食，现在吃鸡肉味猫粮", from: "x", how: "主人说的" }], user: [], summary: "" }));
    env.fake.queue.push(json({ user: ["主人叫小明"], ops: [], summary: "" }));
    const r2 = await env.tidy.run("main", "manual");
    expect(r2.daily!.long).toBe(1);
    // from 不像日期：用那段笔记的最后一天
    expect(fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8")).toMatch(/鸡肉味猫粮 <!-- 出处 daily:\d{4}-\d{2}-\d{2}；主人说的 -->/);
  });

  it("积压多：一趟最多几段，剩下的下次接着；60 天前的不看", async () => {
    const env = setup();
    const big = "主人说了很多很多的话。".repeat(1300); // 每天一段
    for (let d = 2; d <= DAILY_MAX_CALLS + 3; d++) env.note(d, [big]);
    env.note(90, ["很久以前"]);
    for (let i = 0; i < DAILY_MAX_CALLS; i++) env.fake.queue.push(json({ long: [], user: [], summary: "" }));
    env.fake.queue.push(json({ user: ["主人叫小明"], ops: [], summary: "" }));
    const r = await env.tidy.run("main", "manual");
    expect(r.daily!.days).toHaveLength(DAILY_MAX_CALLS);
    expect(r.daily!.left).toBe(2);
    expect(env.fake.calls.map((c: any) => c.full).join("\n")).not.toContain("很久以前");
  });
});
