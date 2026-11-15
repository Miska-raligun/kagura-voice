// 用这台电脑上装的 Bambu Studio 的命令行切片（不带界面）：项目文件 / STL → 切好的 .gcode.3mf。
//
// 两条路（命令行的配置加载在社区里反映不太稳，所以分开）：
//   ① 文件本来就是给这台打印机配的 Bambu Studio 项目（MakerWorld 上选对机型的那份打印配置）：用文件里自带的配置，
//      只在命令行上覆盖主人指定的几项（层高、填充、墙数、支撑、裙边）——命令行的值优先级最高（官方 wiki）。最稳。
//   ② 给别的机型配的项目、普通 3MF、STL：换成这台打印机的系统配置（机器 + 工艺 + 每种料）再切。实验性：
//      系统配置是一层层 inherits 的，命令行不认这个链，要先自己展开成一份完整配置、标成用户配置（社区的做法）。
// 切完一律核对：输出里有没有 G-code、是不是给这台打印机切的（不是就不交出去——拿别的机型的 G-code 打，喷头可能撞板）。
// 命令行参数照官方 wiki（Command-Line-Usage）和社区整理，写的时候手边没有 Bambu Studio，没在真机上跑过。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { platesOf, projectInfo, sliceInfo, modelMatches, zipNames, type ProjectInfo, type SliceInfo } from "./threemf.ts";

export interface SliceOptions {
  plate?: number;
  layer_height?: number;
  /** 填充密度（百分比） */
  infill?: number;
  walls?: number;
  supports?: "off" | "normal" | "tree";
  brim?: "auto" | "off" | "outer";
}

export interface SliceEnv {
  /** bambu-studio 可执行文件；空 = 按系统找默认装的位置 */
  studio?: string;
  /** 系统配置目录（里面有 BBL/machine、BBL/process、BBL/filament）；空 = 跟着可执行文件找 */
  profiles?: string;
  /** 这台打印机的型号（「P2S」），项目里的 printer_model 要对得上 */
  model: string;
  /** 喷嘴直径，选机器配置用（「Bambu Lab P2S 0.4 nozzle」） */
  nozzle?: string;
  /** 切片文件放哪 */
  outDir: string;
  timeoutMs?: number;
  log?(line: string): void;
}

export interface SliceResult { file: string; plates: SliceInfo[]; mode: "project" | "switched"; info: ProjectInfo; warnings: string[] }

/** 默认装在哪 */
export function findStudio(env: Pick<SliceEnv, "studio">, platform = process.platform, exists = fs.existsSync): string {
  if (env.studio) return env.studio;
  const c = platform === "win32" ? ["C:\\Program Files\\Bambu Studio\\bambu-studio.exe", "C:\\Program Files (x86)\\Bambu Studio\\bambu-studio.exe"]
    : platform === "darwin" ? ["/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"]
    : ["/usr/bin/bambu-studio", "/usr/local/bin/bambu-studio", path.join(os.homedir(), "Applications", "BambuStudio.AppImage")];
  return c.find((p) => exists(p)) ?? "";
}

export function findProfiles(env: Pick<SliceEnv, "profiles">, studio: string, exists = fs.existsSync): string {
  if (env.profiles) return env.profiles;
  const dir = path.dirname(studio);
  return [path.join(dir, "resources", "profiles"), path.join(dir, "..", "Resources", "profiles")].find((p) => exists(path.join(p, "BBL"))) ?? "";
}

// ── 系统配置：按 name 建索引，展开 inherits ──

