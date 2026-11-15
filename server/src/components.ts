// 自带的 MCP 组件（打印机 / Blender / build123d）可以不发完整版本单独更新（LRN 2026-11-15，主人：「发版流程太久了，而且没必要」）。
// 组件 = scripts/build-mcp.mjs 打出来的一个 CommonJS 文件（导出 run(version)），发布在 GitHub 的固定 Release「mcp-components」里
// （.github/workflows/mcp-components.yml：这几个目录一改就重打、覆盖，一两分钟）。
//   · 管理界面「检查组件更新」→ ComponentUpdater 下载变了的那个、按 GitHub 给的 sha256 校验 → <数据目录>/mcp_components/<名>.cjs + <名>.json
//   · `kagura mcp <名>` 起来时（McpManager 用 KAGURA_COMPONENTS_DIR 告诉它目录）先看那里有没有**比自带的新**的、文件没被改过，有就加载它，否则用自带的
// 新旧只按源码时间（提交时间）比：以后正式版带了更新的代码，自带的就比下载的新，自动用回自带的——不会越更越旧。
// 下载的是会执行的代码：只认本仓库那个 Release、只认 GitHub 接口给的 digest（镜像拿到的东西不可信），校验不对不装。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { downloadSources, netReason } from "./util/selfupdate.ts";

export const COMPONENTS = ["bambu-printer", "blender", "build123d"] as const;
export type ComponentName = typeof COMPONENTS[number];
export const COMPONENTS_ENV = "KAGURA_COMPONENTS_DIR";
export const COMPONENTS_API = "https://api.github.com/repos/Miska-raligun/kagura-voice/releases/tags/mcp-components";

export interface Stamp { sha256: string; stamp: number }
declare const __MCP_BUILTIN__: Record<string, Stamp> | undefined;
/** 这个程序里自带的组件是哪一版（构建时写进来；开发 / 测试时没有 = 时间 0，任何下载的都算新） */
export const BUILTIN: Record<string, Stamp> = typeof __MCP_BUILTIN__ !== "undefined" ? __MCP_BUILTIN__ : {};

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const readMeta = (dir: string, name: string): (Stamp & { installedAt?: number }) | null => {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8")); return typeof j?.sha256 === "string" && Number.isFinite(j?.stamp) ? j : null; } catch { return null; }
};

/** 该用下载的那份吗：有、比自带的新、文件和记录的 sha256 对得上（被改过 / 没下完的不用） */
export function pickComponent(name: string, dir: string | undefined, builtin: Record<string, Stamp> = BUILTIN): (Stamp & { file: string }) | null {
  if (!dir) return null;
  const meta = readMeta(dir, name);
  const file = path.join(dir, `${name}.cjs`);
  if (!meta || !fs.existsSync(file)) return null;
  const b = builtin[name];
  if (b && (meta.stamp <= b.stamp || meta.sha256 === b.sha256)) return null;
  if (sha256(fs.readFileSync(file)) !== meta.sha256) return null;
  return { ...meta, file };
}

/** `kagura mcp <名>`：有更新版就跑它，返回 true；没有 / 加载失败返回 false（照常用自带的）。日志只能写标准错误（标准输出走协议） */
export function runUpdatedComponent(name: string, version: string, dir = process.env[COMPONENTS_ENV], log: (l: string) => void = (l) => { process.stderr.write(l + "\n"); }): boolean {
  const c = pickComponent(name, dir);
  if (!c) return false;
  try {
    const mod = createRequire(c.file)(c.file);
    if (typeof mod?.run !== "function") throw new Error("里面没有 run()");
    log(`[component] 用更新版 ${name}（${new Date(c.stamp * 1000).toLocaleString("zh-CN", { hour12: false })}，${c.sha256.slice(0, 12)}）`);
    mod.run(version);
    return true;
  } catch (e: any) {
    log(`[component] ⚠️  更新版 ${name} 加载失败，改用自带的：${e?.message ?? e}`);
    return false;
  }
}

export interface ComponentInfo {
  name: string;
  builtin: Stamp | null;
  installed: (Stamp & { installedAt?: number }) | null;
  /** 现在用的是哪份 */
  active: "builtin" | "installed";
  latest: (Stamp & { size: number }) | null;
  updatable: boolean;
}

interface Remote { components: Record<string, Stamp & { size: number; url: string; digest: string }>; checkedAt: number }

export class ComponentUpdater {
  remote: Remote | null = null;
  error = "";
  constructor(readonly dir: string, private opts: { fetch: typeof fetch; mirrors?: string[]; api?: string; builtin?: Record<string, Stamp>; timeoutMs?: number }) {}

  private get builtin() { return this.opts.builtin ?? BUILTIN; }

