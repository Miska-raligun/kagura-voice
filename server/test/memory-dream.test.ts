// 借鉴 Anthropic「The components of agent memory」的几处：出处、对照原文核对、常用、主题页、并发写不丢、跨会话搜原文
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { Memories } from "../src/agent/tools/memory.ts";
import { MemoryTidy, capPinned, describe as describeTidy } from "../src/agent/tidy.ts";
import { USER_AUTO_HEAD, provOf, stripProv, provTag, pinnedOf, PINNED_MAX } from "../src/agent/memory.ts";
import { buildSystemPrompt } from "../src/agent/soul.ts";
import { recallTools } from "../src/agent/tools/recall.ts";

const json = (o: any) => JSON.stringify(o);
function setup(host: any = {}) {
  const env = makeRuntime();
  const a = env.reg.get("main")!;
  const mem = new Memories(env.rt, null);
  env.rt.addTools(mem.tools());
  const tidy = new MemoryTidy(env.reg, env.models, { everyDays: () => 7, window: () => "00:00-23:59", busy: () => false, report: async () => {},
    usage: (ag: any) => mem.of(ag.id).usageByText(), ...host });
  return { ...env, a, mem, tidy, ws: a.workspace };
}
const tool = (env: any, name: string, scope: any = {}) => env.rt.allToolNames && (env.rt as any).toolsFor({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", purpose: "chat", hop: 0, chain: [], meta: {}, trusted: true, ...scope }, env.a, { text: "" }).find((t: any) => t.name === name);

describe("出处", () => {
  it("格式：编号 + 怎么知道的；去掉后检索 / 显示都看不到；合并过的条目认得出多个编号", () => {
    const line = `- 主人对花生过敏${provTag("m120", "主人说的")}`;
    expect(line).toBe("- 主人对花生过敏 <!-- 出处 m120；主人说的 -->");
    expect(stripProv(line)).toBe("- 主人对花生过敏");
    expect(provOf("- x <!-- 出处 m12、m80-m95；推测 -->")).toEqual({ refs: ["m12", "m80-m95"], how: "推测" });
    expect(provOf("- 没有出处")).toEqual({ refs: [], how: "" });
  });

  it("memory_write 记进 MEMORY.md 时带上这个会话最后一条的编号和 how；USER.md、每日笔记不带；同一句不重复记", async () => {
    const env = setup();
    const store = env.rt.store("main");
    store.touchSession("main:main", "main", "webchat");
    store.append("main:main", [{ role: "user", content: [{ type: "text", text: "我对花生过敏" }], timestamp: 1 } as any]);
    const last = store.lastId("main:main");
    const w = tool(env, "memory_write");
    await w.execute("1", { target: "long", text: "主人对花生过敏", how: "主人说的" });
    await w.execute("2", { target: "long", text: "主人对花生过敏 <!-- 出处 m1 -->", how: "又说了一遍" });
    await w.execute("3", { target: "user", text: "主人叫小明", how: "主人说的" });
    const memText = fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8");
    expect(memText).toContain(`- 主人对花生过敏 <!-- 出处 m${last}；主人说的 -->`);
    expect(memText.match(/花生/g)!.length).toBe(1);
    expect(fs.readFileSync(path.join(env.ws, "USER.md"), "utf8")).not.toContain("出处");
    // 自动回忆附上的是去掉出处的那句
    const hits = await env.mem.of("main").recall("我能吃花生酱吗");
    expect(hits.map((h) => stripProv(h.text))).toEqual(["- 主人对花生过敏"]);
  });
});

describe("常用", () => {
  const MEM = `# 长期记忆\n## 常用\n- 打印机是拓竹 P2S，在书房 <!-- 出处 m3 -->\n\n## 其它\n- 主人爱喝无糖乌龙茶\n- 团子是家里的猫\n`;
  it("「常用」那节每轮进系统提示（去掉出处）；自动回忆不再重复附它；超上限的挪回下面", async () => {
    const env = setup();
    fs.writeFileSync(path.join(env.ws, "MEMORY.md"), MEM);
    expect(pinnedOf(MEM)).toBe("- 打印机是拓竹 P2S，在书房");
    const sys = buildSystemPrompt({ agent: env.a, scene: "owner" } as any);
    expect(sys).toContain("常用的几条");
    expect(sys).toContain("- 打印机是拓竹 P2S，在书房");
    expect(sys).not.toContain("出处 m3");
    expect(await env.mem.of("main").recall("书房那台打印机是什么型号")).toEqual([]);
    const many = "# 长期记忆\n## 常用\n" + Array.from({ length: 12 }, (_, i) => `- 第${i}条常用的事情，写得比较长一点凑字数 `.repeat(2)).join("\n") + "\n## 其它\n- 别的\n";
    const capped = capPinned(many);
    expect(Array.from(pinnedOf(capped)).length).toBeLessThanOrEqual(PINNED_MAX);
    expect(capped.match(/常用的事情/g)!.length).toBe(many.match(/常用的事情/g)!.length);   // 一条都没丢，只是挪出去了
  });
});

describe("主题页", () => {
  it("topics/ 下的页参与自动回忆、memory_get 读得到", async () => {
    const env = setup();
    fs.writeFileSync(path.join(env.ws, "MEMORY.md"), "# 长期记忆\n- 打印机：拓竹 P2S 的配置和踩过的坑 → topics/打印机.md\n");
    fs.mkdirSync(path.join(env.ws, "topics"));
    fs.writeFileSync(path.join(env.ws, "topics", "打印机.md"), "# 打印机\n- 访问码贴在打印机背后 <!-- 出处 m9 -->\n- 切片要用纹理 PEI 板\n");
    const hits = await env.mem.of("main").recall("打印机的访问码在哪里");
    expect(hits.map((h) => stripProv(h.text))).toContain("- 访问码贴在打印机背后");
    const r = await tool(env, "memory_get").execute("1", { path: "topics/打印机.md" });
    expect(r.content[0].text).toContain("纹理 PEI");
  });
});

describe("整理：对照原文核对、常用、主题页、并发", () => {
  const seed = (env: any, mem: string) => {
    fs.writeFileSync(path.join(env.ws, "USER.md"), `# 主人\n手写\n\n${USER_AUTO_HEAD}\n- 主人叫小明\n`);
    fs.writeFileSync(path.join(env.ws, "MEMORY.md"), mem);
  };

  it("有出处的条目把原文节选交给模型核对；改了的写进结果；核对过的 30 天内不再核对", async () => {
    const asked: string[][] = [];
    const env = setup({ sources: (_a: any, refs: string[]) => { asked.push(refs); return "[#m5 主人] 我妈生日是 3 月 6 号，不是 5 号"; } });
    seed(env, "# 长期记忆\n- 主人的妈妈生日是 3 月 5 日 <!-- 出处 m5；主人说的 -->\n- 没有出处的一条\n");
    env.fake.queue.push(json({ user: ["主人叫小明"], memory_md: "# 长期记忆\n- 主人的妈妈生日是 3 月 6 日〔又：母亲、老妈〕 <!-- 出处 m5；主人说的 -->\n- 没有出处的一条",
      topics: {}, corrected: [{ text: "主人的妈妈生日是 3 月 6 日", why: "原文说是 6 号" }], removed: [], summary: "改了一条" }));
    const r = await env.tidy.run("main", "manual");
    expect(r.status).toBe("done");
    expect(asked).toEqual([["m5"]]);
    const prompt = env.fake.calls.at(-1).full;
    expect(prompt).toContain("C. 出处原文");
    expect(prompt).toContain("不是 5 号");
    expect(fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8")).toContain("3 月 6 日〔又：母亲、老妈〕 <!-- 出处 m5；主人说的 -->");
    expect(describeTidy(r)).toContain("对照当时的对话改了 1 条");
    // 再整理一次：刚核对过的不再要原文
    env.fake.queue.push(json({ user: ["主人叫小明"], memory_md: fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8").trim(), topics: {}, corrected: [], removed: [], summary: "" }));
    await env.tidy.run("main", "manual");
    expect(asked).toHaveLength(1);
    expect(env.fake.calls.at(-1).full).not.toContain("C. 出处原文");
  });

  it("使用情况交给模型；拆出主题页（挪过去、MEMORY.md 留索引）；抄了两份 / 编东西变多的不写", async () => {
    const env = setup();
    const lines = Array.from({ length: 6 }, (_, i) => `- 打印机第 ${i} 条：拓竹 P2S 的一个设置，写长一点让 MEMORY.md 超过拆主题页的门槛。`.repeat(8));
    seed(env, "# 长期记忆\n" + lines.join("\n") + "\n- 主人爱喝无糖乌龙茶\n");
    const idx = env.mem.of("main");
    await idx.sync();
    for (let i = 0; i < 3; i++) { idx.noteRecalled(["- 主人爱喝无糖乌龙茶"]); idx.noteUsed(["- 主人爱喝无糖乌龙茶"], "泡茶", "给你泡无糖乌龙茶"); }
    env.fake.queue.push(json({ user: ["主人叫小明"], memory_md: "# 长期记忆\n## 常用\n- 主人爱喝无糖乌龙茶\n\n## 其它\n- 打印机：拓竹 P2S 的设置 → topics/打印机.md",
      topics: { "打印机": "# 打印机\n" + lines.join("\n") }, corrected: [], removed: [], summary: "拆了主题页" }));
    const r = await env.tidy.run("main", "manual");
    expect(env.fake.calls.at(-1).full).toContain("经常用上：\n- 主人爱喝无糖乌龙茶（想起 3 次，用上 3 次）");
    expect(r.status).toBe("done");
    expect(r.topics).toEqual(["打印机"]);
    expect(fs.readFileSync(path.join(env.ws, "topics", "打印机.md"), "utf8")).toContain("打印机第 5 条");
    expect(pinnedOf(fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8"))).toBe("- 主人爱喝无糖乌龙茶");
    // 主题页把内容抄了一份、MEMORY.md 里也还留着：变多了，不写
    const before = fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8");
    env.fake.queue.push(json({ user: ["主人叫小明"], memory_md: before.trim() + "\n" + lines.join("\n"), topics: { "打印机2": "# 打印机2\n" + lines.join("\n") }, corrected: [], removed: [], summary: "" }));
    const r2 = await env.tidy.run("main", "manual");
    expect(r2.status).toBe("skipped");
    expect(r2.why).toContain("多了很多");
    expect(fs.existsSync(path.join(env.ws, "topics", "打印机2.md"))).toBe(false);
  });

  it("整理期间新记的不丢（接到结果后面）；原来的条目被改 / 删了就不写", async () => {
    let during: (() => void) | null = null;
    const env = setup({ sources: () => { during?.(); return ""; } });
    seed(env, "# 长期记忆\n- 猫叫团子 <!-- 出处 m1 -->\n- 狗叫豆豆\n- 鱼叫泡泡\n");
    const memFile = path.join(env.ws, "MEMORY.md");
    during = () => fs.appendFileSync(memFile, "- 主人下个月去日本 <!-- 出处 m9 -->\n");
    env.fake.queue.push(json({ user: ["主人叫小明"], memory_md: "# 长期记忆\n- 猫叫团子〔又：猫咪〕 <!-- 出处 m1 -->\n- 狗叫豆豆\n- 鱼叫泡泡", topics: {}, corrected: [], removed: [], summary: "" }));
    expect((await env.tidy.run("main", "manual")).status).toBe("done");
    const after = fs.readFileSync(memFile, "utf8");
    expect(after).toContain("猫叫团子〔又：猫咪〕");
    expect(after).toContain("- 主人下个月去日本 <!-- 出处 m9 -->");
    // 主人在管理界面删了一条：不写
    during = () => fs.writeFileSync(memFile, fs.readFileSync(memFile, "utf8").replace("- 鱼叫泡泡\n", ""));
    const snap = () => fs.readFileSync(memFile, "utf8");
    env.fake.queue.push(json({ user: ["主人叫小明"], memory_md: "# 长期记忆\n- 猫叫团子 <!-- 出处 m1 -->\n- 狗叫豆豆〔又：狗狗〕\n- 鱼叫泡泡\n- 主人下个月去日本 <!-- 出处 m9 -->", topics: {}, corrected: [], removed: [], summary: "" }));
    // 让它去核对一下（这样 sources 才会被调到）：把核对记录清掉
    (env.tidy as any).verified = {};
    const r = await env.tidy.run("main", "manual");
    expect(r.status).toBe("skipped");
    expect(r.why).toContain("整理期间记忆被改过");
    expect(snap()).not.toContain("狗狗");
  });
});

describe("跨会话搜原文", () => {
  it("read_ref all_sessions：只在主人参与的会话里找，群聊 / 陌生人的不给", async () => {
    const env = setup();
    env.rt.addTools(recallTools(env.rt, env.reg));
    const store = env.rt.store("main");
    const say = (key: string, ch: string, text: string, owner: boolean) => {
      store.touchSession(key, "chat", ch);
      if (owner) store.db.prepare("UPDATE sessions SET owner = 1 WHERE key = ?").run(key);
      store.append(key, [{ role: "user", content: [{ type: "text", text }], timestamp: 1 } as any]);
    };
    say("main:feishu:ou_owner", "feishu", "那家餐厅叫山海居，在西湖边", true);
    say("main:feishu:group_x", "feishu", "群里有人说山海居不好吃", false);
    const rr = tool(env, "read_ref");
    const r = await rr.execute("1", { query: "山海居", all_sessions: true });
    expect(r.content[0].text).toContain("西湖边");
    expect(r.content[0].text).toContain("session:main:feishu:ou_owner");
    expect(r.content[0].text).not.toContain("不好吃");
    const none = await rr.execute("2", { query: "山海居" });                     // 不加 all_sessions 只搜当前会话
    expect(none.content[0].text).toContain("没找到");
  });
});

describe("按需检索下的两处衔接", () => {
  it("heartbeat 整篇加载 MEMORY.md 时不带出处注释", () => {
    const env = setup();
    fs.writeFileSync(path.join(env.ws, "MEMORY.md"), "# 长期记忆\n- 主人对花生过敏 <!-- 出处 m12；主人说的 -->\n");
    const sys = buildSystemPrompt({ agent: env.a, scene: "heartbeat" } as any);
    expect(sys).toContain("- 主人对花生过敏");
    expect(sys).not.toContain("出处");
  });

  it("「常用」那节不经检索，也照样攒使用统计（提示里带了、回复里用上了）", async () => {
    const env = setup();
    fs.writeFileSync(path.join(env.ws, "MEMORY.md"), "# 长期记忆\n## 常用\n- 打印机是拓竹 P2S，在书房 <!-- 出处 m3 -->\n\n## 其它\n- 团子是家里的猫\n");
    const idx = env.mem.of("main");
    await idx.sync();
    env.rt.recallUsed = (agent: any, raw: string[], q: string, reply: string, pinned?: boolean) => {
      const { pinnedLines } = require("../src/agent/memfmt.ts");
      const lines = pinned ? pinnedLines(fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8")) : [];
      if (lines.length) idx.noteRecalled(lines);
      idx.noteUsed([...raw, ...lines], q, reply);
    };
    env.fake.queue.push("那台拓竹 P2S 在书房呢。");
    await env.rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "打印机放哪了" });
    const u = idx.usageByText().get("打印机是拓竹 P2S，在书房");
    expect(u).toEqual({ recalled: 1, used: 1 });
  });
});

describe("老版本升级上来", () => {
  const OLD = "# 长期记忆\n" + ["主人爱喝乌龙茶", "猫叫团子", "妈妈生日3月5日", "周五打羽毛球", "不吃香菜", "女儿叫朵朵", "车是蓝色的", "常去山海居", "睡前看书", "怕冷"].map((x) => `- ${x}`).join("\n") + "\n";

  it("没有出处、没有别称的老记忆照常被想起；附在消息里的是干净的一句", async () => {
    const env = setup();
    fs.writeFileSync(path.join(env.ws, "MEMORY.md"), OLD);
    const hits = await env.mem.of("main").recall("我妈哪天生日来着");
    expect(hits.map((h) => h.text)).toEqual(["- 妈妈生日3月5日"]);
    const { provShort } = await import("../src/agent/memfmt.ts");
    expect(provShort(hits[0].text)).toBe("- 妈妈生日3月5日");
    expect(provShort("- 主人对花生过敏 <!-- 出处 m12；推测 -->")).toBe("- 主人对花生过敏（推测，主人没确认过；#m12）");
    expect(provShort("- 猫叫团子 <!-- 出处 m3-m9；主人说的 -->")).toBe("- 猫叫团子（#m3-m9）");
  });

  it("第一次整理给每条短记忆都补上别称：字数一下子多了，但不算「变多太多」，照常写入", async () => {
    const env = setup();
    fs.writeFileSync(path.join(env.ws, "USER.md"), `# 主人\n\n${USER_AUTO_HEAD}\n- 主人叫小明\n`);
    fs.writeFileSync(path.join(env.ws, "MEMORY.md"), OLD);
    const withAlias = OLD.trim().split("\n").map((l) => (l.startsWith("- ") ? `${l}〔又：别称一、别称二〕` : l)).join("\n");
    env.fake.queue.push(json({ user: ["主人叫小明"], memory_md: withAlias, topics: {}, corrected: [], removed: [], summary: "补了别称" }));
    const r = await env.tidy.run("main", "manual");
    expect(r.status).toBe("done");
    expect(fs.readFileSync(path.join(env.ws, "MEMORY.md"), "utf8")).toContain("- 猫叫团子〔又：别称一、别称二〕");
  });

  it("旧的整理状态文件（没有 verified）照常读", () => {
    const env = makeRuntime();
    const f = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "tidy-")), "memory_tidy.json");
    fs.writeFileSync(f, JSON.stringify({ agents: { main: { agent: "main", at: 1, trigger: "auto", status: "done" } }, docs: {} }));
    const t = new MemoryTidy(env.reg, env.models, { everyDays: () => 7, window: () => "00:00-23:59", busy: () => false, report: async () => {} }, f);
    expect(t.last("main")?.status).toBe("done");
  });
});
