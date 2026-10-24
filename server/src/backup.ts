// 导出 / 导入：把设置、各 agent 的人设 / 记忆 / 技能 / 会话、全局技能、扩展、扩展包、MCP、渠道、定时任务、设备图片
// 打成一个 .zip，换电脑或分享给别人时一键导回。
//
//   导出：用户勾选要哪些（catalog() 列出可选项和大小）；数据库用 VACUUM INTO 拍一份一致的快照，不用停服务。
//         默认不带密钥（模型 API Key、百度 Key、IM 凭据、MCP 的 env / headers）——分享给别人时别勾「包含密钥」。
//   导入：先 inspect() 看包里有什么，用户勾选后 stage() 解到 <数据目录>/.import-pending/，然后重启；
//         新进程在打开任何数据库之前 applyPending() 把文件换进去（被换掉的先备份到 backups/），避免覆盖正在用的数据库。
//         设置里的端口、OpenClaw 路径这类「跟这台电脑有关」的保留本机的；导入包里空着的密钥也保留本机的。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zip, unzip, type ZipEntry } from "./util/zip.ts";

export const FORMAT = 1;
const MANIFEST = "kagura-backup.json";
const PENDING = ".import-pending";
const SECRET_KEY = /(secret|token|key|password|passwd)$/i;
/** 设置里跟这台电脑有关的项：导入时保留本机的 */
const HOST_KEYS = ["port", "mqtt_port", "stream_port", "disc_port", "admin_port", "openclaw", "data_dir"];
const AGENT_PARTS = ["profile", "memory", "skills", "sessions", "files"] as const;
type AgentPart = (typeof AGENT_PARTS)[number];

export interface CatalogItem { id: string; label: string; group: string; bytes: number; secret?: boolean; default: boolean; note?: string }
export interface Manifest { format: number; app: "kagura"; version: string; createdAt: string; host: string; secrets: boolean; items: { id: string; label: string; files: number; bytes: number }[] }

const exists = (p: string) => fs.existsSync(p);
const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
/** 目录下所有文件（相对路径，/ 分隔），跳过回收站和临时目录 */
function walk(root: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const go = (d: string, rel: string) => {
    let list: fs.Dirent[] = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".trash" || e.name.startsWith(".tmp-") || skip(r)) continue;
      if (e.isDirectory()) go(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  if (isDir(root)) go(root, "");
  return out;
}
const sizeOf = (files: string[]) => files.reduce((n, f) => { try { return n + fs.statSync(f).size; } catch { return n; } }, 0);

function agentIds(dataDir: string): { id: string; name: string }[] {
  const root = path.join(dataDir, "agents");
  return (isDir(root) ? fs.readdirSync(root) : []).filter((id) => exists(path.join(root, id, "agent.json"))).map((id) => {
    let name = id;
    try { name = JSON.parse(fs.readFileSync(path.join(root, id, "agent.json"), "utf8")).name || id; } catch { /* 坏文件就用 id */ }
    return { id, name };
  });
}

/** 一项对应数据目录里哪些文件（相对数据目录）。sqlite 单独处理（拍快照） */
function filesOf(dataDir: string, id: string): { files: string[]; sqlite: string[] } {
  const dir = (sub: string, skip?: (r: string) => boolean) => walk(path.join(dataDir, sub), skip).map((f) => `${sub}/${f}`);
  const file = (f: string) => (exists(path.join(dataDir, f)) ? [f] : []);
  const m = /^agent:([^:]+):(\w+)$/.exec(id);
  if (m) {
    const [, aid, part] = m;
    const base = `agents/${aid}`, ws = path.join(dataDir, base, "workspace");
    const topMd = isDir(ws) ? fs.readdirSync(ws).filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && fs.statSync(path.join(ws, f)).isFile()) : [];
    switch (part as AgentPart) {
      case "profile": return { files: [...file(`${base}/agent.json`), ...topMd.map((f) => `${base}/workspace/${f}`)], sqlite: [] };
      case "memory": return { files: [...file(`${base}/workspace/MEMORY.md`), ...dir(`${base}/workspace/memory`)], sqlite: [] };
      case "skills": return { files: [...dir(`${base}/workspace/skills`), ...dir(`${base}/workspace/extensions`)], sqlite: [] };
      case "sessions": return { files: [], sqlite: file(`${base}/agent.sqlite`) };
      case "files": return {
        files: dir(`${base}/workspace`, (r) => /^(memory|skills|extensions)(\/|$)/.test(r) || (!r.includes("/") && r.endsWith(".md"))),
        sqlite: [],
      };
    }
  }
  switch (id) {
    case "settings": return { files: [...file("config.json"), ...file("roles_state.json"), ...file("minimax_voices.json")], sqlite: [] };
    case "skills": return { files: dir("skills"), sqlite: [] };
    case "extensions": return { files: [...dir("extensions"), ...file("mcp.json")], sqlite: [] };
    case "packages": {
      // npm / git 装的包只记来源（导入后重新装，不搬几百 MB 的 node_modules）；上传装的整个带上；本地路径的带不走
      let recs: any[] = [];
      try { recs = JSON.parse(fs.readFileSync(path.join(dataDir, "packages.json"), "utf8")); } catch { /* 没装过 */ }
      const up = recs.filter((r) => r.kind === "upload").flatMap((r) => dir(`packages/${r.id}`));
      return { files: [...file("packages.json"), ...up], sqlite: [] };
    }
    case "channels": return { files: [...file("channels.json"), ...file("clients.json")], sqlite: [] };
    case "jobs": return { files: [...file("reminders.json"), ...file("photo_schedules.json")], sqlite: file("system.sqlite") };
    case "device": return { files: dir("device_files"), sqlite: [] };
    case "snapshots": return { files: dir("snapshots"), sqlite: [] };
  }
  return { files: [], sqlite: [] };
}

