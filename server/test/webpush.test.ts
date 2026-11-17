// 网页推送：加密用 http_ece（web-push 包用的那个库）解一遍对照；VAPID 签名用公钥验；失效的订阅自动删
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { encryptPush, vapidAuth, WebPush, type PushSub } from "../src/webpush.ts";

const ece = createRequire(import.meta.url)("http_ece");
const b64u = (b: Buffer) => b.toString("base64url");

function browser() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub: PushSub = { endpoint: "https://push.example/send/abc", keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
  return { sub, decrypt: (body: Buffer) => ece.decrypt(body, { version: "aes128gcm", privateKey: ecdh, authSecret: auth }).toString("utf8") };
}

describe("网页推送", () => {
  it("加密：浏览器那头（http_ece）解得开，中文不乱", () => {
    const b = browser();
    expect(b.decrypt(encryptPush(b.sub, Buffer.from("该喝水了，主人。")))).toBe("该喝水了，主人。");
  });

  it("VAPID：ES256 签名验得过，aud 是推送服务的源", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const h = vapidAuth("https://push.example/send/abc", "PUB", privateKey.export({ format: "jwk" }), "mailto:a@example.com", 1_000_000);
    const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    expect(k).toBe("PUB");
    const [hd, pl, sig] = t.split(".");
    expect(JSON.parse(Buffer.from(pl, "base64url").toString())).toEqual({ aud: "https://push.example", exp: 1000 + 12 * 3600, sub: "mailto:a@example.com" });
    expect(crypto.verify("sha256", Buffer.from(`${hd}.${pl}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true);
  });

  it("发送：带对的头，内容解得开；410 的订阅删掉；密钥落盘后重启还是同一把", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kagura-wp-")), "webpush.json");
    const b = browser(), dead = browser();
    dead.sub.endpoint = "https://push.example/send/dead";
    const calls: { url: string; headers: any; body: Buffer }[] = [];
    const fake = (async (url: string, init: any) => {
      calls.push({ url, headers: init.headers, body: Buffer.from(init.body) });
      return new Response(null, { status: url.endsWith("dead") ? 410 : 201 });
    }) as any;
    const wp = new WebPush(file, { fetch: fake });
    const key = wp.publicKey();
    expect(Buffer.from(key, "base64url").length).toBe(65);
    wp.subscribe("phone-1", b.sub);
    wp.subscribe("phone-1", dead.sub);
    expect(() => wp.subscribe("phone-1", { endpoint: "http://insecure", keys: b.sub.keys })).toThrow();
    expect(await wp.send("phone-1", { title: "神乐", body: "到点啦" })).toBe(1);
    const good = calls.find((c) => c.url === b.sub.endpoint)!;
    expect(good.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(good.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(JSON.parse(b.decrypt(good.body))).toEqual({ title: "神乐", body: "到点啦" });
    const again = new WebPush(file, { fetch: fake });
    expect(again.publicKey()).toBe(key);
    expect(again.has("phone-1")).toBe(true);
    calls.length = 0;
    await again.send("phone-1", { title: "t", body: "b" });
    expect(calls.map((c) => c.url)).toEqual([b.sub.endpoint]);            // 失效的那个已经删了
    again.unsubscribe("phone-1");
    expect(again.has("phone-1")).toBe(false);
  });
});
