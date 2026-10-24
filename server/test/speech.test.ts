// 语音服务商（voice/hub.ts）：本地假服务器模拟 OpenAI 兼容 / MiniMax / 百度接口。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpeechHub, parseSpeechConfig, toPcm16k, minimaxClone, minimaxActivate, minimaxListCloned } from "../src/voice/hub.ts";
import { ClonedVoices, CLONE_EXPIRE_MS } from "../src/voice/minimax-voices.ts";
import { wavHeader, normalizeLoudness, LOUDNESS_TARGET_RMS } from "../src/util/wav.ts";

let server: http.Server, base = "";
const seen: { path: string; body: Buffer; auth: string }[] = [];
let failOpenai = false;
let mmLang = "";

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
      } else if (u.pathname === "/mm/speech_to_text") {
        mmLang = String(req.headers.language ?? "");
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: "开灯。 ", duration: 1.2, trace_id: "t" }));
      } else if (u.pathname === "/mm/files/upload") {
        const purpose = /name="purpose"\r\n\r\n(\w+)/.exec(body.toString("latin1"))?.[1];
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ file: { file_id: purpose === "voice_clone" ? 111 : 222, purpose }, base_resp: { status_code: 0, status_msg: "success" } }));
      } else if (u.pathname === "/mm/voice_clone") {
        const j = JSON.parse(body.toString());
        res.setHeader("content-type", "application/json");
        if (j.voice_id === "Taken_voice1") { res.end(JSON.stringify({ base_resp: { status_code: 2039, status_msg: "voice id duplicate" } })); return; }
        res.end(JSON.stringify({ input_sensitive: { type: j.voice_id === "Bad_voice01" ? 5 : 0 }, demo_audio: j.text ? "https://cdn/demo.mp3" : "", base_resp: { status_code: 0 } }));
      } else if (u.pathname === "/mmpoor/t2a_v2") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } }));
      } else if (u.pathname === "/mmpoor/speech_to_text") {
        res.statusCode = 402; res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ type: "error", error: { type: "insufficient_balance_error", message: "insufficient balance (1008)", http_code: "402" } }));
      } else if (u.pathname === "/mm/get_voice") {
        res.setHeader("content-type", "application/json");
        if (String(req.headers.authorization) === "Bearer plan") { res.end(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "no" } })); return; }
        res.end(JSON.stringify({ voice_cloning: [{ voice_id: "Mio_voice01", created_time: "2026-10-20" }, { voice_id: "Old_voice01", created_time: "2026-01-02" }], base_resp: { status_code: 0 } }));
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

describe("识别（MiniMax）", () => {
  it("speech_to_text：multipart 带 asr-1.0、language: zh 头、Bearer key", async () => {
    const hub = mk({ asr: "mm", providers: providers() });
    expect(await hub.transcribe(wavHeader(0))).toBe("开灯。");
    const r = seen.filter((s) => s.path === "/mm/speech_to_text").at(-1)!;
    expect(r.body.toString()).toContain('name="model"');
    expect(r.body.toString()).toContain("asr-1.0");
    expect(r.body.toString()).toContain('filename="audio.wav"');
    expect(r.auth).toBe("Bearer k2");
    expect(mmLang).toBe("zh");
  });
});

describe("音色复刻（MiniMax）", () => {
  const mm = () => providers()[1] as any;
  const wav = { data: Buffer.alloc(100, 1), filename: "me.wav" };
  it("上传 → 复刻：file_id 是数字、示例音频与逐字稿一起带上、试听用服务商的模型", async () => {
    const r = await minimaxClone(mm(), { voice_id: "Kagura_mio1", audio: wav, prompt: { audio: wav, text: "示例" }, preview_text: "你好", noise_reduction: true });
    expect(r).toEqual({ voice_id: "Kagura_mio1", demo_audio: "https://cdn/demo.mp3", sensitive: 0 });
    const ups = seen.filter((s) => s.path === "/mm/files/upload").slice(-2).map((s) => s.body.toString("latin1"));
    expect(ups[0]).toContain("voice_clone");
    expect(ups[1]).toContain("prompt_audio");
    const req = JSON.parse(seen.filter((s) => s.path === "/mm/voice_clone").at(-1)!.body.toString());
    expect(req).toEqual({ file_id: 111, voice_id: "Kagura_mio1", need_noise_reduction: true, need_volume_normalization: false,
      clone_prompt: { prompt_audio: 222, prompt_text: "示例" }, text: "你好", model: "speech-02-turbo" });
    expect(seen.at(-1)!.auth).toBe("Bearer k2");
  });
  it("voice_id 不合规在本地就拦下；重名、风控如实报错", async () => {
    const n = seen.length;
    for (const id of ["short1", "1abcdefgh", "abcdefgh_", "abc defgh"]) await expect(minimaxClone(mm(), { voice_id: id, audio: wav })).rejects.toThrow(/voice_id/);
    expect(seen.length).toBe(n);
    await expect(minimaxClone(mm(), { voice_id: "Taken_voice1", audio: wav })).rejects.toThrow(/2039/);
    await expect(minimaxClone(mm(), { voice_id: "Bad_voice01", audio: wav })).rejects.toThrow(/风控.*谩骂/);
    await expect(minimaxClone({ ...mm(), api_key: "" }, { voice_id: "Kagura_mio1", audio: wav })).rejects.toThrow(/API Key/);
  });
});

