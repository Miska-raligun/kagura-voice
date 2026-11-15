// 自带的 MCP 服务器（打印机 / Blender / build123d）单独打成一个个 CommonJS 文件，可以不发完整版本单独更新（src/components.ts）。
// 同一份源码打出来的字节必须一模一样：build.mjs 打主程序时也用这里算一遍，记下「自带的是哪一版」（sha256），
// 组件发布（.github/workflows/mcp-components.yml）再打一遍比对——所以这里别放会随构建变化的东西（时间、路径、版本号）。
// 用法：node scripts/build-mcp.mjs [输出目录=dist/mcp]   → <名>.cjs + manifest.json
import { build } from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/** 组件名 → 入口模块和里面的启动函数（run(version)） */
export const COMPONENT_ENTRIES = {
  "bambu-printer": ["src/printer/mcp-server.ts", "runBambuMcp"],
  "blender": ["src/blender/mcp-server.ts", "runBlenderMcp"],
  "build123d": ["src/cad/mcp-server.ts", "runCadMcp"],
};

/** 打一个组件，返回字节 */
export async function buildComponent(name) {
  const [file, fn] = COMPONENT_ENTRIES[name];
  const r = await build({
    stdin: { contents: `export { ${fn} as run } from ${JSON.stringify("./" + file)};`, resolveDir: root, sourcefile: `component-${name}.ts`, loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", target: "node22",
    // 去掉注释（esbuild 会在注释里写源文件路径，不同机器上不一样），变量名保留（出错时堆栈看得懂）
    minifyWhitespace: true, legalComments: "none", logLevel: "warning",
  });
  return Buffer.from(r.outputFiles[0].contents);
}

/** 全部组件：{ 名: { sha256, size, bytes } } */
export async function buildComponents() {
  const out = {};
  for (const name of Object.keys(COMPONENT_ENTRIES)) {
    const bytes = await buildComponent(name);
    out[name] = { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length, bytes };
  }
  return out;
}

/** 这份源码的时间（最后一次提交的时间，秒）：新旧只按它比；不在 git 里 = 0 */
export function sourceStamp() {
  if (process.env.KAGURA_COMPONENT_STAMP) return Number(process.env.KAGURA_COMPONENT_STAMP);
  try { return Number(execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) || 0; } catch { return 0; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(process.argv[2] || path.join(root, "dist", "mcp"));
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = sourceStamp();
  const all = await buildComponents();
  const manifest = { format: 1, stamp, components: {} };
  for (const [name, c] of Object.entries(all)) {
    fs.writeFileSync(path.join(outDir, `${name}.cjs`), c.bytes);
    manifest.components[name] = { file: `${name}.cjs`, sha256: c.sha256, size: c.size, stamp };
    console.log(`  ${name}.cjs  ${(c.size / 1024).toFixed(0)}KB  ${c.sha256.slice(0, 12)}`);
  }
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`组件 → ${outDir}（源码时间 ${stamp ? new Date(stamp * 1000).toISOString() : "未知"}）`);
}
