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
| `device/src/*.py` | CoreS3 固件（**MicroPython**，不能用 CPython 特性/typing；改后需真机烧录验证） |
| `device/main.py` | 烧成 `/flash/main.py` 的引导：把 `/flash/kagura/src` 加进 sys.path |
| `cores3_client.py` | 旧单文件版，**已弃用勿改**，真机验证通过后删除 |
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
  都会带）。请求头：`X-Device-Id`、`X-Local-Time`、`X-Touch`（体感摘要）、
  （可选）`X-Api-Token`。
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
  触觉的累积量在 `Feel` 类，同样只走 `feel_*` 函数改。
- **图片资源**：`ui.draw_image(basename)` 不带扩展名调用，按
  `.jpg/.jpeg/.png/.bmp` 顺序查找，并对 `drawPng`/`drawBmp` 做能力探测
  （固件没有就跳过该格式）。缺图返回 False，调用方降级到纯色/kaomoji。
  照片类资源建议转 JPG：File Manager 单文件上传上限约 100KB，320×240 照片
  的 PNG 常达 150~250KB，且 PNG 解码峰值内存明显更高。
- **触觉三层**（设备端 `TOUCH_FEEL_ENABLED`）：**别把三层混成一层**——
  ① 反射层 `feel_reflex()` 设备端立刻换表情，**不过网、不阻塞**（走一趟
  OpenClaw 是 3~10s，那不叫触觉叫事后转述）；② 体感层 `Feel` 聚合成
  "被摸了多久 / 多久没人碰"，`feel_header()` 打包成 `X-Touch: k=v,k=v` 随
  下次 `/chat` 捎走，服务端 `_touch_background()` 翻成中文注入 prompt，
  **零额外 LLM 调用**；③ 惊动层 `feel_notify()` → `/touch`，链路同 `/shake`。
  - **反射层的屏幕闪烁踩过两次，两条判据缺一不可**（症状都是「摸的时候
    画面在表情图和背景图之间一直切」，每切一次都是整屏 JPEG 重解码约 100ms）：
    ① `feel_reflex` **同一状态重复调用绝不重画**，自己挡，别指望 `draw_state`
    的 `_drawn_key`——那个 key 里含电量百分比，`(v-3000)*100//1200` 里 12mV
    就是 1%，ADC 抖动足以让它每轮都判定「内容变了」；
    ② `feel_reflex_tick` **按「屏幕上还有没有手」(`_touch_seen_ms`) 收回，
    不按倒计时**。抚摸是「划一下—停一下—再划一下」，倒计时会在停顿里掉回
    idle、下一划再切回来；触摸驱动偶发漏报一帧也走同一条老路。
    IMU 触发的 poked/held 屏幕上没有手，自然落到时间判据，两条路各走各的。
  - 定位这类问题打开 `FEEL_DEBUG`：反射层每次真正重画都打一行，
    正常一整段抚摸只该有两行（进 petted、回 idle），刷屏就是判据还有漏。
  - `feel_header()` **取走即清空**，所以 `/touch` 故意不带 `X-Touch`——带上
    等于把窗口白白清掉，下次真对话就没得注入了。
  - 惊动层的冷却（`FEEL_NOTIFY_COOLDOWN=90s`）和显著性筛选是刚需，不是保守：
    每次触摸都惊动 LLM 会让她变成话痨玩具，而且很贵。放宽前先想清楚。
- **触摸屏的双重身份**：`check_touch(feel=False)` 默认行为与加触觉前逐字节等价，
  **只有主循环 `loop()` 传 `feel=True`**——取景模式/配网/播放中断要的是纯按钮，
  别让一次手滑变成抚摸把点击吞掉。分工定死：点按=录音、长按不动=切唤醒，
  **只有手指位移 ≥ `STROKE_MIN_DIST` 才判抚摸**并吞掉这次 short/long。
  位移用"离起点最大曼哈顿距离"而非累计路径：累计会把长按抖动攒过阈值。
  抚摸在**按住期间**就判定（不等抬手），所以拿它当触发器的地方必须
  `touch_reset()` 作废这次按下，否则抬手还会再吐一个事件（休眠唤醒踩过）。
- **IMU 一次采样喂两个检测器**（`imu_tick`）：摇晃彩蛋和本体感觉必须看同一个
  样本，分开读会出现"一次摇晃被同时算成三次轻拍"。轻拍靠延后
  `IMU_TAP_CONFIRM_MS` 确认 + 尖峰计数与摇晃互斥；被端着时一律不算轻拍
  （走动本身就在制造 1.5g 尖峰）。**IMU 阈值全是拍脑袋起点值，必须真机调。**
