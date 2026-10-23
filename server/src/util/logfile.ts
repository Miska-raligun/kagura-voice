// 日志落盘：控制台照常输出，同时追加到 <数据目录>/logs/kagura.log（按大小滚动）。
// 以前只有控制台，托盘/无窗口启动后什么都看不到，排障只能靠重定向。
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

let stream: fs.WriteStream | null = null;
let maxBytes = 5 * 1024 * 1024;
let keep = 3;

function rotate(dir: string, file: string) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes) return;
    for (let i = keep - 1; i >= 1; i--) {
      const from = path.join(dir, `kagura.${i}.log`);
      const to = path.join(dir, `kagura.${i + 1}.log`);
      if (fs.existsSync(from)) {
        if (fs.existsSync(to)) fs.rmSync(to, { force: true });
        fs.renameSync(from, to);
      }
    }
    const first = path.join(dir, "kagura.1.log");
    if (fs.existsSync(first)) fs.rmSync(first, { force: true });
    fs.renameSync(file, first);
  } catch { /* 滚动失败就算了，别挡住启动 */ }
}

/** 开始写日志文件；重复调用只生效一次 */
export function initLogFile(dataDir: string, opts: { maxBytes?: number; keep?: number } = {}) {
  if (stream) return;
  maxBytes = opts.maxBytes ?? maxBytes;
  keep = opts.keep ?? keep;
  const dir = path.join(dataDir, "logs");
  const file = path.join(dir, "kagura.log");
  try {
    fs.mkdirSync(dir, { recursive: true });
    rotate(dir, file);
    stream = fs.createWriteStream(file, { flags: "a" });
    stream.on("error", () => { stream = null; });
  } catch { return; }

  const line = (tag: string, args: unknown[]) => {
    if (!stream) return;
    const t = new Date();
    const ts = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")} `
      + `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    try { stream.write(`${ts}${tag} ${util.format(...(args as any[]))}\n`); } catch { /* 忽略 */ }
  };

  // 保留原行为（控制台照常），再复制一份到文件
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  console.log = (...a: any[]) => { orig.log(...a); line("", a); };
  console.info = (...a: any[]) => { orig.info(...a); line("", a); };
  console.warn = (...a: any[]) => { orig.warn(...a); line(" WARN", a); };
  console.error = (...a: any[]) => { orig.error(...a); line(" ERROR", a); };
  console.debug = (...a: any[]) => { orig.debug(...a); line(" DEBUG", a); };
  process.on("exit", () => { try { stream?.end(); } catch { /* 已关 */ } });
}
