// 异步对话（设备 /chat、/chat-vision 带 X-Async: 1）：设备上传录音后立刻拿到一个回复编号，之后用
// GET /chat/reply/<id>?wait=秒 长轮询取回复；回复按「段」边生成边播。
//
// 为什么要这样：设备是单线程 MicroPython，一个同步请求等多久，主循环就停多久——发不了 MQTT 保活、
// 喂不上狗、点屏幕也没反应，所以同步 /chat 只能等 60 秒。改成长轮询后，每次最多阻塞 wait 秒，
// 两次之间设备回主循环保活、看触摸（点一下 = POST /chat/cancel/<id> 取消），任务多长都行。
//
// 分段：已经生成好的句子攒成一段边合成边写（与 stream-reply 同一套音频协议：WAV 头 + PCM，读到关闭）；
// 写完了、agent 还没说完（比如中途在跑工具）就等 SEG_IDLE，没有新句子就先结束这一段，
// 响应头带 X-Reply-More: 1，设备播完再来取下一段。首段的响应头要等「确认这条消息里没有待执行的工具」
// 才发（同 stream-reply：X-Need-Photo / X-Volume 来自工具调用）。
import type http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { SentenceSplitter, wavPcm } from "./sentences.ts";
import { HEADER_TOOLS } from "./stream-reply.ts";
import { wavHeader } from "../util/wav.ts";
import { b64Header } from "../util/text.ts";
import type { AgentStreamEvent } from "../agent/runtime.ts";
import type { Voice, VoiceRef } from "../voice/types.ts";

export interface PendingOpts {
  dev: string;
  userText: string;
  voice: Voice;
  per: number | VoiceRef;
  /** 首段额外带的响应头（X-Role 等） */
  headers: Record<string, string>;
  run: (onEvent: (e: AgentStreamEvent) => void, meta: { needPhoto?: boolean; volume?: string }, signal: AbortSignal) => Promise<string>;
  done?: (r: { reply: string; error?: string; cancelled?: boolean }) => void;
  log?: (s: string) => void;
}

/** 预合成的句子数 */
const LOOKAHEAD = 2;
/** 一段写完后等新句子的时长：超过就先结束这一段（设备那头的单次读超时是 60 秒） */
export const SEG_IDLE_MS = 15_000;
/** 长轮询最长等多久（设备每次最多阻塞这么久） */
export const MAX_WAIT_MS = 25_000;
/** 跑完后多久没人来取就清掉 */
const KEEP_MS = 10 * 60_000;

export class PendingReply {
  readonly id = crypto.randomBytes(6).toString("hex");
  readonly created = Date.now();
  finishedAt = 0;
  private split = new SentenceSplitter();
  private items: { text: string; wav?: Promise<string | null> }[] = [];
  private cursor = 0;
  private meta: { needPhoto?: boolean; volume?: string } = {};
  private first: string | null = null;
  private textAfterFirst = false;
  private lastMsgEnded = false;
  /** 最后一条助手消息结束了、而且没调工具：这就是最终回复 */
  private finalMsg = false;
  private pendingTools = 0;
  private toolsDone = 0;
  done = false;
  private finalText = "";
  private error: Error | null = null;
  private headersSent = false;
  firstAudioMs: number | null = null;
  private ctl = new AbortController();
  private waiters: (() => void)[] = [];
  /** 正在写的那一段（同一时刻只许一个连接在取） */
  private serving = false;

  constructor(private o: PendingOpts) {
    const enqueue = (s: string) => {
      if (this.first === null) this.first = s; else this.textAfterFirst = true;
      this.items.push({ text: s });
    };
    const onEvent = (e: AgentStreamEvent) => {
      if (e.type === "text") {
        if (this.first !== null && e.delta.trim()) this.textAfterFirst = true;
        this.lastMsgEnded = false; this.finalMsg = false;
        for (const s of this.split.push(e.delta)) enqueue(s);
      } else if (e.type === "message_end") {
        // 一条助手消息结束就是句子边界：「我查一下。」之后它去跑工具了，别把这句压在缓冲里
        for (const s of this.split.flush()) enqueue(s);
        this.lastMsgEnded = true; this.finalMsg = e.toolCalls === 0; this.pendingTools += e.toolNames.filter((n) => HEADER_TOOLS.has(n)).length; }
      else if (e.type === "tool_end" && HEADER_TOOLS.has(e.name)) this.toolsDone++;
      this.notify();
    };
    o.run(onEvent, this.meta, this.ctl.signal).then((t) => { this.finalText = t; }, (e) => { this.error = e; }).finally(() => {
      for (const s of this.split.flush()) enqueue(s);
      // 回复没走逐字通道（OpenClaw、take_photo 时补的「好的，我看看」）：整段当一句
      if (!this.items.length && this.finalText.trim()) enqueue(this.finalText.trim());
      this.done = true;
      this.finishedAt = Date.now();
      const cancelled = this.ctl.signal.aborted;
      o.done?.({ reply: this.reply(), ...(this.error ? { error: String(this.error.message) } : {}), ...(cancelled ? { cancelled } : {}) });
      this.notify();
    });
  }

  reply() { return this.finalText || this.items.map((x) => x.text).join(""); }
  cancel() { this.ctl.abort(); this.notify(); }
  /** 全部取走了（或者跑完很久没人来取），可以清掉 */
  stale(t = Date.now()) { return this.done && (this.cursor >= this.items.length || t - this.finishedAt > KEEP_MS); }

