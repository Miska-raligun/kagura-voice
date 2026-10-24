// 在管理界面里一键更新：下载对应平台的安装包 → 校验 sha256 → 安装 → 重启。
//   下载：GitHub 的安装包实际放在 release-assets.githubusercontent.com，国内经常连不上或被重置（症状「卡在 0~1KB，然后 fetch failed」）。
//   所以按「直连 → 加速镜像」依次试，断点续传，30 秒没数据就换下一个源。镜像返回的东西不可信，
//   校验和只认 GitHub 接口（api.github.com，查更新时已经拿到）给的 digest；老版本没有 digest 才退回 SHA256SUMS。
//   Windows 安装版：静默运行新的 Kagura-Setup（会弹一次管理员确认），装完拉起托盘版；没装成也会把原来的拉起来
//   AppImage：下载新文件替换自己，重启
//   deb：装包要 sudo，服务端做不了——下载好，给出一条命令让用户执行
//   开发运行（node 跑脚本）：不支持
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { UpdateInfo } from "./update.ts";

export type InstallKind = "windows" | "appimage" | "deb" | "unsupported";
export interface UpdateState { phase: "idle" | "downloading" | "verifying" | "installing" | "manual" | "error"; done: number; total: number; message: string; command?: string; file?: string }

function isSea(): boolean { try { return !!require("node:sea").isSea(); } catch { return false; } }

export function installKind(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, platform = process.platform, sea = isSea()): InstallKind {
  if (!sea) return "unsupported";
  if (platform === "win32") return "windows";
  if (platform === "linux" && env.APPIMAGE) return "appimage";
  if (platform === "linux" && execPath.startsWith("/opt/kagura/")) return "deb";
  return "unsupported";
}

/** 这个平台该下哪个文件 */
export function assetFor<T extends { name: string; url: string; size: number }>(kind: InstallKind, assets: T[]): T | undefined {
  const re = kind === "windows" ? /^Kagura-Setup-.*\.exe$/ : kind === "appimage" ? /x86_64\.AppImage$/ : kind === "deb" ? /_amd64\.deb$/ : null;
  return re ? assets.find((a) => re.test(a.name)) : undefined;
}

/** GitHub 下载加速镜像（前缀式：镜像 + 原地址）。都支持断点续传；config.json 的 update_mirrors 可覆盖（[] = 只直连） */
export const UPDATE_MIRRORS = ["https://gh-proxy.com/", "https://ghfast.top/", "https://ghproxy.net/", "https://gh.llkk.cc/"];

