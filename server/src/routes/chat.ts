// 对话路由：/chat、/chat-vision、/role/cycle（设备上行，不要 token，靠限流兜底）。
import fs from "node:fs";
import { bytes, json, type Req, type Res, type Router } from "../http/router.ts";
import { roleVoice, type Role } from "../roles.ts";
import { streamReply, type StreamReplyOpts } from "../speech/stream-reply.ts";
import { PendingReplies, type PendingOpts } from "../speech/async-reply.ts";
import {
  type Ctx, validateDeviceId, preview, MAX_AUDIO_BYTES, ASR_EMPTY_REPLY, CONT_EXIT_REPLY, PHOTO_ONLY_PROMPT,
} from "../ctx.ts";
import * as quick from "../shortcut/quick.ts";
import { withTouch } from "../shortcut/touch.ts";
import { b64Header } from "../util/text.ts";
import { b64decodeLoose } from "../util/image.ts";
import { now } from "../util/time.ts";

const tooMany = () => json({ error: "请求过于频繁，请稍后再试" }, 429);

export function registerChat(r: Router, ctx: Ctx) {
  /** 只有内置 agent 能逐字输出；OpenClaw / 假大脑照旧整段返回 */
  const wantsStream = (req: Req) => req.header("X-Stream") === "1" && ctx.brain.kind === "pi";

  const streamed = (dev: string, role: Role, userText: string, headers: Record<string, string>, t0: number, tAsr: number,
    run: StreamReplyOpts["run"]): Res => ({
    status: 200, headers: {}, body: "",
    raw: (res) => streamReply(res, {
      voice: ctx.voice, per: roleVoice(role), userText, headers, run,
      log: (s) => console.log(`[${dev}] ${s}`),
      done: (r) => {
        ctx.hb.seen(dev);
        ctx.lastReply.set(dev, { user: userText, reply: r.reply || (r.error ? "（出错了）" : ""), ts: now() });
        const total = now() - t0;
        console.log(`[${dev}] 💬  ${preview(r.reply)}`);
        console.log(`[${dev}] ⏱️  asr=${(tAsr - t0).toFixed(1)}s 首声=${r.firstAudioMs === null ? "—" : ((tAsr - t0) + r.firstAudioMs / 1000).toFixed(1) + "s"} 总=${total.toFixed(1)}s ${r.sentences} 句（边生成边播）${r.error ? `  ⚠️ ${r.error}` : ""}`);
      },
    }),
  });

  /**
   * 异步对话：设备带 X-Async: 1（且能边下边播，X-Stream: 1）时，走大脑的请求立刻回 202 + 回复编号，
   * 设备用 GET /chat/reply/<id> 长轮询分段取回复（见 speech/async-reply.ts）。短路命中的照旧直接回 WAV。
   */
  const replies = new PendingReplies();
  // 只对内置 agent：OpenClaw 用 cores3-speak 回复时会同时推送，异步等待期间设备不再丢推送，会播两遍
  const wantsAsync = (req: Req) => req.header("X-Async") === "1" && req.header("X-Stream") === "1" && ctx.brain.kind === "pi";
  const startAsync = (dev: string, role: Role, userText: string, headers: Record<string, string>, t0: number, tAsr: number,
    run: PendingOpts["run"]): Res => {
    const p = replies.start({
      dev, userText, voice: ctx.voice, per: roleVoice(role), headers, run,
      log: (s) => console.log(`[${dev}] ${s}`),
      done: (r) => {
        ctx.hb.seen(dev);
        ctx.lastReply.set(dev, { user: userText, reply: r.reply || (r.error ? "（出错了）" : ""), ts: now() });
        console.log(`[${dev}] 💬  ${preview(r.reply)}`);
        console.log(`[${dev}] ⏱️  asr=${(tAsr - t0).toFixed(1)}s 总=${(now() - t0).toFixed(1)}s（异步）${r.cancelled ? "  🛑 已取消" : r.error ? `  ⚠️ ${r.error}` : ""}`);
      },
    });
    console.log(`[${dev}] ⏳  异步回复 ${p.id}`);
    return { status: 202, headers: { "Content-Type": "application/json", "X-Reply-Id": p.id, "X-User-Text": b64Header(userText), ...headers }, body: JSON.stringify({ id: p.id }) };
  };

  /** 取异步回复的下一段：?wait=秒（最多 25）。204 + X-Reply-Wait = 还在想；204 + X-Reply-Done = 说完了 */
  r.get("/chat/reply/<id>", (req): Res => {
    const p = replies.get(req.params.id);
    if (!p) return { status: 204, headers: { "X-Reply-Done": "1" }, body: "" };     // 早就取完被清掉了
    ctx.hb.seen(validateDeviceId(req.header("X-Device-Id") || "cores3"));
    const wait = Math.max(0, Number(req.query.get("wait") ?? 20)) * 1000;
    // seg：一段写完后等新句子的毫秒数（只能调小，测试用）
    const seg = Number(req.query.get("seg") ?? 0) || undefined;
    return { status: 200, headers: {}, body: "", raw: (res) => p.serve(res, wait, seg) };
  });
  /** 设备上点屏幕取消正在等的回复 */
  r.post("/chat/cancel/<id>", (req) => json({ cancelled: replies.cancel(req.params.id) }));

  /** 边生成边播时 X-Reply-Text 只有首句：设备播完来取完整文本更新屏幕 */
  r.get("/chat/last", (req) => {
    const dev = validateDeviceId(req.header("X-Device-Id") || req.query.get("device_id"));
    const last = ctx.lastReply.get(dev);
    // *_b64 与响应头 X-User-Text / X-Reply-Text 同口径（设备直接交给 ui._update_chat_text）
    return last ? json({ user: last.user, reply: last.reply, ts: last.ts, user_b64: b64Header(last.user), reply_b64: b64Header(last.reply) }) : json({ error: "还没有对话" }, 404);
  });

  /**
   * 接收 WAV，返回 WAV。请求头：X-Device-Id、X-Local-Time、X-Touch、X-Mode。
   * 短路链：没听清 → 免手退出 → 角色列表/切换 → 提醒 → 音量 → 快捷指令 → 大脑。
   * 大脑回复以 [PHOTO] 开头则带 X-Need-Photo: 1，设备拍照后发 /chat-vision。
   */
  r.post("/chat", async (req) => {
    const dev = validateDeviceId(req.header("X-Device-Id"));
    if (!ctx.state.checkRate(dev) || !ctx.ipRateOk(req)) return tooMany();
    const localTime = req.header("X-Local-Time");
    let [role, sid] = ctx.roleCtx(dev);

    const audio = req.body;
    if (!audio.length) return json({ error: "没有收到音频数据" }, 400);
    if (audio.length > MAX_AUDIO_BYTES) return json({ error: "音频数据过大" }, 413);

    ctx.keepDebugAudio(dev, audio);
    ctx.hb.seen(dev);
    const t0 = now();
    try {
      let userText = await ctx.voice.transcribe(audio);
      const tAsr = now();
      console.log(`[${dev}] 🗣️  ${userText}`);

      let needPhoto = false;
      const extra: Record<string, string> = {};
      let reply: string | null = null;
      let remember = true;          // 短路问答要不要记进 last_quick（没听清/退出/切角色都不记）
      const handsFree = ["continuous", "wake"].includes(req.header("X-Mode"));

      if (userText && handsFree && quick.isFiller(userText)) {
        // 免手模式下「嗯」「啊」多半是环境声被认成了字：当没听清处理
        console.log(`[${dev}] 🙉  [filler] ${userText}`);
        userText = "";
      }
      // 真听到主人说话才算在家（免手模式下的环境声不算）。放在大脑之前：这句话里说「我出门了」，set_presence 会在后面改成不在家
      if (userText) ctx.deviceHere(dev);
      if (!userText) {
        // 识别为空直接回固定句，不问大脑；也不记 last_quick
        reply = ASR_EMPTY_REPLY;
        userText = "（没听清）";
        remember = false;
        extra["X-Asr-Empty"] = "1";
        console.log(`[${dev}] 🙉  [asr-empty] ${reply}`);
      }
      if (reply === null && handsFree && quick.matchContExit(userText)) {
        reply = CONT_EXIT_REPLY;
        remember = false;
        extra["X-Cont-Exit"] = "1";
        console.log(`[${dev}] 👋  [cont-exit] ${userText}`);
      }
      if (reply === null) {
        const listing = ctx.roles.matchList(userText);
        if (listing) { reply = listing; console.log(`[${dev}] 🎭  [role-list]`); }
      }
      if (reply === null) {
        const target = ctx.roles.matchSwitch(userText);
        if (target) {
          remember = false;
          if (target.id === role.id) reply = `我就是${target.name}呀。`;
          else {
            ctx.roles.set(dev, target.id);
            role = target;                    // 下面的 TTS 用新角色的音色
            reply = ctx.roles.greeting(target);
          }
          console.log(`[${dev}] 🎭  [role] → ${target.name} (${target.agent})`);
        }
      }
      const rem = reply === null ? quick.matchReminder(userText, localTime) : null;
      if (rem) {
        const [ts, task, r2] = rem;
        reply = r2;
        ctx.reminders.schedule(ts, task, dev);
        console.log(`[${dev}] ⏰  [reminder] ${reply}`);
      }
      if (reply === null) {
        const vol = quick.matchVolume(userText);
        if (vol) { [extra["X-Volume"], reply] = vol; console.log(`[${dev}] 🔊  [volume] ${vol[0]}`); }
      }
      if (reply === null) {
        const q = quick.match(userText, localTime);
        if (q !== null) { reply = q; console.log(`[${dev}] ⚡  [quick] ${reply}`); }
      }

      if (reply !== null) {
        if (remember) ctx.state.setLastQuick(sid, userText, reply);   // 下次走大脑时作为背景带上
      } else {
        let llmText = userText;
        const prev = ctx.state.popLastQuick(sid);
        if (prev) llmText = `[背景：用户刚才问「${prev[0]}」，快捷指令已回复「${prev[1]}」]\n${userText}`;
        llmText = withTouch(llmText, req.header("X-Touch"));
        if (wantsAsync(req)) {
          return startAsync(dev, role, userText, { ...extra, "X-Role": role.id }, t0, tAsr, (onEvent, meta, signal) =>
            ctx.inChat(dev, () => ctx.brain.chat({ message: llmText, sessionId: sid, localTime, agent: role.agent, deviceId: dev, spoken: true, trusted: ctx.deviceTrusted(req, dev), meta, onEvent, signal })));
        }
        if (wantsStream(req)) {
          // 边生成边播：新固件带 X-Stream: 1，首句合成好就开始出声
          return streamed(dev, role, userText, { ...extra, "X-Role": role.id }, t0, tAsr, (onEvent, meta) =>
            ctx.inChat(dev, () => ctx.brain.chat({ message: llmText, sessionId: sid, localTime, agent: role.agent, deviceId: dev, spoken: true, trusted: ctx.deviceTrusted(req, dev), meta, onEvent })));
        }
        const meta: { needPhoto?: boolean; volume?: string } = {};
        reply = await ctx.inChat(dev, () => ctx.brain.chat({ message: llmText, sessionId: sid, localTime, agent: role.agent, deviceId: dev, spoken: true, trusted: ctx.deviceTrusted(req, dev), meta }));
        if (reply.startsWith("[PHOTO]")) {
          meta.needPhoto = true;
          reply = reply.slice("[PHOTO]".length).trim();
        }
        if (meta.needPhoto) { needPhoto = true; console.log(`[${dev}] 📷  大脑请求拍照，返回 X-Need-Photo: 1`); }
        if (meta.volume) { extra["X-Volume"] = meta.volume; console.log(`[${dev}] 🔊  [volume/tool] ${meta.volume}`); }
      }
      console.log(`[${dev}] 💬  ${preview(reply)}`);

      const tLlm = now();
      const wavOut = await ctx.voice.synthesize(reply, roleVoice(role));
      if (!wavOut) return json({ error: "TTS 生成失败" }, 500);
      ctx.logTiming(dev, t0, tAsr, tLlm);
      ctx.hb.seen(dev);
      const data = fs.readFileSync(wavOut);
      console.log(`[${dev}] 📤  WAV ${data.length} bytes`);
      ctx.lastReply.set(dev, { user: userText, reply, ts: now() });
      const headers: Record<string, string> = { ...extra };
      if (needPhoto) headers["X-Need-Photo"] = "1";
      headers["X-User-Text"] = b64Header(userText);
      headers["X-Reply-Text"] = b64Header(reply);
      headers["X-Role"] = role.id;              // 设备据此换背景图
      return bytes(data, "audio/wav", headers);
    } catch (e: any) {
      console.log(`[${dev}] ⚠️  错误: ${e.message}`);
      return json({ error: String(e.message || e) }, 500);
    }
  });

  /**
   * JSON {wav?, text?, image?}，wav 与 image 至少一个：
   *   wav + image：语音触发拍照的第二段；仅 image：取景模式手动拍照（用默认提问）；
   *   text：无 wav 时作为提问。
   */
  r.post("/chat-vision", async (req) => {
    const dev = validateDeviceId(req.header("X-Device-Id"));
    if (!ctx.state.checkRate(dev) || !ctx.ipRateOk(req)) return tooMany();
    const localTime = req.header("X-Local-Time");
    const [role, sid] = ctx.roleCtx(dev);
    const data = req.json();
    if (!data || typeof data !== "object") return json({ error: "missing json body" }, 400);
    const wavB64: string = data.wav || "";
    const imageB64: string = data.image || "";
    if (!wavB64 && !imageB64) return json({ error: "wav or image is required" }, 400);

    let wav: Buffer | null = null;
    if (wavB64) {
      if (wavB64.length > MAX_AUDIO_BYTES) return json({ error: "WAV 数据过大" }, 413);
      wav = b64decodeLoose(wavB64);
      if (!wav) return json({ error: "WAV base64 解码失败" }, 400);
      ctx.keepDebugAudio(dev, wav);
    }
    ctx.hb.seen(dev);
    ctx.deviceHere(dev);
    const t0 = now();
    try {
      const userText = wav ? ((await ctx.voice.transcribe(wav)) || PHOTO_ONLY_PROMPT) : (String(data.text || "").trim() || PHOTO_ONLY_PROMPT);
      const tAsr = now();
      console.log(`[${dev}] 🗣️  ${userText}`);
      const imagePath = imageB64 ? ctx.decodeImageB64(imageB64, dev, "vision") : null;
      if (wantsAsync(req)) {
        return startAsync(dev, role, userText, { "X-Role": role.id }, t0, tAsr, (onEvent, meta, signal) =>
          ctx.inChat(dev, () => ctx.brain.chat({ message: withTouch(userText, req.header("X-Touch")), sessionId: sid, imagePath, localTime, agent: role.agent, deviceId: dev, spoken: true, trusted: ctx.deviceTrusted(req, dev), meta, onEvent, signal })));
      }
      if (wantsStream(req)) {
        return streamed(dev, role, userText, { "X-Role": role.id }, t0, tAsr, (onEvent, meta) =>
          ctx.inChat(dev, () => ctx.brain.chat({ message: withTouch(userText, req.header("X-Touch")), sessionId: sid, imagePath, localTime, agent: role.agent, deviceId: dev, spoken: true, trusted: ctx.deviceTrusted(req, dev), meta, onEvent })));
      }
      const reply = await ctx.inChat(dev, () => ctx.brain.chat({ message: withTouch(userText, req.header("X-Touch")), sessionId: sid, imagePath, localTime, agent: role.agent, deviceId: dev, spoken: true, trusted: ctx.deviceTrusted(req, dev) }));
      console.log(`[${dev}] 💬  ${preview(reply)}`);
      const tLlm = now();
      const wavOut = await ctx.voice.synthesize(reply, roleVoice(role));
      if (!wavOut) return json({ error: "TTS 生成失败" }, 500);
      ctx.logTiming(dev, t0, tAsr, tLlm);
      ctx.hb.seen(dev);
      const out = fs.readFileSync(wavOut);
      console.log(`[${dev}] 📤  WAV ${out.length} bytes`);
      ctx.lastReply.set(dev, { user: userText, reply, ts: now() });
      return bytes(out, "audio/wav", { "X-User-Text": b64Header(userText), "X-Reply-Text": b64Header(reply), "X-Role": role.id });
    } catch (e: any) {
      console.log(`[${dev}] ⚠️  vision 错误: ${e.message}`);
      return json({ error: String(e.message || e) }, 500);
    }
  });

  /** 设备顶栏 ROLE 键：切到下一个角色，直接回新角色的问候语音 */
  r.post("/role/cycle", async (req) => {
    const dev = validateDeviceId(req.header("X-Device-Id"));
    if (!ctx.state.checkRate(dev) || !ctx.ipRateOk(req)) return tooMany();
    ctx.deviceHere(dev);
    const target = ctx.roles.set(dev, ctx.roles.next(dev).id)!;
    const text = ctx.roles.greeting(target);
    const wavOut = await ctx.voice.synthesize(text, roleVoice(target));
    if (!wavOut) return json({ error: "TTS 生成失败" }, 500);
    console.log(`[${dev}] 🎭  [role/tap] → ${target.name} (${target.agent})`);
    return bytes(fs.readFileSync(wavOut), "audio/wav", { "X-Role": target.id, "X-Reply-Text": b64Header(text) });
  });
}
