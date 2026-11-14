// 拓竹打印机的 MCP 服务器（只读）：状态解析、增量合并、通知文案；用 aedes 当一台假打印机验连接、鉴权、事件；证书指纹；MCP 协议上的工具和通知
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, afterEach } from "vitest";
import { Aedes } from "aedes";
import { tmpdir } from "./helpers.ts";
import { BambuPrinter, parseStatus, describeStatus, merge, errCode, colorName, tlsDial, type Dial, type PrinterEvent } from "../src/printer/bambu.ts";
import { PassThrough } from "node:stream";
import { eventText, startBambuMcp } from "../src/printer/mcp-server.ts";
import { Ftps, parseList, type FtpDial } from "../src/printer/ftps.ts";
import { zipNames, platesOf } from "../src/printer/control.ts";
import { zip } from "../src/util/zip.ts";

const SERIAL = "22E8AJ5C1234567", CODE = "12345678";
const until = async (fn: () => boolean, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 10)); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一份打印中的完整状态（字段名照社区整理的拓竹局域网协议） */
const FULL = {
  command: "push_status", gcode_state: "RUNNING", subtask_name: "Benchy", gcode_file: "/data/Metadata/plate_1.gcode", mc_percent: 63, mc_remaining_time: 42,
  layer_num: 120, total_layer_num: 190, stg_cur: 0, spd_lvl: 2, print_error: 0, hms: [],
  nozzle_temper: 219.6, nozzle_target_temper: 220, bed_temper: 55, bed_target_temper: 55, chamber_temper: 38, wifi_signal: "-45dBm",
  ams: { tray_now: "1", ams: [{ id: "0", humidity_raw: "23", tray: [
    { id: "0", tray_type: "PLA", tray_sub_brands: "PLA Basic", tray_color: "FFFFFFFF", remain: 80 },
    { id: "1", tray_type: "PETG", tray_color: "1E40AFFF", remain: 35 },
    { id: "2" },
    { id: "3", tray_type: "PLA", tray_color: "000000FF", remain: -1 }] }] },
};

describe("状态解析", () => {
  it("打印中：进度、层数、剩余时间和预计完成时刻、温度、料", () => {
    const s = parseStatus(FULL);
    expect(s).toMatchObject({ state: "printing", job: "Benchy", percent: 63, remainMin: 42, layer: 120, layers: 190, nozzle: { now: 220, target: 220 }, bed: { now: 55, target: 55 }, chamber: 38, speed: "标准", error: "", activeSlot: 2, amsHumidity: 23 });
    expect(s.trays).toEqual([{ slot: 1, type: "PLA Basic", color: "白色", remain: 80 }, { slot: 2, type: "PETG", color: "蓝色", remain: 35 }, { slot: 4, type: "PLA", color: "黑色", remain: null }]);
    const text = describeStatus(s, new Date(2026, 10, 14, 14, 0));
    expect(text).toContain("正在打印「Benchy」，63%，第 120/190 层，还要 42 分钟（预计 14:42 打完）。");
    expect(text).toContain("喷嘴 220℃（目标 220℃），热床 55℃（目标 55℃），仓内 38℃。");
    expect(text).toContain("料：1 号 白色 PLA Basic（剩 80%）、2 号 蓝色 PETG（剩 35%）、4 号 黑色 PLA；正在用 2 号。");
    expect(text).toContain("料盒湿度 23%");
  });

  it("增量并进上一份：标量直接换，料槽按 id 并，告警整份换", () => {
    let raw = merge({}, FULL);
    raw = merge(raw, { mc_percent: 64, ams: { ams: [{ id: "0", tray: [{ id: "1", remain: 34 }] }] }, hms: [{ attr: 0x03000100, code: 0x00020001 }] });
    const s = parseStatus(raw);
    expect(s.percent).toBe(64);
    expect(s.trays[1]).toEqual({ slot: 2, type: "PETG", color: "蓝色", remain: 34 });
    expect(s.trays).toHaveLength(3);
    expect(s.hms).toEqual([{ code: "0300-0100-0002-0001", severity: 2 }]);
    expect(parseStatus(merge(raw, { hms: [] })).hms).toEqual([]);
  });

  it("新一代机型把温度塞在 device 里（目标 << 16 | 当前）；老字段没有时用它；什么都没有就空着", () => {
    const s = parseStatus({ gcode_state: "IDLE", device: { extruder: { info: [{ id: 0, temp: (220 << 16) | 180 }] }, bed: { info: { temp: (60 << 16) | 45 } }, ctc: { info: { temp: 31 } } } });
    expect(s).toMatchObject({ state: "idle", nozzle: { now: 180, target: 220 }, bed: { now: 45, target: 60 }, chamber: 31 });
    expect(parseStatus({})).toMatchObject({ state: "unknown", nozzle: null, bed: null, chamber: null, percent: null, trays: [] });
    expect(describeStatus(parseStatus({ gcode_state: "IDLE" }))).toBe("空闲。");
  });

  it("错误码写成屏幕上的样子；暂停说原因；取消不算失败；颜色说个大概", () => {
    expect(errCode(0x0300400c)).toBe("0300-400C");
    expect(describeStatus(parseStatus({ ...FULL, gcode_state: "PAUSE", stg_cur: 6, print_error: 0x07008011 }))).toMatch(/^暂停着「Benchy」.*现在：暂停：缺料了。错误码 0700-8011/);
    expect(describeStatus(parseStatus({ gcode_state: "FAILED", subtask_name: "x", print_error: 0x0300400c }))).toBe("上一个任务被取消了「x」。");
    expect(["FF0000FF", "00FF00", "#FFFF00FF", "808080FF", "FFFFFF00", "8B4513FF", "FF69B4FF", "乱写"].map(colorName)).toEqual(["红色", "绿色", "黄色", "灰色", "透明", "棕色", "粉色", ""]);
  });

  it("通知的句子", () => {
    const s = parseStatus({ ...FULL, mc_percent: 37 });
    expect(eventText("P2S", { kind: "finish", status: s, elapsedMin: 133 })).toBe("P2S 上的「Benchy」打印完成了，用了 2 小时 13 分。");
    expect(eventText("P2S", { kind: "finish", status: parseStatus({}), elapsedMin: null })).toBe("P2S 上的这个任务打印完成了。");
    expect(eventText("P2S", { kind: "failed", status: parseStatus({ ...FULL, mc_percent: 37, print_error: 0x03008003 }), elapsedMin: 5 })).toBe("P2S 上的「Benchy」打印失败了，停在 37%（错误码 0300-8003）。");
    expect(eventText("P2S", { kind: "paused", status: parseStatus({ ...FULL, mc_percent: 37, stg_cur: 6 }), elapsedMin: 5 })).toBe("P2S 上的「Benchy」暂停了：缺料了，打到 37%，要你去看一下。");
    expect(eventText("P2S", { kind: "paused", status: parseStatus({ ...FULL, mc_percent: 37, stg_cur: 30 }), elapsedMin: 5 })).toBe("P2S 上的「Benchy」暂停了：G-code 里的暂停点，打到 37%，要你去看一下。");
    expect(eventText("P2S", { kind: "warning", status: s, codes: ["0300-0100-0002-0001"] })).toContain("报了告警（HMS 0300-0100-0002-0001），打印还在继续");
  });
});

