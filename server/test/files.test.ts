// 文件工具：读（行号、分段）、改（唯一匹配、先读后改、改完回显）、写、搜、找；权限同 exec
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { parseToolsConfig } from "../src/config.ts";
import { fileTools, forgetReads, globRe, FILE_TOOLS } from "../src/agent/tools/files.ts";
import { guestLocked } from "../src/agent/toolpolicy.ts";

const scopeOf = (o: any = {}): any => ({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", purpose: "chat", hop: 0, chain: [], meta: {}, trusted: true, ...o });
const text = (r: any) => r.content[0].text as string;

function setup() {
  const env = makeRuntime();
  const a = env.reg.get("main")!;
  const tools = (o: any = {}) => Object.fromEntries(fileTools(parseToolsConfig({}))(scopeOf(o), a).map((t) => [t.name, (args: any) => t.execute("t", args) as Promise<any>]));
  return { ...env, ws: a.workspace, t: tools(), tools };
}

beforeEach(() => forgetReads());

describe("文件工具", () => {
  it("read_file：带行号；长文件分段读、提示从哪接着读；目录、不存在、二进制都给明白的报错", async () => {
    const { ws, t } = setup();
    fs.writeFileSync(path.join(ws, "a.txt"), Array.from({ length: 500 }, (_, i) => `第${i + 1}行`).join("\n") + "\n");
    const r1 = text(await t.read_file({ path: "a.txt" }));
    expect(r1.split("\n")[0]).toBe("    1→第1行");
    expect(r1).toContain("共 500 行，这次读到第 400 行；接着读用 offset=401");
    const r2 = text(await t.read_file({ path: "a.txt", offset: 499, limit: 5 }));
    expect(r2).toBe("  499→第499行\n  500→第500行");
    expect((await t.read_file({ path: "nope.txt" })).isError).toBe(true);
    expect(text(await t.read_file({ path: "." }))).toContain("是目录");
    fs.writeFileSync(path.join(ws, "b.bin"), Buffer.from([1, 0, 2, 3]));
    expect(text(await t.read_file({ path: "b.bin" }))).toContain("二进制");
  });

  it("edit_file：没读过不让改；唯一匹配才改、多处要 replace_all；带了行号会提示；改完回显那几行；别人改过要重读", async () => {
    const { ws, t } = setup();
    const f = path.join(ws, "cfg.py");
    fs.writeFileSync(f, "A = 1\nB = 2\nC = 1\nD = 4\n");
    expect(text(await t.edit_file({ path: "cfg.py", old: "B = 2", new: "B = 3" }))).toContain("先用 read_file 读一遍");
    await t.read_file({ path: "cfg.py" });
    const r = text(await t.edit_file({ path: "cfg.py", old: "B = 2", new: "B = 3" }));
    expect(r).toContain("    2→B = 3");
    expect(fs.readFileSync(f, "utf8")).toBe("A = 1\nB = 3\nC = 1\nD = 4\n");
    expect(text(await t.edit_file({ path: "cfg.py", old: " = 1", new: " = 9" }))).toContain("出现了 2 次");
    expect(text(await t.edit_file({ path: "cfg.py", old: " = 1", new: " = 9", replace_all: true }))).toContain("替换了 2 处");
    expect(text(await t.edit_file({ path: "cfg.py", old: "    4→D = 4", new: "D = 5" }))).toContain("带了 read_file 的行号");
    // 别人（或她用 exec）在读过之后改了文件：先重读
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(f, "全换了\n");
    expect(text(await t.edit_file({ path: "cfg.py", old: "全换了", new: "x" }))).toContain("被改过了");
  });

  it("edit_file 认 Windows 换行；write_file 新建自动建目录、重写已有文件也要先读", async () => {
    const { ws, t } = setup();
    const f = path.join(ws, "win.txt");
    fs.writeFileSync(f, "一\r\n二\r\n三\r\n");
    await t.read_file({ path: "win.txt" });
    await t.edit_file({ path: "win.txt", old: "一\n二", new: "壹\n贰" });
    expect(fs.readFileSync(f, "utf8")).toBe("壹\r\n贰\r\n三\r\n");
    expect(text(await t.write_file({ path: "notes/new.md", content: "# 新\n内容\n" }))).toContain("已新建 notes/new.md");
    expect(fs.readFileSync(path.join(ws, "notes/new.md"), "utf8")).toBe("# 新\n内容\n");
    fs.writeFileSync(path.join(ws, "old.md"), "旧\n");
    expect((await t.write_file({ path: "old.md", content: "新" })).isError).toBe(true);
    await t.read_file({ path: "old.md" });
    expect(text(await t.write_file({ path: "old.md", content: "新" }))).toContain("已重写");
    // 刚写完的接着改，不用再读一遍
    expect((await t.edit_file({ path: "old.md", old: "新", new: "更新" })).isError).toBeFalsy();
  });

  it("search_files 按正则搜、glob 过滤、跳过 node_modules；list_files 按通配找", async () => {
    const { ws, t } = setup();
    fs.mkdirSync(path.join(ws, "src/sub"), { recursive: true });
    fs.mkdirSync(path.join(ws, "node_modules/x"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src/a.py"), "def hello():\n    return 1\n");
    fs.writeFileSync(path.join(ws, "src/sub/b.py"), "# hello world\n");
    fs.writeFileSync(path.join(ws, "src/c.md"), "hello md\n");
    fs.writeFileSync(path.join(ws, "node_modules/x/d.py"), "hello\n");
    const all = text(await t.search_files({ pattern: "hello", path: "src" }));
    expect(all.split("\n").sort()).toEqual(["a.py:1: def hello():", "c.md:1: hello md", "sub/b.py:1: # hello world"]);
    expect(text(await t.search_files({ pattern: "HELLO", glob: "*.py", ignore_case: true }))).not.toContain("c.md");
    expect(text(await t.search_files({ pattern: "hello" }))).not.toContain("node_modules");
    expect((await t.search_files({ pattern: "(" })).isError).toBe(true);
    expect(text(await t.list_files({ pattern: "**/*.py" }))).toMatch(/src\/a\.py.*\n.*src\/sub\/b\.py|src\/sub\/b\.py.*\n.*src\/a\.py/);
    expect(text(await t.list_files({ pattern: "*.md", path: "src" }))).toContain("c.md");
    expect(globRe("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globRe("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globRe("*.{py,md}").test("x.md")).toBe(true);
  });

  it("权限同 exec：陌生人、exec 关掉时都没有；永远不给群聊（toolpolicy 锁着）", () => {
    const { reg } = setup();
    const a = reg.get("main")!;
    expect(fileTools(parseToolsConfig({}))(scopeOf({ trusted: false }), a)).toEqual([]);
    expect(fileTools(parseToolsConfig({ exec: { enabled: false } }))(scopeOf(), a)).toEqual([]);
    for (const n of FILE_TOOLS) expect(guestLocked(n)).toBe(true);
  });
});
