// 扩展：pi 格式的 TypeScript / JavaScript 模块，给 agent 加工具——agent 也可以自己写（extension_write）。
//
//   全局：<数据目录>/extensions/<名字>.ts（或 <名字>/index.ts）   本 agent：workspace/extensions/
//   格式与 pi 一致，pi 的扩展里「加工具」「加 MCP 服务器」这部分拿来就能用：
//     import { Type } from "@earendil-works/pi-ai";
//     export default function (pi) {
//       pi.registerTool({ name: "hello", label: "打招呼", description: "…", parameters: Type.Object({ name: Type.String() }),
//         async execute(id, params, signal, onUpdate, ctx) { return { content: [{ type: "text", text: `你好 ${params.name}` }], details: undefined }; } });
//     }
//   支持：pi.registerTool、pi.registerMcpServer；其它 pi API（命令、TUI、事件……）这里没有界面可接，调用了会记下来、不报错。
//
// 加载：sucrase 把 TS / ESM 转成 CommonJS，在本进程里执行（单文件可执行里也能用，不需要编译器）。
// 能 import 的：pi-ai / typebox / pi-coding-agent（defineTool 等）、Node 内置模块、扩展目录里的相对文件、
// 扩展旁边 node_modules 里的 CommonJS 包。
// 扩展代码和服务端同进程、同权限，跟「执行命令」一样危险：扩展的工具默认只在可信会话（主人）里出现，
// 工具定义里写 allowUntrusted: true 才给 IM 陌生人；agent 自己写扩展的工具也只在可信会话里有。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire, builtinModules } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { transform } from "sucrase";
import * as piAi from "@earendil-works/pi-ai";
import * as typebox from "typebox";
import * as piAgentCore from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunScope } from "./scope.ts";
import type { AgentInfo } from "./registry.ts";
import type { McpServerConfig } from "./mcp.ts";
import { ok, fail } from "./tools/device.ts";
import type { PackageManager } from "./packages.ts";

export const GLOBAL = "~global";
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TOOL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FACTORY_TIMEOUT = 10_000;

// ── pi 宿主提供的包（扩展包把它们写在 peerDependencies 里，不自带）──