/** 可导出的项（给管理界面勾选） */
export function catalog(dataDir: string): CatalogItem[] {
  const size = (id: string) => { const f = filesOf(dataDir, id); return sizeOf([...f.files, ...f.sqlite].map((x) => path.join(dataDir, x))); };
  const items: CatalogItem[] = [
    { id: "settings", group: "系统", label: "设置（模型服务商、百度语音、端口、工具设置……）", bytes: size("settings"), secret: true, default: true },
  ];
  for (const a of agentIds(dataDir)) {
    const g = `Agent：${a.name}（${a.id}）`;
    items.push(
      { id: `agent:${a.id}:profile`, group: g, label: "人设与定义（agent.json、SOUL.md、IDENTITY.md、USER.md……）", bytes: size(`agent:${a.id}:profile`), default: true },
      { id: `agent:${a.id}:memory`, group: g, label: "记忆（MEMORY.md、每日笔记）", bytes: size(`agent:${a.id}:memory`), default: true },
      { id: `agent:${a.id}:skills`, group: g, label: "专属技能与扩展", bytes: size(`agent:${a.id}:skills`), default: true },
      { id: `agent:${a.id}:sessions`, group: g, label: "会话记录与用量统计", bytes: size(`agent:${a.id}:sessions`), default: true, note: "分享给别人时一般不勾" },
      { id: `agent:${a.id}:files`, group: g, label: "工作目录里的其它文件（上传的文件、她写的脚本……）", bytes: size(`agent:${a.id}:files`), default: false },
    );
  }
  items.push(
    { id: "skills", group: "全局", label: "全局技能", bytes: size("skills"), default: true },
    { id: "extensions", group: "全局", label: "全局扩展与 MCP 服务器配置", bytes: size("extensions"), secret: true, default: true },
    { id: "packages", group: "全局", label: "扩展包（npm / git 装的导入后重新下载）", bytes: size("packages"), default: true },
    { id: "channels", group: "全局", label: "IM 渠道（飞书 / QQ 账号、白名单、绑定）与配对过的手机", bytes: size("channels"), secret: true, default: true },
    { id: "jobs", group: "全局", label: "定时任务、提醒、定时拍照（含运行记录）", bytes: size("jobs"), default: true },
    { id: "device", group: "设备", label: "传给设备的角色图片与代码", bytes: size("device"), default: true },
    { id: "snapshots", group: "设备", label: "设备拍的照片", bytes: size("snapshots"), default: false },
  );
  return items.filter((i) => i.bytes > 0 || i.id.endsWith(":profile") || i.id === "settings");
}

