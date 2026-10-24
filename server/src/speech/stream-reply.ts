// 边生成边播（§6.10）的服务端：模型逐字输出 → 切句 → 每句合成 → 立刻写进 HTTP 响应。
//
// 协议（设备 snd.stream_play 本来就这么读，音频部分固件零改动）：
//   一个 44 字节 WAV 头（长度字段随便填，设备不看）+ 一句句的 PCM 依次追加，读到连接关闭为止。
//   不带 Content-Length、不用 chunked（设备的 requests 不认 chunked），Connection: close。
//
// 响应头必须在第一段音频之前发出，而 X-Need-Photo / X-Volume 来自工具调用。所以首句合成好后，
// 要等「确认这条消息里没有待执行的工具」才发头：首句之后又来了新文字，或者这条助手消息已经结束、
// 它带的工具也都执行完了。X-Reply-Text 只放首句（加 X-Reply-Partial: 1），全文设备播完后 GET /chat/last 取。
import type http from "node:http";
import fs from "node:fs";
import { SentenceSplitter, wavPcm } from "./sentences.ts";
import { wavHeader } from "../util/wav.ts";
import { b64Header } from "../util/text.ts";
import type { AgentStreamEvent } from "../agent/runtime.ts";
import type { Voice, VoiceRef } from "../voice/types.ts";

export interface StreamReplyOpts {
  voice: Voice;
  /** 用谁的声音（百度音色编号，或服务商 + 音色） */
  per: number | VoiceRef;
  userText: string;
  headers: Record<string, string>;
  /** 跑大脑：拿到逐字事件与 meta（工具对响应头的影响），返回完整回复 */
  run: (onEvent: (e: AgentStreamEvent) => void, meta: { needPhoto?: boolean; volume?: string }) => Promise<string>;
  /** 结束时回调：完整回复文本、首段音频出声前的耗时等 */
  done?: (r: { reply: string; firstAudioMs: number | null; sentences: number; error?: string }) => void;
  log?: (s: string) => void;
}

/**
 * 会改响应头的工具：首句要等它们执行完才能发头（X-Need-Photo / X-Volume）。
 * 其它工具（搜网页、跑命令……）不等——否则「我查一下。」要憋到工具跑完才出声
 */
export const HEADER_TOOLS = new Set(["take_photo", "set_volume"]);

/** 预合成的句子数（当前这句 + 往后一句），既不让扬声器断粮，也不一口气打满 TTS 接口 */
const LOOKAHEAD = 2;

export async function streamReply(res: http.ServerResponse, o: StreamReplyOpts): Promise<void> {
  const t0 = Date.now();
  const split = new SentenceSplitter();
  const items: { text: string; wav?: Promise<string | null> }[] = [];
  const meta: { needPhoto?: boolean; volume?: string } = {};
  let first: string | null = null;
  let textAfterFirst = false;
  let lastMsgEnded = false, pendingTools = 0, toolsDone = 0;
  /** 最后一条助手消息结束了、而且没调工具：这就是最终回复（整轮马上结束），头里按完整回复写 */
  let finalMsg = false;
  let done = false, finalText = "", error: Error | null = null;
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  const waitChange = () => new Promise<void>((r) => { wake = r; });

  const enqueue = (s: string) => {
    if (first === null) first = s; else textAfterFirst = true;
    items.push({ text: s });
  };
  const onEvent = (e: AgentStreamEvent) => {
    if (e.type === "text") {
      if (first !== null && e.delta.trim()) textAfterFirst = true;
      lastMsgEnded = false; finalMsg = false;
      for (const s of split.push(e.delta)) enqueue(s);
    } else if (e.type === "message_end") {
      // 一条助手消息结束就是句子边界：「我查一下。」之后它去跑工具了，别把这句压在缓冲里
      for (const s of split.flush()) enqueue(s);
      lastMsgEnded = true; finalMsg = e.toolCalls === 0; pendingTools += e.toolNames.filter((n) => HEADER_TOOLS.has(n)).length; }
    else if (e.type === "tool_end" && HEADER_TOOLS.has(e.name)) toolsDone++;
    notify();
  };

  o.run(onEvent, meta).then((t) => { finalText = t; }, (e) => { error = e; }).finally(() => {
    for (const s of split.flush()) enqueue(s);
    // 回复没走逐字通道（take_photo 时补的「好的，我看看」等）：整段当一句
    if (!items.length && finalText.trim()) enqueue(finalText.trim());
    done = true;
    notify();
  });

  const canSendHeaders = () => done || (first !== null && toolsDone >= pendingTools && (textAfterFirst || lastMsgEnded));
  const synth = (i: number) => { const it = items[i]; if (it && !it.wav) it.wav = o.voice.synthesize(it.text, o.per).catch(() => null); };

  let sent = false, firstAudioMs: number | null = null, played = 0;
  const sendHeaders = () => {
    const complete = done || finalMsg;
    const partial = !complete;
    const reply = done ? (finalText || items.map((x) => x.text).join("")) : complete ? items.map((x) => x.text).join("") : (first ?? "");
    const h: Record<string, string> = {
      ...o.headers, "Content-Type": "audio/wav", Connection: "close",
      "X-User-Text": b64Header(o.userText), "X-Reply-Text": b64Header(reply),
    };
    if (partial) h["X-Reply-Partial"] = "1";
    if (meta.needPhoto) h["X-Need-Photo"] = "1";
    if (meta.volume) h["X-Volume"] = meta.volume;
    // 设备的 requests 不认 chunked：不写 Content-Length，靠关连接结束
    (res as any).useChunkedEncodingByDefault = false;
    res.shouldKeepAlive = false;
    res.writeHead(200, h);
    res.write(wavHeader(0x7ffffff0 - 36));
    sent = true;
  };
  const write = (buf: Buffer) => new Promise<void>((r) => { if (!res.write(buf)) res.once("drain", r); else r(); });

  for (let i = 0; ; ) {
    if (res.destroyed) break;          // 设备断开（用户点屏幕停播）：不再合成
    if (i < items.length) {
      for (let k = i; k < Math.min(items.length, i + LOOKAHEAD); k++) synth(k);
      while (!sent && !canSendHeaders()) await waitChange();
      if (error && !sent && !played) break;
      const wav = await items[i].wav!;
      i++;
      if (!wav) { o.log?.(`⚠️  第 ${i} 句合成失败，跳过`); continue; }
      if (!sent) sendHeaders();
      if (firstAudioMs === null) firstAudioMs = Date.now() - t0;
      await write(wavPcm(fs.readFileSync(wav)));
      played++;
      continue;
    }
    if (done) break;
    await waitChange();
  }
  const reply = finalText || items.map((x) => x.text).join("");
  if (!sent) {
    if (error) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String((error as Error).message) }));
      o.done?.({ reply: "", firstAudioMs: null, sentences: 0, error: String((error as Error).message) });
      return;
    }
    sendHeaders();
  }
  res.end();
  o.done?.({ reply, firstAudioMs, sentences: played, ...(error ? { error: String((error as Error).message) } : {}) });
}
