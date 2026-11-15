// 自带的 build123d 建模 MCP 服务器：`kagura mcp build123d`。build123d 是 Python 的参数化 CAD 库（OpenCascade 内核，Apache 2.0），
// 建出来的是精确的实体（B-rep）：倒圆角、挖孔、布尔都在实体上做，不会出 Blender 那种破洞；尺寸写成变量，改一个数就重建。
// 每次调用起一个 Python 跑她的代码（harness.ts），导出 STL + STEP；检查和预览图在本进程里按 STL 做（raster.ts），不用装别的。
//   "build123d": { "command": "kagura", "args": ["mcp", "build123d"], "timeout": 300, "ownerOnly": ["cad_build"],
//                  "env": { "PYTHON": "", "MODEL_BED": "256x256x256" } }
// 需要这台电脑上有 Python 3.10~3.13 和 `pip install build123d`。和 Blender 那个一样是独立进程、零依赖。
// 建模代码是任意 Python（和 exec 同级）：Kagura 里只给可信会话，模板再配 ownerOnly。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { HARNESS } from "./harness.ts";
import { readStl, checkMesh, renderGrid } from "./raster.ts";
import { guide, GUIDE_TOPICS } from "./guide.ts";
import { describeReport, parseBed, type BuildReport } from "../blender/mcp-server.ts";

export interface CadReport extends BuildReport { valid?: boolean; step?: string; step_error?: string; output?: string; picked?: string; fonts?: string[] }
type Py = { cmd: string; pre: string[] };

/** 候选的 Python：env PYTHON（可以带参数，如「py -3.12」）→ Windows 的 py -3 / python → python3 / python */
export function pythonCandidates(env: Record<string, string | undefined>, platform = process.platform): Py[] {
  const given = String(env.PYTHON ?? "").trim();
  if (given) {
    // 带空格的完整路径（C:\Program Files\…\python.exe）整个当命令；否则按空格拆出参数
    // 相对路径换成绝对的：建模时在临时目录里跑，相对路径就找不到了
    const abs = (c: string) => /[\\/]/.test(c) && !path.isAbsolute(c) ? path.resolve(c) : c;
    if (fs.existsSync(given) || !/\s/.test(given)) return [{ cmd: abs(given), pre: [] }];
    const [cmd, ...pre] = given.split(/\s+/);
    return [{ cmd: abs(cmd), pre }];
  }
  return platform === "win32" ? [{ cmd: "py", pre: ["-3"] }, { cmd: "python", pre: [] }] : [{ cmd: "python3", pre: [] }, { cmd: "python", pre: [] }];
}

const PROBE = "import sys\ntry:\n import build123d\n from importlib.metadata import version\n print('OK', version('build123d'))\nexcept Exception as e:\n print('NO', sys.version.split()[0], e)";

/** 找一个装了 build123d 的 Python；找不到就说清楚缺什么 */
export function findPython(env: Record<string, string | undefined>, platform = process.platform): { py?: Py; version?: string; error?: string } {
  const seen: string[] = [];
  for (const c of pythonCandidates(env, platform)) {
    const r = spawnSync(c.cmd, [...c.pre, "-c", PROBE], { encoding: "utf8", timeout: 60_000, windowsHide: true });
    if (r.error) continue;
    const out = String(r.stdout ?? "").trim();
    if (out.startsWith("OK")) return { py: c, version: out.split(/\s+/)[1] };
    if (out.startsWith("NO")) seen.push(`${[c.cmd, ...c.pre].join(" ")}（Python ${out.split(/\s+/)[1]}）`);
  }
  if (seen.length) return { error: `${seen.join("、")} 里没装 build123d。让主人在命令行运行：${pythonCandidates(env, platform)[0].cmd === "py" ? "py -3 -m pip install build123d" : "python3 -m pip install build123d"}（需要 Python 3.10~3.13）` };
  return { error: "这台电脑上没找到 Python。让主人装 Python 3.12（python.org），再运行 pip install build123d；装在别处的话在 MCP 配置的 env 里填 PYTHON（python.exe 的完整路径）。" };
}

