// 语音接入：识别（ASR）和合成（TTS）各自选一家服务商，不写死百度。
//
//   baidu   百度（识别 + 合成，Key 在 config.json 的 baidu 里）
//   openai  OpenAI 兼容接口（/audio/transcriptions、/audio/speech）：OpenAI、硅基流动、本机 VoiceStudio 等
//   minimax MiniMax 语音合成（t2a_v2，支持复刻音色）
//
// 每个 agent 可以单独指定合成服务商和音色（agent.json 的 tts_provider / tts_voice）；没指定用默认服务商。
// 指定的那家失败时退回默认服务商，再不行才报错——别让换了家服务商就变成「没声音」。
// 设备只认 16k 单声道 16 位 PCM，别家返回的采样率不一样就在这里转换。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stripMarkdown, pyHead, pyLen } from "../util/text.ts";
import { wavHeader, SAMPLE_RATE } from "../util/wav.ts";
import { BaiduVoice, pruneDir, TTS_CACHE_MAX_FILES, type BaiduEndpoints, BAIDU_ENDPOINTS } from "./baidu.ts";
import type { Voice, VoiceRef } from "./types.ts";

export type SpeechKind = "baidu" | "openai" | "minimax";
export interface SpeechProvider {
  id: string;
  kind: SpeechKind;
  /** 显示名 */
  name?: string;
  base_url?: string;
  api_key?: string;
  /** 合成模型（openai：tts-1 / 引擎 id；minimax：speech-02-turbo 等） */
  model?: string;
  /** 默认音色（openai：voice 名或 VoiceStudio 的声音 id；minimax：voice_id） */
  voice?: string;
  /** 识别模型（openai：whisper-1、FunAudioLLM/SenseVoiceSmall 等） */
  asr_model?: string;
  /** 语速，1 = 正常 */
  speed?: number;
  /** minimax 旧接口要 GroupId */
  group_id?: string;
}
export interface SpeechConfig { asr: string; tts: string; providers: SpeechProvider[] }

export const DEFAULT_SPEECH: SpeechConfig = { asr: "baidu", tts: "baidu", providers: [{ id: "baidu", kind: "baidu", name: "百度" }] };

/** 读 config.json 的 speech；没写就是只有百度（老配置零改动） */
export function parseSpeechConfig(raw: any): SpeechConfig {
  const list: SpeechProvider[] = Array.isArray(raw?.providers) ? raw.providers.filter((p: any) => p && p.id && ["baidu", "openai", "minimax"].includes(p.kind))
    .map((p: any) => ({ ...p, id: String(p.id).trim() })) : [];
  if (!list.some((p) => p.kind === "baidu")) list.unshift({ id: "baidu", kind: "baidu", name: "百度" });
  const has = (id: unknown) => typeof id === "string" && list.some((p) => p.id === id);
  return { asr: has(raw?.asr) ? raw.asr : list[0].id, tts: has(raw?.tts) ? raw.tts : list[0].id, providers: list };
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

async function fetchOk(url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${what} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

/** 把任意 WAV（或裸 PCM）转成 16k 单声道 16 位 PCM */
export function toPcm16k(buf: Buffer, rawRate = 0): Buffer {
  let rate = rawRate || SAMPLE_RATE, ch = 1, bits = 16, data = buf;
  if (buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    let off = 12, fmt = 1;
    data = Buffer.alloc(0);
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      let size = buf.readUInt32LE(off + 4);
      const body = off + 8;
      // 流式输出的 WAV 常把长度写成占位值，data 块就读到文件尾
      if (id === "data" && (size === 0 || size === 0xffffffff || body + size > buf.length)) size = buf.length - body;
      if (id === "fmt ") { fmt = buf.readUInt16LE(body); ch = buf.readUInt16LE(body + 2); rate = buf.readUInt32LE(body + 4); bits = buf.readUInt16LE(body + 14); }
      else if (id === "data") { data = buf.subarray(body, body + size); break; }
      off = body + size + (size & 1);
    }
    if (fmt === 0xfffe) fmt = bits === 32 ? 3 : 1;   // WAVE_FORMAT_EXTENSIBLE：按位深猜
    if (fmt === 3 && bits !== 32) throw new Error("不支持的 WAV 格式");
    if (fmt !== 1 && fmt !== 3) throw new Error(`不支持的 WAV 编码 ${fmt}`);
    if (fmt === 3) bits = -32;                       // 用负数标浮点
  }
  // 解出单声道浮点样本
  const step = Math.abs(bits) / 8 * ch;
  const n = Math.floor(data.length / step);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) {
      const o = i * step + c * Math.abs(bits) / 8;
      s += bits === 16 ? data.readInt16LE(o) / 32768 : bits === -32 ? data.readFloatLE(o) : bits === 32 ? data.readInt32LE(o) / 2147483648
        : bits === 8 ? (data[o] - 128) / 128 : bits === 24 ? (data.readIntLE(o, 3)) / 8388608 : 0;
    }
    mono[i] = s / ch;
  }
  // 降采样前先做一次简单低通（窗口平均），免得高频混叠成刺耳的杂音
  let src = mono;
  if (rate > SAMPLE_RATE) {
    const w = Math.max(1, Math.round(rate / SAMPLE_RATE));
    if (w > 1) {
      src = new Float32Array(n);
      let acc = 0;
      for (let i = 0; i < n; i++) { acc += mono[i]; if (i >= w) acc -= mono[i - w]; src[i] = acc / Math.min(i + 1, w); }
    }
  }
  const outN = rate === SAMPLE_RATE ? n : Math.floor(n * SAMPLE_RATE / rate);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const pos = i * rate / SAMPLE_RATE, j = Math.floor(pos), f = pos - j;
    const v = (src[j] ?? 0) * (1 - f) + (src[j + 1] ?? src[j] ?? 0) * f;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  return out;
}