type Kind = "machine" | "process" | "filament";
export class Profiles {
  private idx = new Map<string, { kind: Kind; json: any }>();
  constructor(root: string) {
    for (const kind of ["machine", "process", "filament"] as Kind[]) {
      const dir = path.join(root, "BBL", kind);
      const walk = (d: string) => {
        let list: fs.Dirent[] = [];
        try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of list) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".json")) { try { const j = JSON.parse(fs.readFileSync(p, "utf8")); if (j?.name) this.idx.set(`${kind}:${j.name}`, { kind, json: j }); } catch { /* 坏文件跳过 */ } }
        }
      };
      walk(dir);
    }
  }
  get size() { return this.idx.size; }
  has(kind: Kind, name: string) { return this.idx.has(`${kind}:${name}`); }
  names(kind: Kind) { return [...this.idx.keys()].filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1)); }
  raw(kind: Kind, name: string) { return this.idx.get(`${kind}:${name}`)?.json; }

  /** 把 inherits 链从根到叶并成一份完整配置，标成用户配置（命令行只认完整配置） */
  flatten(kind: Kind, name: string): Record<string, unknown> {
    const chain: any[] = [];
    for (let n: string | undefined = name, guard = 0; n && guard < 20; guard++) {
      const j = this.raw(kind, n);
      if (!j) throw new Error(`找不到${kind === "machine" ? "机器" : kind === "process" ? "工艺" : "耗材"}配置「${n}」`);
      chain.unshift(j);
      n = j.inherits || undefined;
    }
    const out: Record<string, unknown> = {};
    for (const j of chain) Object.assign(out, j);
    out.name = name;
    out.from = "User";
    out.inherits = name;
    delete out.instantiation;
    const idKey = kind === "machine" ? "printer_settings_id" : kind === "process" ? "print_settings_id" : "filament_settings_id";
    out[idKey] = kind === "filament" ? [name] : name;
    return out;
  }

  /** 和这台机器配套的工艺：层高最接近的，同样接近时名字里带 Standard 的优先 */
  pickProcess(machine: string, layer = 0.2): string {
    const ok = this.names("process").filter((n) => this.compatible("process", n, machine));
    if (!ok.length) throw new Error(`系统配置里没有给「${machine}」用的工艺配置`);
    const lh = (n: string) => Number(this.flatten("process", n).layer_height ?? /^(\d+\.\d+)mm/.exec(n)?.[1] ?? 0.2);
    return ok.sort((a, b) => Math.abs(lh(a) - layer) - Math.abs(lh(b) - layer) || Number(/Standard/i.test(b)) - Number(/Standard/i.test(a)))[0];
  }

  /** 和这台机器配套的耗材：先找同名（去掉「@BBL X1C」换成这台的），再找同材质的 Generic */
  pickFilament(machine: string, profile: string, type: string): string {
    const ok = this.names("filament").filter((n) => this.compatible("filament", n, machine));
    const base = profile.replace(/\s*@.*$/, "").trim();
    return (base && ok.find((n) => n.replace(/\s*@.*$/, "").trim() === base))
      || ok.find((n) => /^Generic /i.test(n) && String(this.flatten("filament", n).filament_type ?? "").toUpperCase() === type.toUpperCase())
      || ok.find((n) => String(this.flatten("filament", n).filament_type ?? "").toUpperCase() === type.toUpperCase())
      || "";
  }

  private compatible(kind: Kind, name: string, machine: string) {
    const j = this.raw(kind, name);
    if (!j || j.instantiation === "false") return false;
    const cp = this.flatten(kind, name).compatible_printers;
    return Array.isArray(cp) && cp.includes(machine);
  }
}

// ── 跑命令行 ──

/** 命令行上覆盖的参数（--key=value 优先级最高；横线写法和官方 wiki 一致） */
export function overrides(o: SliceOptions): string[] {
  const a: string[] = [];
  if (o.layer_height !== undefined) a.push(`--layer-height=${o.layer_height}`);
  if (o.infill !== undefined) a.push(`--sparse-infill-density=${o.infill}%`);
  if (o.walls !== undefined) a.push(`--wall-loops=${o.walls}`);
  if (o.supports === "off") a.push("--enable-support=0");
  else if (o.supports) a.push("--enable-support=1", `--support-type=${o.supports}(auto)`);
  if (o.brim) a.push(`--brim-type=${o.brim === "off" ? "no_brim" : o.brim === "outer" ? "outer_only" : "auto_brim"}`);
  return a;
}

