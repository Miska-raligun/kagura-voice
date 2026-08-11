# CLAUDE.md

Kagura Voice：基于 OpenClaw 的中文语音助手。本地麦克风模式 + M5Stack CoreS3 硬件终端模式。

## 架构

```
CoreS3 (MicroPython)  ──HTTP──▶  voice_server.py (Flask :5000)  ──subprocess──▶  openclaw CLI
        ▲                              │
        └────MQTT (localhost:1883)◀────┘         百度 ASR/TTS (requests.Session)
```

- 设备录音上传 `/chat` → 服务端 ASR → （短路链 或 OpenClaw）→ TTS → 返回 WAV
- 服务端主动推送：TTS 存 `push_audio/` → MQTT 发 JSON 通知 → 设备 HTTP 下载播放
- UDP :5001 广播 `KAGURA_DISCOVER`/`KAGURA_HERE` 自动发现服务端 IP

## 文件

| 文件 | 说明 |
|---|---|
| `voice_server.py` | Flask 服务端：路由、ASR/TTS、`ServerState`（会话/限流/拍照）、`_send_push` |
| `cores3_client.py` | CoreS3 固件（**MicroPython**，不能用 CPython 特性/typing；改后需真机烧录验证） |
| `voice_assistant.py` | 本地 CLI 模式（ffmpeg 录音 + edge-tts），与服务端独立 |
| `quick_commands.py` | 短路规则：时间/日期/星期 `match`、音量 `match_volume`、提醒解析 `match_reminder` |
| `reminders.py` | 提醒调度：`schedule`/`fire_due`，落盘 `reminders.json`，线程 `init(send_fn)` |
| `photo_schedules.py` | 每日定时拍照：`add`/`update`/`fire_due`，落盘 `photo_schedules.json`，`init(run_fn)` |
| `stream_server.py` | 直播流接收（TCP :5002）。`_Reader` 带缓冲，`latest`/`stats`/`drop` 给路由用 |
| `web/monitor.html` | Web 监控页（单文件，无外部依赖）。由 `/monitor` 路由 `send_file` 直出 |
| `baidu_tokens.py` | 百度 token 缓存（`BaiduTokenCache`，线程安全） |
| `oc_utils.py` | `_extract_json`（raw_decode 提取 CLI stdout 里的 JSON）、`strip_markdown` |
| `config.py` | 不提交。`config.example.py` 为模板；`API_TOKEN` 可选（留空=开放） |

## 关键机制（改动前必读）

- **短路链**（`/chat` 内）：提醒 → 音量 → 快捷指令 → OpenClaw。短路命中存
  `state.set_last_quick`，下次 LLM 对话作为背景注入（`pop_last_quick`）。
- **TTS 缓存**：`synthesize()` 按 md5(文本+音色参数) 缓存于 `tts_cache/`；
  改音色参数必须同步改 cache key。
- **响应头协议**（设备读取）：`X-Need-Photo`、`X-Volume: up/down`、
  `X-User-Text`/`X-Reply-Text`（b64 UTF-8，屏显用；`/chat` 与 `/chat-vision`
  都会带）。请求头：`X-Device-Id`、`X-Local-Time`、（可选）`X-Api-Token`。
- **`/chat-vision` 三种入参形态**：`wav`+`image`（语音触发拍照）、仅 `image`
  （取景模式手动拍照，服务端用 `_PHOTO_ONLY_PROMPT` 当提问）、`text`+`image`
  （无 wav 时以 text 为提问）。`wav`/`image` 至少要有一个，否则 400。
- **MQTT topic**：`kagura/push/{device_id}`（播报通知）、`kagura/cmd/{device_id}`
  （`capture` / `stream_start` / `stream_stop`）。
