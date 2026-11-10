// 文件工具（LRN 2026-11-10，症状「她改文件全靠 exec 拼 cat / sed / grep，容易改错也难自查；记忆写错地方要自己 grep 才发现」）：
//   read_file    带行号读（offset / limit 分段）
//   edit_file    精确替换一段（必须唯一匹配，或 replace_all），返回改完那几行，顺手就能确认
//   write_file   新建 / 整个重写
//   search_files 按正则搜内容（跳过 node_modules / .git / 二进制 / 大文件）
//   list_files   按通配找文件（新改的在前）
// 规矩：改已有文件之前必须在这个会话里 read_file 读过，且读完之后文件没被别人改过——防止凭印象改、改到别人刚改过的版本上。
// 权限同 exec（本质上一样能动这台电脑上的文件）：只给可信会话，exec 关了这些也关；陌生人那边永远没有（toolpolicy 的 LOCKED_NAMES）。
// 全用异步 fs：服务端同时在给设备流式播音频，别用同步读写卡住事件循环。
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunScope } from "../scope.ts";
import type { AgentInfo } from "../registry.ts";
import type { ToolsConfig } from "../../config.ts";
import { ok, fail } from "./device.ts";

export const FILE_TOOLS = ["read_file", "edit_file", "write_file", "search_files", "list_files"];
/** read_file 默认 / 最多读多少行 */
export const READ_LINES = 400;
const READ_CHARS = 40_000;
const LINE_CHARS = 2000;
/** 能读 / 搜的单个文件上限 */
const MAX_FILE = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".cache"]);
const MAX_WALK = 20_000;

/** 这个会话读过哪些文件（读的时候的修改时间 + 大小）：改之前查一下读过没有、读完后有没有被改过 */
const seen = new Map<string, Map<string, string>>();
const stamp = (st: fs.Stats) => `${st.mtimeMs}:${st.size}`;
function remember(session: string, file: string, st: fs.Stats) {
  let m = seen.get(session);
  if (!m) { seen.set(session, (m = new Map())); if (seen.size > 500) seen.delete(seen.keys().next().value!); }
  m.set(file, stamp(st));
}
/** 测试用 */
export function forgetReads() { seen.clear(); }

export function resolvePath(p: string, workspace: string): string {
  let s = String(p ?? "").trim();
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(workspace, s);
}

/** 通配 → 正则：** 跨目录、* 和 ? 不跨，{a,b} 任选其一。没有 / 的只比文件名 */
export function globRe(glob: string): RegExp {
  let re = "";
  const g = glob.replace(/\\/g, "/");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += g[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += g[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { const j = g.indexOf("}", i); if (j < 0) { re += "\\{"; continue; } re += `(?:${g.slice(i + 1, j).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`; i = j; }
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}
const globMatch = (re: RegExp, rel: string, glob: string) => re.test(glob.includes("/") ? rel : path.posix.basename(rel));

/** 遍历目录（跳过常见的依赖 / 构建目录），最多 MAX_WALK 个文件 */
async function walk(root: string, onFile: (abs: string, rel: string) => Promise<boolean | void>): Promise<boolean> {
  let n = 0;
  const go = async (dir: string): Promise<boolean> => {
    let ents: fs.Dirent[];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; if (await go(abs)) return true; }
      else if (e.isFile()) {
        if (++n > MAX_WALK) return true;
        if (await onFile(abs, path.relative(root, abs).split(path.sep).join("/"))) return true;
      }
    }
    return false;
  };
  return go(root);
}

const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);
const numbered = (lines: string[], from: number) => lines.map((l, i) => `${String(from + i).padStart(5)}→${l.length > LINE_CHARS ? l.slice(0, LINE_CHARS) + "…（这一行太长，截断了）" : l}`).join("\n");

