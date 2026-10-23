// Skills（§6.8，本期只做加载机制）：SKILL.md 文件夹，格式与 OpenClaw/pi 一致。
//   全局：<数据目录>/skills/<name>/SKILL.md      本 agent：workspace/skills/<name>/SKILL.md（同名覆盖全局）
// front-matter 里的 name/description 进系统提示的技能目录；agent 需要时 skill_read 读全文。
// 技能里的脚本由 agent 用 exec 工具运行（只在可信会话里有 exec），skill_read 会告诉它技能目录在哪。
import fs from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentInfo } from "./registry.ts";
import type { RunScope } from "./scope.ts";
import { resolveInside } from "./paths.ts";
import { ok, fail } from "./tools/device.ts";

export interface Skill { name: string; description: string; dir: string; scope: "global" | "agent"; folder?: string }

/** 管理界面里技能的归属：全局用这个，其它是 agent id（agent id 里不会出现 ~） */
export const GLOBAL_OWNER = "~global";
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);
const MAX_FILE = 2 * 1024 * 1024;

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_READ = 64 * 1024;

/** 极简 front-matter：--- 之间的 key: value 行（值可带引号） */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: text.slice(m[0].length) };
}

export class Skills {
  /** 扩展包带的技能目录（每个目录下是若干 <技能>/SKILL.md）；全局目录里同名的覆盖它们 */
  extraRoots: () => { root: string; pkg: string }[] = () => [];

  constructor(private globalDir: string) {}

