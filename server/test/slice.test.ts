// 切片：读 3MF 里的配置和统计；按文件自带配置切（只覆盖几项）；给别的机型的换成这台的系统配置（展开 inherits）；
// 切完核对机型；用一个假的 bambu-studio 记下命令行、吐出准备好的结果
import fs from "node:fs";
import path from "node:path";
import { readStl } from "../src/cad/raster.ts";
import { describe, it, expect } from "vitest";
import { tmpdir } from "./helpers.ts";
import { zip } from "../src/util/zip.ts";
import { projectInfo, sliceInfo, modelMatches, readZipEntry, fmtSeconds, startCheck, tempProblems } from "../src/printer/threemf.ts";
import { slice, overrides, checkOptions, findStudio, Profiles, plateValue } from "../src/printer/slice.ts";

const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header><header_item key="X-BBL-Client-Type" value="slicer"/></header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="N7"/>
    <metadata key="prediction" value="5460"/>
    <metadata key="weight" value="23.81"/>
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FFFFFF" used_m="6.10" used_g="18.20" />
    <filament id="2" tray_info_idx="GFG99" type="PETG" color="#0000FF" used_m="1.80" used_g="5.61" />
  </plate>
</config>`;
const project = (model: string, extra: any = {}) => JSON.stringify({ printer_model: model, printer_settings_id: `${model} 0.4 nozzle`, print_settings_id: "0.20mm Standard @BBL X1C", layer_height: "0.2",
  filament_type: ["PLA", "PETG"], filament_colour: ["#FFFFFF", "#0000FF"], filament_settings_id: ["Bambu PLA Basic @BBL X1C", "Bambu PETG HF @BBL X1C"], ...extra });
const mk3mf = (file: string, o: { model?: string; sliced?: boolean; info?: boolean } = {}) => {
  const e = [{ name: "3D/3dmodel.model", data: Buffer.from("<model/>") }];
  if (o.model !== undefined) e.push({ name: "Metadata/project_settings.config", data: Buffer.from(project(o.model)) });
  if (o.sliced) e.push({ name: "Metadata/plate_1.gcode", data: Buffer.from("G28\n".repeat(3000)) });
  if (o.info) e.push({ name: "Metadata/slice_info.config", data: Buffer.from(SLICE_INFO) });
  fs.writeFileSync(file, zip(e));
  return file;
};

/** 假的 bambu-studio：把参数和加载的配置记下来，按 FAKE_OUT 吐出结果（没有就失败退出） */
function fakeStudio(dir: string) {
  const bin = path.join(dir, "bambu-studio");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const at = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const loaded = {};
for (const k of ["--load-settings", "--load-filaments"]) { const v = at(k); if (v) loaded[k] = v.split(";").filter(Boolean).map((f) => JSON.parse(fs.readFileSync(f, "utf8"))); }
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args: a, loaded, cwd: process.cwd() }));
if (process.env.FAKE_KEEP) fs.copyFileSync(a[a.length - 1], process.env.FAKE_KEEP);
if (process.env.FAKE_HANG) { console.log("loading project..."); setInterval(() => {}, 1000); return; }
if (!process.env.FAKE_OUT) { console.error("boom: plate 1 is empty"); process.exit(Number(process.env.FAKE_EXIT || 1)); }
fs.copyFileSync(process.env.FAKE_OUT, at("--outputdir") + at("--export-3mf"));
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** 一小套系统配置：机器 / 工艺 / 耗材，带 inherits 链 */
function profiles(root: string) {
  const w = (kind: string, j: any) => { const d = path.join(root, "BBL", kind); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${j.name}.json`), JSON.stringify({ type: kind, version: "02.00.00.00", ...j })); };   // 真的系统配置每份都带 type / version
  w("machine", { name: "fdm_machine_common", from: "system", instantiation: "false", nozzle_diameter: ["0.4"], printer_technology: "FFF" });
  w("machine", { name: "Bambu Lab P2S 0.4 nozzle", inherits: "fdm_machine_common", from: "system", instantiation: "true", printer_model: "Bambu Lab P2S", bed_exclude_area: ["0x0"], printable_area: ["0x0", "256x0", "256x256", "0x256"] });
  w("machine", { name: "Bambu Lab X1 Carbon 0.4 nozzle", inherits: "fdm_machine_common", from: "system", instantiation: "true", printer_model: "Bambu Lab X1 Carbon" });
  w("process", { name: "fdm_process_common", from: "system", instantiation: "false", layer_height: "0.2", wall_loops: "2", nozzle_diameter: ["0.4"] });
  w("process", { name: "0.20mm Standard @BBL P2S", inherits: "fdm_process_common", from: "system", instantiation: "true", compatible_printers: ["Bambu Lab P2S 0.4 nozzle"] });
  w("process", { name: "0.20mm Strength @BBL P2S", inherits: "fdm_process_common", from: "system", instantiation: "true", wall_loops: "6", compatible_printers: ["Bambu Lab P2S 0.4 nozzle"] });
  w("process", { name: "0.12mm Fine @BBL P2S", inherits: "fdm_process_common", from: "system", instantiation: "true", layer_height: "0.12", compatible_printers: ["Bambu Lab P2S 0.4 nozzle"] });
  w("process", { name: "0.20mm Standard @BBL X1C", inherits: "fdm_process_common", from: "system", instantiation: "true", compatible_printers: ["Bambu Lab X1 Carbon 0.4 nozzle"] });
  w("filament", { name: "fdm_filament_common", from: "system", instantiation: "false", nozzle_temperature: ["220"] });
  w("filament", { name: "Bambu PLA Basic @base", inherits: "fdm_filament_common", from: "system", instantiation: "false", filament_type: ["PLA"] });
  w("filament", { name: "Bambu PLA Basic @BBL P2S", inherits: "Bambu PLA Basic @base", from: "system", instantiation: "true", compatible_printers: ["Bambu Lab P2S 0.4 nozzle"] });
  w("filament", { name: "Bambu PLA Basic @BBL X1C", inherits: "Bambu PLA Basic @base", from: "system", instantiation: "true", compatible_printers: ["Bambu Lab X1 Carbon 0.4 nozzle"] });
  w("filament", { name: "Generic PETG @BBL P2S", inherits: "fdm_filament_common", from: "system", instantiation: "true", filament_type: ["PETG"], nozzle_temperature: ["250"], compatible_printers: ["Bambu Lab P2S 0.4 nozzle"] });
  return root;
}

