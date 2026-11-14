// 拓竹打印机的 MCP 服务器（只读）：`kagura mcp bambu-printer`，由 Kagura 的 MCP 管理器当普通 stdio 服务器拉起（见 README）。
// 核心里没有任何打印机相关的代码——它只是随 Kagura 一起发的一个 MCP 服务器，在 mcp.json 里加一段才启用：
//   "printer": { "command": "kagura", "args": ["mcp", "bambu-printer"], "notify": true,
//                "env": { "BAMBU_HOST": "192.168.1.50", "BAMBU_SERIAL": "…", "BAMBU_ACCESS_CODE": "…", "BAMBU_NAME": "P2S" } }
// 工具：printer_status（看状态；raw=true 给原始数据）、printer_retrust（证书变了之后主人确认过再调）。
// 打完 / 失败 / 暂停 / 严重告警时发 MCP 的日志通知（notifications/message），服务器配置里 "notify": true 时 Kagura 把它送给主人（mcp.ts）。
// 协议是一行一个 JSON-RPC 消息；标准输出只走协议，日志一律写标准错误（管理界面的 MCP 表里看得到）。
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { BambuPrinter, describeStatus, fmtDuration, type Dial, type PrinterEvent, type PrinterStatus } from "./bambu.ts";

/** 通知的句子（系统直接写，不过模型） */
export function eventText(name: string, e: PrinterEvent): string {
  if (e.kind === "cert") return `${name} 的证书和上次连接时不一样，我先断开了。打印机恢复过出厂设置的话，跟我说一声「重新信任打印机」。`;
  const s: PrinterStatus = e.status;
  const job = s.job ? `「${s.job}」` : "这个任务";
  if (e.kind === "warning") return `${name} 打印${job}时报了告警（HMS ${e.codes.join("、")}），打印还在继续，有空去看一眼。`;
  const took = e.elapsedMin !== null && e.elapsedMin >= 1 ? `，用了 ${fmtDuration(e.elapsedMin)}` : "";
  if (e.kind === "finish") return `${name} 上的${job}打印完成了${took}。`;
  if (e.kind === "failed") return `${name} 上的${job}打印失败了${s.percent !== null ? `，停在 ${s.percent}%` : ""}${s.error ? `（错误码 ${s.error}）` : ""}。`;
  const why = s.stage.startsWith("暂停") ? s.stage.replace(/^暂停[：:]?\s*/, "").replace(/^（(.*)）$/, "$1") : "";
  return `${name} 上的${job}暂停了${why ? `：${why}` : ""}${s.error ? `（错误码 ${s.error}）` : ""}${s.percent !== null ? `，打到 ${s.percent}%` : ""}，要你去看一下。`;
}

export interface BambuMcpOpts {
  input: Readable;
  output: Writable;
  env: Record<string, string | undefined>;
  /** 记证书指纹的目录（默认 <当前目录>/bambu_printer，Kagura 拉起时当前目录是数据目录） */
  stateDir?: string;
  log?(line: string): void;
  dial?: Dial;
  settleMs?: number;
  version?: string;
}

const TOOLS = [
  {
    name: "printer_status", title: "看 3D 打印机",
    description: "看家里 3D 打印机现在的情况：在不在打印、打的是什么、进度、还要多久、温度、料还剩多少、有没有报错。问到打印机的事先看一眼再答，别凭之前的印象说。"
      + "只能看，不能控制（暂停 / 停止 / 开始打印要主人自己在打印机或官方软件上操作）。打完、失败、暂停时会自动通知主人，不用你盯着。",
    inputSchema: { type: "object", properties: { raw: { type: "boolean", description: "true = 返回打印机发来的原始数据（排查显示不对时用，平时不要）" } } },
  },
  {
    name: "printer_retrust", title: "重新信任打印机",
    description: "打印机的证书和上次不一样时连接会被拒绝。只有主人明确说打印机恢复过出厂设置 / 换过机器、让你重新信任时才调；别自己决定调。",
    inputSchema: { type: "object", properties: {} },
  },
];

