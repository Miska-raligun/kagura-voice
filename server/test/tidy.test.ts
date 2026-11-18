// 记忆整理：合并 / 删过时 / 挪动；手写部分不动；备份、归档；删太多、格式不对不写；定期跑、失败第二天再试
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { MemoryTidy, tidyTools, describe as describeTidy, ARCHIVE_FILE, DOC_ARCHIVE, parseTidy, parseDocOps, RESUME_MAX } from "../src/agent/tidy.ts";
import { setSharedDir } from "../src/agent/persona.ts";
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
    // 按编号改：MEMORY.md 里 [1] 猫 [2] heartbeat 流水 [3] 吉他课 [4] Postgres
    fake.queue.push("```json\n" + json({
      user: ["女儿叫朵朵，今年五岁"],
      ops: [{ op: "delete", n: 2, why: "流水" }, { op: "to_user", n: 3 }],
      summary: "合并了女儿的两条，吉他课挪进 USER",
    }) + "\n```");
    const r = await t.run("main", "manual");
    expect(r.status).toBe("done");
    const user = fs.readFileSync(path.join(ws, "USER.md"), "utf8");
    expect(user.startsWith("# 主人\n叫小明，手写的\n\n")).toBe(true);
    expect(user).toContain(`${USER_AUTO_HEAD}\n- 女儿叫朵朵，今年五岁\n- 主人每周日晚上上吉他课\n`);
    expect(fs.readFileSync(path.join(ws, "MEMORY.md"), "utf8")).toBe("# 长期记忆\n- 家里的猫叫团子\n- 项目 A 用 Postgres\n");
    const arch = fs.readFileSync(path.join(ws, ARCHIVE_FILE), "utf8");
    expect(arch).toContain("- 2026-11-01 22:14 heartbeat 没事（流水）");
    expect(r.backups!.length).toBe(2);
    expect(fs.readFileSync(r.backups!.find((b) => b.endsWith("MEMORY.md"))!, "utf8")).toContain("heartbeat 没事");
    const text = describeTidy(r);
    expect(text).toContain("MEMORY.md 4 → 2 条");
    expect(text).toContain(`移出了 1 条（放在 ${ARCHIVE_FILE}，没真删）`);
    // 交给模型看的是带编号的条目
    expect(fake.calls.at(-1).full).toContain("[1] 家里的猫叫团子");
  });

  it("删得太多、格式不对、被截断：一律不写，文件原样；USER 里超长的放回 MEMORY", async () => {
    const { ws, t, fake } = setup();
    const before = [fs.readFileSync(path.join(ws, "USER.md"), "utf8"), fs.readFileSync(path.join(ws, "MEMORY.md"), "utf8")];
    const same = () => expect([fs.readFileSync(path.join(ws, "USER.md"), "utf8"), fs.readFileSync(path.join(ws, "MEMORY.md"), "utf8")]).toEqual(before);
    fake.queue.push(json({ user: [], ops: [1, 2, 3].map((n) => ({ op: "delete", n })), summary: "" }));
    const r1 = await t.run("main", "manual");
    expect(r1.status).toBe("skipped");
    expect(r1.why).toContain("删得太多");
    same();
    fake.queue.push("我觉得都挺好的");
    expect((await t.run("main", "manual")).status).toBe("failed");
    same();
    const long = "主人".repeat(50);
    fake.queue.push(json({ user: ["女儿叫朵朵，今年五岁", long, "明天周日去看球"], ops: [], summary: "" }));
    expect((await t.run("main", "manual")).status).toBe("done");
    expect(fs.readFileSync(path.join(ws, "USER.md"), "utf8")).not.toContain(long);
    expect(fs.readFileSync(path.join(ws, "MEMORY.md"), "utf8")).toContain(`- ${long}`);
    expect(parseTidy('{"user": "不是数组"}')).toBeNull();
  });

  it("定期：到期、在时段内、她不忙才做，做完告诉主人；没做完的 20 分钟后自动接着做、不吵主人；周期 0 = 不自动做", async () => {
    let busy = true, days = 7;
    const { t, fake, reports } = setup({ busy: () => busy, everyDays: () => days });
    const now = Date.now();
    expect(await t.tick(now)).toEqual([]);                        // 忙
    busy = false;
    fake.queue.push("乱写的", "还是乱写的");                       // 没整理成（关思考重试也不行）：进度存着
    expect(await t.tick(now)).toEqual(["main", "mio"]);              // mio 没有记忆：看一眼就过
    expect(reports).toEqual([]);                                  // 会自动接着做的，不吵主人
    expect(t.pending("main").map((j) => j.kind)).toEqual(["memory"]);
    expect(await t.tick(now + 5 * 60_000)).toEqual([]);           // 5 分钟后：还没到接着做的时候
    fake.queue.push(json({ user: ["女儿叫朵朵，今年五岁"], ops: [{ op: "delete", n: 2, why: "流水" }], summary: "整理了" }));
    expect(await t.tick(now + 25 * 60_000)).toEqual(["main"]);   // 接着做
    expect(t.last("main")!.status).toBe("done");
    expect(t.last("main")!.trigger).toBe("resume");
    expect(reports.at(-1)).toContain("整理了一遍记忆");
    expect(t.pending("main")).toEqual([]);
    expect(await t.tick(now + 3 * 86400_000)).toEqual([]);        // 做完之后要等满 7 天
    days = 0;
    expect(await t.tick(now + 30 * 86400_000)).toEqual([]);
  });

  it("连着没做成：自动接着做到 RESUME_MAX 次就停下、告诉主人一次；主人再点就接着做", async () => {
    const { t, fake, reports } = setup();
    const now = Date.now();
    await t.run("main", "auto", now, "memory");                   // 假模型回「好的。」：没做成
    for (let i = 1; i < RESUME_MAX; i++) await t.tick(now + i * 25 * 60_000);
    expect(t.pending("main")[0].fails).toBe(RESUME_MAX);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("先停下");
    expect(await t.tick(now + 100 * 25 * 60_000)).toEqual([]);    // 不再自动试
    fake.queue.push(json({ user: ["女儿叫朵朵，今年五岁"], ops: [], summary: "" }));
    expect((await t.run("main", "manual", now, "memory")).status).toBe("done");
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

const RULES = `# 守则

## 说话
- 回复要简短，别长篇大论
- 回答尽量短一点，不要太啰嗦
- 主人说「晚安」之后不要再主动发消息

## 教训
- 2026-10-20 那天的发布会提醒已经发过了，今天别再提
- 改完文件要回读确认，不能凭印象说改好了
- 写完记忆要回读，确认写到了对的文件里
- 查资料先用搜索，别凭记忆编
- 主人问价格的时候要给出处链接
- 记不清的事先查记忆再回答，查不到就直说不知道
- 涉及花钱、删除、对外发消息的操作先问主人
- 群聊里别提主人的私事，也别透露家里的安排
- 定时任务的结果只说重点，一两句话
- 主人在开会（日历上有会议）的时候非紧急的事攒到会后再说
`;
const TIDIED = `# 守则

## 说话
- 回复要简短，别长篇大论
- 主人说「晚安」之后不要再主动发消息

## 教训
- 改完文件、写完记忆都要回读确认，不能凭印象说做好了
- 查资料先用搜索，别凭记忆编
- 主人问价格的时候要给出处链接
- 记不清的事先查记忆再回答，查不到就直说不知道
- 涉及花钱、删除、对外发消息的操作先问主人
- 群聊里别提主人的私事，也别透露家里的安排
- 定时任务的结果只说重点，一两句话
- 主人在开会（日历上有会议）的时候非紧急的事攒到会后再说`;
// RULES 拆成块：[1] 回复要简短 [2] 回答尽量短 [3] 晚安 | [4] 发布会 [5] 改完文件 [6] 写完记忆 [7] 查资料 … [13] 开会
const TIDY_OPS = [{ op: "merge", n: 2, into: 1, why: "重复" }, { op: "delete", n: 4, why: "过时" }, { op: "merge", n: 6, into: 5, text: "改完文件、写完记忆都要回读确认，不能凭印象说做好了", why: "合并" }];
const docOut = (ops: any[] = [], summary = "合并了重复的") => JSON.stringify({ ops, summary });

describe("守则文件整理（AGENTS / TOOLS / HEARTBEAT）", () => {
  it("合并重复、删掉过时的；先备份、删掉的进归档；内容很少的不看（不调模型）；SOUL / IDENTITY 不动", async () => {
    const { ws, t, fake } = setup();
    fs.writeFileSync(path.join(ws, "AGENTS.md"), RULES);
    const soul = fs.readFileSync(path.join(ws, "SOUL.md"), "utf8"), ident = fs.readFileSync(path.join(ws, "IDENTITY.md"), "utf8");
    fake.queue.push(docOut(TIDY_OPS));
    const n = fake.calls.length;
    const r = await t.run("main", "manual", Date.now(), "docs");
    expect(fake.calls.length).toBe(n + 1);                 // TOOLS / HEARTBEAT 还是模板那几行：没调模型
    expect(r.status).toBe("done");
    expect(r.memStatus).toBeUndefined();
    expect(r.docs).toEqual([expect.objectContaining({ file: "AGENTS.md", scope: "own", status: "done" })]);
    expect(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8")).toBe(TIDIED + "\n");
    expect(fs.readFileSync(r.docs![0].backup!, "utf8")).toBe(RULES);
    expect(fs.readFileSync(path.join(ws, DOC_ARCHIVE), "utf8")).toContain("- 回答尽量短一点，不要太啰嗦（重复）");
    expect(fs.readFileSync(path.join(ws, "SOUL.md"), "utf8")).toBe(soul);
    expect(fs.readFileSync(path.join(ws, "IDENTITY.md"), "utf8")).toBe(ident);
    const text = describeTidy(r);
    expect(text).toMatch(/AGENTS\.md 整理了（\d+ → \d+ 字）：合并了重复的/);
    expect(text).toContain(`移出了 3 条（放在 ${DOC_ARCHIVE}，没真删）`);
    expect(fake.calls.at(-1).full).toContain("主人说「晚安」之后不要再主动发消息");
  });

  it("删得太多、格式不对：不写，原样；自动整理时没变过的文件不再看，手动照看；和记忆一起整理时各算各的", async () => {
    const { ws, t, fake } = setup();
    const f = path.join(ws, "TOOLS.md");
    fs.writeFileSync(f, RULES.replace("# 守则", "# 工具备注"));
    const before = fs.readFileSync(f, "utf8");
    fake.queue.push(docOut(Array.from({ length: 12 }, (_, i) => ({ op: "delete", n: i + 1, why: "过时" }))));
    const r1 = await t.run("main", "manual", Date.now(), "docs");
    expect(r1.docs![0]).toMatchObject({ file: "TOOLS.md", status: "skipped" });
    expect(describeTidy(r1)).toContain("TOOLS.md 先没动：一次删得太多");
    fake.queue.push("我看了，挺好的", "还是挺好的");                // 没按格式：关思考再试一次，还不行就停下、进度存着
    const r2 = await t.run("main", "manual", Date.now(), "docs");
    expect(r2.docs![0].status).toBe("failed");
    expect(r2.docs![0].why).toContain("进度存着");
    expect(fs.readFileSync(f, "utf8")).toBe(before);
    // 看过、不用改：记下指纹，下次自动整理不再调模型；文件变了才再看
    fake.queue.push(docOut([], "不用改"));
    const r3 = await t.run("main", "manual", Date.now(), "docs");
    expect(r3.status).toBe("nochange");
    expect(describeTidy(r3)).toBe("TOOLS.md 看过了，不用改");
    const n = fake.calls.length;
    expect((await t.run("main", "auto", Date.now(), "docs")).docs).toEqual([]);
    expect(fake.calls.length).toBe(n);
    fs.appendFileSync(f, "- 新加的一条：下载东西放到 D 盘的 downloads 目录\n");
    fake.queue.push(docOut([], "不用改"));
    expect((await t.run("main", "auto", Date.now(), "docs")).docs!.length).toBe(1);
    // 一起整理：记忆没成（乱写），守则不用改 → 整趟算失败，两边各说各的
    fs.appendFileSync(f, "- 再加一条\n");
    fake.queue.push("乱写的", "又乱写的", docOut([], "不用改"));
    const r5 = await t.run("main", "manual");
    expect([r5.status, r5.memStatus, r5.docs![0].status]).toEqual(["failed", "failed", "nochange"]);
    expect(describeTidy(r5)).toMatch(/^记忆整理没做成：.*\nTOOLS\.md 看过了，不用改$/);
  });

  it("有共享人设时：共享那份和 agent 自己的补充各整理各的，补充拿共享那份当参考；系统自动给的用法也当参考", async () => {
    const env = makeRuntime();
    const ws = env.reg.get("main")!.workspace;
    const shared = path.join(env.root, "shared_persona");
    setSharedDir(shared);
    try {
      fs.writeFileSync(path.join(shared, "AGENTS.md"), RULES);
      const own = "# 守则\n\n" + Array.from({ length: 12 }, (_, i) => `- 只对神乐的第 ${i + 1} 条：说话带一点俏皮的语气词，但别每句都带，尤其是主人在忙的时候`).join("\n") + "\n- 回复要简短，别长篇大论\n";
      fs.writeFileSync(path.join(ws, "AGENTS.md"), own);
      const t = new MemoryTidy(env.reg, env.models, { everyDays: () => 7, window: () => "00:00-23:59", busy: () => false, report: async () => {}, guide: () => "<how_to>\n- 看文件用 read_file\n</how_to>" });
      const ownTidied = own.trim().replace("\n- 回复要简短，别长篇大论", "");
      env.fake.queue.push(docOut(TIDY_OPS), docOut([{ op: "delete", n: 13, why: "共享里有" }], "去掉了共享里已有的"));
      const r = await t.run("main", "manual", Date.now(), "docs");
      expect(r.docs!.map((d) => [d.file, d.scope, d.status])).toEqual([["AGENTS.md", "shared", "done"], ["AGENTS.md", "own", "done"]]);
      expect(fs.readFileSync(path.join(shared, "AGENTS.md"), "utf8")).toBe(TIDIED + "\n");
      expect(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8")).toBe(ownTidied + "\n");
      expect(fs.existsSync(path.join(shared, DOC_ARCHIVE))).toBe(true);
      const call = env.fake.calls.at(-1).full as string;
      expect(call).toContain("共享那份 AGENTS.md");
      expect(call).toContain("看文件用 read_file");
      expect(describeTidy(r)).toContain("共享的 AGENTS.md 整理了");
    } finally { setSharedDir(""); }
  });

  it("parseDocOps：认 {ops, summary}（前面有思考也行）；没有 ops 数组就是 null", () => {
    expect(parseDocOps('<think>想</think>{"ops":[{"op":"delete","n":1}],"summary":"删了一条"}')).toEqual({ ops: [{ op: "delete", n: 1 }], summary: "删了一条" });
    expect(parseDocOps("都挺好")).toBeNull();
  });
});

