// 飞书 / Lark：官方 SDK 的长连接（WebSocket）收 im.message.receive_v1，不需要公网地址。
// 回复用富文本 post + md 标签（飞书会渲染 markdown）；图片先上传拿 image_key 再发。
import * as Lark from "@larksuiteoapi/node-sdk";
import type { ChannelAdapter, ChannelStatus, InboundMessage, SendOpts } from "./types.ts";
import { STATUS_INIT } from "./types.ts";

export interface FeishuCreds { app_id: string; app_secret: string; domain?: string }

/** 依赖注入点：测试里换成假的 client / 长连接 */
export interface FeishuDeps {
  client: any;
  ws: { start(p: { eventDispatcher: any }): Promise<void>; close(p?: any): void; getConnectionStatus?(): { state: string } };
  dispatcher: (handler: (data: any) => Promise<void>) => any;
}

function realDeps(c: FeishuCreds, hooks: { ready: () => void; reconnecting: () => void; error: (e: Error) => void }): FeishuDeps {
  const domain = c.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
  return {
    client: new Lark.Client({ appId: c.app_id, appSecret: c.app_secret, domain, loggerLevel: Lark.LoggerLevel.error }),
    ws: new Lark.WSClient({
      appId: c.app_id, appSecret: c.app_secret, domain, loggerLevel: Lark.LoggerLevel.error, autoReconnect: true,
      onReady: hooks.ready, onReconnected: hooks.ready, onReconnecting: hooks.reconnecting, onError: hooks.error,
    }),
    dispatcher: (handler) => new Lark.EventDispatcher({}).register({ "im.message.receive_v1": handler }),
  };
}

/** 飞书消息 content（JSON 串）→ 纯文本 + 图片 key。text 里的 @_user_N 占位去掉 */
export function parseFeishuContent(type: string, content: string): { text: string; imageKeys: string[] } {
  let c: any = {};
  try { c = JSON.parse(content || "{}"); } catch { /* 坏数据 */ }
  if (type === "text") return { text: String(c.text ?? "").replace(/@_user_\d+/g, "").trim(), imageKeys: [] };
  if (type === "image") return { text: "", imageKeys: c.image_key ? [c.image_key] : [] };
  if (type === "post") {
    const body = c.content ? c : (c.zh_cn ?? c.en_us ?? Object.values(c)[0] ?? {});
    const parts: string[] = body.title ? [body.title] : [];
    const keys: string[] = [];
    for (const line of body.content ?? []) {
      parts.push((line as any[]).map((el) => {
        if (el.tag === "text" || el.tag === "md") return el.text ?? "";
        if (el.tag === "a") return el.text ?? el.href ?? "";
        if (el.tag === "img" && el.image_key) keys.push(el.image_key);
        return "";
      }).join(""));
    }
    return { text: parts.join("\n").replace(/@_user_\d+/g, "").trim(), imageKeys: keys };
  }
  return { text: `[${type} 消息，暂不支持]`, imageKeys: [] };
}