  private notify() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  private waitChange(ms: number) {
    return new Promise<void>((resolve) => {
      const f = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== f); resolve(); }, Math.max(0, ms));
      this.waiters.push(f);
    });
  }
  private canStart() { return this.done || (this.first !== null && this.toolsDone >= this.pendingTools && (this.textAfterFirst || this.lastMsgEnded)); }

  /** 处理一次 GET /chat/reply/<id>：要么写一段音频，要么 204（X-Reply-Wait = 还在想，X-Reply-Done = 没有了） */
  async serve(res: http.ServerResponse, waitMs: number, segIdleMs = SEG_IDLE_MS) {
    segIdleMs = Math.min(SEG_IDLE_MS, Math.max(100, segIdleMs));
    const deadline = Date.now() + Math.min(MAX_WAIT_MS, Math.max(0, waitMs));
    const empty = (h: Record<string, string>) => { res.writeHead(204, { ...h, "X-Reply-Id": this.id, Connection: "close" }).end(); };
    if (this.serving) return empty({ "X-Reply-Wait": "1" });
    if (!this.headersSent) {
      while (!this.canStart() && Date.now() < deadline) await this.waitChange(deadline - Date.now());
      if (!this.canStart()) return empty({ "X-Reply-Wait": "1" });
      if (this.done && !this.items.length) {
        if (this.error && !this.ctl.signal.aborted) {
          res.writeHead(500, { "Content-Type": "application/json", Connection: "close" }).end(JSON.stringify({ error: String(this.error.message) }));
          return;
        }
        return empty({ "X-Reply-Done": "1" });
      }
    } else {
      while (this.cursor >= this.items.length && !this.done && Date.now() < deadline) await this.waitChange(deadline - Date.now());
      if (this.cursor >= this.items.length) return empty(this.done ? { "X-Reply-Done": "1" } : { "X-Reply-Wait": "1" });
    }

    this.serving = true;
    try {
      const firstSeg = !this.headersSent;
      const complete = this.done || this.finalMsg;
      const partial = !complete;
      const all = () => this.items.map((x) => x.text).join("");
      const shown = firstSeg ? (this.done ? this.reply() : complete ? all() : (this.first ?? "")) : complete ? all() : this.items.slice(0, this.cursor + 1).map((x) => x.text).join("");
      const h: Record<string, string> = {
        ...(firstSeg ? this.o.headers : {}), "Content-Type": "audio/wav", Connection: "close", "X-Reply-Id": this.id,
        "X-User-Text": b64Header(this.o.userText), "X-Reply-Text": b64Header(shown),
      };
      if (partial) { h["X-Reply-Partial"] = "1"; h["X-Reply-More"] = "1"; }
      if (firstSeg && this.meta.needPhoto) h["X-Need-Photo"] = "1";
      if (firstSeg && this.meta.volume) h["X-Volume"] = this.meta.volume;
      (res as any).useChunkedEncodingByDefault = false;     // 设备的 requests 不认 chunked
      res.shouldKeepAlive = false;
      res.writeHead(200, h);
      res.write(wavHeader(0x7ffffff0 - 36));
      this.headersSent = true;
      // 对方断开时 drain 永远不来：也要听 close，不然这一段卡死在这儿（异步回复会一直回「还在想」）
      const write = (buf: Buffer) => new Promise<void>((r) => {
        if (res.write(buf) || res.destroyed) return r();
        const done = () => { res.off("drain", done); res.off("close", done); r(); };
        res.once("drain", done); res.once("close", done);
      });
      for (;;) {
        if (res.destroyed) break;                              // 设备断开（点屏幕停播）
        if (this.cursor < this.items.length) {
          for (let k = this.cursor; k < Math.min(this.items.length, this.cursor + LOOKAHEAD); k++) {
            const it = this.items[k];
            it.wav ??= this.o.voice.synthesize(it.text, this.o.per).catch(() => null);
          }
          const wav = await this.items[this.cursor].wav!;
          this.cursor++;
          if (!wav) { this.o.log?.(`⚠️  第 ${this.cursor} 句合成失败，跳过`); continue; }
          if (this.firstAudioMs === null) this.firstAudioMs = Date.now() - this.created;
          await write(wavPcm(fs.readFileSync(wav)));
          continue;
        }
        if (this.done) break;
        // 写完了、agent 还在忙（多半在跑工具）：等一会儿新句子，等不到就先收这一段
        const until = Date.now() + segIdleMs;
        while (this.cursor >= this.items.length && !this.done && Date.now() < until) await this.waitChange(until - Date.now());
        if (this.cursor >= this.items.length && !this.done) break;
      }
      res.end();
    } finally {
      this.serving = false;
    }
  }
}

/** 进行中的异步回复（按 id）；同一台设备新开一个就取消旧的 */
export class PendingReplies {
  private map = new Map<string, PendingReply>();
  private byDev = new Map<string, string>();

  start(o: PendingOpts): PendingReply {
    this.sweep();
    const old = this.byDev.get(o.dev);
    if (old) this.map.get(old)?.cancel();
    const p = new PendingReply(o);
    this.map.set(p.id, p);
    this.byDev.set(o.dev, p.id);
    return p;
  }
  get(id: string) { return this.map.get(id); }
  cancel(id: string) { const p = this.map.get(id); p?.cancel(); return !!p; }
  sweep() { const t = Date.now(); for (const [id, p] of this.map) if (p.stale(t)) this.map.delete(id); }
}
