// 启动前的端口体检：先把要用的端口全试一遍，被占了就查出是谁占的，在窗口里问用户怎么处理。
//
// 为什么要这一步：Windows 上双击 kagura.exe，出错退出时控制台窗口跟着就关了，用户只看见「闪了一下」。
// 最常见的三种占用：
//   1. 已经有一个 Kagura 在跑（开机自启的那个）——不是错误，直接打开管理界面
//   2. 旧方案的 WSL 端口转发（openclaw-startup.ps1 加的 netsh portproxy）占着 5000/1883/5002
//   3. mosquitto / 旧的 voice_server.py 还开着
// 设备端的端口是写死的（HTTP 5000、MQTT 1883、直播 5002），所以「换个端口」不是出路，只能把占用的腾出来。
import net from "node:net";
import dgram from "node:dgram";
import { execFileSync, spawnSync } from "node:child_process";

export interface PortNeed { what: string; port: number; proto: "tcp" | "udp"; host?: string; required: boolean }
export type OwnerKind = "portproxy" | "kagura" | "mosquitto" | "process" | "unknown";
export interface Owner { kind: OwnerKind; pid: number; name: string }
export interface Conflict { need: PortNeed; owner: Owner }

/** 平台相关的操作都走这里，单测换成假的 */
export interface PreflightIO {
  probe(n: PortNeed): Promise<boolean>;                       // true = 端口空闲
  owner(n: PortNeed): Owner;
  health(port: number): Promise<{ app?: string; version?: string; pid?: number } | null>;
  ask(question: string): Promise<string>;                      // 返回用户输入（已 trim）
  log(line: string): void;
  interactive: boolean;
  /** 修复动作；返回 false = 没成功（细节自己打印） */
  killPid(pid: number, name: string): boolean;
  stopMosquitto(pid: number): boolean;
  deletePortproxy(ports: number[]): boolean;
  openAdmin(url: string): void;
}

export type PreflightResult = "ok" | "already-running" | "exit";

// ── 真实平台实现 ──────────────────────────────────────────────

export function probePort(n: PortNeed): Promise<boolean> {
  return new Promise((resolve) => {
    if (n.proto === "udp") {
      const s = dgram.createSocket("udp4");
      s.once("error", () => { s.close(); resolve(false); });
      s.bind(n.port, n.host ?? "0.0.0.0", () => s.close(() => resolve(true)));
      return;
    }
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen({ port: n.port, host: n.host ?? "0.0.0.0", exclusive: true }, () => s.close(() => resolve(true)));
  });
}

const run = (bin: string, args: string[]) => {
  try { return execFileSync(bin, args, { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
};

/** Windows：这个端口是不是 netsh portproxy（旧的 WSL 转发）在听 */
export function portproxyPorts(out = run("netsh", ["interface", "portproxy", "show", "v4tov4"])): number[] {
  const ports: number[] = [];
  for (const l of out.split(/\r?\n/)) {
    const m = /^\s*\S+\s+(\d+)\s+\S+\s+\d+\s*$/.exec(l);
    if (m) ports.push(Number(m[1]));
  }
  return ports;
}

/** netstat -ano 的输出里找监听这个端口的 PID（Windows） */
export function pidFromNetstat(out: string, port: number, proto: "tcp" | "udp"): number {
  for (const l of out.split(/\r?\n/)) {
    const t = l.trim().split(/\s+/);
    if (t[0]?.toUpperCase() !== proto.toUpperCase() || !t[1]?.endsWith(`:${port}`)) continue;
    if (proto === "tcp" && t[3] !== "LISTENING") continue;
    const pid = Number(t[t.length - 1]);
    if (pid > 0) return pid;
  }
  return 0;
}

/** ss -lnp 的输出里找进程（Linux）：users:(("mosquitto",pid=812,fd=5)) */
export function ownerFromSs(out: string): { pid: number; name: string } {
  const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(out);
  return m ? { name: m[1], pid: Number(m[2]) } : { name: "", pid: 0 };
}

/** lsof -Fpc 的输出：p<pid>\nc<命令名> */
export function ownerFromLsof(out: string): { pid: number; name: string } {
  const pid = Number(/^p(\d+)$/m.exec(out)?.[1] ?? 0);
  return { pid, name: pid ? (/^c(.+)$/m.exec(out)?.[1] ?? "") : "" };
}

export function classify(name: string, pid: number, isPortproxy: boolean): Owner {
  if (isPortproxy) return { kind: "portproxy", pid, name: name || "netsh portproxy" };
  if (/mosquitto/i.test(name)) return { kind: "mosquitto", pid, name };
  if (/^kagura/i.test(name)) return { kind: "kagura", pid, name };
  if (pid > 0) return { kind: "process", pid, name: name || "未知程序" };
  return { kind: "unknown", pid: 0, name: "" };
}

export function findOwner(n: PortNeed): Owner {
  if (process.platform === "win32") {
    const isProxy = n.proto === "tcp" && portproxyPorts().includes(n.port);
    const pid = pidFromNetstat(run("netstat", ["-ano", "-p", n.proto.toUpperCase()]), n.port, n.proto);
    let name = "";
    if (pid) {
      const csv = run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      name = /^"([^"]+)"/.exec(csv.trim())?.[1] ?? "";
    }
    return classify(name, pid, isProxy);
  }
  if (process.platform === "linux" || process.platform === "darwin") {
    // ss（iproute2，大多数发行版都有）→ 查不到再用 lsof
    let o = ownerFromSs(run("ss", ["-H", n.proto === "tcp" ? "-lntp" : "-lnup", `sport = :${n.port}`]));
    if (!o.pid) o = ownerFromLsof(run("lsof", ["-nP", n.proto === "tcp" ? `-iTCP:${n.port}` : `-iUDP:${n.port}`, ...(n.proto === "tcp" ? ["-sTCP:LISTEN"] : []), "-Fpc"]));
    return classify(o.name, o.pid, false);
  }
  return classify("", 0, false);
}

export async function fetchHealth(port: number) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? ((await r.json()) as any) : null;
  } catch { return null; }
}

