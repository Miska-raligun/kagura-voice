// 发给服务商的请求体长什么样（LRN 2026-11-07，症状「她说正文消息是空的，然后从记忆里找到了我发的话」）：
// 一轮的用户消息是几段拼的，必须合成一段再发，主人说的话放最后、和系统附的参考明确隔开
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { tmpdir } from "./helpers.ts";
import { AgentRegistry } from "../src/agent/registry.ts";
import { ModelRegistry } from "../src/agent/models.ts";
import { Runtime, flattenUser, MSG_DIVIDER, RECALL_TAG, TURN_NOTE_TAG } from "../src/agent/runtime.ts";

async function withServer(fn: (port: number, bodies: any[]) => Promise<void>) {
  const bodies: any[] = [];
  const srv = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (o: any) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`);
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "收到" }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try { await fn((srv.address() as any).port, bodies); } finally { srv.close(); }
}

describe("发给服务商的用户消息", () => {
  it("几段（时间、自动回忆、系统备注、主人的话）合成一段：主人的话在最后、前面有分隔句；库里照旧分段、回忆和备注不落盘", async () => {
    await withServer(async (port, bodies) => {
      const root = tmpdir();
      fs.mkdirSync(path.join(root, "agents"));
      const reg = new AgentRegistry(path.join(root, "agents"));
      reg.load([{ id: "", name: "神乐", agent: "main", per: 111 }]);
      const models = new ModelRegistry({ providers: [{ id: "mm", api: "openai-completions", base_url: `http://127.0.0.1:${port}/v1`, api_key: "k", models: [{ id: "m" }] }], default: "mm/m", cheap: "" } as any);
      const rt = new Runtime(reg, models, { maxConcurrency: 2, timeoutSecs: 10 });
      rt.backgroundCompact = false;
      rt.recall = async () => [{ line: "MEMORY.md#L3：主人的车牌是沪A12345", why: "车牌" }];
      rt.turnNotes.push(() => "- 后台命令 bg1（已跑 3 分钟）：npm run build");
      const r = await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "webchat", text: "我的车牌是多少" });
      expect(r.text).toBe("收到");
      const user = bodies[0].messages.filter((m: any) => m.role === "user").at(-1);
      const parts = Array.isArray(user.content) ? user.content : [{ type: "text", text: user.content }];
      expect(parts.length).toBe(1);
      const text: string = parts[0].text;
      expect(text).toMatch(/^\[时间 /);
      expect(text).toContain(RECALL_TAG);
      expect(text).toContain(TURN_NOTE_TAG);
      expect(text.endsWith(`${MSG_DIVIDER}\n\n我的车牌是多少`)).toBe(true);
      const saved = rt.store("main").history("main:main")[0].msg as any;
      expect(saved.content.map((c: any) => c.text).at(-1)).toBe("我的车牌是多少");
      expect(JSON.stringify(saved)).not.toContain(RECALL_TAG);
      expect(JSON.stringify(saved)).not.toContain(TURN_NOTE_TAG);
      rt.close();
    });
  });

  it("只有时间和主人的话：合成一段、不加分隔句；图片照常放前面；只有一段的不动", () => {
    const img = { type: "image", data: "AAAA", mimeType: "image/jpeg" };
    const [a, b, c] = flattenUser([
      { role: "user", content: [{ type: "text", text: "[时间 2026-11-07 09:00 周六]" }, { type: "text", text: "早" }] },
      { role: "user", content: [{ type: "text", text: "[时间 …]" }, img, { type: "text", text: "这是什么" }] },
      { role: "user", content: [{ type: "text", text: "只有一段" }] },
    ] as any[]);
    expect(a.content).toEqual([{ type: "text", text: "[时间 2026-11-07 09:00 周六]\n\n早" }]);
    expect(b.content).toEqual([img, { type: "text", text: "[时间 …]\n\n这是什么" }]);
    expect(c.content).toEqual([{ type: "text", text: "只有一段" }]);
  });
});
