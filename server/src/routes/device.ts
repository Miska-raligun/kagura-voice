// 推送、远程拍照、设备诊断（心跳/崩溃上报/状态）、在家状态、摇一摇与触摸、杂项。
import fs from "node:fs";
import path from "node:path";
import { bytes, empty, file, json, type Router } from "../http/router.ts";
import { type Ctx, validateDeviceId, preview, CAPTURE_RATE_MAX, UPLOAD_RATE_MAX } from "../ctx.ts";
import { TOUCH_KIND_DESC, touchPhrases } from "../shortcut/touch.ts";
import { HB_SILENT_SECS } from "../heartbeat.ts";
import { testTone } from "../util/wav.ts";
import { now, sleep, strftime } from "../util/time.ts";
import { VERSION } from "../cli.ts";

const unauthorized = () => json({ error: "invalid or missing X-Api-Token" }, 401);
const RESET_CAUSES: Record<number, string> = { 1: "上电/复位键", 2: "硬复位", 3: "看门狗复位⚠️", 4: "深睡唤醒", 5: "软复位" };

export function registerDevice(r: Router, ctx: Ctx) {
  // ── 推送 ──
  r.post("/push", async (req) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const data = req.json();
    if (!data || !data.text) return json({ error: "text is required" }, 400);
    const dev = validateDeviceId(data.device_id ?? "cores3");
    if (!ctx.mqtt.ok) return json({ error: "MQTT 不可用，推送功能已禁用" }, 503);
    try {
      if (!(await ctx.sendPush(String(data.text), dev))) return json({ error: "TTS 生成失败" }, 500);
      return json({ status: "ok", device_id: dev });
    } catch (e: any) {
      console.log(`[push] ⚠️  错误: ${e.message}`);
      return json({ error: String(e.message || e) }, 500);
    }
  });

  /** 设备下载推送音频，下载后自动删除 */
  r.get("/push-audio/<filename>", (req) => {
    const name = req.params.filename;
    // 还在边合成的：边写边给
    const live = ctx.livePush.take(name);
    if (live) {
      console.log(`[push] ← ${req.header("x-device-id") || req.raw.socket.remoteAddress || "设备"} 来取 ${name}（通知后 ${((Date.now() - live.created) / 1000).toFixed(1)}s，已合成 ${live.chunks.length} 句${live.done ? "、全部完成" : ""}）`);
      return { status: 200, headers: {}, body: "", raw: (res) => live.pipe(res) };
    }
    const p = path.join(ctx.dirs.pushAudio, name);
    if (name.includes("/") || name.includes("\\") || name.startsWith(".") || !fs.existsSync(p)) return empty(404);
    const res = file(p, "audio/wav");
    res.after = () => { try { fs.unlinkSync(p); } catch { /* 已删 */ } };
    return res;
  });

  // ── 远程拍照 ──
  r.post("/capture-request", (req) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const dev = validateDeviceId((req.json() ?? {}).device_id ?? "cores3");
    if (!ctx.state.checkRate(dev, "capture", CAPTURE_RATE_MAX)) return json({ error: "拍照过于频繁，请稍后再试" }, 429);
    if (!ctx.mqtt.ok) return json({ error: "MQTT 不可用" }, 503);
    return json({ request_id: ctx.issueCapture(dev), status: "queued" });
  });

  r.post("/upload-photo", (req) => {
    const data = req.json();
    if (!data || !("request_id" in data)) return json({ error: "missing request_id" }, 400);
    const rid = String(data.request_id);
    const dev = validateDeviceId(data.device_id ?? "cores3");
    if (!ctx.state.checkRate(dev, "upload", UPLOAD_RATE_MAX)) return json({ error: "上传过于频繁，请稍后再试" }, 429);
    if (!ctx.state.photoResults.has(rid)) return json({ error: "unknown request_id" }, 404);
    const img = data.image ? ctx.decodeImageB64(String(data.image), dev, "upload") : null;
    if (img) {
      ctx.state.photoResults.set(rid, { status: "done", image_path: img, _ts: now() });
      console.log(`[upload] ✅  ${rid} 照片已保存: ${img}`);
    } else {
      ctx.state.photoResults.set(rid, { status: "error", error: "no valid image", _ts: now() });
      console.log(`[upload] ⚠️  ${rid} 无有效图片`);
    }
    return json({ status: "ok", request_id: rid });
  });

  /** 轮询拍照结果：pending→202, done→200, 未知→404。image_path 字段 cores3-camera skill 依赖，只能加字段不能改 */
  r.get("/capture-result/<request_id>", (req) => {
    const rid = req.params.request_id;
    const res = ctx.state.photoResults.get(rid);
    if (!res) return json({ error: "unknown request_id" }, 404);
    if (res.status === "pending") return json({ status: "pending" }, 202);
    if (res.status === "error") return json(res, 500);
    return json({ ...res, image_url: `/photo/${rid}` }, 200);
  });

  r.get("/photo/<request_id>", (req) => {
    if (!ctx.tokenOk(req)) return unauthorized();
    const res = ctx.state.photoResults.get(req.params.request_id);
    if (!res || res.status !== "done") return json({ error: "no photo for this request_id" }, 404);
    if (!res.image_path || !fs.existsSync(res.image_path)) return json({ error: "photo file已过期" }, 404);
    return file(res.image_path, "image/jpeg");
  });

  // ── 在家状态（BLE）──
  r.post("/presence", (req) => {
    const data = req.json();
    if (!data || !("status" in data)) return json({ error: "status is required" }, 400);
    const dev = validateDeviceId(data.device_id ?? "cores3");
    const status = data.status;
    if (status !== "home" && status !== "away") return json({ error: "status must be 'home' or 'away'" }, 400);
    // 写 OpenClaw workspace 状态文件供 OpenClaw agent 读取；内置 agent 每轮直接带上 ctx.presence
    ctx.setPresence(status, dev);
    return json({ status: "ok" });
  });

  // ── 心跳 / 诊断 ──
  r.post("/heartbeat", (req) => {
    const data = req.json();
    const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    const dev = validateDeviceId(d.device_id ?? "cores3");
    const logs = Array.isArray(d.logs) ? d.logs : [];
    delete d.logs;
    ctx.hb.beat(dev, d, logs);
    ctx.noteDevice(dev, req.remoteAddr);
    return json({ status: "ok" });
  });

  r.get("/device-status", () => {
    const t = now();
    const out: Record<string, any> = {};
    for (const [dev, rec] of ctx.hb.devices) {
      let tail: string[] = [];
      const f = ctx.hb.logFile(dev);
      if (fs.existsSync(f)) {
        const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
        if (lines.at(-1) === "") lines.pop();         // 同 Python splitlines()：末尾换行不算一行
        tail = lines.slice(-20);
      }
      out[dev] = { last_seen_secs_ago: Math.trunc(t - rec.ts), online: t - rec.ts < HB_SILENT_SECS, last_heartbeat: rec.data, recent_logs: tail };
    }
    return json(Object.keys(out).length ? out : { info: "尚未收到任何设备心跳" });
  });

  /** 设备开机上报：每次重启后调用一次，log 非空时为上次崩溃的堆栈 */
  r.post("/crash-report", (req) => {
    const d = req.json() ?? {};
    const dev = validateDeviceId(d.device_id ?? "cores3");
    const log = String(d.log ?? "").slice(0, 65536);
    // 注意 MicroPython 的口径：brownout 会被归进 1，panic 会被归进 5，别照字面下结论
    const cause = RESET_CAUSES[d.reset_cause] ?? `未知(${d.reset_cause ?? "None"})`;
    const ts = strftime("%Y-%m-%d %H:%M:%S");
    try { ctx.hb.appendLog(dev, [`[${ts}] BOOT reset_cause=${cause} crashlog=${Array.from(log).length}B`]); }
    catch (e: any) { console.log(`[${dev}] boot log 写入失败: ${e.message}`); }
    if (log) {
      const f = path.join(ctx.dirs.crashReports, `${dev}_${strftime("%Y%m%d_%H%M%S")}.log`);
      fs.writeFileSync(f, log);
      console.log(`[${dev}] 💥 开机上报携带崩溃日志 ${Array.from(log).length} bytes → ${f}（${cause}）`);
    } else console.log(`[${dev}] 🔄 设备重启（无崩溃日志，${cause}）@ ${ts}`);
    return json({ status: "ok" });
  });

  r.get("/time", () => json({ timestamp: Math.trunc(now()) }));
  // app/version：再启动一个 Kagura 时靠它认出「已经在运行的是 Kagura 自己」（旧 voice_server.py 只回 status）
  r.get("/health", () => json({ status: "ok", app: "kagura", version: VERSION, pid: process.pid }));
  r.get("/test-tone", () => bytes(testTone(), "audio/wav"));

  /** 试听设备最近一次上传的录音。浏览器直接打开没法带请求头，所以 token 也可以走 ?token= */
  r.get("/debug-audio/<device_id>", (req) => {
    if (ctx.cfg.apiToken && req.query.get("token") !== ctx.cfg.apiToken && !ctx.tokenOk(req)) return json({ error: "invalid or missing token" }, 401);
    const p = path.join(ctx.dirs.debugAudio, `${validateDeviceId(req.params.device_id)}_last.wav`);
    if (!fs.existsSync(p)) return json({ error: "no audio yet" }, 404);
    return file(p, "audio/wav", { "Cache-Control": "no-cache" });
  });

  // ── 摇一摇 / 触摸：立即返回，后台问大脑 ──
  // OpenClaw：agent 自己用 cores3-speak 推送语音；内置 agent：回复由服务端推送播报（spoken）
  const pi = () => ctx.brain.kind === "pi";
  const background = (dev: string, label: string, prompt: string, localTime: string, trusted: boolean) => {
    const [role, sid] = ctx.roleCtx(dev);
    (async () => {
      for (const attempt of [1, 2]) {   // CLI 偶发瞬态失败（升级迁移、gateway 忙等），重试一次
        try {
          const reply = await ctx.brain.chat({ message: prompt, sessionId: sid, localTime, agent: role.agent, deviceId: dev, spoken: pi(), trusted });
          console.log(`[${dev}] ${label} → ${preview(reply)}`);
          if (pi() && reply && !/^(NO_REPLY|HEARTBEAT_OK)$/.test(reply.trim())) await ctx.sendPush(reply, dev);
          return;
        } catch (e: any) {
          console.log(`[${dev}] ⚠️  ${label} 错误(第${attempt}次): ${e.message}`);
          if (attempt === 1) await sleep(3000);
        }
      }
    })();
  };
  const SPEAK_REQ_OC = (what: string) => `你必须用 cores3-speak skill 把${what}说出来，这是硬性要求：纯文字她根本听不到。`;

  r.get("/shake", (req) => {
    const dev = validateDeviceId(req.header("X-Device-Id"));
    if (!ctx.state.checkRate(dev)) return json({ error: "请求过于频繁，请稍后再试" }, 429);
    ctx.deviceHere(dev);
    const prompt = pi()
      ? "[设备事件] 主人摇了摇你——她现在就在你面前的设备旁。跟她随便聊几句（你的回复会直接播出来）。"
      : "用户摇了摇你——她现在就在你面前的 Cores3 设备旁。"
        + "你必须用 cores3-speak skill 把语音说出来，跟她随便聊几句。"
        + "这是硬性要求：收到摇一摇必须用 Cores3 语音回复，"
        + "不要只回文字（纯文字她根本听不到）。";
    background(dev, "🫨  shake", prompt, req.header("X-Local-Time"), ctx.deviceTrusted(req, dev));
    return json({ status: "ok" });
  });

  /** 触觉惊动层。设备端已做冷却与显著性筛选——不要在这里放宽，每次触摸都惊动大脑会变成话痨，而且很贵 */
  r.get("/touch", (req) => {
    const dev = validateDeviceId(req.header("X-Device-Id"));
    if (!ctx.state.checkRate(dev)) return json({ error: "请求过于频繁，请稍后再试" }, 429);
    ctx.deviceHere(dev);
    const kind = req.header("X-Touch-Kind");
    const desc = TOUCH_KIND_DESC[kind];
    if (!desc) return json({ error: "unknown touch kind" }, 400);
    const detail = touchPhrases(req.header("X-Touch-Detail"));
    const extra = detail.length ? "（" + detail.join("；") + "）" : "";
    const body = `${desc}${extra}。她现在就在你面前的 CoreS3 设备旁。`
      + "这是身体接触，不是提问——用一句话回应被碰到的感觉就好，别开启新话题，"
      + "也别追问她想干什么。";
    background(dev, `🖐️  touch/${kind}`, pi() ? `[设备事件] ${body}（你的回复会直接播出来）` : body + SPEAK_REQ_OC("话"), req.header("X-Local-Time"), ctx.deviceTrusted(req, dev));
    return json({ status: "ok" });
  });
}
