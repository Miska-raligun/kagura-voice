// M4：记忆的检索、写入、冲刷、索引增量、路径限制
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { MemoryIndex, chunkMarkdown, ftsQuery, type Embedder } from "../src/agent/memory.ts";
import { Memories } from "../src/agent/tools/memory.ts";
import { resolveInside } from "../src/agent/paths.ts";

function setup(embedder: Embedder | null = null) {
  const env = makeRuntime();
  const mem = new Memories(env.rt, embedder);
  env.rt.addTools(mem.tools());
  env.rt.beforeCompact = (a, k) => mem.flush(a, k);
  const a = env.reg.get("main")!;
  return { ...env, mem, a };
}

describe("关键词检索", () => {
  it("两字中文词、自然语言提问、英文都能搜到；改文件后增量重建", async () => {
    const { mem, a } = setup();
    fs.writeFileSync(path.join(a.workspace, "MEMORY.md"), "# 长期记忆\n\n- 主人喜欢喝无糖乌龙茶，不喜欢香菜\n\n- 猫咪叫团子\n");
    fs.writeFileSync(path.join(a.workspace, "memory", "2026-10-20.md"), "# 2026-10-20\n\n- 主人下周三去杭州出差，记得提醒带 iPhone 充电器\n");
    const idx = mem.of("main");
    expect((await idx.search("香菜"))[0].text).toContain("香菜");
    expect((await idx.search("主人喜欢喝什么茶"))[0].text).toContain("乌龙茶");
    expect((await idx.search("iphone"))[0].path).toBe("memory/2026-10-20.md");
    expect(await idx.search("火星")).toEqual([]);
    // 手改文件（管理 UI 编辑）后马上能搜到，旧内容搜不到
    fs.writeFileSync(path.join(a.workspace, "MEMORY.md"), "- 主人最近改喝咖啡了\n");
    const st = fs.statSync(path.join(a.workspace, "MEMORY.md"));
    fs.utimesSync(path.join(a.workspace, "MEMORY.md"), st.atime, new Date(st.mtimeMs + 5000));
    expect((await idx.search("咖啡"))[0].text).toContain("咖啡");
    expect(await idx.search("香菜")).toEqual([]);
    // 删掉的文件从索引里清掉
    fs.unlinkSync(path.join(a.workspace, "memory", "2026-10-20.md"));
    expect(await idx.search("杭州")).toEqual([]);
  });

  it("切块带行号；查询串拆两字短语", () => {
    const c = chunkMarkdown("# 标题\n\n第一段\n续行\n\n第二段");
    expect(c.map((x) => [x.start, x.end])).toEqual([[1, 1], [3, 4], [6, 6]]);
    expect(ftsQuery("喝茶 ok")).toBe('"喝 茶" OR "ok"');
    expect(ftsQuery("猫")).toBe('"猫"');
  });
});

describe("向量检索", () => {
  it("配了嵌入接口：关键词搜不到的近义说法靠向量找回；嵌入挂了退化为关键词", async () => {
    // 假嵌入：按「茶/饮料」「猫/宠物」两个维度
    let broken = false;
    const emb: Embedder = {
      async embed(ts) {
        if (broken) throw new Error("down");
        return ts.map((t) => Float32Array.from([/茶|饮料|喝/.test(t) ? 1 : 0, /猫|宠物/.test(t) ? 1 : 0, 0.01]));
      },
    };
    const { mem, a } = setup(emb);
    fs.writeFileSync(path.join(a.workspace, "MEMORY.md"), "- 主人爱喝乌龙茶\n\n- 家里的猫叫团子\n");
    const idx = mem.of("main");
    const hits = await idx.search("宠物");
    expect(hits[0].text).toContain("团子");
    expect(hits[0].via).toBe("vector");
    broken = true;
    expect((await idx.search("团子"))[0].via).toBe("keyword");
  });
});