function setup() {
  const dir = tmpdir("slice");
  const studio = fakeStudio(dir);
  const log = path.join(dir, "log.json");
  process.env.FAKE_LOG = log;
  delete process.env.FAKE_OUT;
  const env = { studio, profiles: profiles(path.join(dir, "profiles")), model: "P2S", outDir: path.join(dir, "sliced"), timeoutMs: 20_000, isOpen: async () => false };
  return { dir, env, last: () => JSON.parse(fs.readFileSync(log, "utf8")) };
}

describe("3MF", () => {
  it("读项目配置（给哪台打印机、用了哪些料）和切片统计（时间、重量、每种料）", () => {
    const f = mk3mf(path.join(tmpdir("3mf"), "a.3mf"), { model: "Bambu Lab P2S", sliced: true, info: true });
    expect(projectInfo(f)).toMatchObject({ bambu: true, printerModel: "Bambu Lab P2S", filaments: [{ type: "PLA", color: "#FFFFFF", profile: "Bambu PLA Basic @BBL X1C" }, { type: "PETG" }] });
    expect(sliceInfo(f)).toEqual([{ plate: 1, seconds: 5460, grams: 23.81, printerModelId: "N7", filaments: [{ id: 1, type: "PLA", color: "#FFFFFF", grams: 18.2 }, { id: 2, type: "PETG", color: "#0000FF", grams: 5.61 }] }]);
    expect(readZipEntry(f, "Metadata/plate_1.gcode")!.toString().startsWith("G28")).toBe(true);    // 压缩过的也读得出
    const plain = mk3mf(path.join(tmpdir("3mf"), "b.3mf"));
    expect(projectInfo(plain)).toMatchObject({ bambu: false, printerModel: "" });
    expect(sliceInfo(plain)).toEqual([]);
    expect([modelMatches("Bambu Lab P2S", "P2S"), modelMatches("Bambu Lab P1S", "P2S"), modelMatches("Bambu Lab X1 Carbon", "X1 Carbon"), modelMatches("", "P2S")]).toEqual([true, false, true, false]);
    expect(fmtSeconds(5460)).toBe("1 小时 31 分");
  });
});

