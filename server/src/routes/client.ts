// 手机 / 平板网页客户端（/app）：页面本身、配对后的身份、SSE 推送。管理界面里的配对（发令牌 / 吊销）也在这。
//
// 手机 = 一台新设备：用手机自己的麦克风、喇叭、摄像头，对话走和 CoreS3 一样的 /chat、/chat-vision、异步长轮询；
// 「看家」页用监控接口远程看 CoreS3（令牌在 ctx.tokenOk 里等同 API_TOKEN）。
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { AgentRegistry } from "../agent/registry.ts";
import type { WebPush } from "../webpush.ts";
import { resolveInside } from "../agent/paths.ts";
import { json, bytes, type Req, type Res, type Router } from "../http/router.ts";
import type { Ctx } from "../ctx.ts";
import { Clients } from "../clients.ts";
import { isLocal } from "./admin.ts";
import { VERSION } from "../cli.ts";
import APP_HTML from "../../../web/app.html";

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0d1f24"/><circle cx="256" cy="232" r="132" fill="#2dd4bf"/><circle cx="208" cy="214" r="18" fill="#0d1f24"/><circle cx="304" cy="214" r="18" fill="#0d1f24"/><path d="M206 280q50 40 100 0" stroke="#0d1f24" stroke-width="16" fill="none" stroke-linecap="round"/><rect x="176" y="392" width="160" height="28" rx="14" fill="#2dd4bf" opacity=".6"/></svg>`;

