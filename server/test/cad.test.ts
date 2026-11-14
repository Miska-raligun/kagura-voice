// build123d 建模服务器：STL 读取 / 网格检查 / 软件渲染（不靠 Python）；找 Python；装了 build123d 的机器上真跑（示例逐个建一遍）。
// 本地跑真的那几条：PYTHON=<装了 build123d 的 python> npx vitest run test/cad.test.ts
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "./helpers.ts";
import { readStl, checkMesh, renderGrid, encodePng } from "../src/cad/raster.ts";
import { pythonCandidates, findPython, startCadMcp } from "../src/cad/mcp-server.ts";
import { guide, GUIDE_TOPICS, EXAMPLES } from "../src/cad/guide.ts";
import { guide as blenderGuide } from "../src/blender/guide.ts";

/** 边长 s 的立方体（12 个三角面，法线朝外）；drop = 去掉几个三角面（造破洞） */
function cubeStl(file: string, s = 10, drop = 0, ascii = false) {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]].slice(drop);
  if (ascii) {
    fs.writeFileSync(file, `solid c\n${f.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${v[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid c\n`);
    return file;
  }
  const b = Buffer.alloc(84 + f.length * 50);
  b.writeUInt32LE(f.length, 80);
  f.forEach((t, k) => t.forEach((i, j) => v[i].forEach((x, a) => b.writeFloatLE(x, 84 + k * 50 + 12 + (j * 3 + a) * 4))));
  fs.writeFileSync(file, b);
  return file;
}
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

