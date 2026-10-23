// 监控网页与它的数据接口、角色接口、直播控制与取帧、定时拍照计划。
import fs from "node:fs";
import path from "node:path";
import { bytes, empty, file, json, type Router } from "../http/router.ts";
import {
  type Ctx, validateDeviceId, CAPTURE_RATE_MAX, DEFAULT_PHOTO_PROMPT, SNAPSHOT_NAME_RE, STREAM_RENEW_SECS, STREAM_POLL_WAIT,
} from "../ctx.ts";
import { HB_SILENT_SECS } from "../heartbeat.ts";
import { now, sleep, strftime } from "../util/time.ts";
// 构建时由 esbuild 以文本内联（单文件可执行里没有 web/ 目录）
import MONITOR_HTML from "../../../web/monitor.html";

const unauthorized = () => json({ error: "invalid or missing X-Api-Token" }, 401);

export function registerMonitor(r: Router, ctx: Ctx) {
  /** 页面本身不校验 token，数据接口才校验（否则没地方填 token） */
  r.get("/monitor", () => bytes(Buffer.from(MONITOR_HTML, "utf8"), "text/html; charset=utf-8"));

  r.get("/snapshot/<name>", (req) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const name = req.params.name;
    if (!SNAPSHOT_NAME_RE.test(name)) return json({ error: "bad snapshot name" }, 400);
    const p = path.join(ctx.dirs.snapshots, `${name}.jpg`);
    if (!fs.existsSync(p)) return json({ error: "snapshot not found" }, 404);
    return file(p, "image/jpeg");
  });

  /** 网页一次拉齐：设备在线状态 + 定时计划 + 快照留档 + 直播 + 角色 */
  r.get("/api/monitor/state", (req) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const t = now();
    const devices: Record<string, any> = {};
    for (const [dev, rec] of ctx.hb.devices) {
      devices[dev] = { last_seen_secs_ago: Math.trunc(t - rec.ts), online: t - rec.ts < HB_SILENT_SECS };
      for (const k of ["heap", "rssi", "mqtt", "bat", "chg", "wdt"]) devices[dev][k] = rec.data[k] ?? null;
    }
    const want = validateDeviceId(req.query.get("device_id") ?? "cores3");
    return json({
      server_time: strftime("%Y-%m-%d %H:%M:%S"),
      mqtt: ctx.mqtt.ok,
      auth_required: !!ctx.cfg.apiToken,
      devices,
      schedules: ctx.schedules.list(),
      snapshots: ctx.listSnapshots(),
      stream: ctx.stream.stats(want),
      role: ctx.roles.get(want).id,
      roles: ctx.roles.all().map((x) => ({ id: x.id, name: x.name })),
    });
  });

  // ── 角色 ──
  r.get("/role", (req) => {
    const cur = ctx.roles.get(validateDeviceId(req.query.get("device_id")));
    return json({ role: cur.id, name: cur.name, roles: ctx.roles.all().map((x) => ({ id: x.id, name: x.name })) });
  });

  /** 网页/agent 切换角色：落盘后先 MQTT 发换图命令再推问候（问候播出时已是新图） */
  r.post("/role", async (req) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const data = req.json() ?? {};
    const dev = validateDeviceId(data.device_id);
    const target = ctx.roles.set(dev, String(data.role ?? ""));
    if (!target) return json({ error: "unknown role" }, 400);
    if (ctx.mqtt.ok) {
      ctx.mqtt.publish(`kagura/cmd/${dev}`, { action: "role", role: target.id });
      if (data.greet ?? true) await ctx.sendPush(ctx.roles.greeting(target), dev);
    }
    console.log(`[${dev}] 🎭  [role/api] → ${target.name} (${target.agent})`);
    return json({ role: target.id, name: target.name });
  });

  // ── 直播 ──
  /** 开/续/停直播。网页按续期周期的一半反复调 start；页面关掉后设备会自己超时收摊 */
  r.post("/api/monitor/stream", (req) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const data = req.json() ?? {};
    const dev = validateDeviceId(data.device_id ?? "cores3");
    const action = data.action ?? "start";
    if (action !== "start" && action !== "stop") return json({ error: "action must be 'start' or 'stop'" }, 400);
    if (!ctx.mqtt.ok) return json({ error: "MQTT 不可用，无法下发直播命令" }, 503);
    if (action === "start") ctx.mqtt.publish(`kagura/cmd/${dev}`, { action: "stream_start", secs: STREAM_RENEW_SECS, port: ctx.stream.port });
    else { ctx.mqtt.publish(`kagura/cmd/${dev}`, { action: "stream_stop" }); ctx.stream.drop(dev); }
    return json({ status: "ok", action, stream: ctx.stream.stats(dev) });
  });

  /** 最新一帧。带 ?after=<seq> 时长轮询：没有更新就挂住，直到有新帧或超时（204） */
  r.get("/stream/<device_id>/frame.jpg", async (req) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const dev = validateDeviceId(req.params.device_id);
    const a = req.query.get("after");
    const after = a !== null && /^-?\d+$/.test(a) ? Number(a) : -1;
    const deadline = now() + STREAM_POLL_WAIT;
    for (;;) {
      const rec = ctx.stream.latest(dev);
      if (rec?.jpeg && rec.seq !== after) return bytes(rec.jpeg, "image/jpeg", { "X-Frame-Seq": String(rec.seq), "Cache-Control": "no-store" });
      if (now() >= deadline) return empty(204);
      await sleep(50);
    }
  });

  // ── 拍照 / 识别 ──
  /** 网页「拍完让它说一句」：对已拍到的照片做识别 + 播报，后台跑 */
  r.post("/api/monitor/describe", (req) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const data = req.json() ?? {};
    const rec = ctx.state.photoResults.get(String(data.request_id ?? ""));
    if (!rec || rec.status !== "done") return json({ error: "没有这张照片，或它还没拍好" }, 404);
    if (!rec.image_path || !fs.existsSync(rec.image_path)) return json({ error: "照片文件已过期" }, 404);
    const dev = validateDeviceId(data.device_id ?? "cores3");
    const prompt = String(data.prompt ?? "").trim() || DEFAULT_PHOTO_PROMPT;
    ctx.describeAndSpeak(rec.image_path, dev, prompt, "手动").catch((e) => console.log(`[snapshot] ⚠️  ${e.message}`));
    return json({ status: "started" }, 202);
  });

  /** 网页「拍一张」：直播中默认抓当前帧；hires=true 才让设备切回 QVGA 拍一张 */
  r.post("/api/monitor/capture", (req) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const data = req.json() ?? {};
    const dev = validateDeviceId(data.device_id ?? "cores3");
    if (!ctx.state.checkRate(dev, "capture", CAPTURE_RATE_MAX)) return json({ error: "拍照过于频繁，请稍后再试" }, 429);
    if (!data.hires) {
      const rid = ctx.captureFromStream(dev);
      if (rid) return json({ request_id: rid, status: "done", source: "stream" });
    }
    if (!ctx.mqtt.ok) return json({ error: "MQTT 不可用，无法下发拍照命令" }, 503);
    return json({ request_id: ctx.issueCapture(dev), status: "queued", source: "device" });
  });

  // ── 定时拍照计划 ──
  r.post("/api/monitor/schedules", (req) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const data = req.json() ?? {};
    try {
      return json(ctx.schedules.add(data.time ?? "", validateDeviceId(data.device_id ?? "cores3"), data.prompt ?? ""), 201);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  });

  const editSchedule = (method: "PATCH" | "DELETE") => (req: any) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const sid = req.params.sid;
    if (method === "DELETE") return ctx.schedules.remove(sid) ? json({ status: "ok" }) : json({ error: "unknown schedule id" }, 404);
    const data = req.json() ?? {};
    const fields: Record<string, any> = {};
    for (const k of ["time", "prompt", "enabled", "device_id"]) if (k in data) fields[k] = data[k];
    try {
      const item = ctx.schedules.update(sid, fields);
      return item ? json(item) : json({ error: "unknown schedule id" }, 404);
    } catch (e: any) {
      return json({ error: e.message }, 400);
    }
  };
  r.add("PATCH", "/api/monitor/schedules/<sid>", editSchedule("PATCH"));
  r.add("DELETE", "/api/monitor/schedules/<sid>", editSchedule("DELETE"));

  /** 立即试跑：后台执行（拍照 + 识别可能几十秒），结果去 state 里看 */
  r.post("/api/monitor/schedules/<sid>/run", (req) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const sid = req.params.sid;
    if (!ctx.schedules.get(sid)) return json({ error: "unknown schedule id" }, 404);
    ctx.schedules.runNow(sid).catch((e) => console.log(`[snapshot] ⚠️  ${e.message}`));
    return json({ status: "started" }, 202);
  });
}
