// 按场景的工具权限：群聊 / 陌生人只给白名单，碰家里设备、主人隐私的工具配置也加不上；其它场景默认全给、可单独关
import { describe, it, expect, afterEach } from "vitest";
import { makeRuntime } from "./helpers.ts";
import { deviceTools } from "../src/agent/tools/device.ts";
import { applyToolPolicy, toolAllowed, guestLocked, DEFAULT_GUEST_TOOLS } from "../src/agent/toolpolicy.ts";

const scope = (p: any = {}): any => ({ agentId: "main", sessionKey: "main:feishu:g1", kind: "chat", channel: "feishu", purpose: "chat", hop: 0, chain: [], meta: {}, trusted: false, ...p });

function rt() {
  const { rt, reg } = makeRuntime();
  rt.addTools(deviceTools({
    announce: async () => ({ played: true }), captureAndWait: async () => ["", "x"], presence: () => "在家", setPresence: () => {},
    schedules: { list: () => [] } as any, defaultDevice: () => "cores3",
  }));
  rt.addTools(() => [{ name: "mcp_weather", label: "天气", description: "", parameters: {} as any, execute: async () => ({ content: [] }) } as any], { plugin: true });
  const names = (s: any) => (rt as any).toolsFor(s, reg.get("main")!, { text: "" }).map((t: any) => t.name) as string[];
  return { names };
}

afterEach(() => applyToolPolicy(null));

describe("工具权限", () => {
  it("陌生人：拍照、在家状态、定时拍照都没有；只给白名单（插件里标了陌生人可用的照给）", () => {
    const { names } = rt();
    const g = names(scope());
    for (const n of ["take_photo", "get_presence", "photo_schedule_add", "photo_schedule_list"]) expect(g).not.toContain(n);
    expect(g).toContain("mcp_weather");
    const owner = names(scope({ trusted: true, sessionKey: "main:main", kind: "main" }));
    for (const n of ["take_photo", "get_presence", "set_presence", "photo_schedule_add"]) expect(owner).toContain(n);
  });

  it("配置：陌生人白名单加不上高危工具；其它场景可以单独关", () => {
    applyToolPolicy({ guest: ["take_photo", "get_presence", "exec", "memory_get", "sessions_history", "set_volume"], deny: { task: ["take_photo"], guest: ["mcp_weather"] } });
    const { names } = rt();
    const g = names(scope());
    expect(g).toContain("set_volume");
    for (const n of ["take_photo", "get_presence", "mcp_weather"]) expect(g).not.toContain(n);
    expect(names(scope({ trusted: true, purpose: "task", kind: "isolated" }))).not.toContain("take_photo");
    expect(names(scope({ trusted: true }))).toContain("take_photo");
    expect(toolAllowed("guest", "exec", false)).toBe(false);
    expect(DEFAULT_GUEST_TOOLS.every((n) => !guestLocked(n))).toBe(true);
    for (const n of ["exec", "take_photo", "get_presence", "sessions_history", "memory_write", "cron_add", "task_add", "extension_write", "package_install", "photo_schedule_add"]) expect(guestLocked(n)).toBe(true);
  });
});