/** Windows：弹 UAC 以管理员身份跑一串命令（cmd /c a & b），等它结束 */
function elevated(cmdline: string): boolean {
  const ps = `Start-Process -FilePath cmd.exe -ArgumentList '/c ${cmdline.replace(/'/g, "''")}' -Verb RunAs -Wait -WindowStyle Hidden`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", windowsHide: true });
  return r.status === 0;
}

export function realIO(): PreflightIO {
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  return {
    probe: probePort,
    owner: findOwner,
    health: fetchHealth,
    interactive,
    log: (l) => console.log(l),
    ask: (q) => ask(q),
    killPid(pid, name) {
      if (process.platform === "win32") {
        if (spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true }).status === 0) return true;
        console.log(`  普通权限结束不了 ${name}，弹出管理员确认……`);
        return elevated(`taskkill /PID ${pid} /F`);
      }
      try { process.kill(pid); return true; }
      catch (e: any) {
        if (e.code !== "EPERM") return false;
        console.log(`  ${name} 是别的用户的程序，用 sudo 结束：`);
        return spawnSync("sudo", ["kill", String(pid)], { stdio: "inherit" }).status === 0;
      }
    },
    stopMosquitto(pid) {
      if (process.platform === "win32") {
        // 多半是装 mosquitto 时注册的服务：停掉并取消自启，否则下次开机又占上
        return elevated("net stop mosquitto & sc config mosquitto start= disabled") || this.killPid(pid, "mosquitto");
      }
      console.log("  运行 sudo systemctl disable --now mosquitto（停掉并取消开机自启）");
      return spawnSync("sudo", ["systemctl", "disable", "--now", "mosquitto"], { stdio: "inherit" }).status === 0;
    },
    deletePortproxy(ports) {
      const cmds = ports.map((p) => `netsh interface portproxy delete v4tov4 listenport=${p} listenaddress=0.0.0.0`);
      return elevated(cmds.join(" & "));
    },
    openAdmin(url) {
      const [bin, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
      spawnSync(bin, args as string[], { stdio: "ignore", windowsHide: true });
    },
  };
}

let rl: import("node:readline").Interface | null = null;
export async function ask(q: string): Promise<string> {
  const readline = await import("node:readline");
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl!.question(q, (a) => resolve(a.trim())));
}
export function closeAsk() { rl?.close(); rl = null; }

/** 出错退出前停一下：Windows 双击启动的窗口不然一闪就关了 */
export async function pauseBeforeExit(msg = "按回车键关闭窗口……") {
  if (process.platform !== "win32" || !process.stdin.isTTY) return;
  await ask(`\n${msg}`);
  closeAsk();
}

// ── 体检流程 ──────────────────────────────────────────────────

function describe(o: Owner): string {
  switch (o.kind) {
    case "portproxy": return "旧的 WSL 端口转发（openclaw-startup.ps1 加的 netsh portproxy）";
    case "mosquitto": return `mosquitto（PID ${o.pid}）——新服务端自带 MQTT，不需要它了`;
    case "kagura": return `另一个 Kagura（PID ${o.pid}）`;
    case "process": return `${o.name}（PID ${o.pid}）`;
    default: return "查不到是哪个程序（可能需要管理员权限才看得到）";
  }
}

