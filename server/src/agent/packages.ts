// pi 扩展包（pi packages）：从 pi 的扩展商店（pi.dev/packages，即 npm 上带 pi-package 关键字的包）、
// git 仓库、本地目录或上传的压缩包安装，格式与 pi 一致，装好后其中的扩展（工具）和技能直接可用。
//
//   来源写法（同 pi install）：npm:@scope/name@1.0.0 · 直接写包名 · git:github.com/o/r@v1 · https://github.com/o/r · 本地路径
//   装在 <数据目录>/packages/<id>/，清单 <数据目录>/packages.json；本地路径的包原地加载、不复制（同 pi）。
//
// 依赖：单文件可执行里没有 npm，这里自带一个最小的安装器——按 semver 从 npm 源取包、校验 sha512、解压，
// 依赖尽量放到包根的 node_modules，版本冲突才嵌套。**不跑安装脚本**（postinstall 之类），需要编译的原生模块用不了。
// pi 宿主提供的包（pi-ai、pi-agent-core、pi-coding-agent、pi-tui、typebox）不装，加载时换成内置的。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import semver from "semver";
import { extractTar, parseTar } from "../util/tar.ts";
import { unzip } from "../util/zip.ts";

export const HOST_PROVIDED = new Set([
  "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui",
  "@mariozechner/pi-ai", "@mariozechner/pi-agent-core", "@mariozechner/pi-coding-agent", "@mariozechner/pi-tui",
  "typebox", "@sinclair/typebox",
]);
const MAX_PACKAGES = 600;
const MAX_TOTAL = 400 * 1024 * 1024;
const PARALLEL = 8;

export interface PkgRecord {
  id: string;
  name: string;
  version: string;
  /** 安装来源（同 pi install 的写法），更新时按它重装 */
  source: string;
  kind: "npm" | "git" | "local" | "upload";
  /** 包所在目录（local 是原路径） */
  dir: string;
  description: string;
  installedAt: number;
  enabled: boolean;
  /** 安装时的提醒：跳过的安装脚本、装不了的依赖…… */
  warnings: string[];
  deps: number;
  /** 本地单个扩展文件 */
  entry?: string;
}

export interface PkgResources { extensions: string[]; skillRoots: string[]; prompts: number; themes: number }

export interface GalleryItem { name: string; version: string; description: string; weekly: number; npm: string; homepage: string; date: string; installed: boolean }

