// QQ 官方机器人（WebSocket 接入，不需要公网）：鉴权 → gateway → Identify → 心跳 → 收消息 → REST 回复。
// 没有可用于新版私聊/群聊接口的官方 Node SDK，这里自己实现一个精简客户端（M0 结论）。
//
//   私聊 C2C_MESSAGE_CREATE、群里 @ 机器人 GROUP_AT_MESSAGE_CREATE（intents 1<<25）
//   回复：被动回复带 msg_id（5 分钟内有效）；不带 msg_id 是主动推送，有频次限制
//   断线：指数退避重连，有 session_id 就 Resume（不丢消息）
import WebSocket from "ws";
import type { ChannelAdapter, ChannelStatus, InboundMessage, SendOpts } from "./types.ts";
import { STATUS_INIT } from "./types.ts";
import { stripMarkdown } from "../util/text.ts";

export const QQ_DEFAULTS = {
  tokenUrl: "https://bots.qq.com/app/getAppAccessToken",
  api: "https://api.sgroup.qq.com",
  sandboxApi: "https://sandbox.api.sgroup.qq.com",
};
const INTENT_GROUP_AND_C2C = 1 << 25;

export interface QQCreds { app_id: string; secret: string; sandbox?: string; token_url?: string; api_base?: string }

export class QQAdapter implements ChannelAdapter {
  readonly kind = "qq" as const;
  private ws: WebSocket | null = null;
  private st: ChannelStatus = STATUS_INIT();
  private token = "";
  private tokenExp = 0;
  private seq: number | null = null;
  private sessionId = "";
  private hbTimer: NodeJS.Timeout | null = null;
  private retry = 0;
  private stopped = true;
  private msgSeq = 1;
  private onMessage: (m: InboundMessage) => void = () => {};
  /** 机器人自己的 id（READY 里给），过滤自己发的消息 */
  botId = "";

  constructor(readonly accountId: string, private creds: QQCreds) {}

  private get api() {
    return (this.creds.api_base || (this.creds.sandbox === "1" || this.creds.sandbox === "true" ? QQ_DEFAULTS.sandboxApi : QQ_DEFAULTS.api)).replace(/\/$/, "");
  }