- **屏幕渲染**：`draw_state(state, force=False)` 整屏背景图 + 透明文字直接压在
  图上。**别再加实心条带**——曾试过"分层增量重绘 + 顶栏/文字实心底"，
  局部擦除是省了，但照片被上下黑边夹住、表情压一块黑面板，观感被否掉了。
  现在靠 `_drawn_key`（全屏内容的元组键）比对：**内容没变就整个跳过**，
  一轮对话里 6~8 次调用只有真正变化的那几次会重画。这才是治闪烁的关键，
  不是分层——旧实现是每次调用都无条件全屏重解码 JPEG（实测 58ms）。
- **离屏画布合成**（`USE_CANVAS`，`_get_canvas()`）：draw_state 的所有绘制
  指向 `tgt`（画布或 Lcd），最后 `push(0,0)` 一次上屏，中间过程不可见。
  真机实测（2026-08）：直接上屏 58ms ┊ 画进 PSRAM 画布 54ms ┊ 整屏 push 35ms
  ——**总耗时 58→89ms，反而慢 50%**，买的是"瞬间完成"而非"看着它画"。
  觉得不值就把开关改 False。两个必读结论：
  ① PSRAM 带宽不是瓶颈（54 vs 58ms），JPEG 解码是 CPU 密集，写哪块内存无所谓；
  ② **整屏画布必须 `psram=True`**——内部 SRAM 凑不出 150KB 连续空间，分配会
  "成功"但没有缓冲区，之后绘制全部静默 no-op（症状：drawJpg 耗时 0ms、
  屏幕纹丝不动）。探测脚本留在 `canvas_probe()`，`CANVAS_PROBE=True` 可重测。
  - 画布暴露的方法名与 Lcd 一致，所以只换 `tgt` 不分叉代码；释放用 `delete()`
    （无 `deleteSprite`）。`_vis_set_state` 必须留在 push **之后**——它直接画屏。
  - **分层局部更新目前做不了**：顶栏那条 320×26 的 push 只要 4ms（推屏是纯带宽
    限制，4.4MB/s，严格按面积），但画布之间没有 blit 方法，要局部改字就得先把
    背景恢复回来，而唯一途径是重解 JPEG（54ms），4ms 的优势当场吃光。
    绕过去要 PC 端预生成背景块的 raw RGB565——留到做角色动画时一起搭。
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
  长循环里要 `hw.wdt_feed()`。ESP32 WDT 创建后无法关闭。
- **openclaw 并发**：`chat()` 有全局 Semaphore(2) + 每 session 串行锁。
- **摄像头固件差异**：抓帧走 `_cam_grab()`（优先 `camera.capture()`→bytes，
  回退 `camera.snapshot()`→`image.Image`），预览走 `_cam_show()`（优先
  `Lcd.drawRawBuf`，回退 `Lcd.show`，探测一次后固定）。帧是 raw RGB565，
  分辨率靠字节数反查 `_CAM_SIZES`——改这张表要同步服务端 `RGB565_SIZES`。
- **回退开关**（设备端顶部常量）：`WAKE_MIC_PERSISTENT`、`WATCHDOG_ENABLED`、
  `SHOW_CHAT_TEXT`、`VISUAL_ENABLED`、`USE_STATE_IMAGES`、`CAMERA_MODE_ENABLED`、
  `CAMERA_QVGA`、`PREVIEW_SWAP`、`STREAM_ENABLED`、`STREAM_QQVGA`、
  `TOUCH_FEEL_ENABLED`（整个触觉）、`FEEL_NOTIFY_ENABLED`（只关"主动开口"，
  保留反射层和体感层）、`FEEL_WAKE_ON_PICKUP`
  ——真机出问题先关开关再排查。

## 设备端模块结构（device/src）

依赖分层，**必须保持无环**（`tools/check_split.py` 会检查）：

```
cfg → hw → clock → ui → {wifisetup, audio} → cam → feel
    → diag → netsvc → stream → chat → app
```

| 模块 | 职责 |
|---|---|
| `cfg` | 常量、回退开关、目录助手、`St`/`Feel` 状态类。不 import 任何 kagura 模块 |
| `hw` | LED/看门狗/麦克风/音量/RMS/触摸（含抚摸轨迹）/绘图原语 |
| `clock` | RTC 同步与读取。单独成模块是为打断 ui ↔ netsvc 环 |
| `ui` | 字体、环形可视化、离屏画布合成 `draw_state`、息屏唤醒 |
| `wifisetup` | 屏上配网（SSID 选择 + 软键盘），最自洽的一块 |
| `audio` | 录音 VAD、播放、包络、噪声校准 |
| `cam` | 抓帧/预览/取景模式/拍照上传。**不能叫 camera**——MicroPython 的摄像头驱动就叫这名，同名会 import 到自己 |
| `feel` | 触觉三层 + IMU 本体感觉 |
| `diag` | 事件环形日志、崩溃上报、心跳遥测、网络分级自愈、画布探测 |
| `netsvc` | MQTT、BLE 感知、UDP 发现 |
| `stream` | 摄像头直播推流与直播中插拍 |
| `chat` | 主对话、模式切换、IMU 摇晃彩蛋 |
| `app` | `setup()` / `loop()` / `main()`（含崩溃守护循环） |

