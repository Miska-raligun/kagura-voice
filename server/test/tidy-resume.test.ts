// 记忆 / 守则文件很长时的整理（2026-11，主人「跑了一年，人设文件都非常长……中断了要能断点续做、自动接着做」）：
// 一段没整理成就切半、关思考重试；还不行就停下，进度（看过哪些、拿到哪些操作）按内容指纹存着，下次只看没看过的；守则文件也按编号改
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { MemoryTidy, describe as describeTidy, TIDY_BATCH_CHARS, DOC_BATCH_CHARS, DOC_ARCHIVE } from "../src/agent/tidy.ts";
import { parseDocUnits, numberedDoc, applyDocOps, cleanDocOps, docBatches } from "../src/agent/tidy-ops.ts";
import { USER_AUTO_HEAD } from "../src/agent/memory.ts";

const json = (o: any) => JSON.stringify(o);
function setup(host: any = {}) {
  const env = makeRuntime();
  const ws = env.reg.get("main")!.workspace;
  const stateFile = path.join(env.root, "memory_tidy.json");
  const mk = () => new MemoryTidy(env.reg, env.models, { everyDays: () => 7, window: () => "00:00-23:59", busy: () => false, report: async () => {}, ...host }, stateFile);
  fs.writeFileSync(path.join(ws, "USER.md"), `# 主人\n手写\n\n${USER_AUTO_HEAD}\n- 主人叫小明\n`);
  return { ...env, ws, mk, t: mk(), stateFile };
}
// 很多条：每节 40 条、每条 ~60 字，三节 ≈ 7 千字 × 3，超过一段的量
const bigMemory = () => "# 长期记忆\n" + ["家里", "工作", "爱好"].map((h, s) => `\n## ${h}\n` + Array.from({ length: 40 }, (_, i) => `- ${h}的第 ${i + 1} 件事：${"这是一条比较长的记忆，用来把这一段撑大一点，".repeat(6)}编号 ${s}-${i}`).join("\n")).join("\n") + "\n";