/** 非百度服务商的合成：返回 16k PCM */
async function synthOther(p: SpeechProvider, text: string, voice: string): Promise<Buffer> {
  if (p.kind === "openai") {
    const base = trimSlash(p.base_url || "https://api.openai.com/v1");
    const r = await fetchOk(`${base}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(p.api_key ? { Authorization: `Bearer ${p.api_key}` } : {}) },
      body: JSON.stringify({ model: p.model || "tts-1", voice: voice || p.voice || "alloy", input: text, response_format: "wav", ...(p.speed ? { speed: p.speed } : {}) }),
    }, 60_000, `${p.id} 合成`);
    return toPcm16k(Buffer.from(await r.arrayBuffer()));
  }
  if (p.kind === "minimax") {
    const base = trimSlash(p.base_url || "https://api.minimaxi.com/v1");
    const r = await fetchOk(`${base}/t2a_v2${p.group_id ? `?GroupId=${encodeURIComponent(p.group_id)}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.api_key ?? ""}` },
      body: JSON.stringify({
        model: p.model || "speech-02-turbo", text, stream: false,
        voice_setting: { voice_id: voice || p.voice || "female-shaonv", speed: p.speed ?? 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: SAMPLE_RATE, format: "pcm", channel: 1 },
      }),
    }, 60_000, `${p.id} 合成`);
    const j: any = await r.json();
    if (j?.base_resp?.status_code) throw new Error(`${p.id} 合成失败: ${j.base_resp.status_code} ${j.base_resp.status_msg ?? ""}`);
    const hex = j?.data?.audio;
    if (!hex) throw new Error(`${p.id} 合成失败：没有返回音频`);
    return toPcm16k(Buffer.from(hex, "hex"), SAMPLE_RATE);
  }
  throw new Error(`不支持的合成服务商类型 ${p.kind}`);
}

