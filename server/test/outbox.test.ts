import { describe, it, expect } from "vitest";
import path from "node:path";
import { Outbox } from "../src/agent/outbox.ts";
import { Roles } from "../src/roles.ts";
import { tmpdir } from "./helpers.ts";

function setup(o: { presence?: "home" | "away" | null; online?: string[]; role?: Record<string, string>; im?: string } = {}) {
  const st = { presence: o.presence ?? "home" as any, online: o.online ?? ["cores3"], role: o.role ?? { cores3: "main" }, im: o.im ?? "", busy: false,
    pushed: [] as any[], ims: [] as any[] };
  const box = new Outbox({
    presence: () => st.presence, onlineDevices: () => st.online, knownDevices: () => ["cores3"],
    roleAgent: (d) => st.role[d] ?? "main", agentName: (id) => ({ main: "神乐", mio: "小澪" } as any)[id] ?? id,
    busy: () => st.busy,
    push: async (text, dev, agentId) => { st.pushed.push({ text, dev, agentId }); return true; },
    ownerIm: () => st.im, deliverIm: async (t, text) => { st.ims.push({ t, text }); return true; },
  }, path.join(tmpdir("ob"), "held.json"));
  return { box, st };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("出口：说给主人听的话由代码决定怎么送", () => {
  it("在家、设备正是这个角色 → 播；别的角色 → 留言，不用别人的形象说话", async () => {
    const { box, st } = setup();
    expect(await box.say({ text: "早上好", agentId: "main", kind: "proactive", source: "job" })).toMatchObject({ via: "device", device: "cores3" });
    const r = await box.say({ text: "我是小澪", agentId: "mio", kind: "proactive", source: "speak" });
    expect(r).toMatchObject({ via: "held", device: "cores3" });
    expect(r.note).toContain("小澪");
    expect(st.pushed).toEqual([{ text: "早上好", dev: "cores3", agentId: "main" }]);
    // 顺带念的回复对不上角色就不念，也不留
    expect((await box.say({ text: "x", agentId: "mio", kind: "reply", source: "mirror" })).via).toBe("none");
    expect(box.heldFor("cores3").length).toBe(1);
  });

  it("不在家：主动消息改发主人的 IM；没有 IM 就留言，回家再播；顺带念的回复直接不念", async () => {
    const { box, st } = setup({ presence: "away", im: "feishu:fs:oc_owner" });
    expect(await box.say({ text: "该吃药了", agentId: "main", kind: "proactive", source: "job" })).toMatchObject({ via: "im", target: "feishu:fs:oc_owner" });
    expect(st.ims).toEqual([{ t: "feishu:fs:oc_owner", text: "该吃药了" }]);
    expect((await box.say({ text: "x", agentId: "main", kind: "reply", source: "mirror" })).via).toBe("none");
    st.im = "";
    expect((await box.say({ text: "回来记得关窗", agentId: "main", kind: "proactive", source: "speak" })).via).toBe("held");
    expect(st.pushed).toEqual([]);
    st.presence = "home";
    box.flushAll();
    await wait(1200);
    expect(st.pushed).toEqual([{ text: "回来记得关窗", dev: "cores3", agentId: "main" }]);
    expect(box.heldFor().length).toBe(0);
  });

  it("提醒（不属于哪个 agent）用当前角色播；在家状态未知按在家处理", async () => {
    const { box, st } = setup({ presence: null, role: { cores3: "mio" } });
    expect((await box.say({ text: "关火", agentId: null, kind: "system", device: "cores3", source: "reminder" })).via).toBe("device");
    expect(st.pushed[0]).toEqual({ text: "关火", dev: "cores3", agentId: null });
  });

  it("设备切到这个角色时播出留言（等设备空闲、问候之后），多条合成一段", async () => {
    const dir = tmpdir("ob-roles");
    const roles = new Roles([{ id: "", name: "神乐", agent: "main", per: 111 }, { id: "mio", name: "小澪", agent: "mio", per: 4 }] as any, path.join(dir, "roles.json"));
    const { box, st } = setup();
    st.role = new Proxy({}, { get: (_t, d: string) => roles.get(d).agent }) as any;
    roles.onSwitch = (dev) => box.flush(dev, 10);
    await box.say({ text: "第一句", agentId: "mio", kind: "proactive", source: "a" });
    await box.say({ text: "第二句", agentId: "mio", kind: "proactive", source: "b" });
    await box.say({ text: "神乐的", agentId: "main", kind: "proactive", source: "c" });
    expect(st.pushed.map((p) => p.text)).toEqual(["神乐的"]);
    st.busy = true;
    roles.set("cores3", "mio");
    await wait(300);
    expect(st.pushed.length).toBe(1);              // 设备还在对话里，等它空下来
    st.busy = false;
    await wait(1300);
    expect(st.pushed.at(-1)).toEqual({ text: "有2条留言。第一句。第二句", dev: "cores3", agentId: "mio" });
    roles.set("cores3", "mio");                    // 同一角色再设一次不重复触发
    await wait(100);
    expect(st.pushed.length).toBe(2);
  });

  it("留言落盘，重启后还在", async () => {
    const dir = tmpdir("ob-persist");
    const deps: any = { presence: () => "home", onlineDevices: () => ["cores3"], knownDevices: () => ["cores3"], roleAgent: () => "main", agentName: (x: string) => x,
      busy: () => false, push: async () => true, ownerIm: () => "", deliverIm: async () => false };
    const a = new Outbox(deps, path.join(dir, "h.json"));
    await a.say({ text: "给小澪", agentId: "mio", kind: "proactive", source: "x" });
    expect(new Outbox(deps, path.join(dir, "h.json")).heldFor("cores3").map((h) => h.text)).toEqual(["给小澪"]);
  });
});

describe("出口：点名的设备", () => {
  it("还没发过心跳的设备照样推；见过但掉线的改走 IM / 留言", async () => {
    const { box, st } = setup({ online: [], im: "feishu:fs:oc" });
    expect(await box.say({ text: "新设备", agentId: "main", kind: "proactive", device: "fresh", source: "job" })).toMatchObject({ via: "device", device: "fresh" });
    expect(await box.say({ text: "掉线了", agentId: "main", kind: "proactive", device: "cores3", source: "job" })).toMatchObject({ via: "im" });
  });
});
