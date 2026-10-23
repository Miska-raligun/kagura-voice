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
import { transform } from "sucrase";
import * as piAi from "@earendil-works/pi-ai";
import * as typebox from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunScope } from "./scope.ts";
import type { AgentInfo } from "./registry.ts";
import type { McpServerConfig } from "./mcp.ts";
import { ok, fail } from "./tools/device.ts";

export const GLOBAL = "~global";
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TOOL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FACTORY_TIMEOUT = 10_000;

/** pi-coding-agent 里扩展常用的几个帮助函数（只做最小实现） */
const codingAgentShim = {
  defineTool: <T>(t: T) => t,
  withFileMutationQueue: async <T>(_p: string, fn: () => Promise<T>) => fn(),
  truncateHead: (s: string, n = 20000) => (s.length > n ? s.slice(-n) : s),
  truncateTail: (s: string, n = 20000) => (s.length > n ? s.slice(0, n) : s),
};
const SHIMS: Record<string, unknown> = {
  "@earendil-works/pi-ai": piAi, "@mariozechner/pi-ai": piAi,
  typebox, "@sinclair/typebox": typebox,
  "@earendil-works/pi-coding-agent": codingAgentShim, "@mariozechner/pi-coding-agent": codingAgentShim,
};

export interface ExtTool extends AgentTool<any> { allowUntrusted?: boolean }
export interface LoadedExt {
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

/** 加载一个模块文件（转译 + 执行），相对 import 递归走同一个加载器 */
function loadModule(file: string, cache: Map<string, any>): any {
  if (cache.has(file)) return cache.get(file).exports;
  if (file.endsWith(".json")) return JSON.parse(fs.readFileSync(file, "utf8"));
  const src = fs.readFileSync(file, "utf8");
  const isTs = /\.(ts|mts|cts|tsx)$/.test(file);
  const code = transform(src, { transforms: isTs ? ["typescript", "imports"] : ["imports"], filePath: file, production: true }).code;
  const module = { exports: {} as any };
  cache.set(file, module);
  const dir = path.dirname(file);
  const nodeRequire = createRequire(file);
  const req = (id: string): any => {
    if (id in SHIMS) return SHIMS[id];
    const bare = id.replace(/^node:/, "");
    if (id.startsWith("node:") || builtinModules.includes(bare)) return getBuiltin(id.startsWith("node:") ? id : `node:${bare}`);
    if (id.startsWith(".") || path.isAbsolute(id)) {
      const base = path.resolve(dir, id);
      const cand = [base, ...[".ts", ".js", ".mjs", ".cjs", ".json"].map((e) => base + e), ...["index.ts", "index.js"].map((f) => path.join(base, f))]
        .find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (!cand) throw new Error(`找不到模块 ${id}（相对 ${file}）`);
      return loadModule(cand, cache);
    }
    return nodeRequire(id);     // 扩展旁边 node_modules 里的 CommonJS 包
  };
  const fn = vm.compileFunction(code, ["exports", "require", "module", "__filename", "__dirname"], { filename: file });
  fn(module.exports, req, module, file, dir);
  return module.exports;
}

/** 执行一个扩展文件，收集它注册的东西 */
export async function loadExtension(file: string, owner: string, name: string): Promise<LoadedExt> {
  const ext: LoadedExt = { owner, name, file, tools: [], mcpServers: [], unsupported: [], error: "", loadedAt: Date.now() };
  try {
    const mod = loadModule(file, new Map());
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
    } as Record<string, any>, {
      get(target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop in target) return target[prop];
        return (..._a: unknown[]) => { if (!ext.unsupported.includes(prop)) ext.unsupported.push(prop); };
      },
    });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.resolve(factory(api)),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("扩展初始化超过 10 秒")), FACTORY_TIMEOUT); }),
    ]).finally(() => clearTimeout(timer));
  } catch (e: any) {
    ext.error = String(e?.stack ?? e?.message ?? e).split("\n").slice(0, 6).join("\n");
    ext.tools = [];
  }
  return ext;
}

/** 包一层：结果规范化（字符串 → 文字内容）、报错变成工具错误、传 pi 风格的 ctx */
function wrapTool(t: ExtTool, ext: LoadedExt, agent: AgentInfo, scope: RunScope): AgentTool<any> {
  return {
    name: t.name, label: t.label ?? t.name,
    description: `${t.description ?? t.name}`.slice(0, 2000),
    parameters: t.parameters ?? piAi.Type.Object({}),
    execute: async (id: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      try {
        const ctx = { cwd: agent.workspace, agentId: agent.id, sessionKey: scope.sessionKey, signal, extension: ext.name };
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
    const owners = [GLOBAL, ...this.agents.list().map((a) => a.id)];
    for (const owner of owners) for (const e of this.entries(this.dirOf(owner))) next.push(await loadExtension(e.file, owner, e.name));
    this.loaded = next;
    for (const e of next) {
      if (e.error) console.log(`[ext] ⚠️  ${e.owner}/${e.name} 加载失败：${e.error.split("\n")[0]}`);
      else console.log(`[ext] ${e.owner}/${e.name}：${e.tools.map((t) => t.name).join("、") || "（没有工具）"}`);
    }
    this.onMcpServers?.(next.flatMap((e) => e.mcpServers.map((m) => ({ ...m, source: `扩展 ${e.name}` }))));
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
