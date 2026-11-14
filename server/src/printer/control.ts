// 拓竹打印机的控制（要打印机开了「仅局域网模式」+「开发者模式」，MCP 配置里 BAMBU_CONTROL=1 才有这些工具）：
// 暂停 / 继续 / 停止 / 开关灯 / 速度档；列打印机上的文件；把切好的文件传上去并开始打印。
// 开始打印是两步：第一次调只返回「要打什么」和一个确认码，主人同意后带着码再调一次才真的开始——打印机是会加热的设备，
// 热床上有没有东西只有人看得到。Kagura 那边再配 "ownerOnly"，后台场景（待办 / 定时任务 / heartbeat）里根本没有这两个工具（mcp.ts）。
// 指令格式来自社区整理的协议（ha-bambulab / OpenBambuAPI），写的时候没有真机。
import fs from "node:fs";
import path from "node:path";
import type { BambuPrinter, PrinterStatus } from "./bambu.ts";
import { Ftps, type FtpDial, type FtpEntry } from "./ftps.ts";
import { zipNames, platesOf, projectInfo, sliceInfo, modelMatches, fmtSeconds } from "./threemf.ts";
import { DRYING_MODELS } from "./bambu.ts";
import { slice, type SliceEnv } from "./slice.ts";

export { zipNames, platesOf };

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
      + "只有模型（.stl / 没切片的 .3mf，比如从 MakerWorld 下载的）时先用 printer_slice 切好，再把切好的文件给这里。"
      + "分两步：第一次调（不带 confirm）只返回要打什么和一个确认码；把内容告诉主人，主人确认「热床上是空的、就打这个、用这个料」之后，带上 confirm 用同样的参数再调一次才真的开始。主人没明确同意不要带 confirm。",
    inputSchema: {
      type: "object", required: ["file"],
      properties: {
        file: { type: "string", description: "这台电脑上的文件路径，或打印机上的文件名" },
        plate: { type: "number", description: "第几盘（一个文件里有多盘时），默认第一盘" },
        slots: { type: "array", items: { type: "number" }, description: "文件里用到的每种料各在 AMS 的几号槽（1 起，按文件里料的顺序）；文件只用一种料时不填 = 用现在在用的那个槽" },
        use_ams: { type: "boolean", description: "false = 用外挂料盘；不填 = 有 AMS 就用" },
        bed_leveling: { type: "boolean", description: "打印前调平，默认 true" },
        timelapse: { type: "boolean", description: "拍延时摄影，默认 false" },
        confirm: { type: "string", description: "第一次调返回的确认码；主人同意后才带" },
      },
    },
  },
  {
    name: "printer_ams_dry", title: "料盒烘干",
    description: "让 AMS 料盒烘干耗材（AMS 2 Pro / AMS HT 才能烘干）或停止烘干。状态里看得到每个料盒的湿度和烘干剩余时间；烘干完会自动通知主人。"
      + "温度按料选（不填就按料盒里的料自动选常用值）：PLA 不要超过 55℃（会软化粘在一起），PETG / TPU 约 65℃，ABS / ASA / PA / PC 料盒能给多高给多高。AMS 2 Pro 最高 65℃，AMS HT 最高 85℃；时长 1~24 小时。",
    inputSchema: {
      type: "object", required: ["action"],
      properties: {
        action: { type: "string", enum: ["start", "stop"] },
        ams: { type: "number", description: "第几号料盒（1 起，和状态里的编号一样），默认 1" },
        temp: { type: "number", description: "烘干温度 ℃（45~65，AMS HT 到 85）；不填按料自动选" },
        hours: { type: "number", description: "烘干几小时（1~24），不填按料自动选" },
        rotate: { type: "boolean", description: "烘干时转动料卷（烘得更均匀），默认 false" },
      },
    },
  },
  {
    name: "printer_slice", title: "切片",
    description: "用这台电脑上的 Bambu Studio 把模型切成能打的文件（.gcode.3mf），按这台打印机的配置切。输入是这台电脑上的 .3mf（Bambu Studio 项目、MakerWorld 下载的）或 .stl。"
      + "MakerWorld 上同一个模型常有好几份打印配置，优先下载给这台打印机型号做的那份——用它自带的配置切最稳；给别的机型的、STL 会换成这台的系统配置重切（原作者调过的参数带不过来）。"
      + "参数不填就用文件里 / 系统配置里的；主人提了要求（更结实、更快、要不要支撑）再改对应的几项。切好后把预计时间、用料告诉主人，再用 printer_print 打（它会再让主人确认）。切片可能要几分钟。",
    inputSchema: {
      type: "object", required: ["file"],
      properties: {
        file: { type: "string", description: "这台电脑上的 .3mf / .stl（绝对路径）" },
        plate: { type: "number", description: "切第几盘，默认第一盘" },
        layer_height: { type: "number", description: "层高 mm：0.12 细、0.2 标准、0.28 快" },
        infill: { type: "number", description: "填充密度 %：15 一般、25~40 结实、100 实心" },
        walls: { type: "number", description: "墙层数：2 一般、3~4 结实" },
        supports: { type: "string", enum: ["off", "normal", "tree"], description: "支撑：off 不加、normal 普通、tree 树状（悬空多、好拆）" },
        brim: { type: "string", enum: ["auto", "off", "outer"], description: "裙边（帮底面粘牢）：auto 自动、off 不加、outer 外圈加" },
      },
    },
  },
];

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
  /** 这台打印机的型号（「P2S」）：切片按它选配置；发打印前核对文件是不是给它切的。空 = 不核对 */
  model?: string;
  /** 切片（Bambu Studio 在哪、系统配置在哪、切好的放哪） */
  slicer?: Omit<SliceEnv, "model" | "log">;
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

  /** 料盒烘干 / 停止烘干 */
  async dry(args: any): Promise<{ text: string; isError?: boolean }> {
    const r = this.ready();
    if (typeof r === "string") return { text: r, isError: true };
    const { p, s } = r;
    if (!s.ams.length) return { text: `${this.o.name} 上没看到料盒（AMS）。`, isError: true };
    const no = Math.round(Number(args?.ams ?? 1));
    const unit = s.ams.find((a) => a.no === no && a.id < 128) ?? s.ams.find((a) => a.no === no);
    if (!unit) return { text: `没有 ${no} 号料盒（有：${s.ams.map((a) => `${a.no} 号${a.model ? `（${a.model}）` : ""}`).join("、")}）。`, isError: true };
    if (unit.model && !DRYING_MODELS.includes(unit.model)) return { text: `${unit.no} 号料盒是 ${unit.model}，不能烘干（AMS 2 Pro / AMS HT 才行）。`, isError: true };
    const action = String(args?.action ?? "");
    if (action === "stop") {
      const res = await p.command("print", { command: "ams_filament_drying", ams_id: unit.id, temp: 0, cooling_temp: 45, duration: 0, humidity: 0, mode: 0, rotate_tray: false, filament: "", close_power_conflict: false });
      this.o.log(`[${this.o.name}] 🔥 停止烘干 ${unit.no} 号 → ${res.ok ? "成功" : res.reason}`);
      return res.ok ? { text: `${unit.no} 号料盒停止烘干了。` } : { text: res.reason, isError: !res.sent };
    }
    if (action !== "start") return { text: "action 是 start 或 stop", isError: true };
    const ht = unit.model === "AMS HT" || unit.id >= 128;
    const max = ht ? 85 : 65;
    // 按料盒里的料选常用值（取里面最怕热的那种）：PLA 类 50℃，其它 65℃（AMS HT 上 ABS / PA / PC 这类再高些）
    const types = s.trays.filter((t) => Math.ceil(t.slot / 4) === unit.id + 1).map((t) => t.type.toUpperCase());
    const soft = types.some((t) => /^PLA|^PVA|^TPU/.test(t));
    const hot = types.length > 0 && types.every((t) => /^(ABS|ASA|PA|PC|PET-CF|PAHT)/.test(t));
    const temp = args?.temp !== undefined ? Number(args.temp) : soft ? 50 : hot && ht ? 80 : 65;
    const hours = args?.hours !== undefined ? Number(args.hours) : soft ? 8 : 12;
    if (!(temp >= 45 && temp <= max)) return { text: `温度要在 45~${max}℃ 之间（${unit.model || (ht ? "AMS HT" : "这个料盒")}最高 ${max}℃）。`, isError: true };
    if (!(hours >= 1 && hours <= 24)) return { text: "时长要在 1~24 小时之间。", isError: true };
    const warn = soft && temp > 55 ? `（注意：料盒里有 ${types.filter((t) => /^PLA|^PVA|^TPU/.test(t)).join("、")}，超过 55℃ 可能软化粘在一起）` : "";
    const res = await p.command("print", { command: "ams_filament_drying", ams_id: unit.id, temp, cooling_temp: 45, duration: Math.round(hours), humidity: 0, mode: 1, rotate_tray: args?.rotate === true, filament: "", close_power_conflict: false });
    this.o.log(`[${this.o.name}] 🔥 烘干 ${unit.no} 号 ${temp}℃ ${hours} 小时 → ${res.ok ? "成功" : res.reason}`);
    if (res.ok) return { text: `${unit.no} 号料盒开始烘干：${temp}℃，${Math.round(hours)} 小时${types.length ? `（里面是 ${[...new Set(types)].join("、")}）` : ""}${warn}。烘干完会通知主人；过一会儿用 printer_status 看剩余时间。` };
    const fw = p.firmware && this.o.model && /P2S/i.test(this.o.model) && p.firmware < "01.01.50.40" ? `（打印机固件 ${p.firmware}，烘干可能要 01.01.50.40 以上，先升级）` : "";
    return { text: `${res.reason}${fw}。用 printer_status 看看料盒是不是开始烘干了。`, isError: !res.sent };
  }

  private slicing: Promise<unknown> = Promise.resolve();

  /** 切片：不用连着打印机（只用这台电脑上的 Bambu Studio）；一次只切一个 */
  async slice(args: any): Promise<{ text: string; isError?: boolean }> {
    if (!this.o.model) return { text: "不知道打印机型号（env 里的 BAMBU_MODEL，比如 P2S / P1S / X1 Carbon / A1），不知道按哪台打印机切。", isError: true };
    const file = String(args?.file ?? "").trim();
    if (!path.isAbsolute(file)) return { text: "file 要给这台电脑上的完整路径（比如浏览器下载文件夹里的那个 .3mf）。", isError: true };
    if (!/\.(3mf|stl)$/i.test(file)) return { text: "只能切 .3mf 和 .stl。别的格式（.step / .obj）让主人在 Bambu Studio 里打开、另存成 3mf。", isError: true };
    if (!fs.existsSync(file)) return { text: `这台电脑上没有 ${file}。`, isError: true };
    if (/\.gcode\.3mf$/i.test(file) || (/\.3mf$/i.test(file) && platesOf(zipNames(file)).length && modelMatches(projectInfo(file).printerModel, this.o.model) && !Object.keys(args).some((k) => k !== "file" && k !== "plate")))
      return { text: "这个文件已经是给这台打印机切好的，直接用 printer_print 打就行；要改参数就带上参数再切一次。" };
    const opts = { plate: args?.plate, layer_height: args?.layer_height, infill: args?.infill, walls: args?.walls, supports: args?.supports, brim: args?.brim };
    for (const k of Object.keys(opts) as (keyof typeof opts)[]) if (opts[k] === undefined || opts[k] === null || opts[k] === "") delete opts[k];
    const job = this.slicing.then(async () => {
      const t0 = Date.now();
      this.o.log(`[${this.o.name}] 🔪 切片 ${path.basename(file)} ${JSON.stringify(opts)}`);
      const r = await slice(file, opts, { ...(this.o.slicer ?? { outDir: "." }), model: this.o.model!, log: this.o.log });
      this.o.log(`[${this.o.name}] 🔪 切好了（${Math.round((Date.now() - t0) / 1000)} 秒）→ ${r.file}`);
      return r;
    });
    this.slicing = job.catch(() => {});
    try {
      const r = await job;
      const p = r.plates.find((x) => x.plate === (opts.plate ?? 1)) ?? r.plates[0];
      const fil = p?.filaments.length ? `\n用料：${p.filaments.map((f, i) => `第 ${i + 1} 种 ${[f.color, f.type].filter(Boolean).join(" ")}${f.grams !== null ? ` ${f.grams.toFixed(1)} 克` : ""}`).join("、")}` : "";
      const changed = Object.entries(opts).filter(([k]) => k !== "plate").map(([k, v]) => `${({ layer_height: "层高", infill: "填充", walls: "墙层数", supports: "支撑", brim: "裙边" } as any)[k]} ${v}${k === "infill" ? "%" : k === "layer_height" ? "mm" : ""}`);
      return {
        text: `切好了：${r.file}\n${r.mode === "project" ? `用的是文件自带的 ${this.o.model} 配置` : `换成了 ${this.o.model} 的系统配置`}${changed.length ? `，改了：${changed.join("、")}` : ""}。`
          + (p?.seconds ? `\n预计打印 ${fmtSeconds(p.seconds)}` : "") + (p?.grams ? `${p?.seconds ? "，" : "\n"}总用料约 ${Math.round(p.grams)} 克` : "") + fil
          + (r.warnings.length ? `\n注意：${r.warnings.join(" ")}` : "")
          + `\n把这些告诉主人；要打就用 printer_print，file 填上面这个路径${p && p.filaments.length > 1 ? `，slots 按「第几种料用几号槽」的顺序填 ${p.filaments.length} 个` : ""}。`,
      };
    } catch (e: any) { return { text: String(e?.message ?? e), isError: true }; }
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
    // 是不是给这台打印机切的：拿别的机型的 G-code 打，喷头可能撞板
    const proj = local ? projectInfo(local.path) : null;
    if (proj?.printerModel && this.o.model && !modelMatches(proj.printerModel, this.o.model))
      return { text: `这个文件是给「${proj.printerModel}」切的，不是 ${this.o.model}，不能直接打（喷头可能撞到打印板）。先用 printer_slice 按这台打印机重新切。`, isError: true };
    const stat = local ? sliceInfo(local.path).find((x) => x.plate === plate) : undefined;
    const used = stat?.filaments.length ? stat.filaments : (proj?.filaments ?? []).map((f, i) => ({ id: i + 1, type: f.type, color: f.color, grams: null }));
    if (local && used.length > 1 && !(Array.isArray(args?.slots) && args.slots.length === used.length) && args?.use_ams !== false)
      return { text: `这一盘用了 ${used.length} 种料：${used.map((f, i) => `第 ${i + 1} 种 ${[f.color, f.type].filter(Boolean).join(" ")}`).join("、")}。要说清每种料用 AMS 的几号槽（slots，按这个顺序，${used.length} 个数）。现在 AMS 里：${s.trays.map((t) => `${t.slot} 号 ${[t.color, t.type].filter(Boolean).join(" ")}`).join("、") || "没看到料"}。`, isError: true };
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
      // 文件里的料和槽里的料材质对不上（比如按 PETG 切的、槽里是 PLA）：温度不对，提醒主人
      const mismatch = (want: { type: string }[], sl: number[]) => {
        const bad = sl.map((n, i) => ({ n, want: want[i]?.type ?? "", have: s.trays.find((x) => x.slot === n)?.type ?? "" }))
          .filter((x) => x.want && x.have && !x.have.toUpperCase().startsWith(x.want.toUpperCase().split(/[\s-]/)[0]));
        return bad.length ? `\n⚠️ 材质对不上：${bad.map((x) => `文件按 ${x.want} 切的，${x.n} 号槽是 ${x.have}`).join("；")}——温度不合适会打坏，最好换料或者按这个料重新切。` : "";
      };
      const tray = (n: number) => { const t = s.trays.find((x) => x.slot === n); return `${n} 号槽${t ? `（${[t.color, t.type].filter(Boolean).join(" ")}${t.remain !== null ? `，剩 ${t.remain}%` : ""}）` : "（没看到这个槽里有料）"}`; };
      return {
        text: `还没开始打印。${given ? "确认码不对或者参数变了，重新确认：" : ""}\n要打的是：「${title}」第 ${plate} 盘${local ? `（这台电脑上的文件，${mb(local.size)}，会先传到打印机）` : "（打印机上的文件）"}`
          + (stat && (stat.seconds || stat.grams) ? `\n预计：${stat.seconds ? fmtSeconds(stat.seconds) : "时间不知道"}${stat.grams ? `，用料约 ${Math.round(stat.grams)} 克` : ""}` : "")
          + `\n用料：${useAms ? slots.map(tray).join("、") : "外挂料盘"}${mismatch(used, useAms ? slots : [])}\n打印前调平：${args?.bed_leveling === false ? "否" : "是"}；延时摄影：${args?.timelapse === true ? "是" : "否"}`
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