const DEFAULT_MAX_LINES = 2000, DEFAULT_MAX_BYTES = 50 * 1024;
type TruncOpts = { maxLines?: number; maxBytes?: number };
/** 与 pi 的 truncateHead / truncateTail 同样的返回结构 */
function truncate(content: string, o: TruncOpts = {}, fromTail = false) {
  const maxLines = o.maxLines ?? DEFAULT_MAX_LINES, maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf8");
  const lines = content ? content.split("\n") : [];
  if (content.endsWith("\n")) lines.pop();
  const base = { totalLines: lines.length, totalBytes, lastLinePartial: false, firstLineExceedsLimit: false, maxLines, maxBytes };
  if (lines.length <= maxLines && totalBytes <= maxBytes) return { ...base, content, truncated: false, truncatedBy: null, outputLines: lines.length, outputBytes: totalBytes };
  const out: string[] = [];
  let bytes = 0, by: "lines" | "bytes" = "lines";
  const seq = fromTail ? [...lines].reverse() : lines;
  for (const l of seq) {
    if (out.length >= maxLines) break;
    const b = Buffer.byteLength(l, "utf8") + (out.length ? 1 : 0);
    if (bytes + b > maxBytes) { by = "bytes"; break; }
    out.push(l); bytes += b;
  }
  const text = (fromTail ? out.reverse() : out).join("\n");
  return { ...base, content: text, truncated: true, truncatedBy: by, outputLines: out.length, outputBytes: Buffer.byteLength(text, "utf8"), firstLineExceedsLimit: !fromTail && out.length === 0 };
}
/** 宿主包里这里没有的导出：拿到不报错（多半只在终端界面里用），真调用时才说明 */
const missing = (pkg: string, name: string) => {
  const f = function () { throw new Error(`Kagura 里没有 ${pkg} 的 ${name}（pi 终端界面相关的功能用不了）`); };
  Object.defineProperty(f, "name", { value: name });
  return f;
};
const lenient = (pkg: string, known: Record<string, unknown>) => new Proxy(known, {
  get: (t, k) => (typeof k !== "string" ? undefined : k in t ? t[k] : k === "__esModule" ? true : k === "default" ? t : missing(pkg, k)),
  has: () => true,
});
let agentDirForExt = path.join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent");
const codingAgentShim = lenient("pi-coding-agent", {
  defineTool: <T>(t: T) => t,
  withFileMutationQueue: async <T>(_p: string, fn: () => Promise<T>) => fn(),
  truncateHead: (c: string, o?: TruncOpts) => truncate(c, o, false),
  truncateTail: (c: string, o?: TruncOpts) => truncate(c, o, true),
  truncateLine: (l: string, max = 500) => ({ text: l.length > max ? `${l.slice(0, max)}... [truncated]` : l, wasTruncated: l.length > max }),
  formatSize: (b: number) => (b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1048576).toFixed(1)}MB`),
  DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, GREP_MAX_LINE_LENGTH: 500,
  getAgentDir: () => agentDirForExt,
  CONFIG_DIR_NAME: ".pi", VERSION: "kagura",
  parseFrontmatter: (text: string) => { const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text); return { frontmatter: {}, body: m ? text.slice(m[0].length) : text }; },
  stripFrontmatter: (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""),
  isToolCallEventType: (n: string, e: any) => e?.toolName === n,
});
/** 终端界面组件：扩展里 renderCall / renderResult 才用，这里永远不调用，给能 new 的空壳就行 */
class TuiStub { constructor(..._a: unknown[]) {} render() { return []; } invalidate() {} addChild() {} removeChild() {} setText() {} }
const tuiShim = new Proxy({
  truncateToWidth: (s: string, w: number) => String(s).slice(0, w), visibleWidth: (s: string) => String(s).length,
  wrapTextWithAnsi: (s: string) => [String(s)], matchesKey: () => false, Key: new Proxy({}, { get: (_t, k) => String(k) }),
} as Record<string, unknown>, { get: (t, k) => (typeof k !== "string" ? undefined : k in t ? t[k] : k === "__esModule" ? true : TuiStub), has: () => true });

const SHIMS: Record<string, unknown> = {
  "@earendil-works/pi-ai": piAi, "@mariozechner/pi-ai": piAi,
  "@earendil-works/pi-agent-core": piAgentCore, "@mariozechner/pi-agent-core": piAgentCore,
  typebox, "@sinclair/typebox": typebox,
  "@earendil-works/pi-coding-agent": codingAgentShim, "@mariozechner/pi-coding-agent": codingAgentShim,
  "@earendil-works/pi-tui": tuiShim, "@mariozechner/pi-tui": tuiShim,
};
/** typebox/compiler、pi-ai/xxx 这类子路径也走内置的 */
function shimFor(id: string): unknown {
  if (id in SHIMS) return SHIMS[id];
  const m = /^((?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(id);
  if (m && m[1] in SHIMS) return SHIMS[m[1]];
  return undefined;
}

/** 扩展加载时用的 pi 目录（getAgentDir），系统启动时设成数据目录下的一个子目录 */
export function setExtAgentDir(dir: string) { agentDirForExt = dir; }

export interface ExtTool extends AgentTool<any> { allowUntrusted?: boolean }
export interface LoadedExt {
  /** 来自哪个扩展包（自己写的扩展没有） */
  pkg?: string;
  owner: string;            // ~global 或 agent id
  name: string;
  file: string;
  tools: ExtTool[];
  mcpServers: { name: string; cfg: McpServerConfig }[];
  unsupported: string[];    // 调用了但这里没有的 pi API
  error: string;
  loadedAt: number;
}

const getBuiltin = (id: string): any => (process as any).getBuiltinModule?.(id) ?? createRequire(import.meta.url)(id);

const FILE_EXTS = ["", ".ts", ".js", ".mjs", ".cjs", ".mts", ".cts", ".json", "/index.ts", "/index.js", "/index.mjs", "/index.cjs", "/index.json"];
const asFile = (base: string) => FILE_EXTS.map((e) => base + e).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

/** package.json exports 里按条件取路径（node 的规则：按对象里键的顺序，第一个认识的条件生效） */
function pickExport(t: any): string | null {
  if (typeof t === "string") return t;
  if (Array.isArray(t)) { for (const x of t) { const r = pickExport(x); if (r) return r; } return null; }
  if (t && typeof t === "object") {
    for (const [k, v] of Object.entries(t)) if (["node", "import", "require", "module-sync", "default"].includes(k)) { const r = pickExport(v); if (r) return r; }
  }
  return null;
}
/** 解析裸模块名（node_modules 里的包）：自己实现 exports / main，这样纯 ESM 的包也能经转译加载 */
export function resolveBare(id: string, fromDir: string): string | null {
  const m = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(id);
  if (!m) return null;
  const [, name, sub = ""] = m;
  for (let d = fromDir; ; d = path.dirname(d)) {
    const pkgDir = path.join(d, "node_modules", name);
    const pjPath = path.join(pkgDir, "package.json");
    if (fs.existsSync(pjPath)) {
      let pj: any = {};
      try { pj = JSON.parse(fs.readFileSync(pjPath, "utf8")); } catch { /* 坏的 package.json */ }
      const key = "." + sub;
      if (pj.exports !== undefined) {
        const ex = typeof pj.exports === "string" || Array.isArray(pj.exports) || !Object.keys(pj.exports).some((k) => k.startsWith(".")) ? { ".": pj.exports } : pj.exports;
        let target = ex[key] !== undefined ? pickExport(ex[key]) : null;
        if (!target) {
          for (const [k, v] of Object.entries(ex)) {
            const star = k.indexOf("*");
            if (star < 0) continue;
            const pre = k.slice(0, star), post = k.slice(star + 1);
            if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
              const t = pickExport(v);
              if (t) { target = t.replace("*", key.slice(pre.length, key.length - post.length)); break; }
            }
          }
        }
        if (target) return asFile(path.join(pkgDir, target)) ?? null;
      }
      if (sub) return asFile(path.join(pkgDir, sub)) ?? null;
      return asFile(path.join(pkgDir, pj.main ?? pj.module ?? "index")) ?? asFile(path.join(pkgDir, "index")) ?? null;
    }
    if (path.dirname(d) === d) return null;
  }
}

/** 加载一个模块文件（转译 + 执行）。相对路径和 node_modules 里的包都走同一个加载器（ESM 也能用） */
function loadModule(file: string, cache: Map<string, any>): any {
  if (cache.has(file)) return cache.get(file).exports;
  if (file.endsWith(".json")) return JSON.parse(fs.readFileSync(file, "utf8"));
  if (file.endsWith(".node")) throw new Error(`用不了编译的原生模块 ${path.basename(file)}`);
  const src = fs.readFileSync(file, "utf8").replace(/^#!.*/, "");
  const isTs = /\.(ts|mts|cts|tsx)$/.test(file);
  let code = transform(src, { transforms: isTs ? ["typescript", "imports"] : ["imports"], filePath: file, production: true }).code;
  if (code.includes("import.meta")) code = code.replace(/\bimport\.meta\b/g, "__importMeta");
  const module = { exports: {} as any };
  cache.set(file, module);
  const dir = path.dirname(file);
  const resolve = (id: string): string => {
    if (id.startsWith(".") || path.isAbsolute(id) || id.startsWith("file:")) {
      const base = id.startsWith("file:") ? new URL(id).pathname : path.resolve(dir, id);
      const f = asFile(base);
      if (!f) throw new Error(`找不到模块 ${id}（相对 ${file}）`);
      return f;
    }
    const f = resolveBare(id, dir);
    if (!f) throw Object.assign(new Error(`找不到模块 ${id}（扩展包的依赖没装上？）`), { code: "MODULE_NOT_FOUND" });
    return f;
  };
  const req: any = (id: string): any => {
    const shim = shimFor(id);
    if (shim !== undefined) return shim;
    const bare = id.replace(/^node:/, "");
    if (id.startsWith("node:") || builtinModules.includes(bare)) return getBuiltin(id.startsWith("node:") ? id : `node:${bare}`);
    return loadModule(resolve(id), cache);
  };
  req.resolve = (id: string) => (shimFor(id) !== undefined || builtinModules.includes(id.replace(/^node:/, "")) ? id : resolve(id));
  const importMeta = { url: pathToFileURL(file).href, filename: file, dirname: dir, resolve: (id: string) => pathToFileURL(req.resolve(id)).href };
  const fn = vm.compileFunction(code, ["exports", "require", "module", "__filename", "__dirname", "__importMeta"], { filename: file });
  fn(module.exports, req, module, file, dir, importMeta);
  return module.exports;
}

/** 执行一个扩展文件，收集它注册的东西 */
export async function loadExtension(file: string, owner: string, name: string, opts: { cache?: Map<string, any>; pkg?: string; cwd?: string } = {}): Promise<LoadedExt> {
  const ext: LoadedExt = { owner, name, file, tools: [], mcpServers: [], unsupported: [], error: "", loadedAt: Date.now(), ...(opts.pkg ? { pkg: opts.pkg } : {}) };
  const handlers = new Map<string, ((...a: any[]) => any)[]>();
  const note = (k: string) => { if (!ext.unsupported.includes(k)) ext.unsupported.push(k); };
  try {
    const mod = loadModule(file, opts.cache ?? new Map());
    const factory = typeof mod === "function" ? mod : mod?.default;
    if (typeof factory !== "function") throw new Error("扩展要 export default 一个函数：export default function (pi) { pi.registerTool({...}) }");
    const api = new Proxy({
      registerTool(t: any) {
        if (!t || typeof t !== "object") throw new Error("registerTool 要传一个工具对象");
        if (!TOOL_RE.test(String(t.name ?? ""))) throw new Error(`工具名只能用字母、数字、_ -（≤64）：${t.name}`);
        if (typeof t.execute !== "function") throw new Error(`工具 ${t.name} 没有 execute 函数`);
        ext.tools.push(t);
      },
      registerMcpServer(n: string, cfg: McpServerConfig) { ext.mcpServers.push({ name: String(n), cfg }); },
      /** 事件：这里只有启动时的 session_start 会触发一次，其它（每轮前后、压缩……）记下来不触发 */
      on(ev: string, h: any) {
        if (typeof h !== "function") return;
        if (ev !== "session_start") note(`on("${ev}")`);
        handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
      },
      /** 跑一个命令（同 pi.exec）：{ stdout, stderr, code, killed } */
      exec(command: string, args: string[] = [], o: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}) {
        return new Promise((resolve) => {
          const p = spawn(command, args, { cwd: o.cwd ?? opts.cwd, signal: o.signal, timeout: o.timeout, windowsHide: true });
          let stdout = "", stderr = "";
          p.stdout?.on("data", (d) => { stdout += d; });
          p.stderr?.on("data", (d) => { stderr += d; });
          p.on("error", (e) => resolve({ stdout, stderr: stderr + String(e.message), code: -1, killed: false }));
          p.on("close", (code, sig) => resolve({ stdout, stderr, code: code ?? -1, killed: !!sig }));
        });
      },
      getActiveTools: () => [], getAllTools: () => [], setActiveTools: () => {}, getThinkingLevel: () => "off", setThinkingLevel: () => {},
      getFlag: () => undefined, registerFlag: () => {},
    } as Record<string, any>, {
      get(target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop in target) return target[prop];
        return (..._a: unknown[]) => note(prop);
      },
    });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.resolve(factory(api)),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("扩展初始化超过 10 秒")), FACTORY_TIMEOUT); }),
    ]).finally(() => clearTimeout(timer));
    // 「会话开始」：有的扩展在这里准备目录、读配置，工具才能用
    for (const h of handlers.get("session_start") ?? []) {
      try { await Promise.race([Promise.resolve(h({ type: "session_start", reason: "startup" }, extCtx({ cwd: opts.cwd ?? process.cwd() }))), new Promise((r) => setTimeout(r, FACTORY_TIMEOUT))]); }
      catch (e: any) { note(`session_start 出错：${String(e?.message ?? e).slice(0, 120)}`); }
    }
  } catch (e: any) {
    ext.error = String(e?.stack ?? e?.message ?? e).split("\n").slice(0, 6).join("\n");
    ext.tools = [];
  }
  return ext;
}

/** pi 扩展拿到的 ctx：没有界面（hasUI=false），ui 的方法都是空操作（confirm 一律不同意） */
function extCtx(base: Record<string, unknown>) {
  const ui = new Proxy({} as Record<string, any>, {
    get: (_t, k) => (k === "confirm" ? async () => false : k === "notify" ? (m: string) => console.log(`[ext] ${m}`) : k === "theme" ? new Proxy({}, { get: () => (s: string) => s }) : async () => undefined),
  });
  // 会话管理器：这里的会话不是 pi 的格式，给空的（扩展读历史时当作新会话）
  const sessionManager = new Proxy({} as Record<string, any>, {
    get: (_t, k) => (k === "getCwd" ? () => base.cwd : /^(getBranch|getEntries|getChildren|getTree|getLabels)$/.test(String(k)) ? () => [] : () => undefined),
  });
  return { hasUI: false, ui, sessionManager, isIdle: () => true, abort: () => {}, getContextUsage: () => undefined, ...base };
}

/** 包一层：结果规范化（字符串 → 文字内容）、报错变成工具错误、传 pi 风格的 ctx */
function wrapTool(t: ExtTool, ext: LoadedExt, agent: AgentInfo, scope: RunScope): AgentTool<any> {
  return {
    name: t.name, label: t.label ?? t.name,
    description: `${t.description ?? t.name}`.slice(0, 2000),
    parameters: t.parameters ?? piAi.Type.Object({}),
    execute: async (id: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      try {
        const ctx = extCtx({ cwd: agent.workspace, agentId: agent.id, sessionKey: scope.sessionKey, signal, extension: ext.name });
        const r: any = await (t.execute as any)(id, params, signal, onUpdate, ctx);
        if (typeof r === "string") return ok(r);
        if (!r || !Array.isArray(r.content)) return ok(r === undefined ? "（没有返回内容）" : JSON.stringify(r));
        return { details: undefined, ...r };
      } catch (e: any) {
        return fail(`扩展 ${ext.name} 的工具 ${t.name} 出错：${e?.message ?? e}`);
      }
    },
  };
}

export class Extensions {
  private loaded: LoadedExt[] = [];
  /** 扩展里注册的 MCP 服务器变了时回调（McpManager.setExtensionServers + reload） */
  onMcpServers: ((list: { name: string; cfg: McpServerConfig; source: string }[]) => void) | null = null;
  /** 装好的 pi 扩展包（其中的扩展当全局扩展加载） */
  packages: PackageManager | null = null;

  constructor(readonly globalDir: string, private agents: { list(): AgentInfo[]; get(id: string): AgentInfo | undefined }) {}

  dirOf(owner: string): string {
    if (owner === GLOBAL) return this.globalDir;
    const a = this.agents.get(owner);
    if (!a) throw Object.assign(new Error(`没有 agent ${owner}`), { status: 404 });
    return path.join(a.workspace, "extensions");
  }

  /** 一个目录里的扩展入口：<名字>.ts/.js 或 <名字>/index.ts|js */
  private entries(dir: string): { name: string; file: string }[] {
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out: { name: string; file: string }[] = [];
    for (const d of names) {
      if (d.name.startsWith(".")) continue;
      if (d.isFile()) {
        const m = /^(.+)\.(ts|js|mjs|cjs)$/.exec(d.name);
        if (m && NAME_RE.test(m[1])) out.push({ name: m[1], file: path.join(dir, d.name) });
      } else if (d.isDirectory() && NAME_RE.test(d.name) && d.name !== "node_modules") {
        const f = ["index.ts", "index.js"].map((x) => path.join(dir, d.name, x)).find((x) => fs.existsSync(x));
        if (f) out.push({ name: d.name, file: f });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async reloadAll(): Promise<LoadedExt[]> {
    const next: LoadedExt[] = [];
    const cache = new Map<string, any>();     // 同一轮加载里各扩展共用：同一个依赖只执行一次
    const cwd = path.dirname(this.globalDir);
    const owners = [GLOBAL, ...this.agents.list().map((a) => a.id)];
    for (const owner of owners) for (const e of this.entries(this.dirOf(owner))) next.push(await loadExtension(e.file, owner, e.name, { cache, cwd }));
    for (const { rec, res } of this.packages?.enabled() ?? []) {
      for (const f of res.extensions) {
        const base = path.basename(f).replace(/\.(ts|js|mjs|cjs|mts|cts)$/, "");
        const name = `${rec.id}/${base === "index" ? path.basename(path.dirname(f)) : base}`;
        next.push(await loadExtension(f, GLOBAL, name, { cache, cwd, pkg: rec.id }));
      }
    }
    this.loaded = next;
    for (const e of next) {
      if (e.error) console.log(`[ext] ⚠️  ${e.owner}/${e.name} 加载失败：${e.error.split("\n")[0]}`);
      else console.log(`[ext] ${e.owner}/${e.name}：${e.tools.map((t) => t.name).join("、") || "（没有工具）"}`);
    }
    this.onMcpServers?.(next.filter((e) => !e.error).flatMap((e) => e.mcpServers.map((m) => ({ ...m, source: `扩展 ${e.name}` }))));
    return next;
  }

  list() { return this.loaded; }

  /** 写一个扩展并立刻重新加载，返回加载结果（agent 用 extension_write 自己写工具时看这个结果改错） */
  async write(owner: string, name: string, code: string): Promise<LoadedExt> {
    if (!NAME_RE.test(name)) throw Object.assign(new Error("扩展名只能用字母、数字、_ 和 -"), { status: 400 });
    const dir = this.dirOf(owner);
    fs.mkdirSync(dir, { recursive: true });
    const existing = this.entries(dir).find((e) => e.name === name);
    const file = existing?.file ?? path.join(dir, `${name}.ts`);
    fs.writeFileSync(file, code);
    await this.reloadAll();
    return this.loaded.find((e) => e.owner === owner && e.name === name)!;
  }

  read(owner: string, name: string): { file: string; code: string } {
    const e = this.entries(this.dirOf(owner)).find((x) => x.name === name);
    if (!e) throw Object.assign(new Error(`没有扩展 ${name}`), { status: 404 });
    return { file: e.file, code: fs.readFileSync(e.file, "utf8") };
  }

  /** 删除：挪进 .trash/ */
  async remove(owner: string, name: string) {
    const dir = this.dirOf(owner);
    const e = this.entries(dir).find((x) => x.name === name);
    if (!e) throw Object.assign(new Error(`没有扩展 ${name}`), { status: 404 });
    const trash = path.join(dir, ".trash");
    fs.mkdirSync(trash, { recursive: true });
    const target = path.dirname(e.file) === dir ? e.file : path.dirname(e.file);
    fs.renameSync(target, path.join(trash, `${Date.now()}-${path.basename(target)}`));
    await this.reloadAll();
  }

  /** 运行时的工具提供者：全局扩展 + 这个 agent 自己的扩展；不可信会话里只给标了 allowUntrusted 的 */
  tools() {
    return (scope: RunScope, agent: AgentInfo): AgentTool<any>[] =>
      this.loaded.filter((e) => !e.error && (e.owner === GLOBAL || e.owner === agent.id))
        .flatMap((e) => e.tools.filter((t) => scope.trusted || t.allowUntrusted).map((t) => wrapTool(t, e, agent, scope)));
  }
}

export const TEMPLATE = `import { Type } from "@earendil-works/pi-ai";

export default function (pi) {
  pi.registerTool({
    name: "my_tool",                       // 字母数字下划线，别和已有工具重名
    label: "我的工具",
    description: "什么时候用、做什么（写给模型看的）",
    parameters: Type.Object({ city: Type.String({ description: "城市" }) }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // ctx.cwd 是你的工作目录；可以 import Node 内置模块（node:fs、node:child_process…）、用全局 fetch
      return { content: [{ type: "text", text: "结果" }], details: undefined };
    },
  });
}`;

/** agent 自己写工具：extension_list / extension_read / extension_write / extension_remove（只在可信会话里有） */
export function extensionTools(exts: Extensions) {
  return (scope: RunScope, agent: AgentInfo): AgentTool<any>[] => {
    if (!scope.trusted) return [];
    const ownerOf = (s?: string) => (s === "global" ? GLOBAL : agent.id);
    const brief = (e: LoadedExt) => `${e.owner === GLOBAL ? "全局" : "自己的"} ${e.name}：${e.error ? `❌ 加载失败\n${e.error}` : `工具 ${e.tools.map((t) => t.name).join("、") || "（没有）"}`}${e.unsupported.length ? `（这些 pi API 这里不支持、被忽略：${e.unsupported.join("、")}）` : ""}`;
    return [
      {
        name: "extension_list", label: "列出扩展",
        description: "列出你能用的扩展（自己写的工具）和它们的加载状态。",
        parameters: piAi.Type.Object({}),
        execute: async () => {
          const mine = exts.list().filter((e) => e.owner === GLOBAL || e.owner === agent.id);
          return ok(mine.length ? mine.map(brief).join("\n") : "还没有扩展。可以用 extension_write 给自己写一个工具。");
        },
      },
      {
        name: "extension_read", label: "读扩展代码",
        description: "读一个扩展的源码（改之前先读）。",
        parameters: piAi.Type.Object({ name: piAi.Type.String(), scope: piAi.Type.Optional(piAi.Type.String({ description: "agent（默认，自己的）或 global" })) }),
        execute: async (_id, p: any) => {
          try { const r = exts.read(ownerOf(p.scope), String(p.name)); return ok(`文件：${r.file}\n\n${r.code}`); } catch (e: any) { return fail(e.message); }
        },
      },
      {
        name: "extension_write", label: "写扩展（给自己加工具）",
        description: "给自己写一个新工具（或改已有的）：写一个 pi 格式的 TypeScript 扩展，保存后马上加载并返回结果；有错就看报错改了再写。"
          + "加载成功的工具从下一轮对话起可以直接调用。代码在主人的电脑上运行、权限很大：只写主人要的、安全的功能。\n模板：\n" + TEMPLATE,
        parameters: piAi.Type.Object({
          name: piAi.Type.String({ description: "扩展名（文件名），字母数字 _ -" }),
          code: piAi.Type.String({ description: "完整的 TypeScript 源码" }),
          scope: piAi.Type.Optional(piAi.Type.String({ description: "agent（默认，只给自己用）或 global（所有 agent 都能用）" })),
        }),
        execute: async (_id, p: any) => {
          try {
            const r = await exts.write(ownerOf(p.scope), String(p.name), String(p.code));
            console.log(`[ext] ✏️  ${agent.id} 写了扩展 ${r.owner}/${r.name}`);
            return r.error ? fail(`已保存到 ${r.file}，但加载失败：\n${r.error}`) : ok(`已保存并加载：${brief(r)}\n下一轮对话起就能直接调用这些工具。`);
          } catch (e: any) { return fail(e.message); }
        },
      },
      ...(exts.packages ? packageTools(exts) : []),
      {
        name: "extension_remove", label: "删除扩展",
        description: "删除一个扩展（挪进回收站）。",
        parameters: piAi.Type.Object({ name: piAi.Type.String(), scope: piAi.Type.Optional(piAi.Type.String()) }),
        execute: async (_id, p: any) => {
          try { await exts.remove(ownerOf(p.scope), String(p.name)); return ok(`已删除 ${p.name}`); } catch (e: any) { return fail(e.message); }
        },
      },
    ];
  };
}

/** 扩展包（pi 的扩展商店）：搜索、安装、列表、删除——同样只在可信会话里有 */
function packageTools(exts: Extensions): AgentTool<any>[] {
  const pm = exts.packages!;
  const summary = (id: string) => {
    const mine = exts.list().filter((e) => e.pkg === id);
    const tools = mine.flatMap((e) => e.tools.map((t) => t.name));
    const errs = mine.filter((e) => e.error).map((e) => `${e.name}：${e.error.split("\n")[0]}`);
    return `${tools.length ? `新工具：${tools.join("、")}` : "没有新工具"}${errs.length ? `；加载失败：${errs.join("；")}` : ""}`;
  };
  return [
    {
      name: "package_search", label: "搜索扩展包",
      description: "在 pi 的扩展商店（pi.dev/packages，npm 上的 pi 扩展包）里搜索能给你加能力的扩展包。主人想要某种新能力、而内置工具和技能做不到时用。",
      parameters: piAi.Type.Object({ query: piAi.Type.String({ description: "英文关键词效果更好，如 weather、github、pdf" }) }),
      execute: async (_id, p: any) => {
        try {
          const items = await pm.search(String(p.query ?? ""), 10);
          if (!items.length) return ok("没搜到。换个（英文）关键词试试。");
          return ok(items.map((x) => `${x.name}@${x.version}${x.installed ? "（已安装）" : ""}  周下载 ${x.weekly}\n  ${x.description}`).join("\n")
            + "\n注意：很多扩展包是给写代码的终端助手用的（命令、界面），不一定适合你。装之前先跟主人确认。");
        } catch (e: any) { return fail(`搜索失败：${e.message}`); }
      },
    },
    {
      name: "package_install", label: "安装扩展包",
      description: "安装一个 pi 扩展包（npm:包名、git:github.com/作者/仓库 或直接写包名），装好后里面的工具从下一轮对话起可用。"
        + "第三方代码在主人电脑上运行、权限很大：只装主人明确同意的包。",
      parameters: piAi.Type.Object({ source: piAi.Type.String({ description: "如 npm:pi-web-access 或 pi-web-access" }) }),
      execute: async (_id, p: any) => {
        try {
          const r = await pm.install(String(p.source ?? ""));
          return ok(`已安装 ${r.name}@${r.version}${r.deps ? `（${r.deps} 个依赖）` : ""}。${summary(r.id)}${r.warnings.length ? `\n提醒：${r.warnings.join("；")}` : ""}`);
        } catch (e: any) { return fail(`安装失败：${e.message}`); }
      },
    },
    {
      name: "package_list", label: "已装扩展包",
      description: "列出装了哪些 pi 扩展包、各自提供什么工具。",
      parameters: piAi.Type.Object({}),
      execute: async () => {
        const list = pm.list();
        return ok(list.length ? list.map((r) => `${r.id}（${r.name}@${r.version}${r.enabled ? "" : "，已停用"}）：${summary(r.id)}`).join("\n") : "还没装扩展包。");
      },
    },
    {
      name: "package_remove", label: "卸载扩展包",
      description: "卸载一个扩展包（挪进回收站）。参数是 package_list 里的 id。",
      parameters: piAi.Type.Object({ id: piAi.Type.String() }),
      execute: async (_id, p: any) => {
        try { await pm.remove(String(p.id)); return ok(`已卸载 ${p.id}`); } catch (e: any) { return fail(e.message); }
      },
    },
  ];
}
