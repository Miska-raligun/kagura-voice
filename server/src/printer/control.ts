// 拓竹打印机的控制（要打印机开了「仅局域网模式」+「开发者模式」，MCP 配置里 BAMBU_CONTROL=1 才有这些工具）：
// 暂停 / 继续 / 停止 / 开关灯 / 速度档；列打印机上的文件；把切好的文件传上去并开始打印。
// 开始打印是两步：第一次调只返回「要打什么」和一个确认码，主人同意后带着码再调一次才真的开始——打印机是会加热的设备，
// 热床上有没有东西只有人看得到。Kagura 那边再配 "ownerOnly"，后台场景（待办 / 定时任务 / heartbeat）里根本没有这两个工具（mcp.ts）。
// 指令格式来自社区整理的协议（ha-bambulab / OpenBambuAPI），写的时候没有真机。
import fs from "node:fs";
import path from "node:path";
import type { BambuPrinter, PrinterStatus } from "./bambu.ts";
import { Ftps, type FtpDial, type FtpEntry } from "./ftps.ts";

export const CONTROL_TOOLS = [
  {
    name: "printer_control", title: "控制 3D 打印机",
    description: "控制正在进行的打印：pause 暂停、resume 继续、stop 停止（停了不能接着打，这一件就废了）、light_on / light_off 开关仓内灯、speed 换速度档。"
      + "只在主人明确要求时调；stop 之前跟主人确认一遍。调完用 printer_status 看一眼是不是生效了。",
    inputSchema: {
      type: "object", required: ["action"],
      properties: {
        action: { type: "string", enum: ["pause", "resume", "stop", "light_on", "light_off", "speed"] },
        speed: { type: "string", enum: ["silent", "standard", "sport", "ludicrous"], description: "action=speed 时：静音 / 标准 / 运动 / 狂暴" },
      },
    },
  },
  {
    name: "printer_files", title: "打印机上的文件",
    description: "列出打印机存储里切好的打印文件（.3mf），可以拿来用 printer_print 再打一次。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "printer_print", title: "开始打印",
    description: "开始打印一个**已经切好片**的文件（Bambu Studio 导出的 .gcode.3mf / 切片后的 .3mf）：可以是这台电脑上的文件路径（会先传到打印机），也可以是 printer_files 列出的打印机上的文件名。"
      + "不会切片：只有模型（.stl / 没切片的 .3mf）时让主人先在 Bambu Studio 里切片导出。"
      + "分两步：第一次调（不带 confirm）只返回要打什么和一个确认码；把内容告诉主人，主人确认「热床上是空的、就打这个、用这个料」之后，带上 confirm 用同样的参数再调一次才真的开始。主人没明确同意不要带 confirm。",
    inputSchema: {
      type: "object", required: ["file"],
      properties: {
        file: { type: "string", description: "这台电脑上的文件路径，或打印机上的文件名" },
        plate: { type: "number", description: "第几盘（一个文件里有多盘时），默认第一盘" },
        slots: { type: "array", items: { type: "number" }, description: "文件里用到的每种料各在 AMS 的几号槽（1 起，按文件里料的顺序）；不填 = 用现在在用的那个槽" },
        use_ams: { type: "boolean", description: "false = 用外挂料盘；不填 = 有 AMS 就用" },
        bed_leveling: { type: "boolean", description: "打印前调平，默认 true" },
        timelapse: { type: "boolean", description: "拍延时摄影，默认 false" },
        confirm: { type: "string", description: "第一次调返回的确认码；主人同意后才带" },
      },
    },
  },
];

