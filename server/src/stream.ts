// 设备直播流接收端：一条常驻 TCP 连接收 RGB565 裸帧，只保留最新一帧（对应 stream_server.py）。
//
// 协议（设备 → 服务端，全大端）：
//   握手 : "KAGURA_STREAM v1 <device_id> <token>\n"
//   每帧 : <4 字节长度><该长度的 RGB565 裸字节>
//   结束 : <4 字节 0>
// 服务端不回任何数据——设备只管发，断了就重连。
//
// **握手行和第一帧会被 TCP 合并进同一个 segment**：读完握手后缓冲里剩下的字节
// 必须接着给帧解析用，丢掉就会让整条流错位（表现为"帧长度离谱然后断开"）。
import net from "node:net";
import { now } from "./util/time.ts";

export const MAX_FRAME_BYTES = 400 * 1024;
const HANDSHAKE_MAX = 256;
// 直播中插拍高清照时设备会停发十几秒，按 20s 算会把正常插拍误判成掉线
export const SOCKET_TIMEOUT_MS = 45_000;
export const STALE_AFTER = 10;
const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;

interface Rec { jpeg: Buffer | null; ts: number; seq: number; started: number; frames: number; size: number }

export class StreamHub {
  private latestMap = new Map<string, Rec>();
  private server: net.Server | null = null;
  port = 5002;
  constructor(private toJpeg: (raw: Buffer) => Buffer | null, private token = "") {}

  latest(dev: string): Rec | undefined { return this.latestMap.get(dev); }

  stats(dev: string) {
    const r = this.latestMap.get(dev);
    if (!r) return { live: false, frames: 0, fps: 0.0 };
    const age = now() - r.ts;
    const elapsed = Math.max(r.ts - r.started, 1.0);
    return {
      live: age < STALE_AFTER,
      frames: r.frames,
      fps: r.frames > 1 ? Math.round(r.frames / elapsed * 10) / 10 : 0.0,
      age: Math.round(age * 10) / 10,
      size: r.size,
    };
  }

  drop(dev: string) { this.latestMap.delete(dev); }

  start(port: number): Promise<boolean> {
    this.port = port;
    return new Promise((resolve) => {
      const srv = net.createServer((c) => this.handle(c));
      srv.once("error", (e) => { console.log(`⚠️  直播端口 ${port} 启动失败（直播功能不可用）: ${e.message}`); resolve(false); });
      srv.listen(port, "0.0.0.0", () => { this.server = srv; console.log(`直播流监听 0.0.0.0:${port}`); resolve(true); });
    });
  }

  close() { this.server?.close(); }

  private handle(conn: net.Socket) {
    conn.setTimeout(SOCKET_TIMEOUT_MS, () => conn.destroy());
    let buf: Buffer = Buffer.alloc(0);
    let dev: string | null = null;
    let need = -1;              // -1：等握手；-2：等 4 字节长度；>=0：等帧体
    let frames = 0;
    let started = now();
    const addr = conn.remoteAddress;
    const finish = () => {
      if (dev) {
        const fps = Math.round(frames / Math.max(now() - started, 1) * 10) / 10;
        console.log(`[stream] ⏹  ${dev} 直播结束，共 ${frames} 帧 / ${fps} fps`);
        dev = null;
      }
    };
    conn.on("close", finish);
    conn.on("error", () => {});
    conn.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (need === -1) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) { if (buf.length > HANDSHAKE_MAX) return this.reject(conn, `${addr} 握手失败，断开`); return; }
          const parts = buf.subarray(0, nl).toString("utf8").trim().split(/\s+/);
          buf = buf.subarray(nl + 1);
          if (parts.length < 3 || parts[0] !== "KAGURA_STREAM" || parts[1] !== "v1" || !DEVICE_ID_RE.test(parts[2]))
            return this.reject(conn, `${addr} 握手失败，断开`);
          const tok = parts[3] ?? "";
          if (this.token && tok !== this.token) return this.reject(conn, `${parts[2]} token 不匹配，拒绝`);
          dev = parts[2];
          started = now();
          this.latestMap.set(dev, { jpeg: null, ts: started, seq: 0, started, frames: 0, size: 0 });
          console.log(`[stream] ▶️  ${dev} 开始直播 (来自 ${addr})`);
          need = -2;
        } else if (need === -2) {
          if (buf.length < 4) return;
          const n = buf.readUInt32BE(0);
          buf = buf.subarray(4);
          if (n === 0) { console.log(`[stream] ⏹  ${dev} 正常结束`); conn.destroy(); return; }
          if (n > MAX_FRAME_BYTES) { console.log(`[stream] ⚠️  ${dev} 帧过大 ${n}，断开`); conn.destroy(); return; }
          need = n;
        } else {
          if (buf.length < need) return;
          const raw = Buffer.from(buf.subarray(0, need));
          buf = buf.subarray(need);
          need = -2;
          const jpeg = this.toJpeg(raw);
          if (!jpeg) continue;                     // 尺寸对不上等：跳过这帧，别断流
          frames++;
          const rec = this.latestMap.get(dev!);
          if (!rec) { conn.destroy(); return; }    // 期间被 drop 了，说明已要求停止
          Object.assign(rec, { jpeg, ts: now(), seq: rec.seq + 1, frames, size: jpeg.length });
        }
      }
    });
  }

  private reject(conn: net.Socket, msg: string) {
    console.log(`[stream] ⚠️  ${msg}`);
    conn.destroy();
  }
}
