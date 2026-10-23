// 应用上下文：各路由共用的状态与流程（推送、拍照、快照留档、识别播报……）。
// 对应 voice_server.py 里不属于某一个路由的那些函数。
import fs from "node:fs";
import path from "node:path";
import type { Config, Dirs } from "./config.ts";
import type { Req } from "./http/router.ts";
import type { Voice } from "./voice/types.ts";
import type { Brain } from "./brain/types.ts";
import type { MqttHub } from "./mqtt.ts";
import type { StreamHub } from "./stream.ts";
import { STALE_AFTER } from "./stream.ts";
import { ServerState } from "./state.ts";
import { Roles, type Role } from "./roles.ts";
import { Heartbeats } from "./heartbeat.ts";
import { Reminders } from "./jobs/reminders.ts";
import { PhotoSchedules, type Schedule } from "./jobs/photoSchedules.ts";
import { pruneDir } from "./voice/baidu.ts";
import { rgb565ToJpeg, isJpeg, b64decodeLoose } from "./util/image.ts";
import { audioStats } from "./util/wav.ts";
import { now, sleep, strftime } from "./util/time.ts";
import { hex, pyHead, pyLen } from "./util/text.ts";

export const MAX_IMAGE_B64_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const IP_RATE_MAX = 60;
export const CAPTURE_RATE_MAX = 30;
export const UPLOAD_RATE_MAX = 30;
export const PUSH_AUDIO_MAX_FILES = 50;
export const SNAPSHOT_MAX = 60;
export const PHOTO_TTL = 300;
export const DEVICE_CHAT_TIMEOUT = 60;
export const STREAM_RENEW_SECS = 45;
export const STREAM_POLL_WAIT = 3.0;

export const ASR_EMPTY_REPLY = "没听清，能再说一遍吗？";
export const CONT_EXIT_REPLY = "好的，有事再叫我。";
export const PHOTO_ONLY_PROMPT = "我用 CoreS3 摄像头拍了一张照片给你看，看看这是什么吧";
export const DEFAULT_PHOTO_PROMPT = "看看这张照片，跟我说说吧。";
// 播报由服务端负责，必须拦住 agent 自己再调 cores3-speak，否则设备会念两遍
export const SPEAK_HINT = "\n\n[你的文字回复会由服务端合成语音播报出来。请只回复要说的那句话本身，不要调用 cores3-speak skill，不要加任何前后缀。]";
export const SNAPSHOT_NAME_RE = /^[0-9]{8}_[0-9]{6}_[0-9a-f]{4}$/;
const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;

export const validateDeviceId = (raw: unknown) => (typeof raw === "string" && DEVICE_ID_RE.test(raw) ? raw : "default");
export const preview = (t: string) => pyHead(t, 80).replace(/\n/g, " ") + (pyLen(t) > 80 ? "..." : "");

export class Ctx {
  state = new ServerState();
  roles: Roles;
  hb: Heartbeats;
  reminders: Reminders;
  schedules: PhotoSchedules;

  constructor(
    public cfg: Config, public dirs: Dirs, public voice: Voice, public brain: Brain,
    public mqtt: MqttHub, public stream: StreamHub,
  ) {
    this.roles = new Roles(cfg.roles, dirs.rolesFile);
    this.hb = new Heartbeats(dirs.deviceLogs);
    this.reminders = new Reminders(dirs.remindersFile);
    this.schedules = new PhotoSchedules(dirs.schedulesFile);
  }

  /** API_TOKEN 未设置时永远放行；设置后校验 X-Api-Token 头 */
  tokenOk(req: Req) { return !this.cfg.apiToken || req.header("X-Api-Token") === this.cfg.apiToken; }

  /** 来源 IP 兜底桶：防 device_id 换名刷请求 */
  ipRateOk(req: Req) { return this.state.checkRate(req.remoteAddr, "ip", IP_RATE_MAX); }

  /** 设备当前角色 + 该角色的会话。所有调大脑的地方都走这里 */
  roleCtx(dev: string): [Role, string] {
    const role = this.roles.get(dev);
    return [role, this.state.getSession(this.roles.sessionKey(dev, role))];
  }

  // ── 推送 ──

  /** TTS 合成 → 存盘 → MQTT 通知设备下载播放 */
  async sendPush(text: string, dev: string): Promise<boolean> {
    if (!this.mqtt.ok) return false;
    const wav = await this.voice.synthesize(text, this.roles.get(dev).per);   // 用设备当前角色的音色
    if (!wav) return false;
    const fname = `${hex(8)}.wav`;
    fs.copyFileSync(wav, path.join(this.dirs.pushAudio, fname));
    pruneDir(this.dirs.pushAudio, PUSH_AUDIO_MAX_FILES);
    this.mqtt.publish(`kagura/push/${dev}`, { type: "push", url: `/push-audio/${fname}` });
    console.log(`[push] → ${dev} via MQTT notify: ${pyHead(text, 50)}${pyLen(text) > 50 ? "..." : ""}`);
    return true;
  }

