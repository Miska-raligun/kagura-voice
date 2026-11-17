# 语音合成、出口与语音服务商

> 踩坑记录（LRN），从 CLAUDE.md 按子系统拆出来的。改 TTS 缓存、推送播报（出口）、语音服务商、朗读版之前先读这份；新踩的坑也记在这里（写清症状、原因、别改坏的点）。

- **TTS 缓存**：`synthesize()` 按 md5(文本+音色参数) 缓存于 `tts_cache/`；
  改音色参数必须同步改 cache key。普通缓存只留最近 `TTS_CACHE_MAX_FILES`（1000）条，边生成边播一句一条，很快就轮换。
  **固定的话传 `{ fixed: true }`**（LRN 2026-11-01，症状「额度用完后 ROLE 键切不了角色——问候语明明每次都一样，却要重新合成」）：
  存进 `tts_cache/fixed/`（`pruneDir` 只清顶层，不会被挤掉），合成过一次就一直用，key 含服务商配置，换音色自然重合成。
  现在用在：切角色问候（`/role/cycle`、语音切换、管理界面 / 监控页切换的推送）、`/chat` 里不记 last_quick 的短路回复（没听清 / 退出 / 「我就是 X 呀」）、试听音量。
  `sendPush(..., { fixed: true })` 不按句拆（拆开的每句不固定）。**新加固定说辞时顺手带上。**
- **出口（`agent/outbox.ts`，LRN 2026-10-23，症状「飞书聊天时有时播语音有时不播，要提醒才播」「设备显示小澪却用神乐的声音说话」）**：
  **agent 没有 speak 工具**（只有 `announce`：主人明确让「跟家里说一声」时用，只在可信的非设备会话里有，`relay` 不看在家状态、角色不对也立即播、`never` 仍不播；
  这一轮调过就不再 mirror，免得播两遍），播不播完全是系统的事：agent 发给主人的每条消息——主人 IM 私聊 / 网页聊天的回复（`mirror`：`Runtime.spoken` 去格式后不超过 agent 的 `voice_max_chars`×1.2 直接念，
  更长的用便宜模型压成口语，失败退回截断；按策略不播时不去调模型）、
  定时任务 / heartbeat（投 `device:` 只播；投 IM / webchat 发文字再 mirror）、子任务结果、提醒、定时拍照识别——都经 `Outbox.say()`。
  **朗读版写在最前 + 推送边合成边播**（LRN 2026-10-31，症状「飞书 / 网页的长回复要等全写完，再找便宜模型压成口语，20 秒压不完就截断着念」）：
  会被顺带念的回复（主人 IM 私聊、网页聊天，且 `outbox.allowed()`）给 `RunRequest.onVoice`（`sys.voiceFirst` / `VoiceBridge.early`），系统提示加 `voicePrompt`：
  长回复在最终回复最前面写 `<voice>口语版</voice>`。`VoiceTap` 在流式里扣下这段、一闭合就回调去念（不等正文、不再调模型），正文 / 落盘（`unvoice`）/ 实时页 / onEvent 都拆掉；
  `meta.voice` 有值时事后的 mirror 不再念。没写就走 `spoken()` 兜底：短的直接念，长的用「朗读兜底模型」（`models.voice`，空 = 便宜模型）按它自己的思考设置跑（`quick(…, {think})`），不思考 20 秒 / 思考 60 秒。
  **推送边合成边播**（`speech/live-push.ts`）：`sendPush` 多于一句就按句合成，第一句好了就发 MQTT 通知，`/push-audio/<名>` 先找 `ctx.livePush` 边合成边写（协议同边生成边播：占位长度的 WAV 头 + PCM，读到关连接）。
  日志：`🗣️ 朗读版写好了`、`[outbox] 🔈 …`、`[push] → …（边合成边播，N 句，首句 Xs）`、`[push] ← … 来取（通知后 Xs）`、`[push] ✓ 合成完`。
  ① `voice_push`：`presence`（默认）在家播、不在家不播（未知按在家）；`always` / `never`。管理界面改了就地生效。
  ② `role_push`（设备当前不是说话的那个角色时）：`hold`（默认）留言，设备切到那个角色时（`ctx.onRoleSwitch`，等设备空闲、问候之后）合成一段播；
  mirror 的不留（文字已经发过了，切角色时冒出一串聊天回复很怪）。`switch`：照样推，`ctx.sendPush(text, dev, agentId)` 用那个角色的音色、
  MQTT 通知带 `role`，设备 `netsvc._play_push` 播放期间临时 `ui.set_role(role)`、播完换回（中途收到 role 命令就不换回），服务端的当前角色不变。
  留言落盘 `held_messages.json`（最多 30 条、24 小时），设备页能看能清。
  ③ **不经出口的只有设备自己发起的交互**（对设备说话、摇一摇、触摸、ROLE 键）：主人就在设备前，角色也对得上；这几处都调 `ctx.deviceHere(dev)`
  把在家状态改成 home——`/chat` 里放在 ASR 有结果之后（免手模式的环境声不算）、大脑之前，这样「我出门了」里 agent 调的 `set_presence(away)` 后到、以它为准。**新加任何 agent 主动说话的入口都走出口，别直接 `ctx.sendPush`。**
  **角色切换钩子挂在 Ctx 上（`setRoles`）**：改 agent 时角色表整个重建，钩子挂在 Roles 实例上会悄悄丢失（契约测试踩过）。
  在家状态统一走 `ctx.setPresence` / `loadPresence`（设备 BLE、设备交互、`set_presence` 工具、`/home` `/away` 命令）。
