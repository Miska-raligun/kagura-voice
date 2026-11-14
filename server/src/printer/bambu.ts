// 拓竹（Bambu Lab）打印机的局域网接口：TLS 上的 MQTT（8883 端口，用户名 bblp，密码 = 打印机屏幕上的访问码），
// 订阅 device/<序列号>/report 收状态。只读：不开「开发者模式」时第三方发不了控制指令（拓竹的授权限制），这里也不发，
// 只发一条 pushall（要一份完整状态）。打印机平时推的是增量，要自己并进上一份。
//
// ⚠️ 字段含义来自社区的逆向（ha-bambulab 等），没有官方文档；写这个文件时手边没有真机（P2S），
// 所以解析一律「有就用、没有就空着」，原始数据在管理界面能看——真机上哪项不对，照着原始数据改这里。
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { MqttLite } from "./mqttlite.ts";

export type PrintState = "idle" | "preparing" | "printing" | "paused" | "finished" | "failed" | "unknown";
export interface Temp { now: number; target: number }
export interface Tray { slot: number; type: string; color: string; remain: number | null }
/** 一个料盒（AMS）：编号从 1 起（打印机里 0 起；AMS HT 是 128 起）；型号从 get_version 里认，认不出是空 */
export interface AmsUnit { id: number; no: number; model: string; humidity: number | null; temp: number | null; dryingMin: number | null; dryTemp: number | null }
/** 能烘干的料盒型号（ha-bambulab 整理的） */
export const DRYING_MODELS = ["AMS 2 Pro", "AMS HT"];
/** get_version 里模块名的前缀 → 料盒型号（ha-bambulab 整理的） */
const AMS_MODULES: [RegExp, string][] = [[/^n3f\//, "AMS 2 Pro"], [/^n3s\//, "AMS HT"], [/^ams_f1\//, "AMS Lite"], [/^n10a/, "AMS 3H"], [/^ams\//, "AMS"]];
export function amsModelsOf(modules: any[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const x of Array.isArray(modules) ? modules : []) {
    const name = String(x?.name ?? "");
    const hit = AMS_MODULES.find(([re]) => re.test(name));
    const id = Number(name.split("/")[1]);
    if (hit && Number.isFinite(id)) m.set(id, hit[1]);
  }
  return m;
}
export interface PrinterStatus {
  state: PrintState;
  /** 打印机报的原始状态（IDLE / PREPARE / RUNNING / PAUSE / FINISH / FAILED…） */
  rawState: string;
  job: string;
  percent: number | null;
  remainMin: number | null;
  layer: number | null;
  layers: number | null;
  /** 现在在做什么（调平、换料、因为缺料暂停…），不认识的阶段是空 */
  stage: string;
  stageId: number | null;
  nozzle: Temp | null;
  bed: Temp | null;
  chamber: number | null;
  speed: string;
  /** 错误码（0300-400C 这种写法），没有是空 */
  error: string;
  /** 健康告警（HMS）：severity 1 致命 / 2 严重 / 3 一般 / 4 提示 */
  hms: { code: string; severity: number }[];
  trays: Tray[];
  /** 正在用的料槽（1 起）；外挂料盘 = 0；没在用 = null */
  activeSlot: number | null;
  amsHumidity: number | null;
  /** 每个料盒的温湿度、烘干剩余 */
  ams: AmsUnit[];
  wifi: string;
  /** 能不能控制：true = 开了开发者模式（第三方指令不用签名）；false = 没开，只能看；null = 打印机没报 */
  devMode: boolean | null;
}

const STATES: Record<string, PrintState> = { IDLE: "idle", PREPARE: "preparing", SLICING: "preparing", RUNNING: "printing", PAUSE: "paused", FINISH: "finished", FAILED: "failed" };
/** stg_cur → 人话（社区整理的表；P2S 上可能有没列到的，那就不说） */
const STAGES: Record<number, string> = {
  1: "自动调平", 2: "热床预热", 3: "共振补偿校准", 4: "换料", 5: "暂停（G-code 里的暂停点）", 6: "暂停：缺料了", 7: "喷嘴加热", 8: "挤出校准", 9: "扫描热床",
  10: "检查首层", 11: "识别打印板", 12: "校准激光雷达", 13: "回零", 14: "清理喷嘴", 15: "检查喷嘴温度", 16: "暂停（在打印机上手动暂停的）", 17: "暂停：前盖掉了",
  18: "校准激光雷达", 19: "流量校准", 20: "暂停：喷嘴温度异常", 21: "暂停：热床温度异常", 22: "退料", 23: "暂停：电机丢步", 24: "进料", 25: "电机噪音校准",
  26: "暂停：AMS 断开了", 27: "暂停：散热风扇转速太低", 28: "暂停：仓温控制异常", 29: "仓内降温", 30: "暂停（G-code 里的暂停点）", 32: "暂停：喷嘴裹料了",
  33: "暂停：切刀卡住了", 34: "暂停：首层有问题", 35: "暂停：喷嘴堵了",
  // 新一代机型（H2 / P2）多出来的
  36: "精度校准前检查", 37: "精度校准", 38: "精度校准后检查", 39: "喷嘴偏移校准", 40: "高温调平", 41: "检查快拆", 42: "检查门和上盖", 43: "激光校准", 44: "检查平台",
  47: "调平", 48: "调平", 49: "仓内加热", 50: "热床降温", 51: "打印校准线", 52: "检查耗材", 54: "等热床到温度", 55: "检查耗材位置", 58: "预热保温",
  63: "等仓温稳定", 64: "准备热端", 65: "喷嘴结块检测校准", 66: "净化仓内空气", 68: "移到废料口上方", 69: "喷嘴降温", 72: "识别热端类型", 73: "检查打印板有没有放正",
  74: "检查热床上有没有异物", 75: "检查热床下面有没有异物", 76: "打印前预挤出", 77: "准备 AMS", 82: "等热床温度稳定",
};
/** 人自己按的暂停（不用通知） */
export const STAGE_USER_PAUSE = 16;
/** 打印被取消时的错误码（取消也报成 FAILED）；不算失败、不通知 */
export const ERR_CANCELLED = "0300-400C";
const SPEEDS: Record<number, string> = { 1: "静音", 2: "标准", 3: "运动", 4: "狂暴" };

const num = (v: unknown): number | null => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN; return Number.isFinite(n) ? n : null; };
const hex4 = (n: number) => (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
/** 错误码写成屏幕上那种 XXXX-XXXX */
export const errCode = (n: number) => `${hex4(n >>> 16)}-${hex4(n)}`;
/** 新一代机型把「目标温度 << 16 | 当前温度」塞在一个数里 */
function packedTemp(v: unknown): Temp | null {
  const n = num(v);
  if (n === null || n < 0) return null;
  const t = { now: n & 0xffff, target: (n >>> 16) & 0xffff };
  return t.now <= 500 && t.target <= 500 ? t : null;
}
const temp = (now: unknown, target: unknown): Temp | null => { const a = num(now); return a === null ? null : { now: Math.round(a), target: Math.round(num(target) ?? 0) }; };

/** 料的颜色（RRGGBBAA）→ 大概的颜色名，说给人听用 */
export function colorName(hex: string): string {
  const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(String(hex ?? "").replace(/^#/, ""));
  if (!m) return "";
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
  if (m[4] !== undefined && parseInt(m[4], 16) < 40) return "透明";
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 28) return max < 60 ? "黑色" : max > 215 ? "白色" : "灰色";
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 45 && max < 170 && d / max > 0.3 && h >= 10) return "棕色";
  if (h < 15 || h >= 340) return max > 220 && min > 140 ? "粉色" : "红色";
  if (h < 45) return "橙色";
  if (h < 70) return "黄色";
  if (h < 165) return "绿色";
  if (h < 200) return "青色";
  if (h < 260) return "蓝色";
  if (h < 300) return "紫色";
  return "粉色";
}

/** 增量并进上一份：对象递归并；元素带 id 的数组按 id 并（AMS 的料槽）；其它数组、标量直接换 */
export function merge(base: any, delta: any): any {
  if (Array.isArray(delta)) {
    const byId = Array.isArray(base) && delta.every((x) => x && typeof x === "object" && "id" in x) && base.every((x: any) => x && typeof x === "object" && "id" in x);
    if (!byId) return delta;
    const out = base.map((x: any) => ({ ...x }));
    for (const d of delta) {
      const i = out.findIndex((x: any) => String(x.id) === String(d.id));
      if (i >= 0) out[i] = merge(out[i], d); else out.push(d);
    }
    return out;
  }
  if (delta && typeof delta === "object") {
    const out: any = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(delta)) out[k] = merge(out[k], v);
    return out;
  }
  return delta;
}

/** 原始状态（report 里 print 那一段并出来的）→ 整理好的状态 */
export function parseStatus(p: any, amsModels: Map<number, string> = new Map()): PrinterStatus {
  p = p && typeof p === "object" ? p : {};
  const rawState = String(p.gcode_state ?? "").toUpperCase();
  const stageId = num(p.stg_cur);
  const err = num(p.print_error) ?? 0;
  const dev = p.device && typeof p.device === "object" ? p.device : {};
  // 单喷嘴的机器是 id 0 那一项
  const exts: any[] = Array.isArray(dev.extruder?.info) ? dev.extruder.info : [];
  const ext = exts.find((e) => Number(e?.id) === 0) ?? exts[0];
  // fun 是一串十六进制的功能位；0x20000000 = 指令要签名（没开开发者模式）
  let devMode: boolean | null = null;
  if (typeof p.fun === "string" && /^[0-9a-f]+$/i.test(p.fun)) { try { devMode = (BigInt(`0x${p.fun}`) & 0x20000000n) === 0n; } catch { /* 不认识就当不知道 */ } }
  const trays: Tray[] = [];
  const ams: AmsUnit[] = [];
  let humidity: number | null = null;
  for (const unit of Array.isArray(p.ams?.ams) ? p.ams.ams : []) {
    const u = num(unit?.id) ?? 0;
    humidity ??= num(unit?.humidity_raw);
    const dryMin = num(unit?.dry_time);
    ams.push({ id: u, no: u >= 128 ? u - 127 : u + 1, model: amsModels.get(u) ?? "", humidity: num(unit?.humidity_raw), temp: num(unit?.temp),
      dryingMin: dryMin, dryTemp: num(unit?.dry_setting?.dry_temperature) });
    for (const t of Array.isArray(unit?.tray) ? unit.tray : []) {
      const type = String(t?.tray_sub_brands || t?.tray_type || "").trim();
      if (!type) continue;                       // 空槽
      const remain = num(t?.remain);
      trays.push({ slot: u * 4 + (num(t?.id) ?? 0) + 1, type, color: colorName(String(t?.tray_color ?? "")), remain: remain !== null && remain >= 0 && remain <= 100 ? remain : null });
    }
  }
  const now = num(p.ams?.tray_now);
  const file = String(p.subtask_name || p.gcode_file || "").split(/[\\/]/).pop()!.replace(/\.(gcode\.3mf|3mf|gcode)$/i, "");
  return {
    state: STATES[rawState] ?? "unknown", rawState,
    job: file,
    percent: num(p.mc_percent), remainMin: num(p.mc_remaining_time),
    layer: num(p.layer_num), layers: num(p.total_layer_num),
    stage: stageId !== null ? STAGES[stageId] ?? "" : "", stageId,
    nozzle: temp(p.nozzle_temper, p.nozzle_target_temper) ?? packedTemp(ext?.temp),
    bed: temp(p.bed_temper, p.bed_target_temper) ?? packedTemp(dev.bed?.info?.temp),
    chamber: num(p.chamber_temper) !== null ? Math.round(num(p.chamber_temper)!) : packedTemp(dev.ctc?.info?.temp)?.now ?? null,
    speed: SPEEDS[num(p.spd_lvl) ?? 0] ?? "",
    error: err ? errCode(err) : "",
    hms: (Array.isArray(p.hms) ? p.hms : []).map((h: any) => {
      const a = num(h?.attr) ?? 0, c = num(h?.code) ?? 0;
      return { code: `${hex4(a >>> 16)}-${hex4(a)}-${hex4(c >>> 16)}-${hex4(c)}`, severity: (c >>> 16) & 0xff };
    }),
    trays,
    activeSlot: now === null || now === 255 ? null : now === 254 ? 0 : now + 1,
    amsHumidity: humidity,
    ams,
    wifi: String(p.wifi_signal ?? ""),
    devMode,
  };
}

export const fmtDuration = (min: number) => { const m = Math.max(0, Math.round(min)); return m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ""}` : `${m} 分钟`; };
const STATE_TEXT: Record<PrintState, string> = { idle: "空闲", preparing: "准备中", printing: "正在打印", paused: "暂停着", finished: "打完了", failed: "失败了", unknown: "状态不明" };

/** 说给 agent 听的一段状态 */
export function describeStatus(s: PrinterStatus, now = new Date()): string {
  const busy = s.state === "printing" || s.state === "preparing" || s.state === "paused";
  const parts: string[] = [];
  let head = STATE_TEXT[s.state];
  if (s.state === "failed" && s.error === ERR_CANCELLED) head = "上一个任务被取消了";
  if (s.job && s.state !== "idle") head += `「${s.job}」`;
  if (busy) {
    const bits: string[] = [];
    if (s.percent !== null) bits.push(`${s.percent}%`);
    if (s.layer !== null && s.layers) bits.push(`第 ${s.layer}/${s.layers} 层`);
    if (s.remainMin !== null && s.remainMin > 0) {
      const eta = new Date(now.getTime() + s.remainMin * 60_000);
      bits.push(`还要 ${fmtDuration(s.remainMin)}（预计 ${String(eta.getHours()).padStart(2, "0")}:${String(eta.getMinutes()).padStart(2, "0")} 打完）`);
    }
    if (bits.length) head += `，${bits.join("，")}`;
  }
  parts.push(head + "。");
  if (busy && s.stage) parts.push(`现在：${s.stage}。`);
  if (s.error && !(s.state === "failed" && s.error === ERR_CANCELLED)) parts.push(`错误码 ${s.error}（具体含义看打印机屏幕）。`);
  const bad = s.hms.filter((h) => h.severity > 0 && h.severity <= 2);
  if (bad.length) parts.push(`告警：${bad.map((h) => `HMS ${h.code}`).join("、")}。`);
  const temps: string[] = [];
  const t = (name: string, x: Temp | null) => { if (x) temps.push(`${name} ${x.now}℃${x.target ? `（目标 ${x.target}℃）` : ""}`); };
  t("喷嘴", s.nozzle); t("热床", s.bed);
  if (s.chamber !== null) temps.push(`仓内 ${s.chamber}℃`);
  if (temps.length) parts.push(temps.join("，") + "。");
  if (busy && s.speed) parts.push(`速度档：${s.speed}。`);
  if (s.trays.length) {
    parts.push(`料：${s.trays.map((x) => `${x.slot} 号 ${[x.color, x.type].filter(Boolean).join(" ")}${x.remain !== null ? `（剩 ${x.remain}%）` : ""}`).join("、")}`
      + (s.activeSlot ? `；正在用 ${s.activeSlot} 号` : s.activeSlot === 0 ? "；正在用外挂料盘" : "") + "。");
  }
  if (s.ams.length) {
    parts.push(`料盒：${s.ams.map((a) => {
      const bits = [a.humidity !== null ? `湿度 ${a.humidity}%` : "", a.temp !== null ? `${Math.round(a.temp)}℃` : "",
        a.dryingMin ? `正在烘干（还剩 ${fmtDuration(a.dryingMin)}${a.dryTemp ? `，${a.dryTemp}℃` : ""}）` : ""].filter(Boolean);
      return `${a.no} 号${a.model ? `（${a.model}）` : " "}${bits.join("，")}`;
    }).join("；")}。`);
  }
  return parts.join("");
}

// ── 连接 ──

export interface Dialed { sock: Duplex; fingerprint: string }
export type Dial = (host: string, port: number) => Promise<Dialed>;

/** 打印机的证书是它自己签的（没有公共 CA），没法按常规验证：改成「第一次见到记下指纹，以后必须一样」（见 BambuPrinter.connect） */
/** 最高只用 TLS 1.2：P2S 的固件（01.02）对 TLS 1.3 的握手不回应，会一直挂到超时；1.2 立刻就回（ha-bambulab 里踩出来的） */
export const TLS_MAX = "TLSv1.2" as const;
export const tlsDial: Dial = (host, port) => new Promise((resolve, reject) => {
  const s = tls.connect({ host, port, rejectUnauthorized: false, timeout: 10_000, maxVersion: TLS_MAX });
  s.once("secureConnect", () => { s.setTimeout(0); resolve({ sock: s, fingerprint: s.getPeerCertificate()?.fingerprint256 ?? "" }); });
  s.once("timeout", () => s.destroy(new Error("连接超时")));
  s.once("error", reject);
});

export type ConnState = "off" | "connecting" | "online" | "error";
export type PrinterEvent =
  | { kind: "finish" | "failed" | "paused"; status: PrinterStatus; elapsedMin: number | null }
  | { kind: "warning"; status: PrinterStatus; codes: string[] }
  | { kind: "dried"; status: PrinterStatus; unit: AmsUnit }
  | { kind: "cert" };

export interface BambuOpts {
  host: string; serial: string; accessCode: string;
  port?: number;
  /** 上次记下的证书指纹；空 = 还没见过，这次记下 */
  fingerprint?: string;
  onFingerprint?(fp: string): void;
  onEvent?(e: PrinterEvent): void;
  dial?: Dial;
  /** 状态变了之后等多久再判断（增量是一条条来的，状态和原因可能不在同一条里） */
  settleMs?: number;
  /** 控制指令等回执等多久（默认 6 秒） */
  ackMs?: number;
  log?(line: string): void;
}

const ACTIVE = new Set<PrintState>(["preparing", "printing", "paused"]);
/** 同一个告警多久内不重复通知 */
const WARN_QUIET_MS = 30 * 60_000;
const PUSHALL_EVERY_MS = 5 * 60_000;

export class BambuPrinter {
  conn: ConnState = "off";
  error = "";
  /** 并好的原始状态（report 的 print 段） */
  raw: any = {};
  /** 最近一次收到状态（毫秒时间戳） */
  lastSeen = 0;
  /** 连上的时刻 */
  since = 0;
  private mq: MqttLite | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private backoff = 5000;
  private stopped = true;
  private msgs = 0;
  private prev: PrintState | undefined;
  private jobStart = 0;
  private warned = new Map<string, number>();
  private hmsSeen: Set<string> | null = null;
  private seq = 0;
  /** 等回执的指令：sequence_id → 收到回执时调 */
  private acks = new Map<string, (r: any) => void>();

  constructor(private o: BambuOpts) {}

  /** 料盒型号（get_version 回来的），打印机固件版本 */
  amsModels = new Map<number, string>();
  firmware = "";
  private drying = new Map<number, number>();
  get status(): PrinterStatus { return parseStatus(this.raw, this.amsModels); }
  /** 收到过带状态的数据（没收到之前别拿空状态说「空闲」） */
  get ready() { return typeof this.raw?.gcode_state === "string"; }

  start() { if (!this.stopped) return; this.stopped = false; void this.connect(); }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.poll) clearInterval(this.poll);
    this.retry = this.poll = null;
    this.mq?.close();
    this.mq = null;
    this.conn = "off";
  }

  private log(s: string) { (this.o.log ?? console.log)(s); }

  private again(ms = this.backoff) {
    if (this.stopped) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => { void this.connect(); }, ms);
    this.retry.unref?.();
    this.backoff = Math.min(60_000, this.backoff * 2);
  }

  private fail(msg: string, retryMs?: number) {
    const first = this.error !== msg;
    this.conn = "error";
    this.error = msg;
    if (first) this.log(`⚠️  ${msg}`);
    if (retryMs !== 0) this.again(retryMs);
  }

  private async connect() {
    if (this.stopped) return;
    this.conn = "connecting";
    let d: Dialed;
    try { d = await (this.o.dial ?? tlsDial)(this.o.host, this.o.port ?? 8883); }
    catch (e: any) {
      const code = String(e?.code ?? "");
      return this.fail(/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/.test(code) || /超时/.test(String(e?.message))
        ? `连不上 ${this.o.host}（打印机开着吗？IP 对吗？和这台电脑在同一个局域网吗？）` : `连不上 ${this.o.host}：${e?.message ?? e}`);
    }
    if (this.stopped) { d.sock.destroy(); return; }
    // 证书指纹：第一次记下；以后不一样就不连——别把访问码发给一台冒充的机器。打印机恢复出厂后会变，那时在管理界面重新确认
    if (this.o.fingerprint && d.fingerprint && d.fingerprint !== this.o.fingerprint) {
      d.sock.destroy();
      const first = this.error === "" || !this.error.startsWith("证书");
      this.fail("证书和上次连接时不一样，先不连了。打印机恢复过出厂设置 / 换过机器的话，在管理界面点「重新信任」", 0);
      if (first) this.o.onEvent?.({ kind: "cert" });
      return;
    }
    if (!this.o.fingerprint && d.fingerprint) { this.o.fingerprint = d.fingerprint; this.o.onFingerprint?.(d.fingerprint); }
    const topic = `device/${this.o.serial}`;
    this.msgs = 0;
    const mq = new MqttLite(d.sock, {
      clientId: `kagura-${Math.random().toString(36).slice(2, 10)}`, username: "bblp", password: this.o.accessCode, keepalive: 60,
      onConnect: () => {
        this.conn = "online"; this.error = ""; this.backoff = 5000; this.since = Date.now();
        this.log(`🔌 已连接 ${this.o.host}`);
        mq.subscribe(`${topic}/report`);
        this.pushall();
        // 版本信息（只读）：认料盒型号（能不能烘干）、固件版本
        mq.publish(`${topic}/request`, JSON.stringify({ info: { sequence_id: String(++this.seq), command: "get_version" } }));
        if (this.poll) clearInterval(this.poll);
        // 增量偶尔会漏、空闲时打印机也不怎么推：隔一阵要一份完整的（别太勤，老机型处理不过来）
        this.poll = setInterval(() => { if (Date.now() - this.lastSeen > PUSHALL_EVERY_MS) this.pushall(); }, 60_000);
        this.poll.unref?.();
      },
      onMessage: (_t, payload) => { try { this.onReport(JSON.parse(payload.toString("utf8"))); } catch { /* 不是 JSON 的不管 */ } },
      onClose: (err, code) => {
        if (this.mq !== mq) return;
        this.mq = null;
        if (this.poll) clearInterval(this.poll);
        this.poll = null;
        if (this.stopped) return;
        if (code === 4 || code === 5) return this.fail("访问码不对（在打印机屏幕的「设置 → 局域网」里看，注意它会在重置网络后变）", 5 * 60_000);
        // 连上了、一条状态都没收到就被断开：多半是序列号填错（订阅别人的主题会被踢）
        if (this.since && this.msgs === 0 && Date.now() - this.since < 15_000) return this.fail("连上了但马上被断开：序列号可能填错了（在打印机屏幕「设置 → 设备信息」里看）", 60_000);
        this.fail(`连接断了（${err}），稍后重连`);
      },
    });
    this.mq = mq;
  }

  get options() { return this.o; }

  /**
   * 发一条控制指令（要开发者模式；没开时打印机会拒绝）。等它的回执：ok = 打印机说成功；回执里说失败就带原因；
   * 几秒没回执 = 发出去了但不知道结果（让调用方看状态确认）。
   */
  command(kind: "print" | "system", body: Record<string, unknown>, timeoutMs = this.o.ackMs ?? 6000): Promise<{ ok: boolean; sent: boolean; reason: string }> {
    if (!this.mq || this.conn !== "online") return Promise.resolve({ ok: false, sent: false, reason: `没连上打印机（${this.error || "还在连接"}）` });
    const id = String(++this.seq + 1000);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.acks.delete(id); resolve({ ok: false, sent: true, reason: "指令发出去了，但打印机没有回应" }); }, timeoutMs);
      t.unref?.();
      this.acks.set(id, (r) => {
        clearTimeout(t);
        this.acks.delete(id);
        const res = String(r?.result ?? "").toLowerCase();
        const bad = (res && res !== "success") || (num(r?.err_code) ?? 0) !== 0;
        // 没开开发者模式时打印机回的是「校验失败」之类：换成人话
        const why = String(r?.reason ?? "") + (r?.err_code ? `（${r.err_code}）` : "");
        resolve(bad ? { ok: false, sent: true, reason: /verif|sign|auth/i.test(why) || r?.err_code === 84033543 ? `打印机拒绝了（${why}）：多半是没开开发者模式` : `打印机说失败了：${why || res}` } : { ok: true, sent: true, reason: "" });
      });
      this.mq!.publish(`device/${this.o.serial}/request`, JSON.stringify({ [kind]: { sequence_id: id, ...body } }), 1);
    });
  }

  /** 要一份完整状态（只读请求，不是控制指令） */
  private pushall() {
    this.mq?.publish(`device/${this.o.serial}/request`, JSON.stringify({ pushing: { sequence_id: String(++this.seq), command: "pushall", version: 1, push_target: 1 } }));
  }

  private onReport(msg: any) {
    if (msg?.info?.command === "get_version" && Array.isArray(msg.info.module)) {
      this.amsModels = amsModelsOf(msg.info.module);
      this.firmware = String(msg.info.module.find((m: any) => m?.name === "ota")?.sw_ver ?? this.firmware);
    }
    // 指令的回执：按 sequence_id 对上（print / system 两种外壳）
    for (const k of ["print", "system"]) {
      const r = msg?.[k];
      const ack = r && typeof r === "object" && r.command !== "push_status" ? this.acks.get(String(r.sequence_id ?? "")) : undefined;
      if (ack) ack(r);
    }
    const p = msg?.print;
    if (!p || typeof p !== "object") return;
    if (p.command !== undefined && p.command !== "push_status") return;      // 别的指令的回执，不是状态
    this.msgs++;
    this.lastSeen = Date.now();
    this.raw = merge(this.raw, p);
    if (!this.ready) return;
    const s = this.status;
    // 开打的时刻：看见它从别的状态进到「准备 / 打印」时记下；中途才连上的用打印机报的开始时间
    if (ACTIVE.has(s.state) && !(this.prev && ACTIVE.has(this.prev))) {
      const t = num(this.raw.gcode_start_time);
      this.jobStart = this.prev === undefined ? (t && t > 1e9 ? t * 1000 : 0) : Date.now();
    }
    if (s.state !== this.prev) {
      const from = this.prev;
      this.prev = s.state;
      if (from !== undefined) this.later(() => this.transition(from, s.state));
    }
    // 料盒烘干完了（剩余时间从有变成 0）；刚连上时看到的不算
    for (const a of s.ams) {
      const before = this.drying.get(a.id);
      if (a.dryingMin === null) continue;
      this.drying.set(a.id, a.dryingMin);
      if (before !== undefined && before > 0 && a.dryingMin === 0) this.o.onEvent?.({ kind: "dried", status: s, unit: a });
    }
    // 新冒出来的严重告警（刚连上时已经在的不算新的）
    const codes = s.hms.filter((h) => h.severity > 0 && h.severity <= 2).map((h) => h.code);
    if (this.hmsSeen === null) this.hmsSeen = new Set(codes);
    else {
      const fresh = codes.filter((c) => !this.hmsSeen!.has(c));
      this.hmsSeen = new Set(codes);
      if (fresh.length) this.later(() => this.warn(fresh));
    }
  }

  private later(fn: () => void) { const t = setTimeout(fn, this.o.settleMs ?? 3000); t.unref?.(); }

  private transition(from: PrintState, to: PrintState) {
    const s = this.status;
    if (s.state !== to || !ACTIVE.has(from)) return;                          // 又变了 / 不是从打印中变过来的
    const elapsedMin = this.jobStart ? (Date.now() - this.jobStart) / 60_000 : null;
    if (to === "finished") this.o.onEvent?.({ kind: "finish", status: s, elapsedMin });
    else if (to === "failed") {
      if (s.error === ERR_CANCELLED) return this.log(`「${s.job}」被取消了（不通知）`);
      this.o.onEvent?.({ kind: "failed", status: s, elapsedMin });
    } else if (to === "paused") {
      if (s.stageId === STAGE_USER_PAUSE) return this.log("在打印机上手动暂停的（不通知）");
      this.o.onEvent?.({ kind: "paused", status: s, elapsedMin });
    }
  }

  private warn(codes: string[]) {
    const s = this.status;
    if (s.state !== "printing" && s.state !== "preparing") return;            // 失败 / 暂停有各自的通知，别重复
    const now = Date.now();
    const fresh = codes.filter((c) => now - (this.warned.get(c) ?? 0) > WARN_QUIET_MS);
    if (!fresh.length) return;
    for (const c of fresh) this.warned.set(c, now);
    this.o.onEvent?.({ kind: "warning", status: s, codes: fresh });
  }
}