  // ── 录音留档 ──

  keepDebugAudio(dev: string, wav: Buffer) {
    try {
      const st = audioStats(wav);
      if (st) console.log(`[${dev}] 🎙️  ${st.dur}s rms=${st.rms} peak=${st.peak} clip=${st.clip_pct}% dc=${st.dc}`);
      fs.writeFileSync(path.join(this.dirs.debugAudio, `${dev}_last.wav`), wav);
    } catch (e: any) {
      console.log(`[${dev}] debug audio 保存失败: ${e.message}`);
    }
  }

  // ── 图片 ──

  /** 解码 base64 图片（RGB565 或 JPEG），保存为 JPEG，返回路径。失败返回 null */
  decodeImageB64(b64: string, dev = "unknown", tag = ""): string | null {
    if (b64.length > MAX_IMAGE_B64_BYTES) { console.log(`[${tag}] ${dev} image base64 过大: ${b64.length} bytes，拒绝`); return null; }
    const raw = b64decodeLoose(b64);
    if (!raw) { console.log(`[${tag}] ${dev} base64 解码失败`); return null; }
    const p = path.join(this.dirs.visionTmp, `oc_vision_${hex(8)}.jpg`);
    const jpg = rgb565ToJpeg(raw);
    if (jpg) { fs.writeFileSync(p, jpg); console.log(`[${tag}] ${dev} RGB565→JPEG: ${jpg.length} bytes`); return p; }
    if (isJpeg(raw)) { fs.writeFileSync(p, raw); console.log(`[${tag}] ${dev} JPEG direct: ${raw.length} bytes`); return p; }
    console.log(`[${tag}] ${dev} unknown image format size=${raw.length}, skipping`);
    return null;
  }

  // ── 拍照 ──

  /** 清理超过 5 分钟的拍照记录，同时删除对应磁盘文件 */
  cleanupPhotoResults() {
    const t = now();
    for (const [k, v] of this.state.photoResults) {
      if (t - (v._ts ?? 0) > PHOTO_TTL) {
        this.state.photoResults.delete(k);
        if (v.image_path) { try { fs.unlinkSync(v.image_path); } catch { /* 已删 */ } }
      }
    }
  }

  /** 登记一条 pending 记录并通过 MQTT 下发拍照命令，返回 request_id。调用方需先确认 MQTT 可用 */
  issueCapture(dev: string): string {
    const rid = crypto.randomUUID().slice(0, 8);
    this.cleanupPhotoResults();
    this.state.photoResults.set(rid, { status: "pending", _ts: now() });
    this.mqtt.publish(`kagura/cmd/${dev}`, { action: "capture", request_id: rid });
    console.log(`[capture] 📷  MQTT 拍照命令 ${rid} → ${dev}`);
    return rid;
  }

  /** 直播中抓拍：取服务端最新一帧，瞬时但只有 160×120。没有活跃直播返回 null */
  captureFromStream(dev: string): string | null {
    const rec = this.stream.latest(dev);
    if (!rec?.jpeg || now() - rec.ts > STALE_AFTER) return null;
    const p = path.join(this.dirs.visionTmp, `oc_vision_${hex(8)}.jpg`);
    try { fs.writeFileSync(p, rec.jpeg); } catch (e: any) { console.log(`[capture] ⚠️  直播抓拍写盘失败: ${e.message}`); return null; }
    const rid = crypto.randomUUID().slice(0, 8);
    this.cleanupPhotoResults();
    this.state.photoResults.set(rid, { status: "done", image_path: p, _ts: now() });
    console.log(`[capture] 📸  ${dev} 直播抓拍 ${rid}（第 ${rec.seq} 帧）`);
    return rid;
  }

  /** 下发拍照命令并等设备上传，返回 [image_path, error]。只给后台任务用，HTTP 路由走 issueCapture + 轮询 */
  async captureAndWait(dev: string, timeout = 45): Promise<[string | null, string | null]> {
    if (!this.mqtt.ok) return [null, "MQTT 不可用，无法下发拍照命令"];
    const rid = this.issueCapture(dev);
    const deadline = now() + timeout;
    while (now() < deadline) {
      await sleep(500);
      const rec = this.state.photoResults.get(rid);
      if (!rec) return [null, "拍照记录已被清理"];
      if (rec.status === "done") return [rec.image_path ?? null, null];
      if (rec.status === "error") return [null, rec.error ?? "设备拍照失败"];
    }
    return [null, `等待设备上传超时（${timeout}s），设备可能离线或摄像头不可用`];
  }

