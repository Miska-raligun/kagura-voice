# 设备协议与对话链路

> 踩坑记录（LRN），从 CLAUDE.md 按子系统拆出来的。改 /chat、/chat-vision、响应头、MQTT 命令、角色切换、短路链、边生成边播、异步对话之前先读这份；新踩的坑也记在这里（写清症状、原因、别改坏的点）。

- **短路链**（`/chat` 内）：没听清 → （免手模式）口头退出 → 角色列表/切换 → 提醒 →
  音量 → 快捷指令 → OpenClaw。短路命中存 `state.set_last_quick`，下次 LLM 对话作为
  背景注入（`pop_last_quick`）；没听清/退出/切角色不记（`remember=False`）。
- **角色切换**（`roles.py`，LRN 2026-10-19）：角色 = OpenClaw agent + 百度音色 `per` +
  设备上一套图。**所有调 `chat()` 的地方都必须走 `_role_ctx(device_id)`** 拿
  `(role, session_id)` 并传 `agent=role["agent"]`——漏一处，切了角色之后摇一摇/定时
  拍照还在找原来那个 agent。`synthesize(text, per=...)` 同理（推送走设备当前角色音色）。
  第一个角色是默认：会话 key 就是 `device_id`（老会话不丢），其余是 `device_id~role_id`。
  角色 id 只许 ASCII（要进 `X-Role` 头、当设备目录名）。设备端 `cfg.St.role` 只经
  `ui.set_role()` 改（变了才作废 `_drawn_key`，同角色重复设置不能重画）；
  `ui.img_path(base)` 先找 `resource/<role>/<base>.jpg`、没有就用默认那张，
  `_img_missing` 按路径记。图片各角色分目录常驻 flash，切换只改读哪个目录，不用重传。
  切换入口：语音（`/chat` 短路）、设备顶栏 **ROLE 键**（`chat.cycle_role` →
  `POST /role/cycle`，设备上行不要 token，直接回新角色问候 WAV）、网页顶部下拉
  （`POST /role`，要 token；先 MQTT `{"action":"role"}` 再推问候）。设备拿角色的三处：
  `X-Role` 响应头、开机 `netsvc.fetch_role()`（`GET /role`，顺带填 `ui.role_count`，
  ≥2 才画 ROLE 键）、MQTT role 命令——**这条在回调里就地 `set_role`、不入队**
  （队列里 push 优先，入队的话紧跟的问候会先用旧图播），空闲时靠 `_role_redraw` 重画。
  顶栏坐标 CONT 6 / WAKE 60 / CAM 114 / ROLE 158 / 时间 ≥206，改了要同步
  `cam._CAM_ENTRY` 与 `ui._ROLE_ENTRY`（`import_sim` 查两者不重叠）。
- **免手模式（连续对话/声控唤醒）防误触与退出**（LRN 2026-10-19，症状「一有点声音就
  触发，退不出去只能关机」）：设备起说门槛 ×`HANDS_FREE_TH_RATIO`；开口后够响的块
  不到 `MIN_VOICED_CHUNKS` 当噪声丢弃不上传；请求带 `X-Mode`，服务端在免手模式下把
  「嗯/啊」当没听清。退出四条路：听的时候**轻点**或长按（旧版只认长按，且只在"正在听"
  那几秒有效）；说「不聊了/退出对话」（服务端回 `X-Cont-Exit`）；连续
  `CONT_EMPTY_EXIT` 次 `X-Asr-Empty`（连续模式下没听清**不播**"没听清"，悄悄接着听）；
  `CONT_IDLE_EXIT_SECS` 没有一轮有效对话。单次模式下录音中轻点 = 说完了立刻发送。
- **语音合成失败不能让整个请求报错**（`routes/chat.ts` 的 `ttsFailed`，LRN 2026-11-01，症状「模型额度用完后设备点 ROLE 键只显示 error、角色也没切；管理页面切换却正常」）：
  语音合成和模型常是同一家同一把 Key，额度一满合成也失败。以前 `/role/cycle`、`/chat` 合成失败就回 500，响应头里的 `X-Role` / `X-Volume` / `X-Need-Photo` / 屏显文字全丢了。
  现在合成失败回 300ms 静音 WAV（`silentWav`）、头照常带上，记 `tts_failed`。契约测试用 `/__fake/tts {fail: n}` 模拟。