/** 解析来源 */
export function parseSource(src: string): { kind: "npm"; name: string; spec: string } | { kind: "git"; url: string; ref: string; gh?: { owner: string; repo: string } } | { kind: "local"; path: string } {
  const s = src.trim();
  if (!s) throw new Error("来源不能为空");
  if (/^(\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(s)) return { kind: "local", path: s.replace(/^~(?=[\\/])/, os.homedir()) };
  let g = /^git:(.+)$/.exec(s)?.[1] ?? (/^(https?:\/\/|git@|github\.com\/)/.test(s) ? s : null);
  if (g) {
    g = g.replace(/^git@([^:]+):/, "$1/").replace(/^https?:\/\//, "");
    let ref = "";
    const hash = g.indexOf("#");
    if (hash >= 0) { ref = g.slice(hash + 1); g = g.slice(0, hash); }
    const at = /@([^/@]+)$/.exec(g);
    if (at && !ref) { ref = at[1]; g = g.slice(0, at.index); }
    g = g.replace(/\.git$/, "").replace(/\/$/, "");
    const m = /^github\.com\/([^/]+)\/([^/]+)$/.exec(g);
    return { kind: "git", url: `https://${g}`, ref, ...(m ? { gh: { owner: m[1], repo: m[2] } } : {}) };
  }
  const n = s.replace(/^npm:/, "");
  const m = /^((?:@[^/@\s]+\/)?[^/@\s]+)(?:@(.+))?$/.exec(n);
  if (!m) throw new Error(`看不懂的来源：${src}（写 npm:包名、git:github.com/作者/仓库 或本地路径）`);
  return { kind: "npm", name: m[1], spec: m[2] ?? "" };
}

export const pkgId = (name: string) => name.replace(/^@/, "").replace(/[/\\]/g, "__").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "pkg";

/** 很小的 glob：支持 * ** ?，用于 package.json 的 pi.extensions / pi.skills */
function globToRe(g: string): RegExp {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") { if (g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; } else re += "[^/]*"; }
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
function walk(root: string, max = 5000): string[] {
  const out: string[] = [];
  const go = (d: string, rel: string) => {
    let list: fs.Dirent[] = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (out.length > max || e.name === "node_modules" || e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) go(path.join(d, e.name), r);
    }
  };
  go(root, "");
  return out;
}
/** 把清单里的路径 / glob 展开成实际存在的路径（相对包根），支持 ! 排除 */
function expand(root: string, patterns: unknown): string[] {
  if (!Array.isArray(patterns)) return [];
  let all: string[] | null = null;
  const inc = new Set<string>();
  for (const raw of patterns) {
    let p = String(raw).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    const neg = p.startsWith("!");
    if (neg) p = p.slice(1).replace(/^\.\//, "");
    if (/[*?]/.test(p)) {
      all ??= walk(root);
      const re = globToRe(p);
      for (const f of all) if (re.test(f)) (neg ? inc.delete(f) : inc.add(f));
    } else if (neg) inc.delete(p);
    else if (fs.existsSync(path.join(root, p))) inc.add(p);
  }
  return [...inc];
}
const EXT_RE = /\.(ts|js|mjs|cjs|mts|cts)$/;
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
/** 一个扩展路径：文件就是它；目录有 index 就用 index，否则目录里每个 .ts/.js 各算一个（同 pi） */
function extEntries(abs: string): string[] {
  if (isFile(abs)) return EXT_RE.test(abs) && !abs.endsWith(".d.ts") ? [abs] : [];
  if (!isDir(abs)) return [];
  const idx = ["index.ts", "index.js", "index.mjs"].map((f) => path.join(abs, f)).find(isFile);
  if (idx) return [idx];
  return fs.readdirSync(abs).filter((f) => EXT_RE.test(f) && !f.endsWith(".d.ts")).sort().flatMap((f) => {
    const p = path.join(abs, f);
    if (isFile(p)) return [p];
    const sub = ["index.ts", "index.js"].map((x) => path.join(p, x)).find(isFile);
    return sub ? [sub] : [];
  }).concat(fs.readdirSync(abs).filter((f) => isDir(path.join(abs, f)) && f !== "node_modules").flatMap((f) => {
    const sub = ["index.ts", "index.js"].map((x) => path.join(abs, f, x)).find(isFile);
    return sub ? [sub] : [];
  }));
}

/** 包里有哪些资源（扩展文件、技能目录；提示词模板和主题这里用不上，只计数） */
export function discoverResources(root: string): PkgResources {
  let manifest: any = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))?.pi ?? {}; } catch { /* 没有 package.json 也行 */ }
  const pick = (key: string, conv: string) => (manifest[key] !== undefined ? expand(root, manifest[key]) : fs.existsSync(path.join(root, conv)) ? [conv] : []);
  const extensions = [...new Set(pick("extensions", "extensions").flatMap((p) => extEntries(path.join(root, p))))];
  const skillRoots = pick("skills", "skills").map((p) => path.join(root, p)).filter(isDir);
  const count = (key: string, conv: string, re: RegExp) => pick(key, conv).reduce((n, p) => n + (isDir(path.join(root, p)) ? walk(path.join(root, p)).filter((f) => re.test(f)).length : re.test(p) ? 1 : 0), 0);
  return { extensions, skillRoots, prompts: count("prompts", "prompts", /\.md$/), themes: count("themes", "themes", /\.json$/) };
}

type Fetch = typeof fetch;

export class PackageManager {
  private recs: PkgRecord[] = [];
  private packuments = new Map<string, any>();
  /** 装完 / 删除后回调（重新加载扩展） */
  onChange: (() => Promise<void> | void) | null = null;

  constructor(readonly root: string, private opts: { fetch?: Fetch; registry?: string } = {}) {
    fs.mkdirSync(root, { recursive: true });
    try { this.recs = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.recs = []; }
  }

