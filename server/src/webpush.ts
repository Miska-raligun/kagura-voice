// 网页推送（Web Push）：手机 / 平板的页面没开着时，她主动说的话变成一条系统通知，点开就是 /app。
//
// 页面开着走 SSE（clients.ts，直接播语音）；页面关了 SSE 就断了，以前这时候的话谁都收不到。
// 浏览器只在 HTTPS 下给订阅；iOS 还要先「添加到主屏幕」。推送经浏览器厂商的服务器中转（Chrome → FCM，Safari → Apple），
// 内容端到端加密（RFC 8291，aes128gcm），中转方看不到；服务端身份用 VAPID（RFC 8292，ES256 签的 JWT）。
// 不引 web-push 包：用到的只有一次 ECDH + HKDF + AES-GCM 和一个 JWT，Node 自带的 crypto 都有。
import fs from "node:fs";
import crypto from "node:crypto";

export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }
interface State { vapid?: { publicKey: string; privateJwk: crypto.JsonWebKey }; subs: Record<string, PushSub[]> }

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");
/** 每台手机最多记几个订阅（换浏览器 / 重装主屏幕图标会多出来） */
const MAX_SUBS = 4;

/** 加密一条消息（RFC 8291）。返回请求体 */
export function encryptPush(sub: PushSub, plaintext: Buffer, salt = crypto.randomBytes(16)): Buffer {
  const local = crypto.createECDH("prime256v1");
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  if (ua.length !== 65 || auth.length !== 16) throw new Error("订阅的密钥不对");
  const as = local.generateKeys();
  const secret = local.computeSecret(ua);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua, as]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([plaintext, Buffer.from([2])])), c.final(), c.getAuthTag()]);   // 0x02 = 最后一条记录
  const head = Buffer.alloc(21);
  salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = as.length;
  return Buffer.concat([head, as, body]);
}

/** VAPID 的 Authorization 头 */
export function vapidAuth(endpoint: string, publicKey: string, privateJwk: crypto.JsonWebKey, contact: string, now = Date.now()): string {
  const enc = (o: unknown) => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: contact })}`;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), { key: crypto.createPrivateKey({ key: privateJwk as any, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${publicKey}`;
}

export class WebPush {
  private state: State = { subs: {} };
  constructor(private file: string, private o: { fetch?: typeof fetch; contact?: () => string } = {}) {
    try { this.state = { subs: {}, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { /* 第一次用 */ }
  }
  private save() { try { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 1), { mode: 0o600 }); } catch (e: any) { console.log(`[webpush] ⚠️  存不下: ${e.message}`); } }

  /** 服务端公钥（页面订阅时要）。第一次用到才生成 */
  publicKey(): string {
    if (!this.state.vapid) {
      const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = privateKey.export({ format: "jwk" });
      this.state.vapid = { privateJwk: jwk, publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x!), unb64u(jwk.y!)])) };
      this.save();
    }
    return this.state.vapid.publicKey;
  }

  subscribe(clientId: string, sub: PushSub) {
    if (!/^https:\/\//.test(String(sub?.endpoint)) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("订阅信息不完整");
    const list = (this.state.subs[clientId] ?? []).filter((s) => s.endpoint !== sub.endpoint);
    list.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
    this.state.subs[clientId] = list.slice(-MAX_SUBS);
    this.save();
  }
  unsubscribe(clientId: string, endpoint?: string) {
    const list = (this.state.subs[clientId] ?? []).filter((s) => endpoint && s.endpoint !== endpoint);
    if (list.length) this.state.subs[clientId] = list; else delete this.state.subs[clientId];
    this.save();
  }
  has(clientId: string) { return !!this.state.subs[clientId]?.length; }
  clients() { return Object.keys(this.state.subs); }

  /** 给一台手机发通知。返回送到了几个订阅；订阅失效（404 / 410）的顺手删掉 */
  async send(clientId: string, msg: { title: string; body: string; tag?: string }): Promise<number> {
    const subs = this.state.subs[clientId] ?? [];
    if (!subs.length) return 0;
    const pub = this.publicKey();
    const f = this.o.fetch ?? fetch;
    let ok = 0;
    for (const sub of subs) {
      try {
        const r = await f(sub.endpoint, {
          method: "POST", body: new Uint8Array(encryptPush(sub, Buffer.from(JSON.stringify(msg)))), signal: AbortSignal.timeout(15_000),
          headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "43200", Urgency: "normal",
            Authorization: vapidAuth(sub.endpoint, pub, this.state.vapid!.privateJwk, this.o.contact?.() || "mailto:admin@example.com") },
        });
        if (r.status === 404 || r.status === 410) { this.unsubscribe(clientId, sub.endpoint); console.log(`[webpush] 🗑  ${clientId} 的一个订阅失效了，已删`); }
        else if (r.status >= 200 && r.status < 300) ok++;
        else console.log(`[webpush] ⚠️  ${clientId} 推送被拒（HTTP ${r.status}）：${(await r.text().catch(() => "")).slice(0, 200)}`);
      } catch (e: any) { console.log(`[webpush] ⚠️  ${clientId} 推送没发出去: ${e.message}`); }
    }
    return ok;
  }
}
