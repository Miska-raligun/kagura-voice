// 手机 / 平板网页客户端（/app）：页面本身、配对后的身份、SSE 推送。管理界面里的配对（发令牌 / 吊销）也在这。
//
// 手机 = 一台新设备：用手机自己的麦克风、喇叭、摄像头，对话走和 CoreS3 一样的 /chat、/chat-vision、异步长轮询；
// 「看家」页用监控接口远程看 CoreS3（令牌在 ctx.tokenOk 里等同 API_TOKEN）。
import os from "node:os";
import { json, bytes, type Req, type Res, type Router } from "../http/router.ts";
import type { Ctx } from "../ctx.ts";
import { Clients } from "../clients.ts";
import { isLocal } from "./admin.ts";
import { VERSION } from "../cli.ts";
import APP_HTML from "../../../web/app.html";

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0d1f24"/><circle cx="256" cy="232" r="132" fill="#2dd4bf"/><circle cx="208" cy="214" r="18" fill="#0d1f24"/><circle cx="304" cy="214" r="18" fill="#0d1f24"/><path d="M206 280q50 40 100 0" stroke="#0d1f24" stroke-width="16" fill="none" stroke-linecap="round"/><rect x="176" y="392" width="160" height="28" rx="14" fill="#2dd4bf" opacity=".6"/></svg>`;

export function registerClient(r: Router, ctx: Ctx, clients: Clients) {
  const guard = (h: (req: Req) => Res | Promise<Res>) => async (req: Req): Promise<Res> => {
    if (!isLocal(req)) return json({ error: "管理接口只允许本机访问" }, 403);
    try { return await h(req); } catch (e: any) { return json({ error: String(e.message || e) }, e.status ?? 400); }
  };
  const unauthorized = () => json({ error: "未配对或令牌已失效：请在电脑上打开管理界面 → 设备 → ＋ 添加手机，重新扫码" }, 401);

  // ── 页面 ──
  r.get("/app", () => bytes(Buffer.from(APP_HTML), "text/html; charset=utf-8", { "Cache-Control": "no-cache" }));
  r.get("/app/manifest.webmanifest", () => json({
    name: "Kagura", short_name: "Kagura", start_url: "/app", scope: "/app", display: "standalone",
    background_color: "#0b1418", theme_color: "#0b1418",
    icons: [{ src: "/app/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
  }));
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
      devices, auth_required: !!ctx.cfg.apiToken,
    });
  });

  /** 推送通道：服务端发给这台手机的 push / cmd（同 MQTT 的 kagura/push|cmd/<id>）。EventSource 设不了头，令牌放 ?ct= */
  r.get("/client/events", (req) => {
    const c = clients.fromReq(req);
    if (!c) return unauthorized();
    return { status: 200, headers: {}, body: "", raw: (res) => clients.subscribe(c.id, res) };
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
  r.add("DELETE", "/api/admin/clients/<id>", guard((req) => { clients.revoke(req.params.id); console.log(`[client] 📱 已吊销 ${req.params.id}`); return json({ ok: true }); }));
}
