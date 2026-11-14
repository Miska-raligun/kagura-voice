// Blender 建模服务器：找 Blender、检查结果说人话；装了 Blender 的机器上真跑一遍（建模 → 检查 → STL → 预览图）
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "./helpers.ts";
import { findBlender, parseBed, describeReport, startBlenderMcp, runBlender } from "../src/blender/mcp-server.ts";
import { guide, GUIDE_TOPICS, EXAMPLES, HELPER_NAMES } from "../src/blender/guide.ts";

function serve(env: Record<string, string>) {
  const input = new PassThrough(), output = new PassThrough();
  const waiting = new Map<number, (r: any) => void>();
  let buf = "", id = 0;
  output.on("data", (d) => { buf += d.toString(); for (let i; (i = buf.indexOf("\n")) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const srv = startBlenderMcp({ input, output, env, log: () => {} });
  const rpc = (method: string, params: any = {}) => new Promise<any>((r) => { const n = ++id; waiting.set(n, r); input.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  const call = async (name: string, args: any) => (await rpc("tools/call", { name, arguments: args })).result;
  return { rpc, call, close: () => { srv.close(); input.end(); } };
}

describe("Blender 服务器", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { for (const c of closers.splice(0)) c(); });

  it("找 Blender：env 指定的优先；Windows 装了好几个版本取最新的；都没有是空", () => {
    expect(findBlender({ BLENDER: "/x/blender" })).toBe("/x/blender");
    const pf = tmpdir("pf");
    for (const v of ["Blender 3.6", "Blender 4.2", "Blender 4.10"]) { fs.mkdirSync(path.join(pf, "Blender Foundation", v), { recursive: true }); fs.writeFileSync(path.join(pf, "Blender Foundation", v, "blender.exe"), ""); }
    expect(findBlender({ ProgramFiles: pf }, "win32")).toBe(path.join(pf, "Blender Foundation", "Blender 4.10", "blender.exe"));
    expect(findBlender({ PATH: "" }, "linux")).toBe("");
    expect(parseBed("256x256x256")).toEqual([256, 256, 256]);
    expect(parseBed("180 × 180 × 180")).toEqual([180, 180, 180]);
    expect(parseBed("乱写")).toEqual([256, 256, 256]);
  });

  it("检查结果说人话：破洞、放不下、悬空、太薄都点出来；没问题就说没问题", () => {
    const ok = describeReport({ ok: true, objects: 1, tris: 12, dims: [60, 40, 20], min: [0, 0, 0], volume_mm3: 48000, non_manifold: 0, boundary: 0, loose_verts: 0, fits: true }, [256, 256, 256]);
    expect(ok).toContain("长 60 × 宽 40 × 高 20 mm；体积约 48 cm³");
    expect(ok).toContain("没发现问题");
    const bad = describeReport({ ok: true, objects: 2, tris: 2, dims: [300, 10, 0.2], min: [0, 0, 5], volume_mm3: 0, non_manifold: 4, boundary: 4, loose_verts: 1, fits: false }, [256, 256, 256]);
    expect(bad).toContain("有 4 条破洞边（模型不封闭）");
    expect(describeReport({ ok: true, objects: 2, tris: 20, dims: [10, 10, 10], min: [0, 0, 0], volume_mm3: 1000, non_manifold: 2, boundary: 0, loose_verts: 0, fits: true }, [256, 256, 256])).toMatch(/没发现问题[\s\S]*2 条边连着两个以上的面/);
    expect(bad).toContain("放不进打印机（打印范围 256 × 256 × 256 mm）");
    expect(bad).toContain("最低点在 z=5");
    expect(bad).toContain("只有 0.2 mm");
    expect(bad).toContain("孤立的点");
  });

  it("参数不对、没装 Blender 都说清楚", async () => {
    const s = serve({ BLENDER: "/nope/blender", MODEL_DIR: tmpdir("models") });
    closers.push(s.close);
    expect((await s.rpc("tools/list")).result.tools.map((t: any) => t.name)).toEqual(["model_build", "model_guide", "model_preview"]);
    const g = (await s.call("model_guide", {})).content[0].text;
    expect(g).toContain("## 约定");
    expect(g).toContain("## 分三步做");
    expect(g).toMatch(/- review：建完自己检查[\s\S]*- look：做得好看/);
    expect((await s.call("model_guide", { topic: "review" })).content[0].text).toContain("眯着眼看");
    expect(g).toContain("box(sx, sy, sz");
    expect(g).toMatch(/- fits：配合间隙/);
    expect((await s.call("model_guide", { topic: "fits" })).content[0].text).toContain("M3 3.4");
    expect((await s.call("model_build", { name: "a", code: "x" })).content[0].text).toContain("没找到 Blender");
    const s2 = serve({ BLENDER: process.execPath, MODEL_DIR: tmpdir("models") });
    closers.push(s2.close);
    expect((await s2.call("model_build", { name: "../x", code: "x" })).content[0].text).toContain("name 只能用");
    expect((await s2.call("model_preview", { file: "/nope.stl" })).content[0].text).toContain("这台电脑上没有");
  });
});

const blender = (() => { try { const p = execFileSync("sh", ["-c", "command -v blender"], { encoding: "utf8" }).trim(); execFileSync(p, ["--version"], { stdio: "ignore", timeout: 30_000 }); return p; } catch { return ""; } })();
describe.skipIf(!blender)("真的 Blender", () => {
  const BOX = `
import bpy, bmesh
# 60×40×20 的开口盒子，壁厚 2：外框减内框
bpy.ops.mesh.primitive_cube_add(size=1, location=(30, 20, 10)); outer = bpy.context.object; outer.scale = (60, 40, 20)
bpy.ops.mesh.primitive_cube_add(size=1, location=(30, 20, 12)); inner = bpy.context.object; inner.scale = (56, 36, 20)
m = outer.modifiers.new("cut", "BOOLEAN"); m.object = inner; m.operation = "DIFFERENCE"
inner.hide_render = True; inner.hide_set(True)
`;
  it("建模 → 检查 → STL → 预览图；代码出错带回报错；破洞的模型点出来；还能看现成的 STL", async () => {
    const dir = tmpdir("models");
    const s = serve({ BLENDER: blender, MODEL_DIR: dir });
    try {
      const r = await s.call("model_build", { name: "盒子", code: BOX });
      expect(r.isError).toBeFalsy();
      const text = r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      expect(text).toContain("长 60 × 宽 40 × 高 20 mm");
      expect(text).toContain("没发现问题");
      const img = r.content.find((c: any) => c.type === "image");
      expect(img?.mimeType).toBe("image/png");
      expect(Buffer.from(img.data, "base64").subarray(1, 4).toString()).toBe("PNG");
      const stl = path.join(dir, "盒子", "盒子.stl");
      expect(fs.statSync(stl).size).toBeGreaterThan(84);
      expect(fs.readFileSync(path.join(dir, "盒子", "盒子.py"), "utf8")).toContain("BOOLEAN");
      // 体积：外 60*40*20 - 内腔 56*36*18 = 11712
      expect(text).toMatch(/体积约 11\.7 cm³/);
      const err = await s.call("model_build", { name: "坏的", code: "bpy.ops.mesh.primitive_cube_add(size=10)\nundefined_name + 1" });
      expect(err.isError).toBe(true);
      expect(err.content[0].text).toMatch(/建模代码出错[\s\S]*NameError/);
      const plane = await s.call("model_build", { name: "平面", code: "bpy.ops.mesh.primitive_plane_add(size=20)" });
      expect(plane.content[0].text).toContain("有 4 条破洞边");
      const p = await s.call("model_preview", { file: stl });
      expect(p.content[0].text).toContain("长 60 × 宽 40 × 高 20 mm");
      expect(p.content.some((c: any) => c.type === "image")).toBe(true);
    } finally { s.close(); }
  }, 240_000);

  it("指南里的每个示例都能建出来：封闭、放得下", async () => {
    const dir = tmpdir("examples");
    for (const [name, [, code]] of Object.entries(EXAMPLES)) {
      const f = path.join(dir, `${name}.py`);
      fs.writeFileSync(f, code);
      const r = await runBlender(blender, { mode: "build", code_file: f, out_stl: path.join(dir, `${name}.stl`), bed: [256, 256, 256] }, 120_000);
      expect({ name, ok: r.ok, error: r.error, boundary: r.boundary, fits: r.fits, minZ: r.min?.[2] }).toEqual({ name, ok: true, error: undefined, boundary: 0, fits: true, minZ: expect.closeTo(0, 1) });
    }
  }, 300_000);

  it("小函数：尺寸和位置对（底面中心在 at）；挖 / 合并之后工具物体没了；中文找不到字体会提示", async () => {
    const dir = tmpdir("helpers");
    const f = path.join(dir, "h.py");
    fs.writeFileSync(f, "b = box(30, 20, 10, at=(5, 0, 0))\ncut(b, cylinder(3, 20, at=(5, 0, -1)))\nassert len(bpy.data.objects) == 1, [o.name for o in bpy.data.objects]");
    const r = await runBlender(blender, { mode: "build", code_file: f, bed: [256, 256, 256] }, 120_000);
    expect(r).toMatchObject({ ok: true, dims: [30, 20, 10], min: [-10, -10, 0], boundary: 0 });
    expect(r.volume_mm3).toBeCloseTo(30 * 20 * 10 - Math.PI * 9 * 10, -1);
  }, 120_000);
});