/** 下载源：先直连，再按镜像（只对 github.com 的地址套镜像） */
export function downloadSources(url: string, mirrors: string[] = UPDATE_MIRRORS): { name: string; url: string }[] {
  const out = [{ name: "GitHub 直连", url }];
  if (/^https:\/\/github\.com\//.test(url)) {
    for (const m of mirrors) {
      const base = m.trim().replace(/\/*$/, "/");
      if (/^https?:\/\//.test(base)) out.push({ name: base.replace(/^https?:\/\//, "").replace(/\/$/, ""), url: base + url });
    }
  }
  return out;
}

/** 把 fetch 的报错翻成人话（undici 只说 fetch failed，真正原因在 cause 里） */
export function netReason(e: any): string {
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "长时间没有收到数据";
  const c = e?.cause ?? e;
  const code = String(c?.code ?? "");
  const map: Record<string, string> = {
    ECONNRESET: "连接被重置", ETIMEDOUT: "连接超时", UND_ERR_CONNECT_TIMEOUT: "连接超时", UND_ERR_HEADERS_TIMEOUT: "等待响应超时",
    UND_ERR_BODY_TIMEOUT: "传输超时", UND_ERR_SOCKET: "连接中断", ENOTFOUND: "域名解析失败", EAI_AGAIN: "域名解析失败",
    ECONNREFUSED: "连接被拒绝", ENETUNREACH: "网络不通", EHOSTUNREACH: "网络不通", CERT_HAS_EXPIRED: "证书过期",
  };
  if (map[code]) return `${map[code]}（${code}）`;
  const msg = String(c?.message ?? e?.message ?? e);
  return code && !msg.includes(code) ? `${msg}（${code}）` : msg;
}

const sha256File = (file: string) => new Promise<string>((ok, bad) => {
  const h = crypto.createHash("sha256");
  fs.createReadStream(file).on("data", (d) => h.update(d)).on("error", bad).on("end", () => ok(h.digest("hex")));
});

export class SelfUpdater {
  state: UpdateState = { phase: "idle", done: 0, total: 0, message: "" };
  private mirrors: string[];
  private stallMs: number;
  constructor(private dataDir: string, private fetchFn: typeof fetch = fetch, private kind: InstallKind = installKind(),
              private onRestart: () => void = () => setTimeout(() => process.exit(0), 800),
              opts: { mirrors?: string[]; stallMs?: number } = {}) {
    this.mirrors = opts.mirrors ?? UPDATE_MIRRORS;
    this.stallMs = opts.stallMs ?? 30_000;
  }

  get installKind() { return this.kind; }

  /**
   * 从一个源下到 dest（已有部分就续传）。返回 true = 完整；中途断了抛错，已下的留着给下一次续传。
   * stallMs 内没收到任何数据（含连接、等响应头）就放弃这个源。
   */
  private async fetchOnce(url: string, dest: string, total: number): Promise<void> {
    let have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (total && have >= total) return;
    const ac = new AbortController();
    let timer = setTimeout(() => ac.abort(), this.stallMs);
    const poke = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(), this.stallMs); };
    try {
      const r = await this.fetchFn(url, { headers: { "user-agent": "kagura", ...(have ? { range: `bytes=${have}-` } : {}) }, signal: ac.signal });
      if (r.status === 416 && total && have === total) return;
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      if ((r.headers.get("content-type") ?? "").includes("text/html")) throw new Error("返回的是网页而不是文件");
      if (r.status !== 206) have = 0;                        // 源不支持续传：从头来
      const out = fs.createWriteStream(dest, { flags: have ? "a" : "w" });
      this.state.done = have;
      try {
        for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
          poke();
          this.state.done += chunk.length;
          if (!out.write(chunk)) await new Promise<void>((res) => out.once("drain", () => res()));
        }
      } finally { await new Promise<void>((res) => out.end(() => res())); }
      const size = fs.statSync(dest).size;
      if (total && size !== total) throw new Error(`文件不完整（${size}/${total} 字节）`);
    } finally { clearTimeout(timer); }
  }

  /** 依次试各个源；某个源有进展就在它上面接着续传，没进展再换下一个。返回下载到的文件的 sha256 */
  private async download(asset: { url: string; size: number; name: string }, dest: string, want: string | undefined, mirrors: string[]): Promise<string> {
    const tried: string[] = [];
    fs.rmSync(dest, { force: true });
    for (const src of downloadSources(asset.url, mirrors)) {
      this.state.message = `正在下载 ${asset.name}（${src.name}）`;
      for (let attempt = 0; attempt < 5; attempt++) {
        const before = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        try {
          await this.fetchOnce(src.url, dest, asset.size);
          const got = await sha256File(dest);
          if (want && got !== want) {                       // 这个源给的东西不对：丢掉，换下一个源从头下
            fs.rmSync(dest, { force: true });
            if (src.url === asset.url) throw new Error("校验失败：下载的文件和发布的不一致，已丢弃");
            this.state.done = 0;
            tried.push(`${src.name}（校验不符）`);
            break;
          }
          if (tried.length) console.log(`[update] ⬇️  ${asset.name} 改用 ${src.name} 下载完成（之前：${tried.join("；")}）`);
          return got;
        } catch (e: any) {
          if (String(e?.message).startsWith("校验失败")) throw e;
          const why = netReason(e);
          console.log(`[update] ⚠️  ${src.name} 下载中断：${why}`);
          const after = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
          if (after > before && attempt < 4) continue;      // 有进展：同一个源接着续传
          tried.push(`${src.name}（${why}）`);
          break;
        }
      }
    }
    throw new Error(`下载失败，所有下载源都试过了：${tried.join("；")}。可以在「设置 → 工具」里配置网络代理后重试，或到发布页手动下载安装包`);
  }

  /** 校验和：优先 GitHub 接口给的 digest；没有就下载 SHA256SUMS（同样按各个源试） */
  private async expectedSha(asset: { name: string; digest?: string }, sums: { url: string } | undefined, mirrors: string[]): Promise<string | undefined> {
    const d = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "");
    if (d) return d[1].toLowerCase();
    if (!sums) return undefined;
    const errs: string[] = [];
    for (const src of downloadSources(sums.url, mirrors)) {
      try {
        const r = await this.fetchFn(src.url, { headers: { "user-agent": "kagura" }, signal: AbortSignal.timeout(this.stallMs) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const line = (await r.text()).split("\n").find((l) => l.trim().endsWith(asset.name));
        const want = line?.trim().split(/\s+/)[0]?.toLowerCase();
        if (!want || !/^[0-9a-f]{64}$/.test(want)) throw new Error("SHA256SUMS 里没有这个文件的校验和");
        return want;
      } catch (e: any) { errs.push(`${src.name}（${netReason(e)}）`); }
    }
    throw new Error(`拿不到校验和：${errs.join("；")}`);
  }

  /** 下载、校验、安装。info 是 UpdateChecker 查到的最新版本 */
  async install(info: UpdateInfo | null): Promise<UpdateState> {
    if (["downloading", "verifying", "installing"].includes(this.state.phase)) return this.state;
    try {
      if (!info?.newer) throw new Error("已经是最新版本");
      if (this.kind === "unsupported") throw new Error("这种运行方式（开发版 / 自己编译）不支持在线更新，请到发布页手动下载");
      const asset = assetFor(this.kind, info.assets ?? []);
      if (!asset) throw new Error("新版本里没有这个平台的安装包");
      const sums = (info.assets ?? []).find((a) => a.name === "SHA256SUMS");
      const dir = path.join(this.dataDir, "updates");
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, asset.name);
      this.state = { phase: "downloading", done: 0, total: asset.size, message: `正在下载 ${asset.name}` };
      // 没有 digest 的老发布：SHA256SUMS 只能从同一批源拿，镜像拿到的不可信——这种情况只走直连
      const mirrors = /^sha256:/i.test(asset.digest ?? "") ? this.mirrors : [];
      const want = await this.expectedSha(asset, sums, mirrors);
      const got = await this.download(asset, dest + ".part", want, mirrors);
      this.state = { ...this.state, phase: "verifying", message: "正在校验" };
      if (want && want !== got) throw new Error("校验失败：下载的文件和发布的不一致，已丢弃");
      fs.renameSync(dest + ".part", dest);
      this.state = { ...this.state, phase: "installing", message: "正在安装，服务端马上会重启" };
      if (this.kind === "windows") this.runWindowsInstaller(dest);
      else if (this.kind === "appimage") this.replaceAppImage(dest);
      else {
        this.state = { ...this.state, phase: "manual", file: dest, message: "deb 包需要管理员权限安装：在终端里执行下面这条命令，装完服务会自动用新版本", command: `sudo apt install ${dest} && systemctl --user restart kagura` };
        return this.state;
      }
      console.log(`[update] ⬆️  正在更新到 ${info.latest}`);
      this.onRestart();
    } catch (e: any) {
      this.state = { ...this.state, phase: "error", message: String(e.message ?? e) };
      console.log(`[update] ⚠️  更新失败：${this.state.message}`);
    }
    return this.state;
  }

  /** 静默跑安装包（它会结束正在运行的 Kagura），装完不管成败都把托盘版拉起来 */
  private runWindowsInstaller(setup: string) {
    const app = path.dirname(process.execPath);
    const tray = path.join(app, "kagura-tray.exe");
    const exe = fs.existsSync(tray) ? tray : process.execPath;
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const script = [
      "$ErrorActionPreference = 'Continue'",
      "Start-Sleep -Seconds 2",
      `$p = Start-Process -FilePath ${q(setup)} -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-' -Wait -PassThru`,
      `Add-Content -Path ${q(path.join(this.dataDir, "updates", "update.log"))} -Value ("installer exit " + $p.ExitCode)`,
      `Start-Process -FilePath ${q(exe)} -ArgumentList '--tray','--no-browser'`,
    ].join("\r\n");
    const ps1 = path.join(this.dataDir, "updates", "run-update.ps1");
    fs.writeFileSync(ps1, "﻿" + script, "utf16le");
    spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", ps1], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }

  /** AppImage：换掉自己（Linux 下正在运行的文件可以被替换），然后重启 */
  private replaceAppImage(file: string) {
    const target = process.env.APPIMAGE!;
    const tmp = target + ".new";
    fs.copyFileSync(file, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, target);
  }
}
