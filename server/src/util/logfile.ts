// 日志落盘：控制台照常输出，同时追加到 <数据目录>/logs/kagura.log（按大小滚动）。
// 以前只有控制台，托盘/无窗口启动后什么都看不到，排障只能靠重定向。
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import v8 from "node:v8";

// 同步写（fs.writeSync）：以前用写入流，进程被强行结束 / 原生崩溃时缓冲里排着的最后几行来不及落盘，日志就停在「出事之前好一阵」，
// 看起来像「什么都没记」。日志量不大，同步写的代价可以忽略
let fd: number | null = null;
let logPath = "";
let logDir = "";
let written = 0;
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
  if (fd !== null) return;
  maxBytes = opts.maxBytes ?? maxBytes;
  keep = opts.keep ?? keep;
  const dir = path.join(dataDir, "logs");
  const file = path.join(dir, "kagura.log");
  try {
    fs.mkdirSync(dir, { recursive: true });
    rotate(dir, file);
    logPath = file;
    logDir = dir;
    fd = fs.openSync(file, "a");
    written = fs.fstatSync(fd).size;
  } catch { return; }

  const line = (tag: string, args: unknown[]) => {
    if (fd === null) return;
    const t = new Date();
    const ts = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")} `
      + `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    try {
      const buf = Buffer.from(`${ts}${tag} ${util.format(...(args as any[]))}\n`);
      fs.writeSync(fd, buf);
      written += buf.length;
      // 运行中也滚动（以前只在启动时滚，常年不重启的话一个文件越长越大）
      if (written > maxBytes) { fs.closeSync(fd); rotate(logDir, logPath); fd = fs.openSync(logPath, "a"); written = 0; }
    } catch { /* 忽略 */ }
  };

  // 保留原行为（控制台照常），再复制一份到文件
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  console.log = (...a: any[]) => { orig.log(...a); line("", a); };
  console.info = (...a: any[]) => { orig.info(...a); line("", a); };
  console.warn = (...a: any[]) => { orig.warn(...a); line(" WARN", a); };
  console.error = (...a: any[]) => { orig.error(...a); line(" ERROR", a); };
  console.debug = (...a: any[]) => { orig.debug(...a); line(" DEBUG", a); };
  process.on("exit", () => { try { if (fd !== null) fs.closeSync(fd); } catch { /* 已关 */ } fd = null; });
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

/** 正常退出时为什么退（gracefulExit 设）：退出那一行里带上，和「被强行结束」区分开 */
let exitReason = "";
export function setExitReason(r: string) { if (!exitReason) exitReason = r; }

/**
 * 进程死因尽量留痕（LRN 2026-10-31，症状「服务端运行中无声退出，日志里一个字都没有」）：
 * ① 未捕获的异常记下来再退出（Node 默认行为，只是不再无声无息）；未处理的 Promise 拒绝只记录、不让整个服务挂掉；
 * ② 每次退出都同步写一行 [exit] code=…（原因）——日志末尾**没有这行** = 被外部强行结束（任务管理器 / taskkill / 安装包 / 杀毒软件）、
 *    原生崩溃或内存耗尽，Node 自己来不及做任何事；
 * ③ 内存耗尽等 V8 致命错误写一份诊断报告 logs/report.*.json；每 30 分钟记一行内存，涨到堆上限七成时报警；
 * ④ 关控制台窗口（SIGHUP）、Ctrl+Break（SIGBREAK）也记一行再走正常退出；
 * ⑤ 开机时看上次留下的 running 标记：还在 = 上次不是正常退出，记一行，带上它最后活着的时刻。
 */
export function installCrashLogging(onSignal?: (sig: string) => void) {
  process.on("uncaughtException", (e) => { setExitReason("未捕获的异常"); logFatal("[crash] 未捕获的异常，退出：", e); process.exit(1); });
  process.on("unhandledRejection", (e) => { logFatal("[crash] 未处理的 Promise 拒绝（已忽略，服务继续运行）：", e); });
  process.on("exit", (code) => { logFatal(`[exit] 进程退出 code=${code}${exitReason ? `（${exitReason}）` : ""}`, ""); clearMark(); });
  for (const sig of ["SIGHUP", "SIGBREAK"] as const) {
    try { process.on(sig, () => { setExitReason(`收到 ${sig}${sig === "SIGHUP" ? "（控制台窗口被关掉 / 终端断开）" : ""}`); logFatal(`[main] 收到 ${sig}，正在退出`, ""); onSignal?.(sig); }); }
    catch { /* 这个平台没有这个信号 */ }
  }
  if (logDir) {
    try { process.report.directory = logDir; process.report.reportOnFatalError = true; } catch { /* 老版本 Node */ }
    checkLastRun();
  }
  const mb = (n: number) => Math.round(n / 1048576);
  let warned = false;
  setInterval(() => {
    const m = process.memoryUsage();
    const limit = v8.getHeapStatistics().heap_size_limit;
    const high = m.heapUsed > limit * 0.7;
    console.log(`[mem] ${high ? "⚠️ " : ""}rss ${mb(m.rss)}MB · 堆 ${mb(m.heapUsed)}/${mb(limit)}MB · 外部 ${mb(m.external + m.arrayBuffers)}MB`);
    if (high && !warned) { warned = true; console.log("[mem] ⚠️  堆内存快到上限了，再涨下去进程会被系统结束（日志里会没有 [exit] 那一行）"); }
  }, 30 * 60_000).unref();
}

/** 当前日志文件（管理界面「日志」页读它） */
export const logFilePath = () => logPath;

/** 开机时发现上次没有正常退出（给运行状况记一条） */
export let uncleanLastRun: { pid: string; started: number; lastLog: string } | null = null;

// 「正在运行」标记：正常退出时删掉。开机时还在 = 上次是被强行结束 / 崩溃 / 断电
const markPath = () => (logDir ? path.join(logDir, "running.pid") : "");
function clearMark() { try { if (markPath()) fs.rmSync(markPath(), { force: true }); } catch { /* 删不了就算了 */ } }
function checkLastRun() {
  const p = markPath();
  try {
    if (fs.existsSync(p)) {
      const [pid, since] = fs.readFileSync(p, "utf8").split(" ");
      let lastAlive = "";
      try { lastAlive = new Date(fs.statSync(logPath).mtimeMs).toLocaleString("zh-CN", { hour12: false }); } catch { /* 没有日志 */ }
      uncleanLastRun = { pid, started: since ? Number(since) : 0, lastLog: lastAlive };
      console.log(`[main] ⚠️  上次运行（pid ${pid}，${since ? new Date(Number(since)).toLocaleString("zh-CN", { hour12: false }) : "?"} 启动）没有正常退出：被强行结束、崩溃或断电。`
        + `日志最后写入在 ${lastAlive || "?"}；logs/ 里有 report.*.json 就是内存耗尽或 V8 致命错误`);
    }
    fs.writeFileSync(p, `${process.pid} ${Date.now()}`);
  } catch { /* 写不了标记不影响运行 */ }
}
