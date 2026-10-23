// 百度 ASR/TTS：本地假服务器模拟百度接口，核对请求格式、报错处理、token 缓存、TTS 缓存与 Python 版一致。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BaiduVoice, ttsCacheKey } from "../src/voice/baidu.ts";

let server: http.Server, base = "";
const seen: { path: string; body: string; query: string }[] = [];
let tokenCalls = 0;
let asrReply: any = { err_no: 0, result: ["你好呀 "] };
let ttsJsonError = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      seen.push({ path: u.pathname, body, query: u.search });
      if (u.pathname === "/token") { tokenCalls++; res.end(JSON.stringify({ access_token: "tok-" + tokenCalls, expires_in: 3600 })); }
      else if (u.pathname === "/asr" || u.pathname === "/asr-pro") res.end(JSON.stringify(asrReply));
      else if (ttsJsonError) { res.setHeader("content-type", "application/json"); res.end('{"err_msg":"bad"}'); }
      else { res.setHeader("content-type", "audio/basic"); res.end(Buffer.alloc(3200, 1)); }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

const mk = () => new BaiduVoice({ asrKey: "ak", asrSecret: "as", ttsKey: "tk", ttsSecret: "ts" },
  fs.mkdtempSync(path.join(os.tmpdir(), "tts-")), { token: base + "/token", asr: base + "/asr", tts: base + "/tts" });

describe("百度语音", () => {
  it("ASR 请求格式与结果（去首尾空白）", async () => {
    const v = mk();
    const wav = Buffer.from("RIFFxxxx");
    expect(await v.transcribe(wav)).toBe("你好呀");
    const req = JSON.parse(seen.filter((s) => s.path === "/asr").at(-1)!.body);
    expect(req).toMatchObject({ format: "wav", rate: 16000, channel: 1, cuid: "core2_client", len: wav.length, speech: wav.toString("base64") });
    expect(req.token).toMatch(/^tok-/);
    expect(seen.find((s) => s.path === "/token")!.query).toContain("client_id=ak");
  });

  it("极速版：走 pro_api、带 dev_pid 80001；标准版不带 dev_pid", async () => {
    const v = new BaiduVoice({ asrKey: "ak", asrSecret: "as", ttsKey: "tk", ttsSecret: "ts", asrMode: "pro" },
      fs.mkdtempSync(path.join(os.tmpdir(), "tts-")), { token: base + "/token", asr: base + "/asr", asrPro: base + "/asr-pro", tts: base + "/tts" });
    expect(await v.transcribe(Buffer.from("RIFF"))).toBe("你好呀");
    expect(JSON.parse(seen.filter((s) => s.path === "/asr-pro").at(-1)!.body).dev_pid).toBe(80001);
    await mk().transcribe(Buffer.from("RIFF"));
    expect(JSON.parse(seen.filter((s) => s.path === "/asr").at(-1)!.body).dev_pid).toBeUndefined();
  });

  it("ASR 报错返回空串", async () => {
    asrReply = { err_no: 3301, err_msg: "speech quality error" };
    expect(await mk().transcribe(Buffer.from("x"))).toBe("");
    asrReply = { err_no: 0, result: [] };
    expect(await mk().transcribe(Buffer.from("x"))).toBe("");
    asrReply = { err_no: 0, result: ["你好呀 "] };
  });

  it("token 缓存：同一实例只取一次，并发也只取一次", async () => {
    const v = mk();
    const before = tokenCalls;
    await Promise.all([v.transcribe(Buffer.from("a")), v.transcribe(Buffer.from("b")), v.transcribe(Buffer.from("c"))]);
    expect(tokenCalls - before).toBe(1);
  });

  it("TTS：表单参数、WAV 头、缓存 key 与 Python 版一致、二次命中不再请求", async () => {
    const v = mk();
    const p = (await v.synthesize("**你好**", 4))!;
    expect(path.basename(p)).toBe(ttsCacheKey("你好", 4) + ".wav");
    const form = new URLSearchParams(seen.filter((s) => s.path === "/tts").at(-1)!.body);
    expect(Object.fromEntries(form)).toMatchObject({ tex: "你好", cuid: "core2_client", ctp: "1", lan: "zh", spd: "5", pit: "5", vol: "10", per: "4", aue: "4" });
    const wav = fs.readFileSync(p);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(40)).toBe(3200);
    const n = seen.length;
    expect(await v.synthesize("你好", 4)).toBe(p);
    expect(seen.length).toBe(n);
  });

  it("TTS 缓存 key 与 Python hashlib.md5 逐字一致", () => {
    // python3 -c 'import hashlib;print(hashlib.md5("你好|spd5|pit5|vol10|per111|aue4".encode()).hexdigest())'
    expect(ttsCacheKey("你好", 111)).toBe("737745039cd35357837f3ac73db3aaab");
  });

  it("TTS 返回 JSON = 失败", async () => {
    ttsJsonError = true;
    await expect(mk().synthesize("出错", 111)).rejects.toThrow(/百度 TTS 失败/);
    ttsJsonError = false;
  });

  it("空文本不合成", async () => expect(await mk().synthesize("```code```", 111)).toBeNull());
});
