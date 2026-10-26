// 设备文件同步的接口（存储与清单见 ../devicefiles.ts）。
// 设备侧：GET /device/files、GET /device/file、POST /device/sync-result —— 与其它设备上行接口一样不要 token。
// 管理侧：/api/admin/device-files*（只许本机）。
// 手机显示用的另一套图（../appimages.ts）：手机读 GET /app/img，手机自己改 /client/images（配对令牌），管理界面 /api/admin/app-images*。
import { bytes, empty, json, type Req, type Res, type Router } from "../http/router.ts";
import { AppImages, MAX_APP_IMAGE, checkName, checkRole } from "../appimages.ts";
import { type Ctx, validateDeviceId } from "../ctx.ts";
import { DeviceFiles, IMAGE_SLOTS, checkPath, type Scope } from "../devicefiles.ts";
import { isLocal } from "./admin.ts";
import { now } from "../util/time.ts";

const SCOPES = new Set(["res", "code", "all"]);
const scopeOf = (v: unknown, dflt: Scope): Scope => (typeof v === "string" && SCOPES.has(v) ? (v as Scope) : dflt);
/** 传图后等一会儿再通知设备：一口气传好几张只同步一次 */
const RES_SYNC_DEBOUNCE_MS = 1500;

export interface SyncResult { scope: string; ok: boolean; changed: number; removed: number; error: string; ts: number }

/** 设备固件认不认 sync 命令：带 ota 同步模块的固件心跳里有 ota/fw/res 字段（旧固件收到命令直接忽略） */
export const otaCapable = (hb: Record<string, any>) => hb.ota === 1 || "fw" in hb || "res" in hb;

