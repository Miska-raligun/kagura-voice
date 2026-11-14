// 自带的 Blender 建模 MCP 服务器：`kagura mcp blender`。不用开着 Blender——每次调用在后台起一个 Blender（-b），跑完就退。
// 和打印机那个一样是独立进程、零依赖，别的 MCP 客户端也能用；核心里没有它的代码。
//   "blender": { "command": "kagura", "args": ["mcp", "blender"], "timeout": 300, "ownerOnly": ["model_build"],
//                "env": { "BLENDER": "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe", "MODEL_BED": "256x256x256" } }
// 工具：
//   model_build   她写 Blender Python 建模代码 → 空场景里跑 → 检查（尺寸 / 破洞 / 放不放得下）→ 导出 STL → 四个角度的预览图（图片直接给她看）
//   model_preview 看一个现成的 STL / OBJ（比如从 MakerWorld 下的）：同样的检查 + 预览图
// 建模代码是任意 Python（和 exec 同级）：Kagura 里只给可信会话，模板再配 ownerOnly。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { HARNESS } from "./harness.ts";

export interface BuildReport {
  ok: boolean; error?: string; version?: string;
  objects?: number; tris?: number; dims?: number[]; min?: number[]; max?: number[]; volume_mm3?: number;
  non_manifold?: number; boundary?: number; loose_verts?: number; fits?: boolean;
  stl?: string; png?: string; pngs?: string[]; render_errors?: string[];
}

/** 找 Blender：env 指定的 → Windows 默认装的位置里版本最高的 → macOS → PATH 里的 blender */
export function findBlender(env: Record<string, string | undefined>, platform = process.platform): string {
  const given = String(env.BLENDER ?? "").trim();
  if (given) return given;
  if (platform === "win32") {
    for (const base of [path.join(env.ProgramFiles || "C:\\Program Files", "Blender Foundation"), "C:\\Program Files\\Blender Foundation"]) {
      try {
        const vers = fs.readdirSync(base).filter((d) => /^Blender/i.test(d))
          .sort((a, b) => (b.match(/\d+/g) ?? []).map(Number).reduce((x, n, i) => x || n - Number((a.match(/\d+/g) ?? [])[i] ?? 0), 0));
        for (const v of vers) { const exe = path.join(base, v, "blender.exe"); if (fs.existsSync(exe)) return exe; }
      } catch { /* 没装在这 */ }
    }
    return "";
  }
  if (platform === "darwin" && fs.existsSync("/Applications/Blender.app/Contents/MacOS/Blender")) return "/Applications/Blender.app/Contents/MacOS/Blender";
  for (const d of String(env.PATH ?? "").split(path.delimiter)) { const p = path.join(d, "blender"); if (d && fs.existsSync(p)) return p; }
  return "";
}

/** 「256x256x256」→ [256, 256, 256]（P2S 的打印范围） */
export const parseBed = (s: string): number[] => { const m = /^\s*(\d+(?:\.\d+)?)\s*[x×*,]\s*(\d+(?:\.\d+)?)\s*[x×*,]\s*(\d+(?:\.\d+)?)\s*$/i.exec(s); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [256, 256, 256]; };
const NAME_RE = /^[\p{L}\p{N}_-]{1,60}$/u;

