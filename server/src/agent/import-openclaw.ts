// 从 OpenClaw 导入（§8）：人设/记忆 markdown 原样拷贝，定时任务转换成本系统的任务定义。
// 导入的任务默认暂停，作者在管理界面逐条确认再启用。
//
// OpenClaw 的任务存储（~/.openclaw/cron/jobs.json）各版本字段名有出入，这里宽松解析：
//   schedule: {kind:"cron", expr, tz} | {kind:"every", everyMs} | {kind:"at", atMs | at(ISO)}
//   payload:  {kind:"agentTurn", message} | {kind:"systemEvent", text}
//   sessionTarget: "main" | "isolated"；agentId
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { AgentRegistry } from "./registry.ts";
import { SOUL_FILES } from "./registry.ts";
import type { Scheduler, Schedule } from "./scheduler.ts";

export interface ImportReport {
  dir: string;
  /** OpenClaw 里找到的 agent：from = 它的 workspace（null = 没找到目录），into = 导进了 Kagura 的哪个 agent */
  agents: { id: string; name: string; from: string | null; into: string; created: boolean }[];
  files: { agent: string; copied: string[]; from: string }[];
  jobs: { imported: { id: string; name: string; agent: string }[]; skipped: { name: string; reason: string }[] };
  /** 一个 workspace 都没找到时，告诉用户查过哪些地方 */
  searched: string[];
  /** 拷过来的技能：to = 全局 / agent id */
  skills?: { name: string; to: string; skipped?: string }[];
  /** 定时任务从哪里读到的 / 查过哪些地方 */
  jobSources?: string[];
  jobsSearched?: string[];
}

/** OpenClaw 的配置是 JSON5：去掉注释和尾逗号再解析，失败就当没有 */
export function parseJson5ish(text: string): any {
  try { return JSON.parse(text); } catch { /* 往下 */ }
  const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? "");
  const noTrailing = noComments.replace(/,(\s*[}\]])/g, "$1");
  // 不带引号的键：{ id: "main" } → { "id": "main" }
  const quotedKeys = noTrailing.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  try { return JSON.parse(quotedKeys); } catch { return null; }
}

/**
 * 把 openclaw.json 里写的 workspace 路径换成本机能访问的路径：
 * 「~/…」相对 OpenClaw 目录的上一级（家目录）；Windows 上读 \\wsl.localhost\发行版\… 时，
 * 「/home/…」这类 Linux 绝对路径要接到同一个发行版前缀后面。
 */
export function resolveOcPath(p: string, ocDir: string): string {
  const home = path.dirname(ocDir);
  if (p === "~" || p.startsWith("~/")) return path.join(home, ...p.slice(2).split("/").filter(Boolean));
  const unc = /^(\\\\[^\\]+\\[^\\]+)/.exec(ocDir);
  if (p.startsWith("/") && unc) return unc[1] + p.replace(/\//g, "\\");
  return path.isAbsolute(p) ? p : path.join(ocDir, p);
}

interface OcAgent { id: string; name: string; isDefault: boolean; workspace: string | null }

/** 找出 OpenClaw 里的全部 agent：openclaw.json 的 agents.list + 目录里的 workspace-<id> / agents/<id> */
export function discoverOcAgents(dir: string, searched: string[] = []): OcAgent[] {
  const out = new Map<string, OcAgent>();
  let defaults: any = {};
  for (const f of ["openclaw.json", "clawdbot.json", "config.json"]) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) continue;
    const conf = parseJson5ish(fs.readFileSync(file, "utf8"));
    defaults = conf?.agents?.defaults ?? {};
    for (const a of Array.isArray(conf?.agents?.list) ? conf.agents.list : []) {
      if (!a?.id) continue;
      out.set(String(a.id), { id: String(a.id), name: String(a.name ?? a.identity?.name ?? a.id), isDefault: !!a.default, workspace: a.workspace ? resolveOcPath(String(a.workspace), dir) : null });
    }
    break;
  }
  if (!out.size) out.set("main", { id: "main", name: "main", isDefault: true, workspace: null });
  if (![...out.values()].some((a) => a.isDefault)) [...out.values()][0].isDefault = true;
  // 目录里还有没在配置里登记的 agent
  try {
    for (const d of fs.readdirSync(dir)) {
      const m = /^workspace-([A-Za-z0-9_-]+)$/.exec(d);
      if (m && !out.has(m[1])) out.set(m[1], { id: m[1], name: m[1], isDefault: false, workspace: path.join(dir, d) });
    }
  } catch { /* 目录读不了 */ }
  for (const a of out.values()) {
    if (a.workspace && fs.existsSync(a.workspace)) continue;
    const cands = [
      ...(a.workspace ? [a.workspace] : []),
      ...(a.isDefault && defaults.workspace ? [resolveOcPath(String(defaults.workspace), dir)] : []),
      ...(a.isDefault || a.id === "main" ? [path.join(dir, "workspace")] : []),
      path.join(dir, `workspace-${a.id}`), path.join(dir, "agents", a.id, "workspace"),
    ];
    searched.push(...cands);
    a.workspace = cands.find((p) => fs.existsSync(p)) ?? null;
  }
  return [...out.values()];
}