export function registerDeviceFiles(r: Router, ctx: Ctx, files: DeviceFiles, appImgs?: AppImages) {
  const results = new Map<string, SyncResult>();
  let resTimer: NodeJS.Timeout | null = null;

  /** 给设备发同步命令。dev 为空 = 所有见过的设备 */
  const sendSync = (scope: Scope, dev = ""): string[] => {
    if (!ctx.mqtt.ok) return [];
    const devs = dev ? [dev] : [...ctx.hb.devices.keys()];
    for (const d of devs) ctx.mqtt.publish(`kagura/cmd/${d}`, { action: "sync", scope });
    if (devs.length) console.log(`[files] 🔄  同步(${scope}) → ${devs.join(", ")}`);
    return devs;
  };
  const resChanged = () => {
    if (resTimer) clearTimeout(resTimer);
    resTimer = setTimeout(() => { resTimer = null; sendSync("res"); imagesChanged(); }, RES_SYNC_DEBOUNCE_MS);
    resTimer.unref?.();
  };
  /** 告诉开着的手机页面：图换了，重新取（手机没传的图位用的是 CoreS3 那套，那套变了也要通知） */
  const imagesChanged = () => {
    for (const c of ctx.clients?.list() ?? []) ctx.clients!.send(c.id, "cmd", { action: "images" });
  };

  // ── 设备侧 ──
  r.get("/device/files", (req) => json(files.manifest(scopeOf(req.query.get("scope"), "res"))));

  r.get("/device/file", (req) => {
    let p: string;
    try { p = checkPath(req.query.get("p") ?? ""); } catch (e: any) { return json({ error: e.message }, 400); }
    const b = files.read(p);
    if (!b) return json({ error: "not found" }, 404);
    return bytes(b, p.endsWith(".jpg") ? "image/jpeg" : "text/plain; charset=utf-8");
  });

  r.post("/device/sync-result", (req) => {
    const d = req.json() ?? {};
    const dev = validateDeviceId(d.device_id ?? "cores3");
    const res: SyncResult = {
      scope: String(d.scope ?? ""), ok: !!d.ok, changed: Number(d.changed) || 0, removed: Number(d.removed) || 0,
      error: String(d.error ?? "").slice(0, 200), ts: now(),
    };
    results.set(dev, res);
    console.log(`[files] ${res.ok ? "✅" : "⚠️ "} ${dev} 同步(${res.scope}) ${res.ok ? `更新 ${res.changed} 个、删除 ${res.removed} 个` : res.error}`);
    return json({ status: "ok" });
  });

  // ── 管理侧 ──
  type H = (req: Req) => Res | Promise<Res>;
  const guard = (h: H): H => async (req) => {
    if (!isLocal(req)) return json({ error: "管理接口只允许本机访问" }, 403);
    try { return await h(req); }
    catch (e: any) { return json({ error: String(e.message || e) }, e.status ?? 400); }
  };

  r.add("GET", "/api/admin/device-files", guard(() => {
    const code = files.manifest("code"), res = files.manifest("res");
    const t = now();
    return json({
      version: files.builtinVersion,
      code_rev: code.rev, res_rev: res.rev,
      files: files.list().map((f) => ({ ...f, overrides_builtin: f.source === "custom" && files.isBuiltin(f.p) })),
      slots: IMAGE_SLOTS,
      roles: ctx.roles.all().map((ro) => ({ id: ro.id, name: ro.name })),
      devices: [...ctx.hb.devices.entries()].map(([id, rec]) => ({
        id, online: t - rec.ts < 200, ota_capable: otaCapable(rec.data),
        code_rev: rec.data.fw ?? null, res_rev: rec.data.res ?? null, fw_version: rec.data.fwv ?? null,
        last_sync: results.get(id) ?? null,
      })),
      mqtt: ctx.mqtt.ok,
    });
  }));

  r.add("GET", "/api/admin/device-files/raw", guard((req) => {
    const p = checkPath(req.query.get("p") ?? "");
    const b = files.read(p);
    if (!b) return json({ error: "没有这个文件" }, 404);
    return bytes(b, p.endsWith(".jpg") ? "image/jpeg" : "text/plain; charset=utf-8", { "Cache-Control": "no-cache" });
  }));

  /** 上传：{ p, b64 }。图片会自动通知设备同步；代码要另外点「更新设备代码」 */
  r.add("PUT", "/api/admin/device-files", guard((req) => {
    const d = req.json() ?? {};
    const p = checkPath(String(d.p ?? ""));
    const data = Buffer.from(String(d.b64 ?? ""), "base64");
    if (!data.length) return json({ error: "内容为空" }, 400);
    files.put(p, data);
    if (p.startsWith("resource/")) resChanged();
    return json({ p, n: data.length });
  }));

  r.add("DELETE", "/api/admin/device-files", guard((req) => {
    const p = checkPath(req.query.get("p") ?? "");
    if (!files.remove(p)) return json({ error: files.isBuiltin(p) ? "这是内置代码，没有覆盖可删" : "没有这个文件" }, 404);
    if (p.startsWith("resource/")) resChanged();
    return json({ p, restored_builtin: files.isBuiltin(p) });
  }));

  /** 手动同步：{ scope: res|code|all, device? }。code 需要在设备屏幕上点确认 */
  r.add("POST", "/api/admin/device-files/sync", guard((req) => {
    const d = req.json() ?? {};
    if (!ctx.mqtt.ok) return json({ error: "MQTT 不可用" }, 503);
    const dev = d.device ? validateDeviceId(d.device) : "";
    const scope = scopeOf(d.scope, "res");
    const t = now();
    const known = dev ? [dev] : [...ctx.hb.devices.keys()];
    if (!known.length) return json({ error: "还没有设备连上来过" }, 404);
    const info = (id: string) => ctx.hb.devices.get(id);
    const unsupported = known.filter((id) => info(id) && !otaCapable(info(id)!.data));
    const offline = known.filter((id) => !unsupported.includes(id) && (!info(id) || t - info(id)!.ts >= 200));
    const want = files.manifest("code").rev;
    const upToDate = scope === "code" ? known.filter((id) => info(id)?.data.fw === want) : [];
    const targets = known.filter((id) => !unsupported.includes(id) && !offline.includes(id) && !upToDate.includes(id));
    for (const x of targets) { results.delete(x); sendSync(scope, x); }
    return json({ sent: targets, unsupported, offline, up_to_date: upToDate });
  }));

  if (appImgs) registerAppImages(r, ctx, files, appImgs, guard, imagesChanged);
}