- **响应头协议**（设备读取）：`X-Need-Photo`、`X-Volume: up/down`、
  `X-User-Text`/`X-Reply-Text`（b64 UTF-8，屏显用；`/chat` 与 `/chat-vision`
  都会带）。请求头：`X-Device-Id`、`X-Local-Time`、`X-Touch`（体感摘要）、
  （可选）`X-Api-Token`。
- **带图的那一轮不给 `take_photo`**（`Runtime.toolsFor`，LRN 2026-10-25，症状「CoreS3 拍照发过去，她只说『我看看』就没下文」）：
  照片已经随消息发给模型了，模型看到「这是什么」仍会去调 take_photo；设备对话里它只会 `needPhoto` 并结束本轮，可设备刚拍完不会再拍。
  `req.images` 非空时把 take_photo 从这一轮的工具里拿掉，逼模型直接看图答。
- **`/chat-vision` 三种入参形态**：`wav`+`image`（语音触发拍照）、仅 `image`
  （取景模式手动拍照，服务端用 `_PHOTO_ONLY_PROMPT` 当提问）、`text`+`image`
  （无 wav 时以 text 为提问）。`wav`/`image` 至少要有一个，否则 400。
- **MQTT topic**：`kagura/push/{device_id}`（播报通知）、`kagura/cmd/{device_id}`
  （`capture` / `stream_start` / `stream_stop` / `role` / `sync` / `volume`）。
  `volume`（管理界面设备表的滑块，`POST /api/admin/devices/<id>/volume`，level 10~100 → 下发 0.1~1.0）和 `role` 一样**在回调里就地做**
  （`hw._volume_set`：改变量、`setVolumePercentage`、写 `volume.json`），不入队——入队要等空闲，紧跟的试听推送会按旧音量播。当前音量随心跳 `vol` 上报。
- **WSL 端口转发**：设备走 Windows 侧进来，新开任何端口都必须同步加进
  `openclaw-startup.ps1` 的 portproxy + 防火墙列表（现有 5000/1883/5001/5002），
  否则表现是「其它功能都正常、唯独新功能连不上」。加端口时别忘了这一步。
- **拍照两条路径**：HTTP 路由用 `_issue_capture` 下发后让调用方轮询 `/capture-result`；
  后台线程（定时任务/试跑）用 `_capture_and_wait` 同步等，**别在 Flask 路由里调它**——
  设备离线时会阻塞 45 秒。`/capture-result` 的 `image_path` 字段 cores3-camera skill
  依赖，只能加字段不能改。
- **定时拍照**（`_run_scheduled_capture`）：拍照 → `chat()` 识别 → 存 `snapshots/` →
  `_send_push` 播报。发给 agent 的 prompt 必须带 `_SCHEDULE_SPEAK_HINT` 拦住
  cores3-speak，否则服务端和 agent 各播一遍。当天去重靠 `last_fired`；
  `MISS_WINDOW=900` 保证服务端晚启动时不补拍白天错过的计划。
- **边生成边播（M9，新服务端 + 内置 agent 才有，LRN 2026-10-23）**：设备请求带 `X-Stream: 1`
  （`chat._want_stream`，只在内存流式播放可用时带；`cfg.STREAM_REPLY=False` 关掉）→ 服务端
  `server/src/speech/stream-reply.ts` 边收模型逐字输出边切句、每句合成、立刻写进响应：一个 WAV 头
  （长度是占位值）+ 各句 PCM 依次追加，**不带 Content-Length、不用 chunked**（设备 requests 不认），
  读到连接关闭。`X-Reply-Text` 只有首句并带 `X-Reply-Partial: 1`，设备播完 `GET /chat/last`
  取全文刷新屏显。两个别改坏的点：① 响应头要等「首句之后又来了字，或这条助手消息结束且它的工具都执行完」
  才发——`take_photo`/`set_volume` 往往跟在「我看看。」后面，早发头 `X-Need-Photo` 就丢了；
  ② 落盘播放路径（`save_stream`）遇到长度未知的流，写完要回填真实长度，否则 `playWavFile`
  按占位长度读到文件外。老固件不带头、快捷指令短路，都照旧整段返回。
