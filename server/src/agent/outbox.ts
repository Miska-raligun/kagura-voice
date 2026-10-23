// 出口：所有「用声音说给主人听」的话都经过这里。播不播、播到哪由代码决定，agent 不用管也看不到。
//
//   策略（config.json 的 voice_push）：
//     presence = 在家播、不在家不播（默认；在家状态未知按在家）
//     always   = 总是播
//     never    = 从不播
//   设备：点名的设备 → 当前就是这个角色的在线设备 → 任意在线设备。
//   一台设备多个角色共用时，推送带上说话的角色，设备播放期间临时换成那个角色的图，音色也用它的。
export interface Say { text: string; agentId: string | null; device?: string; source: string }
export interface SayResult { played: boolean; device?: string; reason?: "policy" | "away" | "no-device" | "failed" }

export type PushPolicy = "presence" | "always" | "never";

export interface OutboxDeps {
  policy(): PushPolicy;
  presence(): "home" | "away" | null;
  onlineDevices(): string[];
  knownDevices(): string[];
  /** 设备当前角色对应的 agent */
  roleAgent(dev: string): string;
  /** agentId = null 时用设备当前角色的声音和图 */
  push(text: string, dev: string, agentId: string | null): Promise<boolean>;
}

export class Outbox {
  constructor(private d: OutboxDeps) {}

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
    const ok = await this.d.push(text, dev, s.agentId);
    return ok ? { played: true, device: dev } : { played: false, device: dev, reason: "failed" };
  }
}