/** 手机显示用的图。没单独传的图位退回 CoreS3 那套 */
function registerAppImages(r: Router, ctx: Ctx, files: DeviceFiles, imgs: AppImages,
  guard: (h: (req: Req) => Res | Promise<Res>) => (req: Req) => Res | Promise<Res>, changed: () => void) {
  /**
   * 手机上某个状态显示哪张图。先角色自己的、再默认的（角色对不上比画质差更糟）；同一层里手机的优先，
   * 手机这套缺了这个状态就用手机这套的待机图（别跟 CoreS3 的混着来，一会儿高清竖图一会儿 320×240）。
   */
  const resolve = (role: string, name: string) => {
    for (const ro of role ? [role, ""] : [""]) {
      for (const n of name === "img_bg" ? [name] : [name, "img_bg"]) {
        const a = imgs.read(ro, n);
        if (a) return { ...a, src: "app", role: ro, name: n };
      }
      for (const n of name === "img_bg" ? [name] : [name, "img_bg"]) {
        const p = `resource/${ro ? ro + "/" : ""}${n}.jpg`;
        const b = files.read(p);
        if (b) return { data: b, type: "image/jpeg", mtime: 0, src: "device", role: ro, name: n };
      }
    }
    return null;
  };
  const roleOk = (role: string) => { checkRole(role); if (role && !ctx.roles.all().some((x) => x.id === role)) throw Object.assign(new Error("没有这个角色"), { status: 404 }); return role; };
  const wrap = (h: (req: Req) => Res | Promise<Res>) => async (req: Req): Promise<Res> => {
    try { return await h(req); } catch (e: any) { return json({ error: String(e.message || e) }, e.status ?? 400); }
  };

  // 手机页面直接 <img> / new Image() 取，带不了头——和 /device/file 一样不要令牌（都是角色图）
  r.get("/app/img", wrap((req) => {
    const role = checkRole(req.query.get("role") ?? ""), name = checkName(req.query.get("name") ?? "");
    const hit = resolve(role, name);
    if (!hit) return json({ error: "没有图" }, 404);
    const etag = `"${hit.src}-${hit.role}-${hit.name}-${hit.data.length}-${Math.trunc(hit.mtime)}"`;
    if (req.header("If-None-Match") === etag) return { ...empty(304), headers: { ETag: etag } };
    return bytes(hit.data, hit.type, { "Cache-Control": "no-cache", ETag: etag, "X-Img-Src": hit.src });
  }));

  /** 某个角色每个图位现在用的是哪张：phone = 手机单独传的；否则 using 说明退回到了哪 */
  const slotsOf = (role: string) => IMAGE_SLOTS.map((s) => {
    const own = imgs.find(role, s.base);
    const hit = own ? null : resolve(role, s.base);
    return {
      name: s.base, desc: s.desc,
      phone: own ? { ext: own.ext, n: imgs.read(role, s.base)?.data.length ?? 0 } : null,
      using: own ? "phone" : !hit ? "none" : `${hit.src === "app" ? "phone" : "cores3"}${hit.role === role ? "" : "-default"}${hit.name === s.base ? "" : "-bg"}`,
    };
  });

  // ── 配对过的手机自己改 ──
  const phone = (h: (req: Req) => Res | Promise<Res>) => wrap((req) => (ctx.clients?.fromReq(req) ? h(req) : json({ error: "未配对" }, 401)));
  r.get("/client/images", phone((req) => {
    const role = roleOk(req.query.get("role") ?? "");
    return json({ role, slots: slotsOf(role), max: MAX_APP_IMAGE });
  }));
  r.add("PUT", "/client/images", phone((req) => {
    const d = req.json() ?? {};
    const role = roleOk(String(d.role ?? "")), name = checkName(String(d.name ?? ""));
    const data = Buffer.from(String(d.b64 ?? ""), "base64");
    if (!data.length) return json({ error: "内容为空" }, 400);
    const x = imgs.put(role, name, data);
    console.log(`[files] 📱 ${ctx.clients!.fromReq(req)!.id} 换了手机图 ${role || "默认"}/${name}（${x.n >> 10}KB）`);
    changed();
    return json(x);
  }));
  r.add("DELETE", "/client/images", phone((req) => {
    const role = roleOk(req.query.get("role") ?? ""), name = checkName(req.query.get("name") ?? "");
    if (!imgs.remove(role, name)) return json({ error: "这个图位没有手机单独的图" }, 404);
    changed();
    return json({ ok: true });
  }));

  // ── 管理界面 ──
  r.add("GET", "/api/admin/app-images", guard(() => json({ files: imgs.list(), slots: IMAGE_SLOTS })));
  r.add("GET", "/api/admin/app-images/raw", guard((req) => {
    const hit = imgs.read(checkRole(req.query.get("role") ?? ""), checkName(req.query.get("name") ?? ""));
    return hit ? bytes(hit.data, hit.type, { "Cache-Control": "no-cache" }) : json({ error: "没有这个文件" }, 404);
  }));
  r.add("PUT", "/api/admin/app-images", guard((req) => {
    const d = req.json() ?? {};
    const data = Buffer.from(String(d.b64 ?? ""), "base64");
    if (!data.length) return json({ error: "内容为空" }, 400);
    const x = imgs.put(checkRole(String(d.role ?? "")), checkName(String(d.name ?? "")), data);
    changed();
    return json(x);
  }));
  r.add("DELETE", "/api/admin/app-images", guard((req) => {
    if (!imgs.remove(checkRole(req.query.get("role") ?? ""), checkName(req.query.get("name") ?? ""))) return json({ error: "没有这个文件" }, 404);
    changed();
    return json({ ok: true });
  }));
}