/** zip 里有哪些文件（只读末尾的目录，不解压；判断 3mf 切没切片用） */
export function zipNames(file: string): string[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 66_000);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error("不是 zip / 3mf 文件");
    const cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (cdSize > 32 * 1024 * 1024 || cdOff + cdSize > size) throw new Error("文件目录不对（文件可能不完整）");
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const names: string[] = [];
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const n = cd.readUInt16LE(p + 28), x = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32);
      names.push(cd.subarray(p + 46, p + 46 + n).toString("utf8"));
      p += 46 + n + x + c;
    }
    return names;
  } finally { fs.closeSync(fd); }
}
/** 切好片的盘号（Metadata/plate_N.gcode） */
export const platesOf = (names: string[]) => names.map((n) => /^Metadata\/plate_(\d+)\.gcode$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);

const SPEED: Record<string, [string, string]> = { silent: ["1", "静音"], standard: ["2", "标准"], sport: ["3", "运动"], ludicrous: ["4", "狂暴"] };
const light = (mode: "on" | "off") => ({ command: "ledctrl", led_node: "chamber_light", led_mode: mode, led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 });
const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ACTIVE = new Set(["preparing", "printing", "paused"]);
const NO_DEV = "打印机没开「开发者模式」，控制指令发不出去。在打印机屏幕的设置里：先开「仅局域网模式」，再开它下面的「开发者模式」（开了之后拓竹云和手机 App 用不了）。";
const CONFIRM_TTL_MS = 10 * 60_000;

export interface ControlOpts {
  name: string;
  printer(): BambuPrinter | null;
  fingerprint(): string;
  ftpPort?: number;
  ftpDial?: FtpDial;
  /** project_file 里文件地址的前缀：P2 / H2 这代是 ftp:///，老机型（X1 / P1 / A1）是 file:///sdcard/ */
  fileUrl?: string;
  log(line: string): void;
}

export class PrinterControl {
  private codes = new Map<string, { key: string; exp: number }>();
  constructor(private o: ControlOpts) {}

  /** 连着、有状态、开了开发者模式才往下走；否则返回要说的话 */
  private ready(): { p: BambuPrinter; s: PrinterStatus } | string {
    const p = this.o.printer();
    if (!p || p.conn !== "online") return `${this.o.name} 现在连不上（${p?.error || "还在连接"}）。`;
    if (!p.ready) return `${this.o.name} 刚连上，还没收到状态，过几秒再试。`;
    const s = p.status;
    return s.devMode === false ? NO_DEV : { p, s };
  }

  private ftp() {
    const p = this.o.printer()!;
    return Ftps.open({ host: p.options.host, port: this.o.ftpPort, password: p.options.accessCode, fingerprint: this.o.fingerprint(), dial: this.o.ftpDial });
  }

  async control(args: any): Promise<{ text: string; isError?: boolean }> {
    const r = this.ready();
    if (typeof r === "string") return { text: r, isError: true };
    const { p, s } = r;
    const action = String(args?.action ?? "");
    let kind: "print" | "system" = "print", body: Record<string, unknown>, done: string;
    if (action === "pause") {
      if (s.state !== "printing" && s.state !== "preparing") return { text: `现在没在打印（${s.rawState || "状态不明"}），没什么可暂停的。`, isError: true };
      body = { command: "pause" }; done = "已经让它暂停了";
    } else if (action === "resume") {
      if (s.state !== "paused") return { text: `现在不是暂停状态（${s.rawState || "状态不明"}）。`, isError: true };
      body = { command: "resume" }; done = "已经让它继续了";
    } else if (action === "stop") {
      if (!ACTIVE.has(s.state)) return { text: `现在没有在进行的打印（${s.rawState || "状态不明"}）。`, isError: true };
      body = { command: "stop" }; done = `已经让它停止了${s.job ? `「${s.job}」` : ""}`;
    } else if (action === "light_on" || action === "light_off") {
      kind = "system"; body = light(action === "light_on" ? "on" : "off"); done = action === "light_on" ? "灯开了" : "灯关了";
    } else if (action === "speed") {
      const v = SPEED[String(args?.speed ?? "")];
      if (!v) return { text: "speed 要填 silent / standard / sport / ludicrous 之一。", isError: true };
      body = { command: "print_speed", param: v[0] }; done = `速度档换成${v[1]}了`;
    } else return { text: `不认识的操作 ${action}`, isError: true };
    const res = await p.command(kind, body);
    this.o.log(`[${this.o.name}] 🎛️  ${action} → ${res.ok ? "成功" : res.reason}`);
    if (res.ok) return { text: `${done}。过几秒用 printer_status 看看是不是生效了。` };
    return { text: res.sent ? `${res.reason}。用 printer_status 看看实际有没有变。` : res.reason, isError: true };
  }

