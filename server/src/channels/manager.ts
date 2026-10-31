// 渠道路由：IM 消息 → 安全检查（配对/白名单/群 @/每日上限）→ 按绑定找 agent 与会话 → 跑一轮 → 原路回复。
//
// 会话 key：<agent>:<渠道>:<聊天 id>，同一个 agent 的 MEMORY.md 跨渠道共享（设备上说过的事飞书上也记得）。
// 主人私聊可以并入 main 会话（账号开 owner_main + 白名单里标记 owner）。
import fs from "node:fs";
import path from "node:path";
import type { Runtime } from "../agent/runtime.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { SILENT_RE } from "../agent/scheduler.ts";
import type { ChannelStore } from "./store.ts";
import type { AccountConfig, ChannelAdapter, ChannelKind, InboundMessage } from "./types.ts";
import { FeishuAdapter } from "./feishu.ts";
import { QQAdapter } from "./qq.ts";
import { OneBotAdapter } from "./onebot.ts";
import { runCommand, type CommandDeps } from "./commands.ts";
import { SeenMessages } from "./seen.ts";

/** 晚到多久就在消息前注明（断线后补投的老消息，agent 得知道这不是刚说的） */
const LATE_MS = 5 * 60_000;

/** 渠道回复同时在家里设备上播语音要用的东西（attachAgentSystem 里接上） */
export interface VoiceBridge {
  /** 主人这边收到的回复交给出口顺带念一遍（播不播、播到哪由出口按语音推送策略定） */
  say(agentId: string, text: string, meta?: { announced?: boolean; voice?: string }): Promise<void>;
  /** 这一轮的回复会被念的话，给一个「朗读版写好了就先念」的回调（不会念就 undefined，也就不让她写） */
  early?(agentId: string, source: string): ((text: string) => void) | undefined;
}


export type AdapterFactory = (a: AccountConfig) => ChannelAdapter;

export const defaultFactory: AdapterFactory = (a) => {
  if (a.kind === "feishu") return new FeishuAdapter(a.id, a.credentials as any);
  if (a.kind === "qq") return new QQAdapter(a.id, a.credentials as any);
  return new OneBotAdapter(a.id, a.credentials as any);
};

const PAIRING_REMIND_SECS = 600;

/** 晚到的消息前面注明是多久以前发的 */
function late(m: InboundMessage): string {
  if (!m.sentAt) return "";
  const min = Math.round((Date.now() - m.sentAt) / 60_000);
  return Date.now() - m.sentAt > LATE_MS ? `[这条消息是 ${min} 分钟前发的，网络原因现在才收到] ` : "";
}

export class ChannelManager {
  adapters = new Map<string, ChannelAdapter>();
  private errors = new Map<string, string>();
  private daily = new Map<string, { day: string; n: number; warned: boolean }>();
  private reminded = new Map<string, number>();

  /** 斜杠命令的依赖，attachAgentSystem 里接上（没接就只认 /reset /new） */
  commands: Omit<CommandDeps, "rt" | "agents" | "store"> | null = null;
  /** 主人私聊的回复同时播语音（没接就不播） */
  voice: VoiceBridge | null = null;

  private seen: SeenMessages;

