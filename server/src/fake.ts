// 契约测试用的假服务商：替换 ASR/TTS 与大脑，并开放 /__fake/* 控制接口。
// 只在 KAGURA_FAKE_PROVIDERS=1 时启用。协议与 Python 版 fake_providers.py 完全一致
// （见 contract-tests/README.md），改这里要同步改那边。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stripMarkdown } from "./util/text.ts";
import { wavHeader } from "./util/wav.ts";
import { json, type Router } from "./http/router.ts";
import type { Voice, VoiceRef } from "./voice/types.ts";
import type { Brain, ChatRequest } from "./brain/types.ts";
import type { ServerState } from "./state.ts";
import type { FakeLlm, FakeStep } from "./agent/models.ts";

const DEFAULT_ASR = "你好";
const DEFAULT_LLM = "好的。";
const BYTES_PER_CHAR = 1600;      // 每个字 50ms 的静音

export class FakeProviders implements Voice, Brain, FakeLlm {
  readonly kind = "fake";
  asrQueue: string[] = [];
  llmQueue: FakeStep[] = [];
  log = { asr: 0, llm: [] as any[], tts: [] as any[] };
  constructor(private ttsDir: string) {}

  reset() { this.asrQueue = []; this.llmQueue = []; this.log = { asr: 0, llm: [], tts: [] }; }

  async transcribe(): Promise<string> {
    this.log.asr++;
    return this.asrQueue.length ? this.asrQueue.shift()! : DEFAULT_ASR;
  }

  // ── 内置 agent 模式（KAGURA_BRAIN=pi）：假模型从同一个队列取脚本，日志格式不变 ──
  nextStep(): FakeStep { return this.llmQueue.length ? this.llmQueue.shift()! : DEFAULT_LLM; }
  logCall(e: Record<string, any>) { this.log.llm.push(e); }

  async chat(req: ChatRequest): Promise<string> {
    this.log.llm.push({ message: req.message, session: req.sessionId, agent: req.agent, image: !!req.imagePath, local_time: req.localTime || "" });
    const item = this.llmQueue.length ? this.llmQueue.shift()! : DEFAULT_LLM;
    if (typeof item === "object" && "error" in item) throw new Error(item.error);
    if (typeof item === "object") return item.text ?? "";
    return item;
  }

  async synthesize(text: string, v?: number | VoiceRef): Promise<string | null> {
    const clean = stripMarkdown(text);
    if (!clean) return null;
    const ref: VoiceRef = typeof v === "number" ? { per: v } : v ?? {};
    const per = ref.per ?? 111;
    this.log.tts.push({ text: clean, per, ...(ref.provider ? { provider: ref.provider, voice: ref.voice ?? "" } : {}) });
    const p = path.join(this.ttsDir, crypto.createHash("md5").update(`fake|${clean}|${per}|${ref.provider ?? ""}|${ref.voice ?? ""}`).digest("hex") + ".wav");
    if (!fs.existsSync(p)) {
      const body = Buffer.alloc(BYTES_PER_CHAR * Array.from(clean).length);
      fs.writeFileSync(p, Buffer.concat([wavHeader(body.length), body]));
    }
    return p;
  }

  register(r: Router, state: ServerState) {
    r.post("/__fake/reset", () => {
      this.reset();
      // 限流计数也清掉：所有用例都从 127.0.0.1 发请求，按 IP 的兜底限流会互相干扰
      state.rateBuckets.clear();
      return json({ ok: true });
    });
    r.post("/__fake/asr", (req) => { this.asrQueue.push(...((req.json() ?? {}).queue ?? [])); return json({ ok: true }); });
    r.post("/__fake/llm", (req) => { this.llmQueue.push(...((req.json() ?? {}).queue ?? [])); return json({ ok: true }); });
    r.get("/__fake/log", () => json(this.log));
    console.log("[fake] 假服务商已启用：ASR/LLM/TTS 由 /__fake/* 控制");
  }
}
