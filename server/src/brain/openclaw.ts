// OpenClaw 适配器：调 openclaw CLI（对应 voice_server.chat）。
// 每次调用起一个子进程：全局最多 2 个并发；同一 session 串行，
// 避免两台设备（或 /shake 后台任务与 /chat）同时写同一 session 文件。
import { spawn } from "node:child_process";
import { extractJson } from "../util/text.ts";
import type { Brain, ChatRequest } from "./types.ts";

class Semaphore {
  private queue: (() => void)[] = [];
  constructor(private n: number) {}
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise<void>((r) => this.queue.push(r));
  }
  release() { const next = this.queue.shift(); if (next) next(); else this.n++; }
}

export class OpenClawBrain implements Brain {
  readonly kind = "openclaw";
  private sem = new Semaphore(2);
  private sessionTails = new Map<string, Promise<unknown>>();
  /**
   * @param bin openclaw 可执行文件
   * @param wsl Windows 版服务端调 WSL 里的 OpenClaw：经 wsl.exe 执行，照片路径换成 WSL 里的路径
   */
  constructor(private bin: string, private wsl?: { distro: string; toAgentPath: (p: string) => string }) {}

  /** 实际执行的命令行（单测用） */
  command(args: string[]): [string, string[]] {
    return this.wsl ? ["wsl.exe", ["-d", this.wsl.distro, "-e", this.bin, ...args]] : [this.bin, args];
  }

  /** 同一 session 串行：排到前一个调用之后 */
  private serial<T>(sid: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionTails.get(sid) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.sessionTails.set(sid, run);
    run.finally(() => { if (this.sessionTails.get(sid) === run) this.sessionTails.delete(sid); }).catch(() => {});
    return run;
  }

  chat(req: ChatRequest): Promise<string> {
    let message = req.message;
    if (req.localTime) message = `[当前时间: ${req.localTime}] ${message}`;
    const img = req.imagePath && this.wsl ? this.wsl.toAgentPath(req.imagePath) : req.imagePath;
    if (img) message = `${message}\n\n[用户通过CoreS3摄像头拍了一张照片，保存在 ${img}，请识别这张图片来回答问题]`;
    const args = ["agent", "--agent", req.agent, "--message", message, "--session-id", req.sessionId, "--json", "--timeout", "120"];
    return this.serial(req.sessionId, async () => {
      await this.sem.acquire();
      try {
        const [bin, argv] = this.command(args);
        const { code, stdout, stderr } = await run(bin, argv, 130_000);
        if (code !== 0) {
          // stderr 开头常是无害的 state-migrations 警告，真实错误在末尾
          const err = stderr.replace(/\x1b\[[0-9;]*m/g, "");
          const lines = err.split(/\r?\n/).map((l) => l.trim()).filter((l) =>
            l && !l.includes("state-migrations") && !l.toLowerCase().includes("migration warnings") && !l.startsWith("- Left"));
          const detail = lines.length ? lines.slice(-3).join(" | ") : err.slice(-300);
          throw new Error(`openclaw 失败(rc=${code}): ${detail.slice(0, 500)}`);
        }
        const data = extractJson(stdout);
        if (data.status !== "ok") throw new Error(`agent 状态异常: ${data.status}`);
        return data.result.payloads[0].text as string;
      } finally {
        this.sem.release();
      }
    });
  }
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`openclaw 超时（${timeoutMs / 1000}s）`)); }, timeoutMs);
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}
