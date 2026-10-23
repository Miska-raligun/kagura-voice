// 语音服务商（voice/hub.ts）：本地假服务器模拟 OpenAI 兼容 / MiniMax / 百度接口。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpeechHub, parseSpeechConfig, toPcm16k } from "../src/voice/hub.ts";
import { wavHeader } from "../src/util/wav.ts";

let server: http.Server, base = "";
const seen: { path: string; body: Buffer; auth: string }[] = [];
let failOpenai = false;

/** 24k 单声道 16 位 WAV：n 个样本 */
function wav24k(n: number) {
  const h = wavHeader(n * 2, 24000);
  const d = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) d.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  return Buffer.concat([h, d]);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url!, "http://x");
      seen.push({ path: u.pathname, body, auth: String(req.headers.authorization ?? "") });
      if (u.pathname === "/v1/audio/speech") {
        if (failOpenai) { res.statusCode = 500; res.end("boom"); return; }
        res.setHeader("content-type", "audio/wav"); res.end(wav24k(2400));
      } else if (u.pathname === "/v1/audio/transcriptions") {
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: " 你好呀 " }));
      } else if (u.pathname === "/mm/t2a_v2") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: { audio: Buffer.alloc(3200, 2).toString("hex") }, base_resp: { status_code: 0 } }));
      } else if (u.pathname === "/token") res.end(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      else if (u.pathname === "/tts") { res.setHeader("content-type", "audio/basic"); res.end(Buffer.alloc(1600, 1)); }
      else { res.statusCode = 404; res.end(); }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

const mk = (raw: any) => new SpeechHub({ asrKey: "a", asrSecret: "b", ttsKey: "c", ttsSecret: "d" }, fs.mkdtempSync(path.join(os.tmpdir(), "sp-")),
  parseSpeechConfig(raw), { token: base + "/token", asr: base + "/asr", tts: base + "/tts" });
const providers = () => [
  { id: "vs", kind: "openai", base_url: `${base}/v1/`, api_key: "k1", model: "omnivoice", voice: "def", asr_model: "whisper-1" },
  { id: "mm", kind: "minimax", base_url: `${base}/mm`, api_key: "k2", model: "speech-02-turbo", voice: "female-shaonv" },
];

describe("语音服务商配置", () => {
  it("没写 speech 就只有百度；缺百度自动补上；指向不存在的服务商回落第一家", () => {
    expect(parseSpeechConfig(undefined)).toEqual({ asr: "baidu", tts: "baidu", providers: [{ id: "baidu", kind: "baidu", name: "百度" }] });
    const c = parseSpeechConfig({ asr: "nope", tts: "vs", providers: [{ id: "vs", kind: "openai" }, { id: "x", kind: "weird" }] });
    expect(c.providers.map((p) => p.id)).toEqual(["baidu", "vs"]);
    expect(c.asr).toBe("baidu");
    expect(c.tts).toBe("vs");
  });
});

describe("合成", () => {
  it("OpenAI 兼容：请求格式正确，24k WAV 转成 16k；agent 指定的音色只给它所属的服务商", async () => {
    const hub = mk({ tts: "baidu", providers: providers() });
    const p = (await hub.synthesize("你好", { per: 4, provider: "vs", voice: "mio-clone" }))!;
    const req = JSON.parse(seen.filter((s) => s.path === "/v1/audio/speech").at(-1)!.body.toString());
    expect(req).toMatchObject({ model: "omnivoice", voice: "mio-clone", input: "你好", response_format: "wav" });
    expect(seen.at(-1)!.auth).toBe("Bearer k1");
    const out = fs.readFileSync(p);
    expect(out.readUInt32LE(24)).toBe(16000);
    expect(out.length - 44).toBe(Math.floor(2400 * 16000 / 24000) * 2);
    // 同一句再来一次走缓存
    const n = seen.length;
    expect(await hub.synthesize("你好", { per: 4, provider: "vs", voice: "mio-clone" })).toBe(p);
    expect(seen.length).toBe(n);
  });

  it("MiniMax：voice_id、16k pcm、hex 解码", async () => {
    const hub = mk({ tts: "mm", providers: providers() });
    const p = (await hub.synthesize("早上好", { per: 111 }))!;
    const req = JSON.parse(seen.filter((s) => s.path === "/mm/t2a_v2").at(-1)!.body.toString());
    expect(req).toMatchObject({ model: "speech-02-turbo", text: "早上好", voice_setting: { voice_id: "female-shaonv" }, audio_setting: { sample_rate: 16000, format: "pcm", channel: 1 } });
    expect(fs.statSync(p).size).toBe(44 + 3200);
  });

  it("指定的服务商失败时退回默认服务商（百度用 per）", async () => {
    failOpenai = true;
    try {
      const hub = mk({ tts: "baidu", providers: providers() });
      const p = (await hub.synthesize("退回", { per: 4, provider: "vs", voice: "x" }))!;
      expect(fs.statSync(p).size).toBe(44 + 1600);
      expect(seen.some((s) => s.path === "/tts" && s.body.toString().includes("per=4"))).toBe(true);
    } finally { failOpenai = false; }
  });

  it("默认服务商本身失败就报错（不吞）", async () => {
    failOpenai = true;
    try { await expect(mk({ tts: "vs", providers: providers() }).synthesize("x")).rejects.toThrow(/HTTP 500/); }
    finally { failOpenai = false; }
  });
});

describe("识别", () => {
  it("OpenAI 兼容：multipart 上传、去首尾空白", async () => {
    const hub = mk({ asr: "vs", providers: providers() });
    expect(await hub.transcribe(wavHeader(0))).toBe("你好呀");
    const r = seen.filter((s) => s.path === "/v1/audio/transcriptions").at(-1)!;
    expect(r.body.toString()).toContain('name="model"');
    expect(r.body.toString()).toContain("whisper-1");
  });
});

describe("toPcm16k", () => {
  it("立体声 48k 浮点 → 16k 单声道 16 位；长度占位值为 0 的流式 WAV 读到文件尾", () => {
    const n = 4800;
    const d = Buffer.alloc(n * 2 * 4);
    for (let i = 0; i < n; i++) { d.writeFloatLE(0.5, i * 8); d.writeFloatLE(0.5, i * 8 + 4); }
    const h = wavHeader(0, 48000, 2, 32);
    h.writeUInt16LE(3, 20);                        // IEEE float
    const out = toPcm16k(Buffer.concat([h, d]));
    expect(out.length).toBe(1600 * 2);
    expect(Math.abs(out.readInt16LE(800) - 16383)).toBeLessThan(3);
  });
});
