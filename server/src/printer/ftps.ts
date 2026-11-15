// 极简 FTPS 客户端：只为往拓竹打印机上传切好的文件、列它存储里的文件。
// 打印机的 FTP 是「隐式 TLS」（990 端口，一连上就是 TLS，不是先明文再 AUTH），用户名 bblp、密码 = 访问码；
// 数据通道也要 TLS，而且要**复用控制通道的 TLS 会话**（不复用有的机型会拒绝）。和 MQTT 一样最高 TLS 1.2。
// 只实现用得到的：登录、被动模式、LIST、STOR。没在真机上验证过（写的时候没有打印机）。
import fs from "node:fs";
import tls from "node:tls";
import type { Duplex, Readable } from "node:stream";
import { TLS_MAX } from "./bambu.ts";

export interface FtpEntry { name: string; size: number; dir: boolean; date: string }
/** 连一条通道；session = 复用哪条连接的 TLS 会话（数据通道用） */
/** 打印机拒绝的话翻成人话：553 / 550 多半是存储不让写（没插卡、卡满、写保护），不是我们这边的问题 */
export function denied(what: string, text: string): string {
  const last = text.split("\n").pop() ?? text;
  if (what === "传" && /^55[03]/.test(last)) return `打印机不让写文件（${last}）。多半是打印机的存储没准备好：没插存储卡 / 卡满了 / 卡写保护或格式不认，打印机屏幕上看看存储状态；也可以用 Bambu Studio 的「发送到打印机」试一次——它也失败就是打印机那边的问题`;
  return `${what === "传" ? "传不上去" : `${what}不了`}（${last}）`;
}

export type FtpDial = (host: string, port: number, session?: Buffer) => Promise<{ sock: Duplex; fingerprint: string; session?: Buffer }>;

export const ftpsDial: FtpDial = (host, port, session) => new Promise((resolve, reject) => {
  const s = tls.connect({ host, port, rejectUnauthorized: false, timeout: 15_000, maxVersion: TLS_MAX, ...(session ? { session } : {}) });
  s.once("secureConnect", () => { s.setTimeout(0); resolve({ sock: s, fingerprint: s.getPeerCertificate()?.fingerprint256 ?? "", session: s.getSession() }); });
  s.once("timeout", () => s.destroy(new Error("连接超时")));
  s.once("error", reject);
});

export interface FtpsOpts {
  host: string; port?: number; user?: string; password: string;
  /** 记下的证书指纹：不一样就不登录（别把访问码交给冒充的机器） */
  fingerprint?: string;
  dial?: FtpDial;
  timeoutMs?: number;
}

/** `-rw-rw-rw- 1 root root 12345 Jan 01 00:00 名字 可以有空格.3mf` */
export function parseList(text: string): FtpEntry[] {
  const out: FtpEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([-dl])[-rwxsStT]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line.trim());
    if (m && m[4] !== "." && m[4] !== "..") out.push({ name: m[4], size: Number(m[2]), dir: m[1] === "d", date: m[3].replace(/\s+/g, " ") });
  }
  return out;
}

export class Ftps {
  private buf = "";
  private lines: string[] = [];
  private waiter: ((r: { code: number; text: string }) => void) | null = null;
  private failed: Error | null = null;
  private onFail: ((e: Error) => void) | null = null;

  private constructor(private ctl: Duplex, private o: FtpsOpts, private session?: Buffer) {
    ctl.on("data", (d: Buffer) => { this.buf += d.toString("utf8"); this.pump(); });
    const die = (e: Error) => { this.failed ??= e; this.onFail?.(e); };
    ctl.on("error", (e: any) => die(e instanceof Error ? e : new Error(String(e))));
    ctl.on("close", () => die(new Error("连接断开了")));
  }

  /** 连上并登录 */
  static async open(o: FtpsOpts): Promise<Ftps> {
    const d = await (o.dial ?? ftpsDial)(o.host, o.port ?? 990);
    if (o.fingerprint && d.fingerprint && d.fingerprint !== o.fingerprint) { d.sock.destroy(); throw new Error("证书和记下的不一样，先不传文件"); }
    const f = new Ftps(d.sock, o, d.session);
    try {
      await f.expect(await f.reply(), 220);
      const u = await f.cmd(`USER ${o.user ?? "bblp"}`);
      if (u.code === 331) await f.expect(await f.cmd(`PASS ${o.password}`), 230, "访问码不对");
      else await f.expect(u, 230);
      await f.cmd("PBSZ 0");
      await f.cmd("PROT P");
      await f.cmd("TYPE I");
      return f;
    } catch (e) { f.close(); throw e; }
  }

