// 把 esbuild 产物做成 Node 单文件可执行（SEA）。Windows / Linux / macOS 通用。
// 用法：node scripts/sea.mjs <dist/xxx.cjs> <输出名，不带扩展名>
// 步骤：生成 SEA blob → 复制当前 node 可执行 → （mac/win 先去签名）→ postject 注入 → （mac 重新 ad-hoc 签名）
import { execFileSync } from "node:child_process";
import { copyFileSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/**
 * 单文件可执行是把「当前这个 node」整个复制进去的，所以 node 本身的漏洞会原样带进发布包。
 * 每条大版本线的最低安全版本（有新的安全发布就往上提）：2026-10-21 Brotli 解码越界写 RCE（CVE-2026-111497）等 10 个漏洞。
 */
const MIN_SAFE = { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" };
{
  const v = process.versions.node.split(".").map(Number);
  const min = MIN_SAFE[v[0]];
  const lt = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (!min || lt(v, min.split(".").map(Number)) < 0) {
    console.error(`拒绝打包：当前 Node ${process.versions.node} 不在安全版本列表里（要求 ${Object.values(MIN_SAFE).join(" / ")} 或更高的同线版本）`);
    process.exit(1);
  }
}

const [main, outBase] = process.argv.slice(2);
if (!main || !outBase) { console.error("usage: node scripts/sea.mjs <main.cjs> <out>"); process.exit(2); }
const isWin = process.platform === "win32", isMac = process.platform === "darwin";
const out = outBase + (isWin ? ".exe" : "");
const blob = outBase + ".blob";
const cfg = outBase + ".sea-config.json";

writeFileSync(cfg, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }));
execFileSync(process.execPath, ["--experimental-sea-config", cfg], { stdio: "inherit" });
if (existsSync(out)) rmSync(out);
copyFileSync(process.execPath, out);
if (!isWin) chmodSync(out, 0o755);
if (isMac) execFileSync("codesign", ["--remove-signature", out], { stdio: "inherit" });
// Windows 的 node.exe 自带签名，注入后签名失效但仍可运行（发布时再统一签名，见计划 D5）

const postject = require.resolve("postject/dist/cli.js");
const args = [postject, out, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (isMac) args.push("--macho-segment-name", "NODE_SEA");
execFileSync(process.execPath, args, { stdio: "inherit" });
if (isMac) execFileSync("codesign", ["--sign", "-", out], { stdio: "inherit" });
rmSync(cfg); rmSync(blob);
console.log("SEA ready:", out);