  private scan(dir: string, scope: Skill["scope"]): Skill[] {
    if (!fs.existsSync(dir)) return [];
    // 扩展包里的 skills 路径也可能直接指向一个技能目录
    if (fs.existsSync(path.join(dir, "SKILL.md"))) {
      const { meta } = parseFrontMatter(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
      const folder = path.basename(dir);
      return [{ name: NAME_RE.test(meta.name ?? "") ? meta.name : folder, description: (meta.description ?? "").slice(0, 300), dir, scope, folder }];
    }
    const out: Skill[] = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || !NAME_RE.test(d.name)) continue;
      const f = path.join(dir, d.name, "SKILL.md");
      if (!fs.existsSync(f)) continue;
      const { meta } = parseFrontMatter(fs.readFileSync(f, "utf8"));
      const name = NAME_RE.test(meta.name ?? "") ? meta.name : d.name;
      out.push({ name, description: (meta.description ?? "").slice(0, 300), dir: path.join(dir, d.name), scope, folder: d.name });
    }
    return out;
  }

  /** 这个 agent 能用的技能（白名单过滤；本 agent 的同名技能覆盖全局） */
  list(agent: AgentInfo): Skill[] {
    const map = new Map<string, Skill>();
    for (const r of this.extraRoots()) for (const s of this.scan(r.root, "global")) map.set(s.name, s);
    for (const s of this.scan(this.globalDir, "global")) map.set(s.name, s);
    for (const s of this.scan(path.join(agent.workspace, "skills"), "agent")) map.set(s.name, s);
    const allow = agent.skills.includes("*") ? null : new Set(agent.skills);
    return [...map.values()].filter((s) => !allow || allow.has(s.name)).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── 管理（管理界面增删改）────────────────────────────────

  /** 技能放在哪：~global → 全局目录，否则那个 agent 的 workspace/skills */
  root(owner: string, agents: { get(id: string): AgentInfo | undefined }): string {
    if (owner === GLOBAL_OWNER) return this.globalDir;
    const a = agents.get(owner);
    if (!a) throw Object.assign(new Error(`没有 agent ${owner}`), { status: 404 });
    return path.join(a.workspace, "skills");
  }

  /** 全部技能（全局 + 每个 agent 自己的），不做白名单过滤 */
  all(agents: { list(): AgentInfo[] }) {
    const g = this.scan(this.globalDir, "global").map((s) => ({ ...s, owner: GLOBAL_OWNER }));
    const own = agents.list().flatMap((a) => this.scan(path.join(a.workspace, "skills"), "agent").map((s) => ({ ...s, owner: a.id })));
    return [...g, ...own];
  }

  dirOf(root: string, folder: string): string {
    if (!NAME_RE.test(folder)) throw Object.assign(new Error(`技能名只能用字母、数字和 _ . -：${folder}`), { status: 400 });
    const d = path.join(root, folder);
    if (!fs.existsSync(path.join(d, "SKILL.md"))) throw Object.assign(new Error(`没有技能 ${folder}`), { status: 404 });
    return d;
  }

  /** 技能目录里的文件（相对路径 + 大小），跳过 .git / node_modules 之类 */
  files(dir: string): { path: string; size: number; text: boolean }[] {
    const out: { path: string; size: number; text: boolean }[] = [];
    const walk = (d: string, rel: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (out.length >= 500) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), r); continue; }
        if (!e.isFile()) continue;
        const st = fs.statSync(path.join(d, e.name));
        let text = st.size <= MAX_READ;
        if (text) { const b = fs.readFileSync(path.join(d, e.name)); text = !b.subarray(0, 8000).includes(0); }
        out.push({ path: r, size: st.size, text });
      }
    };
    walk(dir, "");
    return out.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
  }

  create(root: string, folder: string, description: string, body: string): string {
    if (!NAME_RE.test(folder)) throw Object.assign(new Error("技能名只能用字母、数字和 _ . -（会当作文件夹名）"), { status: 400 });
    const d = path.join(root, folder);
    if (fs.existsSync(d)) throw Object.assign(new Error(`已经有技能 ${folder}`), { status: 409 });
    fs.mkdirSync(d, { recursive: true });
    const desc = description.replace(/\r?\n/g, " ").trim();
    fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${folder}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body.trim() || `# ${folder}\n\n（写下什么时候用这个技能、具体怎么做；要跑脚本就写清楚命令，agent 会用 exec 执行）`}\n`);
    return d;
  }

  writeFile(dir: string, rel: string, data: Buffer) {
    if (data.length > MAX_FILE) throw Object.assign(new Error(`文件太大（上限 ${MAX_FILE >> 20}MB）`), { status: 400 });
    const f = resolveInside(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
  }

  deleteFile(dir: string, rel: string) {
    if (rel === "SKILL.md") throw Object.assign(new Error("SKILL.md 不能删，要删就删整个技能"), { status: 400 });
    const f = resolveInside(dir, rel);
    if (!fs.existsSync(f)) throw Object.assign(new Error(`没有 ${rel}`), { status: 404 });
    fs.rmSync(f, { recursive: true });
  }

  /** 删技能：挪进 <归属目录>/.trash/，防手滑 */
  remove(root: string, folder: string) {
    const d = this.dirOf(root, folder);
    const trash = path.join(root, ".trash");
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(d, path.join(trash, `${folder}-${Date.now()}`));
  }

  /**
   * 装一个技能包（zip）：包里可以是「技能名/SKILL.md …」一层文件夹，也可以 SKILL.md 直接在根上。
   * 技能名取 SKILL.md 里的 name，没有就用文件夹名 / zip 文件名。返回装好的技能名。
   */
  installZip(root: string, entries: { name: string; data: Buffer }[], fallbackName: string, overwrite = false): string {
    const skillMd = entries.filter((e) => /(^|\/)SKILL\.md$/.test(e.name) && !e.name.includes("__MACOSX"))
      .sort((a, b) => a.name.split("/").length - b.name.split("/").length)[0];
    if (!skillMd) throw Object.assign(new Error("包里没有 SKILL.md"), { status: 400 });
    const prefix = skillMd.name.slice(0, -"SKILL.md".length);
    const { meta } = parseFrontMatter(skillMd.data.toString("utf8"));
    const guess = [meta.name, prefix.replace(/\/$/, "").split("/").pop(), fallbackName.replace(/\.zip$/i, "")]
      .map((x) => (x ?? "").trim()).find((x) => NAME_RE.test(x));
    if (!guess) throw Object.assign(new Error("认不出技能名：在 SKILL.md 的 front-matter 里写 name（字母、数字、_ . -）"), { status: 400 });
    const d = path.join(root, guess);
    if (fs.existsSync(d)) {
      if (!overwrite) throw Object.assign(new Error(`已经有技能 ${guess}（勾上「覆盖」再传）`), { status: 409 });
      this.remove(root, guess);
    }
    fs.mkdirSync(d, { recursive: true });
    for (const e of entries) {
      if (!e.name.startsWith(prefix) || e.name.includes("__MACOSX/")) continue;
      const rel = e.name.slice(prefix.length);
      if (!rel || rel.split("/").some((seg) => SKIP_DIRS.has(seg))) continue;
      const f = resolveInside(d, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, e.data);
    }
    return guess;
  }

  catalog(agent: AgentInfo) { return this.list(agent).map(({ name, description }) => ({ name, description })); }

  tools() {
    return (_scope: RunScope, agent: AgentInfo): AgentTool<any>[] => {
      if (!this.list(agent).length) return [];
      return [{
        name: "skill_read", label: "读取技能",
        description: "读取一个技能的完整说明（SKILL.md），或技能目录里的其他文本文件（file 参数）。说明里要跑的脚本用 exec 工具执行（技能目录会一并告诉你）。",
        parameters: Type.Object({ name: Type.String(), file: Type.Optional(Type.String()) }),
        execute: async (_id, p: any) => {
          const s = this.list(agent).find((x) => x.name === p.name);
          if (!s) return fail(`没有技能 ${p.name}`);
          try {
            const f = resolveInside(s.dir, p.file || "SKILL.md");
            if (!fs.existsSync(f) || !fs.statSync(f).isFile()) {
              const files = fs.readdirSync(s.dir).join(", ");
              return fail(`技能 ${s.name} 里没有 ${p.file}（有：${files}）`);
            }
            const buf = fs.readFileSync(f);
            if (buf.length > MAX_READ) return fail(`文件太大（${buf.length} 字节）`);
            if (buf.includes(0)) return fail("不是文本文件");
            const head = (p.file && p.file !== "SKILL.md") ? "" : `技能目录：${s.dir}（说明里提到的脚本、相对路径都以这里为准，用 exec 运行）\n\n`;
            return ok(head + buf.toString("utf8"));
          } catch (e: any) { return fail(e.message); }
        },
      }];
    };
  }
}