/** 通知用的 service worker：收到推送弹一条系统通知，点了就回到 / 打开 /app */
const SW_JS = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title || "Kagura", { body: d.body || "", tag: d.tag || "kagura", icon: "/app/icon.svg" }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
    for (const w of ws) if (new URL(w.url).pathname === "/app") return w.focus();
    return self.clients.openWindow("/app");
  }));
});
`;

export function registerClient(r: Router, ctx: Ctx, clients: Clients, agents?: AgentRegistry, webpush?: WebPush) {
  const guard = (h: (req: Req) => Res | Promise<Res>) => async (req: Req): Promise<Res> => {
    if (!isLocal(req)) return json({ error: "管理接口只允许本机访问" }, 403);
    try { return await h(req); } catch (e: any) { return json({ error: String(e.message || e) }, e.status ?? 400); }
  };
  const unauthorized = () => json({ error: "未配对或令牌已失效：请在电脑上打开管理界面 → 设备 → ＋ 添加手机，重新扫码" }, 401);

  // ── 页面 ──
  r.get("/app", () => bytes(Buffer.from(APP_HTML), "text/html; charset=utf-8", { "Cache-Control": "no-cache" }));
  r.get("/app/manifest.webmanifest", () => json({
    name: "Kagura", short_name: "Kagura", start_url: "/app", scope: "/app", display: "standalone",
    background_color: "#111113", theme_color: "#111113",
    icons: [{ src: "/app/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
  }));
  // 放在 /app/ 下的脚本默认只管 /app/…，页面本身是 /app：用这个头把范围放宽到 /app
  r.get("/app/sw.js", () => bytes(Buffer.from(SW_JS), "text/javascript; charset=utf-8", { "Cache-Control": "no-cache", "Service-Worker-Allowed": "/app" }));
  r.get("/app/icon.svg", () => bytes(Buffer.from(ICON_SVG), "image/svg+xml", { "Cache-Control": "max-age=86400" }));

  // ── 配对后的手机 ──
  /** 我是谁 + 页面要的东西：角色、可看的 CoreS3 设备 */
  r.get("/client/me", (req) => {
    const c = clients.fromReq(req);
    if (!c) return unauthorized();
    const t = Date.now() / 1000;
    const devices = [...ctx.hb.devices.entries()].map(([id, rec]) => ({ id, online: t - rec.ts < 180, secs_ago: Math.trunc(t - rec.ts) }));
    const cur = ctx.roles.get(c.id);
    return json({
      id: c.id, name: c.name, version: VERSION, brain: ctx.brain.kind,
      role: cur.id, roles: ctx.roles.all().map((x) => ({ id: x.id, name: x.name })),
      devices, auth_required: !!ctx.cfg.apiToken, push: !!webpush?.has(c.id),
    });
  });

  // ── 通知（Web Push，见 webpush.ts）：页面关着时她主动说的话变成系统通知 ──
  r.get("/client/push-key", (req) => {
    if (!clients.fromReq(req)) return unauthorized();
    return webpush ? json({ key: webpush.publicKey() }) : json({ error: "这个服务端没开通知" }, 404);
  });
  r.add("POST", "/client/push-subscribe", (req) => {
    const c = clients.fromReq(req);
    if (!c) return unauthorized();
    if (!webpush) return json({ error: "这个服务端没开通知" }, 404);
    try { webpush.subscribe(c.id, req.json()?.subscription); } catch (e: any) { return json({ error: String(e.message) }, 400); }
    console.log(`[client] 🔔 ${c.name}（${c.id}）开了通知`);
    return json({ ok: true });
  });
  r.add("POST", "/client/push-unsubscribe", (req) => {
    const c = clients.fromReq(req);
    if (!c) return unauthorized();
    webpush?.unsubscribe(c.id, String(req.json()?.endpoint ?? "") || undefined);
    return json({ ok: true });
  });

  /** 推送通道：服务端发给这台手机的 push / cmd（同 MQTT 的 kagura/push|cmd/<id>）。EventSource 设不了头，令牌放 ?ct= */
  r.get("/client/events", (req) => {
    const c = clients.fromReq(req);
    if (!c) return unauthorized();
    return { status: 200, headers: {}, body: "", raw: (res) => clients.subscribe(c.id, res) };
  });

  /** 她用 send_file 发来的文件（只认 agent 工作目录 sent/ 下的）。<img> 设不了头，令牌也收 ?ct= */
  r.get("/client/file", (req) => {
    if (!clients.fromReq(req)) return unauthorized();
    const a = agents?.get(String(req.query.get("agent") ?? ""));
    const rel = String(req.query.get("path") ?? "");
    if (!a || !rel.startsWith("sent/")) return json({ error: "没有这个文件" }, 404);
    let f = "";
    try { f = resolveInside(a.workspace, rel); } catch { return json({ error: "没有这个文件" }, 404); }
    // sent/../MEMORY.md 这种：解析后还得在 sent/ 里
    if (path.relative(path.join(fs.realpathSync(a.workspace), "sent"), f).startsWith("..")) return json({ error: "没有这个文件" }, 404);
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return json({ error: "没有这个文件" }, 404);
    const mime = ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".pdf": "application/pdf" } as Record<string, string>)[path.extname(f).toLowerCase()] ?? "application/octet-stream";
    const dl = mime === "application/octet-stream" || req.query.get("download") === "1";
    return bytes(fs.readFileSync(f), mime, { "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
      ...(dl ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(f))}` } : {}) });
  });

  // ── 管理界面：配对 ──
  /** 已配对的手机 + 本机局域网地址（页面据此预填「手机能访问到的地址」） */
  r.add("GET", "/api/admin/clients", guard(() => {
    const lan = Object.values(os.networkInterfaces()).flat()
      .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === "IPv4" && !a.internal).map((a) => a.address)
      .sort((a, b) => Number(!/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a)) - Number(!/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(b)));
    return json({ clients: clients.list().map(({ token_hash, ...c }) => ({ ...c, online: clients.online(c.id) })), lan, port: ctx.cfg.port });
  }));
  /** 新建一台：返回令牌（只这一次）和配对链接；base 是手机能访问到的服务端地址（页面上填，推荐 HTTPS） */
  r.add("POST", "/api/admin/clients", guard((req) => {
    const d = req.json() ?? {};
    const base = String(d.base ?? "").trim().replace(/\/+$/, "");
    if (base && !/^https?:\/\/[^\s/]+/.test(base)) return json({ error: "地址要以 http:// 或 https:// 开头" }, 400);
    const { client, token } = clients.create(String(d.name ?? ""));
    console.log(`[client] 📱 新配对 ${client.name}（${client.id}）`);
    // 令牌放在 # 后面：不会出现在服务器日志和代理日志里
    return json({ client: { id: client.id, name: client.name }, token, link: `${base}/app#pair=${token}` });
  }));
  r.add("POST", "/api/admin/clients/<id>/rename", guard((req) => (clients.rename(req.params.id, String(req.json()?.name ?? "")) ? json({ ok: true }) : json({ error: "没有这台" }, 404))));
  r.add("DELETE", "/api/admin/clients/<id>", guard((req) => { clients.revoke(req.params.id); webpush?.unsubscribe(req.params.id); console.log(`[client] 📱 已吊销 ${req.params.id}`); return json({ ok: true }); }));
}
