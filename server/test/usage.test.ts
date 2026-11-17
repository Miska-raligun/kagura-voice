// 用量按场景汇总：看哪个场景的前缀缓存没命中
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStore, usageScene } from "../src/agent/store.ts";

describe("用量按场景", () => {
  it("会话 key / 用途 → 场景", () => {
    expect(usageScene("chat", "main:main")).toBe("主会话");
    expect(usageScene("chat", "main:device:dev1")).toBe("设备");
    expect(usageScene("chat", "main:feishu:ou_x")).toBe("IM");
    expect(usageScene("heartbeat", "main:heartbeat")).toBe("heartbeat");
    expect(usageScene("chat", "main:cron:job1")).toBe("定时任务");
    expect(usageScene("task", "main:task:7")).toBe("待办");
    expect(usageScene("compact", "main:main")).toBe("压缩摘要");
    expect(usageScene("voice", "main:voice")).toBe("朗读兜底");
  });

  it("同一场景的会话合在一起，按输入量从大到小排；按天汇总带缓存写", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-usage-"));
    const s = new AgentStore(path.join(dir, "a.sqlite"));
    const u = (input: number, cacheRead: number, cacheWrite = 0) => ({ model: "p/m", input, output: 10, cacheRead, cacheWrite, cost: 0.01 });
    s.recordUsage("main:main", "chat", u(100, 900));
    s.recordUsage("main:main", "chat", u(200, 800, 50));
    s.recordUsage("main:feishu:a", "chat", u(500, 0));
    s.recordUsage("main:feishu:b", "chat", u(400, 0));
    s.recordUsage("main:main", "compact", u(50, 0));
    const scenes = s.usageByScene(1);
    expect(scenes.map((x) => x.scene)).toEqual(["主会话", "IM", "压缩摘要"]);
    expect(scenes[0]).toMatchObject({ calls: 2, input: 300, cache_read: 1700, cache_write: 50 });
    expect(scenes[1]).toMatchObject({ calls: 2, input: 900, cache_read: 0 });
    expect((s.usageByDay(1)[0] as any).cache_write).toBe(50);
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
