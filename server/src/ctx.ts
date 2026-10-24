// 应用上下文：各路由共用的状态与流程（推送、拍照、快照留档、识别播报……）。
// 对应 voice_server.py 里不属于某一个路由的那些函数。
import fs from "node:fs";
import path from "node:path";
import type { Config, Dirs, RoleDef } from "./config.ts";
import { viaProxy, type Req } from "./http/router.ts";
import type { Voice, VoiceRef } from "./voice/types.ts";
import type { Brain } from "./brain/types.ts";
import type { MqttHub } from "./mqtt.ts";
import type { StreamHub } from "./stream.ts";
import { STALE_AFTER } from "./stream.ts";
import { ServerState } from "./state.ts";
import { Roles, roleVoice, type Role } from "./roles.ts";
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

  /** 每台设备最近一轮对话的完整文本（边生成边播时 X-Reply-Text 只有首句，设备播完来取全文） */
  lastReply = new Map<string, { user: string; reply: string; ts: number }>();
  /** 正在进行中的设备对话数（调度器 idleOnly：设备正在对话时延后执行） */
  activeChats = new Map<string, number>();
  /** 最近一次在家状态（BLE 上报），内置 agent 每轮带上 */
  presence: { status: string; ts: string; dev: string } | null = null;
  /** 新版本提醒（main 里建好；没开就是 null） */
  updates: import("./util/update.ts").UpdateChecker | null = null;
  /** 在线更新（下载安装包、校验、安装、重启） */
  selfUpdater: import("./util/selfupdate.ts").SelfUpdater | null = null;
  /** 出口（内置 agent 模式才有）：所有说给主人听的话经它按 voice_push 策略决定播不播、播到哪 */
  outbox: import("./agent/outbox.ts").Outbox | null = null;
  /** 设备换了角色（播留言）。挂在 Ctx 上而不是 Roles 上：改 agent 时角色表会整个重建 */
  onRoleSwitch: ((dev: string) => void) | null = null;
  /** 换一张角色表（改了 agent 之后），钩子跟着挂上 */
  setRoles(r: Roles) {
    this.roles = r;
    r.onSwitch = (dev) => this.onRoleSwitch?.(dev);
  }

  constructor(
    public cfg: Config, public dirs: Dirs, public voice: Voice, public brain: Brain,
    public mqtt: MqttHub, public stream: StreamHub,
    /** 内置 agent 模式下角色表来自 agent 注册表；OpenClaw 模式来自 config.roles */
    roleDefs: RoleDef[] | null = cfg.roles,
  ) {
    this.roles = new Roles(roleDefs, dirs.rolesFile);
    this.roles.onSwitch = (dev) => this.onRoleSwitch?.(dev);
    this.hb = new Heartbeats(dirs.deviceLogs);
    this.reminders = new Reminders(dirs.remindersFile);
    this.schedules = new PhotoSchedules(dirs.schedulesFile);
  }

  /** 手机 / 平板客户端（配对令牌 + SSE 推送），main 里建好 */
  clients: import("./clients.ts").Clients | null = null;

  /** API_TOKEN 未设置时永远放行；设置后校验 X-Api-Token 头。配对过的手机凭令牌也放行（看家页要用监控接口） */
  tokenOk(req: Req) {
    return !this.cfg.apiToken || req.header("X-Api-Token") === this.cfg.apiToken || !!this.clients?.fromReq(req);
  }

  /** 来源 IP 兜底桶：防 device_id 换名刷请求 */
  ipRateOk(req: Req) { return this.state.checkRate(req.remoteAddr, "ip", IP_RATE_MAX); }

  /** 设备当前角色 + 该角色的会话。所有调大脑的地方都走这里 */
  roleCtx(dev: string): [Role, string] {
    const role = this.roles.get(dev);
    return [role, this.state.getSession(this.roles.sessionKey(dev, role))];
  }

  // ── 推送 ──

  /**
   * TTS 合成 → 存盘 → MQTT 通知设备下载播放。
   * agentId：说话的 agent。它对应某个角色时，用那个角色的音色，并在通知里带上 role——
   * 设备当前不是这个角色就在播放期间临时换成它的图（一台设备多个角色共用）。不传 = 设备当前角色。
   */
  async sendPush(text: string, dev: string, agentId?: string | null): Promise<boolean> {
    if (!this.mqtt.ok) return false;
    const cur = this.roles.get(dev);
    const role = agentId ? (cur.agent === agentId ? cur : this.roles.all().find((r) => r.agent === agentId)) : cur;
    const wav = await this.voice.synthesize(text, role ? roleVoice(role) : this.agentVoice?.(agentId!) ?? roleVoice(cur));
    if (!wav) return false;
    const fname = `${hex(8)}.wav`;
    fs.copyFileSync(wav, path.join(this.dirs.pushAudio, fname));
    pruneDir(this.dirs.pushAudio, PUSH_AUDIO_MAX_FILES);
    // 手机页面要把这句话显示出来；CoreS3 不需要，MQTT 包保持原样
    const isPhone = !!this.clients?.list().some((c) => c.id === dev);
    this.mqtt.publish(`kagura/push/${dev}`, { type: "push", url: `/push-audio/${fname}`, ...(role ? { role: role.id } : {}), ...(isPhone ? { text } : {}) });
    const tag = role && role.id !== cur.id ? `（${role.name}）` : "";
    console.log(`[push] → ${dev}${tag} via MQTT notify: ${pyHead(text, 50)}${pyLen(text) > 50 ? "..." : ""}`);
    return true;
  }

  /** 不对应任何角色的 agent 的声音（agent 系统挂上） */
  agentVoice: ((agentId: string) => VoiceRef | undefined) | null = null;

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
      // OpenClaw 要靠提示词拦住 cores3-speak；内置 agent 知道这轮回复会被播报（spoken），不需要
      const hint = this.brain.kind === "pi" ? "" : SPEAK_HINT;
      const reply = await this.brain.chat({ message: prompt + hint, sessionId: sid, imagePath, localTime: strftime("%Y-%m-%d %H:%M"), agent: role.agent, deviceId: dev, spoken: true });
      console.log(`[snapshot] 👁  ${label || "手动"} 识别: ${preview(reply)}`);
      result.reply = reply;
      result.ok = true;
    } catch (e: any) {
      console.log(`[snapshot] ⚠️  识别失败: ${e.message}`);
      result.error = String(e.message || e);
    }
    result.snapshot = this.saveSnapshot(imagePath, { ts: started, device_id: dev, time: label, prompt, reply: result.reply, error: result.error });
    if (result.reply) {
      // 内置 agent 走出口（按语音推送策略）；OpenClaw 模式直接推
      try { result.spoken = this.outbox ? (await this.outbox.say({ text: result.reply, agentId: null, device: dev, source: "snapshot" })).played : await this.sendPush(result.reply, dev); }
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

  /** 包住一次设备对话：期间 activeChats 计数 +1 */
  async inChat<T>(dev: string, fn: () => Promise<T>): Promise<T> {
    this.activeChats.set(dev, (this.activeChats.get(dev) ?? 0) + 1);
    try { return await fn(); }
    finally {
      const n = (this.activeChats.get(dev) ?? 1) - 1;
      if (n > 0) this.activeChats.set(dev, n); else this.activeChats.delete(dev);
    }
  }

  /** 主人在设备上做了操作（说话、摇一摇、触摸、按 ROLE 键）：人肯定在家，在家状态不是 home 就改过来 */
  deviceHere(dev: string) {
    if (this.presence?.status !== "home") this.setPresence("home", dev, "device");
  }

  /**
   * 更新在家状态并落盘（设备 BLE 上报 /presence、主人在聊天里说「我到家了」都走这里）。
   * 写两个文件：user_presence.txt / mio-home-status.json 是 OpenClaw 那边的 skill 读的，重启时也从这里恢复
   */
  setPresence(status: "home" | "away", dev: string, source = "ble") {
    const ts = strftime("%Y-%m-%dT%H:%M:%S+08:00");
    const tmp = this.dirs.visionTmp;
    try {
      fs.writeFileSync(path.join(tmp, "user_presence.txt"), `${status}\n${ts}\n${dev}\n`);
      fs.writeFileSync(path.join(tmp, "mio-home-status.json"), JSON.stringify({
        at_home: status === "home", last_updated: ts, last_action: `${source}_${status === "home" ? "detected_home" : "detected_away"}`,
      }));
    } catch (e: any) { console.log(`[presence] 写状态文件失败: ${e.message}`); }
    this.presence = { status, ts, dev };
    console.log(`[presence] ${dev} → ${status} @ ${ts}${source === "ble" ? "" : `（${source}）`}`);
  }

  /** 重启后恢复上次的在家状态（设备 BLE 只在状态变化时上报，不恢复的话一重启就成了「不知道」） */
  loadPresence() {
    try {
      const f = path.join(this.dirs.visionTmp, "mio-home-status.json");
      if (!fs.existsSync(f)) return;
      const saved = JSON.parse(fs.readFileSync(f, "utf8"));
      if (typeof saved?.at_home !== "boolean") return;
      let dev = "cores3";
      try { dev = fs.readFileSync(path.join(this.dirs.visionTmp, "user_presence.txt"), "utf8").split("\n")[2]?.trim() || dev; } catch { /* 没有就用默认 */ }
      this.presence = { status: saved.at_home ? "home" : "away", ts: String(saved.last_updated ?? ""), dev };
      console.log(`[presence] 恢复上次状态：${this.presence.status}（${this.presence.ts}）`);
    } catch (e: any) {
      console.log(`[presence] ⚠️  恢复状态失败: ${e.message}`);
    }
  }

  // ── 受信设备 ──
  // 设备上行接口（/chat 等）不带口令（固件不支持），同一 WiFi 下谁都能冒充设备说话。设备对话又是可信的
  // （能让 agent 执行命令、装扩展），所以：第一台发心跳的设备自动受信，之后新设备要在管理界面批准；
  // 请求还必须从这台设备心跳的 IP 发来。不受信的照样能聊天，只是拿不到高风险工具。
  private trustFile() { return path.join(this.cfg.dataDir, "trusted_devices.json"); }
  trust: Record<string, { trusted: boolean; ip: string; first: number; last: number }> = {};
  loadTrust() { try { this.trust = JSON.parse(fs.readFileSync(this.trustFile(), "utf8")); } catch { this.trust = {}; } }
  private saveTrust() { try { fs.writeFileSync(this.trustFile(), JSON.stringify(this.trust, null, 2)); } catch (e: any) { console.log(`[trust] 保存失败：${e.message}`); } }
  static normIp(ip: string) { return ip.replace(/^::ffff:/, ""); }

  /** 心跳时调：记下设备的 IP；第一台设备自动受信 */
  noteDevice(dev: string, remote: string) {
    const ip = Ctx.normIp(remote), t = now();
    const rec = this.trust[dev];
    if (!rec) {
      const first = !Object.values(this.trust).some((r) => r.trusted);
      this.trust[dev] = { trusted: first, ip, first: t, last: t };
      console.log(first ? `[trust] 🔐 ${dev}（${ip}）是第一台设备，自动设为受信` : `[trust] 🔐 新设备 ${dev}（${ip}）：在管理界面「设备」里批准后才能用执行命令等高风险功能`);
      this.saveTrust();
      return;
    }
    if (rec.ip !== ip) {
      // IP 变了（DHCP 换地址、重新联网）：原 IP 已经十分钟没心跳才跟着换，防止别人冒充它的 id 把绑定抢走
      if (t - rec.last < 600) { console.log(`[trust] ⚠️  ${dev} 的心跳从新地址 ${ip} 发来，但原地址 ${rec.ip} 还在活动，不更新`); return; }
      console.log(`[trust] ${dev} 的地址变了：${rec.ip} → ${ip}`);
      rec.ip = ip;
      rec.last = t;
      this.saveTrust();
      return;
    }
    rec.last = t;
  }

  setDeviceTrusted(dev: string, trusted: boolean) {
    const rec = this.trust[dev];
    if (!rec) throw Object.assign(new Error(`没见过设备 ${dev}（等它发过心跳再批准）`), { status: 404 });
    rec.trusted = trusted;
    this.saveTrust();
    console.log(`[trust] ${dev} → ${trusted ? "受信" : "不受信"}`);
  }

  /** 这个请求能不能当作受信设备：批准过、从它心跳的 IP 来、不是浏览器跨站发来的。本机进程发的算可信 */
  deviceTrusted(req: Req, dev: string): boolean {
    if (this.cfg.deviceTrust === "all") return true;
    // 配对过的手机：令牌对得上、且就是以它自己的 id 说话（不能拿手机的令牌冒充 CoreS3）。它是浏览器，所以放在 Origin 判据之前
    const c = this.clients?.fromReq(req);
    if (c) return c.id === dev;
    if (req.hasHeader("Origin") || req.hasHeader("Sec-Fetch-Site")) return false;   // 设备不会带这两个头，浏览器才会
    const ip = Ctx.normIp(req.remoteAddr);
    // 本机来的算受信——经本机反向代理转进来的不算（来源也是 127.0.0.1，人却在外面）
    if ((ip === "127.0.0.1" || ip === "::1") && !viaProxy(req)) return true;
    const rec = this.trust[dev];
    return !!rec?.trusted && rec.ip === ip;
  }

  presenceText(): string {
    if (!this.presence) return "";
    return `${this.presence.status === "home" ? "在家" : "不在家"}（${this.presence.ts.slice(5, 16).replace("T", " ")} 起）`;
  }

  /** 一行分阶段耗时；超过设备超时就明确告警 */
  logTiming(dev: string, t0: number, tAsr: number, tLlm: number) {
    const t = now(), total = t - t0;
    const warn = total > DEVICE_CHAT_TIMEOUT ? `  ⚠️ 超过设备超时 ${DEVICE_CHAT_TIMEOUT}s，设备收不到这条` : "";
    console.log(`[${dev}] ⏱️  asr=${(tAsr - t0).toFixed(1)}s llm=${(tLlm - tAsr).toFixed(1)}s tts=${(t - tLlm).toFixed(1)}s 总=${total.toFixed(1)}s${warn}`);
  }
}
