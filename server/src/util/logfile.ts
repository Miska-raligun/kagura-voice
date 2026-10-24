// 日志落盘：控制台照常输出，同时追加到 <数据目录>/logs/kagura.log（按大小滚动）。
// 以前只有控制台，托盘/无窗口启动后什么都看不到，排障只能靠重定向。
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

let stream: fs.WriteStream | null = null;
let logPath = "";
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
    logPath = file;
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

/**
 * 进程要死了：同步写一行（异步流里排队的日志来不及落盘）。
 * 托盘版没有控制台，以前未捕获的异常会让进程无声消失、日志里一个字都没有（在线更新下载到一半就这样没了）。
 */
export function logFatal(tag: string, e: unknown) {
  const msg = `${new Date().toISOString()} ${tag} ${e instanceof Error ? e.stack || e.message : util.format(e)}\n`;
  try { process.stderr.write(msg); } catch { /* 没有控制台 */ }
  if (logPath) { try { fs.appendFileSync(logPath, msg); } catch { /* 写不了就算了 */ } }
}

/** 未捕获的异常记下来再退出（Node 默认行为，只是不再无声无息）；未处理的 Promise 拒绝只记录、不让整个服务挂掉 */
export function installCrashLogging() {
  process.on("uncaughtException", (e) => { logFatal("[crash] 未捕获的异常，退出：", e); process.exit(1); });
  process.on("unhandledRejection", (e) => { logFatal("[crash] 未处理的 Promise 拒绝（已忽略，服务继续运行）：", e); });
}
