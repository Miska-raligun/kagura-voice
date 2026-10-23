// 运行环境探测：WSL 里跑、Windows 原生跑，各有各的坑（见 docs/migrate-from-wsl.md）。
import fs from "node:fs";
import path from "node:path";

/** 是否在 WSL 里（Linux 内核带 microsoft 字样，或有 WSL_DISTRO_NAME） */
export function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8")); } catch { return false; }
}

/**
 * Windows 侧访问 WSL 里的 Linux 路径：/home/u/.openclaw → \\wsl.localhost\Ubuntu\home\u\.openclaw
 */
export function wslUncPath(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, "\\")}`;
}

/** 反过来：给 WSL 里的程序看的路径（只认我们自己写进去的那个目录） */
export function toLinuxPath(winPath: string, uncRoot: string, linuxRoot: string): string {
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  if (!norm(winPath).startsWith(norm(uncRoot))) return winPath;
  return path.posix.join(linuxRoot, winPath.slice(uncRoot.length).replace(/\\/g, "/"));
}