describe("记忆工具", () => {
  it("memory_write 写今天的笔记 / MEMORY.md，之后 memory_search 搜得到", async () => {
    const { rt, fake, a } = setup();
    fake.queue.push({ tool_calls: [{ name: "memory_write", args: { target: "long", text: "主人生日是 3 月 14 日" } }, { name: "memory_write", args: { target: "daily", text: "今天一起看了电影" } }], then: "记住啦" });
    const r = await rt.run({ kind: "main", channel: "device", agentId: "main", sessionKey: "main:main", text: "记住我生日" });
    expect(r.text).toBe("记住啦");
    expect(fs.readFileSync(path.join(a.workspace, "MEMORY.md"), "utf8")).toContain("- 主人生日是 3 月 14 日");
    const daily = fs.readdirSync(path.join(a.workspace, "memory"));
    expect(daily.length).toBe(1);
    fake.queue.push({ tool_calls: [{ name: "memory_search", args: { query: "生日" } }], then: "3 月 14" });
    await rt.run({ kind: "main", channel: "device", agentId: "main", sessionKey: "main:main", text: "我生日哪天" });
    const tr = rt.store("main").history("main:main").map((h) => h.msg as any).filter((m) => m.role === "toolResult").at(-1);
    expect(tr.content[0].text).toContain("3 月 14 日");
  });

  it("memory_get 只能读记忆和人设文件，越界与符号链接都拒绝", async () => {
    const { a } = setup();
    expect(() => Memories.memoryPath(a, "../agent.json")).toThrow();
    expect(Memories.memoryPath(a, "SOUL.md")).toContain("SOUL.md");             // 没加载的人设文件要能现读
    expect(() => Memories.memoryPath(a, "files/x.md")).toThrow();
    expect(() => Memories.memoryPath(a, "memory/../../agent.json")).toThrow();
    expect(Memories.memoryPath(a, "memory/2026-10-01.md")).toContain("memory");
    fs.symlinkSync("/etc", path.join(a.workspace, "files", "etc"));
    expect(() => resolveInside(a.workspace, "files/etc/passwd")).toThrow(/符号链接/);
    expect(() => resolveInside(a.workspace, "/etc/passwd")).toThrow();
  });

  it("其他 agent 的记忆互不可见（按 agent 分库、分 workspace）", async () => {
    const { mem, reg } = setup();
    fs.writeFileSync(path.join(reg.get("mio")!.workspace, "MEMORY.md"), "- 小澪的秘密：喜欢草莓\n");
    expect(await mem.of("main").search("草莓")).toEqual([]);
    expect((await mem.of("mio").search("草莓")).length).toBe(1);
  });
});

describe("压缩前冲刷", () => {
  it("超阈值时先跑一轮只给 memory_write 的冲刷，写进记忆、不进对话历史", async () => {
    const { rt, reg, fake, a } = setup();
    reg.update("main", { compaction: { max_tokens: 20, keep_messages: 2 } });
    const key = "main:main";
    fake.queue.push("好呀好呀好呀好呀好呀好呀");
    await rt.run({ kind: "main", channel: "device", agentId: "main", sessionKey: key, text: "我下个月要搬家到上海了哦哦哦" });
    fake.queue.push("嗯嗯嗯嗯嗯嗯嗯嗯嗯");
    await rt.run({ kind: "main", channel: "device", agentId: "main", sessionKey: key, text: "还要带上猫猫猫猫猫猫" });
    // 第三轮开始前触发：冲刷（memory_write）→ 摘要 → 正常回复
    fake.queue.push({ tool_calls: [{ name: "memory_write", args: { target: "long", text: "主人下个月搬家到上海" } }], then: "NO_REPLY" }, "摘要：主人要搬家", "好的");
    const r = await rt.run({ kind: "main", channel: "device", agentId: "main", sessionKey: key, text: "你记得吗" });
    expect(r.text).toBe("好的");
    expect(fs.readFileSync(path.join(a.workspace, "MEMORY.md"), "utf8")).toContain("搬家到上海");
    expect(fake.calls.map((c) => c.purpose)).toEqual(["chat", "chat", "flush", "compact", "chat"]);
    const hist = rt.store("main").history(key).map((h) => JSON.stringify(h.msg)).join("");
    expect(hist).not.toContain("NO_REPLY");
    expect(rt.store("main").getSession(key)!.summary).toBe("摘要：主人要搬家");
  });
});

