// 用 esbuild 把入口和全部依赖打成一个 CommonJS 文件（Node SEA 只认单个 CJS 脚本）。
// 用法：node scripts/build.mjs [入口=src/main.ts] [输出=dist/kagura.cjs]
import { build } from "esbuild";
const entry = process.argv[2] || "src/main.ts";
const outfile = process.argv[3] || "dist/kagura.cjs";
const r = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // CJS 产物里没有 import.meta.url，给一个等价实现
  define: { "import.meta.url": "__kagura_import_meta_url" },
  banner: { js: 'const __kagura_import_meta_url = require("url").pathToFileURL(__filename).href;' },
  logLevel: "warning",
  metafile: true,
  legalComments: "none",
});
const bytes = Object.values(r.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
console.log(`built ${outfile} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