  constructor(public store: ChannelStore, private rt: Runtime, private agents: AgentRegistry, private factory: AdapterFactory = defaultFactory, seenFile: string | null = null) {
    this.seen = new SeenMessages(seenFile);
    this.chatFile = seenFile ? path.join(path.dirname(seenFile), "channels_sessions.json") : null;
    try { if (this.chatFile) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.chatFile, "utf8")))) this.chatSessions.set(k, String(v)); } catch { /* 还没有 */ }
  }

  /** 「账号:聊天」→ 这个聊天用的会话（主人私聊开了 owner_main 时是 <agent>:main）。投递主动消息时据此把话也记进那个会话 */
  private chatSessions = new Map<string, string>();
  private chatFile: string | null;
  private rememberChat(account: string, chatId: string, sessionKey: string) {
    const k = `${account}:${chatId}`;
    if (this.chatSessions.get(k) === sessionKey) return;
    this.chatSessions.set(k, sessionKey);
    if (this.chatFile) { try { fs.writeFileSync(this.chatFile, JSON.stringify(Object.fromEntries(this.chatSessions), null, 1)); } catch { /* 存不下就只在内存里 */ } }
  }

  /** 投递目标（feishu:<账号>:<聊天>）对应 agent 的哪个会话：聊过就用聊天时的那个，没聊过按默认规则 */
  sessionFor(target: string, agentId: string): string | null {
    const i = target.indexOf(":");
    if (i < 0) return null;
    const kind = target.slice(0, i);
    let rest = target.slice(i + 1);
    const acc = this.store.accounts().find((a) => a.kind === kind && rest.startsWith(`${a.id}:`)) ?? this.store.accounts().find((a) => a.kind === kind && a.enabled);
    if (!acc) return null;
    if (rest.startsWith(`${acc.id}:`)) rest = rest.slice(acc.id.length + 1);
    const known = this.chatSessions.get(`${acc.id}:${rest}`);
    return known && known.startsWith(`${agentId}:`) ? known : `${agentId}:${kind}:${rest}`;
  }

  async startAll() {
    for (const a of this.store.accounts()) if (a.enabled) await this.start(a.id);
  }

  async start(id: string) {
    await this.stop(id);
    const a = this.store.account(id);
    if (!a || !a.enabled) return;
    const ad = this.factory(a);
    this.adapters.set(id, ad);
    this.errors.delete(id);
    try {
      await ad.start((m) => {
        // 飞书等是「至少投递一次」：同一条消息可能来两次（重连补投、重启后重投），只处理第一次
        if (!this.seen.first(m.account, m.messageId)) { console.log(`[channel] ↩️  ${id} 重复投递的消息，跳过（${m.messageId}）`); return; }
        this.handle(m).catch((e) => console.log(`[channel] ⚠️  ${id} 处理消息失败: ${e.message}`));
      });
      console.log(`[channel] ${a.kind}/${id} 已启动`);
    } catch (e: any) {
      this.errors.set(id, e.message);
      console.log(`[channel] ⚠️  ${a.kind}/${id} 启动失败: ${e.message}`);
    }
  }

  async stop(id: string) {
    const ad = this.adapters.get(id);
    this.adapters.delete(id);
    if (ad) await ad.stop().catch(() => {});
  }

  async stopAll() { for (const id of [...this.adapters.keys()]) await this.stop(id); this.seen.flush(); }

  status() {
    return this.store.accounts().map((a) => {
      const ad = this.adapters.get(a.id);
      const st = ad?.status() ?? { state: "stopped", detail: "", since: 0 };
      const err = this.errors.get(a.id);
      return { id: a.id, kind: a.kind, name: a.name, enabled: a.enabled, ...(err ? { ...st, state: "error", detail: err } : st) };
    });
  }

  private reply(m: InboundMessage, text: string, image?: Buffer) {
    const ad = this.adapters.get(m.account);
    return ad ? ad.send(m.chatId, text, { replyTo: m.messageId, image }).catch((e) => console.log(`[channel] ⚠️  ${m.account} 回复失败: ${e.message}`)) : Promise.resolve();
  }

  /** 每日回复上限。返回 false = 超了 */
  private quota(a: AccountConfig): boolean {
    if (!a.daily_limit) return true;
    const day = new Date().toDateString();
    const c = this.daily.get(a.id);
    const cur = c && c.day === day ? c : { day, n: 0, warned: false };
    this.daily.set(a.id, cur);
    if (cur.n >= a.daily_limit) return false;
    cur.n++;
    return true;
  }

  /** 收到一条 IM 消息 */
  async handle(m: InboundMessage): Promise<void> {
    const a = this.store.account(m.account);
    if (!a || !a.enabled) return;
    if (!m.text && !m.images.length) return;
    const allowed = this.store.isAllowed(a.id, m.sender);
    if (m.chatType === "group") {
      if (a.group_policy === "off") return;
      if (a.group_policy === "mention" && !m.mentionedMe) return;
    } else if (!allowed && a.dm_policy !== "open") {
      if (a.dm_policy === "allowlist") return;
      // 配对制：发一个码，主人在管理界面批准后才放行。十分钟内不重复提醒
      const p = this.store.requestPairing(a.id, m.sender, m.chatId, m.senderName);
      const key = `${a.id}|${m.sender}`;
      const t = Date.now() / 1000;
      if (t - (this.reminded.get(key) ?? 0) > PAIRING_REMIND_SECS) {
        this.reminded.set(key, t);
        await this.reply(m, `你好！我还不认识你。配对码：${p.code}\n请让主人在 Kagura 管理界面的「渠道」页批准后再来找我。`);
      }
      console.log(`[channel] 🔐 ${a.id} 陌生人 ${m.sender} 申请配对（${p.code}）`);
      return;
    }
    const agentId = [this.store.binding(a.id, m.chatId)?.agent, a.agent].find((x) => x && this.agents.get(x)) ?? this.agents.default().id;
    const ownerMain = a.owner_main && m.chatType === "dm" && !!allowed?.owner;
    const sessionKey = ownerMain ? `${agentId}:main` : `${agentId}:${m.kind}:${m.chatId}`;
    this.rememberChat(a.id, m.chatId, sessionKey);
    if (m.text.trim().startsWith("/")) {
      const owner = !!allowed?.owner;
      const deps: CommandDeps = { rt: this.rt, agents: this.agents, store: this.store, version: "", scheduler: () => null, devices: () => [], channelStatus: () => this.status(), restart: () => {}, ...(this.commands ?? {}) };
      try {
        const out = await runCommand(m.text, { m, owner, agentId, sessionKey }, deps);
        if (out !== null) {
          console.log(`[channel] ⌨️  ${a.kind}/${a.id} ${m.sender}${owner ? "（主人）" : ""}: ${m.text.trim().slice(0, 60)}`);
          await this.reply(m, out);
          return;
        }
      } catch (e: any) { await this.reply(m, `命令出错：${e.message}`); return; }
    }
    if (!this.quota(a)) {
      const c = this.daily.get(a.id)!;
      if (!c.warned) { c.warned = true; await this.reply(m, "今天的对话额度用完了，明天再聊吧。"); }
      return;
    }
    const who = m.chatType === "group" ? `[${m.senderName || m.sender.slice(-6)}] ` : "";
    console.log(`[channel] 💬 ${a.kind}/${a.id} ${m.chatType} ${m.chatId} → ${agentId}: ${m.text.slice(0, 60)}`);
    // 主人私聊的回复同时交给出口念（播不播由系统按语音推送策略定）。群聊、陌生人的消息不往家里喇叭上念
    const ownerDm = m.chatType === "dm" && !!allowed?.owner;
    // 先给这条消息贴个「正在处理」的表情（飞书），回复发出后撤掉。不等它：贴表情慢不能拖慢回复
    const reacting = this.adapters.get(m.account)?.react?.(m.messageId).catch(() => null) ?? Promise.resolve(null);
    let released = false;
    const release = () => { if (!released) { released = true; void reacting.then((undo) => undo?.()); } };
    try {
      const r = await this.rt.run({
        agentId, sessionKey, kind: ownerMain ? "main" : "chat", channel: m.kind, purpose: "chat",
        text: late(m) + who + (m.text || "（发来一张图片）"), images: m.images.map((i) => ({ type: "image" as const, ...i })),
        origin: `${m.kind}:${a.id}:${m.chatId}`,
        // 只有白名单里标了 owner 的人在私聊里说的才可信（能让 agent 执行命令）；群聊、配对的陌生人一律不可信
        trusted: m.chatType === "dm" && !!allowed?.owner,
        // 主人私聊的回复会顺带念：让她先写朗读版，一写完就念，不等正文
        onVoice: ownerDm ? this.voice?.early?.(agentId, "im") : undefined,
      });
      if (!r.text || SILENT_RE.test(r.text)) return;
      // take_photo 在 IM 里触发时，照片直接发回聊天
      const photo = r.meta.photos?.[0];
      await this.reply(m, r.text, photo && fs.existsSync(photo) ? fs.readFileSync(photo) : undefined);
      release();
      // 跑完才判断：主人这条消息里说了「我到家了」（set_presence）也算
      if (ownerDm) await this.voice?.say(agentId, r.text, r.meta);
    } catch (e: any) {
      await this.reply(m, `（出错了：${String(e.message).slice(0, 100)}）`);
    } finally {
      release();
    }
  }

  /**
   * 主动投递（定时任务、子任务结果）。target：<渠道>:<账号>:<聊天 id>，
   * 或 <渠道>:<聊天 id>（用该渠道第一个启用的账号）
   */
  async deliver(target: string, text: string): Promise<boolean> {
    const i = target.indexOf(":");
    const kind = target.slice(0, i) as ChannelKind;
    let rest = target.slice(i + 1);
    let acc = this.store.accounts().find((a) => a.kind === kind && rest.startsWith(`${a.id}:`));
    if (acc) rest = rest.slice(acc.id.length + 1);
    else acc = this.store.accounts().find((a) => a.kind === kind && a.enabled);
    const ad = acc && this.adapters.get(acc.id);
    if (!ad) { console.log(`[channel] ⚠️  投递 ${target} 失败：没有在线的 ${kind} 账号`); return false; }
    try { await ad.send(rest, text); return true; }
    catch (e: any) { console.log(`[channel] ⚠️  投递 ${target} 失败: ${e.message}`); return false; }
  }

  /** 管理界面「测试连接」：重启这个账号，几秒后看状态 */
  async test(id: string, waitMs = 5000) {
    await this.start(id);
    const t = Date.now();
    while (Date.now() - t < waitMs) {
      const s = this.status().find((x) => x.id === id);
      if (s && (s.state === "online" || s.state === "error")) return s;
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.status().find((x) => x.id === id);
  }
}