// ── 密钥 ──

/** 把对象里像密钥的字符串清空（${环境变量} 引用保留） */
function stripSecrets(v: any, key = ""): any {
  if (Array.isArray(v)) return v.map((x) => stripSecrets(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripSecrets(x, k)]));
  return typeof v === "string" && v && SECRET_KEY.test(key) && !/^\$\{.+\}$/.test(v) ? "" : v;
}
function stripFile(rel: string, data: Buffer): Buffer {
  try {
    const j = JSON.parse(data.toString("utf8"));
    if (rel === "config.json") return Buffer.from(JSON.stringify(stripSecrets(j), null, 2));
    if (rel === "channels.json") {
      for (const a of j.accounts ?? []) a.credentials = Object.fromEntries(Object.keys(a.credentials ?? {}).map((k) => [k, ""]));
      return Buffer.from(JSON.stringify(j, null, 2));
    }
    if (rel === "mcp.json") {
      for (const s of Object.values<any>(j.mcpServers ?? {})) {
        for (const f of ["env", "headers"]) if (s?.[f]) s[f] = Object.fromEntries(Object.entries(s[f]).map(([k, x]) => [k, /^\$\{.+\}$/.test(String(x)) ? x : ""]));
      }
      return Buffer.from(JSON.stringify(j, null, 2));
    }
  } catch { /* 不是 JSON 就原样 */ }
  return data;
}