describe("记忆很多时：分段、失败切半重试、断点续做", () => {
  it("中间一段没整理成：前面的进度存着（重启也在）；她又记了新的，下次只看没看过的和新的；全看完才一起写进文件", async () => {
    const env = setup();
    fs.writeFileSync(path.join(env.ws, "MEMORY.md"), bigMemory());
    const total = 120;
    // 第一段：删第 1 条；第二段（第 2 次调用）开始一直乱写 → 切半重试也不行 → 停下
    env.fake.queue.push(json({ user: ["主人叫小明"], ops: [{ op: "delete", n: 1, why: "过时" }], summary: "第一段" }));
    for (let i = 0; i < 30; i++) env.fake.queue.push("我不会");
    const r1 = await env.t.run("main", "manual", Date.now(), "memory");
    expect(r1.status).toBe("failed");
    expect(r1.resume!.done).toBeGreaterThan(0);
    expect(r1.resume!.done).toBeLessThan(total);
    expect(r1.why).toContain("进度存着");
    expect(fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8")).toContain("家里的第 1 件事");   // 还没写
    const done1 = r1.resume!.done;
    // 停下期间她又记了一条（追加在最后）
    fs.appendFileSync(path.join(env.ws, "MEMORY.md"), "- 主人新养了一条鱼\n");
    env.fake.queue.length = 0;
    // 重启：从状态文件读回进度
    const t2 = env.mk();
    expect(t2.pending("main")[0].reviewed).toBe(done1);
    const n0 = env.fake.calls.length;
    for (let i = 0; i < 10; i++) env.fake.queue.push(json({ ops: [], summary: "" }));
    const r2 = await t2.run("main", "manual", Date.now(), "memory");
    expect(r2.status).toBe("done");
    expect(r2.resumed).toBe(true);
    // 接着做的那几次调用里没有第一段看过的条目，有新记的那条
    const asked = env.fake.calls.slice(n0).map((c: any) => c.full).join("\n");
    expect(asked).not.toContain("家里的第 1 件事");
    expect(asked).toContain("主人新养了一条鱼");
    const mem = fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8");
    expect(mem).not.toContain("家里的第 1 件事：");                          // 第一段拿到的操作最后落上了
    expect(mem).toContain("家里的第 2 件事");
    expect(mem).toContain("主人新养了一条鱼");
    expect(t2.pending("main")).toEqual([]);
    expect(describeTidy(r2)).toContain("接着上次没做完的");
  });

  it("一段被截断 / 没按格式：切成两半、关思考重试，两半都成了就算这一段成了", async () => {
    const env = setup();
    fs.writeFileSync(path.join(env.ws, "MEMORY.md"), "# 长期记忆\n" + Array.from({ length: 40 }, (_, i) => `- 第 ${i + 1} 条：${"一条中等长度的记忆内容，".repeat(4)}`).join("\n") + "\n");
    env.fake.queue.push({ text: '{"user": ["主人叫小明"], "ops": [', stop: "length" } as any);
    env.fake.queue.push(json({ user: ["主人叫小明"], ops: [{ op: "delete", n: 3, why: "过时" }], summary: "前半" }));
    env.fake.queue.push(json({ ops: [{ op: "delete", n: 38, why: "过时" }], summary: "后半" }));
    const n0 = env.fake.calls.length;
    const r = await env.t.run("main", "manual", Date.now(), "memory");
    expect(r.status).toBe("done");
    expect(env.fake.calls.length - n0).toBe(3);
    const second = env.fake.calls[n0 + 1].full as string, third = env.fake.calls[n0 + 2].full as string;
    expect(second).toContain("[1] 第 1 条");
    expect(second).not.toContain("[40] 第 40 条");
    expect(third).toContain("[40] 第 40 条");
    expect(third).toContain("整理在第一段做过了");
    const mem = fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8");
    expect(mem).not.toContain("第 3 条：");
    expect(mem).not.toContain("第 38 条：");
    expect(r.summary).toBe("前半；后半");
  });

  it("全看完了、写之前发现记忆被改过：不写，进度留着；下次只看改过的那条，不用整趟重来", async () => {
    let poke = () => {};
    const env = setup({ usage: () => { return new Map(); } });
    fs.writeFileSync(path.join(env.ws, "MEMORY.md"), "# 长期记忆\n- 家里的猫叫团子\n- 2026-11-01 heartbeat 没事\n- 项目 A 用 Postgres\n");
    // 模型回复的时候「主人在管理界面改了一条」
    const orig = env.fake.nextStep.bind(env.fake);
    env.fake.nextStep = () => { poke(); return orig(); };
    poke = () => { fs.writeFileSync(path.join(env.ws, "MEMORY.md"), "# 长期记忆\n- 家里的猫叫团子\n- 2026-11-01 heartbeat 没事\n- 项目 A 用 MySQL\n"); poke = () => {}; };
    env.fake.queue.push(json({ user: ["主人叫小明"], ops: [{ op: "delete", n: 2, why: "流水" }], summary: "删流水" }));
    const r1 = await env.t.run("main", "manual", Date.now(), "memory");
    expect(r1.status).toBe("skipped");
    expect(r1.why).toContain("下次只看改过的");
    expect(fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8")).toContain("heartbeat 没事");
    env.fake.queue.push(json({ ops: [], summary: "" }));
    const n0 = env.fake.calls.length;
    const r2 = await env.t.run("main", "manual", Date.now(), "memory");
    expect(r2.status).toBe("done");
    const asked = env.fake.calls[n0].full as string;
    expect(asked).toContain("MySQL");
    expect(asked).not.toContain("团子");
    expect(fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8")).toBe("# 长期记忆\n- 家里的猫叫团子\n- 项目 A 用 MySQL\n");
  });
});

describe("守则文件按块编号", () => {
  const DOC = `# 守则

## 说话
- 回复要简短
  续行：尤其是在设备上
1. 第一步先问清楚
2. 第二步再动手

一段说明文字，
跨了两行。

| 名字 | 用途 |
|---|---|
| a | b |

\`\`\`bash
echo hi

echo bye
\`\`\`

## 空节

## 教训
- 改完要回读
- 过时的一条
`;
  it("清单一项连同续行、编号清单、一段话、表格、代码块各算一块；标题、空行原样", () => {
    const p = parseDocUnits(DOC);
    expect(p.units.map((u) => u.text.split("\n")[0])).toEqual(["- 回复要简短", "1. 第一步先问清楚", "2. 第二步再动手", "一段说明文字，", "| 名字 | 用途 |", "```bash", "- 改完要回读", "- 过时的一条"]);
    expect(p.units[0].text).toContain("续行");
    expect(p.units[5].text).toContain("echo bye");
    expect(numberedDoc(p, new Set([7, 8]))).toBe("# 守则\n## 说话\n## 空节\n## 教训\n[7] - 改完要回读\n[8] - 过时的一条");
    // 什么都不改：原样
    expect(applyDocOps(p, []).text).toBe(DOC);
  });

  it("删 / 并 / 改：清单符号补回来；删空了的节连标题一起去掉，本来就空的节不动", () => {
    const p = parseDocUnits(DOC);
    const ops = cleanDocOps([{ op: "delete", n: 8, why: "过时" }, { op: "delete", n: 7 }, { op: "edit", n: 2, text: "先问清楚再说" }, { op: "merge", n: 3, into: 99 }, { op: "nope", n: 1 }], new Set([2, 3, 7, 8]), p.units.length);
    expect(ops.map((o) => o.op)).toEqual(["delete", "delete", "edit"]);
    const r = applyDocOps(p, ops);
    expect(r.text).toContain("1. 先问清楚再说");
    expect(r.text).not.toContain("## 教训");
    expect(r.text).toContain("## 空节");
    expect(r.removed).toEqual([{ text: "过时的一条", why: "过时" }, { text: "改完要回读", why: "" }]);
  });

  it("分段按标题切，看过的块跳过", () => {
    const p = parseDocUnits(DOC);
    expect(docBatches(p, 100_000)).toEqual([new Set([1, 2, 3, 4, 5, 6, 7, 8])]);
    expect(docBatches(p, 100_000, new Set([1, 2, 3, 4, 5, 6]))).toEqual([new Set([7, 8])]);
    expect(docBatches(p, 60).length).toBeGreaterThan(2);
  });

  it("几万字的守则文件：分段整理（输出只是操作，不再被截断）；中间断了接着做，做完一次写入", async () => {
    const env = setup();
    const f = path.join(env.ws, "AGENTS.md");
    const big = "# 守则\n" + Array.from({ length: 12 }, (_, s) => `\n## 第 ${s + 1} 节\n` + Array.from({ length: 30 }, (_, i) => `- 规矩 ${s}-${i}：${"要遵守的一条比较长的规矩说明，".repeat(4)}`).join("\n")).join("\n") + "\n";
    fs.writeFileSync(f, big);
    expect(Array.from(big).length).toBeGreaterThan(DOC_BATCH_CHARS * 2);
    // 第一段删掉第 1 块，第二段开始一直乱写
    env.fake.queue.push(json({ ops: [{ op: "delete", n: 1, why: "过时" }], summary: "删了一条" }));
    for (let i = 0; i < 30; i++) env.fake.queue.push("嗯");
    const r1 = await env.t.run("main", "manual", Date.now(), "docs");
    const d1 = r1.docs!.find((d) => d.file === "AGENTS.md")!;
    expect(d1.status).toBe("failed");
    expect(d1.resume!.done).toBeGreaterThan(0);
    expect(fs.readFileSync(f, "utf8")).toBe(big);
    env.fake.queue.length = 0;
    for (let i = 0; i < 20; i++) env.fake.queue.push(json({ ops: [], summary: "不用改" }));
    const r2 = await env.t.run("main", "manual", Date.now(), "docs");
    const d2 = r2.docs!.find((d) => d.file === "AGENTS.md")!;
    expect(d2.status).toBe("done");
    expect(d2.resumed).toBe(true);
    const now = fs.readFileSync(f, "utf8");
    expect(now).not.toContain("规矩 0-0：");
    expect(now).toContain("规矩 0-1：");
    expect(fs.readFileSync(path.join(env.ws, DOC_ARCHIVE), "utf8")).toContain("规矩 0-0");
    expect(env.t.pending("main")).toEqual([]);
  });
});

it("常量合理：记忆一段的字数比守则大（记忆条目短、操作多）", () => { expect(TIDY_BATCH_CHARS).toBeGreaterThan(DOC_BATCH_CHARS); });

it("接着做时 USER.md 自动记录变过：停下期间新记的补上，主人删掉的不会被加回来", async () => {
  const env = setup();
  fs.writeFileSync(path.join(env.ws, "USER.md"), `# 主人\n手写\n\n${USER_AUTO_HEAD}\n- 主人叫小明\n- 主人喜欢喝茶\n`);
  fs.writeFileSync(path.join(env.ws, "MEMORY.md"), "# 长期记忆\n" + ["家里", "工作", "爱好"].map((h) => `\n## ${h}\n` + Array.from({ length: 40 }, (_, i) => `- ${h} ${i}：${"一条比较长的记忆内容，".repeat(12)}`).join("\n")).join("\n") + "\n");
  env.fake.queue.push(json({ user: ["主人叫小明", "主人喜欢喝茶（绿茶）"], ops: [], summary: "" }));
  for (let i = 0; i < 30; i++) env.fake.queue.push("嗯");
  expect((await env.t.run("main", "manual", Date.now(), "memory")).status).toBe("failed");
  // 停下期间：她记了一条新的；主人删掉了「叫小明」
  fs.writeFileSync(path.join(env.ws, "USER.md"), `# 主人\n手写\n\n${USER_AUTO_HEAD}\n- 主人喜欢喝茶\n- 主人的生日是 3 月 6 日\n`);
  env.fake.queue.length = 0;
  for (let i = 0; i < 10; i++) env.fake.queue.push(json({ ops: [], summary: "" }));
  expect((await env.t.run("main", "manual", Date.now(), "memory")).status).toBe("done");
  const user = fs.readFileSync(path.join(env.ws, "USER.md"), "utf8");
  expect(user).toContain("- 主人喜欢喝茶（绿茶）");
  expect(user).toContain("- 主人的生日是 3 月 6 日");
  expect(user).not.toContain("小明");
});
