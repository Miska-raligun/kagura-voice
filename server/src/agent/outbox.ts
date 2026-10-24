// 出口：agent 说给主人听的每一句话都经过这里，由系统决定播不播、播到哪。agent 没有 speak 工具，也不知道这些。
//
//   策略（config.json 的 voice_push）：
//     presence = 在家播、不在家不播（默认；在家状态未知按在家）
//     always   = 总是播
//     never    = 从不播
//   设备：点名的设备 → 当前绑定这个角色的在线设备 → 任意在线设备；同样合适时家里的设备（CoreS3）优先于手机，
//         所以在家时只在 CoreS3 上说，不会两边一起响。
//   手机 / 平板（portable）：页面开着才算在线（没开推了也收不到）；跟着主人走，所以「不在家不播」只管家里的设备——
//         不在家时主动说的话去开着的手机。顺带朗读（mirror，文字已经在 IM / 网页里）和传话（relay，说给家里人听）只走家里的设备。
//   设备当前不是说话的那个角色时（role_push）：
//     hold   = 先留着，设备切到这个角色（问候之后）再播（默认）。mirror（文字已经发到 IM / 网页）的不留，直接不念
//     switch = 照样推，推送带 role，设备播放期间临时换成那个角色的图和音色，播完换回
//   relay（announce 工具）：主人明确让传话给家里人——不看在家状态（本来就是给家里其他人听的），立即播。
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
  /** 主人让传话给家里人（announce 工具）：不看主人在不在家，角色对不上也立即播（用说话角色的形象）；never 仍不播 */
  relay?: boolean;
}
export interface SayResult { played: boolean; held?: boolean; device?: string; reason?: "policy" | "away" | "no-device" | "role" | "failed" }
export interface Held { dev: string; agentId: string; text: string; at: number; source: string }

export interface OutboxDeps {
  policy(): PushPolicy;
  rolePush(): RolePush;
  presence(): "home" | "away" | null;
  onlineDevices(): string[];
  knownDevices(): string[];
  /** 随身设备（配对过的手机 / 平板）：不受「不在家不播」限制，同样合适时排在家里的设备后面 */
  portable?(dev: string): boolean;
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

  private portable(dev: string) { return this.d.portable?.(dev) ?? false; }

  /** 这句话能去的在线设备：家里的看策略和在家状态；手机只要不是 never，但不收顺带朗读和传话 */
  private eligible(s: Pick<Say, "relay" | "mirror">): string[] {
    const homeOk = s.relay ? this.d.policy() !== "never" : this.allowed();
    const portOk = this.d.policy() !== "never" && !s.relay && !s.mirror;
    return this.d.onlineDevices().filter((d) => (this.portable(d) ? portOk : homeOk));
  }

  /** 选设备：点名的（能去、或是还没见过的新设备）→ 当前绑定这个角色的 → 任意能去的；同样合适时家里的设备优先 */
  target(s: Pick<Say, "agentId" | "device" | "relay" | "mirror">): string | undefined {
    const ok = this.eligible(s);
    if (s.device) {
      if (ok.includes(s.device)) return s.device;
      // 还没发过心跳的新设备照样推（但没开页面的手机、不在家时的家里设备不算）
      const fresh = !this.d.knownDevices().includes(s.device) && !this.portable(s.device);
      if (fresh && (s.relay ? this.d.policy() !== "never" : this.allowed())) return s.device;
    }
    const homeFirst = (list: string[]) => list.find((d) => !this.portable(d)) ?? list[0];
    const bound = s.agentId ? ok.filter((d) => this.d.roleAgent(d) === s.agentId) : [];
    return homeFirst(bound) ?? homeFirst(ok);
  }

  /** 兼容旧调用：按默认（非 relay、非 mirror）选设备 */
  pick(agentId: string | null, device?: string): string | undefined { return this.target({ agentId, device }); }

  heldFor(dev?: string) { return dev ? this.held.filter((h) => h.dev === dev) : [...this.held]; }
  clear(dev: string) { this.held = this.held.filter((h) => h.dev !== dev); this.save(); }

  async say(s: Say): Promise<SayResult> {
    const text = s.text.trim();
    if (!text) return { played: false };
    if (this.d.policy() === "never") {
      console.log(`[outbox] 🔇 不播（已关闭语音推送）：${text.slice(0, 40)}`);
      return { played: false, reason: "policy" };
    }
    const dev = this.target(s);
    if (!dev) {
      // 不在家、手机也没开着页面
      if (!s.relay && !this.allowed()) {
        console.log(`[outbox] 🔇 不播（主人不在家，也没有开着的手机页面）：${text.slice(0, 40)}`);
        return { played: false, reason: "away" };
      }
      return { played: false, reason: "no-device" };
    }
    const other = !!s.agentId && this.d.roleAgent(dev) !== s.agentId && this.d.hasRole(s.agentId);
    if (other && !s.relay && this.d.rolePush() === "hold") {
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