async function streamToBuffer(s: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

export class FeishuAdapter implements ChannelAdapter {
  readonly kind = "feishu" as const;
  private st: ChannelStatus = STATUS_INIT();
  private deps: FeishuDeps | null = null;
  botOpenId = "";

  constructor(readonly accountId: string, private creds: FeishuCreds, private inject?: FeishuDeps) {}

  status() {
    const s = this.deps?.ws.getConnectionStatus?.().state;
    if (s === "connected" && this.st.state !== "online") this.set("online");
    return { ...this.st };
  }
  private set(state: ChannelStatus["state"], detail = "") { this.st = { state, detail, since: Date.now() / 1000 }; }

  async start(onMessage: (m: InboundMessage) => void) {
    if (!this.creds.app_id || !this.creds.app_secret) throw new Error("飞书需要 app_id 和 app_secret");
    this.set("connecting");
    this.deps = this.inject ?? realDeps(this.creds, {
      ready: () => this.set("online"),
      reconnecting: () => this.set("connecting", "重连中"),
      error: (e) => this.set("error", e.message),
    });
    try {
      const info: any = await this.deps.client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
      this.botOpenId = info?.bot?.open_id ?? info?.data?.bot?.open_id ?? "";
    } catch (e: any) { console.log(`[feishu] ⚠️  取机器人信息失败（群里 @ 判断会放宽）: ${e.message}`); }
    const handler = async (data: any) => {
      try { const m = await this.toInbound(data); if (m) onMessage(m); }
      catch (e: any) { console.log(`[feishu] ⚠️  消息处理失败: ${e.message}`); }
    };
    await this.deps.ws.start({ eventDispatcher: this.deps.dispatcher(handler) });
    if (this.inject) this.set("online");
  }

  async stop() {
    try { this.deps?.ws.close({ force: true }); } catch { /* 已关 */ }
    this.set("stopped");
  }

  async toInbound(data: any): Promise<InboundMessage | null> {
    const msg = data?.message;
    if (!msg || data?.sender?.sender_type === "app") return null;     // 机器人自己发的
    const { text, imageKeys } = parseFeishuContent(msg.message_type, msg.content);
    const mentions: any[] = msg.mentions ?? [];
    const mentionedMe = mentions.some((m) => (this.botOpenId ? m.id?.open_id === this.botOpenId : true));
    const images: InboundMessage["images"] = [];
    for (const key of imageKeys.slice(0, 4)) {
      try {
        const res = await this.deps!.client.im.messageResource.get({ path: { message_id: msg.message_id, file_key: key }, params: { type: "image" } });
        const buf = await streamToBuffer(res.getReadableStream());
        images.push({ data: buf.toString("base64"), mimeType: "image/jpeg" });
      } catch (e: any) { console.log(`[feishu] ⚠️  图片下载失败: ${e.message}`); }
    }
    return {
      kind: "feishu", account: this.accountId, chatType: msg.chat_type === "p2p" ? "dm" : "group",
      chatId: msg.chat_id, sender: data.sender?.sender_id?.open_id ?? "", text, images, mentionedMe, messageId: msg.message_id,
      ...(Number(msg.create_time) > 0 ? { sentAt: Number(msg.create_time) } : {}),
    };
  }

  /** 收到消息先贴个「敲键盘」表情表示在处理（同 OpenClaw），回复后撤掉。需要应用开通「消息表情回复」权限，没开就静默跳过 */
  async react(messageId: string): Promise<(() => Promise<void>) | null> {
    const c = this.deps?.client;
    if (!c || !messageId) return null;
    try {
      const r: any = await c.im.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: "Typing" } } });
      const id = r?.data?.reaction_id ?? r?.reaction_id;
      if (r?.code || !id) { if (r?.code) console.log(`[feishu] 贴表情失败（检查应用权限 im:message.reactions:write_only）: ${r.code} ${r.msg ?? ""}`); return null; }
      return async () => { try { await c.im.messageReaction.delete({ path: { message_id: messageId, reaction_id: id } }); } catch { /* 撤不掉就留着 */ } };
    } catch (e: any) {
      console.log(`[feishu] 贴表情失败（检查应用权限 im:message.reactions:write_only）: ${e.message}`);
      return null;
    }
  }

  async send(chatId: string, text: string, opts: SendOpts = {}) {
    const c = this.deps?.client;
    if (!c) throw new Error("飞书账号未启动");
    const post = { msg_type: "post", content: JSON.stringify({ zh_cn: { content: [[{ tag: "md", text }]] } }) };
    if (opts.replyTo) await c.im.message.reply({ path: { message_id: opts.replyTo }, data: post });
    else await c.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, ...post } });
    if (opts.image) {
      const up: any = await c.im.image.create({ data: { image_type: "message", image: opts.image } });
      const key = up?.image_key ?? up?.data?.image_key;
      if (key) await c.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "image", content: JSON.stringify({ image_key: key }) } });
    }
  }
}
