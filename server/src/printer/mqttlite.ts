// 极简 MQTT 3.1.1 客户端：只为连打印机（拓竹的局域网接口是 TLS 上的 MQTT）。
// 只实现用得到的：CONNECT（用户名 / 密码）、SUBSCRIBE、收发 QoS 0 的 PUBLISH、PING。
// 服务端自己的 broker 用 aedes；这里不引 mqtt.js，是因为只当一个订阅者，一百多行就够，单文件可执行也不必再多带一个库。
import type { Duplex } from "node:stream";

const str = (s: string) => { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
function packet(head: number, ...body: Buffer[]): Buffer {
  const b = Buffer.concat(body);
  const len: number[] = [];
  let n = b.length;
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 0x80; len.push(d); } while (n > 0);
  return Buffer.concat([Buffer.from([head, ...len]), b]);
}

/** CONNACK 返回码 → 人话 */
export const CONNACK_ERRORS: Record<number, string> = { 1: "协议版本不支持", 2: "客户端标识被拒绝", 3: "服务不可用", 4: "用户名或密码不对", 5: "没有权限" };

export interface MqttLiteOpts {
  clientId: string; username?: string; password?: string;
  /** 保活间隔（秒）：一半时间没发过包就发 PING，1.5 倍时间什么都没收到就当断了 */
  keepalive?: number;
  onConnect(): void;
  onMessage(topic: string, payload: Buffer): void;
  /** 连接结束（不管是对方断开、超时还是被拒）；code 是 CONNACK 的返回码（被拒时） */
  onClose(err: string, code?: number): void;
}

export class MqttLite {
  private buf: Buffer = Buffer.alloc(0);
  private pid = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastIn = Date.now();
  private lastOut = Date.now();
  private closed = false;
  connected = false;

  constructor(private sock: Duplex, private o: MqttLiteOpts) {
    const keep = o.keepalive ?? 60;
    sock.on("data", (d: Buffer) => { this.lastIn = Date.now(); this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; try { this.drain(); } catch (e: any) { this.end(`数据解析出错：${e.message}`); } });
    sock.on("error", (e: any) => this.end(String(e?.message ?? e)));
    sock.on("close", () => this.end("连接断开"));
    const flags = 0x02 | (o.username !== undefined ? 0x80 : 0) | (o.password !== undefined ? 0x40 : 0);
    const k = Buffer.alloc(2); k.writeUInt16BE(keep);
    this.send(packet(0x10, str("MQTT"), Buffer.from([0x04, flags]), k, str(o.clientId), ...(o.username !== undefined ? [str(o.username)] : []), ...(o.password !== undefined ? [str(o.password)] : [])));
    this.timer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastIn > keep * 1500) return this.end("太久没有回应");
      if (this.connected && now - this.lastOut > keep * 500) this.send(Buffer.from([0xc0, 0x00]));
    }, Math.max(1000, keep * 250));
    this.timer.unref?.();
  }

  private send(b: Buffer) { if (this.closed) return; this.lastOut = Date.now(); try { this.sock.write(b); } catch { /* close 事件里收尾 */ } }

  private drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      // 剩余长度：变长编码，最多 4 字节
      let len = 0, mul = 1, i = 1;
      for (;; i++) {
        if (i >= this.buf.length) return;
        const d = this.buf[i];
        len += (d & 0x7f) * mul;
        if (!(d & 0x80)) break;
        mul *= 128;
        if (i >= 4) throw new Error("长度字段不合法");
      }
      const start = i + 1;
      if (this.buf.length < start + len) return;
      const head = this.buf[0];
      const body = this.buf.subarray(start, start + len);
      this.buf = this.buf.subarray(start + len);
      this.handle(head, body);
    }
  }

  private handle(head: number, body: Buffer) {
    switch (head >> 4) {
      case 2: {            // CONNACK
        const rc = body[1] ?? 0;
        if (rc !== 0) return this.end(CONNACK_ERRORS[rc] ?? `连接被拒绝（${rc}）`, rc);
        this.connected = true;
        this.o.onConnect();
        return;
      }
      case 3: {            // PUBLISH
        const qos = (head >> 1) & 3;
        const tl = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + tl).toString("utf8");
        let at = 2 + tl;
        if (qos > 0) { const id = body.subarray(at, at + 2); at += 2; if (qos === 1) this.send(Buffer.concat([Buffer.from([0x40, 0x02]), id])); }
        this.o.onMessage(topic, body.subarray(at));
        return;
      }
      default: return;     // SUBACK / PINGRESP 等：收到就算活着
    }
  }

  subscribe(topic: string) {
    const id = Buffer.alloc(2); id.writeUInt16BE((this.pid = (this.pid % 65535) + 1));
    this.send(packet(0x82, id, str(topic), Buffer.from([0])));
  }

  publish(topic: string, payload: string | Buffer) {
    this.send(packet(0x30, str(topic), typeof payload === "string" ? Buffer.from(payload, "utf8") : payload));
  }

  /** 主动断开（不再回调 onClose） */
  close() {
    if (this.closed) return;
    this.send(Buffer.from([0xe0, 0x00]));
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    try { this.sock.destroy(); } catch { /* 已经关了 */ }
  }

  private end(err: string, code?: number) {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    if (this.timer) clearInterval(this.timer);
    try { this.sock.destroy(); } catch { /* 已经关了 */ }
    this.o.onClose(err, code);
  }
}
