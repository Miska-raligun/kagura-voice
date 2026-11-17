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
import { SentenceSplitter, wavPcm, endsSentence, LONG_SENTENCE } from "./sentences.ts";
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
/** 「还在想」的回应里带的状态变了就提前回，但两次之间至少隔这么久（设备每次轮询是一次 HTTP 往返） */
const STATUS_MIN_MS = 1500;

/** 她正在用的工具 → 设备屏幕上显示的一句话（「思考中」太久没动静时，让人知道她在干什么） */
const ACTIVITY: [RegExp, string][] = [
  [/^web_search$/, "在搜网页"], [/^web_fetch$/, "在看网页"], [/^exec/, "在跑命令"],
  [/^(read_file|search_files|list_files)$/, "在看文件"], [/^(edit_file|write_file)$/, "在改文件"],
  [/^memory_/, "在翻记忆"], [/^read_ref$/, "在翻之前的对话"], [/^take_photo$/, "要拍照"],
  [/^sessions_/, "在找别的 agent"], [/^(cron_|task_|photo_schedule_)/, "在安排事情"], [/^skill_read$/, "在看技能说明"],
  [/^tools_load$/, "在拿工具"], [/^send_file$/, "在发文件"], [/^announce$/, "在跟家里说"],
];
export function toolActivity(name: string): string {
  for (const [re, s] of ACTIVITY) if (re.test(name)) return s;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  return mcp ? `在用 ${mcp[1]}` : "在用工具";
}
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
  private split = new SentenceSplitter({ eagerFirst: true });
  /** 她现在在干什么（正在执行的工具）；空 = 在想。随「还在想」的回应带给设备（X-Reply-Status） */
  private activity = "";
  private reported = "";
  private items: { text: string; wav?: Promise<string | null> }[] = [];
  private cursor = 0;
  private meta: { needPhoto?: boolean; volume?: string } = {};
  private first: string | null = null;
  private textAfterFirst = false;
  /** 第一句说完了没有（首句在逗号处先切出来的半句不算，见 stream-reply） */
  private firstClosed = false;
  private firstLen = 0;
  /** 整个第一句（在逗号处先切出来的半句们拼起来），首段没说完时屏显用 */
  private firstText = "";
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
      if (this.first === null) this.first = s; else if (this.firstClosed) this.textAfterFirst = true;
      if (!this.firstClosed) { this.firstLen += s.length; this.firstText += s; this.firstClosed = endsSentence(s) || this.firstLen >= LONG_SENTENCE; }
      const it: { text: string; wav?: Promise<string | null> } = { text: s };
      // 头两句一出来就去合成，不等设备来取、也不等「能发响应头了」（首句后面跟着工具时，合成和工具一起跑）
      if (this.items.length < LOOKAHEAD) it.wav = this.o.voice.synthesize(s, this.o.per).catch(() => null);
      this.items.push(it);
    };
    const onEvent = (e: AgentStreamEvent) => {
      if (e.type === "tool_start") this.activity = toolActivity(e.name);
      else if (e.type === "tool_end" || (e.type === "text" && e.delta.trim())) this.activity = "";
      if (e.type === "text") {
        this.lastMsgEnded = false; this.finalMsg = false;
        for (const s of this.split.push(e.delta)) enqueue(s);
        if (this.first !== null && this.firstClosed && this.split.pending) this.textAfterFirst = true;
      } else if (e.type === "message_end") {
        // 一条助手消息结束就是句子边界：「我查一下。」之后它去跑工具了，别把这句压在缓冲里
        for (const s of this.split.flush()) enqueue(s);
        if (this.first !== null) this.firstClosed = true;
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
    const t0 = Date.now();
    const empty = (h: Record<string, string>) => {
      // 还在想：顺带说一句她在干什么（设备显示在屏幕上）
      if (h["X-Reply-Wait"] && !this.done) { this.reported = this.activity; if (this.activity) h["X-Reply-Status"] = b64Header(this.activity); }
      res.writeHead(204, { ...h, "X-Reply-Id": this.id, Connection: "close" }).end();
    };
    /** 等到 ready() 或到点；她在干的事变了也提前回去（让设备换一行字），但别回得太勤 */
    const waitFor = async (ready: () => boolean) => {
      while (!ready() && Date.now() < deadline) {
        if (this.activity !== this.reported) {
          const hold = t0 + STATUS_MIN_MS - Date.now();
          if (hold <= 0) return;
          await this.waitChange(Math.min(hold, deadline - Date.now()));
          continue;
        }
        await this.waitChange(deadline - Date.now());
      }
    };
    if (this.serving) return empty({ "X-Reply-Wait": "1" });
    if (!this.headersSent) {
      await waitFor(() => this.canStart());
      if (!this.canStart()) return empty({ "X-Reply-Wait": "1" });
      if (this.done && !this.items.length) {
        if (this.error && !this.ctl.signal.aborted) {
          res.writeHead(500, { "Content-Type": "application/json", Connection: "close" }).end(JSON.stringify({ error: String(this.error.message) }));
          return;
        }
        return empty({ "X-Reply-Done": "1" });
      }
    } else {
      await waitFor(() => this.cursor < this.items.length || this.done);
      if (this.cursor >= this.items.length) return empty(this.done ? { "X-Reply-Done": "1" } : { "X-Reply-Wait": "1" });
    }

    this.serving = true;
    try {
      const firstSeg = !this.headersSent;
      const complete = this.done || this.finalMsg;
      const partial = !complete;
      const all = () => this.items.map((x) => x.text).join("");
      const shown = firstSeg ? (this.done ? this.reply() : complete ? all() : this.firstText) : complete ? all() : this.items.slice(0, this.cursor + 1).map((x) => x.text).join("");
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