describe("MiniMax 错误码翻成人话", () => {
  it("合成（HTTP 200 + base_resp）和识别（402 + OpenAI 风格错误体）都认得出余额不足", async () => {
    const poor = { id: "mm", kind: "minimax", base_url: `${base}/mmpoor`, api_key: "k" };
    await expect(mk({ tts: "mm", providers: [poor] }).synthesize("你好")).rejects.toThrow(/余额不足.*（1008）/);
    // 识别失败不抛错、返回空（当没听清），原因打日志
    expect(await mk({ asr: "mm", providers: [poor] }).transcribe(wavHeader(0))).toBe("");
  });
});

describe("复刻音色清单与激活（MiniMax）", () => {
  it("复刻、激活走按量计费 Key；查询订阅 Key 不行就换按量 Key", async () => {
    const p: any = { ...providers()[1], api_key: "plan", billing_api_key: "paid" };
    await minimaxClone(p, { voice_id: "Kagura_mio2", audio: { data: Buffer.alloc(10, 1), filename: "a.wav" } });
    expect(seen.filter((x) => x.path === "/mm/voice_clone").at(-1)!.auth).toBe("Bearer paid");
    await minimaxActivate(p, "Kagura_mio2");
    const t2a = seen.filter((x) => x.path === "/mm/t2a_v2").at(-1)!;
    expect(t2a.auth).toBe("Bearer paid");
    expect(JSON.parse(t2a.body.toString()).voice_setting.voice_id).toBe("Kagura_mio2");
    expect((await minimaxListCloned(p)).map((v) => v.voice_id)).toEqual(["Mio_voice01", "Old_voice01"]);
    // 没填按量 Key 就用 api_key
    await minimaxActivate({ ...p, billing_api_key: "" }, "Kagura_mio2");
    expect(seen.filter((x) => x.path === "/mm/t2a_v2").at(-1)!.auth).toBe("Bearer plan");
  });

  it("本地记录与远端合并：远端有的标成已激活，没激活的 7 天后算过期，远端独有的也列出来", () => {
    const store = new ClonedVoices(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cv-")), "minimax_voices.json"));
    const now = Date.now();
    store.add({ voice_id: "Mio_voice01", provider: "mm", name: "小澪", created_at: now - 3600_000 });
    store.add({ voice_id: "New_voice01", provider: "mm", created_at: now - 3600_000 });
    store.add({ voice_id: "Gone_voice1", provider: "mm", created_at: now - CLONE_EXPIRE_MS - 1 });
    store.add({ voice_id: "Other_voice", provider: "other", created_at: now });
    const rows = store.merge("mm", [{ voice_id: "Mio_voice01", created_time: "2026-10-20" }, { voice_id: "Old_voice01", created_time: "2026-01-02" }], now);
    const by = Object.fromEntries(rows.map((r) => [r.voice_id, r]));
    expect(Object.keys(by).sort()).toEqual(["Gone_voice1", "Mio_voice01", "New_voice01", "Old_voice01"]);
    expect(by.Mio_voice01).toMatchObject({ status: "active", name: "小澪" });
    expect(by.New_voice01).toMatchObject({ status: "pending", expires_at: now - 3600_000 + CLONE_EXPIRE_MS });
    expect(by.Gone_voice1.status).toBe("expired");
    expect(by.Old_voice01).toMatchObject({ status: "active", in_remote: true });
    expect(store.list().find((v) => v.voice_id === "Mio_voice01")!.activated_at).toBe(now);   // 落盘
    // 远端查不到（比如没网）：只看本地，不乱标
    expect(store.merge("mm", null, now).find((r) => r.voice_id === "New_voice01")!.status).toBe("pending");
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

describe("响度补偿", () => {
  const tone = (amp: number, n = 16000, silenceFirst = 0) => {
    const b = Buffer.alloc(n * 2);
    for (let i = silenceFirst; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin(i / 7)), i * 2);
    return b;
  };
  const rms = (b: Buffer, from = 0) => { let e = 0, k = 0; for (let i = from; i < b.length / 2; i++) { const v = b.readInt16LE(i * 2) / 32768; e += v * v; k++; } return Math.sqrt(e / k); };
  const peak = (b: Buffer) => { let m = 0; for (let i = 0; i < b.length / 2; i++) m = Math.max(m, Math.abs(b.readInt16LE(i * 2)) / 32768); return m; };

  it("小声的放大到目标响度；只按有声段算（前面一半静音不影响）", () => {
    const quiet = tone(0.05, 32000, 16000);             // 有声段 RMS ≈ 0.035，前一秒是静音
    const out = normalizeLoudness(quiet);
    expect(rms(out, 16000)).toBeGreaterThan(LOUDNESS_TARGET_RMS * 0.95);
    expect(rms(out, 16000)).toBeLessThan(LOUDNESS_TARGET_RMS * 1.05);
  });
  it("够响的不动；最多放大 4 倍；有尖峰时不削波", () => {
    const loud = tone(0.3);
    expect(normalizeLoudness(loud)).toBe(loud);
    expect(peak(normalizeLoudness(tone(0.01)))).toBeLessThan(0.01 * 4 + 0.001);
    const spiky = tone(0.03); spiky.writeInt16LE(20000, 1000);         // 尖峰 0.61：放大受它限制
    const out = normalizeLoudness(spiky);
    expect(peak(out)).toBeLessThanOrEqual(0.9 + 1e-4);
    expect(peak(out)).toBeGreaterThan(0.85);
  });
  it("全是静音不放大", () => {
    const silent = Buffer.alloc(32000);
    expect(normalizeLoudness(silent)).toBe(silent);
  });
});