export function checkOptions(o: SliceOptions): string {
  if (o.layer_height !== undefined && !(o.layer_height >= 0.06 && o.layer_height <= 0.32)) return "层高要在 0.06 ~ 0.32 mm 之间（0.4 喷嘴常用 0.12 / 0.16 / 0.2 / 0.24 / 0.28）";
  if (o.infill !== undefined && !(o.infill >= 0 && o.infill <= 100)) return "填充密度是 0 ~ 100（百分比）";
  if (o.walls !== undefined && !(Number.isInteger(o.walls) && o.walls >= 1 && o.walls <= 10)) return "墙层数是 1 ~ 10 的整数";
  return "";
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let out = "", timedOut = false;
    const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (d: Buffer) => { out = (out + d.toString("utf8")).slice(-20_000); };
    child.stdout.on("data", keep); child.stderr.on("data", keep);
    // Windows 上连它派生的子进程一起结束（只 kill 主进程的话，卡住的那个可能还挂在后台占着配置目录，下一次切片接着卡）
    const t = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
      else child.kill();
    }, timeoutMs);
    child.once("error", (e) => { clearTimeout(t); resolve({ code: null, out: String(e.message), timedOut }); });
    child.once("close", (code) => { clearTimeout(t); resolve({ code, out, timedOut }); });
  });
}