  status(): ComponentInfo[] {
    return COMPONENTS.map((name) => {
      const builtin = this.builtin[name] ?? null;
      const installed = readMeta(this.dir, name);
      const active = pickComponent(name, this.dir, this.builtin) ? "installed" : "builtin";
      const cur = active === "installed" ? installed! : builtin;
      const r = this.remote?.components[name];
      const latest = r ? { sha256: r.sha256, stamp: r.stamp, size: r.size } : null;
      const updatable = !!latest && latest.sha256 !== cur?.sha256 && latest.sha256 !== builtin?.sha256 && latest.stamp > (cur?.stamp ?? 0);
      return { name, builtin, installed, active, latest, updatable };
    });
  }

  /** 下载一个小文件：先直连、再镜像；按 digest 校验，第一个对得上的算数 */
  private async fetchVerified(url: string, want: string, label: string): Promise<Buffer> {
    const tried: string[] = [];
    for (const src of downloadSources(url, this.opts.mirrors)) {
      try {
        const r = await this.opts.fetch(src.url, { headers: { "user-agent": "kagura" }, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const b = Buffer.from(await r.arrayBuffer());
        if (sha256(b) !== want) { tried.push(`${src.name}（校验不符）`); continue; }
        return b;
      } catch (e: any) { tried.push(`${src.name}（${netReason(e)}）`); }
    }
    throw new Error(`${label} 下载失败：${tried.join("；")}`);
  }

  /** 查 GitHub 上最新的组件 */
  async check(): Promise<ComponentInfo[]> {
    this.error = "";
    try {
      const r = await this.opts.fetch(this.opts.api ?? COMPONENTS_API, { headers: { "user-agent": "kagura", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) });
      if (r.status === 404) throw new Error("还没有发布过组件更新");
      if (!r.ok) throw new Error(`GitHub 接口返回 HTTP ${r.status}`);
      const rel: any = await r.json();
      const assets = new Map<string, { url: string; digest: string; size: number }>();
      for (const a of rel?.assets ?? []) {
        const d = /^sha256:([0-9a-f]{64})$/i.exec(String(a?.digest ?? ""));
        if (d) assets.set(String(a.name), { url: String(a.browser_download_url), digest: d[1].toLowerCase(), size: Number(a.size ?? 0) });
      }
      const m = assets.get("manifest.json");
      if (!m) throw new Error("发布里没有带校验和的 manifest.json");
      const manifest = JSON.parse((await this.fetchVerified(m.url, m.digest, "manifest.json")).toString("utf8"));
      const components: Remote["components"] = {};
      for (const name of COMPONENTS) {
        const c = manifest?.components?.[name], a = assets.get(`${name}.cjs`);
        // manifest 说的和 GitHub 给的 digest 对不上：发布有问题，这个组件先不认
        if (!c || !a || String(c.sha256).toLowerCase() !== a.digest) continue;
        components[name] = { sha256: a.digest, stamp: Number(c.stamp) || 0, size: a.size, url: a.url, digest: a.digest };
      }
      this.remote = { components, checkedAt: Date.now() };
    } catch (e: any) {
      this.error = String(e?.message ?? e);
      console.log(`[component] ⚠️  检查组件更新失败：${this.error}`);
    }
    return this.status();
  }

  /** 装上能更新的（names 不给 = 全部）；返回装了哪些 */
  async update(names?: string[]): Promise<string[]> {
    if (!this.remote) await this.check();
    if (!this.remote) throw new Error(this.error || "查不到组件更新");
    const todo = this.status().filter((c) => c.updatable && (!names?.length || names.includes(c.name)));
    fs.mkdirSync(this.dir, { recursive: true });
    const done: string[] = [];
    for (const c of todo) {
      const r = this.remote.components[c.name];
      const bytes = await this.fetchVerified(r.url, r.digest, `${c.name}.cjs`);
      const file = path.join(this.dir, `${c.name}.cjs`);
      fs.writeFileSync(file + ".part", bytes);
      fs.renameSync(file + ".part", file);
      fs.writeFileSync(path.join(this.dir, `${c.name}.json`), JSON.stringify({ sha256: r.sha256, stamp: r.stamp, installedAt: Date.now() }));
      console.log(`[component] ⬆️  ${c.name} 更新到 ${new Date(r.stamp * 1000).toLocaleString("zh-CN", { hour12: false })} 的版本（${r.sha256.slice(0, 12)}）`);
      done.push(c.name);
    }
    return done;
  }

  /** 删掉下载的，用回自带的 */
  reset(name: string): boolean {
    if (!(COMPONENTS as readonly string[]).includes(name)) throw new Error(`没有组件 ${name}`);
    let had = false;
    for (const f of [`${name}.cjs`, `${name}.json`]) { const p = path.join(this.dir, f); if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); had = true; } }
    if (had) console.log(`[component] ↩️  ${name} 用回自带的`);
    return had;
  }
}