  async files(): Promise<{ text: string; isError?: boolean }> {
    const p = this.o.printer();
    if (!p || p.conn !== "online") return { text: `${this.o.name} 现在连不上（${p?.error || "还在连接"}）。`, isError: true };
    let ftp: Ftps;
    try { ftp = await this.ftp(); } catch (e: any) { return { text: `连不上打印机的文件服务：${e.message}`, isError: true }; }
    try {
      const pick = (list: FtpEntry[], dir: string) => list.filter((f) => !f.dir && /\.3mf$/i.test(f.name)).map((f) => ({ ...f, name: dir + f.name }));
      const root = pick(await ftp.list("/"), "");
      const cache = await ftp.list("/cache").then((l) => pick(l, "cache/")).catch(() => []);
      const all = [...root, ...cache].slice(0, 40);
      if (!all.length) return { text: "打印机上没有切好的打印文件（.3mf）。" };
      return { text: `打印机上的打印文件（文件名可以直接给 printer_print）：\n${all.map((f) => `- ${f.name}（${mb(f.size)}，${f.date}）`).join("\n")}` };
    } catch (e: any) { return { text: `列文件出错：${e.message}`, isError: true }; } finally { ftp.close(); }
  }

  async print(args: any): Promise<{ text: string; isError?: boolean }> {
    const r = this.ready();
    if (typeof r === "string") return { text: r, isError: true };
    const { p, s } = r;
    if (ACTIVE.has(s.state)) return { text: `${this.o.name} 正在打印${s.job ? `「${s.job}」` : ""}，等它打完或者先停掉。`, isError: true };
    const file = String(args?.file ?? "").trim();
    if (!file) return { text: "要给 file（这台电脑上的文件路径，或打印机上的文件名）。", isError: true };
    if (!/\.3mf$/i.test(file)) return { text: "只能打切好片的 .3mf（Bambu Studio 里切片后「导出切片文件」得到的 .gcode.3mf）。只有模型的话让主人先在 Bambu Studio 里切片。", isError: true };
    let local: { path: string; size: number } | null = null;
    let plates: number[] = [];
    try {
      if (path.isAbsolute(file) && fs.statSync(file).isFile()) {
        local = { path: file, size: fs.statSync(file).size };
        plates = platesOf(zipNames(file));
        if (!plates.length) return { text: "这个 3mf 还没切片（里面没有 G-code）。让主人在 Bambu Studio 里打开它、切片，然后「导出切片文件」，再把导出的 .gcode.3mf 给我。", isError: true };
      }
    } catch (e: any) {
      if (path.isAbsolute(file)) return { text: e?.code === "ENOENT" ? `这台电脑上没有 ${file}。` : `读不了 ${file}：${e.message}`, isError: true };
    }
    if (!local && path.isAbsolute(file)) return { text: `这台电脑上没有 ${file}。`, isError: true };
    const plate = Number(args?.plate) || plates[0] || 1;
    if (local && !plates.includes(plate)) return { text: `这个文件里没有第 ${plate} 盘（切好的有：第 ${plates.join("、")} 盘）。`, isError: true };
    // 用哪个料槽：没说就用现在在用的那个，再没有就 1 号
    const hasAms = s.trays.length > 0;
    const useAms = args?.use_ams === undefined ? hasAms : args.use_ams === true;
    const slots: number[] = Array.isArray(args?.slots) && args.slots.length ? args.slots.map((x: unknown) => Math.round(Number(x))) : [s.activeSlot && s.activeSlot > 0 ? s.activeSlot : s.trays[0]?.slot ?? 1];
    if (useAms && slots.some((x) => !(x >= 1 && x <= 16))) return { text: "slots 里是 AMS 的槽号（1 起）。", isError: true };
    const remote = local ? path.basename(local.path) : file.replace(/^\/+/, "");
    const title = path.basename(remote).replace(/\.(gcode\.3mf|3mf)$/i, "");
    const key = JSON.stringify([file, plate, useAms, useAms ? slots : [], args?.bed_leveling !== false, args?.timelapse === true]);
    const now = Date.now();
    for (const [c, v] of this.codes) if (v.exp < now) this.codes.delete(c);
    const given = String(args?.confirm ?? "").trim();
    if (!given || this.codes.get(given)?.key !== key) {
      const code = String(Math.floor(1000 + Math.random() * 9000));
      this.codes.set(code, { key, exp: now + CONFIRM_TTL_MS });
      const tray = (n: number) => { const t = s.trays.find((x) => x.slot === n); return `${n} 号槽${t ? `（${[t.color, t.type].filter(Boolean).join(" ")}${t.remain !== null ? `，剩 ${t.remain}%` : ""}）` : "（没看到这个槽里有料）"}`; };
      return {
        text: `还没开始打印。${given ? "确认码不对或者参数变了，重新确认：" : ""}\n要打的是：「${title}」第 ${plate} 盘${local ? `（这台电脑上的文件，${mb(local.size)}，会先传到打印机）` : "（打印机上的文件）"}`
          + `\n用料：${useAms ? slots.map(tray).join("、") : "外挂料盘"}\n打印前调平：${args?.bed_leveling === false ? "否" : "是"}；延时摄影：${args?.timelapse === true ? "是" : "否"}`
          + `\n把上面的内容告诉主人，并请主人确认：① 热床上是空的、打印板放好了；② 就打这个、用这个料。`
          + `\n主人明确同意后，带上 confirm="${code}"、其余参数不变再调一次（${CONFIRM_TTL_MS / 60_000} 分钟内有效）。主人没同意不要调。`,
      };
    }
    this.codes.delete(given);
    if (local) {
      let ftp: Ftps;
      try { ftp = await this.ftp(); } catch (e: any) { return { text: `连不上打印机的文件服务，没传上去：${e.message}`, isError: true }; }
      try {
        this.o.log(`[${this.o.name}] ⬆️  上传 ${remote}（${mb(local.size)}）`);
        await ftp.upload(`/${remote}`, fs.createReadStream(local.path));
      } catch (e: any) { return { text: `文件没传上去：${e.message}`, isError: true }; } finally { ftp.close(); }
    }
    const res = await p.command("print", {
      command: "project_file", param: `Metadata/plate_${plate}.gcode`, url: `${this.o.fileUrl || "ftp:///"}${remote}`, file: "", md5: "", subtask_name: title,
      bed_type: "auto", timelapse: args?.timelapse === true, bed_leveling: args?.bed_leveling !== false, flow_cali: true, vibration_cali: true, layer_inspect: false,
      use_ams: useAms, ams_mapping: useAms ? slots.map((x) => x - 1) : [], profile_id: "0", project_id: "0", subtask_id: "0", task_id: "0",
    }, p.options.ackMs ?? 15_000);          // 开始打印的回执比暂停之类慢
    this.o.log(`[${this.o.name}] ▶️  开始打印 ${remote} 第 ${plate} 盘 → ${res.ok ? "成功" : res.reason}`);
    if (res.ok) return { text: `「${title}」开始打印了${local ? "（文件已经传到打印机）" : ""}。过半分钟用 printer_status 看看是不是真的在准备 / 打印了；打完会自动通知主人。` };
    return { text: `${local ? "文件传上去了，但" : ""}${res.reason}。用 printer_status 看看实际有没有开始。`, isError: !res.sent };
  }
}
