// 设备文件同步的接口（存储与清单见 ../devicefiles.ts）。
// 设备侧：GET /device/files、GET /device/file、POST /device/sync-result —— 与其它设备上行接口一样不要 token。
// 管理侧：/api/admin/device-files*（只许本机）。
import { bytes, json, type Req, type Res, type Router } from "../http/router.ts";
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

export function registerDeviceFiles(r: Router, ctx: Ctx, files: DeviceFiles) {
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
    resTimer = setTimeout(() => { resTimer = null; sendSync("res"); }, RES_SYNC_DEBOUNCE_MS);
    resTimer.unref?.();
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
}