export interface OcJobs { jobs: any[]; sources: string[]; searched: string[] }

/**
 * 读 OpenClaw 的定时任务。不同版本存的地方不一样，几处都读、按 id 去重：
 *   - 新版：状态库 <OpenClaw 目录>/state/openclaw.sqlite 的 cron_jobs 表（每行 job_json 是任务定义）
 *   - 旧版：cron/jobs.json（或 openclaw.json 里 cron.store 指定的文件）{ version, jobs: [...] }
 *   - openclaw.json 里直接写的 cron.jobs
 */
export function readOcJobs(dir: string): OcJobs {
  const out: OcJobs = { jobs: [], sources: [], searched: [] };
  const seen = new Set<string>();
  const add = (list: any[], source: string) => {
    let n = 0;
    for (const j of list) {
      if (!j || typeof j !== "object") continue;
      const key = String(j.id ?? j.jobId ?? j.name ?? JSON.stringify(j.schedule));
      if (seen.has(key)) continue;
      seen.add(key); out.jobs.push(j); n++;
    }
    if (n) out.sources.push(`${source}（${n} 条）`);
  };
  let conf: any = null;
  for (const f of ["openclaw.json", "clawdbot.json"]) {
    const file = path.join(dir, f);
    if (fs.existsSync(file)) { conf = parseJson5ish(fs.readFileSync(file, "utf8")); break; }
  }

  // 1. 新版：SQLite 状态库
  const db = path.join(dir, "state", "openclaw.sqlite");
  out.searched.push(db);
  if (fs.existsSync(db)) add(readJobsFromSqlite(db), db);

  // 2. 旧版：jobs.json
  const files = [
    ...(typeof conf?.cron?.store === "string" ? [resolveOcPath(conf.cron.store, dir)] : []),
    path.join(dir, "cron", "jobs.json"), path.join(dir, "state", "cron", "jobs.json"),
    path.join(dir, "cron.json"), path.join(dir, "automations", "jobs.json"),
  ];
  for (const f of files) {
    out.searched.push(f);
    try {
      const raw = parseJson5ish(fs.readFileSync(f, "utf8"));
      const list = Array.isArray(raw) ? raw : raw?.jobs ?? raw?.items ?? [];
      if (Array.isArray(list)) add(list, f);
    } catch { /* 没有这个文件 */ }
  }

  // 3. 配置文件里直接写的任务
  if (Array.isArray(conf?.cron?.jobs)) add(conf.cron.jobs, "openclaw.json 的 cron.jobs");
  return out;
}

/**
 * 只读地读 cron_jobs 表。先把库（连同 -wal）拷到临时目录再打开：
 * OpenClaw 可能正开着它（WAL 模式），而且经 \\wsl.localhost 访问时 SQLite 的文件锁不可靠。
 */
