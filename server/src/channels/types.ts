// IM 渠道（§6.12）：每个渠道一个适配器，实现 start / stop / send / status。
// 进来的消息统一成 InboundMessage，交给 ChannelManager 按绑定找 agent 和会话；回复由同一个适配器发回去。

export type ChannelKind = "feishu" | "qq" | "onebot";

export interface InboundMessage {
  kind: ChannelKind;
  /** 渠道账号 id（channels.json 里的 accounts[].id） */
  account: string;
  chatType: "dm" | "group";
  /** 发回去用的聊天 id（适配器自己定义格式，对外不透明） */
  chatId: string;
  /** 发送者在该渠道里的唯一 id（配对、白名单按它） */
  sender: string;
  senderName?: string;
  text: string;
  images: { data: string; mimeType: string }[];
  /** 群里是否 @ 了机器人 */
  mentionedMe: boolean;
  messageId: string;
}

export interface SendOpts {
  /** 回复哪条消息（QQ 被动回复必须带，5 分钟内有效） */
  replyTo?: string;
  /** 附一张图（JPEG） */
  image?: Buffer;
}

export interface ChannelStatus {
  state: "stopped" | "connecting" | "online" | "error";
  detail: string;
  since: number;
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  readonly accountId: string;
  start(onMessage: (m: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, text: string, opts?: SendOpts): Promise<void>;
  status(): ChannelStatus;
}

export interface AccountConfig {
  id: string;
  kind: ChannelKind;
  name: string;
  enabled: boolean;
  /** 渠道凭据：飞书 app_id/app_secret；QQ app_id/secret；OneBot url/token */
  credentials: Record<string, string>;
  /** 这个账号默认交给哪个 agent（空 = 默认 agent） */
  agent: string;
  /** 私聊策略：pairing（陌生人要配对码，主人批准）/ allowlist（只认白名单）/ open（完全开放） */
  dm_policy: "pairing" | "allowlist" | "open";
  /** 群聊策略：mention（只响应 @ 机器人）/ all / off */
  group_policy: "mention" | "all" | "off";
  /** 主人的私聊并入 agent 的 main 会话（与设备、heartbeat 共享上下文） */
  owner_main: boolean;
  /** 每天最多回复多少条（防陌生人刷额度），0 = 不限 */
  daily_limit: number;
  /**
   * 主人私聊的回复要不要同时在家里设备上用语音播（代码判断，不靠模型自觉）：
   * home = 在家才播（默认）/ always = 总是播 / off = 不播（模型仍可自己调 speak）
   */
  voice_push: "home" | "always" | "off";
}

export const STATUS_INIT = (): ChannelStatus => ({ state: "stopped", detail: "", since: Date.now() / 1000 });