describe("自动回忆（长期记忆不整篇注入）", () => {
  it("只挑真正相关的：常见词单独命中不算；今天 / 昨天的笔记已在提示里就不重复", async () => {
    const { mem, a } = setup();
    fs.writeFileSync(path.join(a.workspace, "MEMORY.md"), "- 主人爱喝无糖乌龙茶\n\n- 今天的事情很多\n\n- 家里的猫叫团子\n");
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayRel = `memory/${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.md`;
    fs.writeFileSync(path.join(a.workspace, todayRel), "- 下午给乌龙茶续了一壶\n");
    const idx = mem.of("main");
    const hits = await idx.recall("帮我泡杯乌龙茶吧", { skip: [todayRel] });
    expect(hits.map((h) => h.text)).toEqual(["- 主人爱喝无糖乌龙茶"]);
    expect(await idx.recall("今天好累")).toEqual([]);          // 只撞上「今天」一个词
    expect(await idx.recall("嗯嗯")).toEqual([]);             // 太短不搜
  });

  it("每轮自动附上相关记忆：模型看得到，落盘的历史里没有", async () => {
    const { rt, mem, fake, a } = setup();
    rt.recall = async (ag, text, skip) => (await mem.of(ag.id).recall(text, { skip })).map((h) => ({ line: `${h.path}：${h.text}`, why: "" }));
    fs.writeFileSync(path.join(a.workspace, "MEMORY.md"), "- 主人爱喝无糖乌龙茶\n");
    fake.queue.push("好的", "嗯");
    await rt.run({ kind: "main", channel: "device", agentId: "main", sessionKey: "main:main", text: "帮我泡杯乌龙茶吧", trusted: true });
    expect(fake.calls.at(-1).full).toContain("[相关记忆");
    expect(fake.calls.at(-1).full).toContain("无糖乌龙茶");
    expect(fake.calls.at(-1).system).not.toContain("无糖乌龙茶");
    expect(JSON.stringify(rt.store("main").history("main:main").map((h) => h.msg))).not.toContain("相关记忆");
    // 陌生人那边不附
    await rt.run({ kind: "chat", channel: "feishu", agentId: "main", sessionKey: "main:feishu:g", text: "帮我泡杯乌龙茶吧", trusted: false });
    expect(fake.calls.at(-1).full).not.toContain("相关记忆");
  });

  it("target=user 写进 USER.md 末尾的自动记录一节：不碰手写部分、不重复、满了改记 MEMORY.md", () => {
    const { mem, a } = setup();
    const f = path.join(a.workspace, "USER.md");
    fs.writeFileSync(f, "# 主人\n叫小明\n");
    const idx = mem.of("main");
    expect(idx.write("user", "女儿叫朵朵")).toBe("USER.md");
    idx.write("user", "女儿叫朵朵");
    idx.write("user", "晚上十一点睡");
    const t = fs.readFileSync(f, "utf8");
    expect(t.startsWith("# 主人\n叫小明\n\n## 自动记录")).toBe(true);
    expect(t.match(/朵朵/g)!.length).toBe(1);
    expect(t.trimEnd().endsWith("- 晚上十一点睡")).toBe(true);
    expect(idx.write("user", "很长".repeat(800))).toBe("MEMORY.md");
  });
});


describe("自动回忆不再随机", () => {
  it("清单每一项单独成块；只命中常用词（主人 / 今天…）的不附；很少见的词中一个就够", async () => {
    expect(chunkMarkdown("# 长期记忆\n- 主人爱喝乌龙茶\n- 家里的猫叫团子\n  它很胖\n1. 下周去杭州").map((c) => [c.start, c.end, c.text]))
      .toEqual([[1, 1, "# 长期记忆"], [2, 2, "- 主人爱喝乌龙茶"], [3, 4, "- 家里的猫叫团子\n  它很胖"], [5, 5, "1. 下周去杭州"]]);
    const { mem, a } = setup();
    fs.writeFileSync(path.join(a.workspace, "MEMORY.md"), "# 长期记忆\n- 主人爱喝无糖乌龙茶\n- 家里的猫叫团子\n- 主人下周去杭州出差\n- 主人今天说想学吉他\n- 主人今天心情不错\n");
    const idx = mem.of("main");
    const r1 = await idx.recall("帮我泡杯乌龙茶吧");
    expect(r1.map((h) => h.text)).toEqual(["- 主人爱喝无糖乌龙茶"]);          // 以前整串五条一起附上
    expect(r1[0].terms).toEqual(expect.arrayContaining(["乌龙", "龙茶"]));
    expect(await idx.recall("主人今天有点累")).toEqual([]);                    // 只撞上常用词
    expect((await idx.recall("团子在干嘛呢")).map((h) => h.text)).toEqual(["- 家里的猫叫团子"]);
  });
});
