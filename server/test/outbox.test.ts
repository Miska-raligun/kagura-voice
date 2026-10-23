import { describe, it, expect } from "vitest";
import path from "node:path";
import { Outbox, type PushPolicy, type RolePush } from "../src/agent/outbox.ts";
import { Roles } from "../src/roles.ts";
import { tmpdir } from "./helpers.ts";

function setup(o: { presence?: "home" | "away" | null; online?: string[]; role?: Record<string, string>; policy?: PushPolicy; rolePush?: RolePush; file?: string } = {}) {
  const st = { presence: o.presence === undefined ? "home" : o.presence, online: o.online ?? ["cores3"], role: o.role ?? { cores3: "main" } as Record<string, string>,
    policy: o.policy ?? "presence" as PushPolicy, rolePush: o.rolePush ?? "hold" as RolePush, busy: false, pushed: [] as any[] };
  const box = new Outbox({
    policy: () => st.policy, rolePush: () => st.rolePush, presence: () => st.presence,
    onlineDevices: () => st.online, knownDevices: () => ["cores3", "kitchen"],
    roleAgent: (d) => st.role[d] ?? "main", hasRole: (a) => a !== "norole", busy: () => st.busy,
    push: async (text, dev, agentId) => { st.pushed.push({ text, dev, agentId }); return true; },
  }, o.file);
  return { box, st };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("出口：播不播按策略，由系统决定", () => {
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
  });

  it("选设备：点名的 → 当前就是这个角色的 → 任意在线", async () => {
    const { box } = setup({ online: ["cores3", "kitchen"], role: { cores3: "main", kitchen: "mio" } });
    expect(box.pick("mio")).toBe("kitchen");
    expect(box.pick("other")).toBe("cores3");
    expect(box.pick("mio", "fresh")).toBe("fresh");              // 还没发过心跳的新设备照样推
  });

  it("点名的设备见过但掉线了 → 换一台在线的；一台都没有就不播", async () => {
    const { box, st } = setup({ online: ["kitchen"] });
    expect((await box.say({ text: "x", agentId: "main", device: "cores3", source: "job" })).device).toBe("kitchen");
    st.online = [];
    expect(await box.say({ text: "y", agentId: "main", device: "cores3", source: "job" })).toEqual({ played: false, reason: "no-device" });
  });
});

describe("出口：设备当前不是说话的角色", () => {
  it("hold（默认）：留着，切到这个角色时（设备空闲、问候之后）播；多条合成一段；mirror 的不留", async () => {
    const roles = new Roles([{ id: "", name: "神乐", agent: "main", per: 111 }, { id: "mio", name: "小澪", agent: "mio", per: 4 }] as any, path.join(tmpdir("ob-roles"), "roles.json"));
    const { box, st } = setup();
    st.role = new Proxy({}, { get: (_t, d: string) => roles.get(d).agent }) as any;
    roles.onSwitch = (dev) => box.flush(dev, 10);
    expect(await box.say({ text: "第一句", agentId: "mio", source: "a" })).toMatchObject({ played: false, held: true, device: "cores3" });
    await box.say({ text: "第二句", agentId: "mio", source: "b" });
    expect(await box.say({ text: "聊天回复", agentId: "mio", mirror: true, source: "im" })).toMatchObject({ played: false, reason: "role" });
    await box.say({ text: "神乐的", agentId: "main", source: "c" });
    await box.say({ text: "没有角色的 agent 用当前形象说", agentId: "norole", source: "d" });
    expect(st.pushed.map((p) => p.text)).toEqual(["神乐的", "没有角色的 agent 用当前形象说"]);
    expect(box.heldFor("cores3").length).toBe(2);
    st.busy = true;
    roles.set("cores3", "mio");
    await wait(300);
    expect(st.pushed.length).toBe(2);              // 设备还在对话里，等它空下来
    st.busy = false;
    await wait(1300);
    expect(st.pushed.at(-1)).toEqual({ text: "有2条留言。第一句。第二句", dev: "cores3", agentId: "mio" });
    expect(box.heldFor().length).toBe(0);
  });

  it("switch：照样推（推送带 role，设备临时换图）", async () => {
    const { box, st } = setup({ rolePush: "switch" });
    expect((await box.say({ text: "我是小澪", agentId: "mio", source: "job" })).played).toBe(true);
    expect(st.pushed).toEqual([{ text: "我是小澪", dev: "cores3", agentId: "mio" }]);
  });

  it("留言落盘，重启后还在", async () => {
    const file = path.join(tmpdir("ob-persist"), "held.json");
    const { box } = setup({ file });
    await box.say({ text: "给小澪", agentId: "mio", source: "x" });
    expect(setup({ file }).box.heldFor("cores3").map((h) => h.text)).toEqual(["给小澪"]);
  });
});
