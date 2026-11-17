// 拓竹打印机的 MCP 服务器（只读）：`kagura mcp bambu-printer`，由 Kagura 的 MCP 管理器当普通 stdio 服务器拉起（见 README）。
// 核心里没有任何打印机相关的代码——它只是随 Kagura 一起发的一个 MCP 服务器，在 mcp.json 里加一段才启用：
//   "printer": { "command": "kagura", "args": ["mcp", "bambu-printer"], "notify": true,
//                "env": { "BAMBU_HOST": "192.168.1.50", "BAMBU_SERIAL": "…", "BAMBU_ACCESS_CODE": "…", "BAMBU_NAME": "P2S" } }
// 工具：printer_status（看状态；raw=true 给原始数据）、printer_retrust（证书变了之后主人确认过再调）。
// env 里 BAMBU_CONTROL=1 时多三个控制工具（control.ts：printer_control / printer_files / printer_print），要打印机开了开发者模式才发得出去。
// 打完 / 失败 / 暂停 / 严重告警时发 MCP 的日志通知（notifications/message），服务器配置里 "notify": true 时 Kagura 把它送给主人（mcp.ts）。
// 协议是一行一个 JSON-RPC 消息；标准输出只走协议，日志一律写标准错误（管理界面的 MCP 表里看得到）。
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { BambuPrinter, describeStatus, fmtDuration, tlsDial, type Dial, type PrinterEvent, type PrinterStatus } from "./bambu.ts";
import { CONTROL_TOOLS, PrinterControl } from "./control.ts";
import type { FtpDial } from "./ftps.ts";
import { CAMERA_PORT, cameraCertVerdict, findFfmpeg, takeSnapshot } from "./camera.ts";

/** 通知的句子（系统直接写，不过模型） */
export function eventText(name: string, e: PrinterEvent): string {
  if (e.kind === "dried") return `${name} 的 ${e.unit.no} 号料盒烘干好了${e.unit.humidity !== null ? `，现在湿度 ${e.unit.humidity}%` : ""}。`;
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
  ftpDial?: FtpDial;
  /** 拍照前核对摄像头端口证书用（默认 tlsDial） */
  camDial?: Dial;
  settleMs?: number;
  ackMs?: number;
  version?: string;
}

/** 没填 BAMBU_MODEL 时按这个型号（Bambu Studio 系统配置里的写法，「Bambu Lab P2S 0.4 nozzle」里的那段） */
export const DEFAULT_MODEL = "P2S";

const TOOLS = [
  {
    name: "printer_status", title: "看 3D 打印机",
    description: "看家里 3D 打印机现在的情况：在不在打印、打的是什么、进度、还要多久、温度、料还剩多少、有没有报错。问到打印机的事先看一眼再答，别凭之前的印象说。"
      + "打完、失败、暂停时会自动通知主人，不用你盯着。",
    inputSchema: { type: "object", properties: { raw: { type: "boolean", description: "true = 返回打印机发来的原始数据（排查显示不对时用，平时不要）" } } },
  },
  {
    name: "printer_snapshot", title: "用打印机的摄像头拍一张",
    description: "用打印机机内的摄像头拍一张照片（看打印进度、看打完的成品、看热床上有没有东西）。图片直接给你看；要给主人看就用 send_file 发回复里的那个路径。"
      + "需要这台电脑上装了 ffmpeg；拍不到时照返回的提示告诉主人。别频繁拍（每次要连一下摄像头，十几秒）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "printer_check", title: "看一眼打印得怎么样",
    description: "打印中途检查用：一次给你现在的状态（进度、层数、温度、报错）和机内摄像头刚拍的一张，对着返回的检查要点看有没有打坏。"
      + "系统定时叫你看护打印时调这个（比分别调 printer_status 和 printer_snapshot 省一趟）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "printer_retrust", title: "重新信任打印机",
    description: "打印机的证书和上次不一样时连接会被拒绝。只有主人明确说打印机恢复过出厂设置 / 换过机器、让你重新信任时才调；别自己决定调。",
    inputSchema: { type: "object", properties: {} },
  },
];

