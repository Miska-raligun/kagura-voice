import { describe, it, expect } from "vitest";
import { Outbox, type PushPolicy } from "../src/agent/outbox.ts";

function setup(o: { presence?: "home" | "away" | null; online?: string[]; role?: Record<string, string>; policy?: PushPolicy } = {}) {
  const st = { presence: o.presence === undefined ? "home" : o.presence, online: o.online ?? ["cores3"], role: o.role ?? { cores3: "main" },
    policy: o.policy ?? "presence" as PushPolicy, pushed: [] as any[] };
  const box = new Outbox({
    policy: () => st.policy, presence: () => st.presence,
    onlineDevices: () => st.online, knownDevices: () => ["cores3", "kitchen"],
    roleAgent: (d) => st.role[d] ?? "main",
    push: async (text, dev, agentId) => { st.pushed.push({ text, dev, agentId }); return true; },
  });
  return { box, st };
}

describe("出口：播不播按策略，由代码决定", () => {
  it("presence：在家播、不在家不播；在家状态未知按在家", async () => {
    const { box, st } = setup();
    expect(await box.say({ text: "早上好", agentId: "main", source: "job" })).toEqual({ played: true, device: "cores3" });
    st.presence = "away";
    expect(await box.say({ text: "该吃药了", agentId: "main", source: "job" })).toEqual({ played: false, reason: "away" });
    st.presence = null;
    expect((await box.say({ text: "关火", agentId: null, source: "reminder" })).played).toBe(true);
    expect(st.pushed.map((p) => p.text)).toEqual(["早上好", "关火"]);
  });

  it("always 不在家也播；never 一律不播", async () => {
    const { box, st } = setup({ presence: "away", policy: "always" });
    expect((await box.say({ text: "a", agentId: "main", source: "x" })).played).toBe(true);
    st.policy = "never"; st.presence = "home";
    expect(await box.say({ text: "b", agentId: "main", source: "x" })).toEqual({ played: false, reason: "policy" });
    expect(box.allowed()).toBe(false);
  });

  it("别的角色的话不扣下：照样推，由设备临时换成那个角色播", async () => {
    const { box, st } = setup();
    expect((await box.say({ text: "我是小澪", agentId: "mio", source: "speak" })).played).toBe(true);
    expect(st.pushed).toEqual([{ text: "我是小澪", dev: "cores3", agentId: "mio" }]);
  });

  it("选设备：点名的 → 当前就是这个角色的 → 任意在线", async () => {
    const { box } = setup({ online: ["cores3", "kitchen"], role: { cores3: "main", kitchen: "mio" } });
    expect(box.pick("mio")).toBe("kitchen");
    expect(box.pick("main")).toBe("cores3");
    expect(box.pick("other")).toBe("cores3");
    expect(box.pick("mio", "cores3")).toBe("cores3");
    expect(box.pick("mio", "fresh")).toBe("fresh");              // 还没发过心跳的新设备照样推
  });

  it("点名的设备见过但掉线了 → 换一台在线的；一台都没有就不播", async () => {
    const { box, st } = setup({ online: ["kitchen"] });
    expect((await box.say({ text: "x", agentId: "main", device: "cores3", source: "job" })).device).toBe("kitchen");
    st.online = [];
    expect(await box.say({ text: "y", agentId: "main", device: "cores3", source: "job" })).toEqual({ played: false, reason: "no-device" });
  });
});
