// 打印机：配置（<数据目录>/printers.json）、连接、状态变化时的通知文案。现在只有拓竹（bambu.ts），只读。
// 通知是系统直接写的固定句式（打完了 / 失败了 / 暂停了 / 告警），不为它调模型；怎么送出去由 system.ts 接（走出口，和待办汇报同一条路）。
import fs from "node:fs";
import { BambuPrinter, describeStatus, fmtDuration, type Dial, type PrinterEvent, type PrinterStatus } from "./bambu.ts";

export interface PrinterConfig {
  id: string;
  name: string;
  kind: "bambu";
  host: string;
  serial: string;
  access_code: string;
  enabled: boolean;
  /** 用谁的声音 / 身份通知（空 = 默认 agent） */
  agent: string;
  /** 通知送到哪（device:xx / feishu:…）；空 = 跟这个 agent 的 heartbeat 投递目标，再没有就在家里的设备上说 */
  delivery: string;
  /** 打印中冒出严重告警（HMS）也通知 */
  warnings: boolean;
  /** 第一次连上时记下的证书指纹（见 bambu.ts） */
  fingerprint: string;
}

const ID_RE = /^[a-z0-9_-]{1,24}$/;
const HOST_RE = /^[A-Za-z0-9.:_-]{1,253}$/;

export function validatePrinter(raw: any, keep?: PrinterConfig): PrinterConfig {
  const s = (v: unknown) => String(v ?? "").trim();
  const c: PrinterConfig = {
    id: s(raw.id) || keep?.id || "",
    name: s(raw.name) || keep?.name || "打印机",
    kind: "bambu",
    host: s(raw.host ?? keep?.host),
    serial: s(raw.serial ?? keep?.serial).toUpperCase(),
    // 访问码不回显给页面：留空 = 不改
    access_code: s(raw.access_code) || keep?.access_code || "",
    enabled: raw.enabled === undefined ? keep?.enabled ?? true : raw.enabled !== false,
    agent: s(raw.agent ?? keep?.agent),
    delivery: s(raw.delivery ?? keep?.delivery),
    warnings: raw.warnings === undefined ? keep?.warnings ?? true : raw.warnings !== false,
    fingerprint: keep?.fingerprint ?? "",
  };
  if (!ID_RE.test(c.id)) throw new Error("编号只能用小写字母、数字、_ 和 -");
  if (!HOST_RE.test(c.host)) throw new Error("要填打印机的 IP 地址（打印机屏幕「设置 → 局域网」里看）");
  if (!/^[A-Z0-9]{8,32}$/.test(c.serial)) throw new Error("要填打印机的序列号（打印机屏幕「设置 → 设备信息」里看，一串字母数字）");
  if (!c.access_code) throw new Error("要填访问码（打印机屏幕「设置 → 局域网」里看）");
  // 换了机器（IP / 序列号变了）：以前记的证书不作数
  if (keep && (keep.host !== c.host || keep.serial !== c.serial)) c.fingerprint = "";
  return c;
}

/** 通知的句子 */
export function eventText(name: string, e: PrinterEvent): string {
  if (e.kind === "cert") return `${name} 的证书和上次连接时不一样，我先断开了。打印机恢复过出厂设置的话，去管理界面的打印机页点一下「重新信任」。`;
  const s: PrinterStatus = e.status;
  const job = s.job ? `「${s.job}」` : "这个任务";
  if (e.kind === "warning") return `${name} 打印${job}时报了告警（HMS ${e.codes.join("、")}），打印还在继续，有空去看一眼。`;
  const took = e.elapsedMin !== null && e.elapsedMin >= 1 ? `，用了 ${fmtDuration(e.elapsedMin)}` : "";
  if (e.kind === "finish") return `${name} 上的${job}打印完成了${took}。`;
  if (e.kind === "failed") return `${name} 上的${job}打印失败了${s.percent !== null ? `，停在 ${s.percent}%` : ""}${s.error ? `（错误码 ${s.error}）` : ""}。`;
  const why = s.stage.startsWith("暂停") ? s.stage.replace(/^暂停[：:]?\s*/, "").replace(/^（(.*)）$/, "$1") : "";
  return `${name} 上的${job}暂停了${why ? `：${why}` : ""}${s.error ? `（错误码 ${s.error}）` : ""}${s.percent !== null ? `，打到 ${s.percent}%` : ""}，要你去看一下。`;
}

export interface HubOpts {
  /** 状态变化要告诉主人的话 */
  notify?(p: PrinterConfig, text: string, kind: PrinterEvent["kind"]): void;
  dial?: Dial;
  settleMs?: number;
}

export class PrinterHub {
  private list: PrinterConfig[] = [];
  private live = new Map<string, BambuPrinter>();
  private started = false;

