import { describe, it, expect } from "vitest";
import { isLocal } from "../src/routes/admin.ts";
import { Ctx } from "../src/ctx.ts";
import { tmpdir } from "./helpers.ts";

const req = (headers: Record<string, string>, remote = "127.0.0.1", method = "POST"): any => ({
  remoteAddr: remote, method,
  header: (n: string) => headers[Object.keys(headers).find((k) => k.toLowerCase() === n.toLowerCase()) ?? ""] ?? "",
  hasHeader: (n: string) => Object.keys(headers).some((k) => k.toLowerCase() === n.toLowerCase()),
});

describe("管理接口只许本机（防跨站请求 / DNS 重绑定）", () => {
  it("本机 curl、本机页面放行；局域网、跨站网页、恶意域名拒绝", () => {
    expect(isLocal(req({ Host: "127.0.0.1:5000" }))).toBe(true);                                         // curl
    expect(isLocal(req({ Host: "localhost:5080", Origin: "http://localhost:5080", "Sec-Fetch-Site": "same-origin" }))).toBe(true);
    expect(isLocal(req({ Host: "127.0.0.1:5000" }, "192.168.1.5"))).toBe(false);                       // 局域网
    expect(isLocal(req({ Host: "127.0.0.1:5000", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }))).toBe(false);
    expect(isLocal(req({ Host: "127.0.0.1:5000", Origin: "https://evil.example" }))).toBe(false);      // 老浏览器没有 Sec-Fetch-*
    expect(isLocal(req({ Host: "127.0.0.1:5000", Origin: "null" }))).toBe(false);                      // 沙箱 iframe
    expect(isLocal(req({ Host: "evil.example:5000" }))).toBe(false);                                   // DNS 重绑定
    // 经本机反向代理（tailscale serve 等）进来的：来源是 127.0.0.1，但人不在电脑前
    expect(isLocal(req({ Host: "127.0.0.1:5000", "X-Forwarded-For": "100.64.0.9" }))).toBe(false);
    expect(isLocal(req({ Host: "localhost:5000", "Tailscale-User-Login": "me@example.com" }))).toBe(false);
    // 从别的网站点链接打开管理页（顶层导航 GET）可以
    expect(isLocal(req({ Host: "127.0.0.1:5000", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" }, "127.0.0.1", "GET"))).toBe(true);
    expect(isLocal(req({ Host: "127.0.0.1:5000", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" }, "127.0.0.1", "GET"))).toBe(false);
  });
});

describe("受信设备", () => {
  const mk = (mode: "approve" | "all" = "approve") => {
    const c: any = Object.create(Ctx.prototype);
    c.cfg = { dataDir: tmpdir("trust"), deviceTrust: mode };
    c.trust = {};
    return c as Ctx;
  };
  it("第一台自动受信；之后的要批准；必须从心跳的 IP 来；浏览器发来的不算；本机算", () => {
    const c = mk();
    c.noteDevice("cores3", "::ffff:192.168.1.20");
    c.noteDevice("guest", "192.168.1.66");
    expect(c.deviceTrusted(req({}, "192.168.1.20"), "cores3")).toBe(true);
    expect(c.deviceTrusted(req({}, "192.168.1.66"), "cores3")).toBe(false);          // 冒充 id，IP 不对
    expect(c.deviceTrusted(req({}, "192.168.1.66"), "guest")).toBe(false);           // 没批准
    c.setDeviceTrusted("guest", true);
    expect(c.deviceTrusted(req({}, "192.168.1.66"), "guest")).toBe(true);
    expect(c.deviceTrusted(req({ Origin: "https://evil.example" }, "127.0.0.1"), "cores3")).toBe(false);
    expect(c.deviceTrusted(req({}, "127.0.0.1"), "anything")).toBe(true);
    expect(c.deviceTrusted(req({ "X-Forwarded-For": "100.64.0.9" }, "127.0.0.1"), "anything")).toBe(false);   // 经本机代理转进来的不算
    expect(() => c.setDeviceTrusted("nope", true)).toThrow(/没见过/);
    // 落盘、重启后还在
    const c2: any = Object.create(Ctx.prototype);
    c2.cfg = (c as any).cfg;
    c2.loadTrust();
    expect(c2.trust.guest.trusted).toBe(true);
  });

  it("IP 变了：原地址还在活动就不换（防抢绑定），十分钟没动静才换", () => {
    const c = mk();
    c.noteDevice("cores3", "192.168.1.20");
    c.noteDevice("cores3", "192.168.1.99");
    expect(c.trust.cores3.ip).toBe("192.168.1.20");
    c.trust.cores3.last -= 700;
    c.noteDevice("cores3", "192.168.1.99");
    expect(c.trust.cores3.ip).toBe("192.168.1.99");
  });

  it("device_trust=all：全部可信（旧行为）", () => {
    expect(mk("all").deviceTrusted(req({}, "10.0.0.9"), "x")).toBe(true);
  });
});

describe("托盘版可执行文件（PE 子系统）", () => {
  it("读写子系统字段：控制台 3 → 图形界面 2；当前进程读得出来", async () => {
    // @ts-ignore 脚本是 .mjs
    const { getSubsystem, setSubsystem } = await import("../scripts/pe.mjs");
    const { exeSubsystem } = await import("../src/util/wingui.ts");
    const buf = Buffer.alloc(512);
    buf.writeUInt16LE(0x5a4d, 0); buf.writeUInt32LE(0x80, 0x3c); buf.writeUInt32LE(0x4550, 0x80);
    buf.writeUInt16LE(0x20b, 0x80 + 24); buf.writeUInt16LE(3, 0x80 + 24 + 68);
    expect(getSubsystem(buf)).toBe(3);
    setSubsystem(buf, 2);
    expect(getSubsystem(buf)).toBe(2);
    const fs = await import("node:fs");
    const f = tmpdir("pe") + "/x.exe";
    fs.writeFileSync(f, buf);
    expect(exeSubsystem(f)).toBe(2);
    expect(exeSubsystem(process.execPath)).toBe(process.platform === "win32" ? 3 : null);
    expect(() => getSubsystem(Buffer.alloc(100))).toThrow();
  });
});

describe("新版本提醒", () => {
  const rel = (tag: string, extra: any = {}) => ({ tag_name: tag, html_url: `https://x/${tag}`, body: `notes ${tag}`, ...extra });
  it("预览版连预览版一起比；正式版只看正式版；草稿忽略", async () => {
    const { pickLatest, UpdateChecker } = await import("../src/util/update.ts");
    const list = [rel("v0.1.0-beta.18"), rel("v1.0.0-rc.1"), rel("v0.9.0"), rel("v1.0.0", { draft: true })];
    expect(pickLatest("0.1.0-beta.15", list)!.tag).toBe("1.0.0-rc.1");
    expect(pickLatest("0.9.0", list)!.tag).toBe("0.9.0");
    const c = new UpdateChecker("1.0.0-rc.1", (async () => Response.json([rel("v1.0.0"), rel("v1.0.0-rc.2")])) as any);
    expect((await c.check())!).toMatchObject({ latest: "1.0.0", newer: true });
    expect(c.line()).toContain("1.0.0");
    const same = new UpdateChecker("1.0.0", (async () => Response.json([rel("v1.0.0")])) as any);
    expect((await same.check())!.newer).toBe(false);
    const dev = new UpdateChecker("dev", (async () => { throw new Error("不该查"); }) as any);
    expect(await dev.check()).toBe(null);
    const bad = new UpdateChecker("1.0.0", (async () => new Response("x", { status: 500 })) as any);
    expect((await bad.check())!.error).toContain("500");
  });
});