function readJobsFromSqlite(db: string): any[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-import-"));
  try {
    const copy = path.join(tmp, "openclaw.sqlite");
    fs.copyFileSync(db, copy);
    for (const ext of ["-wal", "-shm"]) if (fs.existsSync(db + ext)) fs.copyFileSync(db + ext, copy + ext);
    const conn = new DatabaseSync(copy);
    try {
      const has = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_jobs'").get();
      if (!has) return [];
      const rows = conn.prepare("SELECT * FROM cron_jobs ORDER BY sort_order").all() as any[];
      return rows.map((r) => {
        let def: any = {};
        try { def = JSON.parse(String(r.job_json ?? "{}")); } catch { /* 坏行 */ }
        return { ...def, id: def.id ?? r.job_id, name: def.name ?? r.name, agentId: def.agentId ?? r.agent_id ?? undefined, enabled: r.enabled === undefined ? def.enabled : !!r.enabled };
      });
    } finally { conn.close(); }
  } catch (e: any) {
    console.log(`[import] ⚠️  读 ${db} 失败: ${e.message}`);
    return [];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function convertSchedule(s: any): Schedule {
  if (!s) throw new Error("没有 schedule");
  const kind = s.kind ?? s.type;
  if (kind === "cron") return { kind: "cron", expr: String(s.expr ?? s.cron ?? s.expression), ...(s.tz ? { tz: s.tz } : {}) };
  if (kind === "every" || kind === "interval") {
    const ms = Number(s.everyMs ?? s.intervalMs ?? (s.everySeconds ?? s.seconds) * 1000);
    if (!Number.isFinite(ms) || ms <= 0) throw new Error("every 缺少间隔");
    return { kind: "every", every_secs: Math.round(ms / 1000), ...(s.anchorMs ? { anchor: s.anchorMs / 1000 } : {}) };
  }
  if (kind === "at" || kind === "once") {
    const ms = typeof s.atMs === "number" ? s.atMs : Date.parse(s.at ?? s.time);
    if (!Number.isFinite(ms)) throw new Error("at 缺少时间");
    return { kind: "at", at: ms / 1000 };
  }
  throw new Error(`不认识的 schedule: ${JSON.stringify(s)}`);
}

/** 拷技能文件夹（带 SKILL.md 的才算），跳过 .git / node_modules；已有同名的不覆盖（除非 overwrite） */
function copySkills(from: string, to: string, label: string, overwrite: boolean, out: NonNullable<ImportReport["skills"]>) {
  let names: string[] = [];
  try { names = fs.readdirSync(from); } catch { return; }
  for (const n of names) {
    const src = path.join(from, n);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(n) || !fs.existsSync(path.join(src, "SKILL.md"))) continue;
    const dst = path.join(to, n);
    if (fs.existsSync(dst) && !overwrite) { out.push({ name: n, to: label, skipped: "已存在" }); continue; }
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: true, filter: (s) => !/[\\/](\.git|node_modules|__pycache__|\.venv)([\\/]|$)/.test(s.slice(src.length)) });
    out.push({ name: n, to: label });
  }
}