/** 假打印机：aedes 当 broker，鉴权 bblp / 访问码，只许订阅自己序列号的主题（订别的直接踢，和真机一样） */
async function fakePrinter(secure?: { key: Buffer; cert: Buffer }) {
  const broker: any = await Aedes.createBroker();
  const requests: any[] = [];
  let connects = 0;
  broker.authenticate = (_c: any, user: string, pass: Buffer, cb: any) => { connects++; cb(null, user === "bblp" && pass?.toString() === CODE); };
  broker.authorizeSubscribe = (c: any, sub: any, cb: any) => { if (sub.topic === `device/${SERIAL}/report`) cb(null, sub); else { c.close(); cb(new Error("no")); } };
  /** 怎么回执控制指令：默认说成功；设成 null 就不回；设成函数自己定 */
  const ctl: { ack: null | ((kind: string, body: any) => any) } = { ack: (_k, b) => ({ command: b.command, sequence_id: b.sequence_id, result: "success", reason: "" }) };
  broker.on("publish", (pk: any, c: any) => {
    if (!c || pk.topic !== `device/${SERIAL}/request`) return;
    const req = JSON.parse(pk.payload.toString());
    requests.push({ ...req, _qos: pk.qos });
    const kind = Object.keys(req)[0];
    if (kind === "pushing" || !ctl.ack) return;
    const r = ctl.ack(kind, req[kind]);
    if (r) broker.publish({ cmd: "publish", topic: `device/${SERIAL}/report`, payload: Buffer.from(JSON.stringify({ [kind]: r })), qos: 0, dup: false, retain: false }, () => {});
  });
  const server = secure ? tls.createServer(secure, broker.handle) : net.createServer(broker.handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, requests, ctl, connects: () => connects, subscribed: () => new Promise<void>((r) => broker.once("subscribe", () => r())),
    push: (print: any) => new Promise<void>((r) => broker.publish({ cmd: "publish", topic: `device/${SERIAL}/report`, payload: Buffer.from(JSON.stringify({ print })), qos: 0, dup: false, retain: false }, () => r())),
    close: async () => { await new Promise<void>((r) => broker.close(() => r())); server.close(); },
  };
}
const plainDial = (fp = "FP1"): Dial => (host, port) => new Promise((resolve, reject) => { const s = net.connect(port, host, () => resolve({ sock: s, fingerprint: fp })); s.once("error", reject); });

