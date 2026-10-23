import { describe, expect, it } from "vitest";
import net from "node:net";
import {
  preflight, probePort, pidFromNetstat, ownerFromSs, ownerFromLsof, portproxyPorts, classify,
  type Owner, type PortNeed, type PreflightIO,
} from "../src/startup/preflight.ts";

const NEEDS: PortNeed[] = [
  { what: "HTTP", port: 5000, proto: "tcp", required: true },
  { what: "MQTT", port: 1883, proto: "tcp", required: true },
  { what: "直播", port: 5002, proto: "tcp", required: true },
  { what: "发现", port: 5001, proto: "udp", required: false },
];

/** 假平台：busy 里的端口被 owners 里的东西占着；修复动作把对应端口放出来 */
function fakeIO(o: { busy: number[]; owners: Record<number, Owner>; health?: any; answers?: string[]; interactive?: boolean }) {
  const busy = new Set(o.busy);
  const answers = [...(o.answers ?? [])];
  const log: string[] = [];
  const did: string[] = [];
  const free = (pred: (p: number) => boolean) => { for (const p of [...busy]) if (pred(p)) busy.delete(p); };
  const io: PreflightIO = {
    probe: async (n) => !busy.has(n.port),
    owner: (n) => o.owners[n.port] ?? { kind: "unknown", pid: 0, name: "" },
    health: async () => o.health ?? null,
    ask: async (q) => { log.push(q); return answers.shift() ?? "q"; },
    log: (l) => log.push(l),
    interactive: o.interactive ?? true,
    killPid: (pid) => { did.push(`kill ${pid}`); free((p) => o.owners[p]?.pid === pid); return true; },
    stopMosquitto: (pid) => { did.push(`mosq ${pid}`); free((p) => o.owners[p]?.pid === pid); return true; },
    deletePortproxy: (ports) => { did.push(`proxy ${ports.join(",")}`); free((p) => ports.includes(p)); return true; },
    openAdmin: (url) => did.push(`open ${url}`),
  };
  return { io, log, did };
}

const PROXY: Owner = { kind: "portproxy", pid: 4400, name: "svchost.exe" };

describe("启动前端口体检", () => {
  it("都空闲直接过", async () => {
    const f = fakeIO({ busy: [], owners: {} });
    expect(await preflight(NEEDS, 5000, "u", f.io)).toBe("ok");
    expect(f.log).toEqual([]);
  });

  it("已经有 Kagura 在跑：不算错误，回车打开管理界面", async () => {
    const f = fakeIO({ busy: [5000, 1883, 5002], owners: {}, health: { app: "kagura", version: "1.0", pid: 77 }, answers: [""] });
    expect(await preflight(NEEDS, 5000, "http://localhost:5000/admin", f.io)).toBe("already-running");
    expect(f.did).toEqual(["open http://localhost:5000/admin"]);
    expect(f.log.join("\n")).toContain("已经在运行");
  });

  it("已经有 Kagura 在跑，选 R：结束它后重新检测通过", async () => {
    const owners = { 5000: { kind: "kagura", pid: 77, name: "kagura.exe" } as Owner, 1883: { kind: "kagura", pid: 77, name: "kagura.exe" } as Owner };
    const f = fakeIO({ busy: [5000, 1883], owners, health: { app: "kagura", pid: 77 }, answers: ["r"] });
    expect(await preflight(NEEDS, 5000, "u", f.io)).toBe("ok");
    expect(f.did).toEqual(["kill 77"]);
  });

  it("旧的 WSL 端口转发 + mosquitto：列出来，回车全部处理，再检测通过", async () => {
    const mosq: Owner = { kind: "mosquitto", pid: 900, name: "mosquitto.exe" };
    const f = fakeIO({ busy: [5000, 5002, 1883], owners: { 5000: PROXY, 5002: PROXY, 1883: mosq }, answers: [""] });
    expect(await preflight(NEEDS, 5000, "u", f.io)).toBe("ok");
    expect(f.did).toEqual(["proxy 5000,5002", "mosq 900"]);
    const text = f.log.join("\n");
    expect(text).toContain("WSL 端口转发");
    expect(text).toContain("全部处理");
  });

  it("只选其中一项：处理完还有占用就再问一轮", async () => {
    const py: Owner = { kind: "process", pid: 321, name: "python.exe" };
    const f = fakeIO({ busy: [5000, 1883], owners: { 5000: py, 1883: PROXY }, answers: ["2", "1"] });
    expect(await preflight(NEEDS, 5000, "u", f.io)).toBe("ok");
    expect(f.did).toEqual(["kill 321", "proxy 1883"]);
  });

  it("旧版 voice_server.py 占着 5000：提示出来", async () => {
    const f = fakeIO({ busy: [5000], owners: { 5000: { kind: "process", pid: 5, name: "python3" } }, health: { status: "ok" }, answers: ["q"] });
    expect(await preflight(NEEDS, 5000, "u", f.io)).toBe("exit");
    expect(f.log.join("\n")).toContain("voice_server.py");
  });

  it("只有 UDP 发现被占：可以选择继续启动", async () => {
    const f = fakeIO({ busy: [5001], owners: { 5001: { kind: "process", pid: 8, name: "python.exe" } }, answers: ["c"] });
    expect(await preflight(NEEDS, 5000, "u", f.io)).toBe("ok");
    expect(f.did).toEqual([]);
  });

  it("不是交互窗口（开机自启/服务）：不问，必需端口被占就退出", async () => {
    const f = fakeIO({ busy: [1883], owners: { 1883: PROXY }, interactive: false });
    expect(await preflight(NEEDS, 5000, "u", f.io)).toBe("exit");
    expect(f.log.join("\n")).toContain("1883");
    const g = fakeIO({ busy: [5000], owners: {}, health: { app: "kagura" }, interactive: false });
    expect(await preflight(NEEDS, 5000, "u", g.io)).toBe("already-running");
  });
});