- **异步对话（`server/src/speech/async-reply.ts` ↔ `chat._poll_reply`，`cfg.ASYNC_CHAT`，LRN 2026-10-24，症状「对着设备交代长任务，60 秒一到就断」）**：
  设备单线程，同步 `/chat` 等多久主循环就停多久（发不了 MQTT 保活、喂不上狗、点屏幕没反应），所以同步路径只能等 60 秒。
  请求带 `X-Async: 1`（跟着 `X-Stream` 走，只对内置 agent）时，走大脑的请求立刻回 **202 + `X-Reply-Id`**，设备用
  `GET /chat/reply/<id>?wait=ASYNC_POLL_WAIT` 长轮询：204 + `X-Reply-Wait` = 还在想；200 = 一段流式音频（同 stream-reply 协议）；
  204 + `X-Reply-Done` = 说完了。两次轮询之间设备回来泵 MQTT、喂狗、看触摸（**按住屏幕 = `POST /chat/cancel/<id>`**，经
  `RunRequest.signal` 中止 agent）。**分段**：已生成的句子写完、agent 还没说完（多半在跑工具）就等 `SEG_IDLE_MS`，等不到先收这一段，
  头里 `X-Reply-More: 1`，设备播完再取（`_play_rest`）。别改坏的点：① 首段的头只等**会改响应头的工具**（`HEADER_TOOLS`：take_photo / set_volume），
  其它工具不等——否则「我查一下。」要憋到工具跑完；② 一条助手消息结束就 `split.flush()`（它说完「我查一下。」就去跑工具了，句子不能压在缓冲里）；
  ③ 最后一条消息没调工具 = 最终回复，头里按完整回复写（否则短回复也被标成未完，多取一次全文）；④ 等待期间 `St.awaiting=True`，
  推送入队而不是按「重复推送」丢掉（这也是只对内置 agent 开的原因：OpenClaw 的 cores3-speak 会重复推送）；⑤ 每次成功轮询刷新
  `St.last_ok_ms`，否则任务超过 30 分钟死人开关会把正在等回复的设备复位。快捷指令短路、老服务端照旧同步返回。
- **`/chat` 超时**（LRN 2026-10-18，症状「回答一长就不播，设备 `network err: ETIMEDOUT`，
  服务端却打印了 `📤 WAV`」）：设备 `REQUEST_TIMEOUT_CHAT` 原为 30s，而 OpenClaw
  允许 120s，长回答 LLM + TTS 轻松超 30s——服务端照常发、设备早已放弃。现为 60s，
  服务端 `_DEVICE_CHAT_TIMEOUT` 要同步改；每条回复打印 `⏱️ asr/llm/tts/总`，
  超时会标 ⚠️。别随手再加大：阻塞期间发不了 MQTT ping（发请求前已
  `netsvc.mqtt_ping()` 清零计时），broker 约 90s 收不到包就断。
- **openclaw 并发**：`chat()` 有全局 Semaphore(2) + 每 session 串行锁。
- **思考时显示她在做什么（`X-Reply-Status`，`async-reply.ts` 的 `toolActivity` ↔ `chat._poll_reply` / `ui.set_note`，2026-11）**：异步回复「还在想」（204 + `X-Reply-Wait`）的回应里带一句 b64 的状态
  （在搜网页 / 在跑命令 / 在用 <MCP 服务器>…，没在跑工具就不带），设备思考态多画一行（`_note`，进了 `_drawn_key`：换了一句才重画）、手机页面显示在状态条上。
  状态变了服务端提前回这次长轮询，但从这次请求进来算起至少隔 `STATUS_MIN_MS`（1.5 秒）——每次是一次 HTTP 往返，工具连着调时别把设备拖成忙轮询。`_poll_reply` 退出时清掉这行。新工具想有专门的说法就加进 `ACTIVITY`。
- **首句早点出声（`sentences.ts` 的 `eagerFirst` / `endsSentence`，2026-11）**：句子本来就预合成两句（`LOOKAHEAD`），慢的是「第一句写完」之前什么都做不了。现在第一句超过 `FIRST_MAX_CHARS`（14 字）先在逗号处切一段去合成；
  异步回复头两句一入队就合成（不等设备来取、不等能发头）。**响应头的时机没变**：「后面又来了字」从整句说完（`firstClosed`：句末标点、消息结束，或半句攒到 `LONG_SENTENCE`）算起——
  不然「我看看桌上有什么，稍等。」+ take_photo 会在逗号后就发头、`X-Need-Photo` 丢了（`test/reply.test.ts` 有这条）。部分回复时 `X-Reply-Text` 仍是整个第一句（`firstText`，半句们拼起来），不是那半句。
