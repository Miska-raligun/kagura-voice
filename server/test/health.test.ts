// 运行状况：每轮结果、兜底动作记进统计，按天汇总、列出最近异常
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { health, errorClass } from "../src/agent/health.ts";

afterEach(() => health.close());

describe("运行状况", () => {
  it("失败按类归", () => {
    expect(errorClass("429 Too Many Requests")).toBe("限流 429");
    expect(errorClass("模型连着两次返回了空回复")).toBe("空回复");
    expect(errorClass("已在管理界面终止")).toBe("被取消");
    expect(errorClass("fetch failed")).toBe("网络");
    expect(errorClass("503 Service Unavailable")).toBe("服务商出错");
  });

  it("每轮成功 / 失败、催说话都记下来，按天汇总，异常列表只列有问题的", async () => {
    health.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kh-")), "system.sqlite"));
    const { rt, fake } = makeRuntime();
    fake.queue.push("好的");
    await rt.run({ kind: "main", channel: "webchat", agentId: "main", sessionKey: "main:main", text: "x", trusted: true });
    fake.queue.push("", "说了");                       // 想完没说话 → 催一句
    await rt.run({ kind: "main", channel: "webchat", agentId: "main", sessionKey: "main:main", text: "y", trusted: true });
    fake.queue.push({ error: "429 rate limit exceeded" });
    await rt.run({ kind: "main", channel: "webchat", agentId: "main", sessionKey: "main:main", text: "z", trusted: true }).catch(() => {});
    const [today] = health.summary(1);
    expect(today.turns).toBe(3);
    expect(today.ok).toBe(2);
    expect(today.errors["限流 429"]).toBe(1);
    expect(today.events.nudge).toBe(1);
    const recent = health.recent(10);
    expect(recent.map((e: any) => e.kind)).toEqual(["turn", "nudge"]);
    expect(recent[0].detail.error).toBe("限流 429");
  });
});