- **直播链路**：MQTT 下发 `stream_start` → 设备连 TCP :5002 → 每帧 `4 字节大端长度
  + RGB565 裸字节`（0 长度=结束）→ 服务端只留最新一帧 → 网页长轮询
  `/stream/<dev>/frame.jpg?after=<seq>`。三个别踩的点：
  ① 握手行和第一帧会被 TCP 合并进同一个 segment，必须用 `_Reader` 的缓冲接着读，
  丢掉剩余字节会让整条流错位；② 网页每 20s 续期、设备端 45s 超时收摊，
  这是「关掉网页摄像头别一直开着」的唯一保障，改续期周期要同步改 `_STREAM_RENEW_SECS`；
  ③ 直播中按快门默认走 `_capture_from_stream`（取服务端最新帧，瞬时但只有
  160×120）；带 `hires=true` 才发 MQTT capture，由 `_stream_hires_capture`
  在推流循环里临时切回 QVGA 拍一张（画面停几秒）。**capture 命令必须在
  `_stream_drain_cmds` 里就地消费**——压回队列就要等直播结束才执行，
  用户按下快门就成了「没反应」。插拍耗时要补回 `_stream_deadline`，
  且 `stream_server.SOCKET_TIMEOUT` 必须大于插拍总耗时（现 45s），
  否则正常插拍会被当成掉线断开。
- **推流必须复制帧**：`raw = bytes(raw)` 那行别删。发一帧 38KB 期间驱动可能往
  同一块 framebuffer 写下一帧，取景模式定格处有同样的复制与注释。
- **网页画面「频闪」查过一次，不在设备端**：实测 226 帧亮度 120.5±0.3、连续帧
  无撕裂——设备送出的帧是干净的。真凶是 `setStage()` 把还没解码的 `<img>`
  换上屏。**必须 `await next.decode()` 之后再换 src，并复用同一个 `<img>`**；
  改回「新建 img → appendChild → 删旧 img」就会重现。
- **直播分辨率**：`_cam_set_framesize` 切 QQVGA，退出时切回 QVGA。固件没有
  `camera.deinit()` 就返回 False 照常推流（只是慢），别把这条回退路径删掉。
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
- **设备端状态**：跨子系统 flag 全在 `St` 类（busy/continuous/wake/sleeping/last_activity）；
  模式转移只走 `toggle_continuous/toggle_wake_mode/enter_sleep/wake_up`。
- **屏幕渲染**：`draw_state(state, force=False)` 整屏背景图 + 透明文字直接压在
  图上。**别再加实心条带**——曾试过"分层增量重绘 + 顶栏/文字实心底"，
  局部擦除是省了，但照片被上下黑边夹住、表情压一块黑面板，观感被否掉了。
  现在靠 `_drawn_key`（全屏内容的元组键）比对：**内容没变就整个跳过**，
  一轮对话里 6~8 次调用只有真正变化的那几次会重画。这才是治闪烁的关键，
  不是分层——旧实现是每次调用都无条件全屏重解码 JPEG（单次 ~100ms）。
  时钟只在 `draw_state` 被调用时刷新，主循环没有周期性调用（历来如此）。
- **`_ui_invalidate()`**：取景预览 / 摇晃彩蛋 / WiFi 配网会直接 `fillScreen`
  或 `drawJpg` 铺满屏幕，绕过 `draw_state`。它们**在接管前**必须调这个作废
  `_drawn_key`，否则下次 `draw_state` 判定"内容没变"跳过重绘，上一屏残留。
  在接管处调用，别改成逐个补返回路径——出口太多会漏。
- **环形可视化**（`visual_tick`，默认 `VISUAL_ENABLED = False`）：
  待机时一直转的圈像"卡在加载中"，已关闭；代码保留，改回 `True` 即恢复
  （录音跟音量、播放跟包络的反馈是有价值的，只是待机那圈不要）。
  实现上，24 段圆环在**同一批预计算矩形上原地重绘**，
  因此无需擦除、不关心背景是照片还是纯色，只用 `fillRect`（不依赖
  `fillCircle`/canvas 等未验证 API）。差分渲染：只重画亮度档位变化的段
  （实测 comet 模式平均 5.9/24 段每帧）。亮度档位恒在 `0..7`，否则
  `_vis_shades[k]` 越界——改公式后务必重验边界。
  - 驱动点：主循环（idle 彗星）、`_vis_wait`（录音电平）、`play_wav`（播放包络）
  - `processing` 态是静态帧：单线程下 HTTP 阻塞期间主循环不转。**这是成本
    取舍，不是能力限制**——设备支持线程，详见下条。
- **音频响应**：`rms_slices()` 单次遍历同时给出 5 个子片电平（动画用）和整体
  RMS（VAD 用），成本等同一次 `rms()`；`_wav_envelope()` 用稀疏 `unpack_from`
  而非 `array()` 整体转换——长回复可达 300KB，整体转换会撑爆堆。