function serve(env: Record<string, string | undefined>) {
  const input = new PassThrough(), output = new PassThrough();
  const waiting = new Map<number, (r: any) => void>();
  let buf = "", id = 0;
  output.on("data", (d) => { buf += d.toString(); for (let i; (i = buf.indexOf("\n")) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const srv = startCadMcp({ input, output, env, log: () => {} });
  const rpc = (method: string, params: any = {}) => new Promise<any>((r) => { const n = ++id; waiting.set(n, r); input.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  const call = async (name: string, args: any) => (await rpc("tools/call", { name, arguments: args })).result;
  return { rpc, call, close: () => { srv.close(); input.end(); } };
}

describe("STL 检查和预览图（不用 Python）", () => {
  it("二进制和文本 STL 都读得出；封闭的立方体没有破洞、体积对；少两个面就有 4 条破洞边", () => {
    const d = tmpdir("stl");
    for (const ascii of [false, true]) {
      const c = checkMesh(readStl(cubeStl(path.join(d, `c${ascii}.stl`), 10, 0, ascii)));
      expect(c).toMatchObject({ tris: 12, boundary: 0, non_manifold: 0, volume_mm3: 1000, min: [0, 0, 0], max: [10, 10, 10] });
    }
    expect(checkMesh(readStl(cubeStl(path.join(d, "h.stl"), 10, 2))).boundary).toBe(4);
  });

  it("四个角度拼成 800×600 的 PNG；背景是浅灰、模型画上去了", () => {
    const png = renderGrid(readStl(cubeStl(path.join(tmpdir("stl2"), "c.stl"))));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(pngSize(png)).toEqual([800, 600]);
    const tiny = encodePng(new Uint8Array([255, 0, 0, 0, 255, 0]), 2, 1);
    expect(pngSize(tiny)).toEqual([2, 1]);
  });
});

describe("build123d 服务器", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { for (const c of closers.splice(0)) c(); });

  it("找 Python：PYTHON 指定的（可以带参数）优先；Windows 先试 py -3；没有就说怎么装", () => {
    expect(pythonCandidates({ PYTHON: "py -3.12" })).toEqual([{ cmd: "py", pre: ["-3.12"] }]);
    expect(pythonCandidates({ PYTHON: "/opt/py/bin/python" })).toEqual([{ cmd: "/opt/py/bin/python", pre: [] }]);
    expect(pythonCandidates({ PYTHON: "venv/bin/python" })).toEqual([{ cmd: path.resolve("venv/bin/python"), pre: [] }]);   // 建模在临时目录里跑
    expect(pythonCandidates({}, "win32")[0]).toEqual({ cmd: "py", pre: ["-3"] });
    expect(pythonCandidates({}, "linux")[0]).toEqual({ cmd: "python3", pre: [] });
    expect(findPython({ PYTHON: "/没有/python" }).error).toContain("没找到 Python");
  });

  it("指导：默认给约定 + 常用写法 + 目录；打印规矩 / 配合 / 自查 / 好看和 Blender 那个是同一份", () => {
    expect(GUIDE_TOPICS).toEqual(["basics", "api", "printing", "fits", "review", "look", "examples", "problems"]);
    const g = guide();
    expect(g).toContain("result = 零件");
    expect(g).toContain("align=(Align.CENTER, Align.CENTER, Align.MIN)");
    expect(g).toContain("- fits：");
    for (const k of ["printing", "fits", "review", "look"]) expect(guide(k)).toBe(blenderGuide(k));
    expect(guide("examples")).toContain("### 带盖收纳盒");
  });

  it("工具：cad_build / cad_guide / cad_preview；看现成 STL 不用 Python；没 Python 时建模说清楚缺什么", async () => {
    const out = tmpdir("cadout");
    const s = serve({ PYTHON: "/没有/python", MODEL_DIR: out });
    closers.push(s.close);
    expect((await s.rpc("tools/list")).result.tools.map((t: any) => t.name)).toEqual(["cad_build", "cad_guide", "cad_preview"]);
    const r = await s.call("cad_preview", { file: cubeStl(path.join(tmpdir("stl3"), "方块.stl"), 20) });
    expect(r.content[0].text).toContain("长 20 × 宽 20 × 高 20 mm");
    expect(r.content[0].text).toContain("没发现问题");
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(fs.existsSync(path.join(out, "_preview", "方块.png"))).toBe(true);
    const holes = await s.call("cad_preview", { file: cubeStl(path.join(tmpdir("stl4"), "坏.stl"), 20, 2) });
    expect(holes.content[0].text).toContain("4 条破洞边");
    expect((await s.call("cad_preview", { file: "相对/路径.stl" })).isError).toBe(true);
    const nb = await s.call("cad_build", { name: "x", code: "result = Box(1,1,1)" });
    expect(nb.isError).toBe(true);
    expect(nb.content[0].text).toContain("没找到 Python");
  });

  const py = findPython(process.env);
  describe.skipIf(!py.py)("真的 build123d", () => {
    it("示例都建得出来：有效、封闭、放得下，STL / STEP / 预览图都有", async () => {
      const out = tmpdir("cadreal");
      const s = serve({ ...process.env, MODEL_DIR: out });
      closers.push(s.close);
      for (const [name, [, code]] of Object.entries(EXAMPLES)) {
        const r = await s.call("cad_build", { name, code });
        const text = r.content[0].text as string;
        expect(r.isError, `${name}: ${text}`).toBeFalsy();
        expect(text, name).toContain("没发现问题");
        expect(text, name).not.toContain("不完全有效");
        if (name !== "带盖收纳盒") expect(text, name).not.toContain("分开的实体");
        for (const ext of ["stl", "step", "png", "py"]) expect(fs.existsSync(path.join(out, name, `${name}.${ext}`)), `${name}.${ext}`).toBe(true);
        expect(r.content[1].type).toBe("image");
      }
    }, 240_000);

    it("代码出错给出 model.py 的行号；没写 result 用最后一个实体并提醒；result 不是实体说清楚；print 的附在结果里", async () => {
      const s = serve({ ...process.env, MODEL_DIR: tmpdir("cadreal2") });
      closers.push(s.close);
      const bad = await s.call("cad_build", { name: "bad", code: "a = 1\nb = Bxo(1, 2, 3)\n" });
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toMatch(/建模代码出错：\nFile "model.py", line 2[\s\S]*NameError/);
      const noRes = await s.call("cad_build", { name: "nores", code: "x = Box(10, 10, 10, align=(Align.CENTER, Align.CENTER, Align.MIN))\nprint('体积', round(x.volume))\n" });
      expect(noRes.content[0].text).toContain("用的是最后建的 x");
      expect(noRes.content[0].text).toContain("体积 1000");
      const notShape = await s.call("cad_build", { name: "ns", code: "result = 42" });
      expect(notShape.content[0].text).toContain("result 不是实体（是 int）");
      const floating = await s.call("cad_build", { name: "fl", code: "result = Box(10, 10, 10)" });
      expect(floating.content[0].text).toContain("最低点在 z=-5");
    }, 120_000);
  });
});
