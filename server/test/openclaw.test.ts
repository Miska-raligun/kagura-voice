// OpenClaw 适配器：用一个假的 openclaw 可执行脚本验证参数、输出解析、报错、并发与会话串行。
// 契约测试里大脑是假的，这条路径只能在这里测。
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenClawBrain } from "../src/brain/openclaw.ts";

const posix = process.platform !== "win32";
let bin = "", logFile = "";

beforeAll(() => {
  if (!posix) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-openclaw-"));
  logFile = path.join(dir, "calls.log");
  bin = path.join(dir, "openclaw");
  // 按 --message 决定行为；每次调用记录开始/结束时刻，用来检查并发
  fs.writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2);
const get = (k) => a[a.indexOf(k) + 1];
const msg = get("--message"), sid = get("--session-id"), agent = get("--agent");
const fs = require("fs");
const t0 = Date.now();
const done = () => fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ msg, sid, agent, t0, t1: Date.now(), args: a }) + "\\n");
if (msg.includes("FAIL")) { process.stderr.write("\\x1b[33m- state-migrations ok\\x1b[0m\\nError: gateway down\\n"); done(); process.exit(3); }
if (msg.includes("BADSTATUS")) { console.log(JSON.stringify({ status: "error" })); done(); process.exit(0); }
setTimeout(() => {
  console.log("\\x1b[32m[info]\\x1b[0m booting {not json}");
  console.log(JSON.stringify({ status: "ok", result: { payloads: [{ text: "回:" + msg }] } }));
  done();
}, msg.includes("SLOW") ? 300 : 10);
`, { mode: 0o755 });
});

const calls = () => fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe.runIf(posix)("OpenClaw 适配器", () => {
  it("参数与输出解析（含时间、照片注释）", async () => {
    const b = new OpenClawBrain(bin);
    const r = await b.chat({ message: "你好", sessionId: "s1", agent: "mio", localTime: "2026-05-15 14:23", imagePath: "/tmp/a.jpg" });
    expect(r.startsWith("回:[当前时间: 2026-05-15 14:23] 你好")).toBe(true);
    expect(r).toContain("保存在 /tmp/a.jpg");
    const c = calls().at(-1);
    expect(c.agent).toBe("mio");
    expect(c.sid).toBe("s1");
    expect(c.args).toEqual(expect.arrayContaining(["agent", "--json", "--timeout", "120"]));
  });

  it("非零退出：报错带上 stderr 里的真实错误、去掉迁移警告", async () => {
    const b = new OpenClawBrain(bin);
    await expect(b.chat({ message: "FAIL", sessionId: "s2", agent: "main" })).rejects.toThrow(/rc=3\): Error: gateway down$/);
  });

  it("status 不是 ok 也算失败", async () => {
    await expect(new OpenClawBrain(bin).chat({ message: "BADSTATUS", sessionId: "s3", agent: "main" })).rejects.toThrow(/状态异常/);
  });

  it("全局最多 2 个并发；同一会话串行", async () => {
    fs.writeFileSync(logFile, "");
    const b = new OpenClawBrain(bin);
    await Promise.all([
      b.chat({ message: "SLOW-a1", sessionId: "A", agent: "main" }),
      b.chat({ message: "SLOW-a2", sessionId: "A", agent: "main" }),
      b.chat({ message: "SLOW-b", sessionId: "B", agent: "main" }),
      b.chat({ message: "SLOW-c", sessionId: "C", agent: "main" }),
    ]);
    const cs = calls();
    // 任意时刻同时在跑的进程不超过 2 个
    for (const c of cs) expect(cs.filter((o) => o.t0 < c.t1 && c.t0 < o.t1).length).toBeLessThanOrEqual(2);
    // 同一会话的两次调用不重叠，且按提交顺序
    const [a1, a2] = ["SLOW-a1", "SLOW-a2"].map((m) => cs.find((c) => c.msg === m));
    expect(a2.t0).toBeGreaterThanOrEqual(a1.t1);
  });

  it("前一个失败不影响同会话后面的调用", async () => {
    const b = new OpenClawBrain(bin);
    const p1 = b.chat({ message: "FAIL", sessionId: "D", agent: "main" }).catch(() => "failed");
    const p2 = b.chat({ message: "ok", sessionId: "D", agent: "main" });
    expect(await p1).toBe("failed");
    expect(await p2).toBe("回:ok");
  });
});