/** 数据库快照：VACUUM INTO 得到一致的单文件（WAL 里没合并的也在里面），不用停服务 */
function snapshotDb(file: string): Buffer {
  const tmp = path.join(os.tmpdir(), `kagura-snap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new DatabaseSync(file);
  try { db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { db.close(); }
  try { return fs.readFileSync(tmp); } finally { fs.rmSync(tmp, { force: true }); }
}

export function exportBackup(dataDir: string, ids: string[], opts: { secrets: boolean; version: string }): { buf: Buffer; manifest: Manifest } {
  const known = new Map(catalog(dataDir).map((c) => [c.id, c]));
  const entries: ZipEntry[] = [];
  const items: Manifest["items"] = [];
  for (const id of ids) {
    const c = known.get(id);
    if (!c) continue;
    const { files, sqlite } = filesOf(dataDir, id);
    let bytes = 0;
    for (const f of files) {
      let data: Buffer = fs.readFileSync(path.join(dataDir, f));
      if (!opts.secrets && ["config.json", "channels.json", "mcp.json"].includes(f)) data = stripFile(f, data);
      entries.push({ name: `data/${f}`, data });
      bytes += data.length;
    }
    for (const f of sqlite) {
      const data = snapshotDb(path.join(dataDir, f));
      entries.push({ name: `data/${f}`, data });
      bytes += data.length;
    }
    items.push({ id, label: `${c.group} · ${c.label}`, files: files.length + sqlite.length, bytes });
  }
  const manifest: Manifest = { format: FORMAT, app: "kagura", version: opts.version, createdAt: new Date().toISOString(), host: os.hostname(), secrets: opts.secrets, items };
  entries.unshift({ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  return { buf: zip(entries), manifest };
}

const UNZIP_LIMITS = { maxEntries: 60000, maxTotal: 3 * 1024 * 1024 * 1024 };

/** 看看备份包里有什么（导入前给用户勾选） */
export function inspectBackup(buf: Buffer): Manifest {
  const all = unzip(buf, UNZIP_LIMITS);
  const m = all.find((e) => e.name === MANIFEST);
  if (!m) throw new Error("这不是 Kagura 的备份包（缺 kagura-backup.json）");
  const man = JSON.parse(m.data.toString("utf8")) as Manifest;
  if (man.app !== "kagura" || !man.format) throw new Error("这不是 Kagura 的备份包");
  if (man.format > FORMAT) throw new Error("这个备份包是更新的版本做的，请先升级 Kagura");
  return man;
}

/** 一个文件属于备份里的哪一项（导入时按勾选过滤） */
export function itemOf(rel: string): string | null {
  const m = /^agents\/([^/]+)\/(.+)$/.exec(rel);
  if (m) {
    const [, aid, rest] = m;
    const part = rest === "agent.json" || /^workspace\/[^/]+\.md$/.test(rest) && rest !== "workspace/MEMORY.md" ? "profile"
      : rest === "workspace/MEMORY.md" || rest.startsWith("workspace/memory/") ? "memory"
      : rest.startsWith("workspace/skills/") || rest.startsWith("workspace/extensions/") ? "skills"
      : rest === "agent.sqlite" ? "sessions" : "files";
    return `agent:${aid}:${part}`;
  }
  const top = rel.split("/")[0];
  const map: Record<string, string> = {
    "config.json": "settings", "roles_state.json": "settings", "minimax_voices.json": "settings", skills: "skills", extensions: "extensions", "mcp.json": "extensions",
    "packages.json": "packages", packages: "packages", "channels.json": "channels", "clients.json": "channels", "system.sqlite": "jobs", "reminders.json": "jobs",
    "photo_schedules.json": "jobs", device_files: "device", snapshots: "snapshots",
  };
  return map[top] ?? null;
}

/** 导入第一步：把勾选的项解到 .import-pending/，等重启后换进去 */
export function stageImport(dataDir: string, buf: Buffer, ids: string[]): { items: string[]; files: number } {
  const man = inspectBackup(buf);
  const want = new Set(ids.filter((id) => man.items.some((i) => i.id === id)));
  if (!want.size) throw new Error("没有选要导入的内容");
  // 本机没有的 agent：只勾了记忆 / 会话也得把人设（agent.json）一起带上，不然导进来认不出这个 agent
  for (const id of [...want]) {
    const m = /^agent:([^:]+):/.exec(id);
    if (m && !fs.existsSync(path.join(dataDir, "agents", m[1], "agent.json")) && man.items.some((i) => i.id === `agent:${m[1]}:profile`)) want.add(`agent:${m[1]}:profile`);
  }
  const stage = path.join(dataDir, PENDING);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  let n = 0;
  for (const e of unzip(buf, UNZIP_LIMITS)) {
    if (!e.name.startsWith("data/")) continue;
    const rel = e.name.slice(5);
    const parts = rel.split("/");
    if (!rel || parts.some((p) => p === ".." || p === "" || p.includes(":") || p.includes("\\"))) throw new Error(`备份包里有不安全的路径：${e.name}`);
    const id = itemOf(rel);
    if (!id || !want.has(id)) continue;
    const t = path.join(stage, "data", ...parts);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, e.data);
    n++;
  }
  fs.writeFileSync(path.join(stage, "plan.json"), JSON.stringify({ items: [...want], secrets: man.secrets, from: man.host, at: new Date().toISOString() }, null, 2));
  return { items: [...want], files: n };
}

/** 深合并设置：导入的为主；本机相关的键、导入包里空着的密钥保留本机的 */
function mergeSettings(local: any, incoming: any): any {
  const out = { ...incoming };
  for (const k of HOST_KEYS) if (k in local) out[k] = local[k]; else delete out[k];
  const keep = (inc: any, loc: any, key = ""): any => {
    if (inc && typeof inc === "object" && !Array.isArray(inc)) {
      return Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, keep(v, loc?.[k], k)]));
    }
    if (Array.isArray(inc)) return inc.map((v, i) => keep(v, Array.isArray(loc) ? (loc.find((x: any) => x?.id && x.id === v?.id) ?? loc[i]) : undefined));
    if (inc === "" && SECRET_KEY.test(key) && typeof loc === "string" && loc) return loc;
    return inc;
  };
  return keep(out, local);
}

/** 导入第二步（启动时、打开数据库之前调）：有待导入的就换进去。返回导入了哪些项（没有就是 null） */
export function applyPending(dataDir: string, log: (s: string) => void = console.log): string[] | null {
  const stage = path.join(dataDir, PENDING);
  const planFile = path.join(stage, "plan.json");
  if (!exists(planFile)) return null;
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const src = path.join(stage, "data");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = path.join(dataDir, "backups", `before-import-${stamp}`);
  const moveAway = (rel: string) => {
    const p = path.join(dataDir, rel);
    if (!exists(p)) return;
    const b = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(p, b);
  };
  const put = (rel: string) => {
    const from = path.join(src, rel), to = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  };
  const staged = walk(src);
  for (const id of plan.items as string[]) {
    const mine = staged.filter((f) => itemOf(f) === id);
    const m = /^agent:([^:]+):(\w+)$/.exec(id);
    // 整块替换的目录：先把本机的挪进备份，再放进来
    const dirs = m ? ({ memory: [`agents/${m[1]}/workspace/memory`], skills: [`agents/${m[1]}/workspace/skills`, `agents/${m[1]}/workspace/extensions`] } as Record<string, string[]>)[m[2]] ?? []
      : ({ skills: ["skills"], extensions: ["extensions"], device: ["device_files"] } as Record<string, string[]>)[id] ?? [];
    for (const d of dirs) moveAway(d);
    for (const f of mine) {
      if (f === "config.json") {
        let local: any = {};
        try { local = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8")); } catch { /* 本机还没有设置 */ }
        const merged = mergeSettings(local, JSON.parse(fs.readFileSync(path.join(src, f), "utf8")));
        moveAway(f);
        fs.writeFileSync(path.join(dataDir, f), JSON.stringify(merged, null, 2));
        continue;
      }
      if (f === "channels.json" || f === "mcp.json") {
        let local: any = {};
        try { local = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8")); } catch { /* 本机没有 */ }
        const inc = JSON.parse(fs.readFileSync(path.join(src, f), "utf8"));
        if (f === "channels.json") {
          for (const a of inc.accounts ?? []) {
            const la = (local.accounts ?? []).find((x: any) => x.id === a.id);
            for (const [k, v] of Object.entries(a.credentials ?? {})) if (v === "" && la?.credentials?.[k]) a.credentials[k] = la.credentials[k];
          }
        } else {
          for (const [n, s] of Object.entries<any>(inc.mcpServers ?? {})) {
            const ls = local.mcpServers?.[n];
            for (const fld of ["env", "headers"]) for (const [k, v] of Object.entries(s?.[fld] ?? {})) if (v === "" && ls?.[fld]?.[k]) s[fld][k] = ls[fld][k];
          }
        }
        moveAway(f);
        fs.writeFileSync(path.join(dataDir, f), JSON.stringify(inc, null, 2));
        continue;
      }
      if (f.endsWith(".sqlite")) {
        moveAway(f);
        for (const x of ["-wal", "-shm"]) moveAway(f + x);
        put(f);
        continue;
      }
      if (!dirs.length) moveAway(f);
      put(f);
    }
    // 扩展包：npm / git 装的记下来，启动后重新下载安装
    if (id === "packages") {
      try {
        const recs = JSON.parse(fs.readFileSync(path.join(dataDir, "packages.json"), "utf8"));
        const again = recs.filter((r: any) => r.kind === "npm" || r.kind === "git");
        fs.writeFileSync(path.join(dataDir, "packages-reinstall.json"), JSON.stringify(again.map((r: any) => r.source)));
        fs.writeFileSync(path.join(dataDir, "packages.json"), JSON.stringify(recs.filter((r: any) => r.kind === "upload").map((r: any) => ({ ...r, dir: path.join(dataDir, "packages", r.id) })), null, 2));
      } catch { /* 没有扩展包 */ }
    }
  }
  fs.rmSync(stage, { recursive: true, force: true });
  log(`[backup] 📦 已导入：${plan.items.join("、")}（来自 ${plan.from}；被替换的原文件在 ${backupDir}）`);
  return plan.items;
}

/** 备份文件名 */
export const backupName = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `kagura-backup-${os.hostname().replace(/[^\w.-]/g, "_")}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`;
};