/** 非百度服务商的识别 */
async function transcribeOther(p: SpeechProvider, wav: Buffer): Promise<string> {
  if (p.kind !== "openai") throw new Error(`${p.id}（${p.kind}）不支持语音识别`);
  const base = trimSlash(p.base_url || "https://api.openai.com/v1");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("model", p.asr_model || "whisper-1");
  form.append("language", "zh");
  const r = await fetchOk(`${base}/audio/transcriptions`, { method: "POST", headers: p.api_key ? { Authorization: `Bearer ${p.api_key}` } : {}, body: form }, 30_000, `${p.id} 识别`);
  const ct = r.headers.get("content-type") ?? "";
  return (ct.includes("json") ? String(((await r.json()) as any).text ?? "") : await r.text()).trim();
}

export class SpeechHub implements Voice {
  private baidu: BaiduVoice;
  cfg: SpeechConfig = DEFAULT_SPEECH;

  constructor(baiduKeys: ConstructorParameters<typeof BaiduVoice>[0], private cacheDir: string, cfg?: SpeechConfig, baiduEp: BaiduEndpoints = BAIDU_ENDPOINTS) {
    this.baidu = new BaiduVoice(baiduKeys, cacheDir, baiduEp);
    if (cfg) this.cfg = cfg;
  }

  /** 管理界面改了设置：就地换，不用重启 */
  configure(cfg: SpeechConfig) { this.cfg = cfg; }

  private provider(id?: string) { return this.cfg.providers.find((p) => p.id === id); }

  warmup() { return this.provider(this.cfg.asr)?.kind === "baidu" ? this.baidu.warmup() : Promise.resolve(""); }

  async transcribe(wav: Buffer): Promise<string> {
    const p = this.provider(this.cfg.asr);
    if (!p || p.kind === "baidu") return this.baidu.transcribe(wav);
    try { return await transcribeOther(p, wav); }
    catch (e: any) { console.log(`[asr] ❌ ${p.id}: ${e.message}`); return ""; }
  }

  async synthesize(text: string, v?: number | VoiceRef): Promise<string | null> {
    const ref: VoiceRef = typeof v === "number" ? { per: v } : v ?? {};
    const want = this.provider(ref.provider) ?? this.provider(this.cfg.tts);
    const fallback = this.provider(this.cfg.tts);
    try {
      return await this.synthWith(want, text, ref);
    } catch (e: any) {
      if (!want || !fallback || want.id === fallback.id) throw e;
      console.log(`[tts] ⚠️  ${want.id} 合成失败，改用 ${fallback.id}: ${e.message}`);
      return this.synthWith(fallback, text, { per: ref.per });
    }
  }

  private async synthWith(p: SpeechProvider | undefined, text: string, ref: VoiceRef): Promise<string | null> {
    // 百度的音色是 per 编号；别家的音色是名字 / id，指定给别家的音色不能拿去问百度
    if (!p || p.kind === "baidu") return this.baidu.synthesize(text, ref.per ?? 111);
    const clean = stripMarkdown(text);
    if (!clean) return null;
    // 音色只给它所属的那家：指定了服务商就只认那家，没指定就是给默认服务商的
    const voice = (ref.provider ? ref.provider === p.id : p.id === this.cfg.tts) ? (ref.voice || "") : "";
    const key = crypto.createHash("md5").update(`${clean}|${p.kind}|${p.id}|${p.base_url ?? ""}|${p.model ?? ""}|${voice || p.voice || ""}|${p.speed ?? 1}`, "utf8").digest("hex");
    const cachePath = path.join(this.cacheDir, `${key}.wav`);
    if (fs.existsSync(cachePath)) {
      const t = new Date();
      fs.utimesSync(cachePath, t, t);
      console.log(`[tts] ♻️  缓存命中（${p.id}）: ${pyHead(clean, 30)}${pyLen(clean) > 30 ? "..." : ""}`);
      return cachePath;
    }
    const pcm = await synthOther(p, clean, voice);
    if (!pcm.length) throw new Error(`${p.id} 返回了空音频`);
    const tmp = path.join(this.cacheDir, `${crypto.randomUUID()}.part`);
    fs.writeFileSync(tmp, Buffer.concat([wavHeader(pcm.length), pcm]));
    fs.renameSync(tmp, cachePath);
    pruneDir(this.cacheDir, TTS_CACHE_MAX_FILES);
    return cachePath;
  }
}
