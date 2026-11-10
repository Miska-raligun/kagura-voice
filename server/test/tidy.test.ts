// 记忆整理：合并 / 删过时 / 挪动；手写部分不动；备份、归档；删太多、格式不对不写；定期跑、失败第二天再试
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { MemoryTidy, tidyTools, describe as describeTidy, ARCHIVE_FILE, parseTidy } from "../src/agent/tidy.ts";
import { USER_AUTO_HEAD } from "../src/agent/memory.ts";

function setup(host: any = {}) {
  const env = makeRuntime();
  const ws = env.reg.get("main")!.workspace;
  const reports: string[] = [];
  const t = new MemoryTidy(env.reg, env.models, { everyDays: () => 7, window: () => "00:00-23:59", busy: () => false, report: async (_a, x) => { reports.push(x); }, ...host });
  fs.writeFileSync(path.join(ws, "USER.md"), `# 主人\n叫小明，手写的\n\n${USER_AUTO_HEAD}\n- 女儿叫朵朵\n- 女儿叫朵朵，今年五岁\n- 明天周日去看球\n`);
  fs.writeFileSync(path.join(ws, "MEMORY.md"), "# 长期记忆\n- 家里的猫叫团子\n- 2026-11-01 22:14 heartbeat 没事\n- 主人每周日晚上上吉他课\n- 项目 A 用 Postgres\n");
  return { ...env, ws, t, reports };
}
const json = (o: any) => JSON.stringify(o);

describe("记忆整理", () => {
  it("合并重复、删掉过时、挪进 USER；手写部分一字不动；改之前备份、删掉的进归档；结果说清楚", async () => {
    const { ws, t, fake } = setup();
    fake.queue.push("```json\n" + json({
      user: ["女儿叫朵朵，今年五岁", "每周日晚上上吉他课"],
      memory_md: "# 长期记忆\n- 家里的猫叫团子\n- 项目 A 用 Postgres",
      removed: [{ text: "明天周日去看球", why: "过时" }, { text: "2026-11-01 22:14 heartbeat 没事", why: "流水" }],
      summary: "合并了女儿的两条，吉他课挪进 USER",
    }) + "\n```");
    const r = await t.run("main", "manual");
    expect(r.status).toBe("done");
    const user = fs.readFileSync(path.join(ws, "USER.md"), "utf8");
    expect(user.startsWith("# 主人\n叫小明，手写的\n\n")).toBe(true);
    expect(user).toContain(`${USER_AUTO_HEAD}\n- 女儿叫朵朵，今年五岁\n- 每周日晚上上吉他课\n`);
    expect(fs.readFileSync(path.join(ws, "MEMORY.md"), "utf8")).toBe("# 长期记忆\n- 家里的猫叫团子\n- 项目 A 用 Postgres\n");
    const arch = fs.readFileSync(path.join(ws, ARCHIVE_FILE), "utf8");
    expect(arch).toContain("- 明天周日去看球（过时）");
    expect(r.backups!.length).toBe(2);
    expect(fs.readFileSync(r.backups!.find((b) => b.endsWith("MEMORY.md"))!, "utf8")).toContain("heartbeat 没事");
    const text = describeTidy(r);
    expect(text).toContain("MEMORY.md 4 → 2 条");
    expect(text).toContain(`移出了 2 条（放在 ${ARCHIVE_FILE}，没真删）`);
    // 整理时用的提示里有今天的日期、两部分内容
    expect(fake.calls.at(-1).full).toContain("家里的猫叫团子");
  });

  it("删得太多、格式不对、被截断：一律不写，文件原样；USER 里超长的放回 MEMORY", async () => {
    const { ws, t, fake } = setup();
    const before = [fs.readFileSync(path.join(ws, "USER.md"), "utf8"), fs.readFileSync(path.join(ws, "MEMORY.md"), "utf8")];
    const same = () => expect([fs.readFileSync(path.join(ws, "USER.md"), "utf8"), fs.readFileSync(path.join(ws, "MEMORY.md"), "utf8")]).toEqual(before);
    fake.queue.push(json({ user: [], memory_md: "# 长期记忆\n- 猫叫团子", removed: [], summary: "" }));
    const r1 = await t.run("main", "manual");
    expect(r1.status).toBe("skipped");
    expect(r1.why).toContain("删得太多");
    same();
    fake.queue.push("我觉得都挺好的");
    expect((await t.run("main", "manual")).status).toBe("failed");
    same();
    const long = "主人".repeat(50);
    fake.queue.push(json({ user: ["女儿叫朵朵，今年五岁", long, "明天周日去看球"], memory_md: "# 长期记忆\n- 家里的猫叫团子\n- 2026-11-01 22:14 heartbeat 没事\n- 主人每周日晚上上吉他课\n- 项目 A 用 Postgres", removed: [], summary: "" }));
    expect((await t.run("main", "manual")).status).toBe("done");
    expect(fs.readFileSync(path.join(ws, "USER.md"), "utf8")).not.toContain(long);
    expect(fs.readFileSync(path.join(ws, "MEMORY.md"), "utf8")).toContain(`- ${long}`);
    expect(parseTidy('{"user": "不是数组", "memory_md": ""}')).toBeNull();
  });

  it("定期：到期、在时段内、她不忙才做，做完告诉主人；没到期不做；失败的第二天再试；周期 0 = 不自动做", async () => {
    let busy = true, days = 7;
    const { t, fake, reports } = setup({ busy: () => busy, everyDays: () => days });
    const now = Date.now();
    expect(await t.tick(now)).toEqual([]);                        // 忙
    busy = false;
    fake.queue.push("乱写的");                                     // 失败
    expect(await t.tick(now)).toEqual(["main", "mio"]);              // mio 没有记忆：看一眼就过
    expect(reports[0]).toContain("记忆整理没做成");
    expect(await t.tick(now + 3600_000)).toEqual([]);             // 一小时后：还不到一天
    fake.queue.push(json({ user: ["女儿叫朵朵，今年五岁"], memory_md: "# 长期记忆\n- 家里的猫叫团子\n- 主人每周日晚上上吉他课\n- 项目 A 用 Postgres\n- 女儿叫朵朵", removed: [{ text: "明天周日去看球", why: "过时" }], summary: "整理了" }));
    expect(await t.tick(now + 25 * 3600_000)).toContain("main");   // 第二天再试
    expect(t.last("main")!.status).toBe("done");
    expect(await t.tick(now + 3 * 86400_000)).toEqual([]);        // 成功之后要等满 7 天
    days = 0;
    expect(await t.tick(now + 30 * 86400_000)).toEqual([]);
  });

  it("memory_tidy 工具只给可信会话（子任务也没有），返回给主人看的那段话", async () => {
    const { t, reg, fake } = setup();
    const scope = (o: any = {}): any => ({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", purpose: "chat", hop: 0, chain: [], meta: {}, trusted: true, ...o });
    expect(tidyTools(t)(scope({ trusted: false }), reg.get("main")!)).toEqual([]);
    expect(tidyTools(t)(scope({ kind: "sub" }), reg.get("main")!)).toEqual([]);
    const [tool] = tidyTools(t)(scope(), reg.get("main")!);
    fake.queue.push(json({ user: ["女儿叫朵朵", "女儿叫朵朵，今年五岁", "明天周日去看球"], memory_md: "# 长期记忆\n- 家里的猫叫团子\n- 2026-11-01 22:14 heartbeat 没事\n- 主人每周日晚上上吉他课\n- 项目 A 用 Postgres", removed: [], summary: "看过了" }));
    const r: any = await tool.execute("t", {});
    expect(r.content[0].text).toContain("没什么要改的");
  });
});