/** 跑一次 Blender（后台、出厂设置，不读主人的偏好和插件） */
export async function runBlender(blender: string, job: Record<string, unknown>, timeoutMs: number): Promise<BuildReport> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-blender-"));
  try {
    const script = path.join(work, "harness.py"), argFile = path.join(work, "args.json"), result = path.join(work, "result.json");
    fs.writeFileSync(script, HARNESS);
    fs.writeFileSync(argFile, JSON.stringify({ ...job, result }));
    const out = await new Promise<{ code: number | null; log: string; timedOut: boolean }>((resolve) => {
      let log = "", timedOut = false;
      const child = spawn(blender, ["-b", "--factory-startup", "--python-exit-code", "1", "--python", script, "--", argFile], { cwd: work, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const keep = (d: Buffer) => { log = (log + d.toString("utf8")).slice(-20_000); };
      child.stdout.on("data", keep); child.stderr.on("data", keep);
      const t = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      child.once("error", (e) => { clearTimeout(t); resolve({ code: null, log: String(e.message), timedOut }); });
      child.once("close", (code) => { clearTimeout(t); resolve({ code, log, timedOut }); });
    });
    if (out.timedOut) return { ok: false, error: `Blender 跑了 ${Math.round(timeoutMs / 1000)} 秒还没完，停掉了（模型太复杂，或者代码里有死循环）` };
    if (!fs.existsSync(result)) {
      const tail = out.log.trim().split(/\r?\n/).filter((l) => !/^(Blender \d|Read prefs|EGL Error|Color management|Fra:|Warning: )/.test(l)).slice(-8).join("\n");
      return { ok: false, error: `Blender 没跑起来（退出码 ${out.code ?? "?"}）${tail ? `：\n${tail}` : ""}` };
    }
    return JSON.parse(fs.readFileSync(result, "utf8"));
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

const r1 = (n: number) => (Math.round(n * 10) / 10).toString();
/** 检查结果说给她听 */
export function describeReport(r: BuildReport, bed: number[]): string {
  const d = r.dims ?? [0, 0, 0];
  const lines = [`尺寸：长 ${r1(d[0])} × 宽 ${r1(d[1])} × 高 ${r1(d[2])} mm；体积约 ${r1((r.volume_mm3 ?? 0) / 1000)} cm³（实心算，按 PLA 约 ${r1((r.volume_mm3 ?? 0) / 1000 * 1.24)} 克上限）；${r.objects} 个物体，${r.tris} 个三角面。`];
  const issues: string[] = [];
  if (r.boundary) issues.push(`有 ${r.boundary} 条破洞边（模型不封闭）：切片软件可能补不好，改成封闭的实体（别用单面平面，挤出要成体，布尔运算后检查）`);
  if (r.loose_verts) issues.push(`有 ${r.loose_verts} 个孤立的点，删掉`);
  if (!r.fits) issues.push(`放不进打印机（打印范围 ${bed.join(" × ")} mm），缩小或者拆成几块`);
  if (r.min && Math.abs(r.min[2]) > 0.05) issues.push(`最低点在 z=${r1(r.min[2])}，不在地面上（切片时会自动放到板上，但最好让底面贴着 z=0、底面平）`);
  if (Math.min(...d) < 0.8) issues.push(`最薄的方向只有 ${r1(Math.min(...d))} mm，打不出来（至少 1 mm 左右）`);
  lines.push(issues.length ? `问题：\n- ${issues.join("\n- ")}` : "检查：封闭、放得下，没发现问题。");
  // 没有破洞、只是有边连着两个以上的面：多半是几个物体贴在一起 / 插在一起，切片时会合成一个，一般没事
  if (!r.boundary && r.non_manifold) lines.push(`（有 ${r.non_manifold} 条边连着两个以上的面，多半是几个物体贴在一起，切片时会合并，一般没事；想更稳可以用 Boolean 的 Union 合成一个）`);
  if (r.render_errors?.length && !r.png && !r.pngs?.length) lines.push(`预览图没渲染出来：${r.render_errors[0]}`);
  return lines.join("\n");
}

const TOOLS = [
  {
    name: "model_build", title: "用 Blender 建模",
    description: "写一段 Blender Python（bpy）建模代码，在后台的 Blender 里跑（不用开着 Blender），检查后导出 STL，并给你四个角度的预览图（左上：前面斜上方，右上：正面，左下：右侧，右下：背面斜上方）。"
      + "规则：单位是毫米（1 = 1 mm），z 轴朝上，底面放在 z=0；每次都从空场景开始，所以每次给完整代码；场景里所有可见的网格（修改器生效后）会合成一个 STL。"
      + "可以用 bpy.ops.mesh.primitive_*、bmesh、修改器（Boolean、Solidify、Bevel、Array）、文字（bpy.ops.object.text_add 后会自动转成网格）。"
      + "要打印的东西必须是封闭的实体：别用单面平面；壁厚至少 1.2 mm；悬空超过 45° 要支撑。看预览图和检查结果确认对了再交给 printer_slice。代码会存成 <name>.py，下次改的时候可以 read_file 拿回来。",
    inputSchema: {
      type: "object", required: ["name", "code"],
      properties: {
        name: { type: "string", description: "模型名（文件名用，字母数字中文 _ -），同名会覆盖上一版" },
        code: { type: "string", description: "Blender Python 代码（bpy、bmesh、math、mathutils、Vector 已经导入）" },
      },
    },
  },
  {
    name: "model_preview", title: "看一个模型",
    description: "看这台电脑上一个现成的 .stl / .obj（比如从 MakerWorld 下载的）：尺寸、有没有破洞、放不放得进打印机，加四个角度的预览图。3mf 项目文件看不了（直接给 printer_slice）。",
    inputSchema: { type: "object", required: ["file"], properties: { file: { type: "string", description: "文件的完整路径" } } },
  },
];

export interface BlenderMcpOpts {
  input: Readable; output: Writable;
  env: Record<string, string | undefined>;
  log?(line: string): void;
  version?: string;
}

export function startBlenderMcp(o: BlenderMcpOpts): { close(): void } {
  const log = o.log ?? ((l: string) => { process.stderr.write(l + "\n"); });
  const send = (m: unknown) => { try { o.output.write(JSON.stringify(m) + "\n"); } catch { /* 对方关了 */ } };
  const env = (k: string) => String(o.env[k] ?? "").trim();
  const outRoot = env("MODEL_DIR") || path.join(process.cwd(), "models");
  const bed = parseBed(env("MODEL_BED") || "256x256x256");
  const timeoutMs = (Number(env("MODEL_TIMEOUT")) || 240) * 1000;
  let queue: Promise<unknown> = Promise.resolve();
  /** 一次只跑一个 Blender（一个就要好几百 MB 内存） */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };

  const reply = (r: BuildReport, head: string) => {
    const content: any[] = [];
    if (!r.ok) return { content: [{ type: "text", text: r.error || "没成功" }], isError: true };
    content.push({ type: "text", text: `${head}\n${describeReport(r, bed)}` });
    const imgs = r.png ? [r.png] : r.pngs ?? [];
    for (const p of imgs) { try { content.push({ type: "image", data: fs.readFileSync(p).toString("base64"), mimeType: "image/png" }); } catch { /* 图没了 */ } }
    if (imgs.length) content.push({ type: "text", text: `预览图：${imgs.join("、")}（要给主人看就用 send_file 发这张）` });
    return { content };
  };

  const build = async (args: any) => {
    const blender = findBlender(o.env);
    if (!blender || !fs.existsSync(blender)) return { content: [{ type: "text", text: "这台电脑上没找到 Blender。装了的话在 MCP 配置的 env 里填 BLENDER（blender.exe 的完整路径）。" }], isError: true };
    const name = String(args?.name ?? "").trim(), code = String(args?.code ?? "");
    if (!NAME_RE.test(name)) return { content: [{ type: "text", text: "name 只能用字母、数字、中文、_ 和 -（60 个字以内）" }], isError: true };
    if (!code.trim()) return { content: [{ type: "text", text: "code 是空的" }], isError: true };
    const dir = path.join(outRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const codeFile = path.join(dir, `${name}.py`);
    fs.writeFileSync(codeFile, code);
    const t0 = Date.now();
    const r = await serial(() => runBlender(blender, { mode: "build", code_file: codeFile, out_stl: path.join(dir, `${name}.stl`), out_png: path.join(dir, `${name}.png`), bed }, timeoutMs));
    log(`🧊 建模 ${name}：${r.ok ? `好了（${Math.round((Date.now() - t0) / 1000)} 秒）` : `失败 ${String(r.error).split("\n")[0]}`}`);
    return reply(r, `建好了（Blender ${r.version ?? ""}）。STL：${r.stl}\n代码存在 ${codeFile}`);
  };

  const preview = async (args: any) => {
    const blender = findBlender(o.env);
    if (!blender || !fs.existsSync(blender)) return { content: [{ type: "text", text: "这台电脑上没找到 Blender。装了的话在 MCP 配置的 env 里填 BLENDER（blender.exe 的完整路径）。" }], isError: true };
    const file = String(args?.file ?? "").trim();
    if (!path.isAbsolute(file) || !fs.existsSync(file)) return { content: [{ type: "text", text: `这台电脑上没有 ${file}（要完整路径）` }], isError: true };
    if (!/\.(stl|obj)$/i.test(file)) return { content: [{ type: "text", text: "只能看 .stl 和 .obj；.3mf 直接交给 printer_slice。" }], isError: true };
    const dir = path.join(outRoot, "_preview");
    fs.mkdirSync(dir, { recursive: true });
    const png = path.join(dir, `${path.basename(file).replace(/\.[^.]+$/, "")}.png`);
    const r = await serial(() => runBlender(blender, { mode: "preview", import_file: file, out_png: png, bed }, timeoutMs));
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
        serverInfo: { name: "kagura-blender", version: o.version ?? "0" },
        instructions: "用 Blender 建 3D 打印模型（后台运行，不用开着 Blender）：写建模代码 → 检查 → 导出 STL → 预览图",
      });
      case "ping": return ok({});
      case "tools/list": return ok({ tools: TOOLS });
      case "tools/call": {
        const name = m.params?.name, args = m.params?.arguments ?? {};
        const run = name === "model_build" ? build(args) : name === "model_preview" ? preview(args) : null;
        if (!run) return ok({ content: [{ type: "text", text: `没有工具 ${name}` }], isError: true });
        run.then(ok).catch((e) => ok({ content: [{ type: "text", text: `出错了：${e?.message ?? e}` }], isError: true }));
        return;
      }
      default: return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `不支持 ${m.method}` } });
    }
  });
  return { close: () => rl.close() };
}

export function runBlenderMcp(version: string) {
  startBlenderMcp({ input: process.stdin, output: process.stdout, env: process.env, version });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}
