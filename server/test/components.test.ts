// 自带 MCP 组件单独更新：该不该用下载的那份（比自带的新、文件没被改过）；从 GitHub 查、按 digest 校验下载、镜像给的坏东西不收；用回自带的
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpdir } from "./helpers.ts";
import { pickComponent, runUpdatedComponent, ComponentUpdater } from "../src/components.ts";
import { buildComponent, COMPONENT_ENTRIES } from "../scripts/build-mcp.mjs";

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const install = (dir: string, name: string, code: string, stamp: number, metaSha = sha(code)) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.cjs`), code);
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ sha256: metaSha, stamp }));
};

describe("用不用下载的那份", () => {
  it("比自带的新、sha256 对得上才用；旧的 / 和自带一样 / 被改过 / 没有记录的都不用", () => {
    const dir = tmpdir("comp");
    const builtin = { "bambu-printer": { sha256: "aa", stamp: 1000 } };
    install(dir, "bambu-printer", "exports.run = () => {}", 2000);
    expect(pickComponent("bambu-printer", dir, builtin)).toMatchObject({ stamp: 2000, file: path.join(dir, "bambu-printer.cjs") });
    expect(pickComponent("bambu-printer", undefined, builtin)).toBeNull();
    install(dir, "bambu-printer", "exports.run = () => {}", 900);                                      // 比自带的旧（装了新正式版之后）
    expect(pickComponent("bambu-printer", dir, builtin)).toBeNull();
    install(dir, "bambu-printer", "exports.run = () => {}", 2000, "aa");                             // 和自带的是同一份
    expect(pickComponent("bambu-printer", dir, builtin)).toBeNull();
    install(dir, "bambu-printer", "exports.run = () => {}", 2000, sha("别的内容"));                   // 文件被改过 / 没写完
    expect(pickComponent("bambu-printer", dir, builtin)).toBeNull();
    fs.rmSync(path.join(dir, "bambu-printer.json"));
    expect(pickComponent("bambu-printer", dir, builtin)).toBeNull();
  });

  it("跑更新版：调它的 run(版本)；加载出错就退回自带的", () => {
    const dir = tmpdir("comp2");
    const out = path.join(dir, "ran.txt");
    install(dir, "blender", `exports.run = (v) => require("fs").writeFileSync(${JSON.stringify(out)}, "ran " + v);`, 2000);
    const logs: string[] = [];
    expect(runUpdatedComponent("blender", "1.2.3", dir, (l) => logs.push(l))).toBe(true);
    expect(fs.readFileSync(out, "utf8")).toBe("ran 1.2.3");
    expect(logs[0]).toContain("用更新版 blender");
    install(dir, "build123d", "throw new Error('坏了')", 2000);
    expect(runUpdatedComponent("build123d", "1", dir, (l) => logs.push(l))).toBe(false);
    expect(logs.at(-1)).toContain("加载失败，改用自带的：坏了");
    expect(runUpdatedComponent("bambu-printer", "1", dir, () => {})).toBe(false);                     // 没有下载的
  });

  it("打出来的组件每次一模一样（自带的哪一版靠 sha256 认），能被加载、导出 run", async () => {
    for (const name of Object.keys(COMPONENT_ENTRIES)) {
      const a = await buildComponent(name), b = await buildComponent(name);
      expect(sha(a), name).toBe(sha(b));
      expect(a.toString("utf8")).not.toMatch(/kagura-voice|src[\\/](printer|blender|cad)[\\/]/);              // 不带构建机器上的路径（那样每台机器打出来都不一样）
      const dir = tmpdir("built");
      fs.writeFileSync(path.join(dir, `${name}.cjs`), a);
      const mod = require(path.join(dir, `${name}.cjs`));
      expect(typeof mod.run, name).toBe("function");
    }
  }, 60_000);
});

/** 假的 GitHub：releases/tags/mcp-components + 下载地址；mirrorBad = 镜像返回被改过的内容 */
function fakeGithub(files: Record<string, string>, o: { stamp?: number; digestOverride?: Record<string, string>; directFails?: boolean; mirrorBad?: boolean; status?: number } = {}) {
  const manifest = { format: 1, stamp: o.stamp ?? 3000, components: Object.fromEntries(Object.entries(files).map(([n, c]) => [n, { file: `${n}.cjs`, sha256: sha(c), size: c.length, stamp: o.stamp ?? 3000 }])) };
  const assets: Record<string, string> = { "manifest.json": JSON.stringify(manifest), ...Object.fromEntries(Object.entries(files).map(([n, c]) => [`${n}.cjs`, c])) };
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    if (url.startsWith("https://api.github.com/")) {
      if (o.status) return new Response("", { status: o.status });
      return Response.json({ assets: Object.entries(assets).map(([name, body]) => ({ name, size: body.length, browser_download_url: `https://github.com/x/releases/download/mcp-components/${name}`, digest: `sha256:${o.digestOverride?.[name] ?? sha(body)}` })) });
    }
    const name = url.split("/").pop()!;
    const mirror = !url.startsWith("https://github.com/");
    if (!mirror && o.directFails && name !== "manifest.json") throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
    if (mirror && o.mirrorBad) return new Response("exports.run = () => { /* 被改过 */ }");
    return new Response(assets[name]);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("从 GitHub 更新", () => {
  const builtin = { "bambu-printer": { sha256: "b1", stamp: 1000 }, blender: { sha256: "b2", stamp: 1000 }, build123d: { sha256: "b3", stamp: 1000 } };

  it("查到比自带新的就能更新；装上之后用它；已是最新就不再提示；用回自带的", async () => {
    const dir = tmpdir("upd");
    const printer = "exports.run = () => 'new printer'";
    const { fetchFn } = fakeGithub({ "bambu-printer": printer, blender: "exports.run = () => {}" });
    const u = new ComponentUpdater(dir, { fetch: fetchFn, mirrors: [], builtin: { ...builtin, blender: { sha256: sha("exports.run = () => {}"), stamp: 1000 } } });
    const st = await u.check();
    expect(u.error).toBe("");
    expect(st.map((c) => [c.name, c.updatable, c.active])).toEqual([["bambu-printer", true, "builtin"], ["blender", false, "builtin"], ["build123d", false, "builtin"]]);   // blender 和自带的一样；build123d 发布里没有
    expect(await u.update()).toEqual(["bambu-printer"]);
    expect(fs.readFileSync(path.join(dir, "bambu-printer.cjs"), "utf8")).toBe(printer);
    expect(pickComponent("bambu-printer", dir, builtin)).not.toBeNull();
    expect(u.status()[0]).toMatchObject({ active: "installed", updatable: false });
    expect(await u.update()).toEqual([]);
    expect(u.reset("bambu-printer")).toBe(true);
    expect(u.status()[0]).toMatchObject({ active: "builtin", installed: null, updatable: true });
    expect(() => u.reset("../../etc")).toThrow(/没有组件/);
  });

  it("直连不通走镜像；镜像给的东西对不上 digest 就不收；manifest 和 GitHub 的 digest 对不上的组件不认", async () => {
    const dir = tmpdir("upd2");
    const code = "exports.run = () => 'ok'";
    const g = fakeGithub({ "bambu-printer": code }, { directFails: true });
    const u = new ComponentUpdater(dir, { fetch: g.fetchFn, mirrors: ["https://mirror.example/"], builtin });
    await u.check();
    expect(await u.update(["bambu-printer"])).toEqual(["bambu-printer"]);
    expect(g.calls.some((c) => c.startsWith("https://mirror.example/https://github.com/"))).toBe(true);

    const bad = fakeGithub({ "bambu-printer": code }, { directFails: true, mirrorBad: true });
    const u2 = new ComponentUpdater(tmpdir("upd3"), { fetch: bad.fetchFn, mirrors: ["https://mirror.example/"], builtin });
    await u2.check();
    await expect(u2.update()).rejects.toThrow(/下载失败：GitHub 直连（连接被重置[\s\S]*mirror\.example（校验不符）/);
    expect(fs.existsSync(path.join(u2.dir, "bambu-printer.cjs"))).toBe(false);

    const odd = fakeGithub({ "bambu-printer": code }, { digestOverride: { "bambu-printer.cjs": "0".repeat(64) } });
    const u3 = new ComponentUpdater(tmpdir("upd4"), { fetch: odd.fetchFn, mirrors: [], builtin });
    expect((await u3.check())[0].latest).toBeNull();
  });

  it("没发布过 / 接口出错：说清楚，不影响现在用的", async () => {
    const u = new ComponentUpdater(tmpdir("upd5"), { fetch: fakeGithub({}, { status: 404 }).fetchFn, mirrors: [], builtin });
    const st = await u.check();
    expect(u.error).toBe("还没有发布过组件更新");
    expect(st.every((c) => c.active === "builtin" && !c.updatable)).toBe(true);
    await expect(u.update()).rejects.toThrow(/还没有发布过组件更新/);
  });
});
