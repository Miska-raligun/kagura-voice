// 出口：所有「用声音说给主人听」的话都经过这里，由代码决定怎么送到，不靠提示词劝模型。
//
//   主人不在家      → 主动消息改发到主人最近用的 IM 私聊（文字）；没配 IM 就留着，回家时再播
//   设备不是这个角色 → 不用别人的形象说话：留着，等设备切到这个角色（问候之后）再播
//   都对得上        → 推到设备上播
//
//   kind：proactive = 主动开口（speak 工具、定时任务、heartbeat、子任务结果）
//         reply     = 已经在聊天里回过文字、顺带念一遍（IM / 网页聊天）——对不上就不念，也不留
//         system    = 不属于任何 agent（提醒）：用设备当前角色的声音，只看在家状态
// 在家状态未知（设备还没上报过）按在家处理，和以前的行为一致。
import fs from "node:fs";

export type SayKind = "proactive" | "reply" | "system";
export interface Say { text: string; agentId: string | null; kind: SayKind; device?: string; source: string }
export interface SayResult { via: "device" | "im" | "held" | "none"; device?: string; target?: string; note: string }
export interface Held { dev: string; agentId: string | null; text: string; at: number; reason: "role" | "away"; source: string }

export interface OutboxDeps {
  presence(): "home" | "away" | null;
  onlineDevices(): string[];
  knownDevices(): string[];
  /** 设备当前角色对应的 agent */
  roleAgent(dev: string): string;
  agentName(agentId: string): string;
  /** 设备正在对话（这时推过去会被设备丢掉） */
  busy(dev: string): boolean;
  push(text: string, dev: string, agentId: string | null): Promise<boolean>;
  ownerIm(): string;
  deliverIm(target: string, text: string): Promise<boolean>;
}

const HOLD_MAX = 30;
const HOLD_SECS = 24 * 3600;

export class Outbox {
  private held: Held[] = [];
  constructor(private d: OutboxDeps, private file?: string) {
    if (file) try { this.held = JSON.parse(fs.readFileSync(file, "utf8")); } catch { this.held = []; }
  }

  private save() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file, JSON.stringify(this.held)); } catch { /* 下次再存 */ }
  }

  private hold(h: Omit<Held, "at">): SayResult {
    const t = Date.now() / 1000;
    this.held = this.held.filter((x) => t - x.at < HOLD_SECS);
    this.held.push({ ...h, at: t });
    while (this.held.length > HOLD_MAX) this.held.shift();
    this.save();
    const who = h.agentId ? this.d.agentName(h.agentId) : "";
    console.log(`[outbox] 📮 留言（${h.reason === "away" ? "主人不在家" : `设备 ${h.dev} 现在不是${who}`}）：${h.text.slice(0, 40)}`);
    return {
      via: "held", device: h.dev,
      note: h.reason === "away" ? "主人不在家（也没有可用的 IM），这句话先留着，主人回家后在设备上播。"
        : `设备 ${h.dev} 现在显示的是别的角色，这句话先留着，切到${who}时再播。`,
    };
  }

  heldFor(dev?: string) { return dev ? this.held.filter((h) => h.dev === dev) : [...this.held]; }
  clear(dev: string) { this.held = this.held.filter((h) => h.dev !== dev); this.save(); }

  async say(s: Say): Promise<SayResult> {
    const text = s.text.trim();
    if (!text) return { via: "none", note: "没有内容" };
    const presence = this.d.presence();
    // 1. 不在家：主动消息改走 IM；顺带念的回复本来就发过文字了，不用管
    if (presence === "away" && s.kind !== "reply") {
      const im = this.d.ownerIm();
      if (im && (await this.d.deliverIm(im, text))) {
        console.log(`[outbox] 📱 主人不在家，改发到 ${im}：${text.slice(0, 40)}`);
        return { via: "im", target: im, note: `主人不在家，已改发到 IM 私聊（${im.split(":")[0]}）。` };
      }
      const dev = s.device ?? this.pickAny();
      return dev ? this.hold({ dev, agentId: s.agentId, text, reason: "away", source: s.source }) : { via: "none", note: "主人不在家，也没有可用的 IM 和设备，没送出去。" };
    }
    if (presence === "away") return { via: "none", note: "主人不在家，不念" };
    // 2. 在家（或不知道）：找当前角色正是这个 agent 的设备
    const online = this.d.onlineDevices();
    const fits = (dev: string) => !s.agentId || s.kind === "system" || this.d.roleAgent(dev) === s.agentId;
    let dev = s.device;
    // 点名的设备：只有「见过、但已经掉线」才放弃；没发过心跳的（刚开机、还没到第一次心跳）照样推，MQTT 连着就能收到
    if (dev && !online.includes(dev) && this.d.knownDevices().includes(dev)) dev = undefined;
    if (!dev) dev = online.find(fits) ?? (s.kind === "system" ? online[0] : undefined);
    if (dev && fits(dev)) {
      const ok = await this.d.push(text, dev, s.kind === "system" ? null : s.agentId);
      return ok ? { via: "device", device: dev, note: `已在 ${dev} 上播出。` } : { via: "none", device: dev, note: "播报失败：设备不在线或语音合成失败。" };
    }
    if (s.kind === "reply") return { via: "none", note: "没有显示这个角色的在线设备，不念" };
    // 3. 设备显示的是别的角色：留着；一台在线设备都没有就改走 IM
    // 有在线设备（只是角色不对）才留在设备上；一台在线的都没有就先试 IM
    const target = dev ?? (online.length ? (s.device && online.includes(s.device) ? s.device : online[0]) : undefined);
    if (target) return this.hold({ dev: target, agentId: s.agentId, text, reason: "role", source: s.source });
    const im = this.d.ownerIm();
    if (im && (await this.d.deliverIm(im, text))) return { via: "im", target: im, note: "设备不在线，已改发到 IM 私聊。" };
    const known = this.d.knownDevices()[0];
    return known ? this.hold({ dev: known, agentId: s.agentId, text, reason: "role", source: s.source }) : { via: "none", note: "没有设备也没有 IM，没送出去。" };
  }

  private pickAny() { return this.d.onlineDevices()[0] ?? this.d.knownDevices()[0]; }

  /** 设备切到某个角色 / 主人回家：把能播的留言播出来（等设备空闲，问候语先播） */
  flush(dev: string, waitMs = 4000) {
    const go = async () => {
      if (this.d.presence() === "away") return;
      const agent = this.d.roleAgent(dev);
      const due = this.held.filter((h) => h.dev === dev && (h.agentId === null || h.agentId === agent));
      if (!due.length) return;
      this.held = this.held.filter((h) => !due.includes(h));
      this.save();
      const intro = due.length > 1 ? `有${due.length}条留言。` : "";
      const body = due.map((h) => h.text).join("。");
      console.log(`[outbox] ▶️  ${dev} 播放 ${due.length} 条留言`);
      await this.d.push(intro + body, dev, agent);
    };
    const start = Date.now();
    const tick = () => {
      if (this.d.busy(dev) && Date.now() - start < 120_000) { setTimeout(tick, 1000); return; }
      setTimeout(() => { go().catch(() => {}); }, waitMs);
    };
    tick();
  }

  /** 主人回家：每台设备都看看有没有能播的 */
  flushAll() { for (const dev of new Set(this.held.map((h) => h.dev))) this.flush(dev, 1000); }
}