设备端由 `tools/` 下的生成器从单文件版拆出，**注释逐行保留**（顶层语句之间的
独立注释块会随下一条语句一起被抽走，否则段头和踩坑记录会全部丢失）。

**三条铁律**：

1. **可变全局必须用 `cfg.X` 访问，绝不能 `from cfg import X`。**
   `SERVER_BASE`/`SERVER_URL`/`VISION_URL`/`UPLOAD_URL`/`MQTT_BROKER` 由
   `netsvc.discover_server()` 改写，`SILENCE_THRESHOLD`/`WAKE_THRESHOLD` 由
   `audio.calibrate_noise()` 改写。用 `from` 导入拿到的是值拷贝，改了看不到，
   **且不报错**——设备会一直连 fallback IP。
2. **改写 cfg 里的可变量要写 `cfg.X = ...`，不能用 `global X`**（那会在本模块
   建一个同名局部全局，cfg 里的值纹丝不动）。
3. **别拿模块名当局部变量**。原代码 `ensure_wifi()` 里有个局部 `cfg = _wifi_load()`
   会遮蔽 cfg 模块，拆分时已改名为 `saved`。

**两处循环依赖用回调注入打断**，注入点都在 `app.setup()`：

- `audio ↔ netsvc`（`play_wav` 要 `mqtt_check` 维持心跳、push 又要回调
  `play_wav`）→ `audio.set_pump(netsvc.mqtt_check)`。取景循环也要泵 MQTT，
  走同一个注入点（`audio._pump_safe()`），别再开第二个。
- `netsvc ↔ stream`（MQTT 收到 `stream_start` 要跑推流、推流循环又要回来消费
  命令队列）→ `netsvc.set_stream_runner(stream._run_stream_cmd)`。

`_mqtt_ok` 放在 `diag` 而不是 `netsvc`：心跳要读它，netsvc 要写它，
放 netsvc 就成环。netsvc 写 `diag._mqtt_ok = ...`，单向依赖。

## 测试与验证

```bash
pip install -r requirements.txt
pytest tests/ -q                 # 200+ 例，外部依赖全打桩（conftest 注入 config/paho 桩）
python3 tools/check_split.py     # 设备端拆分静态校验（5 项）
python3 tools/import_sim.py      # 桩件环境下真的 import 一遍设备模块
# 监控页 JS 语法检查（node --check 只认真实文件，不能用进程替换）
python3 -c "import re;open('/tmp/m.js','w').write(re.search(r'<script>(.*)</script>', \
  open('web/monitor.html').read(), re.S).group(1))" && node --check /tmp/m.js
```

- 服务端改动必须跑 pytest；`tests/conftest.py` 的 `vs` fixture 每测试重置 `ServerState`。
- 设备端无法本地运行，但有两层静态兜底（CI 也跑）：
  - `tools/check_split.py`：名字解析、import 无环、可变全局导入方式、
    跨模块 `mod.attr` 是否悬空、函数是否丢失
  - `tools/import_sim.py`：用桩件模拟 M5/MicroPython 环境**真的 import 一遍**，
    并验证 `rms`/`rms_slices` 一致性、WAV 头、包络等纯函数行为
  - 最终仍需 uiflow2.m5stack.com 真机烧录确认
- paho-mqtt 用 1.x API（`mqtt.Client()`），勿升 2.x。

## 惯例

- 提交信息中文，格式 `类型: 摘要`（feat/fix/perf/refactor/docs/chore）。
- 注释中文为主；服务端有 type hints，设备端（MicroPython）没有。
- 运行时产物（`push_audio/`、`tts_cache/`、`snapshots/`、`reminders.json`、
  `photo_schedules.json`）已 gitignore，勿提交。
- 设备目录：`/flash/kagura/src`（代码）、`/flash/kagura/resource`（图片，
  用 `cfg.res()` 取路径）、`/flash/kagura/data`（运行时状态，`cfg.data()`，
  `cfg.ensure_dirs()` 自动创建）。新增文件路径一律走这两个助手，别硬编码。