interface Fix { key: string; label: string; act: () => boolean }

export async function preflight(needs: PortNeed[], httpPort: number, adminUrl: string, io: PreflightIO): Promise<PreflightResult> {
  for (let round = 0; ; round++) {
    const conflicts: Conflict[] = [];
    for (const n of needs) if (!(await io.probe(n))) conflicts.push({ need: n, owner: io.owner(n) });
    if (!conflicts.length) return "ok";

    // 1. 已经有一个 Kagura 在跑：不是错误
    const httpBusy = conflicts.some((c) => c.need.port === httpPort && c.need.proto === "tcp");
    const h = httpBusy ? await io.health(httpPort) : null;
    if (h?.app === "kagura") {
      io.log(`\nKagura 已经在运行了（版本 ${h.version ?? "?"}，PID ${h.pid ?? "?"}）——多半是开机自启的那个，在后台。`);
      io.log(`管理界面：${adminUrl}`);
      if (!io.interactive) return "already-running";
      const a = (await io.ask("\n  [回车] 打开管理界面   [R] 关掉它，在这个窗口重新启动   [Q] 退出\n> ")).toLowerCase();
      if (a === "r" && h.pid) {
        if (io.killPid(h.pid, "Kagura")) { await sleep(1000); continue; }
        io.log("  没能结束它。");
        return "exit";
      }
      if (a === "q") return "already-running";
      io.openAdmin(adminUrl);
      return "already-running";
    }

    // 2. 列出占用
    io.log("\n⚠️  有端口被占用，Kagura 现在启动不了：");
    for (const c of conflicts) {
      io.log(`  ✗ ${c.need.what}（${c.need.proto.toUpperCase()} ${c.need.port}）← ${describe(c.owner)}`);
    }
    if (httpBusy && h && !h.app) io.log("    端口 5000 上应答的是旧版 voice_server.py。");
    io.log("  设备那边的端口是固定的（5000 / 1883 / 5002 / 5001），只能把它们腾出来，不能换端口。");

    // 3. 能做的修复
    const fixes: Fix[] = [];
    const proxyPorts = [...new Set(conflicts.filter((c) => c.owner.kind === "portproxy").map((c) => c.need.port))];
    if (proxyPorts.length) {
      fixes.push({ key: "", label: `删除旧的 WSL 端口转发（${proxyPorts.join("/")}，会弹出管理员确认）`, act: () => io.deletePortproxy(proxyPorts) });
    }
    const seen = new Set<number>();
    for (const c of conflicts) {
      const o = c.owner;
      if (!o.pid || seen.has(o.pid) || o.kind === "portproxy") continue;
      seen.add(o.pid);
      const ports = conflicts.filter((x) => x.owner.pid === o.pid).map((x) => x.need.port).join("/");
      if (o.kind === "mosquitto") fixes.push({ key: "", label: `停止 mosquitto 并取消它的开机自启（占着 ${ports}）`, act: () => io.stopMosquitto(o.pid) });
      else fixes.push({ key: "", label: `结束 ${o.name}（PID ${o.pid}，占着 ${ports}）`, act: () => io.killPid(o.pid, o.name) });
    }
    fixes.forEach((f, i) => (f.key = String(i + 1)));
    const onlyOptional = conflicts.every((c) => !c.need.required);

    if (!io.interactive) {
      io.log("  （不是在交互窗口里运行，没法询问。处理掉上面的占用后再启动。）");
      return onlyOptional ? "ok" : "exit";
    }
    if (round >= 5) io.log("  （已经试了好几轮，还是不行的话把上面这几行发给开发者。）");

    const lines = fixes.map((f) => `  [${f.key}] ${f.label}`);
    if (fixes.length > 1) lines.unshift("  [回车] 全部处理（推荐）");
    else if (fixes.length === 1) lines[0] = `  [回车] ${fixes[0].label}`;
    if (onlyOptional) lines.push("  [C] 不管它，继续启动（设备自动发现会用不了）");
    lines.push("  [R] 重新检测（自己处理完之后选这个）", "  [Q] 退出");
    const a = (await io.ask(`\n怎么处理？\n${lines.join("\n")}\n> `)).toLowerCase();

    if (a === "q") return "exit";
    if (a === "c" && onlyOptional) return "ok";
    if (a === "r") continue;
    const chosen = a === "" ? fixes : fixes.filter((f) => f.key === a);
    if (!chosen.length) { io.log("  没有这个选项。"); continue; }
    for (const f of chosen) io.log(f.act() ? `  ✓ ${f.label}` : `  ✗ 没成功：${f.label}`);
    await sleep(800);       // 端口释放要一小会儿
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
