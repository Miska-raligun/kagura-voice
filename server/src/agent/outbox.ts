// 出口：agent 说给主人听的每一句话都经过这里，由系统决定播不播、播到哪。agent 没有 speak 工具，也不知道这些。
//
//   策略（config.json 的 voice_push）：
//     presence = 在家播、不在家不播（默认；在家状态未知按在家）
//     always   = 总是播
//     never    = 从不播
//   设备：点名的设备 → 当前就是这个角色的在线设备 → 任意在线设备。
//   设备当前不是说话的那个角色时（role_push）：
//     hold   = 先留着，设备切到这个角色（问候之后）再播（默认）。mirror（文字已经发到 IM / 网页）的不留，直接不念
//     switch = 照样推，推送带 role，设备播放期间临时换成那个角色的图和音色，播完换回
//   不经过这里的只有设备自己发起的交互（对设备说话、摇一摇、触摸、ROLE 键）——那时主人就在设备前，角色也对得上。
import fs from "node:fs";

export type PushPolicy = "presence" | "always" | "never";
export type RolePush = "hold" | "switch";

export interface Say {
  text: string;
  agentId: string | null;
  device?: string;
  source: string;
  /** 这段话已经以文字发到 IM / 网页了，这里只是顺带念：角色对不上就不念，也不留 */
  mirror?: boolean;
}
export interface SayResult { played: boolean; held?: boolean; device?: string; reason?: "policy" | "away" | "no-device" | "role" | "failed" }
export interface Held { dev: string; agentId: string; text: string; at: number; source: string }

export interface OutboxDeps {
  policy(): PushPolicy;
  rolePush(): RolePush;
  presence(): "home" | "away" | null;
  onlineDevices(): string[];
  knownDevices(): string[];
  /** 设备当前角色对应的 agent */
  roleAgent(dev: string): string;
  /** 这个 agent 在设备上有没有自己的角色（没有就谈不上「换成它」，直接用当前的图播） */
  hasRole(agentId: string): boolean;
  /** 设备正在对话（这时推过去会被设备丢掉） */
  busy(dev: string): boolean;
  /** agentId = null 时用设备当前角色的声音和图 */
  push(text: string, dev: string, agentId: string | null): Promise<boolean>;
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

  /** 按策略现在该不该出声 */
  allowed(): boolean {
    const p = this.d.policy();
    return p === "always" || (p === "presence" && this.d.presence() !== "away");
  }

  /** 选设备：点名的（除非见过且已掉线）→ 当前角色就是它的 → 任意在线 */
  pick(agentId: string | null, device?: string): string | undefined {
    const online = this.d.onlineDevices();
    if (device && (online.includes(device) || !this.d.knownDevices().includes(device))) return device;
    return (agentId ? online.find((d) => this.d.roleAgent(d) === agentId) : undefined) ?? online[0];
  }

  heldFor(dev?: string) { return dev ? this.held.filter((h) => h.dev === dev) : [...this.held]; }
  clear(dev: string) { this.held = this.held.filter((h) => h.dev !== dev); this.save(); }

  async say(s: Say): Promise<SayResult> {
    const text = s.text.trim();
    if (!text) return { played: false };
    if (!this.allowed()) {
      const reason = this.d.policy() === "never" ? "policy" : "away";
      console.log(`[outbox] 🔇 不播（${reason === "away" ? "主人不在家" : "已关闭语音推送"}）：${text.slice(0, 40)}`);
      return { played: false, reason };
    }
    const dev = this.pick(s.agentId, s.device);
    if (!dev) return { played: false, reason: "no-device" };
    const other = !!s.agentId && this.d.roleAgent(dev) !== s.agentId && this.d.hasRole(s.agentId);
    if (other && this.d.rolePush() === "hold") {
      if (s.mirror) return { played: false, device: dev, reason: "role" };
      const t = Date.now() / 1000;
      this.held = this.held.filter((h) => t - h.at < HOLD_SECS);
      this.held.push({ dev, agentId: s.agentId!, text, at: t, source: s.source });
      while (this.held.length > HOLD_MAX) this.held.shift();
      this.save();
      console.log(`[outbox] 📮 留言（设备 ${dev} 现在不是这个角色）：${text.slice(0, 40)}`);
      return { played: false, held: true, device: dev, reason: "role" };
    }
    const ok = await this.d.push(text, dev, s.agentId);
    return ok ? { played: true, device: dev } : { played: false, device: dev, reason: "failed" };
  }

  /** 设备切到某个角色：把留给这个角色的话播出来（等设备空闲，问候语先播） */
  flush(dev: string, waitMs = 4000) {
    if (!this.held.some((h) => h.dev === dev)) return;
    const go = async () => {
      if (!this.allowed()) return;
      const agent = this.d.roleAgent(dev);
      const due = this.held.filter((h) => h.dev === dev && h.agentId === agent);
      if (!due.length) return;
      this.held = this.held.filter((h) => !due.includes(h));
      this.save();
      const intro = due.length > 1 ? `有${due.length}条留言。` : "";
      console.log(`[outbox] ▶️  ${dev} 播放 ${due.length} 条留言`);
      await this.d.push(intro + due.map((h) => h.text).join("。"), dev, agent);
    };
    const start = Date.now();
    const tick = () => {
      if (this.d.busy(dev) && Date.now() - start < 120_000) { setTimeout(tick, 1000); return; }
      setTimeout(() => { go().catch(() => {}); }, waitMs);
    };
    tick();
  }
}
