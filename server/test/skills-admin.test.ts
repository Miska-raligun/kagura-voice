import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { tmpdir } from "./helpers.ts";
import { Skills } from "../src/agent/skills.ts";
import { unzip } from "../src/util/zip.ts";
import { AgentRegistry } from "../src/agent/registry.ts";
import { importOpenClaw, describeImport } from "../src/agent/import-openclaw.ts";

/** 测试用的最小 zip 写入器（deflate；utf8 标志可关，模拟 Windows 资源管理器打的 GBK 包） */
function makeZip(files: Record<string, string | Buffer>, utf8 = true, nameEnc: (s: string) => Buffer = (s) => Buffer.from(s)): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nb = nameEnc(name);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(utf8 ? 0x800 : 0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(utf8 ? 0x800 : 0, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb);
    off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("zip 解包", () => {
  it("deflate、目录、UTF-8 与 GBK 文件名", () => {
    const z = makeZip({ "a/SKILL.md": "---\nname: a\n---\n说明", "a/scripts/run.py": "print(1)" });
    expect(unzip(z).map((e) => [e.name, e.data.toString()])).toEqual([["a/SKILL.md", "---\nname: a\n---\n说明"], ["a/scripts/run.py", "print(1)"]]);
    const gbk = makeZip({ "技能/SKILL.md": "x" }, false, (s) => Buffer.from(new Uint8Array([0xbc, 0xbc, 0xc4, 0xdc, ...Buffer.from(s.slice(2))])));
    expect(unzip(gbk)[0].name).toBe("技能/SKILL.md");
    expect(() => unzip(Buffer.from("not a zip at all, definitely"))).toThrow("不是 zip");
  });
});

describe("技能管理", () => {
  const setup = () => {
    const root = tmpdir("sk");
    const agentsDir = path.join(root, "agents");
    fs.mkdirSync(agentsDir);
    const reg = new AgentRegistry(agentsDir);
    reg.load([{ id: "", name: "神乐", agent: "main", per: 111 }, { id: "mio", name: "小澪", agent: "mio", per: 4 }]);
    return { reg, sk: new Skills(path.join(root, "skills")) };
  };

  it("新建 / 列表 / 文件读写删 / 删除进回收站", () => {
    const { reg, sk } = setup();
    const g = sk.root("~global", reg);
    const d = sk.create(g, "weather", "主人问天气时用", "");
    expect(fs.readFileSync(path.join(d, "SKILL.md"), "utf8")).toContain('description: "主人问天气时用"');
    sk.create(sk.root("mio", reg), "diary", "写日记", "步骤");
    expect(sk.all(reg).map((s) => [s.owner, s.name])).toEqual([["~global", "weather"], ["mio", "diary"]]);
    expect(sk.list(reg.get("mio")!).map((s) => s.name)).toEqual(["diary", "weather"]);
    expect(sk.list(reg.get("main")!).map((s) => s.name)).toEqual(["weather"]);
    sk.writeFile(d, "scripts/get.py", Buffer.from("print('晴')"));
    expect(sk.files(d).map((f) => f.path)).toEqual(["SKILL.md", "scripts/get.py"]);
    expect(() => sk.writeFile(d, "../evil.txt", Buffer.from("x"))).toThrow("越界");
    expect(() => sk.deleteFile(d, "SKILL.md")).toThrow("不能删");
    sk.deleteFile(d, "scripts/get.py");
    expect(() => sk.create(g, "weather", "", "")).toThrow("已经有");
    expect(() => sk.create(g, "../x", "", "")).toThrow("技能名");
    sk.remove(g, "weather");
    expect(fs.existsSync(d)).toBe(false);
    expect(fs.readdirSync(path.join(g, ".trash"))[0]).toMatch(/^weather-/);
    expect(sk.all(reg).map((s) => s.name)).toEqual(["diary"]);
  });

  it("上传技能包：一层文件夹或根上都行；名字取 front-matter；同名要勾覆盖；跳过 __MACOSX / node_modules", () => {
    const { reg, sk } = setup();
    const g = sk.root("~global", reg);
    const z1 = unzip(makeZip({ "pkg-1.0/SKILL.md": "---\nname: news\ndescription: 讲新闻\n---\n用 scripts/fetch.py", "pkg-1.0/scripts/fetch.py": "x", "__MACOSX/pkg-1.0/._SKILL.md": "junk", "pkg-1.0/node_modules/a.js": "x" }));
    expect(sk.installZip(g, z1, "pkg.zip")).toBe("news");
    expect(sk.files(path.join(g, "news")).map((f) => f.path)).toEqual(["SKILL.md", "scripts/fetch.py"]);
    expect(() => sk.installZip(g, z1, "pkg.zip")).toThrow("覆盖");
    expect(sk.installZip(g, z1, "pkg.zip", true)).toBe("news");
    const z2 = unzip(makeZip({ "SKILL.md": "没有 front-matter 的说明" }));
    expect(sk.installZip(g, z2, "todo-helper.zip")).toBe("todo-helper");
    expect(() => sk.installZip(g, unzip(makeZip({ "README.md": "x" })), "x.zip")).toThrow("SKILL.md");
  });

  it("从 OpenClaw 导入时把技能一起搬过来：全局 + 各 agent 自己的", () => {
    const { reg } = setup();
    const home = tmpdir("ochome");
    const oc = path.join(home, ".openclaw");
    for (const [d, f] of [["skills/stock/scripts", "q.sh"], ["workspace/skills/mine", "SKILL.md"], ["skills/not-a-skill", "readme.txt"]]) {
      fs.mkdirSync(path.join(oc, d), { recursive: true });
      fs.writeFileSync(path.join(oc, d, f), "x");
    }
    fs.writeFileSync(path.join(oc, "skills", "stock", "SKILL.md"), "---\nname: stock\n---\n查股价");
    const skillsDir = path.join(home, "kagura-skills");
    const rep = importOpenClaw(oc, reg, null, { skillsDir });
    expect(fs.existsSync(path.join(skillsDir, "stock", "scripts", "q.sh"))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, "not-a-skill"))).toBe(false);
    expect(fs.existsSync(path.join(reg.get("main")!.workspace, "skills", "mine", "SKILL.md"))).toBe(true);
    expect(describeImport(rep).join("\n")).toContain("技能：stock（全局）、mine（main）");
    expect(importOpenClaw(oc, reg, null, { skillsDir }).skills!.every((s) => s.skipped)).toBe(true);
  });
});