  status() { return { ...this.st }; }
  private set(state: ChannelStatus["state"], detail = "") {
    if (this.st.state !== state || this.st.detail !== detail) this.st = { state, detail, since: Date.now() / 1000 };
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    const r = await fetch(this.creds.token_url || QQ_DEFAULTS.tokenUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: this.creds.app_id, clientSecret: this.creds.secret }),
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`QQ 鉴权失败：${j.message ?? j.msg ?? r.status}`);
    this.token = j.access_token;
    this.tokenExp = Date.now() + Number(j.expires_in ?? 7200) * 1000;
    return this.token;
  }

  async request(method: string, path: string, body?: any): Promise<any> {
    const tok = await this.getToken();
    const r = await fetch(this.api + path, {
      method, headers: { authorization: `QQBot ${tok}`, "x-union-appid": this.creds.app_id, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    let j: any = {};
    try { j = text ? JSON.parse(text) : {}; } catch { /* 非 JSON */ }
    if (!r.ok || (j.code && j.code !== 0)) throw new Error(`QQ 接口 ${path} 失败：${j.message ?? text.slice(0, 200) ?? r.status}`);
    return j;
  }

  async start(onMessage: (m: InboundMessage) => void) {
    if (!this.creds.app_id || !this.creds.secret) throw new Error("QQ 机器人需要 app_id 和 secret");
    this.onMessage = onMessage;
    this.stopped = false;
    await this.connect();
  }

  async stop() {
    this.stopped = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    try { this.ws?.close(); } catch { /* 已关 */ }
    this.ws = null;
    this.set("stopped");
  }

  private async connect() {
    this.set("connecting");
    let url: string;
    try {
      url = (await this.request("GET", "/gateway")).url;
    } catch (e: any) {
      this.set("error", e.message);
      this.scheduleReconnect();
      return;
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("message", (raw) => { try { this.onFrame(JSON.parse(String(raw))); } catch (e: any) { console.log(`[qq] ⚠️  帧解析失败: ${e.message}`); } });
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      if (this.hbTimer) clearInterval(this.hbTimer);
      this.hbTimer = null;
      if (!this.stopped) { this.set("error", `连接断开（${code}），重连中`); this.scheduleReconnect(); }
    });
    ws.on("error", (e) => { if (this.ws === ws) this.set("error", e.message); });
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(60, 2 ** this.retry++) * 1000;
    setTimeout(() => { if (!this.stopped) this.connect().catch(() => {}); }, delay).unref();
  }

  private sendFrame(op: number, d: any) { this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ op, d })); }

  private async onFrame(f: any) {
    if (typeof f.s === "number") this.seq = f.s;
    switch (f.op) {
      case 10: {   // Hello：开始心跳，然后 Identify 或 Resume
        const iv = Number(f.d?.heartbeat_interval ?? 41250);
        if (this.hbTimer) clearInterval(this.hbTimer);
        this.hbTimer = setInterval(() => this.sendFrame(1, this.seq), iv);
        this.hbTimer.unref();
        const token = `QQBot ${await this.getToken()}`;
        if (this.sessionId) this.sendFrame(6, { token, session_id: this.sessionId, seq: this.seq ?? 0 });
        else this.sendFrame(2, { token, intents: INTENT_GROUP_AND_C2C, shard: [0, 1], properties: {} });
        return;
      }
      case 7:      // 服务端要求重连（带 Resume）
        this.ws?.close();
        return;
      case 9:      // 会话失效：丢掉 session 重新 Identify
        this.sessionId = ""; this.seq = null;
        this.ws?.close();
        return;
      case 11:
        return;
      case 0:
        if (f.t === "READY") {
          this.sessionId = f.d?.session_id ?? "";
          this.botId = f.d?.user?.id ?? "";
          this.retry = 0;
          this.set("online", f.d?.user?.username ?? "");
          return;
        }
        if (f.t === "RESUMED") { this.retry = 0; this.set("online"); return; }
        const m = await this.toInbound(f.t, f.d);
        if (m) this.onMessage(m);
    }
  }

  async toInbound(t: string, d: any): Promise<InboundMessage | null> {
    if (t !== "C2C_MESSAGE_CREATE" && t !== "GROUP_AT_MESSAGE_CREATE") return null;
    const images: InboundMessage["images"] = [];
    for (const a of d.attachments ?? []) {
      if (!String(a.content_type ?? "").startsWith("image/") || !a.url) continue;
      try {
        const url = /^https?:/.test(a.url) ? a.url : `https://${a.url}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (r.ok) images.push({ data: Buffer.from(await r.arrayBuffer()).toString("base64"), mimeType: a.content_type });
      } catch (e: any) { console.log(`[qq] ⚠️  图片下载失败: ${e.message}`); }
    }
    const group = t === "GROUP_AT_MESSAGE_CREATE";
    return {
      kind: "qq", account: this.accountId, chatType: group ? "group" : "dm",
      chatId: group ? `group:${d.group_openid}` : `c2c:${d.author?.user_openid}`,
      sender: group ? d.author?.member_openid : d.author?.user_openid,
      text: String(d.content ?? "").trim(), images, mentionedMe: group, messageId: d.id,
    };
  }

  async send(chatId: string, text: string, opts: SendOpts = {}) {
    const [type, id] = [chatId.slice(0, chatId.indexOf(":")), chatId.slice(chatId.indexOf(":") + 1)];
    const path = type === "group" ? `/v2/groups/${id}/messages` : type === "c2c" ? `/v2/users/${id}/messages` : "";
    if (!path || !id) throw new Error(`QQ 聊天 id 格式不对：${chatId}`);
    // QQ 普通消息不渲染 markdown；图片要先上传到公网地址才能发，本期只发文字
    const body: any = { content: stripMarkdown(text) || text, msg_type: 0, msg_seq: this.msgSeq++ };
    if (opts.replyTo) body.msg_id = opts.replyTo;
    await this.request("POST", path, body);
  }
}
