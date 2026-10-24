// 手机客户端：配对令牌、吊销、SSE 推送转发、令牌 = 受信设备
import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { Clients } from "../src/clients.ts";
import { Ctx } from "../src/ctx.ts";
import { tmpdir } from "./helpers.ts";

const req = (headers: Record<string, string>, query = "", remote = "192.168.1.50"): any => ({
  remoteAddr: remote, query: new URLSearchParams(query),
  header: (n: string) => headers[Object.keys(headers).find((k) => k.toLowerCase() === n.toLowerCase()) ?? ""] ?? "",
  hasHeader: (n: string) => Object.keys(headers).some((k) => k.toLowerCase() === n.toLowerCase()),
});

/** 假的 http.ServerResponse：记下写了什么，能模拟断开 */
class FakeRes extends EventEmitter {
  out = "";
  ended = false;
  writeHead() { return this; }
  write(s: string) { this.out += s; return true; }
  end() { this.ended = true; this.emit("close"); }
}

describe("手机客户端：配对令牌", () => {
  it("新建返回明文令牌，只存哈希；三种带法都认；乱填、吊销后都不认", () => {
    const file = path.join(tmpdir("cl"), "clients.json");
    const cs = new Clients(file);
    const { client, token } = cs.create("小米手机");
    expect(client.id).toMatch(/^phone-[0-9a-f]{6}$/);
    expect(fs.readFileSync(file, "utf8")).not.toContain(token);
    expect(cs.fromReq(req({ Authorization: `Bearer ${token}` }))?.id).toBe(client.id);
    expect(cs.fromReq(req({ "X-Client-Token": token }))?.id).toBe(client.id);
    expect(cs.fromReq(req({}, `ct=${token}`))?.id).toBe(client.id);
    expect(cs.fromReq(req({ Authorization: "Bearer kc_wrong" }))).toBeNull();
    expect(cs.fromReq(req({}))).toBeNull();
    expect(cs.list()[0].last_seen).toBeGreaterThan(0);
    cs.revoke(client.id);
    expect(cs.fromReq(req({ Authorization: `Bearer ${token}` }))).toBeNull();
  });

  it("SSE：发往这台手机的 push / cmd 转过去，别的设备的不转；吊销时断开", async () => {
    const cs = new Clients(path.join(tmpdir("cl"), "clients.json"));
    const { client } = cs.create("iPad");
    const res = new FakeRes();
    const done = cs.subscribe(client.id, res as any);
    expect(cs.online(client.id)).toBe(true);
    cs.onPublish(`kagura/push/${client.id}`, { type: "push", url: "/push-audio/a.wav" });
    cs.onPublish(`kagura/cmd/${client.id}`, { action: "role", role: "mio" });
    cs.onPublish("kagura/push/cores3", { type: "push", url: "/push-audio/b.wav" });
    expect(res.out).toContain(`event: push\ndata: {"type":"push","url":"/push-audio/a.wav"}`);
    expect(res.out).toContain(`event: cmd\ndata: {"action":"role","role":"mio"}`);
    expect(res.out).not.toContain("b.wav");
    cs.revoke(client.id);
    await done;
    expect(res.ended).toBe(true);
    expect(cs.online(client.id)).toBe(false);
  });
});

describe("令牌 = 受信设备", () => {
  const mk = () => {
    const c: any = Object.create(Ctx.prototype);
    c.cfg = { dataDir: tmpdir("trust"), deviceTrust: "approve", apiToken: "secret" };
    c.trust = {};
    c.clients = new Clients(path.join(c.cfg.dataDir, "clients.json"));
    return c as Ctx;
  };
  it("浏览器带令牌、以自己的 id 说话：受信；拿手机令牌冒充 CoreS3：不受信；监控接口凭令牌放行", () => {
    const c = mk();
    c.noteDevice("cores3", "192.168.1.20");
    const { client, token } = c.clients!.create("手机");
    const browser = { Origin: "https://kagura.tail1234.ts.net", "Sec-Fetch-Site": "same-origin", Authorization: `Bearer ${token}` };
    expect(c.deviceTrusted(req(browser, "", "100.64.0.9"), client.id)).toBe(true);
    expect(c.deviceTrusted(req(browser, "", "192.168.1.20"), "cores3")).toBe(false);
    expect(c.deviceTrusted(req({ Origin: "https://x" }, "", "100.64.0.9"), client.id)).toBe(false);   // 没令牌
    expect(c.tokenOk(req({ Authorization: `Bearer ${token}` }))).toBe(true);
    expect(c.tokenOk(req({}, `ct=${token}`))).toBe(true);
    expect(c.tokenOk(req({}))).toBe(false);
    expect(c.tokenOk(req({ "X-Api-Token": "secret" }))).toBe(true);
  });
});
