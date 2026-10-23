import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { tmpdir, makeRuntime } from "./helpers.ts";
import { parseTar, extractTar } from "../src/util/tar.ts";
import { PackageManager, parseSource, discoverResources, pkgId } from "../src/agent/packages.ts";
import { Extensions, resolveBare } from "../src/agent/extensions.ts";

/** 造一个 tar（ustar），可选 gzip */
export function makeTar(files: Record<string, string | Buffer>, gz = true): Buffer {
  const parts: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const h = Buffer.alloc(512);
    const long = Buffer.byteLength(name) > 100;
    if (long) {   // GNU 长文件名
      const ln = Buffer.from(name + "\0");
      const lh = Buffer.alloc(512);
      lh.write("././@LongLink", 0); lh.write("0000644\0", 100); lh.write("0000000\0", 108); lh.write("0000000\0", 116);
      lh.write(ln.length.toString(8).padStart(11, "0") + "\0", 124); lh.write("00000000000\0", 136); lh.write("L", 156);
      lh.write("        ", 148); let sum = 0; for (const b of lh) sum += b; lh.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      parts.push(lh, ln, Buffer.alloc((512 - (ln.length % 512)) % 512));
    }
    h.write(name.slice(0, 100), 0); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124); h.write("00000000000\0", 136); h.write("0", 156); h.write("ustar\0", 257);
    h.write("        ", 148); let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const tar = Buffer.concat(parts);
  return gz ? zlib.gzipSync(tar) : tar;
}

