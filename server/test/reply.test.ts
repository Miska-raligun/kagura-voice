// 边生成边播 / 异步回复：首句早切、响应头的时机、「还在想」时带上她在干什么
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SentenceSplitter, endsSentence } from "../src/speech/sentences.ts";
import { PendingReply, toolActivity } from "../src/speech/async-reply.ts";
import { streamReply } from "../src/speech/stream-reply.ts";
import { wavHeader } from "../src/util/wav.ts";
import type { AgentStreamEvent } from "../src/agent/runtime.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-reply-"));
const wavFile = path.join(dir, "a.wav");
fs.writeFileSync(wavFile, Buffer.concat([wavHeader(320), Buffer.alloc(320)]));
const said: string[] = [];
const voice = { synthesize: async (t: string) => { said.push(t); return wavFile; } } as any;
const text = (h: string | null) => Buffer.from(h ?? "", "base64").toString("utf8");

let server: http.Server, base = "";
let handler: (res: http.ServerResponse, url: URL) => void = () => {};
beforeAll(async () => {
  server = http.createServer((req, res) => handler(res, new URL(req.url!, "http://x")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("切句", () => {
  it("第一句够长就在逗号处先切一段；后面的句子照旧只在句末切", () => {
    const s = new SentenceSplitter({ eagerFirst: true });
    expect(s.push("今天外面天气挺不错的，适合出去走")).toEqual(["今天外面天气挺不错的，"]);
    expect(s.push("走。然后我们再看看晚上吃什么，要不要")).toEqual(["适合出去走走。"]);
    expect(s.flush()).toEqual(["然后我们再看看晚上吃什么，要不要"]);
  });
  it("短的第一句不拆；不开 eagerFirst 行为不变", () => {
    expect(new SentenceSplitter({ eagerFirst: true }).push("好的，我看看")).toEqual([]);
    expect(new SentenceSplitter().push("今天外面天气挺不错的，适合出去走")).toEqual([]);
  });
  it("endsSentence：句末标点（带引号）算，逗号不算", () => {
    expect(endsSentence("好的。")).toBe(true);
    expect(endsSentence("他说“好！”")).toBe(true);
    expect(endsSentence("我看看桌上，")).toBe(false);
  });
});

describe("工具 → 屏幕上的一句话", () => {
  it("内置工具有专门的说法，MCP 工具说服务器名，其它兜底", () => {
    expect(toolActivity("web_search")).toBe("在搜网页");
    expect(toolActivity("exec")).toBe("在跑命令");
    expect(toolActivity("mcp__bambu-printer__printer_status")).toBe("在用 bambu-printer");
    expect(toolActivity("whatever")).toBe("在用工具");
  });
});

describe("异步回复", () => {
  it("还在想的时候带上她在干什么；工具换了就提前回一次", async () => {
    let emit!: (e: AgentStreamEvent) => void, finish!: (t: string) => void;
    const p = new PendingReply({ dev: "d", userText: "u", voice, per: 0, headers: {},
      run: (on) => { emit = on; return new Promise((r) => { finish = r; }); } });
    handler = (res, url) => void p.serve(res, Number(url.searchParams.get("wait")) * 1000);
    emit({ type: "tool_start", name: "web_search", args: {} });
    const r1 = await fetch(`${base}/?wait=0`);
    expect(r1.status).toBe(204);
    expect(r1.headers.get("x-reply-wait")).toBe("1");
    expect(text(r1.headers.get("x-reply-status"))).toBe("在搜网页");
    // 状态没变：等到点才回；变了：约 1.5 秒就回，不等满
    const t0 = Date.now();
    const pending = fetch(`${base}/?wait=20`);
    setTimeout(() => emit({ type: "tool_start", name: "exec", args: {} }), 100);
    const r2 = await pending;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(text(r2.headers.get("x-reply-status"))).toBe("在跑命令");
    emit({ type: "tool_end", name: "exec" });
    finish("");
    const r3 = await fetch(`${base}/?wait=1`);
    expect(r3.headers.get("x-reply-done")).toBe("1");
    expect(r3.headers.get("x-reply-status")).toBeNull();
  });

  it("首句在逗号处先切去合成，但响应头等整句说完再决定：后面跟着 take_photo 时 X-Need-Photo 不丢", async () => {
    said.length = 0;
    let emit!: (e: AgentStreamEvent) => void, finish!: (t: string) => void, meta!: any;
    const p = new PendingReply({ dev: "d", userText: "u", voice, per: 0, headers: {},
      run: (on, m) => { emit = on; meta = m; return new Promise((r) => { finish = r; }); } });
    handler = (res, url) => void p.serve(res, Number(url.searchParams.get("wait")) * 1000);
    emit({ type: "text", delta: "我看看桌上都放了些什么东西，稍" });
    expect(said).toEqual(["我看看桌上都放了些什么东西，"]);            // 半句已经在合成了
    emit({ type: "text", delta: "等一下。" });
    const early = await fetch(`${base}/?wait=0`);
    expect(early.status).toBe(204);                                      // 整句刚说完、后面是什么还不知道：先不发头
    emit({ type: "message_end", toolCalls: 1, toolNames: ["take_photo"] });
    meta.needPhoto = true;
    emit({ type: "tool_end", name: "take_photo" });
    finish("我看看桌上都放了些什么东西，稍等一下。");
    const r = await fetch(`${base}/?wait=1`);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-need-photo")).toBe("1");
    expect(text(r.headers.get("x-reply-text"))).toBe("我看看桌上都放了些什么东西，稍等一下。");
    await r.arrayBuffer();
  });
});

describe("边生成边播（同步）", () => {
  it("首句半句先合成；整句说完又来了字才发头，屏显带上已经切出来的全部", async () => {
    said.length = 0;
    let emit!: (e: AgentStreamEvent) => void, finish!: (t: string) => void;
    handler = (res) => void streamReply(res, { voice, per: 0, userText: "u", headers: {},
      run: (on) => { emit = on; return new Promise((r) => { finish = r; }); } });
    const pending = fetch(`${base}/`);
    await new Promise((r) => setTimeout(r, 50));
    emit({ type: "text", delta: "今天外面天气挺不错的，适合出去走" });
    emit({ type: "text", delta: "走。然后" });
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.headers.get("x-reply-partial")).toBe("1");
    expect(text(r.headers.get("x-reply-text"))).toBe("今天外面天气挺不错的，适合出去走走。");
    finish("今天外面天气挺不错的，适合出去走走。然后");
    await r.arrayBuffer();
    expect(said.slice(0, 2)).toEqual(["今天外面天气挺不错的，", "适合出去走走。"]);
  });
});