/** 跑一次建模代码 */
export async function runCad(py: Py, job: Record<string, unknown>, timeoutMs: number): Promise<CadReport> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-cad-"));
  try {
    const script = path.join(work, "harness.py"), argFile = path.join(work, "args.json"), result = path.join(work, "result.json");
    fs.writeFileSync(script, HARNESS);
    fs.writeFileSync(argFile, JSON.stringify({ ...job, result }));
    const out = await new Promise<{ code: number | null; log: string; timedOut: boolean }>((resolve) => {
      let log = "", timedOut = false;
      // -I：不读当前目录 / 用户 site 里的同名模块；PYTHONIOENCODING 免得 Windows 上中文报错变乱码
      const child = spawn(py.cmd, [...py.pre, "-I", script, argFile], { cwd: work, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      const keep = (d: Buffer) => { log = (log + d.toString("utf8")).slice(-20_000); };
      child.stdout.on("data", keep); child.stderr.on("data", keep);
      const t = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      child.once("error", (e) => { clearTimeout(t); resolve({ code: null, log: String(e.message), timedOut }); });
      child.once("close", (code) => { clearTimeout(t); resolve({ code, log, timedOut }); });
    });
    if (out.timedOut) return { ok: false, error: `跑了 ${Math.round(timeoutMs / 1000)} 秒还没完，停掉了（模型太复杂——比如对上百个小物体逐个布尔、字太多，或者代码里有死循环）` };
    if (!fs.existsSync(result)) {
      const tail = out.log.trim().split(/\r?\n/).filter((l) => !/Fontconfig|Font_FontMgr/.test(l)).slice(-8).join("\n");
      return { ok: false, error: `Python 没跑起来（退出码 ${out.code ?? "?"}）${tail ? `：\n${tail}` : ""}` };
    }
    return JSON.parse(fs.readFileSync(result, "utf8"));
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

/** 按 STL 补上网格检查，并渲染预览图 */
export function meshAndPreview(r: CadReport, stl: string, png: string): CadReport {
  const m = readStl(stl);
  const c = checkMesh(m);
  r.tris = c.tris; r.boundary = c.boundary; r.non_manifold = c.non_manifold; r.loose_verts = 0;
  if (r.objects === undefined) {   // 看现成的 STL：没有实体信息，尺寸体积按网格
    r.objects = 1; r.volume_mm3 = c.volume_mm3;
    r.min = c.min.map((v) => Math.round(v * 100) / 100); r.max = c.max.map((v) => Math.round(v * 100) / 100);
    r.dims = c.max.map((v, i) => Math.round((v - c.min[i]) * 100) / 100);
  }
  try { fs.writeFileSync(png, renderGrid(m)); r.png = png; } catch (e: any) { r.render_errors = [String(e?.message ?? e)]; }
  return r;
}

const NAME_RE = /^[\p{L}\p{N}_-]{1,60}$/u;

const TOOLS = [
  {
    name: "cad_build", title: "用 build123d 建模",
    description: "写一段 build123d（Python 参数化 CAD）代码建 3D 打印模型：实体建模，倒圆角 / 挖孔 / 布尔都精确，尺寸写成变量好改。跑完检查、导出 STL + STEP，并给你四个角度的预览图（左上：前面斜上方，右上：正面，左下：右侧，右下：背面斜上方）。"
      + "**第一次用前先调 cad_guide** 看约定和常用写法（Box 默认是居中的、要 align 才落地，最后要 result = 零件）；有配合的读 topic=fits，建完按 topic=review 自查。"
      + "单位毫米，z 朝上，底面放在 z=0；每次给完整代码。看预览图和检查结果确认对了再交给 printer_slice。代码存成 <name>.py，改的时候可以 read_file 拿回来。",
    inputSchema: {
      type: "object", required: ["name", "code"],
      properties: {
        name: { type: "string", description: "模型名（文件名用，字母数字中文 _ -），同名会覆盖上一版" },
        code: { type: "string", description: "build123d 代码（已经 from build123d import *、import math；中文字体路径在 CJK_FONT，全部候选在 CJK_FONTS）。最后 result = 零件" },
      },
    },
  },
  {
    name: "cad_guide", title: "build123d 建模指导",
    description: "用 build123d 建 3D 打印模型的指导：约定和流程、常用写法（建体 / 定位 / 选边倒角 / 挖孔 / 草图挤出 / 字 / 阵列）、打印规矩、配合间隙和螺丝孔尺寸、自查清单、做得好看的方法、示例代码、出错怎么办。"
      + "不填 topic 给约定 + 常用写法 + 目录；做配合件前读 fits，建完读 review，要好看读 look。",
    inputSchema: { type: "object", properties: { topic: { type: "string", enum: [...GUIDE_TOPICS, "all"], description: `${GUIDE_TOPICS.join(" / ")} / all` } } },
  },
  {
    name: "cad_preview", title: "看一个 STL",
    description: "看这台电脑上一个现成的 .stl（比如从 MakerWorld 下载的）：尺寸、有没有破洞、放不放得进打印机，加四个角度的预览图。不需要 Python。3mf 项目文件直接给 printer_slice。",
    inputSchema: { type: "object", required: ["file"], properties: { file: { type: "string", description: "文件的完整路径" } } },
  },
];

export interface CadMcpOpts {
  input: Readable; output: Writable;
  env: Record<string, string | undefined>;
  log?(line: string): void;
  version?: string;
}

export function startCadMcp(o: CadMcpOpts): { close(): void } {
  const log = o.log ?? ((l: string) => { process.stderr.write(l + "\n"); });
  const send = (m: unknown) => { try { o.output.write(JSON.stringify(m) + "\n"); } catch { /* 对方关了 */ } };
  const env = (k: string) => String(o.env[k] ?? "").trim();
  const outRoot = env("MODEL_DIR") || path.join(process.cwd(), "models");
  const bed = parseBed(env("MODEL_BED") || "256x256x256");
  const timeoutMs = (Number(env("MODEL_TIMEOUT")) || 180) * 1000;
  let py: { py?: Py; version?: string; error?: string } | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  /** 一次只跑一个（OpenCascade 吃内存） */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
  const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });

  const reply = (r: CadReport, head: string) => {
    if (!r.ok) return fail(r.error || "没成功");
    const lines = [head, describeReport(r, bed)];
    if (r.valid === false) lines.push("注意：OpenCascade 说这个实体不完全有效（is_valid = False），切片多半还行，但最好检查最后几步布尔 / 倒角，换个顺序或把圆角改小。");
    if (r.objects && r.objects > 1) lines.push(`（结果里有 ${r.objects} 个分开的实体：本来就要分开打的零件没关系；要连成一体的就是没合上——让它们重叠一点再相加）`);
    if (r.step_error) lines.push(`STEP 没导出来：${r.step_error}`);
    if (r.output) lines.push(`代码里 print 的：\n${r.output.trim()}`);
    const content: any[] = [{ type: "text", text: lines.join("\n") }];
    if (r.png) {
      try { content.push({ type: "image", data: fs.readFileSync(r.png).toString("base64"), mimeType: "image/png" }); } catch { /* 图没了 */ }
      content.push({ type: "text", text: `预览图：${r.png}（灰底单色工作图；要给主人看就用 send_file 发这张）` });
    }
    return { content };
  };

  const build = async (args: any) => {
    py ??= findPython(o.env);
    if (!py.py) { const e = py.error!; py = null; return fail(e); }   // 主人装好之后下次再找
    const name = String(args?.name ?? "").trim(), code = String(args?.code ?? "");
    if (!NAME_RE.test(name)) return fail("name 只能用字母、数字、中文、_ 和 -（60 个字以内）");
    if (!code.trim()) return fail("code 是空的");
    const dir = path.join(outRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const codeFile = path.join(dir, `${name}.py`), stl = path.join(dir, `${name}.stl`);
    fs.writeFileSync(codeFile, code);
    const t0 = Date.now();
    const r = await serial(async () => {
      const r = await runCad(py!.py!, { code_file: codeFile, out_stl: stl, out_step: path.join(dir, `${name}.step`), bed }, timeoutMs);
      return r.ok ? meshAndPreview(r, stl, path.join(dir, `${name}.png`)) : r;
    });
    log(`📐 建模 ${name}：${r.ok ? `好了（${Math.round((Date.now() - t0) / 1000)} 秒）` : `失败 ${String(r.error).split("\n")[0]}`}`);
    const picked = r.picked && r.picked !== "result" ? `\n（没写 result，用的是最后建的 ${r.picked}；最好明确写 result = …）` : "";
    // 代码里有中文字：说清楚用的哪个字体——缺字时那个字是空的，只有看预览图才知道
    const cjk = /Text\s*\(/.test(code) && /[\u3000-\u9fff]/.test(code)
      ? r.fonts?.length ? `\n中文字体：CJK_FONT = ${r.fonts[0]}${r.fonts.length > 1 ? `（还有 ${r.fonts.slice(1).map((f) => path.basename(f)).join("、")}，在 CJK_FONTS 里）` : ""}。看预览图里每个字都在不在；缺字（尤其「楽」这类日文写法）就换 CJK_FONTS 里的日文字体（YuGoth / meiryo）。`
        : "\n没找到中文字体（CJK_FONTS 是空的），中文字会是空的：用 font_path= 指定一个字体文件，或者让主人装一个中文字体。"
      : "";
    return reply(r, `建好了（build123d ${r.version ?? ""}）。STL：${r.stl}${r.step ? `\nSTEP：${r.step}（别的 CAD 能打开继续改）` : ""}\n代码存在 ${codeFile}${picked}${cjk}`);
  };

  const preview = async (args: any) => {
    const file = String(args?.file ?? "").trim();
    if (!path.isAbsolute(file) || !fs.existsSync(file)) return fail(`这台电脑上没有 ${file}（要完整路径）`);
    if (!/\.stl$/i.test(file)) return fail("只能看 .stl；.3mf 直接交给 printer_slice。");
    const dir = path.join(outRoot, "_preview");
    fs.mkdirSync(dir, { recursive: true });
    const png = path.join(dir, `${path.basename(file).replace(/\.[^.]+$/, "")}.png`);
    const r = await serial(async () => {
      const r: CadReport = { ok: true };
      meshAndPreview(r, file, png);
      r.fits = (r.dims ?? []).every((d, i) => d <= bed[i] + 1e-6);
      return r;
    });
    if (!r.tris) return fail(`${path.basename(file)} 里读不出三角面（不是 STL，或者文件坏了）`);
    return reply(r, `${path.basename(file)}：`);
  };

  const rl = readline.createInterface({ input: o.input });
  rl.on("line", (line) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || m.id === undefined) return;
    const ok = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize": return ok({
        protocolVersion: m.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} },
        serverInfo: { name: "kagura-build123d", version: o.version ?? "0" },
        instructions: "用 build123d（Python 参数化 CAD）建 3D 打印模型：写代码 → 检查 → 导出 STL / STEP → 预览图",
      });
      case "ping": return ok({});
      case "tools/list": return ok({ tools: TOOLS });
      case "tools/call": {
        const name = m.params?.name, args = m.params?.arguments ?? {};
        if (name === "cad_guide") return ok({ content: [{ type: "text", text: guide(String(args?.topic ?? "")) }] });
        const run = name === "cad_build" ? build(args) : name === "cad_preview" ? preview(args) : null;
        if (!run) return ok({ content: [{ type: "text", text: `没有工具 ${name}` }], isError: true });
        run.then(ok).catch((e) => ok({ content: [{ type: "text", text: `出错了：${e?.message ?? e}` }], isError: true }));
        return;
      }
      default: return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `不支持 ${m.method}` } });
    }
  });
  return { close: () => rl.close() };
}

export function runCadMcp(version: string) {
  startCadMcp({ input: process.stdin, output: process.stdout, env: process.env, version });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}
