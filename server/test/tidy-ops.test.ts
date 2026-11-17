// 记忆整理「按编号改」：没提到的不动、各种操作落到文件上、「常用」节不吞掉后面的条目、大文件分段
import { describe, it, expect } from "vitest";
import { parseFiles, numbered, cleanOps, applyOps, batches } from "../src/agent/tidy-ops.ts";
import { pinnedOf } from "../src/agent/memfmt.ts";

const MEM = "# 长期记忆\n\n- 猫叫团子 <!-- 出处 m1；主人说的 -->\n- 狗叫豆豆\n- 2026-11-01 22:14 heartbeat 没事\n- 主人的妈妈生日 3 月 5 日 <!-- 出处 m5 -->\n- 妈妈生日是三月五号\n- 主人对花生过敏\n";

describe("按编号改", () => {
  it("给模型看的是编号 + 正文（不带出处注释）；操作落到对应的行上，没提到的原样", () => {
    const p = parseFiles([{ file: "MEMORY.md", text: MEM }]);
    expect(numbered(p.files[0])).toContain("[1] 猫叫团子\n[2] 狗叫豆豆");
    expect(numbered(p.files[0])).not.toContain("出处");
    const ops = cleanOps([
      { op: "delete", n: 3, why: "流水" },
      { op: "merge", n: 5, into: 4, why: "重复" },
      { op: "alias", n: 4, words: "母亲、老妈" },
      { op: "correct", n: 4, text: "主人的妈妈生日 3 月 6 日", why: "原文说 6 号" },
      { op: "guess", n: 6 },
      { op: "to_user", n: 2 },
      { op: "explode", n: 1 }, { op: "delete", n: 99 },                 // 认不得的、编号不对的丢掉
    ], new Set(p.items.map((x) => x.n)));
    expect(ops).toHaveLength(6);
    const r = applyOps(p, ops);
    const out = r.files.get("MEMORY.md")!;
    expect(out).toBe("# 长期记忆\n\n- 猫叫团子 <!-- 出处 m1；主人说的 -->\n- 主人的妈妈生日 3 月 6 日〔又：母亲、老妈〕 <!-- 出处 m5 -->\n- 主人对花生过敏 <!-- 出处 ；推测 -->\n");
    expect(r.toUser).toEqual(["狗叫豆豆"]);
    expect(r.removed.map((x) => x.why)).toEqual(["流水", "重复"]);
    expect(r.corrected).toEqual([{ text: "主人的妈妈生日 3 月 6 日", why: "原文说 6 号" }]);
  });

  it("挪进「常用」：没有二级标题的老文件补一个「## 其它」，后面的条目不会被算进常用；挪出来的、主题页索引都在常用外面", () => {
    const p = parseFiles([{ file: "MEMORY.md", text: MEM }]);
    const r = applyOps(p, [{ op: "pin", n: 6 }, { op: "topic", n: 1, name: "宠物" }, { op: "topic", n: 2, name: "宠物" }], { 宠物: "家里的猫狗" });
    const out = r.files.get("MEMORY.md")!;
    expect(pinnedOf(out)).toBe("- 主人对花生过敏");
    expect(out).toContain("## 其它");
    expect(out).toContain("- 宠物：家里的猫狗 → topics/宠物.md");
    expect(r.files.get("topics/宠物.md")).toBe("# 宠物\n\n- 猫叫团子 <!-- 出处 m1；主人说的 -->\n- 狗叫豆豆\n");
    // 再挪出来：常用是最后一节也不会落回去
    const p2 = parseFiles([{ file: "MEMORY.md", text: "# 长期记忆\n\n## 其它\n- 甲\n\n## 常用\n- 乙\n- 丙\n" }]);
    const out2 = applyOps(p2, [{ op: "unpin", n: 2 }]).files.get("MEMORY.md")!;
    expect(pinnedOf(out2)).toBe("- 丙");
    expect(out2).toContain("- 乙");
  });

  it("大文件分段：每段不超过上限，同一节尽量不拆；3 万字分成几段", () => {
    const sec = (h: string, n: number) => `## ${h}\n` + Array.from({ length: n }, (_, i) => `- ${h}的第 ${i} 条记忆，写得长一些凑够字数，看看分段对不对。`).join("\n");
    const text = "# 长期记忆\n" + ["家人", "工作", "打印机", "饮食", "爱好", "健康"].map((h) => sec(h, 150)).join("\n\n");
    const p = parseFiles([{ file: "MEMORY.md", text }]);
    expect(Array.from(text).length).toBeGreaterThan(25_000);
    const g = batches(p, 12_000);
    expect(g.length).toBeGreaterThanOrEqual(3);
    expect(g.reduce((n, s) => n + s.size, 0)).toBe(p.items.length);           // 每条都在某一段里，不重不漏
  });
});
