// QQ（OneBot v11，可选）：连本机 NapCat / LLOneBot 等 OneBot 实现的正向 WebSocket。
// ⚠️ 非官方协议，有封号风险——只作为可选项、默认关闭，管理界面里写明风险。
import WebSocket from "ws";
import type { ChannelAdapter, ChannelStatus, InboundMessage, SendOpts } from "./types.ts";
import { STATUS_INIT } from "./types.ts";
import { stripMarkdown } from "../util/text.ts";

export interface OneBotCreds { url: string; token?: string }

/** 消息段（数组格式或 CQ 码字符串）→ 文本、图片 url、有没有 @ 自己 */
export function parseOneBotMessage(message: any, selfId: string): { text: string; imageUrls: string[]; atMe: boolean } {
  const segs: any[] = Array.isArray(message)
    ? message
    : String(message ?? "").split(/(\[CQ:[^\]]+\])/).filter(Boolean).map((p) => {
      const m = p.match(/^\[CQ:(\w+)((?:,[^,\]]+)*)\]$/);
      if (!m) return { type: "text", data: { text: p } };
      const data: Record<string, string> = {};
      for (const kv of m[2].split(",").filter(Boolean)) { const i = kv.indexOf("="); data[kv.slice(0, i)] = kv.slice(i + 1); }
      return { type: m[1], data };
    });
  let text = "", atMe = false;
  const imageUrls: string[] = [];
  for (const s of segs) {
    if (s.type === "text") text += s.data?.text ?? "";
    else if (s.type === "at") { if (String(s.data?.qq) === String(selfId)) atMe = true; }
    else if (s.type === "image" && s.data?.url) imageUrls.push(s.data.url);
  }
  return { text: text.trim(), imageUrls, atMe };
}

export class OneBotAdapter implements ChannelAdapter {
  readonly kind = "onebot" as const;
  private ws: WebSocket | null = null;
  private st: ChannelStatus = STATUS_INIT();
  private stopped = true;
  private retry = 0;
  private echo = 0;
  private pending = new Map<string, (r: any) => void>();
  private onMessage: (m: InboundMessage) => void = () => {};

  constructor(readonly accountId: string, private creds: OneBotCreds) {}

  status() { return { ...this.st }; }
  private set(state: ChannelStatus["state"], detail = "") { this.st = { state, detail, since: Date.now() / 1000 }; }

  async start(onMessage: (m: InboundMessage) => void) {
    if (!this.creds.url) throw new Error("OneBot 需要 WebSocket 地址（如 ws://127.0.0.1:3001）");
    this.onMessage = onMessage;
    this.stopped = false;
    this.connect();
  }

  async stop() {
    this.stopped = true;
    try { this.ws?.close(); } catch { /* 已关 */ }
    this.ws = null;
    this.set("stopped");
  }

  private connect() {
    this.set("connecting");
    const ws = new WebSocket(this.creds.url, { headers: this.creds.token ? { authorization: `Bearer ${this.creds.token}` } : {} });
    this.ws = ws;
    ws.on("open", () => { this.retry = 0; this.set("online"); });
    ws.on("message", (raw) => {
      let f: any;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (f.echo !== undefined && this.pending.has(String(f.echo))) { this.pending.get(String(f.echo))!(f); this.pending.delete(String(f.echo)); return; }
      if (f.post_type === "message") this.toInbound(f).then((m) => m && this.onMessage(m)).catch((e) => console.log(`[onebot] ⚠️  ${e.message}`));
    });
    ws.on("close", () => {
      if (this.ws !== ws || this.stopped) return;
      this.set("error", "连接断开，重连中");
      setTimeout(() => !this.stopped && this.connect(), Math.min(60, 2 ** this.retry++) * 1000).unref();
    });
    ws.on("error", (e) => { if (this.ws === ws) this.set("error", e.message); });
  }

  async toInbound(f: any): Promise<InboundMessage | null> {
    const { text, imageUrls, atMe } = parseOneBotMessage(f.message ?? f.raw_message, String(f.self_id ?? ""));
    const images: InboundMessage["images"] = [];
    for (const u of imageUrls.slice(0, 4)) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(15_000) });
        if (r.ok) images.push({ data: Buffer.from(await r.arrayBuffer()).toString("base64"), mimeType: r.headers.get("content-type") || "image/jpeg" });
      } catch { /* 图片拉不到就算了 */ }
    }
    const group = f.message_type === "group";
    return {
      kind: "onebot", account: this.accountId, chatType: group ? "group" : "dm",
      chatId: group ? `group:${f.group_id}` : `private:${f.user_id}`, sender: String(f.user_id),
      senderName: f.sender?.card || f.sender?.nickname, text, images, mentionedMe: atMe, messageId: String(f.message_id ?? ""),
    };
  }

  /** 调一个 OneBot 动作并等回执 */
  call(action: string, params: any, timeout = 15_000): Promise<any> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("OneBot 未连接"));
    const echo = String(++this.echo);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(echo); reject(new Error(`${action} 超时`)); }, timeout);
      this.pending.set(echo, (r) => { clearTimeout(t); r.status === "failed" ? reject(new Error(r.wording || r.msg || `${action} 失败`)) : resolve(r.data); });
      this.ws!.send(JSON.stringify({ action, params, echo }));
    });
  }

  async send(chatId: string, text: string, opts: SendOpts = {}) {
    const i = chatId.indexOf(":");
    const [type, id] = [chatId.slice(0, i), chatId.slice(i + 1)];
    const msg: any[] = [];
    if (opts.replyTo) msg.push({ type: "reply", data: { id: opts.replyTo } });
    msg.push({ type: "text", data: { text: stripMarkdown(text) || text } });
    if (opts.image) msg.push({ type: "image", data: { file: `base64://${opts.image.toString("base64")}` } });
    if (type === "group") await this.call("send_group_msg", { group_id: Number(id), message: msg });
    else await this.call("send_private_msg", { user_id: Number(id), message: msg });
  }
}