- **设备线程能力**（结论备查，当前代码**有意不使用**）：CoreS3 支持多线程。
  上游 MicroPython `ports/esp32/mpconfigport.h` 无条件 `MICROPY_PY_THREAD (1)`
  + `MICROPY_PY_THREAD_GIL (1)`，栈 16KB/线程；`modsocket.c` 在每个阻塞 lwIP
  调用外都有 `MP_THREAD_GIL_EXIT()`，**所以主线程等 socket 时后台线程能跑**。
  （未直接验证 UIFlow2 是否自行关闭——板级配置在 `m5stack/boards/`，线程开关
  在 port 层，设备上 `import _thread` 一行即可确认。）
  - 因此"HTTP 阻塞期间做不了动画"的说法**不成立**；不做只是不值得为一个状态
    引入线程复杂度。别把它当硬约束写进注释。
  - 真要做的路径：复用一个长驻线程（`_thread` 退出不干净，见 micropython
    issue #4303，切勿每次请求新建）；请求前后用"标志位 + 确认位"严格交接
    LCD 所有权——请求期间主线程整个卡在 lwip 里不碰 SPI，交接干净就无需互斥锁。
- **push 去重 hack**：对话期间（`St.busy` 且非 `St.streaming`）收到的 MQTT push
  直接丢弃——OpenClaw 用 cores3-speak 回复时会同时触发 push，不丢会播两遍。
  改播放逻辑时务必保留。**直播必须走 `St.streaming` 豁免**：推流整段都置 `busy`，
  不豁免的话网页抓拍后的播报会被静默丢掉（症状：服务端日志有 `[push] →`，设备没声音），
  推流循环里自己消费 `_pending_push` 并在播完切回 `draw_state("streaming")`。
- **MQTT 回调只入队**：耗时操作（播放/拍照）在主循环 `process_mqtt_queue()` 消费，
  否则长播放阻塞心跳导致断连。
- **看门狗**：`WATCHDOG_TIMEOUT_MS=120s` 必须大于最长合法阻塞（HTTP 30s+余量）；
  长循环里要 `_wdt_feed()`。ESP32 WDT 创建后无法关闭。
- **openclaw 并发**：`chat()` 有全局 Semaphore(2) + 每 session 串行锁。
- **摄像头固件差异**：抓帧走 `_cam_grab()`（优先 `camera.capture()`→bytes，
  回退 `camera.snapshot()`→`image.Image`），预览走 `_cam_show()`（优先
  `Lcd.drawRawBuf`，回退 `Lcd.show`，探测一次后固定）。帧是 raw RGB565，
  分辨率靠字节数反查 `_CAM_SIZES`——改这张表要同步服务端 `RGB565_SIZES`。
- **回退开关**（设备端顶部常量）：`WAKE_MIC_PERSISTENT`、`WATCHDOG_ENABLED`、
  `SHOW_CHAT_TEXT`、`VISUAL_ENABLED`、`USE_STATE_IMAGES`、`CAMERA_MODE_ENABLED`、
  `CAMERA_QVGA`、`PREVIEW_SWAP`、`STREAM_ENABLED`、`STREAM_QQVGA`
  ——真机出问题先关开关再排查。

## 测试与验证

```bash
pip install -r requirements.txt
pytest tests/ -q                 # 155+ 例，外部依赖全打桩（conftest 注入 config/paho 桩）
python -c "import ast; ast.parse(open('cores3_client.py').read())"   # 设备端语法检查
# 监控页 JS 语法检查（node --check 只认真实文件，不能用进程替换）
python -c "import re;open('/tmp/m.js','w').write(re.search(r'<script>(.*)</script>', \
  open('web/monitor.html').read(), re.S).group(1))" && node --check /tmp/m.js
```

- 服务端改动必须跑 pytest；`tests/conftest.py` 的 `vs` fixture 每测试重置 `ServerState`。
- `cores3_client.py` 无法本地运行，只能 AST 检查 + uiflow2.m5stack.com 真机烧录验证。
- paho-mqtt 用 1.x API（`mqtt.Client()`），勿升 2.x。

## 惯例

- 提交信息中文，格式 `类型: 摘要`（feat/fix/perf/refactor/docs/chore）。
- 注释中文为主；服务端有 type hints，设备端（MicroPython）没有。
- 运行时产物（`push_audio/`、`tts_cache/`、`snapshots/`、`reminders.json`、
  `photo_schedules.json`）已 gitignore，勿提交。