const NO_FFMPEG = "这台电脑上没找到 ffmpeg（拍照要用它把摄像头的视频解成图片）。让主人装一个：Windows 在命令行运行 winget install ffmpeg（macOS：brew install ffmpeg），装完不用重启 Kagura；装在别处的话在 MCP 配置的 env 里填 BAMBU_FFMPEG（ffmpeg.exe 的完整路径）。";

/** 只有暂停的工具（BAMBU_CONTROL=1 才有）：看护打印时发现打坏了用。暂停随时能继续，所以不像 printer_control 那样只给主人本人的对话 */
const PAUSE_TOOL = {
  name: "printer_pause", title: "暂停打印",
  description: "把正在打的任务暂停（只能暂停，不能停止 / 继续）。看护打印时看到明显打坏了（见 printer_check 的检查要点）才用；暂停后一定要告诉主人你看到了什么。"
    + "拿不准就别暂停，把情况告诉主人让他自己看。主人让你暂停 / 继续 / 停止时用 printer_control。",
  inputSchema: { type: "object", properties: { reason: { type: "string", description: "看到了什么（一句话，记进日志）" } }, required: ["reason"] },
};

/** printer_check 附的检查要点：摄像头是俯视 / 侧视热床，判断只看得见的东西 */
export const CHECK_POINTS = "检查要点（看照片）：① 炒面——喷嘴周围 / 热床上一团乱丝，没在成形；② 脱板——零件歪了、倒了、被喷嘴拖着走，或者热床上本该有东西却是空的；"
  + "③ 喷嘴裹料——喷嘴上包着一大坨料；④ 空打——层数在涨但照片里没有新料出来；⑤ 严重翘边——底边翘起一大截。"
  + "轻微拉丝、表面小瑕疵、支撑看着乱不算。照片太暗 / 看不清 / 拿不准，都算正常，别暂停。";

/** 看护打印时叫醒 agent 的话（Kagura 扩展：logger = kagura.wake 的日志通知，服务器配置 "wake": true 时让 agent 跑一轮；别的客户端只当一行日志） */
export function watchPrompt(name: string, s: PrinterStatus, canPause: boolean): string {
  const at = [s.percent !== null ? `${s.percent}%` : "", s.layer !== null && s.layers ? `第 ${s.layer}/${s.layers} 层` : ""].filter(Boolean).join("，");
  return `${name} 正在打印${s.job ? `「${s.job}」` : ""}${at ? `（${at}）` : ""}，例行看护：调 printer_check 看一眼。`
    + `一切正常就只回 NO_REPLY（不要汇报「一切正常」）。`
    + (canPause ? `明显打坏了就调 printer_pause 暂停，然后用一两句话告诉主人你看到了什么、已经暂停了。` : `明显打坏了就用一两句话告诉主人你看到了什么，让他去暂停（你这边暂停不了）。`)
    + `拿不准的不要暂停；拍不到照片也只回 NO_REPLY。`;
}
/** 看护间隔的下限（分钟）：每次一张图 + 一轮模型调用 */
export const WATCH_MIN_MINUTES = 3;