export function importOpenClaw(dir: string, agents: AgentRegistry, sched: Scheduler | null, opts: { overwrite?: boolean; skillsDir?: string } = {}): ImportReport {
  if (!fs.existsSync(dir)) throw new Error(`找不到 OpenClaw 目录 ${dir}`);
  const report: ImportReport = { dir, agents: [], files: [], jobs: { imported: [], skipped: [] }, searched: [] };
  const oc = discoverOcAgents(dir, report.searched);
  const ocIds = new Set(oc.map((a) => a.id));
  const idMap = new Map<string, string>();       // OpenClaw agent id → Kagura agent id
  const created: string[] = [];
  for (const a of oc) {
    let into = agents.get(a.id)?.id;
    // OpenClaw 的默认 agent 名字跟 Kagura 的默认 agent 对不上（比如 kagura vs main）：导进 Kagura 的默认 agent
    const def = agents.default();
    if (!into && a.isDefault && !ocIds.has(def.id)) into = def.id;
    let isNew = false;
    if (!into) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(a.id)) { report.agents.push({ id: a.id, name: a.name, from: a.workspace, into: "", created: false }); continue; }
      agents.create(a.id, { name: a.name });
      into = a.id; isNew = true; created.push(a.id);
    }
    idMap.set(a.id, into);
    report.agents.push({ id: a.id, name: a.name, from: a.workspace, into, created: isNew });
  }
  // 新建的 agent 和其它 agent 互相可以通信（OpenClaw 里它们本来就能互相找）
  for (const id of created) {
    for (const other of agents.list()) {
      if (other.id === id) continue;
      if (!other.a2a.allow.includes(id) && !other.a2a.allow.includes("*")) agents.update(other.id, { a2a: { ...other.a2a, allow: [...other.a2a.allow, id] } });
      const me = agents.get(id)!;
      if (!me.a2a.allow.includes(other.id)) agents.update(id, { a2a: { ...me.a2a, allow: [...me.a2a.allow, other.id] } });
    }
  }
  for (const a of oc) {
    const into = idMap.get(a.id);
    if (!into || !a.workspace) continue;
    const target = agents.get(into)!;
    const from = a.workspace;
    const copied: string[] = [];
    for (const f of SOUL_FILES) {
      const src = path.join(from, f);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(target.workspace, f));
      copied.push(f);
    }
    const mem = path.join(from, "memory");
    if (fs.existsSync(mem)) {
      fs.mkdirSync(path.join(target.workspace, "memory"), { recursive: true });
      for (const f of fs.readdirSync(mem)) {
        if (!f.endsWith(".md")) continue;
        const dst = path.join(target.workspace, "memory", f);
        if (fs.existsSync(dst) && !opts.overwrite) continue;
        fs.copyFileSync(path.join(mem, f), dst);
        copied.push(`memory/${f}`);
      }
    }
    report.files.push({ agent: into, copied, from });
  }
  // 技能：OpenClaw 的 <目录>/skills → 全局；各 agent workspace/skills → 那个 agent 自己的
  if (opts.skillsDir) {
    const sk: NonNullable<ImportReport["skills"]> = [];
    copySkills(path.join(dir, "skills"), opts.skillsDir, "全局", !!opts.overwrite, sk);
    for (const a of oc) {
      const into = idMap.get(a.id);
      if (into && a.workspace) copySkills(path.join(a.workspace, "skills"), path.join(agents.get(into)!.workspace, "skills"), into, !!opts.overwrite, sk);
    }
    report.skills = sk;
  }
  if (sched) {
    const oj = readOcJobs(dir);
    report.jobSources = oj.sources;
    report.jobsSearched = oj.searched;
    for (const j of oj.jobs) {
      const name = String(j.name ?? j.id ?? "未命名");
      try {
        const agent = idMap.get(String(j.agentId ?? j.agent ?? "")) ?? agents.default().id;
        const p = j.payload ?? {};
        const kind = p.kind === "systemEvent" ? "systemEvent" : "agentTurn";
        const message = String(p.message ?? p.text ?? j.message ?? "").trim();
        if (!message) throw new Error("没有提示词");
        const id = `oc-${String(j.id ?? name).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || Math.random().toString(36).slice(2, 8)}`;
        if (sched.get(id)) { report.jobs.skipped.push({ name, reason: "已导入过" }); continue; }
        sched.add({
          id, agent, name, enabled: false, schedule: convertSchedule(j.schedule), kind,
          session: j.sessionTarget === "main" || kind === "systemEvent" ? "main" : "isolated",
          // OpenClaw 的任务多半在提示词里让 agent 自己用 cores3-speak 播报；本系统没有 speak，
          // 投到网页聊天（文字留档），同时由出口按语音推送策略在设备上播
          message, delivery: "webchat", source: "openclaw",
        });
        report.jobs.imported.push({ id, name, agent });
      } catch (e: any) {
        report.jobs.skipped.push({ name, reason: e.message });
      }
    }
  }
  return report;
}