describe("切片", () => {
  it("参数覆盖写成命令行上的 --key=value；范围不对的先挡掉；找默认装的位置", () => {
    expect(overrides({ layer_height: 0.12, infill: 25, walls: 3, supports: "tree", brim: "off" })).toEqual(["--layer-height=0.12", "--sparse-infill-density=25%", "--wall-loops=3", "--enable-support=1", "--support-type=tree(auto)", "--brim-type=no_brim"]);
    expect(overrides({ supports: "off" })).toEqual(["--enable-support=0"]);
    expect(checkOptions({ layer_height: 0.5 })).toContain("层高");
    expect(checkOptions({ infill: 120 })).toContain("填充");
    expect(checkOptions({ walls: 2.5 })).toContain("墙层数");
    expect(findStudio({}, "win32", (p) => String(p).startsWith("C:\\Program Files\\Bambu Studio"))).toBe("C:\\Program Files\\Bambu Studio\\bambu-studio.exe");
    expect(findStudio({}, "win32", () => false)).toBe("");
  });

  it("给这台打印机配的项目：用文件自带配置切，只覆盖指定的几项；结果放进 sliced/、临时目录清掉", async () => {
    const { dir, env, last } = setup();
    const src = mk3mf(path.join(dir, "猫猫.3mf"), { model: "Bambu Lab P2S" });
    process.env.FAKE_OUT = mk3mf(path.join(dir, "out.3mf"), { model: "Bambu Lab P2S", sliced: true, info: true });
    const r = await slice(src, { infill: 30, supports: "normal" }, env);
    expect(r.mode).toBe("project");
    expect(r.file).toBe(path.join(env.outDir, "猫猫.gcode.3mf"));
    expect(r.plates[0]).toMatchObject({ seconds: 5460, grams: 23.81 });
    const l = last();
    expect(l.args).toEqual(["--slice", "1", "--sparse-infill-density=30%", "--enable-support=1", "--support-type=normal(auto)", "--outputdir", expect.stringMatching(/[\\/]$/), "--export-3mf", "output.gcode.3mf", expect.stringMatching(/[\\/]input\.3mf$/)]);
    expect(l.loaded).toEqual({});
    expect(fs.existsSync(l.cwd)).toBe(false);
    // 再切一次不覆盖上一份
    expect((await slice(src, {}, env)).file).toBe(path.join(env.outDir, "猫猫-2.gcode.3mf"));
  });

  it("给别的机型配的项目：换成这台的系统配置——机器 / 工艺 / 每种料都展开成完整配置；层高按要求挑工艺", async () => {
    const { dir, env, last } = setup();
    const src = mk3mf(path.join(dir, "x1c.3mf"), { model: "Bambu Lab X1 Carbon" });
    process.env.FAKE_OUT = mk3mf(path.join(dir, "out.3mf"), { model: "Bambu Lab P2S", sliced: true, info: true });
    const r = await slice(src, { layer_height: 0.12 }, env);
    expect(r.mode).toBe("switched");
    expect(r.warnings[0]).toContain("原本是给「Bambu Lab X1 Carbon」配的");
    expect(r.warnings[0]).toContain("0.12mm Fine @BBL P2S");
    const l = last();
    const [machine, proc] = l.loaded["--load-settings"];
    expect(machine).toMatchObject({ name: "Bambu Lab P2S 0.4 nozzle", from: "User", inherits: "Bambu Lab P2S 0.4 nozzle", printer_model: "Bambu Lab P2S", nozzle_diameter: ["0.4"], printer_settings_id: "Bambu Lab P2S 0.4 nozzle" });
    expect(machine.instantiation).toBeUndefined();
    expect(proc).toMatchObject({ name: "0.12mm Fine @BBL P2S", layer_height: "0.12", wall_loops: "2", print_settings_id: "0.12mm Fine @BBL P2S" });
    expect(proc.nozzle_diameter).toBeUndefined();                    // 和机器重复的键去掉
    // 每份都带自己的 type（命令行靠它认；机器里也有 type，去重复键时不能把它删掉）
    expect([machine.type, proc.type, ...l.loaded["--load-filaments"].map((f: any) => f.type)]).toEqual(["machine", "process", "filament", "filament"]);
    expect(l.loaded["--load-filaments"].map((f: any) => [f.name, f.nozzle_temperature[0]])).toEqual([["Bambu PLA Basic @BBL P2S", "220"], ["Generic PETG @BBL P2S", "250"]]);
    expect(l.args).toContain("--layer-height=0.12");
    // STL 也走这条路（默认 0.2 标准）；以原点为中心建的模型先挪到打印板中间、底面贴 z=0，文件名换成英文
    fs.writeFileSync(path.join(dir, "件.stl"), "solid x\nfacet normal 0 0 1\nouter loop\nvertex -10 -5 -3\nvertex 10 -5 -3\nvertex 10 5 7\nendloop\nendfacet\nendsolid x\n");
    process.env.FAKE_KEEP = path.join(dir, "placed.stl");
    try {
      const s2 = await slice(path.join(dir, "件.stl"), {}, env);
      expect(s2.warnings[0]).toContain("STL 没有打印配置");
      expect(s2.file).toBe(path.join(env.outDir, "件.gcode.3mf"));
    } finally { delete process.env.FAKE_KEEP; }
    expect(last().loaded["--load-settings"][1].name).toBe("0.20mm Standard @BBL P2S");
    expect(last().args.at(-1)).toMatch(/[\\/]input\.stl$/);
    const placed = readStl(path.join(dir, "placed.stl"));
    expect([...placed.tris]).toEqual([118, 123, 0, 138, 123, 0, 138, 133, 10]);
    // 读不出三角面的说清楚
    fs.writeFileSync(path.join(dir, "空.stl"), "solid x\nendsolid x\n");
    await expect(slice(path.join(dir, "空.stl"), {}, env)).rejects.toThrow(/读不出三角面/);
  });

  it("失败说得出原因：命令行报错（带最后几行输出、换配置时给出手动的办法）、没切出 G-code、切出来不是给这台的、配置里没有这台、没装 Bambu Studio", async () => {
    const { dir, env } = setup();
    const p2s = mk3mf(path.join(dir, "a.3mf"), { model: "Bambu Lab P2S" });
    await expect(slice(p2s, {}, env)).rejects.toThrow(/切片失败（退出码 1）：\nboom: plate 1 is empty/);
    const x1 = mk3mf(path.join(dir, "b.3mf"), { model: "Bambu Lab X1 Carbon" });
    await expect(slice(x1, {}, env)).rejects.toThrow(/在 Bambu Studio 里打开这个文件、把打印机换成 P2S/);
    process.env.FAKE_OUT = mk3mf(path.join(dir, "nogcode.3mf"), { model: "Bambu Lab P2S" });
    await expect(slice(p2s, {}, env)).rejects.toThrow(/没有 G-code/);
    process.env.FAKE_OUT = mk3mf(path.join(dir, "wrong.3mf"), { model: "Bambu Lab X1 Carbon", sliced: true });
    await expect(slice(p2s, {}, env)).rejects.toThrow(/是给「Bambu Lab X1 Carbon」的，不是 P2S，不能拿去打/);
    await expect(slice(x1, {}, { ...env, model: "H9X" })).rejects.toThrow(/系统配置里没有「Bambu Lab H9X 0.4 nozzle」/);
    await expect(slice(p2s, {}, { ...env, studio: path.join(dir, "nope") })).rejects.toThrow(/没找到 Bambu Studio/);
    await expect(slice(p2s, { layer_height: 1 }, env)).rejects.toThrow(/层高/);
    expect(fs.existsSync(env.outDir) ? fs.readdirSync(env.outDir) : []).toEqual([]);   // 失败的不留下
  });

  it("Bambu Studio 开着：不去切（会被它接走、一直卡着），马上说清楚要关掉", async () => {
    const { dir, env, last } = setup();
    const p2s = mk3mf(path.join(dir, "a.3mf"), { model: "Bambu Lab P2S" });
    fs.writeFileSync(path.join(dir, "log.json"), "{}");
    await expect(slice(p2s, {}, { ...env, isOpen: async () => true })).rejects.toThrow(/Bambu Studio 现在开着[\s\S]*关掉/);
    expect(last()).toEqual({});                // 没起 Bambu Studio
  });

  it("卡住（后台弹了看不见的窗口）：到时间停掉，带上最后的输出，告诉主人怎么处理", async () => {
    const { dir, env } = setup();
    const p2s = mk3mf(path.join(dir, "a.3mf"), { model: "Bambu Lab P2S" });
    process.env.FAKE_HANG = "1";
    try {
      await expect(slice(p2s, {}, { ...env, timeoutMs: 1500 })).rejects.toThrow(/切片超时[\s\S]*最后输出：\nloading project\.\.\.[\s\S]*结束所有 bambu-studio\.exe/);
    } finally { delete process.env.FAKE_HANG; }
  });

  it("include 的模板也并进来（P2S 的启动 / 换料 G-code 在模板里，不在 inherits 链上）；自己的键优先；模板缺了说清楚", () => {
    const root = tmpdir("prof-inc");
    const w = (j: any) => { const d = path.join(root, "BBL", "machine"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${j.name}.json`), JSON.stringify({ type: "machine", ...j })); };
    w({ name: "fdm_machine_common", instantiation: "false", machine_start_gcode: "G28 ; 通用的老启动代码", machine_end_gcode: "M84" });
    w({ name: "P2S template machine_start_gcode", instantiation: "false", machine_start_gcode: "M190 S[bed]\nM109 S[nozzle]\nG29" });
    w({ name: "P2S template change_filament_gcode", instantiation: "false", change_filament_gcode: "; 换料", printable_area: ["0x0", "1x1"] });
    w({ name: "Bambu Lab P2S 0.4 nozzle", inherits: "fdm_machine_common", instantiation: "true", include: ["P2S template machine_start_gcode", "P2S template change_filament_gcode"], printable_area: ["0x0", "256x256"] });
    w({ name: "坏的", inherits: "fdm_machine_common", instantiation: "true", include: ["没有这个模板"] });
    const m = new Profiles(root).flatten("machine", "Bambu Lab P2S 0.4 nozzle");
    expect(m).toMatchObject({ machine_start_gcode: "M190 S[bed]\nM109 S[nozzle]\nG29", change_filament_gcode: "; 换料", machine_end_gcode: "M84", printable_area: ["0x0", "256x256"], name: "Bambu Lab P2S 0.4 nozzle", type: "machine" });
    expect(m.include).toBeUndefined();
    expect(() => new Profiles(root).flatten("machine", "坏的")).toThrow(/引用的模板「没有这个模板」找不到/);
  });

  it("启动代码检查：第一次挤料之前要给喷嘴和热床加热；没挤料的不下结论", () => {
    expect(startCheck("M140 S60\nM190 S60\nM104 S220\nG28\nM109 S220\nG1 X1 Y1 E2\n")).toMatchObject({ extrudes: true, nozzleHeat: true, bedHeat: true });
    expect(startCheck("G28 ; home\nG1 E-2 ; 回抽不算\nG1 X5 Y5 E1.5\nM109 S220\n")).toMatchObject({ extrudes: true, nozzleHeat: false, bedHeat: false, line: 3 });
    expect(startCheck("M104 S140 ; 低温擦嘴不算加热\nM140 S55\nG1 X1 E1\n")).toMatchObject({ nozzleHeat: false, bedHeat: true });
    expect(startCheck("G28\nG1 X1 Y1\n").extrudes).toBe(false);
  });

  it("打印板类型：键 / 官方名字 / 中文都认；写进 --curr-bed-type；认不出的挡掉", () => {
    expect(["textured", "Textured PEI Plate", "纹理 PEI", "光面", "smooth", "低温板", "supertack", "工程板"].map(plateValue)).toEqual(["Textured PEI Plate", "Textured PEI Plate", "Textured PEI Plate", "High Temp Plate", "High Temp Plate", "Cool Plate", "Supertack Plate", "Engineering Plate"]);
    expect(plateValue("")).toBe("");
    expect(overrides({ plate_type: "smooth" })).toEqual(["--curr-bed-type=High Temp Plate"]);
    expect(checkOptions({ plate_type: "木板" })).toContain("打印板类型认不出");
  });

  it("温度检查：料和喷嘴温度对不上、超过喷嘴 / 热床上限的拦下；只看这一盘用到的料；正常的不报", () => {
    const dir = tmpdir("temps");
    const mk = (settings: any, used?: number[]) => {
      const f = path.join(dir, `${Math.random()}.3mf`);
      const info = used ? `<config><plate><metadata key="index" value="1"/>${used.map((id) => `<filament id="${id}" type="X" color="#fff" used_g="1"/>`).join("")}</plate></config>` : "";
      fs.writeFileSync(f, zip([{ name: "Metadata/project_settings.config", data: Buffer.from(JSON.stringify(settings)) }, ...(info ? [{ name: "Metadata/slice_info.config", data: Buffer.from(info) }] : [])]));
      return f;
    };
    const ok = { filament_type: ["PLA", "PETG"], nozzle_temperature: ["220", "255"], nozzle_temperature_initial_layer: ["220", "250"], hot_plate_temp: ["55", "70"], textured_plate_temp_initial_layer: ["65", "70"] };
    expect(tempProblems(mk(ok), 1)).toEqual([]);
    expect(tempProblems(mk({ ...ok, nozzle_temperature: ["260", "255"] }), 1)).toEqual(["第 1 种料是 PLA，喷嘴却是 220~260℃（PLA 一般 180~245℃）"]);
    expect(tempProblems(mk({ ...ok, nozzle_temperature: ["220", "320"] }), 1)).toEqual(["第 2 种料（PETG）喷嘴 320℃，超过打印机上限 300℃"]);
    expect(tempProblems(mk({ ...ok, hot_plate_temp: ["55", "120"] }), 1)).toEqual(["热床温度设到了 120℃（hot_plate_temp），超过上限 110℃"]);
    expect(tempProblems(mk({ ...ok, nozzle_temperature: ["220", "200"] }, [1]), 1)).toEqual([]);          // 第 2 种料这一盘没用到
  });

  it("切出来的文件启动代码不对（不加热就挤料）：不交出去", async () => {
    const { dir, env } = setup();
    const p2s = mk3mf(path.join(dir, "a.3mf"), { model: "Bambu Lab P2S" });
    const out = path.join(dir, "cold.3mf");
    fs.writeFileSync(out, zip([{ name: "Metadata/plate_1.gcode", data: Buffer.from("G28\nG1 X5 Y5 E2\n") }, { name: "Metadata/project_settings.config", data: Buffer.from(JSON.stringify({ printer_model: "Bambu Lab P2S" })) }]));
    process.env.FAKE_OUT = out;
    await expect(slice(p2s, { infill: 20 }, env)).rejects.toThrow(/切出来的文件不能用：第 1 盘的 G-code 在第一次挤料（第 2 行）之前没有给喷嘴加热、给热床加热/);
    expect(fs.existsSync(env.outDir) ? fs.readdirSync(env.outDir) : []).toEqual([]);
  });

  it("系统配置索引：不能直接用的（instantiation=false）不选；料先找同名的，再找同材质的 Generic", () => {
    const { env } = setup();
    const pr = new Profiles(env.profiles);
    expect(pr.pickProcess("Bambu Lab P2S 0.4 nozzle", 0.2)).toBe("0.20mm Standard @BBL P2S");
    expect(pr.pickFilament("Bambu Lab P2S 0.4 nozzle", "Bambu PLA Basic @BBL X1C", "PLA")).toBe("Bambu PLA Basic @BBL P2S");
    expect(pr.pickFilament("Bambu Lab P2S 0.4 nozzle", "Bambu PETG HF @BBL X1C", "PETG")).toBe("Generic PETG @BBL P2S");
    expect(pr.pickFilament("Bambu Lab P2S 0.4 nozzle", "", "TPU")).toBe("");
  });
});