  // ── 快照留档 ──

  private pruneSnapshots() {
    const metas = fs.readdirSync(this.dirs.snapshots).filter((f) => f.endsWith(".json")).sort().reverse();
    for (const m of metas.slice(SNAPSHOT_MAX)) {
      for (const f of [m, m.replace(/\.json$/, ".jpg")]) { try { fs.unlinkSync(path.join(this.dirs.snapshots, f)); } catch { /* 无 */ } }
    }
  }

  saveSnapshot(imagePath: string | null, meta: Record<string, any>): string | null {
    const ts = meta.ts ?? now();
    const name = `${strftime("%Y%m%d_%H%M%S", new Date(ts * 1000))}_${hex(4)}`;
    try {
      if (imagePath && fs.existsSync(imagePath)) fs.copyFileSync(imagePath, path.join(this.dirs.snapshots, `${name}.jpg`));
      fs.writeFileSync(path.join(this.dirs.snapshots, `${name}.json`), JSON.stringify(meta), "utf8");
    } catch (e: any) {
      console.log(`[snapshot] 留档失败: ${e.message}`);
      return null;
    }
    this.pruneSnapshots();
    return name;
  }

  listSnapshots(limit = 30) {
    const out: any[] = [];
    for (const f of fs.readdirSync(this.dirs.snapshots).filter((x) => x.endsWith(".json")).sort().reverse().slice(0, limit)) {
      let meta: any;
      try { meta = JSON.parse(fs.readFileSync(path.join(this.dirs.snapshots, f), "utf8")); } catch { continue; }
      const name = f.replace(/\.json$/, "");
      out.push({ ...meta, name, has_image: fs.existsSync(path.join(this.dirs.snapshots, `${name}.jpg`)), image_url: `/snapshot/${name}` });
    }
    return out;
  }

  // ── 识别 + 播报 ──

  /** 识别一张照片 → 留档 → 语音播报。识别失败也照样留档 */
  async describeAndSpeak(imagePath: string, dev: string, prompt: string, label = "", started = now()) {
    const result: Record<string, any> = { ts: started, ok: false, error: null, reply: "", snapshot: null, spoken: false, device_id: dev };
    try {
      const [role, sid] = this.roleCtx(dev);
      const reply = await this.brain.chat({ message: prompt + SPEAK_HINT, sessionId: sid, imagePath, localTime: strftime("%Y-%m-%d %H:%M"), agent: role.agent });
      console.log(`[snapshot] 👁  ${label || "手动"} 识别: ${preview(reply)}`);
      result.reply = reply;
      result.ok = true;
    } catch (e: any) {
      console.log(`[snapshot] ⚠️  识别失败: ${e.message}`);
      result.error = String(e.message || e);
    }
    result.snapshot = this.saveSnapshot(imagePath, { ts: started, device_id: dev, time: label, prompt, reply: result.reply, error: result.error });
    if (result.reply) {
      try { result.spoken = await this.sendPush(result.reply, dev); }
      catch (e: any) { console.log(`[snapshot] ⚠️  播报失败: ${e.message}`); result.error ||= `播报失败: ${e.message}`; }
    }
    return result;
  }

  /** 定时计划的执行体：拍照 → 识别 → 留档 → 播报 */
  async runScheduledCapture(s: Schedule) {
    const dev = validateDeviceId(s.device_id ?? "cores3");
    const prompt = s.prompt || DEFAULT_PHOTO_PROMPT;
    const label = s.time ?? "?";
    const started = now();
    const [img, err] = await this.captureAndWait(dev);
    if (err) {
      console.log(`[snapshot] ⚠️  ${label} 拍照失败: ${err}`);
      return {
        ts: started, ok: false, error: err, reply: "", spoken: false, device_id: dev,
        snapshot: this.saveSnapshot(null, { ts: started, device_id: dev, time: label, prompt, reply: "", error: err }),
      };
    }
    return this.describeAndSpeak(img!, dev, prompt, label, started);
  }

  /** 一行分阶段耗时；超过设备超时就明确告警 */
  logTiming(dev: string, t0: number, tAsr: number, tLlm: number) {
    const t = now(), total = t - t0;
    const warn = total > DEVICE_CHAT_TIMEOUT ? `  ⚠️ 超过设备超时 ${DEVICE_CHAT_TIMEOUT}s，设备收不到这条` : "";
    console.log(`[${dev}] ⏱️  asr=${(tAsr - t0).toFixed(1)}s llm=${(tLlm - tAsr).toFixed(1)}s tts=${(t - tLlm).toFixed(1)}s 总=${total.toFixed(1)}s${warn}`);
  }
}