/** 启动服务器（读 input、写 output）；返回关闭函数 */
export function startBambuMcp(o: BambuMcpOpts): { close(): void; printer: BambuPrinter | null; /** 看护的一次检查（测试用：传入当前时刻） */ watchTick(now?: number): boolean } {
  const log = o.log ?? ((l: string) => { process.stderr.write(l + "\n"); });
  const send = (m: unknown) => { try { o.output.write(JSON.stringify(m) + "\n"); } catch { /* 对方关了 */ } };
  const env = (k: string) => String(o.env[k] ?? "").trim();
  const name = env("BAMBU_NAME") || "打印机";
  const host = env("BAMBU_HOST"), serial = env("BAMBU_SERIAL").toUpperCase(), code = env("BAMBU_ACCESS_CODE");
  // 没填，或者还是模板里的中文占位
  const unset = (v: string) => !v || /[^\x21-\x7e]/.test(v);
  const missing = [unset(host) && "BAMBU_HOST（打印机 IP）", unset(serial) && "BAMBU_SERIAL（序列号）", unset(code) && "BAMBU_ACCESS_CODE（访问码）"].filter(Boolean);
  // 记证书指纹、放切好的文件的目录：Kagura 拉起时当前目录是数据目录；单独给别的 MCP 客户端用时可以 BAMBU_STATE_DIR 指定
  const stateDir = o.stateDir ?? (env("BAMBU_STATE_DIR") || path.join(process.cwd(), "bambu_printer"));
  const stateFile = path.join(stateDir, `${serial || "unknown"}.json`);
  const readState = (): { fingerprint?: string; host?: string; camera?: string; cameraHost?: string } => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; } };
  const writeState = (s: object) => { try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (e: any) { log(`记不下证书指纹：${e.message}`); } };

  /** 交出访问码之前先核对摄像头端口的证书（ffmpeg 带 -tls_verify 0，它自己不验）：和 MQTT 那边记下的一样，或者和以前在摄像头端口记下的一样才拍；
   *  第一次见、MQTT 那边又对不上（摄像头用的是另一张证书）就记下来，以后必须一样。printer_retrust 一起忘掉 */
  let camMismatch = false;
  const checkCameraCert = async (port: number) => {
    let fp = "";
    try {
      const d = await (o.camDial ?? tlsDial)(host, port);
      fp = d.fingerprint;
      d.sock.destroy();
    } catch (e: any) {
      throw new Error(`连不上打印机的摄像头端口 ${port}（${e?.message ?? e}）。打印机上可能要打开「局域网模式直播」（LAN Only Liveview，在网络设置里）`);
    }
    const st = readState();
    const known = st.host === host ? st.fingerprint ?? "" : "", camera = st.cameraHost === host ? st.camera ?? "" : "";
    const v = cameraCertVerdict(fp, known, camera);
    camMismatch = v === "mismatch";
    if (v === "mismatch") {
      log(`[${name}] ⚠️  摄像头端口的证书和记下的不一样，没拍`);
      throw new Error(`摄像头端口的证书和以前记下的不一样，没拍（没把访问码交出去）。可能是换了机器 / 重置过，也可能有别的设备在冒充它。请主人确认是自己的打印机后再调 printer_retrust。`);
    }
    if (v === "remember") { writeState({ ...st, camera: fp, cameraHost: host }); log(`[${name}] 记下摄像头端口的证书指纹`); }
  };

  let printer: BambuPrinter | null = null;
  const open = () => {
    printer?.stop();
    const st = readState();
    printer = new BambuPrinter({
      host, serial, accessCode: code, port: Number(env("BAMBU_PORT")) || undefined,
      // 换了 IP 就当换了机器：以前记的证书不作数
      fingerprint: st.host === host ? st.fingerprint : "",
      dial: o.dial, settleMs: o.settleMs, ackMs: o.ackMs, log: (l) => log(`[${name}] ${l}`),
      onFingerprint: (fp) => writeState({ ...readState(), fingerprint: fp, host }),
      onEvent: (e) => {
        if (e.kind === "warning" && env("BAMBU_WARNINGS") === "0") return;
        const text = eventText(name, e);
        log(`[${name}] 📣 ${text}`);
        send({ jsonrpc: "2.0", method: "notifications/message", params: { level: e.kind === "finish" || e.kind === "dried" ? "notice" : "warning", logger: "bambu-printer", data: text } });
      },
    });
    printer.start();
  };
  if (missing.length) log(`还没配置好：缺 ${missing.join("、")}`);
  else open();
  // 控制（BAMBU_CONTROL=1 才有）：没开的话这个服务器只读，工具列表里也没有控制类的
  const controlOn = env("BAMBU_CONTROL") === "1";
  const control = new PrinterControl({
    name, printer: () => printer, fingerprint: () => readState().fingerprint ?? "", log,
    ftpPort: Number(env("BAMBU_FTP_PORT")) || undefined, ftpDial: o.ftpDial, fileUrl: env("BAMBU_FILE_URL"),
    // 型号：切片按它选配置、发打印前按它核对文件；不填默认 P2S
    model: env("BAMBU_MODEL") || DEFAULT_MODEL,
    // 打印机上放的打印板：不填按纹理 PEI 板（拓竹打印机大多出厂带这块）
    plateType: env("BAMBU_PLATE") || "textured",
    slicer: {
      studio: env("BAMBU_STUDIO"), profiles: env("BAMBU_PROFILES"), nozzle: env("BAMBU_NOZZLE") || "0.4",
      outDir: path.join(stateDir, "sliced"),
      timeoutMs: (Number(env("BAMBU_SLICE_TIMEOUT")) || 540) * 1000,
    },
  });
  const tools = controlOn ? [...TOOLS, PAUSE_TOOL, ...CONTROL_TOOLS]
    : TOOLS.map((t) => (t.name === "printer_status" ? { ...t, description: t.description + "只能看，不能控制（暂停 / 停止 / 开始打印要主人自己在打印机或官方软件上操作）。" } : t));

  const statusText = (raw: boolean): string => {
    if (missing.length) return `打印机还没配置好：在 MCP 配置的 env 里填 ${missing.join("、")}（都在打印机屏幕的设置里看）。`;
    const p = printer!;
    if (raw) return p.ready ? JSON.stringify(p.raw, null, 1) : "还没收到打印机的数据。";
    if (p.conn !== "online") {
      const last = p.ready && p.lastSeen ? `最后一次看到是 ${fmtDuration((Date.now() - p.lastSeen) / 60_000)}前：${describeStatus(p.status)}` : "";
      return `${name}：连不上（${p.error || "还在连接"}）。${last}`;
    }
    if (!p.ready) return `${name}：刚连上，还没收到状态，过几秒再问。`;
    const s = p.status;
    return `${name}：${describeStatus(s)}${controlOn && s.devMode === false ? "（打印机没开开发者模式：现在只能看，暂停 / 停止 / 开始打印发不出去）" : ""}`;
  };

  /** 拍一张（先核对摄像头端口的证书）。没装 ffmpeg / 拍不到都抛带说明的错 */
  const snap = async (): Promise<string> => {
    const ffmpeg = findFfmpeg(o.env);
    if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error(NO_FFMPEG);
    const t0 = Date.now();
    const camPort = Number(env("BAMBU_CAMERA_PORT")) || CAMERA_PORT;
    try {
      await checkCameraCert(camPort);
      const file = await takeSnapshot({ ffmpeg, host, code, port: camPort, dir: path.join(stateDir, "snapshots"), name });
      log(`[${name}] 📷 拍了一张（${Math.round((Date.now() - t0) / 1000)} 秒）→ ${file}`);
      return file;
    } catch (e: any) { log(`[${name}] 📷 没拍到：${String(e?.message ?? e).split("\n")[0]}`); throw e; }
  };

  // 看护打印（BAMBU_WATCH_MINUTES > 0）：打印期间每隔这么久叫醒 agent 看一眼。暂停 / 没在打就不叫
  const watchMin = Number(env("BAMBU_WATCH_MINUTES")) > 0 ? Math.max(WATCH_MIN_MINUTES, Number(env("BAMBU_WATCH_MINUTES"))) : 0;
  let printingSince = 0, lastWatch = 0;
  const watchTick = (now = Date.now()) => {
    const p = printer;
    const printing = !!p && p.conn === "online" && p.ready && p.status.state === "printing";
    if (!printing) { printingSince = 0; return false; }
    if (!printingSince) { printingSince = now; lastWatch = now; return false; }       // 刚开始打：等满一个间隔再看
    if (now - lastWatch < watchMin * 60_000) return false;
    lastWatch = now;
    const text = watchPrompt(name, p!.status, controlOn);
    log(`[${name}] 👀 叫她看一眼（${p!.status.percent ?? "?"}%）`);
    send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "notice", logger: "kagura.wake", data: text } });
    return true;
  };
  const watchTimer = watchMin && !missing.length ? setInterval(() => watchTick(), 30_000) : null;
  watchTimer?.unref?.();

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
        instructions: controlOn ? `拓竹 3D 打印机（${name}）：看进度 / 温度 / 料 / 报错，暂停、继续、停止，切片（用这台电脑上的 Bambu Studio），把切好的文件发去打印`
          : `看拓竹 3D 打印机（${name}）的状态：进度、剩余时间、温度、料、报错（只读）`,
      });
      case "ping": case "logging/setLevel": return ok({});
      case "tools/list": return ok({ tools });
      case "tools/call": {
        const tool = m.params?.name, args = m.params?.arguments ?? {};
        if (tool === "printer_status") return text(statusText(args.raw === true));
        if (tool === "printer_check") {
          if (missing.length) return text(statusText(false), true);
          const st = statusText(false);
          snap().then((file) => ok({ content: [{ type: "image", data: fs.readFileSync(file).toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: `${st}\n照片：${file}\n${CHECK_POINTS}` }] }))
            .catch((e) => text(`${st}\n没拍到照片（${String(e?.message ?? e).split("\n")[0]}）：只能按上面的状态判断，看不出问题就当正常。`));
          return;
        }
        if (controlOn && tool === "printer_pause") {
          if (missing.length) return text(statusText(false), true);
          log(`[${name}] ⏸  她要暂停：${String(args.reason ?? "").slice(0, 200)}`);
          control.control({ action: "pause" }).then((r) => text(r.text, r.isError === true)).catch((e) => text(`出错了：${e?.message ?? e}`, true));
          return;
        }
        if (tool === "printer_snapshot") {
          if (missing.length) return text(statusText(false), true);
          snap().then((file) => ok({ content: [{ type: "image", data: fs.readFileSync(file).toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: `${name} 机内摄像头刚拍的：${file}（要给主人看就用 send_file 发这个路径；之后想再看一眼用 read_file 读它）` }] }))
            .catch((e) => text(String(e?.message ?? e), true));
          return;
        }
        if (tool === "printer_retrust") {
          if (missing.length) return text(statusText(false), true);
          if (!printer!.error.startsWith("证书") && !camMismatch) return text("现在不是证书的问题，不用重新信任。" + statusText(false));
          writeState({});
          camMismatch = false;
          open();
          return text(`已经忘掉 ${name} 以前的证书，正在重新连接，这次连上的会被记成新的。过几秒用 printer_status 看看连上没有。`);
        }
        // 切片不用连着打印机（只用这台电脑上的 Bambu Studio）
        if (controlOn && tool === "printer_slice") { control.slice(args).then((r) => text(r.text, r.isError === true)).catch((e) => text(`出错了：${e?.message ?? e}`, true)); return; }
        if (controlOn && (tool === "printer_control" || tool === "printer_files" || tool === "printer_print" || tool === "printer_ams_dry")) {
          if (missing.length) return text(statusText(false), true);
          const run = tool === "printer_control" ? control.control(args) : tool === "printer_files" ? control.files() : tool === "printer_ams_dry" ? control.dry(args) : control.print(args);
          run.then((r) => text(r.text, r.isError === true)).catch((e) => text(`出错了：${e?.message ?? e}`, true));
          return;
        }
        return text(`没有工具 ${tool}`, true);
      }
      default: return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `不支持 ${m.method}` } });
    }
  });
  const stop = () => { printer?.stop(); if (watchTimer) clearInterval(watchTimer); };
  const close = () => { stop(); rl.close(); };
  rl.on("close", stop);
  return { close, get printer() { return printer; }, watchTick };
}

/** `kagura mcp bambu-printer`：标准输入输出上跑，输入关了（Kagura 断开）就退出 */
export function runBambuMcp(version: string) {
  startBambuMcp({ input: process.stdin, output: process.stdout, env: process.env, version });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}