/**
 * 找 OpenClaw 目录：配置里写的 → 本机 ~/.openclaw → （Windows）各个 WSL 发行版里各用户家目录下的 .openclaw。
 * 旧方案 OpenClaw 都装在 WSL 里，Windows 版不写路径时以前只找 C:\Users\你\.openclaw，结果什么都没导、也不报错。
 */
export function findOpenClawDirs(configured: string, home: string, wslDistros: () => string[] = listWslDistros): string[] {
  const out: string[] = [];
  const add = (p: string) => { if (p && !out.includes(p) && fs.existsSync(p)) out.push(p); };
  add(configured);
  add(path.join(home, ".openclaw"));
  if (process.platform === "win32") {
    for (const d of wslDistros()) {
      for (const root of [`\\\\wsl.localhost\\${d}`, `\\\\wsl$\\${d}`]) {
        let users: string[] = [];
        try { users = fs.readdirSync(`${root}\\home`); } catch { continue; }
        for (const u of users) add(`${root}\\home\\${u}\\.openclaw`);
        add(`${root}\\root\\.openclaw`);
        break;
      }
    }
  }
  return out;
}

/** wsl.exe -l -q 的输出是 UTF-16LE，还可能带 BOM 和空行 */
export function parseWslList(buf: Buffer): string[] {
  const utf16 = buf.length > 1 && (buf[1] === 0 || (buf[0] === 0xff && buf[1] === 0xfe));
  const text = utf16 ? buf.toString("utf16le") : buf.toString("utf8");
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).map((s) => s.replace(/\0/g, "").trim()).filter(Boolean);
}

function listWslDistros(): string[] {
  try { return parseWslList(execFileSync("wsl.exe", ["-l", "-q"], { timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return []; }
}

/** 给命令行 / 管理界面用的人话报告 */
export function describeImport(rep: ImportReport): string[] {
  const lines = [`OpenClaw 目录：${rep.dir}`];
  for (const a of rep.agents) {
    if (!a.into) { lines.push(`  ✗ agent ${a.id}：id 只能用字母/数字/_-，跳过`); continue; }
    const tag = a.created ? `新建了 agent ${a.into}` : a.into === a.id ? `导入到 ${a.into}` : `导入到默认 agent ${a.into}`;
    lines.push(a.from ? `  · ${a.id}（${a.name}）→ ${tag}` : `  ✗ ${a.id}（${a.name}）：找不到它的 workspace 目录${a.created ? `（已${tag}，人设是模板）` : ""}`);
    const f = rep.files.find((x) => x.agent === a.into && x.from === a.from);
    if (f) lines.push(`      ${f.copied.length ? f.copied.join("、") : "（目录里没有人设 / 记忆文件）"} ← ${f.from}`);
  }
  if (!rep.files.length && rep.searched.length) lines.push("  一个 workspace 都没找到，查过：", ...[...new Set(rep.searched)].map((p) => `      ${p}`));
  if (rep.skills?.length) {
    const ok = rep.skills.filter((s) => !s.skipped), skip = rep.skills.filter((s) => s.skipped);
    if (ok.length) lines.push(`  技能：${ok.map((s) => `${s.name}（${s.to}）`).join("、")}`);
    if (skip.length) lines.push(`  已有同名技能没覆盖：${skip.map((s) => s.name).join("、")}（要覆盖加 --force）`);
  } else if (rep.skills) lines.push("  没找到 OpenClaw 自己装的技能（skills/ 目录）");
  if (rep.jobSources?.length) lines.push(`  定时任务来自：${rep.jobSources.join("；")}`);
  else if (rep.jobsSearched) lines.push("  没找到定时任务，查过：", ...rep.jobsSearched.map((p) => `      ${p}`));
  for (const j of rep.jobs.imported) lines.push(`  ✓ 任务 ${j.name}（${j.agent}，已暂停，到管理界面确认后启用）`);
  for (const j of rep.jobs.skipped) lines.push(`  ✗ 任务 ${j.name}：${j.reason}`);
  return lines;
}