describe("占用者识别", () => {
  it("netstat -ano（Windows）", () => {
    const out = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:1883           0.0.0.0:0              LISTENING       4120",
      "  TCP    127.0.0.1:50000        127.0.0.1:1883         ESTABLISHED     999",
      "  TCP    [::]:5000              [::]:0                 LISTENING       3300",
      "  UDP    0.0.0.0:5001           *:*                                    2200",
    ].join("\r\n");
    expect(pidFromNetstat(out, 1883, "tcp")).toBe(4120);
    expect(pidFromNetstat(out, 5000, "tcp")).toBe(3300);
    expect(pidFromNetstat(out, 5001, "udp")).toBe(2200);
    expect(pidFromNetstat(out, 5002, "tcp")).toBe(0);
  });

  it("netsh portproxy show v4tov4", () => {
    const out = [
      "侦听 ipv4:                 连接到 ipv4:", "", "地址            端口        地址            端口",
      "--------------- ----------  --------------- ----------",
      "0.0.0.0         5000        172.20.1.2      5000",
      "0.0.0.0         1883        172.20.1.2      1883",
    ].join("\r\n");
    expect(portproxyPorts(out)).toEqual([5000, 1883]);
  });

  it("ss -lntp（Linux）与归类", () => {
    expect(ownerFromSs('LISTEN 0 100 0.0.0.0:1883 0.0.0.0:* users:(("mosquitto",pid=812,fd=5))')).toEqual({ name: "mosquitto", pid: 812 });
    expect(ownerFromSs("LISTEN 0 100 0.0.0.0:1883 0.0.0.0:*")).toEqual({ name: "", pid: 0 });
    expect(ownerFromLsof("p812\ncmosquitto\nf5\n")).toEqual({ pid: 812, name: "mosquitto" });
    expect(ownerFromLsof("")).toEqual({ pid: 0, name: "" });
    expect(classify("mosquitto.exe", 1, false).kind).toBe("mosquitto");
    expect(classify("kagura.exe", 1, false).kind).toBe("kagura");
    expect(classify("svchost.exe", 1, true).kind).toBe("portproxy");
    expect(classify("", 0, false).kind).toBe("unknown");
  });

  it("probePort 真的能发现占用", async () => {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, "0.0.0.0", () => r()));
    const port = (s.address() as net.AddressInfo).port;
    expect(await probePort({ what: "x", port, proto: "tcp", required: true })).toBe(false);
    await new Promise((r) => s.close(r));
    expect(await probePort({ what: "x", port, proto: "tcp", required: true })).toBe(true);
  });
});
