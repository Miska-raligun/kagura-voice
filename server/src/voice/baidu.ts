// 百度 ASR / TTS（对应 transcribe / synthesize / baidu_tokens.py）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stripMarkdown, pyHead, pyLen } from "../util/text.ts";
import { wavHeader, SAMPLE_RATE } from "../util/wav.ts";
import { sleep } from "../util/time.ts";
import type { Voice } from "./types.ts";

export const TTS_CACHE_MAX_FILES = 200;

/** 百度 OAuth access token 缓存，过期前自动刷新；并发请求共用同一次刷新 */
/** 百度接口地址。测试用本地假服务器替换 */
export interface BaiduEndpoints { token: string; asr: string; tts: string }
export const BAIDU_ENDPOINTS: BaiduEndpoints = {
  token: "https://aip.baidubce.com/oauth/2.0/token",
  asr: "https://vop.baidu.com/server_api",
  tts: "https://tsn.baidu.com/text2audio",
};

export class BaiduToken {
  private token: string | null = null;
  private expire = 0;
  private inflight: Promise<string> | null = null;
  constructor(private key: string, private secret: string, private name: string, private url = BAIDU_ENDPOINTS.token) {}

  async get(): Promise<string> {
    if (this.token && Date.now() / 1000 < this.expire) return this.token;
    this.inflight ??= this.fetch().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async fetch(): Promise<string> {
    const url = `${this.url}?grant_type=client_credentials&client_id=${encodeURIComponent(this.key)}&client_secret=${encodeURIComponent(this.secret)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data: any = await r.json();
    if (!data.access_token) throw new Error(`百度 ${this.name} token 获取失败: ${data.error ?? JSON.stringify(data)}`);
    this.token = data.access_token;
    this.expire = Date.now() / 1000 + Number(data.expires_in ?? 2592000) - 60;   // 默认 30 天
    return this.token!;
  }
}

/** 百度 API 调用带一次退避重试，网络抖动不直接把错误抛给用户 */
async function postWithRetry(url: string, init: RequestInit, timeoutMs = 15_000, attempts = 2): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) {
      last = e;
      if (i + 1 < attempts) { console.log(`[http] 请求失败重试 (${i + 1}/${attempts}): ${e.message}`); await sleep(500 * (i + 1)); }
    }
  }
  throw last;
}

/** 按 mtime 保留最新 max 个 wav，其余删除 */
export function pruneDir(dir: string, max: number) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".wav"))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(max)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* 被并发删了 */ } }
}

/** TTS 缓存 key：与 Python 版逐字一致（per=111 的旧缓存照样命中，迁移时直接拷 tts_cache/） */
export const ttsCacheKey = (clean: string, per: number) =>
  crypto.createHash("md5").update(`${clean}|spd5|pit5|vol10|per${per}|aue4`, "utf8").digest("hex");

export class BaiduVoice implements Voice {
  private asrTok: BaiduToken;
  private ttsTok: BaiduToken;
  constructor(keys: { asrKey: string; asrSecret: string; ttsKey: string; ttsSecret: string }, private cacheDir: string,
              private ep: BaiduEndpoints = BAIDU_ENDPOINTS) {
    this.asrTok = new BaiduToken(keys.asrKey, keys.asrSecret, "ASR", ep.token);
    this.ttsTok = new BaiduToken(keys.ttsKey, keys.ttsSecret, "TTS", ep.token);
  }

  warmup() { return this.asrTok.get(); }

  async transcribe(wav: Buffer): Promise<string> {
    const r = await postWithRetry(this.ep.asr, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "wav", rate: SAMPLE_RATE, channel: 1, cuid: "core2_client",
        token: await this.asrTok.get(), speech: wav.toString("base64"), len: wav.length,
      }),
    });
    const result: any = await r.json();
    if (result.err_no !== 0) {
      // 别静默吞掉：3301=音质差/无有效语音、3302=鉴权、3308=音频过长……
      console.log(`[asr] ❌ err_no=${result.err_no} ${result.err_msg ?? ""}`);
      return "";
    }
    const res = result.result ?? [];
    if (!res.length) { console.log("[asr] ❌ 返回成功但 result 为空"); return ""; }
    return String(res[0]).trim();
  }

  async synthesize(text: string, per = 111): Promise<string | null> {
    const clean = stripMarkdown(text);
    if (!clean) return null;
    const cachePath = path.join(this.cacheDir, `${ttsCacheKey(clean, per)}.wav`);
    if (fs.existsSync(cachePath)) {
      const t = new Date();
      fs.utimesSync(cachePath, t, t);     // 刷新 mtime，供 LRU 保留热门条目
      console.log(`[tts] ♻️  缓存命中: ${pyHead(clean, 30)}${pyLen(clean) > 30 ? "..." : ""}`);
      return cachePath;
    }
    const form = new URLSearchParams({
      tex: clean, tok: await this.ttsTok.get(), cuid: "core2_client", ctp: "1", lan: "zh",
      spd: "5", pit: "5", vol: "10", per: String(per), aue: "4",       // aue=4：pcm-16k
    });
    const r = await postWithRetry(this.ep.tts, { method: "POST", body: form });
    const ct = r.headers.get("content-type") ?? "";
    const body = Buffer.from(await r.arrayBuffer());
    if (ct.includes("json") || body[0] === 0x7b) throw new Error(`百度 TTS 失败: ${body.subarray(0, 200).toString()}`);
    // 先写临时文件再原子改名：并发合成同一文本时不会读到半个 WAV
    const tmp = path.join(this.cacheDir, `${crypto.randomUUID()}.part`);
    fs.writeFileSync(tmp, Buffer.concat([wavHeader(body.length), body]));
    fs.renameSync(tmp, cachePath);
    pruneDir(this.cacheDir, TTS_CACHE_MAX_FILES);
    return cachePath;
  }
}