  constructor(private file: string, private o: HubOpts = {}) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const raw of Array.isArray(j?.printers) ? j.printers : []) {
        try { const c = validatePrinter(raw); c.fingerprint = String(raw.fingerprint ?? ""); this.list.push(c); }
        catch (e: any) { console.log(`[printer] ⚠️  printers.json 里的 ${raw?.id ?? "?"} 配置不对：${e.message}`); }
      }
    } catch { /* 还没配过 */ }
  }

  private save() { fs.writeFileSync(this.file, JSON.stringify({ printers: this.list }, null, 2)); }
  configs(): PrinterConfig[] { return this.list.map((c) => ({ ...c })); }
  get count() { return this.list.filter((c) => c.enabled).length; }
  conn(id: string) { return this.live.get(id); }

  start() { this.started = true; for (const c of this.list) this.open(c); }
  stop() { this.started = false; for (const p of this.live.values()) p.stop(); this.live.clear(); }

  private open(c: PrinterConfig) {
    this.live.get(c.id)?.stop();
    this.live.delete(c.id);
    if (!this.started || !c.enabled) return;
    const p = new BambuPrinter({
      host: c.host, serial: c.serial, accessCode: c.access_code, fingerprint: c.fingerprint,
      dial: this.o.dial, settleMs: this.o.settleMs,
      log: (line) => console.log(`[printer] ${c.name} ${line}`),
      onFingerprint: (fp) => { const cur = this.list.find((x) => x.id === c.id); if (cur) { cur.fingerprint = fp; this.save(); } },
      onEvent: (e) => {
        const cur = this.list.find((x) => x.id === c.id) ?? c;
        if (e.kind === "warning" && !cur.warnings) return;
        const text = eventText(cur.name, e);
        console.log(`[printer] 📣 ${text}`);
        this.o.notify?.(cur, text, e.kind);
      },
    });
    this.live.set(c.id, p);
    p.start();
  }

  /** 新建或修改（访问码留空 = 不改）；改完重连 */
  upsert(raw: any): PrinterConfig {
    const keep = this.list.find((x) => x.id === String(raw?.id ?? ""));
    let id = String(raw?.id ?? "").trim();
    if (!id) { for (let i = 1; ; i++) { id = i === 1 ? "printer" : `printer${i}`; if (!this.list.some((x) => x.id === id)) break; } }
    const c = validatePrinter({ ...raw, id }, keep);
    if (keep) this.list[this.list.indexOf(keep)] = c; else this.list.push(c);
    this.save();
    this.open(c);
    return c;
  }

  remove(id: string) {
    this.live.get(id)?.stop();
    this.live.delete(id);
    this.list = this.list.filter((x) => x.id !== id);
    this.save();
  }

  /** 证书变了之后主人确认过：忘掉旧指纹，重连时记新的 */
  retrust(id: string) {
    const c = this.list.find((x) => x.id === id);
    if (!c) throw new Error(`没有打印机 ${id}`);
    c.fingerprint = "";
    this.save();
    this.open(c);
  }

  reconnect(id: string) { const c = this.list.find((x) => x.id === id); if (!c) throw new Error(`没有打印机 ${id}`); this.open(c); }

  /** 管理界面用：配置（不带访问码）+ 连接和状态 */
  view() {
    return this.list.map((c) => {
      const p = this.live.get(c.id);
      return {
        id: c.id, name: c.name, kind: c.kind, host: c.host, serial: c.serial, has_code: !!c.access_code, enabled: c.enabled, agent: c.agent, delivery: c.delivery, warnings: c.warnings,
        trusted: !!c.fingerprint, conn: p?.conn ?? "off", error: p?.error ?? "", last_seen: p?.lastSeen ? Math.round(p.lastSeen / 1000) : 0,
        status: p?.ready ? p.status : null, text: p?.ready ? describeStatus(p.status) : "",
      };
    });
  }

  /** 说给 agent 听的：全部打印机，或名字 / 编号对得上的那台 */
  describe(which = "", now = new Date()): string {
    const q = which.trim().toLowerCase();
    const all = this.list.filter((c) => c.enabled);
    const hit = q ? all.filter((c) => c.id === q || c.name.toLowerCase().includes(q)) : all;
    const list = hit.length ? hit : all;
    if (!list.length) return "还没有配置打印机（管理界面「打印机」页添加）。";
    return list.map((c) => {
      const p = this.live.get(c.id);
      if (!p || p.conn !== "online") {
        const last = p?.ready && p.lastSeen ? `最后一次看到是 ${fmtDuration((now.getTime() - p.lastSeen) / 60_000)}前：${describeStatus(p.status, now)}` : "";
        return `${c.name}：连不上（${p?.error || "还在连接"}）。${last}`;
      }
      if (!p.ready) return `${c.name}：刚连上，还没收到状态，过几秒再问。`;
      return `${c.name}：${describeStatus(p.status, now)}`;
    }).join("\n");
  }
}