export function fileTools(cfg: ToolsConfig) {
  return (scope: RunScope, agent: AgentInfo): AgentTool<any>[] => {
    if (!cfg.exec.enabled || !scope.trusted) return [];
    const ws = agent.workspace;
    const where = (p: string) => resolvePath(p, ws);
    const show = (abs: string) => { const r = path.relative(ws, abs); return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.split(path.sep).join("/") : abs; };
    /** 改已有文件前的检查：这个会话读过、读完后没变 */
    const mustHaveRead = (abs: string, st: fs.Stats): string | null => {
      const s = seen.get(scope.sessionKey)?.get(abs);
      if (!s) return `改之前先用 read_file 读一遍 ${show(abs)}（看清楚现在的内容再改）`;
      if (s !== stamp(st)) return `${show(abs)} 在你读过之后被改过了，先用 read_file 重新读一遍再改`;
      return null;
    };
    return [
      {
        name: "read_file", label: "读文件",
        description: `读一个文本文件，每行前面带行号（行号→内容，行号不是文件内容）。默认从头读 ${READ_LINES} 行；长文件用 offset（从第几行开始）、limit（读几行）分段读。`
          + `相对路径按你的工作目录（${ws}）算。看文件、改文件之前都用它，别用 exec 去 cat。`,
        parameters: Type.Object({
          path: Type.String({ description: "文件路径" }),
          offset: Type.Optional(Type.Number({ description: "从第几行开始（从 1 数）" })),
          limit: Type.Optional(Type.Number({ description: `读几行，最多 ${READ_LINES * 5}` })),
        }),
        async execute(_id, p: any) {
          const abs = where(p.path);
          let st: fs.Stats;
          try { st = await fsp.stat(abs); } catch { return fail(`没有这个文件：${show(abs)}`); }
          if (st.isDirectory()) return fail(`${show(abs)} 是目录，用 list_files 看里面有什么`);
          if (st.size > MAX_FILE) return fail(`文件太大（${(st.size / 1048576).toFixed(1)}MB），用 search_files 找要看的那段，或者 exec 处理`);
          const buf = await fsp.readFile(abs);
          if (isBinary(buf)) return fail(`${show(abs)} 是二进制文件，不能按文本读`);
          remember(scope.sessionKey, abs, st);
          const lines = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
          if (lines.length > 1 && lines.at(-1) === "") lines.pop();
          if (!lines.length) return ok(`（${show(abs)} 是空文件）`);
          const from = Math.max(1, Math.floor(Number(p.offset) || 1));
          const n = Math.min(READ_LINES * 5, Math.max(1, Math.floor(Number(p.limit) || READ_LINES)));
          if (from > lines.length) return fail(`${show(abs)} 只有 ${lines.length} 行`);
          let part = lines.slice(from - 1, from - 1 + n);
          let text = numbered(part, from);
          while (text.length > READ_CHARS && part.length > 1) { part = part.slice(0, Math.floor(part.length / 2)); text = numbered(part, from); }
          const end = from + part.length - 1;
          const more = end < lines.length ? `\n（共 ${lines.length} 行，这次读到第 ${end} 行；接着读用 offset=${end + 1}）` : "";
          return ok(text + more, { path: abs, lines: lines.length });
        },
      },
      {
        name: "edit_file", label: "改文件",
        description: "精确替换文件里的一段文字：old 必须和文件里的原文一字不差（包括缩进和空格，别带 read_file 的行号），而且只出现一次——不唯一就多带几行上下文，或者 replace_all=true 全部替换。"
          + "改之前必须先 read_file 读过这个文件。返回改完那几行，看一眼对不对。",
        parameters: Type.Object({
          path: Type.String(),
          old: Type.String({ description: "要被替换的原文" }),
          new: Type.String({ description: "换成什么（空字符串 = 删掉）" }),
          replace_all: Type.Optional(Type.Boolean({ description: "把所有出现的都换掉" })),
        }),
        async execute(_id, p: any) {
          const abs = where(p.path);
          let st: fs.Stats;
          try { st = await fsp.stat(abs); } catch { return fail(`没有这个文件：${show(abs)}（新建用 write_file）`); }
          const not = mustHaveRead(abs, st);
          if (not) return fail(not);
          let oldS = String(p.old ?? ""), newS = String(p.new ?? "");
          if (!oldS) return fail("old 不能是空的（要在文件末尾加内容，就把最后几行当 old、带上新内容当 new）");
          if (oldS === newS) return fail("old 和 new 一样，什么都没改");
          let text = await fsp.readFile(abs, "utf8");
          // 文件是 Windows 换行（\r\n）、她写的是 \n：按文件的换行来
          if (!text.includes(oldS) && text.includes("\r\n") && oldS.includes("\n")) { oldS = oldS.replace(/\r?\n/g, "\r\n"); newS = newS.replace(/\r?\n/g, "\r\n"); }
          const count = text.split(oldS).length - 1;
          if (!count) {
            const hint = /^\s*\d+→/m.test(oldS) ? "（old 里带了 read_file 的行号，去掉「数字→」那部分）" : "（再 read_file 看一眼原文，注意空格、缩进、标点）";
            return fail(`在 ${show(abs)} 里没找到 old 这段原文${hint}`);
          }
          if (count > 1 && !p.replace_all) return fail(`old 在 ${show(abs)} 里出现了 ${count} 次，多带几行上下文让它唯一，或者用 replace_all=true`);
          const at = text.indexOf(oldS);
          text = p.replace_all ? text.split(oldS).join(newS) : text.slice(0, at) + newS + text.slice(at + oldS.length);
          await fsp.writeFile(abs, text);
          remember(scope.sessionKey, abs, await fsp.stat(abs));
          // 改完那几行（前后各 3 行）给她看：顺手确认，不用再读一遍
          const lines = text.replace(/\r\n/g, "\n").split("\n");
          const first = text.slice(0, at).replace(/\r\n/g, "\n").split("\n").length;
          const span = newS.replace(/\r\n/g, "\n").split("\n").length;
          const from = Math.max(1, first - 3);
          console.log(`[files] ${agent.id} ✏️  ${show(abs)}（${p.replace_all ? `替换 ${count} 处` : `第 ${first} 行`}）`);
          return ok(`已改 ${show(abs)}${p.replace_all && count > 1 ? `（替换了 ${count} 处，下面是第一处）` : ""}：\n${numbered(lines.slice(from - 1, first - 1 + span + 3), from)}`, { path: abs, count });
        },
      },
      {
        name: "write_file", label: "写文件",
        description: "新建文件，或者把整个文件换成新内容（会自动建好上级目录）。改已有文件的一小部分用 edit_file；整个重写已有文件也要先 read_file 读过。",
        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        async execute(_id, p: any) {
          const abs = where(p.path);
          const st = await fsp.stat(abs).catch(() => null);
          if (st?.isDirectory()) return fail(`${show(abs)} 是目录`);
          if (st) { const not = mustHaveRead(abs, st); if (not) return fail(not); }
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          const content = String(p.content ?? "");
          await fsp.writeFile(abs, content);
          remember(scope.sessionKey, abs, await fsp.stat(abs));
          console.log(`[files] ${agent.id} 📝 ${st ? "重写" : "新建"} ${show(abs)}`);
          return ok(`已${st ? "重写" : "新建"} ${show(abs)}（${content.split("\n").length} 行，${Buffer.byteLength(content)} 字节）`, { path: abs });
        },
      },
      {
        name: "search_files", label: "搜文件内容",
        description: "在目录里按正则搜文件内容，返回「路径:行号: 那一行」。默认搜你的工作目录；glob 只搜某类文件（如 *.py、src/**/*.ts）；会跳过 node_modules、.git、二进制和大文件。找到位置再用 read_file 看前后文。",
        parameters: Type.Object({
          pattern: Type.String({ description: "正则（普通文字也行）" }),
          path: Type.Optional(Type.String({ description: "目录或文件，默认工作目录" })),
          glob: Type.Optional(Type.String({ description: "只搜匹配的文件，如 *.md" })),
          ignore_case: Type.Optional(Type.Boolean()),
          max: Type.Optional(Type.Number({ description: "最多返回几条，默认 100" })),
        }),
        async execute(_id, p: any) {
          let re: RegExp;
          try { re = new RegExp(String(p.pattern ?? ""), p.ignore_case ? "i" : ""); } catch (e: any) { return fail(`正则写错了：${e.message}`); }
          if (!p.pattern) return fail("pattern 不能是空的");
          const root = where(p.path ?? ".");
          const st = await fsp.stat(root).catch(() => null);
          if (!st) return fail(`没有这个目录：${show(root)}`);
          const max = Math.min(500, Math.max(1, Number(p.max) || 100));
          const g = p.glob ? String(p.glob) : "", gre = g ? globRe(g) : null;
          const hits: string[] = [];
          let files = 0;
          const scan = async (abs: string, rel: string) => {
            if (gre && !globMatch(gre, rel, g)) return;
            const s = await fsp.stat(abs).catch(() => null);
            if (!s || s.size > MAX_FILE) return;
            const buf = await fsp.readFile(abs).catch(() => null);
            if (!buf || isBinary(buf)) return;
            files++;
            const lines = buf.toString("utf8").split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                hits.push(`${st.isFile() ? show(abs) : rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
                if (hits.length >= max) return true;
              }
            }
          };
          const capped = st.isFile() ? !!(await scan(root, path.basename(root))) : await walk(root, scan);
          if (!hits.length) return ok(`在 ${show(root)} 下没搜到（看了 ${files} 个文件）`);
          return ok(hits.join("\n") + (capped ? `\n（到上限了，只列了前 ${hits.length} 条；缩小范围再搜）` : ""), { count: hits.length });
        },
      },
      {
        name: "list_files", label: "找文件",
        description: "列出目录里的文件，或按通配找文件（**/*.py 找所有 Python 文件，*config* 找名字里带 config 的），新改过的排在前面。默认在你的工作目录里找。",
        parameters: Type.Object({
          pattern: Type.Optional(Type.String({ description: "通配，默认列出全部" })),
          path: Type.Optional(Type.String({ description: "目录，默认工作目录" })),
        }),
        async execute(_id, p: any) {
          const root = where(p.path ?? ".");
          const st = await fsp.stat(root).catch(() => null);
          if (!st?.isDirectory()) return fail(`没有这个目录：${show(root)}`);
          const g = String(p.pattern ?? "**/*"), gre = globRe(g);
          const found: { rel: string; mtime: number; size: number }[] = [];
          const capped = await walk(root, async (abs, rel) => {
            if (!globMatch(gre, rel, g)) return;
            const s = await fsp.stat(abs).catch(() => null);
            if (s) found.push({ rel, mtime: s.mtimeMs, size: s.size });
          });
          if (!found.length) return ok(`在 ${show(root)} 下没找到匹配 ${g} 的文件`);
          found.sort((a, b) => b.mtime - a.mtime);
          const kb = (n: number) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}KB`);
          const list = found.slice(0, 200).map((f) => `${f.rel}  ${kb(f.size)}`);
          return ok(`${show(root)} 下：\n${list.join("\n")}${found.length > 200 ? `\n（共 ${found.length} 个，只列了最近改过的 200 个）` : capped ? "\n（目录太大，没看完）" : ""}`, { count: found.length });
        },
      },
    ] as AgentTool<any>[];
  };
}
