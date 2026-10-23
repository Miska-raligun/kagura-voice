// 用 esbuild 把入口和全部依赖打成一个 CommonJS 文件（Node SEA 只认单个 CJS 脚本）。
// 管理界面（admin-ui/，Preact）先单独编译成浏览器 JS，再作为虚拟模块 virtual:admin-ui 内联进产物。
// 用法：node scripts/build.mjs [入口=src/main.ts] [输出=dist/kagura.cjs]
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = process.argv[2] || "src/main.ts";
const outfile = process.argv[3] || "dist/kagura.cjs";

/** 编译管理界面，返回 { js, css } 字符串 */
export async function buildAdminUi() {
  const ui = path.join(here, "..", "admin-ui");
  const r = await build({
    entryPoints: [path.join(ui, "main.tsx")], bundle: true, write: false, format: "esm", platform: "browser",
    target: ["chrome100", "safari15", "firefox100"], minify: true, jsx: "automatic", jsxImportSource: "preact",
    legalComments: "none", logLevel: "warning",
  });
  return { js: r.outputFiles[0].text, css: fs.readFileSync(path.join(ui, "style.css"), "utf8") };
}

const adminUi = {
  name: "admin-ui",
  setup(b) {
    b.onResolve({ filter: /^virtual:admin-ui$/ }, () => ({ path: "admin-ui", namespace: "virtual" }));
    b.onLoad({ filter: /.*/, namespace: "virtual" }, async () => {
      const { js, css } = await buildAdminUi();
      return { contents: `export const js = ${JSON.stringify(js)}; export const css = ${JSON.stringify(css)};`, loader: "js" };
    });
  },
};

// 设备固件：device/src/*.py 原样打进产物，管理界面「设备文件」把它下发给设备（版本 = 服务端版本）
const deviceFw = {
  name: "device-fw",
  setup(b) {
    b.onResolve({ filter: /^virtual:device-fw$/ }, () => ({ path: "device-fw", namespace: "virtual-fw" }));
    b.onLoad({ filter: /.*/, namespace: "virtual-fw" }, () => {
      const src = path.join(here, "..", "..", "device", "src");
      const files = {};
      for (const f of fs.readdirSync(src).filter((n) => n.endsWith(".py")).sort()) {
        files[`src/${f}`] = fs.readFileSync(path.join(src, f)).toString("base64");
      }
      return { contents: `export const files = ${JSON.stringify(files)};`, loader: "js", watchFiles: Object.keys(files).map((k) => path.join(src, k.slice(4))) };
    });
  },
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    // CJS 产物里没有 import.meta.url，给一个等价实现
    define: {
      "import.meta.url": "__kagura_import_meta_url",
      // 版本号：发布时由 release.yml 从 tag 传入（KAGURA_VERSION=1.2.3），否则用 package.json 的
      __KAGURA_VERSION__: JSON.stringify(process.env.KAGURA_VERSION || JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version),
    },
    banner: { js: 'const __kagura_import_meta_url = require("url").pathToFileURL(__filename).href;' },
    logLevel: "warning",
    metafile: true,
    legalComments: "none",
    loader: { ".html": "text" },      // web/monitor.html 内联进产物，单文件可执行里没有 web/ 目录
    plugins: [adminUi, deviceFw],
  });
  const bytes = Object.values(r.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
  console.log(`built ${outfile} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}
