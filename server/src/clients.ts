// 手机 / 平板客户端（浏览器里的 /app）：配对令牌 + SSE 推送通道。
//
// 为什么要令牌：设备上行接口不带口令，可信度靠「第一台心跳的设备 + 绑定 IP」，而且带 Origin 的（浏览器发的）一律不受信。
// 手机会换 IP、会出门，还是浏览器——那套判据全不适用。所以管理界面给每台手机发一个令牌（扫码），
// 凭令牌 = 受信设备（能用 exec 等），不看 IP，随时可吊销。令牌只存哈希。
//
// 推送：浏览器连不了 MQTT。MqttHub 每次 publish 都抄一份给这里，发往某台手机的（kagura/push|cmd/<手机 id>）
// 经它的 SSE 连接（GET /client/events）送过去。
import fs from "node:fs";
import crypto from "node:crypto";
import type http from "node:http";
import type { Req } from "./http/router.ts";

export interface ClientRec {
  /** 也是它的设备 id（X-Device-Id），字母数字 - _，≤32 */
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen?: number;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export class Clients {
  private subs = new Map<string, Set<http.ServerResponse>>();
  private seenSaved = new Map<string, number>();

  constructor(private file: string) {}

  list(): ClientRec[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(v) ? v.filter((c) => c && typeof c.id === "string" && typeof c.token_hash === "string") : [];
    } catch { return []; }
  }

  private save(list: ClientRec[]) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** 新建一台：返回明文令牌（只这一次，之后只有哈希） */
  create(name: string): { client: ClientRec; token: string } {
    const list = this.list();
    let id = "";
    do id = `phone-${crypto.randomBytes(3).toString("hex")}`; while (list.some((c) => c.id === id));
    const token = `kc_${crypto.randomBytes(24).toString("base64url")}`;
    const client: ClientRec = { id, name: name.trim().slice(0, 40) || "我的手机", token_hash: sha(token), created_at: Date.now() };
    this.save([...list, client]);
    return { client, token };
  }

  /** 吊销：删掉记录，断开它的推送连接 */
  revoke(id: string) {
    this.save(this.list().filter((c) => c.id !== id));
    for (const res of this.subs.get(id) ?? []) res.end();
    this.subs.delete(id);
  }

  rename(id: string, name: string) {
    const list = this.list();
    const c = list.find((x) => x.id === id);
    if (!c) return false;
    c.name = name.trim().slice(0, 40) || c.name;
    this.save(list);
    return true;
  }

  /** 令牌 → 客户端（常数时间比较哈希） */
  verify(token: string): ClientRec | null {
    if (!token || !token.startsWith("kc_")) return null;
    const h = Buffer.from(sha(token), "hex");
    for (const c of this.list()) {
      const ch = Buffer.from(c.token_hash, "hex");
      if (ch.length === h.length && crypto.timingSafeEqual(ch, h)) { this.touch(c); return c; }
    }
    return null;
  }

  /** 请求里带的令牌：Authorization: Bearer / X-Client-Token / ?ct=（EventSource 设不了请求头） */
  static tokenOf(req: Req): string {
    const a = req.header("Authorization");
    if (/^Bearer\s+kc_/i.test(a)) return a.replace(/^Bearer\s+/i, "").trim();
    return req.header("X-Client-Token") || req.query.get("ct") || "";
  }

  fromReq(req: Req): ClientRec | null { return this.verify(Clients.tokenOf(req)); }

  /** 最近在线：内存里实时更新，落盘最多一分钟一次 */
  private touch(c: ClientRec) {
    const now = Date.now();
    c.last_seen = now;
    if (now - (this.seenSaved.get(c.id) ?? 0) < 60_000) return;
    this.seenSaved.set(c.id, now);
    const list = this.list();
    const x = list.find((y) => y.id === c.id);
    if (x) { x.last_seen = now; this.save(list); }
  }

  online(id: string) { return (this.subs.get(id)?.size ?? 0) > 0; }

  // ── SSE ──

  /** 接管一个 SSE 连接，断开时自动移除；每 25 秒发一行注释保活（代理 / 手机网络会掐掉静默连接） */
  subscribe(id: string, res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    const set = this.subs.get(id) ?? new Set();
    set.add(res);
    this.subs.set(id, set);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    ping.unref?.();
    return new Promise((resolve) => {
      res.on("close", () => {
        clearInterval(ping);
        set.delete(res);
        if (!set.size) this.subs.delete(id);
        resolve();
      });
    });
  }

  send(id: string, event: string, data: unknown) {
    for (const res of this.subs.get(id) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** MqttHub 抄过来的每条发布：kagura/push/<id> → push，kagura/cmd/<id> → cmd */
  onPublish(topic: string, payload: unknown) {
    const m = /^kagura\/(push|cmd)\/(.+)$/.exec(topic);
    if (m && this.subs.has(m[2])) this.send(m[2], m[1], payload);
  }
}
