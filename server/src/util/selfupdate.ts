// 在管理界面里一键更新：下载对应平台的安装包 → 按 SHA256SUMS 校验 → 安装 → 重启。
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
export function assetFor(kind: InstallKind, assets: { name: string; url: string; size: number }[]) {
  const re = kind === "windows" ? /^Kagura-Setup-.*\.exe$/ : kind === "appimage" ? /x86_64\.AppImage$/ : kind === "deb" ? /_amd64\.deb$/ : null;
  return re ? assets.find((a) => re.test(a.name)) : undefined;
}

export class SelfUpdater {
  state: UpdateState = { phase: "idle", done: 0, total: 0, message: "" };
  constructor(private dataDir: string, private fetchFn: typeof fetch = fetch, private kind: InstallKind = installKind(),
              private onRestart: () => void = () => setTimeout(() => process.exit(0), 800)) {}

  get installKind() { return this.kind; }

  private async download(url: string, dest: string, total: number) {
    const r = await this.fetchFn(url, { headers: { "user-agent": "kagura" }, signal: AbortSignal.timeout(30 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`下载失败：HTTP ${r.status}`);
    this.state.total = Number(r.headers.get("content-length")) || total;
    const out = fs.createWriteStream(dest);
    const hash = crypto.createHash("sha256");
    for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      this.state.done += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((res) => out.once("drain", () => res()));
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    return hash.digest("hex");
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
      const got = await this.download(asset.url, dest + ".part", asset.size);
      this.state = { ...this.state, phase: "verifying", message: "正在校验" };
      if (sums) {
        const r = await this.fetchFn(sums.url, { headers: { "user-agent": "kagura" }, signal: AbortSignal.timeout(60_000) });
        const line = (await r.text()).split("\n").find((l) => l.trim().endsWith(asset.name));
        const want = line?.trim().split(/\s+/)[0]?.toLowerCase();
        if (!want) throw new Error("SHA256SUMS 里没有这个文件的校验和");
        if (want !== got) throw new Error("校验失败：下载的文件和发布的不一致，已丢弃");
      }
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