  private get file() { return path.join(path.dirname(this.root), "packages.json"); }
  private get registry() { return (this.opts.registry ?? "https://registry.npmjs.org").replace(/\/$/, ""); }
  private get fetch(): Fetch { return this.opts.fetch ?? fetch; }
  private save() { fs.writeFileSync(this.file, JSON.stringify(this.recs, null, 2)); }

  list(): PkgRecord[] { return this.recs; }
  get(id: string) { return this.recs.find((r) => r.id === id); }
  /** 启用的包的资源 */
  enabled(): { rec: PkgRecord; res: PkgResources }[] {
    return this.recs.filter((r) => r.enabled && (r.entry ? isFile(r.entry) : isDir(r.dir)))
      .map((rec) => ({ rec, res: rec.entry ? { extensions: [rec.entry], skillRoots: [], prompts: 0, themes: 0 } : discoverResources(rec.dir) }));
  }

  /** pi 扩展商店（npm 上带 pi-package 关键字的包）搜索 */
  async search(q: string, size = 20): Promise<GalleryItem[]> {
    const text = encodeURIComponent(`keywords:pi-package ${q}`.trim());
    const r = await this.fetch(`${this.registry}/-/v1/search?text=${text}&size=${Math.min(50, Math.max(1, size))}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`搜索失败：HTTP ${r.status}`);
    const d: any = await r.json();
    const have = new Set(this.recs.map((x) => x.name));
    return (d.objects ?? []).map((o: any) => ({
      name: o.package.name, version: o.package.version, description: String(o.package.description ?? "").slice(0, 300),
      weekly: o.downloads?.weekly ?? 0, npm: o.package.links?.npm ?? `https://www.npmjs.com/package/${o.package.name}`,
      homepage: o.package.links?.homepage ?? o.package.links?.repository ?? "", date: o.package.date ?? "", installed: have.has(o.package.name),
    }));
  }

  private async packument(name: string): Promise<any> {
    if (this.packuments.has(name)) return this.packuments.get(name);
    const r = await this.fetch(`${this.registry}/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" }, signal: AbortSignal.timeout(30_000) });
    if (r.status === 404) throw new Error(`npm 上没有包 ${name}`);
    if (!r.ok) throw new Error(`取 ${name} 的信息失败：HTTP ${r.status}`);
    const d = await r.json();
    this.packuments.set(name, d);
    return d;
  }

  private pickVersion(doc: any, spec: string): any {
    const tags = doc["dist-tags"] ?? {};
    const versions = Object.keys(doc.versions ?? {});
    const v = !spec || spec === "*" ? tags.latest : tags[spec] ?? (semver.valid(spec) ? spec : semver.maxSatisfying(versions, spec));
    const meta = v && doc.versions?.[v];
    if (!meta) throw new Error(`${doc.name} 没有满足「${spec || "latest"}」的版本`);
    return meta;
  }

  /** 下载一个 npm 版本的 tarball，校验后解到 dest */
  private async fetchTarball(meta: any, dest: string, budget: { bytes: number }) {
    const r = await this.fetch(meta.dist.tarball, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`下载 ${meta.name}@${meta.version} 失败：HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    budget.bytes += buf.length;
    if (budget.bytes > MAX_TOTAL) throw new Error("依赖太多太大，放弃安装");
    const integ = String(meta.dist.integrity ?? "");
    if (integ.startsWith("sha512-")) {
      if (crypto.createHash("sha512").update(buf).digest("base64") !== integ.slice(7)) throw new Error(`${meta.name}@${meta.version} 校验失败（sha512 不符）`);
    } else if (meta.dist.shasum && crypto.createHash("sha1").update(buf).digest("hex") !== meta.dist.shasum) {
      throw new Error(`${meta.name}@${meta.version} 校验失败（sha1 不符）`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    extractTar(buf, dest, 1);
  }

  /** 装 root 包的依赖（及依赖的依赖）。返回装了几个、提醒 */
  async installDeps(root: string): Promise<{ count: number; warnings: string[] }> {
    const warnings: string[] = [];
    const budget = { bytes: 0 };
    let count = 0;
    const readPkg = (dir: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { return {}; } };
    /** 从 dir 往上找已装好的 name（到 root 为止） */
    const findInstalled = (dir: string, name: string): string | null => {
      const top = path.resolve(root);
      let d = path.resolve(dir);
      for (;;) {
        const p = path.join(d, "node_modules", name);
        if (isFile(path.join(p, "package.json"))) return p;
        if (d === top) return null;
        // 往上一层包：.../node_modules/<名>（或 @scope/<名>）的上面
        const i = d.lastIndexOf(`${path.sep}node_modules${path.sep}`);
        if (i < 0 || i < top.length) return null;
        d = d.slice(0, i);
      }
    };
    let level: { dir: string }[] = [{ dir: root }];
    const noteScripts = (dir: string, name: string) => {
      const s = readPkg(dir).scripts ?? {};
      if (s.preinstall || s.install || s.postinstall) warnings.push(`${name} 有安装脚本（没有运行），如果用到编译出来的原生模块可能用不了`);
    };
    while (level.length) {
      const jobs: { dest: string; meta: any }[] = [];
      for (const { dir } of level) {
        const pj = readPkg(dir);
        const deps: Record<string, string> = { ...(pj.optionalDependencies ?? {}), ...(pj.dependencies ?? {}) };
        for (let [name, range] of Object.entries(deps)) {
          if (HOST_PROVIDED.has(name)) continue;
          range = String(range);
          let real = name;
          const alias = /^npm:((?:@[^/]+\/)?[^@]+)@?(.*)$/.exec(range);
          if (alias) { real = alias[1]; range = alias[2] || "*"; }
          if (/^(file:|link:|git|https?:|github:|workspace:)/.test(range) || /^[^/@]+\/[^/]+$/.test(range)) {
            warnings.push(`跳过 ${name}（${range}）：只支持从 npm 源装依赖`);
            continue;
          }
          const have = findInstalled(dir, name);
          if (have && semver.satisfies(readPkg(have).version ?? "0.0.0", range, { includePrerelease: true })) continue;
          if (jobs.some((j) => j.dest === path.join(root, "node_modules", name))) continue;
          let meta: any;
          try { meta = this.pickVersion(await this.packument(real), range); }
          catch (e: any) {
            if (pj.optionalDependencies?.[name]) continue;
            throw e;
          }
          const rootSlot = path.join(root, "node_modules", name);
          const dest = !fs.existsSync(rootSlot) && !jobs.some((j) => j.dest === rootSlot) ? rootSlot : path.join(dir, "node_modules", name);
          if (jobs.some((j) => j.dest === dest)) continue;
          jobs.push({ dest, meta });
        }
      }
      if (count + jobs.length > MAX_PACKAGES) throw new Error(`依赖超过 ${MAX_PACKAGES} 个，放弃安装`);
      for (let i = 0; i < jobs.length; i += PARALLEL) {
        await Promise.all(jobs.slice(i, i + PARALLEL).map(async (j) => {
          await this.fetchTarball(j.meta, j.dest, budget);
          noteScripts(j.dest, j.meta.name);
        }));
      }
      count += jobs.length;
      level = jobs.map((j) => ({ dir: j.dest }));
    }
    return { count, warnings };
  }

  private async fromGithub(gh: { owner: string; repo: string }, ref: string, dest: string) {
    const r = await this.fetch(`https://codeload.github.com/${gh.owner}/${gh.repo}/tar.gz/${encodeURIComponent(ref || "HEAD")}`, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`下载 GitHub 仓库 ${gh.owner}/${gh.repo}${ref ? `@${ref}` : ""} 失败：HTTP ${r.status}`);
    extractTar(Buffer.from(await r.arrayBuffer()), dest, 1);
  }

  private fromGit(url: string, ref: string, dest: string) {
    const r = spawnSync("git", ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), url, dest], { encoding: "utf8", timeout: 180_000 });
    if (r.error) throw new Error(`这台电脑上没有 git，只能直接安装 GitHub 上的仓库（${url}）`);
    if (r.status !== 0) throw new Error(`git clone 失败：${(r.stderr || "").trim().split("\n").pop()}`);
    fs.rmSync(path.join(dest, ".git"), { recursive: true, force: true });
  }

  /** 把一个已经解好的包目录登记（替换同 id 的旧版本） */
  private commit(tmp: string, base: Omit<PkgRecord, "id" | "name" | "version" | "description" | "dir" | "installedAt" | "enabled" | "deps" | "warnings">, extra: { count: number; warnings: string[] }, fallbackName: string): PkgRecord {
    let pj: any = {};
    try { pj = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8")); } catch { /* 单个扩展文件没有 package.json */ }
    const name = String(pj.name || fallbackName);
    const id = pkgId(name);
    const dir = path.join(this.root, id);
    const old = this.get(id);
    if (old && old.kind !== "local") fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    const res = discoverResources(dir);
    const warnings = [...extra.warnings];
    if (!res.extensions.length && !res.skillRoots.length) warnings.push("包里没找到扩展或技能（如果是要先编译的 TypeScript 项目，请装 npm 上发布好的版本）");
    if (res.prompts || res.themes) warnings.push(`包里的${res.prompts ? ` ${res.prompts} 个提示词模板` : ""}${res.themes ? ` ${res.themes} 个主题` : ""}是 pi 终端界面用的，这里用不上`);
    const rec: PkgRecord = { ...base, id, name, version: String(pj.version ?? ""), description: String(pj.description ?? "").slice(0, 300), dir, installedAt: Date.now() / 1000, enabled: old?.enabled ?? true, deps: extra.count, warnings };
    this.recs = [...this.recs.filter((r) => r.id !== id), rec];
    this.save();
    return rec;
  }

  private tmpDir() {
    const d = path.join(this.root, `.tmp-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  /** 安装（或重装）。source 同 pi install；upload = 上传的 .tgz / .zip / .ts / .js */
  async install(source: string, upload?: { filename: string; data: Buffer }): Promise<PkgRecord> {
    let rec: PkgRecord;
    if (upload) {
      const tmp = this.tmpDir();
      try {
        const fn = upload.filename.toLowerCase();
        if (/\.(tgz|tar\.gz|tar)$/.test(fn)) extractTar(upload.data, tmp, stripOf(upload.data));
        else if (fn.endsWith(".zip")) {
          const entries = unzip(upload.data);
          const top = new Set(entries.map((e) => e.name.split("/")[0]));
          const strip = top.size === 1 && entries.every((e) => e.name.includes("/")) ? 1 : 0;
          for (const e of entries) {
            const rel = e.name.split("/").slice(strip).filter(Boolean);
            if (!rel.length || e.name.endsWith("/")) continue;
            if (rel.includes("..")) throw new Error(`压缩包里有越界路径：${e.name}`);
            const t = path.join(tmp, ...rel);
            fs.mkdirSync(path.dirname(t), { recursive: true });
            fs.writeFileSync(t, e.data);
          }
        } else if (EXT_RE.test(fn)) {
          fs.mkdirSync(path.join(tmp, "extensions"), { recursive: true });
          fs.writeFileSync(path.join(tmp, "extensions", path.basename(upload.filename)), upload.data);
        } else throw new Error("只认 .tgz / .zip / .ts / .js");
        const extra = await this.installDeps(tmp);
        rec = this.commit(tmp, { source: `upload:${upload.filename}`, kind: "upload" }, extra, upload.filename.replace(/\.(tgz|tar\.gz|tar|zip|ts|js|mjs)$/i, ""));
      } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
    } else {
      const src = parseSource(source);
      if (src.kind === "local") {
        const abs = path.resolve(src.path);
        if (!fs.existsSync(abs)) throw new Error(`没有这个路径：${abs}`);
        let pj: any = {};
        try { pj = JSON.parse(fs.readFileSync(path.join(abs, "package.json"), "utf8")); } catch { /* 可以没有 */ }
        const name = String(pj.name || path.basename(abs).replace(EXT_RE, ""));
        const id = pkgId(name);
        // 单个文件就是一个扩展；目录按包的规则找资源。都原地引用、不复制（改了重新加载就生效）
        const entry = isFile(abs) ? abs : undefined;
        const res = entry ? { extensions: [entry], skillRoots: [] } : discoverResources(abs);
        rec = { id, name, version: String(pj.version ?? ""), source, kind: "local", dir: entry ? path.dirname(abs) : abs, ...(entry ? { entry } : {}),
          description: String(pj.description ?? ""), installedAt: Date.now() / 1000, enabled: true, deps: 0,
          warnings: res.extensions.length || res.skillRoots.length ? ["本地包原地加载，不复制、不装依赖（同 pi）"] : ["这个目录里没找到扩展或技能"] };
        this.recs = [...this.recs.filter((r) => r.id !== id), rec];
        this.save();
      } else {
        const tmp = this.tmpDir();
        try {
          const budget = { bytes: 0 };
          if (src.kind === "npm") {
            const meta = this.pickVersion(await this.packument(src.name), src.spec);
            await this.fetchTarball(meta, tmp, budget);
          } else if (src.gh) await this.fromGithub(src.gh, src.ref, tmp);
          else { fs.rmSync(tmp, { recursive: true, force: true }); this.fromGit(src.url, src.ref, tmp); }
          const extra = await this.installDeps(tmp);
          rec = this.commit(tmp, { source: source.trim(), kind: src.kind }, extra, src.kind === "npm" ? src.name : (src.gh?.repo ?? path.basename(src.url)));
        } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
        finally { this.packuments.clear(); }
      }
    }
    console.log(`[pkg] 📦 已安装 ${rec.name}${rec.version ? `@${rec.version}` : ""}（${rec.source}${rec.deps ? `，${rec.deps} 个依赖` : ""}）`);
    await this.onChange?.();
    return rec;
  }

  /** 按原来源重新安装（npm 带了版本号的就还是那个版本，同 pi） */
  async update(id: string): Promise<PkgRecord> {
    const r = this.get(id);
    if (!r) throw Object.assign(new Error(`没有扩展包 ${id}`), { status: 404 });
    if (r.kind === "upload") throw new Error("上传安装的包没法自动更新，请重新上传");
    if (r.kind === "local") { await this.onChange?.(); return r; }
    return this.install(r.source);
  }

  async setEnabled(id: string, enabled: boolean) {
    const r = this.get(id);
    if (!r) throw Object.assign(new Error(`没有扩展包 ${id}`), { status: 404 });
    r.enabled = enabled;
    this.save();
    await this.onChange?.();
  }

  /** 删除：装的挪进回收站；本地包只是不再引用 */
  async remove(id: string) {
    const r = this.get(id);
    if (!r) throw Object.assign(new Error(`没有扩展包 ${id}`), { status: 404 });
    if (r.kind !== "local" && r.dir.startsWith(path.resolve(this.root))) {
      const trash = path.join(this.root, ".trash");
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(r.dir, path.join(trash, `${Date.now()}-${r.id}`));
    }
    this.recs = this.recs.filter((x) => x.id !== id);
    this.save();
    await this.onChange?.();
  }

  /** pi 里装过的包（~/.pi/agent/settings.json 的 packages）和放在 ~/.pi/agent/extensions/ 的扩展 */
  static piSources(home = os.homedir()): { source: string; from: string }[] {
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
    const out: { source: string; from: string }[] = [];
    try {
      const s = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
      for (const p of s.packages ?? []) {
        const src = typeof p === "string" ? p : p?.source;
        if (!src) continue;
        // 相对路径以 settings.json 所在目录为准
        out.push({ source: /^\.{1,2}[\\/]/.test(src) ? path.resolve(agentDir, src) : src, from: "settings.json" });
      }
    } catch { /* 没装 pi */ }
    const extDir = path.join(agentDir, "extensions");
    if (isDir(extDir)) for (const f of fs.readdirSync(extDir)) {
      const p = path.join(extDir, f);
      if ((isFile(p) && EXT_RE.test(f)) || isFile(path.join(p, "index.ts")) || isFile(path.join(p, "index.js"))) out.push({ source: p, from: "extensions/" });
    }
    return out;
  }
}

/** .tgz 第一层是不是唯一的目录（npm 包是 package/，GitHub 是 repo-ref/）：是就去掉它 */
function stripOf(buf: Buffer): number {
  const names = parseTar(buf).map((e) => e.name.replace(/^\.\//, ""));
  const tops = new Set(names.map((n) => n.split("/")[0]));
  return tops.size === 1 && names.every((n) => n.includes("/") || n.endsWith("/")) ? 1 : 0;
}