/** 假 npm 源：{ 包名: { 版本: { 文件, package.json 额外字段 } } } */
function fakeRegistry(pkgs: Record<string, Record<string, { files: Record<string, string>; pj?: any }>>, opts: { corrupt?: string } = {}) {
  const tarballs = new Map<string, Buffer>();
  const docs: Record<string, any> = {};
  for (const [name, versions] of Object.entries(pkgs)) {
    const doc: any = { name, "dist-tags": {}, versions: {} };
    for (const [v, { files, pj = {} }] of Object.entries(versions)) {
      const pjson = { name, version: v, ...pj };
      const tgz = makeTar(Object.fromEntries([["package/package.json", JSON.stringify(pjson)], ...Object.entries(files).map(([k, x]) => [`package/${k}`, x])]));
      const url = `https://reg.test/${name}/-/${v}.tgz`;
      tarballs.set(url, opts.corrupt === name ? Buffer.concat([tgz, Buffer.from("x")]) : tgz);
      doc.versions[v] = { ...pjson, dist: { tarball: url, integrity: "sha512-" + crypto.createHash("sha512").update(tgz).digest("base64") } };
      doc["dist-tags"].latest = v;
    }
    docs[name] = doc;
  }
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const u = String(url);
    if (tarballs.has(u)) return new Response(new Uint8Array(tarballs.get(u)!));
    if (u.includes("/-/v1/search")) {
      return Response.json({ objects: Object.keys(docs).map((n) => ({ package: { name: n, version: docs[n]["dist-tags"].latest, description: "d", links: {} }, downloads: { weekly: 5 } })) });
    }
    const name = decodeURIComponent(u.replace("https://reg.test/", ""));
    return docs[name] ? Response.json(docs[name]) : new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe("tar", () => {
  it("gzip / 长文件名 / 去前缀；越界路径拒绝", () => {
    const long = "package/" + "a".repeat(120) + ".txt";
    const tgz = makeTar({ "package/x.txt": "hi", [long]: "long" });
    expect(parseTar(tgz).map((e) => e.name)).toEqual(["package/x.txt", long]);
    const d = tmpdir("tar");
    expect(extractTar(tgz, d, 1)).toBe(2);
    expect(fs.readFileSync(path.join(d, "x.txt"), "utf8")).toBe("hi");
    expect(() => extractTar(makeTar({ "package/../../evil": "x" }), tmpdir("tar"), 1)).toThrow(/越界/);
  });
});

describe("来源解析", () => {
  it("npm / git / GitHub 网址 / 本地路径", () => {
    expect(parseSource("npm:@a/b@1.2.3")).toEqual({ kind: "npm", name: "@a/b", spec: "1.2.3" });
    expect(parseSource("pi-web-access")).toEqual({ kind: "npm", name: "pi-web-access", spec: "" });
    expect(parseSource("git:github.com/o/r@v1")).toMatchObject({ kind: "git", ref: "v1", gh: { owner: "o", repo: "r" } });
    expect(parseSource("https://github.com/o/r.git#main")).toMatchObject({ kind: "git", ref: "main", gh: { owner: "o", repo: "r" } });
    expect(parseSource("git@gitlab.com:o/r")).toMatchObject({ kind: "git", url: "https://gitlab.com/o/r" });
    expect(parseSource("./my-pkg")).toEqual({ kind: "local", path: "./my-pkg" });
    expect(parseSource("C:\\pkgs\\x")).toMatchObject({ kind: "local" });
    expect(pkgId("@juicesharp/rpiv-todo")).toBe("juicesharp__rpiv-todo");
  });
});

describe("包资源发现", () => {
  it("pi 清单（glob、排除、目录取 index）与约定目录", () => {
    const d = tmpdir("res");
    const w = (f: string, c = "x") => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
    w("package.json", JSON.stringify({ pi: { extensions: ["./src/*.ts", "!src/legacy.ts", "./dist"], skills: ["./res/skills"], prompts: ["./p/*.md"] } }));
    w("src/a.ts"); w("src/legacy.ts"); w("src/b.d.ts"); w("dist/index.js"); w("dist/cli.js"); w("res/skills/s1/SKILL.md"); w("p/x.md");
    const r = discoverResources(d);
    expect(r.extensions.map((f) => path.relative(d, f)).sort()).toEqual(["dist/index.js", "src/a.ts"].map((x) => path.normalize(x)));
    expect(r.skillRoots).toEqual([path.join(d, "res/skills")]);
    expect(r.prompts).toBe(1);
    const c = tmpdir("res");
    fs.mkdirSync(path.join(c, "extensions", "multi"), { recursive: true });
    fs.writeFileSync(path.join(c, "extensions", "one.ts"), "");
    fs.writeFileSync(path.join(c, "extensions", "multi", "index.ts"), "");
    expect(discoverResources(c).extensions.map((f) => path.relative(c, f)).sort()).toEqual(["extensions/multi/index.ts", "extensions/one.ts"].map((x) => path.normalize(x)));
  });

  it("node_modules 解析：exports 条件 / 子路径通配 / main", () => {
    const d = tmpdir("rb");
    const w = (f: string, c = "") => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
    w("node_modules/esm-only/package.json", JSON.stringify({ exports: { ".": { types: "./x.d.ts", import: "./esm/index.js" }, "./sub/*": { import: "./esm/sub/*.js" } } }));
    w("node_modules/esm-only/esm/index.js"); w("node_modules/esm-only/esm/sub/deep.js");
    w("node_modules/@s/old/package.json", JSON.stringify({ main: "lib/main" })); w("node_modules/@s/old/lib/main.js");
    expect(resolveBare("esm-only", path.join(d, "src"))).toBe(path.join(d, "node_modules/esm-only/esm/index.js"));
    expect(resolveBare("esm-only/sub/deep", d)).toBe(path.join(d, "node_modules/esm-only/esm/sub/deep.js"));
    expect(resolveBare("@s/old", d)).toBe(path.join(d, "node_modules/@s/old/lib/main.js"));
    expect(resolveBare("nope", d)).toBe(null);
  });
});

const EXT = `import { Type } from "@earendil-works/pi-ai";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { shout } from "dep-a";
import { two } from "dep-b";
export default function (pi) {
  let ready = false;
  pi.on("session_start", async () => { ready = true; });
  pi.registerCommand("x", {});
  pi.registerTool({
    name: "pkg_shout", label: "喊", description: "大写", parameters: Type.Object({ s: Type.String() }),
    renderCall: () => new Text("x"),
    async execute(id, p) { return { content: [{ type: "text", text: shout(p.s) + two() + (ready ? "!" : "?") + truncateHead("a\\nb", { maxLines: 1 }).content }] }; },
  });
  pi.registerTool({ name: "speak", description: "和内置重名", parameters: Type.Object({}), execute: async () => "x" });
}`;

describe("扩展包安装（假 npm 源）", () => {
  const registry = () => fakeRegistry({
    "kagura-test-pkg": { "1.0.0": { files: { "extensions/main.ts": EXT, "skills/hello/SKILL.md": "---\nname: hello-skill\ndescription: 打招呼\n---\n说你好" },
      pj: { keywords: ["pi-package"], dependencies: { "dep-a": "^1.0.0", "dep-b": "^2.0.0" }, peerDependencies: { "@earendil-works/pi-ai": "*" } } } },
    // 纯 ESM、只有 import 条件；它自己要 dep-b@1（和根上的 2 冲突 → 嵌套）
    "dep-a": { "1.2.0": { files: { "esm/index.js": `import { one } from "dep-b"; export const shout = (s) => s.toUpperCase() + one(); export const url = import.meta.url;` },
      pj: { type: "module", exports: { ".": { import: "./esm/index.js" } }, dependencies: { "dep-b": "^1.0.0" } } } },
    "dep-b": {
      "1.0.0": { files: { "index.js": "exports.one = () => '1'; exports.two = () => 'one-two';" } },
      "2.0.0": { files: { "index.js": "exports.one = () => 'two-one'; exports.two = () => '2';" } },
    },
  });

  it("装依赖（冲突版本嵌套、宿主包不装）、校验、加载、工具可用、技能可用、重名的内置优先", async () => {
    const { rt, reg, fake } = makeRuntime();
    const root = tmpdir("pkgs");
    const { fetch } = registry();
    const pm = new PackageManager(path.join(root, "packages"), { fetch, registry: "https://reg.test" });
    const ex = new Extensions(path.join(root, "extensions"), reg);
    ex.packages = pm;
    pm.onChange = async () => { await ex.reloadAll(); };
    const rec = await pm.install("npm:kagura-test-pkg");
    expect(rec).toMatchObject({ id: "kagura-test-pkg", version: "1.0.0", kind: "npm", deps: 3, enabled: true });
    const nm = path.join(rec.dir, "node_modules");
    expect(JSON.parse(fs.readFileSync(path.join(nm, "dep-b/package.json"), "utf8")).version).toBe("2.0.0");
    expect(JSON.parse(fs.readFileSync(path.join(nm, "dep-a/node_modules/dep-b/package.json"), "utf8")).version).toBe("1.0.0");
    expect(fs.existsSync(path.join(nm, "@earendil-works"))).toBe(false);
    const e = ex.list().find((x) => x.pkg === "kagura-test-pkg")!;
    expect(e.error).toBe("");
    expect(e.unsupported).toContain("registerCommand");
    // 内置工具（speak）先注册、扩展包的工具后注册：重名时用内置的
    rt.addTools(() => [{ name: "speak", label: "内置", description: "内置", parameters: {} as any, execute: async () => ({ content: [{ type: "text", text: "builtin" }], details: {} }) }]);
    rt.addTools(ex.tools(), { plugin: true });
    expect(rt.builtinToolNames(reg.get("main")!).has("speak")).toBe(true);
    fake.queue.push({ tool_calls: [{ name: "pkg_shout", args: { s: "hi" } }, { name: "speak", args: {} }], then: "好" });
    await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "device", text: "x", trusted: true });
    const results = rt.store("main").history("main:main").map((h) => h.msg).filter((m: any) => m.role === "toolResult") as any[];
    expect(results[0].content[0].text).toBe("HI12!a");     // dep-a 用的是嵌套的 dep-b@1（one → 1），根上用 dep-b@2（two → 2）
    expect(results[1].content[0].text).toBe("builtin");
    // 技能目录
    const { Skills } = await import("../src/agent/skills.ts");
    const sk = new Skills(path.join(root, "skills"));
    sk.extraRoots = () => pm.enabled().flatMap((x) => x.res.skillRoots.map((r) => ({ root: r, pkg: x.rec.id })));
    expect(sk.list(reg.get("main")!).map((s) => s.name)).toContain("hello-skill");
    // 停用 → 工具没了；删除 → 进回收站
    await pm.setEnabled("kagura-test-pkg", false);
    expect(ex.list().some((x) => x.pkg)).toBe(false);
    await pm.remove("kagura-test-pkg");
    expect(pm.list()).toEqual([]);
    expect(fs.readdirSync(path.join(root, "packages", ".trash")).length).toBe(1);
    // 记录落盘：重新打开还在
    await pm.install("kagura-test-pkg@^1");
    expect(new PackageManager(path.join(root, "packages")).list().map((r) => r.name)).toEqual(["kagura-test-pkg"]);
  });

  it("校验和不符 / 没有的包 / 没有的版本 → 报错且不留半成品", async () => {
    const root = tmpdir("pkgs");
    const bad = fakeRegistry({ x: { "1.0.0": { files: { "extensions/a.ts": "export default () => {}" } } } }, { corrupt: "x" });
    const pm = new PackageManager(path.join(root, "packages"), { fetch: bad.fetch, registry: "https://reg.test" });
    await expect(pm.install("x")).rejects.toThrow(/校验失败/);
    await expect(pm.install("nope")).rejects.toThrow(/没有包/);
    const ok = fakeRegistry({ y: { "1.0.0": { files: {} } } });
    const pm2 = new PackageManager(path.join(root, "p2"), { fetch: ok.fetch, registry: "https://reg.test" });
    await expect(pm2.install("y@^2")).rejects.toThrow(/没有满足/);
    expect(fs.readdirSync(path.join(root, "packages")).filter((f) => !f.startsWith("."))).toEqual([]);
    expect(fs.readdirSync(path.join(root, "packages")).filter((f) => f.startsWith(".tmp"))).toEqual([]);
  });

  it("商店搜索带「已安装」标记", async () => {
    const { fetch, calls } = registry();
    const pm = new PackageManager(path.join(tmpdir("pkgs"), "packages"), { fetch, registry: "https://reg.test" });
    await pm.install("kagura-test-pkg");
    const items = await pm.search("memory");
    expect(calls.some((u) => u.includes("text=keywords%3Api-package%20memory"))).toBe(true);
    expect(items.find((x) => x.name === "kagura-test-pkg")!.installed).toBe(true);
  });

  it("上传 .ts / .zip / .tgz；本地目录原地加载；从 pi 的配置读来源", async () => {
    const { reg } = makeRuntime();
    const root = tmpdir("pkgs");
    const pm = new PackageManager(path.join(root, "packages"), { fetch: (() => { throw new Error("不该联网"); }) as any });
    const ex = new Extensions(path.join(root, "extensions"), reg);
    ex.packages = pm;
    pm.onChange = async () => { await ex.reloadAll(); };
    const tool = (n: string) => `export default (pi) => pi.registerTool({ name: "${n}", description: "d", parameters: {}, execute: async () => "${n}-ok" });`;
    await pm.install("", { filename: "solo.ts", data: Buffer.from(tool("up_ts")) });
    await pm.install("", { filename: "bundle.tgz", data: makeTar({ "my-bundle/package.json": JSON.stringify({ name: "my-bundle", version: "0.1.0" }), "my-bundle/extensions/x.js": tool("up_tgz") }) });
    const local = tmpdir("local");
    fs.mkdirSync(path.join(local, "extensions"));
    fs.writeFileSync(path.join(local, "package.json"), JSON.stringify({ name: "local-pkg" }));
    fs.writeFileSync(path.join(local, "extensions", "l.ts"), tool("up_local"));
    await pm.install(local);
    expect(pm.get("local-pkg")!.dir).toBe(path.resolve(local));
    const names = ex.list().flatMap((e) => e.tools.map((t) => t.name)).sort();
    expect(names).toEqual(["up_local", "up_tgz", "up_ts"]);
    // 改了本地文件，「重新加载」就生效
    fs.writeFileSync(path.join(local, "extensions", "l.ts"), tool("up_local2"));
    await pm.update("local-pkg");
    expect(ex.list().flatMap((e) => e.tools.map((t) => t.name))).toContain("up_local2");
    // 删除本地包不删用户的目录
    await pm.remove("local-pkg");
    expect(fs.existsSync(path.join(local, "extensions", "l.ts"))).toBe(true);
    // pi 的配置
    const home = tmpdir("home");
    fs.mkdirSync(path.join(home, ".pi", "agent", "extensions"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access", { source: "./mine" }] }));
    fs.writeFileSync(path.join(home, ".pi", "agent", "extensions", "hello.ts"), tool("h"));
    const old = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    expect(PackageManager.piSources(home).map((s) => s.source)).toEqual(["npm:pi-web-access", path.join(home, ".pi", "agent", "mine"), path.join(home, ".pi", "agent", "extensions", "hello.ts")]);
    if (old !== undefined) process.env.PI_CODING_AGENT_DIR = old;
  });
});