/** 启动服务器（读 input、写 output）；返回关闭函数 */
export function startBambuMcp(o: BambuMcpOpts): { close(): void; printer: BambuPrinter | null } {
  const log = o.log ?? ((l: string) => { process.stderr.write(l + "\n"); });
  const send = (m: unknown) => { try { o.output.write(JSON.stringify(m) + "\n"); } catch { /* 对方关了 */ } };
  const env = (k: string) => String(o.env[k] ?? "").trim();
  const name = env("BAMBU_NAME") || "打印机";
  const host = env("BAMBU_HOST"), serial = env("BAMBU_SERIAL").toUpperCase(), code = env("BAMBU_ACCESS_CODE");
  // 没填，或者还是模板里的中文占位
  const unset = (v: string) => !v || /[^\x21-\x7e]/.test(v);
  const missing = [unset(host) && "BAMBU_HOST（打印机 IP）", unset(serial) && "BAMBU_SERIAL（序列号）", unset(code) && "BAMBU_ACCESS_CODE（访问码）"].filter(Boolean);
  const stateFile = path.join(o.stateDir ?? path.join(process.cwd(), "bambu_printer"), `${serial || "unknown"}.json`);
  const readState = (): { fingerprint?: string; host?: string } => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; } };
  const writeState = (s: object) => { try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (e: any) { log(`记不下证书指纹：${e.message}`); } };

  let printer: BambuPrinter | null = null;
  const open = () => {
    printer?.stop();
    const st = readState();
    printer = new BambuPrinter({
      host, serial, accessCode: code, port: Number(env("BAMBU_PORT")) || undefined,
      // 换了 IP 就当换了机器：以前记的证书不作数
      fingerprint: st.host === host ? st.fingerprint : "",
      dial: o.dial, settleMs: o.settleMs, log: (l) => log(`[${name}] ${l}`),
      onFingerprint: (fp) => writeState({ fingerprint: fp, host }),
      onEvent: (e) => {
        if (e.kind === "warning" && env("BAMBU_WARNINGS") === "0") return;
        const text = eventText(name, e);
        log(`[${name}] 📣 ${text}`);
        send({ jsonrpc: "2.0", method: "notifications/message", params: { level: e.kind === "finish" ? "notice" : "warning", logger: "bambu-printer", data: text } });
      },
    });
    printer.start();
  };
  if (missing.length) log(`还没配置好：缺 ${missing.join("、")}`);
  else open();

  const statusText = (raw: boolean): string => {
    if (missing.length) return `打印机还没配置好：在 MCP 配置的 env 里填 ${missing.join("、")}（都在打印机屏幕的设置里看）。`;
    const p = printer!;
    if (raw) return p.ready ? JSON.stringify(p.raw, null, 1) : "还没收到打印机的数据。";
    if (p.conn !== "online") {
      const last = p.ready && p.lastSeen ? `最后一次看到是 ${fmtDuration((Date.now() - p.lastSeen) / 60_000)}前：${describeStatus(p.status)}` : "";
      return `${name}：连不上（${p.error || "还在连接"}）。${last}`;
    }
    return p.ready ? `${name}：${describeStatus(p.status)}` : `${name}：刚连上，还没收到状态，过几秒再问。`;
  };

  const rl = readline.createInterface({ input: o.input });
  rl.on("line", (line) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || m.id === undefined) return;                       // 通知（initialized 之类）不用回
    const ok = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
    const text = (t: string, isError = false) => ok({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
    switch (m.method) {
      case "initialize": return ok({
        protocolVersion: m.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {}, logging: {} },
        serverInfo: { name: "kagura-bambu-printer", version: o.version ?? "0" },
        instructions: `看拓竹 3D 打印机（${name}）的状态：进度、剩余时间、温度、料、报错（只读）`,
      });
      case "ping": case "logging/setLevel": return ok({});
      case "tools/list": return ok({ tools: TOOLS });
      case "tools/call": {
        const tool = m.params?.name, args = m.params?.arguments ?? {};
        if (tool === "printer_status") return text(statusText(args.raw === true));
        if (tool === "printer_retrust") {
          if (missing.length) return text(statusText(false), true);
          if (!printer!.error.startsWith("证书")) return text("现在不是证书的问题，不用重新信任。" + statusText(false));
          writeState({});
          open();
          return text(`已经忘掉 ${name} 以前的证书，正在重新连接，这次连上的会被记成新的。过几秒用 printer_status 看看连上没有。`);
        }
        return text(`没有工具 ${tool}`, true);
      }
      default: return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `不支持 ${m.method}` } });
    }
  });
  const close = () => { printer?.stop(); rl.close(); };
  rl.on("close", () => printer?.stop());
  return { close, get printer() { return printer; } };
}

/** `kagura mcp bambu-printer`：标准输入输出上跑，输入关了（Kagura 断开）就退出 */
export function runBambuMcp(version: string) {
  startBambuMcp({ input: process.stdin, output: process.stdout, env: process.env, version });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}
