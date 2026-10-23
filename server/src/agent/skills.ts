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

export interface Skill { name: string; description: string; dir: string; scope: "global" | "agent" }

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
  constructor(private globalDir: string) {}

  private scan(dir: string, scope: Skill["scope"]): Skill[] {
    if (!fs.existsSync(dir)) return [];
    const out: Skill[] = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || !NAME_RE.test(d.name)) continue;
      const f = path.join(dir, d.name, "SKILL.md");
      if (!fs.existsSync(f)) continue;
      const { meta } = parseFrontMatter(fs.readFileSync(f, "utf8"));
      const name = NAME_RE.test(meta.name ?? "") ? meta.name : d.name;
      out.push({ name, description: (meta.description ?? "").slice(0, 300), dir: path.join(dir, d.name), scope });
    }
    return out;
  }

  /** 这个 agent 能用的技能（白名单过滤；本 agent 的同名技能覆盖全局） */
  list(agent: AgentInfo): Skill[] {
    const map = new Map<string, Skill>();
    for (const s of this.scan(this.globalDir, "global")) map.set(s.name, s);
    for (const s of this.scan(path.join(agent.workspace, "skills"), "agent")) map.set(s.name, s);
    const allow = agent.skills.includes("*") ? null : new Set(agent.skills);
    return [...map.values()].filter((s) => !allow || allow.has(s.name)).sort((a, b) => a.name.localeCompare(b.name));
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