/** 切一个文件。成功返回切好的文件（已核对是给这台打印机切的）；失败抛错，错误信息是给人看的 */
export async function slice(src: string, o: SliceOptions, env: SliceEnv): Promise<SliceResult> {
  const studio = findStudio(env);
  if (!studio || !fs.existsSync(studio)) throw new Error("这台电脑上没找到 Bambu Studio。装了的话在 MCP 配置的 env 里填 BAMBU_STUDIO（bambu-studio.exe 的完整路径）。");
  const bad = checkOptions(o);
  if (bad) throw new Error(bad);
  const isStl = /\.stl$/i.test(src);
  const info = isStl ? { bambu: false, printerModel: "", printerProfile: "", processProfile: "", layerHeight: "", filaments: [] } as ProjectInfo : projectInfo(src);
  const plate = Math.max(1, Math.round(o.plate ?? 1));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-slice-"));
  const warnings: string[] = [];
  try {
    const args = ["--slice", String(plate)];
    const same = info.bambu && modelMatches(info.printerModel, env.model);
    let mode: SliceResult["mode"] = "project";
    if (!same) {
      // ② 换成这台打印机的系统配置
      mode = "switched";
      const root = findProfiles(env, studio);
      if (!root) throw new Error("找不到 Bambu Studio 的系统配置目录。在 env 里填 BAMBU_PROFILES（里面有 BBL 文件夹的那个 profiles 目录）。");
      const pr = new Profiles(root);
      const machine = `Bambu Lab ${env.model} ${env.nozzle || "0.4"} nozzle`;
      if (!pr.has("machine", machine)) {
        const near = pr.names("machine").filter((n) => n.includes(env.model)).slice(0, 5);
        throw new Error(`系统配置里没有「${machine}」${near.length ? `（有：${near.join("、")}）` : "：这个版本的 Bambu Studio 可能还不认这台打印机，先升级"}`);
      }
      const proc = pr.pickProcess(machine, o.layer_height ?? (Number(info.layerHeight) || 0.2));
      const fils = (info.filaments.length ? info.filaments : [{ type: "PLA", color: "", profile: "" }]).map((f) => {
        const n = pr.pickFilament(machine, f.profile, f.type);
        if (!n) throw new Error(`系统配置里没有给 ${env.model} 用的 ${f.type} 耗材配置`);
        return n;
      });
      const write = (name: string, j: unknown) => { const p = path.join(work, name); fs.writeFileSync(p, JSON.stringify(j, null, 2)); return p; };
      const m = pr.flatten("machine", machine);
      // 社区的经验：命令行会把每个加载文件里的每个键都用上，工艺 / 耗材里和机器重复的键去掉，免得盖掉机器的
      const strip = (j: Record<string, unknown>) => { for (const k of Object.keys(m)) if (!["name", "from", "inherits", "compatible_printers"].includes(k)) delete j[k]; return j; };
      args.push("--load-settings", `${write("machine.json", m)};${write("process.json", strip(pr.flatten("process", proc)))}`);
      args.push("--load-filaments", fils.map((n, i) => write(`filament${i + 1}.json`, strip(pr.flatten("filament", n)))).join(";"));
      warnings.push(info.bambu ? `这个文件原本是给「${info.printerModel || info.printerProfile || "别的打印机"}」配的，已经换成 ${env.model} 的系统配置（${proc}；料：${[...new Set(fils)].join("、")}）重新切。原作者调过的参数没有带过来。`
        : `${isStl ? "STL" : "这个 3MF"} 没有打印配置，用的是 ${env.model} 的系统配置（${proc}；料：${[...new Set(fils)].join("、")}）。`);
      env.log?.(`切片：换配置 ${machine} / ${proc} / ${fils.join("、")}`);
    }
    args.push(...overrides(o));
    const outName = `${path.basename(src).replace(/\.(gcode\.3mf|3mf|stl)$/i, "")}.gcode.3mf`;
    // --outputdir 会直接拼在 --export-3mf 前面（社区整理的行为），目录末尾带分隔符
    args.push("--outputdir", work + path.sep, "--export-3mf", outName, src);
    env.log?.(`切片：${studio} ${args.join(" ")}`);
    const r = await run(studio, args, work, env.timeoutMs ?? 9 * 60_000);
    const produced = [path.join(work, outName), path.join(work, path.basename(outName))].find((p) => fs.existsSync(p));
    const tail = r.out.trim().split(/\r?\n/).filter(Boolean).slice(-6).join("\n");
    // 卡住多半不是模型太复杂（一般一两分钟就切完），而是 Bambu Studio 弹了个看不见的窗口在等人点（更新提示、上次异常退出的报告…）
    if (r.timedOut) throw new Error(`切片超时（${Math.round((env.timeoutMs ?? 540_000) / 60_000)} 分钟还没切完），已经停掉。${tail ? `Bambu Studio 最后输出：\n${tail}\n` : "Bambu Studio 一行输出都没有。"}`
      + "这种一般不是模型的问题，是 Bambu Studio 在后台弹了窗口等人点（刚自动更新过、上次被强行关掉后的报告窗口等）。请主人：① 任务管理器里结束所有 bambu-studio.exe；② 正常打开一次 Bambu Studio，把弹出来的窗口点掉，再关掉；③ 再切一次。");
    if (!produced) throw new Error(`切片失败（退出码 ${r.code ?? "?"}）${tail ? `：\n${tail}` : ""}${mode === "switched" ? "\n换配置切片在命令行里不太稳。可以让主人在 Bambu Studio 里打开这个文件、把打印机换成 " + env.model + "、保存项目，再拿保存的文件来切。" : ""}`);
    if (!platesOf(zipNames(produced)).length) throw new Error(`切出来的文件里没有 G-code（第 ${plate} 盘可能不存在，或者这一盘上没有东西）${tail ? `：\n${tail}` : ""}`);
    const outInfo = projectInfo(produced);
    if (outInfo.printerModel && !modelMatches(outInfo.printerModel, env.model)) throw new Error(`切出来的文件是给「${outInfo.printerModel}」的，不是 ${env.model}，不能拿去打（会撞板）。${mode === "project" ? "" : "换配置没换成功。"}`);
    if (!outInfo.printerModel) warnings.push("切出来的文件里看不出是给哪台打印机的，打之前在 Bambu Studio 里确认一下。");
    fs.mkdirSync(env.outDir, { recursive: true });
    let dest = path.join(env.outDir, outName);
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(env.outDir, outName.replace(/\.gcode\.3mf$/i, `-${i}.gcode.3mf`));
    fs.copyFileSync(produced, dest);
    return { file: dest, plates: sliceInfo(dest), mode, info, warnings };
  } finally {
    // 每次切片会留下不少临时文件
    fs.rmSync(work, { recursive: true, force: true });
  }
}
