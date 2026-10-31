// 推送边合成边播（LRN 2026-10-31，症状「飞书 / 网页回复顺带念，要等整段合成完才发通知」）：
// 主动说的话（朗读版、heartbeat、提醒……）按句合成，第一句好了就发 MQTT 通知，设备 / 手机来取时一边合成一边往下写。
// 协议和边生成边播一样：一个长度随便填的 WAV 头 + 一句句 PCM，不带 Content-Length、不用 chunked，写完关连接
// （设备 snd.stream_play 读到连接关闭为止；手机页面 playResponse 同样边收边播）。
import type http from "node:http";
import { wavHeader } from "../util/wav.ts";

/** 来取音频前最多留多久（设备离线 / 收不到通知时别一直占着内存） */
const KEEP_MS = 3 * 60_000;

export class LivePush {
  readonly chunks: Buffer[] = [];
  done = false;
  private wake: (() => void) | null = null;
  readonly created = Date.now();

  add(pcm: Buffer) { this.chunks.push(pcm); this.notify(); }
  finish() { this.done = true; this.notify(); }
  private notify() { const w = this.wake; this.wake = null; w?.(); }

  /** 把已经合成好的写出去，再等后面的；全部合成完就关连接 */
  async pipe(res: http.ServerResponse) {
    (res as any).useChunkedEncodingByDefault = false;
    res.shouldKeepAlive = false;
    res.writeHead(200, { "Content-Type": "audio/wav", Connection: "close", "Cache-Control": "no-store" });
    // 对方断开时 drain 永远不来：也要听 close
    const write = (buf: Buffer) => new Promise<void>((r) => {
      if (res.write(buf) || res.destroyed) return r();
      const done = () => { res.off("drain", done); res.off("close", done); r(); };
      res.once("drain", done); res.once("close", done);
    });
    await write(wavHeader(0x7ffffff0 - 36));
    for (let i = 0; ; ) {
      if (res.destroyed) break;
      if (i < this.chunks.length) { await write(this.chunks[i++]); continue; }
      if (this.done) break;
      await new Promise<void>((r) => { this.wake = r; setTimeout(r, 30_000).unref?.(); });
      if (!this.done && i >= this.chunks.length && Date.now() - this.created > KEEP_MS) break;
    }
    res.end();
  }
}

/** 正在合成 / 等着被取的推送音频，按文件名找 */
export class LivePushes {
  private map = new Map<string, LivePush>();
  create(name: string): LivePush {
    this.prune();
    const p = new LivePush();
    this.map.set(name, p);
    return p;
  }
  /** 取走（一条推送只给一个设备播一次，和落盘的推送音频「下载后删除」一致） */
  take(name: string): LivePush | undefined {
    const p = this.map.get(name);
    if (p) this.map.delete(name);
    return p;
  }
  private prune() {
    const now = Date.now();
    for (const [k, p] of this.map) if (now - p.created > KEEP_MS) this.map.delete(k);
  }
}