  private pump() {
    for (let i; (i = this.buf.indexOf("\n")) >= 0;) { this.lines.push(this.buf.slice(0, i).replace(/\r$/, "")); this.buf = this.buf.slice(i + 1); }
    // 一条回复 = 「NNN 文字」；多行的以「NNN-」开头、到「NNN 」结束
    for (;;) {
      if (!this.waiter) return;
      const end = this.lines.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
      if (end < 0) return;
      const part = this.lines.splice(0, end + 1);
      const w = this.waiter; this.waiter = null;
      w({ code: Number(part[part.length - 1].slice(0, 3)), text: part.join("\n") });
    }
  }

  private reply(): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      if (this.failed) return reject(this.failed);
      const t = setTimeout(() => { this.waiter = null; this.onFail = null; reject(new Error("打印机的文件服务没有回应")); }, this.o.timeoutMs ?? 20_000);
      this.onFail = (e) => { clearTimeout(t); this.waiter = null; reject(e); };
      this.waiter = (r) => { clearTimeout(t); this.onFail = null; resolve(r); };
      this.pump();
    });
  }
  private cmd(line: string) { this.ctl.write(line + "\r\n"); return this.reply(); }
  private async expect(r: { code: number; text: string }, want: number, hint = "") {
    if (r.code !== want) throw new Error(`${hint || "文件服务报错"}（${r.text.split("\n").pop()}）`);
    return r;
  }

  /** 被动模式开一条数据通道并发命令。地址用控制通道那个（回复里的 IP 不可信），TLS 会话复用控制通道的。
   *  **先发命令、再等数据通道握手完成**（LRN 2026-11-15，症状「列文件 / 传文件都是『连接超时』」）：打印机（vsftpd）要收到 LIST / STOR
   *  才去接这条连接、开始 TLS 握手；以前先等握手再发命令，两边互等到超时。现在 TCP 先连上、命令马上发，握手和等回复同时进行 */
  private async withData(command: string, what: string): Promise<{ d: Duplex; r: { code: number; text: string } }> {
    const p = await this.cmd("PASV");
    const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(p.text);
    if (p.code !== 227 || !m) throw new Error(`开不了数据通道（${p.text}）`);
    const dial = (this.o.dial ?? ftpsDial)(this.o.host, Number(m[5]) * 256 + Number(m[6]), this.session);
    dial.catch(() => {});                           // 命令被拒时没人等它，别报未处理的错误
    const r = await this.cmd(command);
    if (r.code >= 400) { dial.then((x) => x.sock.destroy(), () => {}); throw new Error(denied(what, r.text)); }
    return { d: (await dial).sock, r };
  }

  async list(dir = "/"): Promise<FtpEntry[]> {
    const { d, r } = await this.withData(`LIST ${dir}`, `列 ${dir}`);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => { d.on("data", (c: Buffer) => chunks.push(c)); d.once("end", resolve); d.once("close", resolve); d.once("error", () => resolve()); });
    if (r.code < 200) await this.reply();           // 150 之后还有一条 226
    return parseList(Buffer.concat(chunks).toString("utf8"));
  }

  /** 下载到本地文件（开打打印机上已有的文件前，拿回来检查）；超过 maxBytes 就停 */
  async download(remote: string, dest: string, maxBytes = 300 * 1024 * 1024): Promise<number> {
    const { d, r } = await this.withData(`RETR ${remote}`, "下载");
    const out = fs.createWriteStream(dest);
    let got = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        d.on("data", (c: Buffer) => { got += c.length; if (got > maxBytes) { d.destroy(); reject(new Error(`文件太大（超过 ${Math.round(maxBytes / 1048576)}MB）`)); return; } out.write(c); });
        d.once("error", reject);
        d.once("end", resolve);
        d.once("close", resolve);
      });
    } finally { await new Promise<void>((ok) => out.end(ok)); }
    if (r.code < 200) await this.expect(await this.reply(), 226, "下载到一半出错了");
    return got;
  }

  /** 上传；onProgress 报已发的字节数 */
  async upload(remote: string, src: Readable, onProgress?: (n: number) => void): Promise<void> {
    const { d, r } = await this.withData(`STOR ${remote}`, "传");
    let sent = 0;
    await new Promise<void>((resolve, reject) => {
      src.on("data", (c: Buffer) => { sent += c.length; onProgress?.(sent); });
      src.once("error", reject);
      d.once("error", reject);
      d.once("finish", resolve);
      src.pipe(d);
    });
    d.destroy();                                    // 不等对方的 TLS 收尾（有的固件不回，会卡住）
    if (r.code < 200) await this.expect(await this.reply(), 226, "传到一半出错了");
  }

  close() { try { this.ctl.write("QUIT\r\n"); } catch { /* 已经断了 */ } this.ctl.destroy(); }
}