- **语音服务商（`server/src/voice/hub.ts`）**：识别、合成不写死百度——`speech.asr` / `speech.tts` 选默认服务商（baidu / openai 兼容 / minimax），
  agent 的 `tts_provider` / `tts_voice` 经 `roleVoice(role)` 变成 `VoiceRef` 传给 `synthesize`（**新加合成调用点一律传 `roleVoice(...)`，别再只传 `per`**，
  否则角色单独选的服务商被悄悄丢掉）。音色只给它所属的那家；指定的那家失败退回默认服务商（百度时用 per）。别家音频统一 `toPcm16k`（设备只认 16k 单声道 16 位），
  缓存 key 含服务商 / 模型 / 音色，**百度的 key 保持原样**（旧 tts_cache 照样命中）。别家合成后过 `normalizeLoudness`（`util/wav.ts`：有声段 RMS 补到约 -18dBFS，最多 ×4、峰值不过 0.9，只放大不压低；MiniMax 复刻音色常偏小），key 带 `|norm1`——改这个处理要换后缀。管理界面改 speech 就地 `configure`，不用重启。
  MiniMax（文档 platform.minimax.cn/docs/api-reference）：识别 `speech_to_text`（asr-1.0），合成 `t2a_v2`；错误有两种外形
  （HTTP 200 + `base_resp.status_code` / 真实状态码 + OpenAI 风格错误体），都要认。管理页「复刻音色」走 `minimaxClone`
  （`files/upload` → `voice_clone`，录音 base64 进 JSON，`/api/admin/voice-clone` 只对本机放宽请求体）；复刻音色 7 天内不正式合成会被删。
  **两把 Key 分开**（LRN 2026-10-24）：复刻音色首次正式合成收一次音色费，订阅 Key（Token Plan / M Plan）只扣套餐额度、付不了（报 1008），
  所以复刻 / 激活走 `billing_api_key`（按量计费，`billingKey(p)`），日常合成 / 识别走 `api_key`（可以是订阅 Key）；激活过后订阅 Key 也能用该音色。
  复刻过的音色记在 `minimax_voices.json`（`voice/minimax-voices.ts`，已登记进导出的 settings 项）——MiniMax 的 `get_voice` 只返回**已激活**的复刻音色，没激活的只能靠本地记录。