describe("连接假打印机", () => {
  const open: { stop(): void }[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const p of open.splice(0)) p.stop(); for (const c of closers.splice(0)) await c(); });
  async function setup(over: Partial<ConstructorParameters<typeof BambuPrinter>[0]> = {}) {
    const fp = await fakePrinter();
    closers.push(fp.close);
    const events: PrinterEvent[] = [];
    const logs: string[] = [];
    const p = new BambuPrinter({ host: "127.0.0.1", port: fp.port, serial: SERIAL, accessCode: CODE, dial: plainDial(), settleMs: 20, onEvent: (e) => events.push(e), log: (l) => logs.push(l), ...over });
    open.push(p);
    return { fp, p, events, logs };
  }

  it("新固件的几处：是不是开了开发者模式（fun 里的签名位）、单喷嘴取 id 0 那项、新阶段号", () => {
    expect(parseStatus({ gcode_state: "IDLE", fun: "3EC1AFFF9CFF" }).devMode).toBe(false);
    expect(parseStatus({ gcode_state: "IDLE", fun: "3EC18FFF9CFF" }).devMode).toBe(true);
    expect(parseStatus({ gcode_state: "IDLE" }).devMode).toBe(null);
    const s = parseStatus({ gcode_state: "PREPARE", stg_cur: 77, device: { extruder: { info: [{ id: 1, temp: 5 }, { id: 0, temp: (220 << 16) | 180 }] } } });
    expect(s).toMatchObject({ stage: "准备 AMS", nozzle: { now: 180, target: 220 } });
  });

  it("连上后订阅、要一份完整状态；收到增量并进去；刚连上时的状态不通知", async () => {
    const { fp, p, events } = await setup();
    const sub = fp.subscribed();
    p.start();
    await sub;
    await until(() => fp.requests.length > 0);
    expect(p.conn).toBe("online");
    expect(fp.requests[0].pushing.command).toBe("pushall");
    expect(p.ready).toBe(false);
    await fp.push(FULL);
    await until(() => p.ready);
    await fp.push({ command: "push_status", mc_percent: 70, mc_remaining_time: 30 });
    await until(() => p.status.percent === 70);
    expect(p.status).toMatchObject({ state: "printing", job: "Benchy", remainMin: 30, layers: 190 });
    // 别的指令的回执不是状态，不并
    await fp.push({ command: "gcode_line", gcode_state: "FAILED" });
    await sleep(60);
    expect(p.status.state).toBe("printing");
    expect(events).toEqual([]);
  });

  it("打完通知一次（带用时）；取消不通知；手动暂停不通知、缺料暂停通知；失败通知", async () => {
    const { fp, p, events, logs } = await setup();
    const sub = fp.subscribed();
    p.start();
    await sub;
    await fp.push({ ...FULL, gcode_state: "IDLE" });
    await until(() => p.ready);
    await fp.push({ command: "push_status", gcode_state: "RUNNING" });
    await until(() => p.status.state === "printing");
    await fp.push({ command: "push_status", gcode_state: "PAUSE", stg_cur: 16 });
    await sleep(80);
    expect(events).toEqual([]);
    expect(logs.join()).toContain("手动暂停");
    await fp.push({ command: "push_status", gcode_state: "RUNNING", stg_cur: 0 });
    await sleep(40);
    // 状态和原因分两条来：等一下再判断，原因也带得上
    await fp.push({ command: "push_status", gcode_state: "PAUSE" });
    await fp.push({ command: "push_status", stg_cur: 6, print_error: 0x07008011 });
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ kind: "paused", status: { stage: "暂停：缺料了", error: "0700-8011" } });
    await fp.push({ command: "push_status", gcode_state: "RUNNING", stg_cur: 0, print_error: 0 });
    await sleep(40);
    await fp.push({ command: "push_status", gcode_state: "FINISH", mc_percent: 100 });
    await until(() => events.length === 2);
    expect(events[1].kind).toBe("finish");
    expect((events[1] as any).elapsedMin).toBeLessThan(1);
    await sleep(60);
    expect(events).toHaveLength(2);
    // 下一件：开打后取消（FAILED + 取消的错误码）→ 不通知；再下一件真失败 → 通知
    await fp.push({ command: "push_status", gcode_state: "RUNNING", mc_percent: 5 });
    await sleep(40);
    await fp.push({ command: "push_status", gcode_state: "FAILED", print_error: 0x0300400c });
    await sleep(80);
    expect(events).toHaveLength(2);
    await fp.push({ command: "push_status", gcode_state: "PREPARE", print_error: 0 });
    await sleep(40);
    await fp.push({ command: "push_status", gcode_state: "FAILED", print_error: 0x03008003, mc_percent: 12 });
    await until(() => events.length === 3);
    expect(events[2]).toMatchObject({ kind: "failed", status: { error: "0300-8003", percent: 12 } });
  });

  it("打印中新冒出来的严重告警通知一次；刚连上时已有的、一般的、同一个半小时内的不通知", async () => {
    const { fp, p, events } = await setup();
    const sub = fp.subscribed();
    p.start();
    await sub;
    const old = { attr: 0x05000100, code: 0x00020003 }, serious = { attr: 0x03000100, code: 0x00020001 }, minor = { attr: 0x0c000100, code: 0x00030004 };
    await fp.push({ ...FULL, hms: [old] });
    await until(() => p.ready);
    await fp.push({ command: "push_status", hms: [old, minor] });
    await sleep(60);
    expect(events).toEqual([]);
    await fp.push({ command: "push_status", hms: [old, serious] });
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ kind: "warning", codes: ["0300-0100-0002-0001"] });
    await fp.push({ command: "push_status", hms: [old] });
    await fp.push({ command: "push_status", hms: [old, serious] });
    await sleep(80);
    expect(events).toHaveLength(1);
  });

  it("访问码不对：说清楚、不反复猛连；序列号不对（连上就被踢）：提示检查序列号", async () => {
    const a = await setup({ accessCode: "wrong" });
    a.p.start();
    await until(() => a.p.conn === "error");
    expect(a.p.error).toContain("访问码不对");
    await sleep(150);
    expect(a.fp.connects()).toBe(1);
    const b = await setup({ serial: "WRONGSERIAL00" });
    b.p.start();
    await until(() => b.p.conn === "error");
    expect(b.p.error).toContain("序列号可能填错了");
  });

  it("连不上：给出人能看懂的原因", async () => {
    const p = new BambuPrinter({ host: "127.0.0.1", port: 1, serial: SERIAL, accessCode: CODE, dial: plainDial(), log: () => {} });
    open.push(p);
    p.start();
    await until(() => p.conn === "error");
    expect(p.error).toContain("连不上 127.0.0.1（打印机开着吗？");
  });

  it("证书指纹：第一次记下；以后不一样就不连、不把访问码发出去，并提醒一次", async () => {
    const seen: string[] = [];
    const a = await setup({ onFingerprint: (f) => seen.push(f) });
    const sub = a.fp.subscribed();
    a.p.start();
    await sub;
    expect(seen).toEqual(["FP1"]);
    const b = await setup({ fingerprint: "FP1", dial: plainDial("FP-OTHER") });
    b.p.start();
    await until(() => b.p.conn === "error");
    expect(b.p.error).toMatch(/^证书和上次连接时不一样/);
    expect(b.events).toEqual([{ kind: "cert" }]);
    await sleep(100);
    expect(b.fp.connects()).toBe(0);           // 连 CONNECT 都没发
  });
});

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
describe.skipIf(!hasOpenssl)("真的走 TLS（自签证书）", () => {
  it("自签证书也连得上，记下的是证书的 SHA-256 指纹", async () => {
    const dir = tmpdir("printer-tls");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2", "-subj", `/CN=${SERIAL}`], { stdio: "ignore" });
    const fp = await fakePrinter({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) });
    const seen: string[] = [];
    const p = new BambuPrinter({ host: "127.0.0.1", port: fp.port, serial: SERIAL, accessCode: CODE, dial: tlsDial, onFingerprint: (f) => seen.push(f), log: () => {} });
    try {
      const sub = fp.subscribed();
      p.start();
      await sub;
      await fp.push(FULL);
      await until(() => p.ready);
      expect(p.status.job).toBe("Benchy");
      expect(seen[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    } finally { p.stop(); await fp.close(); }
  });
});

describe("MCP 服务器", () => {
  /** 在进程里起服务器，用一对管道当标准输入输出 */
  function serve(env: Record<string, string>, dial: Dial = plainDial(), stateDir = tmpdir("bambu-state")) {
    const input = new PassThrough(), output = new PassThrough();
    const logs: string[] = [], notes: any[] = [];
    const waiting = new Map<number, (r: any) => void>();
    let buf = "", id = 0;
    output.on("data", (d) => {
      buf += d.toString();
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.id !== undefined) waiting.get(m.id)?.(m); else notes.push(m);
      }
    });
    const srv = startBambuMcp({ input, output, env, stateDir, dial, settleMs: 10, log: (l) => logs.push(l), version: "t" });
    const rpc = (method: string, params: any = {}) => new Promise<any>((r) => { const n = ++id; waiting.set(n, r); input.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
    const call = async (name: string, args: any = {}) => (await rpc("tools/call", { name, arguments: args })).result;
    return { srv, rpc, call, notes, logs, stateDir, close: () => { srv.close(); input.end(); } };
  }
  const closers: (() => any)[] = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("握手、列工具、看状态、要原始数据；打完发一条通知（notice 级，原话）", async () => {
    const fp = await fakePrinter();
    const s = serve({ BAMBU_NAME: "P2S", BAMBU_HOST: "127.0.0.1", BAMBU_PORT: String(fp.port), BAMBU_SERIAL: SERIAL.toLowerCase(), BAMBU_ACCESS_CODE: CODE });
    closers.push(s.close, fp.close);
    const init = (await s.rpc("initialize", { protocolVersion: "2025-06-18" })).result;
    expect(init).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {}, logging: {} }, serverInfo: { name: "kagura-bambu-printer" } });
    expect((await s.rpc("tools/list")).result.tools.map((t: any) => t.name)).toEqual(["printer_status", "printer_retrust"]);
    expect((await s.rpc("nope")).error.code).toBe(-32601);
    await until(() => s.srv.printer?.conn === "online");
    expect((await s.call("printer_status")).content[0].text).toBe("P2S：刚连上，还没收到状态，过几秒再问。");
    await fp.push(FULL);
    await until(() => !!s.srv.printer?.ready);
    expect((await s.call("printer_status")).content[0].text).toMatch(/^P2S：正在打印「Benchy」，63%/);
    expect(JSON.parse((await s.call("printer_status", { raw: true })).content[0].text)).toMatchObject({ gcode_state: "RUNNING", subtask_name: "Benchy" });
    expect((await s.call("printer_retrust")).content[0].text).toContain("现在不是证书的问题");
    await fp.push({ command: "push_status", gcode_state: "FINISH", mc_percent: 100 });
    await until(() => s.notes.length === 1);
    expect(s.notes[0]).toMatchObject({ method: "notifications/message", params: { level: "notice", logger: "bambu-printer" } });
    expect(s.notes[0].params.data).toMatch(/^P2S 上的「Benchy」打印完成了/);
    // 第一次连上记下了证书指纹
    expect(JSON.parse(fs.readFileSync(path.join(s.stateDir, `${SERIAL}.json`), "utf8"))).toEqual({ fingerprint: "FP1", host: "127.0.0.1" });
    // 断了之后说得出原因和最后看到的情况
    await fp.close();
    await until(() => s.srv.printer?.conn === "error");
    expect((await s.call("printer_status")).content[0].text).toMatch(/^P2S：连不上（连接断了.*最后一次看到是 0 分钟前：打完了「Benchy」/);
  });

  it("证书变了：不连、发一条警告通知；主人确认后 printer_retrust 重新记", async () => {
    const fp = await fakePrinter();
    const env = { BAMBU_NAME: "P2S", BAMBU_HOST: "127.0.0.1", BAMBU_PORT: String(fp.port), BAMBU_SERIAL: SERIAL, BAMBU_ACCESS_CODE: CODE };
    const dir = tmpdir("bambu-state");
    fs.writeFileSync(path.join(dir, `${SERIAL}.json`), JSON.stringify({ fingerprint: "OLD", host: "127.0.0.1" }));
    const s = serve(env, plainDial("NEW"), dir);
    closers.push(s.close, fp.close);
    await until(() => s.notes.length === 1);
    expect(s.notes[0].params).toMatchObject({ level: "warning" });
    expect(s.notes[0].params.data).toContain("证书和上次连接时不一样");
    expect(fp.connects()).toBe(0);
    expect((await s.call("printer_status")).content[0].text).toContain("连不上（证书和上次连接时不一样");
    expect((await s.call("printer_retrust")).content[0].text).toContain("正在重新连接");
    await until(() => s.srv.printer?.conn === "online");
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${SERIAL}.json`), "utf8")).fingerprint).toBe("NEW");
    // 换了 IP 当成换了机器：旧指纹不作数，直接连
    const s2 = serve({ ...env, BAMBU_HOST: "localhost" }, plainDial("THIRD"), dir);
    closers.push(s2.close);
    await until(() => s2.srv.printer?.conn === "online");
  });

  it("没配好（缺项 / 还是模板里的占位）：服务器照样起来，工具说清楚缺什么", async () => {
    const s = serve({ BAMBU_HOST: "打印机的 IP", BAMBU_SERIAL: SERIAL });
    closers.push(s.close);
    expect(s.srv.printer).toBe(null);
    const r = await s.call("printer_status");
    expect(r.content[0].text).toContain("BAMBU_HOST（打印机 IP）、BAMBU_ACCESS_CODE（访问码）");
    expect(r.content[0].text).not.toContain("BAMBU_SERIAL");
    expect((await s.call("printer_retrust")).isError).toBe(true);
    expect(s.logs.join()).toContain("还没配置好");
  });
});

/** 假的打印机文件服务：明文（测试里不走 TLS），够 Ftps 用的那几条命令 */
async function fakeFtp(files: Record<string, Buffer> = {}) {
  const stored: Record<string, Buffer> = { ...files };
  const log: string[] = [];
  const servers: net.Server[] = [];
  const ctl = net.createServer((c) => {
    let data: Promise<net.Socket> | null = null;
    let buf = "";
    c.write("220 hi\r\n");
    c.on("data", async (d) => {
      buf += d.toString();
      for (let i; (i = buf.indexOf("\r\n")) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [cmd, ...rest] = line.split(" "); const arg = rest.join(" ");
        log.push(cmd === "PASS" ? "PASS ***" : line);
        if (cmd === "USER") c.write("331 pass?\r\n");
        else if (cmd === "PASS") c.write(arg === CODE ? "230 ok\r\n" : "530 no\r\n");
        else if (cmd === "PBSZ" || cmd === "PROT" || cmd === "TYPE") c.write("200 ok\r\n");
        else if (cmd === "PASV") {
          const ds = net.createServer(); servers.push(ds);
          data = new Promise((r) => ds.once("connection", (s) => { s.pause(); r(s); }));
          await new Promise<void>((r) => ds.listen(0, "127.0.0.1", () => r()));
          const p = (ds.address() as net.AddressInfo).port;
          c.write(`227 Entering Passive Mode (10,0,0,9,${p >> 8},${p & 255})\r\n`);
        } else if (cmd === "LIST") {
          const dir = arg.replace(/\/$/, "");
          const names = Object.keys(stored).filter((n) => path.posix.dirname(n) === (dir || "/"));
          if (dir === "/cache" && !names.length) { c.write("550 no such dir\r\n"); (await data!).destroy(); continue; }
          c.write("150 here\r\n");
          const s = await data!;
          s.end(names.map((n) => `-rw-rw-rw- 1 root root ${String(stored[n].length).padStart(8)} Nov 14 09:30 ${path.posix.basename(n)}`).join("\r\n") + "\r\ndrwxr-xr-x 2 root root 0 Nov 01 00:00 cache\r\n");
          c.write("226 done\r\n");
        } else if (cmd === "STOR") {
          c.write("150 go\r\n");
          const s = await data!; const chunks: Buffer[] = [];
          s.on("data", (x) => chunks.push(x)); s.resume();
          s.once("close", () => { stored[arg] = Buffer.concat(chunks); c.write("226 stored\r\n"); });
        } else if (cmd === "QUIT") c.end("221 bye\r\n");
        else c.write("502 ?\r\n");
      }
    });
    c.on("error", () => {});
  });
  await new Promise<void>((r) => ctl.listen(0, "127.0.0.1", () => r()));
  return { port: (ctl.address() as net.AddressInfo).port, stored, log, close: () => { ctl.close(); for (const d of servers) d.close(); } };
}
const plainFtp = (fp = "FP1"): FtpDial => (host, port) => new Promise((resolve, reject) => { const s = net.connect(port, host, () => resolve({ sock: s, fingerprint: fp })); s.once("error", reject); });

describe("文件服务（FTPS）与切片文件", () => {
  it("列表解析：名字里有空格、目录、大小", () => {
    expect(parseList("-rw-rw-rw- 1 root root   123456 Nov 14 09:30 小船 final.gcode.3mf\r\ndrwxr-xr-x 2 root root 0 Nov 01 00:00 cache\r\ntotal 3\r\n")).toEqual([
      { name: "小船 final.gcode.3mf", size: 123456, dir: false, date: "Nov 14 09:30" }, { name: "cache", size: 0, dir: true, date: "Nov 01 00:00" }]);
  });

  it("登录、列文件、上传（数据通道连的是控制通道那个地址，不信回复里的 IP）；访问码不对、证书不对都说清楚", async () => {
    const srv = await fakeFtp({ "/a.gcode.3mf": Buffer.from("AAAA"), "/notes.txt": Buffer.from("x"), "/cache/b.3mf": Buffer.from("BB") });
    try {
      const f = await Ftps.open({ host: "127.0.0.1", port: srv.port, password: CODE, dial: plainFtp(), fingerprint: "FP1" });
      expect((await f.list("/")).map((x) => x.name)).toEqual(["a.gcode.3mf", "notes.txt", "cache"]);
      expect((await f.list("/cache")).map((x) => [x.name, x.size])).toEqual([["b.3mf", 2], ["cache", 0]]);
      const body = Buffer.alloc(300_000, 7);
      const { Readable } = await import("node:stream");
      await f.upload("/大文件.gcode.3mf", Readable.from([body.subarray(0, 100_000), body.subarray(100_000)]));
      f.close();
      await until(() => !!srv.stored["/大文件.gcode.3mf"]);
      expect(srv.stored["/大文件.gcode.3mf"].equals(body)).toBe(true);
      expect(srv.log.slice(0, 5)).toEqual(["USER bblp", "PASS ***", "PBSZ 0", "PROT P", "TYPE I"]);
      await expect(Ftps.open({ host: "127.0.0.1", port: srv.port, password: "bad", dial: plainFtp() })).rejects.toThrow(/访问码不对/);
      await sleep(50);
      const before = srv.log.length;
      await expect(Ftps.open({ host: "127.0.0.1", port: srv.port, password: CODE, dial: plainFtp("OTHER"), fingerprint: "FP1" })).rejects.toThrow(/证书和记下的不一样/);
      await sleep(50);
      expect(srv.log.length).toBe(before);           // 没登录
    } finally { srv.close(); }
  });

  it("3mf 切没切片：看里面有没有 Metadata/plate_N.gcode", () => {
    const dir = tmpdir("3mf");
    const sliced = path.join(dir, "s.gcode.3mf"), raw = path.join(dir, "r.3mf");
    fs.writeFileSync(sliced, zip([{ name: "3D/3dmodel.model", data: Buffer.from("<m/>") }, { name: "Metadata/plate_2.gcode", data: Buffer.from("G1") }, { name: "Metadata/plate_1.gcode", data: Buffer.from("G1 X1".repeat(500)) }, { name: "Metadata/plate_1.png", data: Buffer.alloc(10) }]));
    fs.writeFileSync(raw, zip([{ name: "3D/3dmodel.model", data: Buffer.from("<m/>") }]));
    expect(platesOf(zipNames(sliced))).toEqual([1, 2]);
    expect(platesOf(zipNames(raw))).toEqual([]);
    fs.writeFileSync(path.join(dir, "bad.3mf"), "不是 zip");
    expect(() => zipNames(path.join(dir, "bad.3mf"))).toThrow(/不是 zip/);
  });
});

describe("控制（BAMBU_CONTROL=1）", () => {
  const DEV = "3EC18FFF9CFF", NODEV = "3EC1AFFF9CFF";
  const closers: (() => any)[] = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });
  async function setup(first: any, files: Record<string, Buffer> = {}, studioBin?: string) {
    const fp = await fakePrinter();
    const ftp = await fakeFtp(files);
    const input = new PassThrough(), output = new PassThrough();
    const waiting = new Map<number, (r: any) => void>();
    let buf = "", id = 0;
    output.on("data", (d) => { buf += d.toString(); for (let i; (i = buf.indexOf("\n")) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id !== undefined) waiting.get(m.id)?.(m); } });
    const srv = startBambuMcp({ input, output, stateDir: tmpdir("bambu-state"), dial: plainDial(), ftpDial: plainFtp(), settleMs: 10, ackMs: 1200, log: () => {},
      env: { BAMBU_NAME: "P2S", BAMBU_STUDIO: studioBin ?? "", BAMBU_HOST: "127.0.0.1", BAMBU_PORT: String(fp.port), BAMBU_FTP_PORT: String(ftp.port), BAMBU_SERIAL: SERIAL, BAMBU_ACCESS_CODE: CODE, BAMBU_CONTROL: "1" } });
    closers.push(() => { srv.close(); input.end(); }, fp.close, ftp.close);
    const rpc = (method: string, params: any = {}) => new Promise<any>((r) => { const n = ++id; waiting.set(n, r); input.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
    const call = async (name: string, args: any = {}) => { const r = (await rpc("tools/call", { name, arguments: args })).result; return { text: r.content[0].text as string, isError: !!r.isError }; };
    await until(() => srv.printer?.conn === "online");
    await fp.push(first);
    await until(() => !!srv.printer?.ready);
    const sent = () => fp.requests.filter((r) => !r.pushing);
    return { fp, ftp, srv, rpc, call, sent };
  }

  it("多出三个控制工具；没开开发者模式时不发指令、说清楚怎么开", async () => {
    const s = await setup({ ...FULL, fun: NODEV });
    expect((await s.rpc("tools/list")).result.tools.map((t: any) => t.name)).toEqual(["printer_status", "printer_retrust", "printer_control", "printer_files", "printer_print", "printer_slice"]);
    expect((await s.call("printer_status")).text).toContain("打印机没开开发者模式：现在只能看");
    const r = await s.call("printer_control", { action: "pause" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain("开发者模式");
    expect((await s.call("printer_print", { file: "x.gcode.3mf" })).text).toContain("开发者模式");
    expect(s.sent()).toEqual([]);
  });

  it("暂停 / 继续 / 停止 / 灯 / 速度：状态不对不发；发的是带回执的指令；被拒绝、没回应都照实说", async () => {
    const s = await setup({ ...FULL, fun: DEV });
    expect((await s.call("printer_control", { action: "resume" })).text).toContain("现在不是暂停状态");
    expect(s.sent()).toEqual([]);
    expect((await s.call("printer_control", { action: "pause" })).text).toContain("已经让它暂停了");
    expect(s.sent()[0]).toMatchObject({ print: { command: "pause" }, _qos: 1 });
    expect((await s.call("printer_control", { action: "light_off" })).text).toContain("灯关了");
    expect(s.sent()[1]).toMatchObject({ system: { command: "ledctrl", led_node: "chamber_light", led_mode: "off" } });
    expect((await s.call("printer_control", { action: "speed", speed: "silent" })).text).toContain("速度档换成静音了");
    expect(s.sent()[2].print).toMatchObject({ command: "print_speed", param: "1" });
    expect((await s.call("printer_control", { action: "speed", speed: "warp" })).isError).toBe(true);
    // 打印机拒绝（没开开发者模式时的校验失败）
    s.fp.ctl.ack = (_k, b) => ({ command: b.command, sequence_id: b.sequence_id, result: "failed", reason: "mqtt message verify failed", err_code: 84033543 });
    const no = await s.call("printer_control", { action: "stop" });
    expect(no.text).toContain("多半是没开开发者模式");
    // 没回应
    s.fp.ctl.ack = null;
    expect((await s.call("printer_control", { action: "stop" })).text).toContain("指令发出去了，但打印机没有回应");
    // 空闲时没什么可停的
    await s.fp.push({ command: "push_status", gcode_state: "FINISH" });
    await until(() => s.srv.printer!.status.state === "finished");
    expect((await s.call("printer_control", { action: "stop" })).text).toContain("现在没有在进行的打印");
  });

  it("列打印机上的文件（根目录和 cache 里的 .3mf）", async () => {
    const s = await setup({ ...FULL, gcode_state: "IDLE", fun: DEV }, { "/小船.gcode.3mf": Buffer.alloc(2_500_000), "/readme.txt": Buffer.from("x"), "/cache/old.3mf": Buffer.from("zz") });
    const r = await s.call("printer_files");
    expect(r.text).toContain("- 小船.gcode.3mf（2.4 MB，Nov 14 09:30）");
    expect(r.text).toContain("- cache/old.3mf（1 KB");
    expect(r.text).not.toContain("readme");
  });

  it("开始打印分两步：先给确认码，主人同意后带码再调才上传并开打；没切片的、正在打的、参数变了的都不开始", async () => {
    const dir = tmpdir("3mf");
    const sliced = path.join(dir, "小船.gcode.3mf"), raw = path.join(dir, "模型.3mf");
    fs.writeFileSync(sliced, zip([{ name: "Metadata/plate_1.gcode", data: Buffer.from("G1 X1\n".repeat(2000)) }]));
    fs.writeFileSync(raw, zip([{ name: "3D/3dmodel.model", data: Buffer.from("<m/>") }]));
    const s = await setup({ ...FULL, gcode_state: "IDLE", fun: DEV });
    expect((await s.call("printer_print", { file: raw })).text).toContain("还没切片");
    expect((await s.call("printer_print", { file: path.join(dir, "没有.gcode.3mf") })).text).toContain("这台电脑上没有");
    expect((await s.call("printer_print", { file: "model.stl" })).text).toContain("只能打切好片的 .3mf");
    expect((await s.call("printer_print", { file: sliced, plate: 3 })).text).toContain("没有第 3 盘");
    const ask = await s.call("printer_print", { file: sliced });
    expect(ask.isError).toBe(false);
    expect(ask.text).toMatch(/还没开始打印。\n要打的是：「小船」第 1 盘（这台电脑上的文件/);
    expect(ask.text).toContain("用料：2 号槽（蓝色 PETG，剩 35%）");       // 没说用哪个槽 = 现在在用的那个
    expect(ask.text).toContain("热床上是空的");
    const code = /confirm="(\d{4})"/.exec(ask.text)![1];
    expect(s.sent()).toEqual([]);
    expect(Object.keys(s.ftp.stored)).toEqual([]);
    // 带着码但参数变了（换了料槽）：不算确认，重新给码
    const again = await s.call("printer_print", { file: sliced, slots: [1], confirm: code });
    expect(again.text).toContain("确认码不对或者参数变了");
    expect(s.sent()).toEqual([]);
    const code2 = /confirm="(\d{4})"/.exec(again.text)![1];
    const go = await s.call("printer_print", { file: sliced, slots: [1], confirm: code2 });
    expect(go.text).toContain("「小船」开始打印了（文件已经传到打印机）");
    expect(s.ftp.stored["/小船.gcode.3mf"].equals(fs.readFileSync(sliced))).toBe(true);
    expect(s.sent()).toHaveLength(1);
    expect(s.sent()[0].print).toMatchObject({ command: "project_file", param: "Metadata/plate_1.gcode", url: "ftp:///小船.gcode.3mf", subtask_name: "小船", use_ams: true, ams_mapping: [0], bed_leveling: true, timelapse: false });
    // 码只能用一次
    expect((await s.call("printer_print", { file: sliced, slots: [1], confirm: code2 })).text).toContain("还没开始打印");
    // 打印机上已有的文件：不上传，直接开；外挂料盘
    const ask2 = await s.call("printer_print", { file: "cache/old.3mf", use_ams: false });
    expect(ask2.text).toContain("（打印机上的文件）");
    expect(ask2.text).toContain("用料：外挂料盘");
    await s.call("printer_print", { file: "cache/old.3mf", use_ams: false, confirm: /confirm="(\d{4})"/.exec(ask2.text)![1] });
    expect(s.sent()[1].print).toMatchObject({ url: "ftp:///cache/old.3mf", use_ams: false, ams_mapping: [] });
    // 正在打的时候不让开新的
    await s.fp.push({ command: "push_status", gcode_state: "RUNNING" });
    await until(() => s.srv.printer!.status.state === "printing");
    expect((await s.call("printer_print", { file: sliced })).text).toContain("正在打印");
  });

  it("发打印前核对：给别的机型切的不让打；用了几种料要说清几个槽；文件的料和槽里的对不上要提醒；带上预计时间和用量", async () => {
    const dir = tmpdir("3mf");
    const proj = (model: string) => JSON.stringify({ printer_model: model, filament_type: ["PLA", "PETG"], filament_colour: ["#FFFFFF", "#0000FF"] });
    const info = `<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="5460"/><metadata key="weight" value="23.81"/>
      <filament id="1" type="PLA" color="#FFFFFF" used_g="18.2" /><filament id="2" type="PETG" color="#0000FF" used_g="5.6" /></plate></config>`;
    const mk = (name: string, model: string) => { const f = path.join(dir, name); fs.writeFileSync(f, zip([{ name: "Metadata/plate_1.gcode", data: Buffer.from("G28") }, { name: "Metadata/project_settings.config", data: Buffer.from(proj(model)) }, { name: "Metadata/slice_info.config", data: Buffer.from(info) }])); return f; };
    const s = await setup({ ...FULL, gcode_state: "IDLE", fun: DEV });
    expect((await s.call("printer_print", { file: mk("x1c.gcode.3mf", "Bambu Lab X1 Carbon") })).text).toContain("是给「Bambu Lab X1 Carbon」切的，不是 P2S，不能直接打");
    const ok = mk("双色.gcode.3mf", "Bambu Lab P2S");
    const need = await s.call("printer_print", { file: ok });
    expect(need.isError).toBe(true);
    expect(need.text).toContain("这一盘用了 2 种料：第 1 种 #FFFFFF PLA、第 2 种 #0000FF PETG");
    expect(need.text).toContain("现在 AMS 里：1 号 白色 PLA Basic、2 号 蓝色 PETG、4 号 黑色 PLA");
    const bad = await s.call("printer_print", { file: ok, slots: [1, 4] });
    expect(bad.text).toContain("预计：1 小时 31 分，用料约 24 克");
    expect(bad.text).toContain("⚠️ 材质对不上：文件按 PETG 切的，4 号槽是 PLA");
    const good = await s.call("printer_print", { file: ok, slots: [1, 2] });
    expect(good.text).not.toContain("材质对不上");
    await s.call("printer_print", { file: ok, slots: [1, 2], confirm: /confirm="(\d{4})"/.exec(good.text)![1] });
    expect(s.sent().at(-1).print).toMatchObject({ command: "project_file", use_ams: true, ams_mapping: [0, 1] });
    expect(s.sent()).toHaveLength(1);
  });

  it("printer_slice：交给这台电脑上的 Bambu Studio 切，回来说预计时间和用料；已经切好的不用再切", async () => {
    const dir = tmpdir("slice-mcp");
    const bin = path.join(dir, "bambu-studio");
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2); const at = (k) => a[a.indexOf(k) + 1];
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(a));
fs.copyFileSync(process.env.FAKE_OUT, at("--outputdir") + at("--export-3mf"));
`);
    fs.chmodSync(bin, 0o755);
    const proj = JSON.stringify({ printer_model: "Bambu Lab P2S", filament_type: ["PLA"], filament_colour: ["#FFFFFF"] });
    const info = `<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="1500"/><metadata key="weight" value="9.4"/><filament id="1" type="PLA" color="#FFFFFF" used_g="9.4" /></plate></config>`;
    const src = path.join(dir, "钥匙扣.3mf");
    fs.writeFileSync(src, zip([{ name: "Metadata/project_settings.config", data: Buffer.from(proj) }]));
    process.env.FAKE_OUT = path.join(dir, "out.3mf");
    fs.writeFileSync(process.env.FAKE_OUT, zip([{ name: "Metadata/plate_1.gcode", data: Buffer.from("G28") }, { name: "Metadata/project_settings.config", data: Buffer.from(proj) }, { name: "Metadata/slice_info.config", data: Buffer.from(info) }]));
    process.env.FAKE_LOG = path.join(dir, "log.json");
    const s = await setup({ ...FULL, gcode_state: "IDLE", fun: DEV }, {}, bin);
    const r = await s.call("printer_slice", { file: src, infill: 40, walls: 4 });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^切好了：.*sliced[\\/]钥匙扣\.gcode\.3mf\n用的是文件自带的 P2S 配置，改了：填充 40%、墙层数 4。\n预计打印 25 分钟，总用料约 9 克\n用料：第 1 种 #FFFFFF PLA 9\.4 克/);
    expect(JSON.parse(fs.readFileSync(process.env.FAKE_LOG, "utf8"))).toContain("--wall-loops=4");
    const out = /切好了：(.*)\n/.exec(r.text)![1];
    expect((await s.call("printer_slice", { file: out })).text).toContain("已经是给这台打印机切好的");
    expect((await s.call("printer_slice", { file: "猫.stl" })).text).toContain("完整路径");
    expect((await s.call("printer_slice", { file: path.join(dir, "a.obj") })).text).toContain("只能切 .3mf 和 .stl");
    // 切好的直接拿去打：第一步就带上预计时间
    expect((await s.call("printer_print", { file: out })).text).toContain("预计：25 分钟，用料约 9 克");
    delete process.env.FAKE_OUT;
  });
});
