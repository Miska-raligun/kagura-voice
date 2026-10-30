# CLAUDE.md

Kagura Voice：中文语音助手。M5Stack CoreS3 硬件终端 + 服务端（内置 agent 系统，也可接 OpenClaw）。

## 架构

```
CoreS3 (MicroPython) ──HTTP──▶ server/（TypeScript 单文件可执行 :5000）──▶ 内置 agent（pi）或 openclaw CLI
        ▲                         │  内置 MQTT broker :1883 · UDP 发现 :5001 · 直播 TCP :5002
        └──────MQTT───────────────┘  百度 ASR/TTS · 飞书/QQ 渠道 · 本机管理界面 /admin
```

- 设备录音上传 `/chat` → 服务端 ASR → （短路链 或 agent）→ TTS → 返回 WAV（新固件边生成边播）
- 服务端主动推送：TTS 存 `push_audio/` → MQTT 发 JSON 通知 → 设备 HTTP 下载播放
- UDP :5001 广播 `KAGURA_DISCOVER`/`KAGURA_HERE` 自动发现服务端 IP
- **当前主线是 `server/`**。根目录的 Python 版（`voice_server.py` 等）已冻结，只修严重 bug；
  契约测试仍对两版都跑，等 1.0 正式版稳定后删除（见 `docs/legacy-python.md`）。

## 文件

| 文件 | 说明 |
|---|---|
| `server/` | **服务端（主线）**：单文件可执行、内置 MQTT broker、内置 agent 系统（基于 pi：记忆、定时任务、heartbeat、agent 间通信、技能、扩展 / 扩展包 / MCP）、IM 渠道（飞书/QQ）、本机管理界面 `/admin`、Windows 托盘版。见 `server/README.md`、`docs/plan-kagura-agent.md`。`contract-tests/` 新旧两版共用（`KAGURA_BRAIN=pi` 再跑一轮内置 agent） |
| `voice_server.py` | 旧版 Flask 服务端（**已冻结**）：路由、ASR/TTS、`ServerState`、`_send_push`。改设备协议时契约测试还会跑它 |
| `device/src/*.py` | CoreS3 固件（**MicroPython**，不能用 CPython 特性/typing；改后需真机烧录验证） |
| `device/main.py` | 烧成 `/flash/main.py` 的引导：把 `/flash/kagura/src` 加进 sys.path |
| `cores3_client.py` | 旧单文件版，**已弃用勿改**，真机验证通过后删除 |
| `voice_assistant.py` | 本地 CLI 模式（ffmpeg 录音 + edge-tts），与服务端独立 |
| `quick_commands.py` | 短路规则：时间/日期/星期 `match`、音量 `match_volume`、提醒解析 `match_reminder` |
| `reminders.py` | 提醒调度：`schedule`/`fire_due`，落盘 `reminders.json`，线程 `init(send_fn)` |
| `photo_schedules.py` | 每日定时拍照：`add`/`update`/`fire_due`，落盘 `photo_schedules.json`，`init(run_fn)` |
| `stream_server.py` | 直播流接收（TCP :5002）。`_Reader` 带缓冲，`latest`/`stats`/`drop` 给路由用 |
| `web/monitor.html` | Web 监控页（单文件，无外部依赖）。由 `/monitor` 路由 `send_file` 直出 |
| `web/app.html` | 手机 / 平板网页客户端（单文件，无外部依赖），新服务端 `/app` 直出：对话 + 看家 |
| `roles.py` | 角色（多 agent）：`get`/`set_role`/`session_key`/`match_switch`，落盘 `roles_state.json`，表来自 `config.ROLES` |
| `baidu_tokens.py` | 百度 token 缓存（`BaiduTokenCache`，线程安全） |
| `oc_utils.py` | `_extract_json`（raw_decode 提取 CLI stdout 里的 JSON）、`strip_markdown` |
| `config.py` | 不提交。`config.example.py` 为模板；`API_TOKEN` 可选（留空=开放） |

## 关键机制（改动前必读）

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
- **TTS 缓存**：`synthesize()` 按 md5(文本+音色参数) 缓存于 `tts_cache/`；
  改音色参数必须同步改 cache key。
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
    ——包络只有内存路径 `play_wav` 有；落盘路径 `play_file` 为了不把整段 WAV
    拉回堆，故意不回读文件算包络。
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
- **看门狗**：`WATCHDOG_TIMEOUT_MS=180s` 必须大于最长合法阻塞。
  长循环里要 `hw._wdt_feed()`。ESP32 WDT 创建后无法关闭。
  **"最长合法阻塞"里包含整段播放**，不只是 HTTP 30s——早报推送 74 秒，
  加上下载与写盘就顶到了原来的 120s 窗口（见下条）。
- **长音频播放：整条链路都得喂狗，别再用 `resp.content`**
  （LRN 2026-08-25，症状是"语音一长就播到一半黑屏"）。
  一条早报推送可达 **2.4MB / 74 秒**。原来的链路
  「`resp.content` 整段进堆 → 一次 `f.write` 全写 flash → `playWavFile`」
  从头到尾没有一次 `_wdt_feed()`，而 WDT 窗口只有 120 秒——
  服务端日志留下了完整现场：2026-08-11 08:10:49 推送 2.38MB，08:11/08:12
  两次心跳全丢，08:13:00 带着「**看门狗复位⚠️**」重启上报。现在的口径：
  ① 下载走 `snd.save_stream(resp)`：分块 `readinto` 直接落盘，每块喂狗，
  堆里不再出现整段 WAV（`/chat`、`/chat-vision`、push 四处调用点都换了）；
  ② 写盘走 `snd._write_chunked`，同样每块喂狗；
  ③ **短写必须自己查**——flash 写满时 MicroPython 的 `f.write` 只返回少写的
  字节数、不抛异常，放着不管就是"WAV 头写着完整长度、文件只有一半"，
  症状同样是"播到一半没了"，极易和本条混淆；
  ④ 超过 `PLAY_SEG_MAX`（约 50 秒）的音频**边下边切**成 10 秒一段
  （`_save_segmented`，跳掉源 44 字节头、每段回填自己的头，不多读写一遍），
  `play_file()` 按清单连播。这样无论 `playWavFile` 阻塞与否，最长不喂狗
  窗口都钉死在 10 秒量级。**日常回复（< 50 秒）一段到底，一条缝都没有。**
  三个别改坏的点：段间**不 end/begin 扬声器**（收尾那 150ms 消 pop 静音会
  把缝隙从几十毫秒拖成两百多毫秒）；收尾处轮询从 50ms 收紧到 5ms；
  **接缝两头各做 5ms 淡入淡出**（`_fade_edges`）——切点处波形是硬台阶
  （上一段停在某个幅度、夹几十毫秒静音、下一段又从另一个幅度起步），
  那声"咔嚓"就是它，2026-08-25 真机首测 10 段听出了 9 次。
  **淡化后残余的那一点咔嚓已经查过，是功放启停的物理声，软件治不了**
  （同一条 96 秒音频：10 段→4 段、加 5ms 淡化后"轻了但还在"）。
  别再往淡化时长/切点对齐上使劲了，唯一有效的旋钮是把 `PLAY_SEG_BYTES`
  加长、减少启停次数——上限 60 秒/段（再长 MQTT keepalive 就掉线），
  代价是"按屏幕停播"要等一段播完。
  段长同时决定三件事，别只盯着一件调：接缝次数（咔嚓）、
  "按屏幕停播"的响应粒度（阻塞期间主循环不转）、喂狗与 MQTT ping 的间隔
  （只能在段间做，所以段长不能超过 keepalive 60s 的一半量级）。
  **为什么不让服务端拆成多条推送**：每段之间要重走「MQTT 通知 → HTTP GET
  → 下载几百 KB」，缝隙是秒级的，还各自多两次全屏重绘。
  另外 `_drop_stale_segs` 必须留着——上一条长音频的分段不删就一直占 flash，
  而 flash 满的后果恰恰是"写出半个 WAV、播到一半没了"，跟本条症状撞车。
  ⑤ `snd.play_file()` 返回播放等待循环的轮数 `iters`，长音频前后各持久化一条
  面包屑（`play …KB` / `played …s iters=…`）。下次再黑屏，crash.log 里
  **只有 play 没有 played = 死在播放中**；**`iters=0` = `playWavFile` 是阻塞
  实现**（整段播放期间主循环没转，喂狗只靠进函数前那一次）——这一条没在
  真机上确认过，是留给下次的判据。
- **边下边播**（`snd.stream_play`，`PLAY_STREAMING`，LRN 2026-10-18，症状「长回复
  生成完还要等很久才出声，播完 MQTT/心跳断连重连」）。两个根因：
  ① 旧链路先把整段 WAV 写进 flash 再播，60 秒回复约 1.9MB，光写盘就十几秒；
  ② **本固件 `playWavFile` 是阻塞实现**（iters≈每段 1 轮），一段 25~60 秒播放
  期间主循环不转，`play_file` 里那个泵 MQTT 的循环形同虚设。现在 `/chat`、
  `/chat-vision`、取景拍照、push 四处都走 `stream_play`：每收 1 秒
  （`STREAM_BLOCK_BYTES`）加迷你 WAV 头，`Speaker.playWav(内存)` 挂进固定通道
  `STREAM_CH` 的两槽队列（非阻塞），三块缓冲轮转，收满 `STREAM_PREBUF` 块开播。
  **别改坏的点**：往一块缓冲写数据前，它必须已播完——靠「队列有空位才挂下一块」
  保证（在播的只剩上一块），`isPlaying(ch)` 查不了深度时按预计播完时刻估；
  `import_sim` 用两槽队列桩专门验了「播出逐字节一致 + 在播缓冲零覆盖」。
  第一块挂进去 100ms 内不在播（或 `playWav` 签名不符抛异常）就把已读字节接回
  流前面、退回落盘 `save_stream + play_file`，本次开机不再尝试。
  每次播放写一条 `play stream kb= first= ms= gaps=` 诊断日志：`first` 是从开始
  下载到出声，`gaps>0` = 网络跟不上、扬声器断过粮，`mode=fallback` = 固件不支持。
  服务端 `/chat` 也会刷新心跳时刻（`_hb_seen`）：设备对话期间不发心跳，
  长对话会被误报「心跳中断」。
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
- **会话锁不能被无限占着**（`agent/runtime.ts`，LRN 2026-10-24，症状「某个 agent 突然不理人、再发也没反应，换个 agent 正常」）：
  同一会话的轮次串行（`serial`），一轮卡住后面全排队。占锁的每一段都要有时限、能被取消：① 回复前的压缩（记忆冲刷 + 摘要模型调用）
  以前既没超时也不理取消，接口一卡就永远锁死——现在上限 2×`timeout_secs`、接上 `req.signal`，超时 / 取消就跳过压缩、照常回复，
  放弃之后回来的结果**不再改历史**；② 工具执行期间不按 idle 计时，但最多 `TOOL_MAX_MS`（15 分钟）；③ 流式写音频的 `write` 要同时听 `drain` 和 `close`，
  对方断开时 drain 永远不来，异步回复会一直回「还在想」。排队超过 20 秒会打一行 `⏳ … 在排队：上一轮还没结束（用途/渠道/阶段/工具）`——
  再遇到「不理人」先搜这行。新加任何在会话锁里 await 的东西都要问一句：它卡住了怎么办？
  **单轮上限（`TurnGuard`，LRN 2026-10-30，症状「等她回复，她一直 exec 兜圈子把 token 烧光」）**：无进展超时被每次工具调用刷新、总时长又有半小时，挡不住兜圈子。
  现在每轮有工具调用次数（`max_tool_calls`，默认 40）和 token（`max_turn_tokens`，默认 200 万，含缓存读写，0 = 不限）上限，待办 ×3；同一工具同样参数第 `REPEAT_LIMIT`（3）次直接拒绝。
  到上限先软停：之后的工具调用都返回「别再调工具，告诉主人做到哪了」，再 `GUARD_GRACE` 次还在调就强制中止。日志 `🔁`。工具经 `guard.wrap` 包一层（保留原型）。
  **会话页实时过程（`Runtime.watchLive`，`GET /api/admin/agents/<id>/sessions/<key>/live`，LRN 2026-10-30，症状「网页上只有发消息那个窗口看得到过程，切走再回来、飞书 / 设备触发的只剩『回复中』」）**：
  每轮（非嵌套）在 `execute` 里留一份 `LiveRun`（已完成的消息 + 正在生成的思考 / 正文 + 正在执行的工具），会话页长连接订阅：先快照（start / idle），再 delta / message / tool，结束 end（带错误原因，超长重试那次不报）。
  推给页面的消息过 `liveMessage`（去自动回忆、图片只留占位、工具结果截 8000 字）。页面过程一律从订阅来，发消息的 POST 只等结果；end 后先重新拉历史再收起实时块。
  **每轮 token 明细**：每条助手消息本来就带服务商报的 `usage`（输入未缓存 / 缓存读写 / 输出 / 思考 / 费用）；`execute` 落盘时在这一轮最后一条助手消息上加 `kctx`
  （系统提示 / 工具定义 / 历史的估算 token、窗口、调用次数），会话页 `TurnUsage` 汇总显示。**读历史给模型前要去掉 `kctx`**（`execute` 里 `history` 那行）。
  **系统处理详情**：`kctx` 里还有 `trace`（`buildSystemPrompt` 的 `PromptTrace`：场景、加载了哪些文件 / 全文还是目录 / 字数 / 是否截断、没加载的、今昨笔记、技能、摘要）、
  近况条数、自动回忆命中（`recallFor` 返回 hits / 用时 / 没附的原因）、截短的旧工具结果条数、单轮上限叫停原因。
  压缩不属于某一轮，记成会话事件（`AgentStore.addEvent`，`events` 表，每会话留 200 条）：`compact`（`trigger` = before / background / overflow / manual，压了多少、剩多少、记进了哪些记忆）、
  `compact_failed`；会话接口带 `events`。会话页每轮回复下面只放小图标（`TurnMeta`）：ⓘ 上下文 + token，🗜 这一轮之后发生的压缩（`placeEvents` 按时间挂到轮次上），悬停预览（不挡鼠标）、点击固定（`ui.Pop`）——**别再把详情平铺进对话流**。新加系统层对上下文的处理时也照这个记，别只打日志。
  **会话来源**：所有入口（设备、飞书 / QQ、网页、heartbeat、定时任务、待办、子任务）的会话都在 agent 库里，会话页一律能看、能实时跟。
  落盘时第一条用户消息带 `ksrc`（渠道 / 用途 / 设备），`Runtime.note` 记进来的带 `purpose: "note"`；和 `kctx` 一样**发给模型前去掉**。
  列表按 key 认来源（`sourceOf`：`:main` 主会话、`:heartbeat` / `:cron:` / `:task:` / `:sub:` 后台），每 5 秒刷新。
  ④ **跨会话互相等待**（2026-10-24 真机日志：worker 的 heartbeat 拿着 `worker:main` 去 `sessions_send` 等 main，同时 main 那边一轮拿着 `main:main` 等 worker；
  手机设备 `device_in_main` 也走 `worker:main`，于是手机消息永远排不上）：`scope.chain` 只看得见同一条调用链，两条各自起头的链互等它看不出来。
  `Runtime.run` 记 `waitsFor`（拿着锁的会话 → 它在等的会话），发起嵌套等待前顺着走一圈，成环就立刻失败（日志 `🔁 互相等待`）；
  嵌套等待（手里拿着自己的锁去等别人）还有上限 `lockWaitMs.a2a`（90 秒），等不到就放弃——但排着的位置要等前面真完了才让出去，别让后面的插队。
  管理界面总览的「正在运行」卡片（`Runtime.activeRuns` / `cancelRun`，`/api/admin/runs`）：每个会话正在跑的那一轮、阶段 / 工具、排队数、在等谁，能手动终止。
  终止走每轮自己的 `AbortController`（调用方的 `req.signal` 也接在它上面），和取消同一条路：中止模型和工具，最多 2 秒放开会话锁。
  **手动终止的那一轮要留痕**（LRN 2026-10-30）：`info.cancelled`（管理界面「停止 / 停止并发送」、总览终止）时把用户消息 + 已经说出口的字（`spoken`，按 text_delta 攒——中止后那条没说完的消息内容是空的）
  + 「（这一轮被主人打断了，没说完）」记进历史，工具调用 / 结果不留（没配对的 toolCall 服务商会拒）；设备按住取消（`req.signal`）不留。
  会话页她在回复时也能发：消息排在页面上（`queue`，能撤回），这一轮结束按顺序发；「停止并发送」= 插到队首 + `/api/admin/runs/cancel`。
  ⑤ **压缩是分块滚动摘要**（LRN 2026-10-24，症状「压缩失败：摘要为空」连着好几轮、会话越积越大）：一次塞几万 token 给推理型模型（MiniMax-M3 等），
  输出额度被思考用完、正文为空。现在按 `COMPACT_CHUNK_TOKENS`（1.6 万）切块，「上一版摘要 + 这一块」→ 新摘要，每次 `maxTokens` 至少 `COMPACT_MAX_OUTPUT`（8192）、
  各自 `timeout_secs`；某块失败 / 为空就记下这段里用户说过的话**照样压掉**——别改回「失败就下轮重试」，那样历史只会越来越大、越来越压不动。
  默认值（2026-10）：压缩阈值 6 万 / 保留 30 条（不超过主模型上下文的六成）；模型没填时上下文 12.8 万、单次输出 8192。
  agent.json 里原样存着旧默认（16000 / 16）的当成没改过、跟新默认走。
  ⑦ **上下文预算**（LRN 2026-10-30，症状「compact 不生效、上下文爆了不回复 / 回复很慢、heartbeat 很费 token」）：
  以前只拿「历史」跟 `max_tokens` 比——系统提示（人设 + 记忆 + 近况）、工具定义、输出预留都没算；压缩后按条数留 30 条，一轮干活的几条大工具结果
  本身就超阈值，压了等于没压；一轮里工具调来调去中途就撑爆。现在：`execute` 先算系统提示和工具定义，阈值 = min(agent 设置, (窗口 − 系统 − 工具 − 输出预留) × 85%)；
  压缩按 token 留最近的（`KEEP_RATIO` × 阈值、至少最近一轮）；`pruneToolResults` 在 `transformContext` 里每次调模型前截短工具结果
  （之前几轮的留 `OLD_TOOL_CHARS`，这一轮单条 `TOOL_RESULT_MAX_CHARS`，总量超预算从这一轮最早的截；库里存原文）；大小一律按 `msgTokens`（含思考）×「截短后」算；
  服务商报超长（`OVERFLOW_RE`）就 `limit: 0` 狠压一次再 `execute` 一次（出错的那轮没落盘，不会重复）；回复后到了阈值七成就 `compactAfterReply` 在会话队列里后台先压（测试里 `backgroundCompact = false`）。
  上下文过半会打一行 `📏 … 系统提示 X + 工具 Y + 历史 Z`。**记忆冲刷不再单独跑**：以前压缩前用整段上下文另跑一轮（一次几万 token），
  现在摘要模型顺手输出「【记住】长期：/今天：」，经 `runtime.remember` 写进 MEMORY.md / 当天笔记（`beforeCompact` 留着但默认不接）。
  **heartbeat 不再跑在 main 会话里**：每半小时把整段主对话重发一遍太费，现在是 `<agent>:heartbeat` 小会话、只留最近 `HEARTBEAT_KEEP` 条，
  **`keepLast` 只能在用户消息处切**（LRN 2026-10-30，症状「heartbeat 一直 400」）：按条数硬切会切在工具调用和结果之间，留下孤儿 toolResult。
  另外 `repairHistory` 在发给模型前去掉没配对的工具调用 / 结果（打 `🩹`），库里不动——**任何新的「截历史」逻辑都要在一轮开头切**。

  主对话最近说了什么靠近况带上。**主动说出去的话要记进接收方会话**（`Runtime.note`）：heartbeat / 定时任务 / 待办汇报投递成功后，
  把那句话以「[heartbeat]（你主动开口…）+ 助手消息」一对记进接收方的会话——设备走 `runtime.sessionKey(agent, "device", dev)`，
  IM 走 `ChannelManager.sessionFor(target)`（`channels_sessions.json` 记着每个聊天实际用的会话，主人私聊开了 owner_main 就是 main）。
  不记的话主人在飞书回 heartbeat 的话题，她只能从近况里猜。近况按「agent + 角色 + 文字」去重，同一句不会列两次。
  ⑥ **内部小任务关思考**（`ModelRegistry.quick`，症状「压缩经常超时 / 思考把输出额度占满」）：压缩摘要、长回复压成口语都走 `quick`，
  按服务商地址自动加关思考的字段（MiniMax / DeepSeek / 智谱 → `thinking: {type: "disabled"}`，通义 → `enable_thinking: false`），经 pi-ai 的
  `samplingParams` 原样并进请求体；服务商报错里提到这个字段就去掉重试、本次运行不再发；正文里的 `<think>…</think>` 剥掉。
  `ProviderDef.no_thinking` 可手动指定字段或 `false`（不发）。
  **正常对话的思考等级**是每个模型自己的设置（`ModelDef.thinking`：空 = 服务商默认 / off / low / medium / high，管理界面模型表「思考」列），
  agent 每轮走 `ModelRegistry.chatStream`（Agent 的 `streamFn`）按 `thinkingParams` 加字段：MiniMax / 智谱只有开关，DeepSeek 加 `reasoning_effort`，
  通义加 `thinking_budget`，认不出的服务商「关」就不发（别乱发不认识的字段）。**思考在这几家都算进 max_tokens，改不了**——所以 `max_tokens` 的含义是
  「回复本身的上限」，请求时另加 `THINK_RESERVE`（默认 +4k / 低 +2k / 中 +6k / 高 +16k / 关 0），思考就挤不掉回复。
- **工具权限按场景（`agent/toolpolicy.ts`，`Runtime.toolsFor` 里 `toolAllowed(sceneOf(scope), …)`，LRN 2026-10-30 安全检查）**：
  以前是「默认都给、危险的各自 `if (!scope.trusted)` 拦」，漏拦一个就是一个洞——查出群聊陌生人能 `take_photo`（照片发回群里）、`get_presence`、
  `sessions_history` 读主人聊天、`photo_schedule_add` / `cron_add`、`web_fetch` 读本机管理接口。现在 **guest 默认什么都不给，只放 `POLICY.guest` 白名单**
  （默认 web_search / web_fetch / skill_read / set_volume），`guestLocked` 里的（家里设备、隐私、执行代码、替主人花额度）配置也加不上；
  扩展 / MCP 的工具提供者在不可信时本来就只给 `allowUntrusted` 的，这里照放、可单独关。其它场景默认全给，`deny` 按场景关。
  `config.json` 的 `tool_policy`，管理界面 Agents → 工具与技能 →「按场景」。各工具里原来的可信判断保留（双保险）。**新加内置工具不用做什么就不会给陌生人**；
  要给就进白名单，碰隐私的加进 `guestLocked`。扩展必须用 `addTools(p, { plugin: true })` 注册，否则会被当内置工具、陌生人那边被白名单挡掉。
  **`web_fetch` 不去本机 / 局域网**（`isPrivateIp` / `assertPublic`）：域名先解析、重定向自己一跳跳跟且每跳都查——从本机发的请求算 `isLocal`，不拦就能借它读管理接口。
- **人设文件按场景加载（`soul.ts` 的 `LOADOUT` / `sceneOf`，LRN 2026-10-27，症状「群聊陌生人的上下文里有主人的 USER / MEMORY / 笔记」「干活也背着整篇人设」）**：
  场景 = owner（主人对话）/ guest（不可信：群聊、陌生人，**不管 purpose 一律算它**）/ heartbeat / cron / task / sub / a2a，每个场景一组文件（含 HEARTBEAT.md、daily=今昨笔记），
  `config.json` 的 `prompt_files` 可改（管理界面 Agents → 人设文件 →「加载场景」）。**guest 永远拿不到 `PRIVATE_FILES`（USER / MEMORY / daily）**，配置也加不上；
  记忆工具（memory_search / get / write）也只给可信会话——陌生人既能套话、也能往记忆里塞东西。没加载的文件在 `<not_loaded>` 里点名（guest 不提），
  `memory_get` 能读所有人设文件。HEARTBEAT.md 现在走场景表，别再在 scheduler 里用 extraSystem 另塞一遍。加载的文件仍是整篇注入（每个上限 `BUDGETS`）。
  **三种加载方式 + 长期记忆改检索**（LRN 2026-10-30，症状「AGENTS / TOOLS / MEMORY 全量注入，上下文大头」）：每格是全文 `X.md` / 目录 `X.md:toc`（`tocOf`：只放各节标题和行号，用到时 memory_get 读那节；`TOC_FILES` 才能选）/ 不加载。
  默认 TOOLS 在主人对话 / 定时任务 / agent 间只放目录（待办、子任务要干活，给全文）。**MEMORY.md 只有 heartbeat 带全文**，其它场景由 `Runtime.recallFor` 每轮拿主人这句话检索（`MemoryIndex.recall`：
  先从这句话里抠掉常用词（`STOP_TERMS`）再切两字词、再去掉在记忆里到处都是的（出现在超过 15% 的块里）；中 2 个，或中 1 个很少见的（≤2 块），或向量 ≥0.5；最多 5 条 / 1200 字；**清单每一项单独成块**（`chunkMarkdown`，改切块要加 `CHUNKER_VERSION`，旧索引自动重建），**只检索 MEMORY.md**——每日笔记记的是当时的事，混进来模型分不清哪天、会当成现在（LRN 2026-10-30），旧笔记由 agent 自己 memory_search；最多等 `RECALL_WAIT_MS`），以 `RECALL_TAG` 开头附在**这一轮用户消息**里——不进系统提示（前缀缓存），
  落盘前 `stripRecall` 去掉。关于主人本人的稳定信息走常驻的 USER.md：压缩摘要的「【记住】主人：」和 `memory_write target=user` 追加到 USER.md 末尾 `USER_AUTO_HEAD` 那节，
  去重、上限 `USER_AUTO_MAX`，满了改记 MEMORY.md 并打日志，不碰手写部分。旧版整表保存过的默认（`OLD_DEFAULT`）当没改过、跟新默认走。
- **近况（`Runtime.recentActivity`，LRN 2026-10-26，症状「heartbeat / 主动聊天老问已经说过的事；换个 agent 又问一遍」）**：
  每个会话只看得见自己的历史——飞书私聊（没开 owner_main 时）、网页聊天、独立定时任务、别的 agent 各说各的，跨会话以前只能靠 agent 自己写记忆文件。
  现在每轮（只给可信会话、不给子任务 / 记忆冲刷）从库里摘最近 `RECENT_HOURS`（48）小时、**别处**跟主人的往来：本 agent 的其它会话 + 其他 agent 的，
  按时间排、每条截 160 字、总量 `BUDGETS.recent`（4000 字，`prompt_budgets.recent` 可调，0 = 关），作为 `<recent_activity>` 放进系统提示，明说「说过的别再问、别再重复」。
  只摘「主人参与的会话」：`sessions.owner`（可信的一轮跑过就标上）或主会话 / 设备 / 网页；**陌生人、群聊的对话不混进来，不可信会话也拿不到近况**——别放宽，
  否则就是把主人的事讲给路人听。heartbeat 们的「用户消息」（`[heartbeat]` / `[定时任务` 等）不算主人说的话。零额外模型调用。
- **设备文件同步（`ota.py`，管理界面「设备 → 图片与代码」）**：服务端 `server/src/devicefiles.ts` 存
  `<数据目录>/device_files/`（自定义）+ 构建时打进来的 `device/src`（`virtual:device-fw`，版本 = 服务端版本）；
  MQTT `{"action":"sync","scope":"res|code|all"}` → 设备空闲时 `GET /device/files` 拿清单（路径/大小/sha256）
  → 只下变了的 → `POST /device/sync-result` 回报；指纹 `rev` 随心跳 `fw`/`res`/`fwv` 上报。别改坏的点：
  ① 路径白名单两边一致（`src/<名>.py`、`resource/[角色/]<名>.jpg`），`main.py` **故意不能在线更新**——它坏了只能接 USB；
  ② 代码**先全部下载校验成 .new，屏幕确认后**才先写 `data/ota_pending.json` 再换文件（顺序反了中途断电就回滚不了）；
  ③ 回滚在 `device/main.py` 的 `_ota_guard`：起不来或第 4 次开机标记还在就从 `src.bak/` 换回，`ota.tick()` 等心跳成功一次
  才删标记——别提前到 `setup()` 结束，那时还不知道新代码能不能跟服务端说上话；
  ④ `ota_state.json` 只记自己装过的文件，删除只删这些（手动传的文件不碰）；换了图要清 `ui._role_hit`/`_img_missing`；
  ⑤ `rev` 算法两边必须一致（`DeviceFiles.rev` ↔ `ota._rev`），`import_sim` 里专门对过。
  ⑥ **反方向：从设备取回图片**（LRN 2026-10-30，症状「图当初用 File Manager 直接传到设备上，服务端没有，手机页面 / 头像没图、原图也找不到了」）：
  管理界面按钮 → `POST /api/admin/device-files/pull` → MQTT `{"action":"upload_res"}` → 设备空闲时 `ota.upload_res()` 把 flash 上 `resource/[角色/]*.jpg` 逐张
  `POST /device/upload-res` → 最后 `sync-result` 报 `scope: "upload"`。服务端只在点了之后 10 分钟内、受信设备、JPEG、`resource/` 下才收，**已有的不覆盖**（409）；
  设备心跳 `pull: 1` 才显示按钮（旧代码先「更新设备代码」）。
- **待办必须写状态行才算完成**（`tasks.ts` 的 `verdictOf` / `MAX_ROUNDS`，LRN 2026-10-30，症状「报了已完成实际没做完」）：模型说一句「接下来我改 X」就结束本轮、
  输出到上限被截断（`RunResult.stopReason === "length"`）、工具报错了却说搞定了，以前一律记 done。现在最后必须单独一行「状态：完成 / 没做完：… / 需要主人：…」，
  没写或被截断就在同一会话里用 `CONTINUE_PROMPT` 催，最多 `MAX_ROUNDS` 轮、总时长不超过单件上限；只有「完成」是 done，其余 `partial`（汇报照实说「没做完：…」），
  `requeue` 对 partial 默认 `resume`（接着原会话，提示词「[继续待办…]」），否则 `host.reset` 清会话从头来。状态行不进汇报正文。
- **待办 / 延迟执行（`agent/tasks.ts` `TaskQueue`、工具 `tools/tasks.ts`、管理界面「待办」，LRN 2026-10-27）**：白天遇到改代码这类大而不急的活，
  agent 用 `task_add` 记下（只在可信会话里有；执行待办的那一轮、子任务里没有），夜间静默时段（默认 01:00-06:00）一件件做，订阅制额度白天留给对话。
  存 system.sqlite 的 `tasks` / `task_settings`。别改坏的点：① **一次只做一件**（`running`），做完 `setImmediate` 接着看下一件——按真实时钟判断时段，测试里要自己逐个 `tick(t)`；
  ② `run_at` 空 = 等静默时段，有值 = 到点就做（不看时段），管理界面「立即执行」= 把 `run_at` 设成现在；③ 执行用全新上下文 `<agent>:task:<id>`、
  `purpose: "task"`、`maxSecs` = 单件上限（`RunRequest.maxSecs` 覆盖全局 max_secs），提示词里明说「主人不在旁边、不可撤回的事别做、最后写汇报」；
  ④ **做完不马上说**：`canReport` = 不在静默时段且过了 `report_at`（默认 08:00），同一来源合成一条，送没送出去都标 `reported`（别每分钟重试）；
  来源是网页 / 管理界面的按 agent 的 heartbeat 投递目标送；⑤ 重启时 `running` 的回到排队，被打断两次算失败。`[待办` 开头的用户消息不算主人说的话（`NOT_OWNER`）。
  `/api/admin/runs` 是「正在运行」，定时任务的运行记录在 `/api/admin/job-runs`（rc.18 起两者同路径、后者一直被盖住，会话页「定时任务消息」是空的）。
- **agent 工作目录可自定义**（`agent.json` 的 `workspace_dir`，`registry.resolveWorkspace`，LRN 2026-10-26）：绝对路径或 `~/…`，空 = `agents/<id>/workspace`。
  人设、记忆、技能、扩展、exec 默认目录都跟着走，`agent.json` / `agent.sqlite` 始终在数据目录。一律用 `AgentInfo.workspace`，**别再自己拼 `agents/<id>/workspace`**。
  改目录：新目录空的就整个复制过去、有东西（如 OpenClaw 工作区）就原样用只补缺的人设，旧目录不删；不能包住数据目录、不能和别的 agent 重叠；
  改完要 `memories.forget`（索引按旧目录建的）。目录用不了（移动盘没插）就退回默认目录并带 `workspace_error`，别让整个 agent 加载失败。
  导出包里一律按默认布局记，读写经 `backup.realPath` 换成本机真实目录；导入时 `workspace_dir` 是本机的事：本机有就保留、没有就删掉用默认。
- **执行命令 / 联网（新服务端内置 agent，`server/src/agent/tools/exec.ts`、`web.ts`）**：`exec` 只在
  `RunScope.trusted` 的会话里出现。可信度的来源：IM 渠道默认不可信，只有渠道白名单里 owner 的私聊显式可信；
  其它渠道可信；嵌套调用（a2a）沿用上层，后台派出的经 `lineage.trusted` 带过去；**不可信会话里 cron_add / cron_update
  的任务标 `untrusted`，跑起来也不可信**（管理界面改过才清掉）——新加任何「替别人跑一轮」的入口都要把可信度带上，
  漏一处就是让陌生人借道执行命令。联网走 `util/proxy.ts`：配了代理就换全局 dispatcher（含调模型），本机地址直连。
- **扩展 / MCP（`server/src/agent/extensions.ts`、`mcp.ts`）**：扩展是 pi 格式（`export default (pi) => pi.registerTool(...)`），
  运行时 sucrase 转译 + `vm.compileFunction`，`@earendil-works/pi-ai`/`typebox` 走内置 shim（打包后没有 node_modules）。
  扩展工具、MCP 工具、`extension_*` 自写工具**都按 `exec` 同一条可信度规则**——它们本质上就是任意代码执行；
  只有工具自己标 `allowUntrusted` / 服务器配置 `allowUntrusted` 才放给不可信会话。`toolsFor` 按名字去重、内置优先，
  别让扩展覆盖 `exec` 之类的内置工具——扩展 / MCP 的提供者用 `addTools(p, { plugin: true })` 注册，
  永远排在内置之后（设备工具是后注册的，不分开排的话扩展里的 `speak` 会盖掉内置的）。新工具从下一轮对话起生效。
  **pi 扩展包**（`packages.ts`）：单文件可执行里没有 npm，自带最小安装器（semver + sha512 + 冲突嵌套，不跑安装脚本）；
  依赖也走扩展加载器（`resolveBare` 自己解析 exports，`import.meta` 换成注入的对象），这样纯 ESM 包也能转译加载。
  宿主包（pi-ai / pi-coding-agent / pi-tui / typebox）一律换内置 shim，pi-tui 与 pi-coding-agent 里没实现的导出拿到不报错、调用才报。
- **日志与 Windows 托盘（`util/logfile.ts` / `tray.ts`）**：控制台照常输出，同时 tee 到 `<数据目录>/logs/kagura.log`，5MB 滚动、留 3 份。
  `--tray` 用 `Start-Process -WindowStyle Hidden` 起隐藏子进程（**别直接 spawn**：子进程会挂在父控制台上，父进程一退就被关掉；
  且 SEA 的 `process.argv` 有时会多带一次 exe 路径，必须过滤，否则会被当子命令报错）。
  子进程起服务端后用 PowerShell NotifyIcon 出托盘：打开管理页面 / 打开日志 / 重启 / 退出；退出走 `POST /api/admin/quit`。
  托盘脚本写成 `<数据目录>/logs/tray.ps1`（UTF-16 带 BOM），再用 `Start-Process -File` 起独立隐藏进程——
  **别用 spawn + -EncodedCommand**：实测子进程秒退 code=0、什么都不做；脚本里 `[ref]$created` 前必须先 `$created = $false`，否则 PowerShell 报「无法将 [ref] 应用于不存在的变量」。
  托盘用 `Global\\KaguraTrayMutex` 防重复；定时轮询 `/api/admin/meta`，服务端没了就自己消失。
  隐藏进程设 `KAGURA_NO_PROMPT=1`，preflight 和出错后的「按回车」都不再等待（否则没有窗口时会永久卡住）。
- **出口（`agent/outbox.ts`，LRN 2026-10-23，症状「飞书聊天时有时播语音有时不播，要提醒才播」「设备显示小澪却用神乐的声音说话」）**：
  **agent 没有 speak 工具**（只有 `announce`：主人明确让「跟家里说一声」时用，只在可信的非设备会话里有，`relay` 不看在家状态、角色不对也立即播、`never` 仍不播；
  这一轮调过就不再 mirror，免得播两遍），播不播完全是系统的事：agent 发给主人的每条消息——主人 IM 私聊 / 网页聊天的回复（`mirror`：`Runtime.spoken` 去格式后不超过 agent 的 `voice_max_chars`×1.2 直接念，
  更长的用便宜模型压成口语，失败退回截断；按策略不播时不去调模型）、
  定时任务 / heartbeat（投 `device:` 只播；投 IM / webchat 发文字再 mirror）、子任务结果、提醒、定时拍照识别——都经 `Outbox.say()`。
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
- **手机 / 平板客户端（`web/app.html` = `/app`，`server/src/clients.ts`、`routes/client.ts`，LRN 2026-10-24）**：手机是和 CoreS3 并列的一台设备
  （设备 id `phone-xxxxxx`），对话走同一套 `/chat` / `/chat-vision` / 异步长轮询，「看家」页用监控接口远程看 CoreS3。三个别改坏的点：
  ① **鉴权靠配对令牌**（管理界面扫码发，`clients.json` 只存哈希）：`ctx.deviceTrusted` 里令牌判据放在 Origin 判据**之前**（手机是浏览器），
  且令牌只给它自己的 id 受信（不能拿手机令牌冒充 CoreS3）；`ctx.tokenOk` 也认令牌（看家页要用监控接口，`<img>` 设不了头所以收 `?ct=`）；
  ② **推送走 SSE**（`/client/events`）：浏览器连不了 MQTT，`MqttHub.taps` 把每条发布抄给 `Clients.onPublish`，`kagura/push|cmd/<手机 id>` 转过去——
  新加发给设备的命令照常 `mqtt.publish` 就行，手机自动收到。**出口选设备**（`Outbox.target`）：在线 = 心跳没断的设备 + SSE 连着的手机
  （页面离开前台就主动断开，iOS 后台连接会挂着却收不到）；推给绑定说话角色的设备，同样合适时家里的优先（在家不两边一起响）；
  手机 `portable`，不受「不在家不播」限制（不在家时主动说的话去开着的手机），但不收 mirror / relay；
  ③ `/chat-vision` 纯文字只对配对过的手机放行（设备那边「wav 或 image 必须有一个」是新旧两版共用的契约）。
  浏览器只在 HTTPS 下让网页录音（`getUserMedia`）：局域网 http 下打字、听回复（Web Audio 不受限）、SSE 推送、拍照（`<input capture>` 走系统相机）、
  看家都正常，只有「按住说话」不行——README 推荐 Tailscale `tailscale serve`。
  **iOS 声音**（症状「看到回复、浏览器有小喇叭，手机却没声」）：iOS 的 Web Audio 默认是「环境音」，侧面静音开关一开就静音。
  `unlockAudio()` 在点击 / 抬手里设 `navigator.audioSession.type = "playback"`（iOS 17+）并用 `<audio>` 播一小段静音（老 iOS 靠它切到媒体播放类别）；
  `Player.feed` 先把 16k 重采样到 `AudioContext.sampleRate` 再建 buffer（iOS Safari 对 16k AudioBuffer 挑剔）。别删这两处。
  **声音被系统暂停**（LRN 2026-10-24，症状「发图片加一句话后一直『她在说…』，看得到几个字、没声音」）：去拍照 / 选相册时页面进了后台，
  iOS 把 AudioContext 暂停（suspended / interrupted）；回来用键盘「发送」键发出去，一次都没点屏幕，没人恢复它。暂停时播放时钟不走，
  `Player.drain()` 以前就永远等。现在：解锁也认 `keydown`；`pageshow` / `focus` / 选完照片先试 `resume()`；`drain()` 里恢复不了就亮状态条上的
  「▶ 点我播放」（点它就是那次手势），两分钟没人点就放弃。**新加任何「等播放时钟」的循环都要考虑时钟不走的情况。**
  管理界面里手机和 CoreS3 在同一张设备表（`/api/admin/devices` 带 `kind: "phone"`），配对入口是表上的「＋ 添加手机」。
  舞台图跟着状态换，规则抄设备端 `ui._IMG_MAP`（待机 img_bg / 录音 img_recording / 思考 img_streaming / 说话 img_playing，角色目录优先、缺了退 img_bg）——
  改设备端的映射要同步改 `app.html` 的 `IMG_MAP`；图预先解码好、复用同一个 `<img>` 换 src。
  **手机有自己的一套图**（界面上别写「CoreS3」，硬件设备不止这一种，统称「硬件设备」；也别加大段说明小字）（`server/src/appimages.ts`，`<数据目录>/app_images/[角色/]<图名>.<jpg|png|webp>`，LRN 2026-10-26）：CoreS3 那套受设备内存所限是 320×240 JPEG，
  手机屏幕大、竖着拿，两套分开存，手机这套不裁、不限比例、单张 4MB。手机只请求 `GET /app/img?role=&name=`，**挑图在服务端 `resolve`**：
  先角色的、再默认的（角色对不上比画质差更糟）；同一层手机的优先；手机这套缺了某个状态用手机这套的待机图（别和 320×240 的混着闪）；再退 CoreS3 那套。
  改这个顺序要同步管理界面 `PhoneImages.fallback`。入口：手机右上角「形象」（`/client/images`，配对令牌）、管理界面「设备 → 图片与代码」切到「手机 / 平板」。
  任一套图变了都经 SSE 发 `{"action":"images"}`，开着的页面清 `imgCache` 重取；舞台高度跟着待机图比例走（`applyRatio`，竖图最多 54vh）。
  聊天里的相机键是「拍照 / 从相册选」底部菜单（`chooseImage`），她说「我看看」那条只开相机。导出项「device」含 app_images。
  布局：清晰的角色图按 4:3 放顶上（`--stage-h`），聊天从它下面开始（`.stagegap`）、不压着她；底色是同一张待机图放大糊开压暗（`#bgAmb`），颜色跟着角色走，别再写死成某个色调。
  **摇一摇**同 CoreS3 彩蛋：`devicemotion` 去重力后 700ms 内 3 下 → 换 `img_shake`、`GET /shake`，回复走推送（推给手机的通知带 `text`，页面显示成她的一条消息）。
  动作传感器只在 https 下有；iOS / 新版 Chrome 要在一次点击里 `DeviceMotionEvent.requestPermission()`——挂在 `unlockAudio` 上，**`pointerdown` 里申请不算数**。
- **管理接口与设备信任（`routes/admin.ts` 的 `isLocal`、`ctx.deviceTrusted`，LRN 2026-10-23 安全检查）**：
  ① 管理接口光看「来源是 127.0.0.1」不够——你电脑上任何网页都能让浏览器往 127.0.0.1 发请求（跨站请求伪造），
  DNS 重绑定还能绕过同源。`isLocal` 同时要求 Host 是本机地址、跨站的 Origin / `Sec-Fetch-Site: cross-site` 一律拒绝
  （顶层导航 GET 例外）。**新加管理接口一律走 guard，别自己判断来源**——漏了就是网页一键装扩展包、执行命令。
  ② 设备上行接口（/chat 等）固件不带口令，同一 WiFi 谁都能冒充设备；而设备对话是可信的（能 exec）。所以
  `deviceTrusted`：第一台心跳的设备自动受信，之后的新设备要在管理界面批准，且请求 IP 必须是它心跳的 IP；
  带 Origin / Sec-Fetch-* 的（浏览器发的）一律不受信。新加「设备触发 agent」的入口要把 `trusted: ctx.deviceTrusted(req, dev)` 传进去。
  WSL + portproxy 下所有局域网请求看起来都来自同一个 Windows 地址，IP 绑定在那里形同虚设（已在 README 说明）。
- **Windows 托盘版（`kagura-tray.exe`）**：和 `kagura.exe` 是同一个文件，只把 PE 头的子系统改成「图形界面」
  （`scripts/gui-exe.mjs`），启动根本不建控制台窗口。别再回到「先开窗口、PowerShell 拉起隐藏进程」的做法——
  Windows 11 默认用 Windows Terminal 托管控制台，隐藏参数经常被无视（beta.17/18 就栽在这）。托盘版里 console 看不见
  （Node 自动丢弃输出，日志靠 `logs/kagura.log`），不能停下来问人（`KAGURA_NO_PROMPT`），出错要 `messageBox` 弹框；
  它派生的子进程都要 `windowsHide: true`，否则每跑一次命令就闪一个黑窗口。CI（server.yml / release.yml）有托盘版冒烟。
- **导出 / 导入（`backup.ts`）与在线更新（`util/selfupdate.ts`）**：导入**绝不能在运行中直接覆盖数据库**——
  写到 `.import-pending/`，重启后 `main()` 第一件事 `applyPending()`（在 loadConfig 之后、任何 DatabaseSync 之前）。
  导出数据库用 `VACUUM INTO` 拍快照（WAL 里的也在），不用停服务。新加数据目录里的东西时记得在 `catalog`/`filesOf`/`itemOf`
  三处登记，不然导出时就悄悄漏掉；带密钥的文件要在 `stripFile` 里清空、在 `applyPending` 里「空着就保留本机的」。
  在线更新：Windows 由一个独立的隐藏 PowerShell 跑安装包再拉起托盘版（本进程先退出，安装包会强制结束它）；
  装失败也要把原来的拉起来，不然用户点一下更新服务就没了。下载（LRN 2026-10-24，症状「卡在 1KB 然后 fetch failed」）：安装包实际在
  release-assets.githubusercontent.com，国内常连不上——按「直连 → 加速镜像（`UPDATE_MIRRORS`，`update_mirrors` 可覆盖）」依次试，
  断点续传、30 秒没数据换源、后面还有源时速度低于 200KB/s（且照这速度还要 30 秒以上）也换源接着续传（直连 GitHub 常见的是一直几 KB/s 地慢慢给，不是断）；**镜像下的文件只认 GitHub 接口给的 `digest` 校验**，没有 digest 的老发布不走镜像。
  **下载不能走 undici**（`util/nodefetch.ts`，LRN 2026-10-24）：对方 `Connection: close` + 写盘背压暂停时，undici 在 socket end 里 `assert(!this.paused)`
  抛未捕获异常，托盘版进程无声消失（CI 冒烟在 Windows 上抓到，undici 7/8 都在）。用 Node 自带 http/https，代理走 CONNECT 隧道。
  **Windows 安装期间服务端不先退出**：等用户点了 UAC「是」、安装包的 `PrepareToInstall` 才结束它，装完 `run-update.ps1` 再拉起；
  点「否」/ 装失败服务照常运行，进度看 `updates/update.log`（脚本用 Start-Process 起，别 spawn）。release.yml 有 Windows 在线更新冒烟。
  `main()` 装了 `installCrashLogging`：未捕获异常同步写进 kagura.log 再退出——托盘版没控制台，以前这类崩溃一个字都不留。大请求体只对本机来源放宽（`Router.bigBodyPaths`）。
- **优雅退出（`util/shutdown.ts`，LRN 2026-10-24，症状「在线更新之后神乐的飞书十几分钟收不到消息，状态却显示在线」）**：
  以前退出 / 重启 / 更新都是直接结束进程，飞书长连接没断开，飞书把事件继续投给死连接，直到租约过期。现在 `gracefulExit` 先跑 `onShutdown`
  （关 IM 渠道，最多等 3 秒）再退；`/api/admin/quit`、`restartSelf`、SIGINT/SIGTERM 都走它。Windows 安装包的 `PrepareToInstall` 先
  `POST /api/admin/quit`（端口由更新脚本 `/KAGURAPORT=` 传入，手动安装按 5000 试）、等 3 秒，再 taskkill 兜底。**新加要退出进程的地方别直接 `process.exit`。**
  **IM 消息去重**（`channels/seen.ts`，症状「升级完她把之前那几条又回了一遍」）：飞书事件「至少投递一次」，投给死连接 / 没确认的会重投，QQ 重连也补发。
  `ChannelManager` 收到就按「账号 + message_id」查 `channels_seen.json`（留 3 天、最多 3000 条，重启后也记得），见过就跳过（日志 `↩️ 重复投递`）。
  晚到超过 5 分钟的（`InboundMessage.sentAt`，飞书 `create_time`）在消息前注明「这条消息是 N 分钟前发的」，别让 agent 当成刚说的。
- **Agent 通信按会话看（`a2a_log.trace` / `parent`，管理界面 `#/a2a/<trace>`，LRN 2026-10-30）**：一轮对话引出的所有 a2a 调用共用一个 `RunScope.trace`
  （顶层一轮新生成，嵌套 / `lineage` 后台派出 / 子任务结果交回那一轮都经 `RunRequest.trace` 带下去），`a2aCall` = 引起这一轮的那次调用，它再发起的调用记成 `parent`。
  **新加任何「替别的会话跑一轮」的 a2a 入口都要传 `trace` 和 `a2aCall`**，否则那一步会被拆成单独一串。老记录没有 trace，各算一串（`'id' || id`）。
  **接收方不进自己的 main**（`a2aKey` = `<接收方>:a2a:<发起方>`，LRN 2026-10-30）：进 main 会让主人的对话里混进别的 agent 的话、每次背整段主对话、还占着 main 的锁（主人找她要排队、两边容易互等）。
  每对一个会话，和同一个 agent 的往来接得上；发之前 `keepLast(A2A_KEEP)`（在一轮开头切）；主人那边的事靠近况。`sessions_history` 默认仍看对方 main。
  头像（`common.Avatar` / `avatarUrl`）= agent 的 `device_role` 那套角色图的待机图，走 `/app/img?…&strict=1`（只认这个角色自己的目录，不退回默认角色，免得别的 agent 顶着默认角色的脸），没图显示首字。
  **会话页实时弹出**（`a2a.A2ADock`）：`LiveRun.trace` 带着这一轮的会话 id（`execute` 开头先算 `traceId`，start 事件里就有），实时过程里一出现 `sessions_send` / `sessions_spawn`
  就在输入框上方滑出这串调用的动画（**放在卡片里、别用 fixed 盖住输入框**）。对话框（`.card.chat`）整体固定高、消息区 `flex:1` 吃剩下的——**别再给消息区写 max-height**，那样内容少 / 弹面板时框会忽大忽小，每秒刷新；这一轮结束后留着，主人关了同一串就不再弹。历史轮次在 ⓘ 里有「看这一轮的 Agent 通信」（`kctx.a2a`）。
  详情页是回放：每次调用拆成「发出 / 回来」两步，按时间排，SVG 节点（每个 agent 一个，子任务会话单独一个）+ 沿弧线走的光点，下方步骤列表同步高亮，进行中的 3 秒刷新一次接着播。
- **管理界面的长列表**：侧边列表一律用 `ui.SideList`（搜索框、分组折叠、先显示一部分再「再显示」），表格用 `ui.usePage` 分页（每页 20）。
  新加会越积越多的列表 / 记录时直接用这两个，别平铺。
- **新版本提醒（`util/update.ts`）**：启动 30 秒后、之后每 12 小时查一次 GitHub Releases，只提示不安装；
  预览版连预览版一起比，正式版只看正式版。`update_check: false` 关掉。
- **`global` 声明必须有主**（LRN 2026-08-25）：`netsvc.mqtt_check` 里写过
  `global _mqtt_ok`，但本模块从来没有这个名字（状态在 `diag`）。后果是
  **任何一次 MQTT 掉线都变成 NameError 逃出 `mqtt_check`**，主循环连吃 10 次
  就 `machine.reset()`——同样表现为"毫无征兆黑屏重启"，crash_reports 里
  4 份日志全是它。`global X` 会让静态检查把 X 当成已定义，所以
  `tools/check_split.py` 第 5 项专门查这个：被 global 声明却无人赋值 = 报错。
- **崩溃日志取尾不取头**：`crash.log` 是追加的，死因永远在末尾，
  `_boot_report` 却只上传前 8KB——2026-08-11 那份 8KB 日志里一行堆栈都没有，
  全是几天前的 `power-change`。满电涓流会让 `isCharging()` 每几十秒翻一次，
  条条持久化就是拿噪声把证据挤出去，现在只有"电量没满却停充"才写 flash。
- **"设备僵死但没复位"的排查判据**（LRN 2026-08-26，那次停摆 4 小时 51 分，
  从完全空闲的状态僵住，全靠手动上电才回来）：
  ① `crash.log` 里**有没有 `netfix1`**——失联满 10 分钟必写一条，没有就说明
  `net_watch_tick` 压根没执行到，即主循环停摆（不是网络问题）；
  ② 有没有堆栈 = 有没有未捕获异常；③ 崩溃日志的时间跨度能证明中间**有没有
  重启过**（重启会上传并删除它）。三条都空 = 主循环卡死且看门狗没救它。
- **看门狗武装失败必须回退，而且必须能被远程看见**：`_wdt_init` 旧实现构造
  失败只 print 一行就把 `_wdt` 留成 `None`——整台设备失去硬件自愈能力，
  远程完全看不出来。现在依次试 `WATCHDOG_TIMEOUT_MS` 和 120000（8 月上旬
  真机产生过"看门狗复位"的已知可用值），结果记进 `hw._wdt_ms` 随心跳上报，
  服务端日志与 `/device-status` 直接显示 `wdt=180s` / `wdt=⚠️未武装`。
  **改 `WATCHDOG_TIMEOUT_MS` 之后务必看一眼心跳里的 wdt**——固件对上限
  有没有自己的限制无从预知，改大了却被拒 = 悄悄卸掉了看门狗。
- **死人开关（`hw._deadman_check`，判据放在喂狗点上）**：失联超过
  `DEADMAN_SECS`（30 分钟，故意大于 netfix2 的 25 分钟，主循环还活着时优先
  走正常分级自愈）就自己复位，复位前往 `crash.log` 写一行
  `deadman (stuck at <阶段>, dead=<秒>)`。**为什么判据在 `_wdt_feed()` 里**：
  8/26 那次僵死，看门狗武装着 180 秒却一次没响——卡住的循环一边转一边喂狗，
  而 netfix1/netfix2 都要主循环跑到 `net_watch_tick` 才有机会执行，三道自愈
  全都够不着。`_wdt_feed()` 是唯一一个在每个这种循环里都还在转的函数，
  判据放这儿，以后新写的"喂狗死循环"也自动被兜住。两个实现要点：
  ① 必须用 `ticks_ms` 而非 `time.time()`——`clock.sync_rtc()` 会把墙钟往前跳
  好几年，拿墙钟算年龄一开机就判超时；② 开机门槛用**一次性闩锁**
  （`_deadman_armed`），不是每次比对开机时刻——`ticks_diff` 只在约 6.2 天内
  有效，连续跑一周后拿它算 uptime 会翻负，兜底就悄悄失效了。
  阶段标记 `cfg.St.stage` 由主循环每轮复位成 `loop`，各长循环入口自己改写
  （`rec`/`dl`/`play`/`cam`/`stream`/`chat`）——卡住时主循环轮不到复位，
  标记正好停在卡住的那一段上。
- **纯硬件条件的等待一律要有上限并喂狗**：`drain_touch()` 曾是
  `while M5.Touch.getCount() > 0` 死等且一次不喂狗——屏上压个东西、驱动漏报
  一次抬手，就是"主循环停摆 + 看门狗饿不死它"的配方。写这类循环前先问一句
  "硬件永远不给我想要的状态会怎样"。
- **网络自愈的判据只看 `dead_for`（多久没成功联系上服务端），绝不能加
  `wifi_ok` / `_mqtt_ok` 前置条件**。曾经加过，结果 2026-08-21 那次失联
  79 分钟自愈一次都没触发：WiFi 驱动 wedge 的典型表现就是 `isconnected()`
  仍返回 True、MQTT socket 也还在，设备自认为健康，可包一个都出不去
  （服务端记的正是 `mqtt=True`）。**"自己看起来好不好"不可信，
  "服务端还认不认得我"才是唯一可信的判据。**
  看门狗也救不了这种情况——主循环活得好好的，一直在喂狗。
- **录音 VAD**（`snd._record_audio`，LRN 2026-10-18，症状「连续模式说话几乎不触发、
  单次对话识别也差」）。四条别改回去：
  ① **无缝双缓冲**（`MIC_GAPLESS`）：两块缓冲始终排在 `Mic.record` 队列里，
  队首录满（按时间算 + `isRecording()<2` 确认）才取出处理并重新排队。旧版
  「录一块 → sleep(块长+50ms) → 算 RMS → 再录」每 250ms 丢约 80ms，上传的
  语音断断续续；② **字头预录** `PREROLL_CHUNKS`：只从过门槛那块开始存会把
  "你好"的"你"切掉；③ **开机校准取中位数**、丢开麦前 3 段、封顶
  `VAD_MAX_THRESHOLD`，`rms()` 去直流——旧版取最大值×3，一段开麦爆音就能
  把门槛抬到说话够不着；④ 连续模式播完**直接进下一轮录音**，旧版 1.5 秒
  长按退出窗口期间麦克风是关的（录音循环本身就认长按退出）。
  排查口径：心跳带 `vad=[底噪,说话,唤醒]`；每次录音写一条 `rec n=… peak=… th=…
  tmo=… late=…` 诊断日志（`late>0` = 处理跟不上出了缝，`tmo` 多 = 固件
  `isRecording` 语义不符、退回按时间判）；服务端每条录音打印 `🎙️ rms/peak/clip/dc`，
  百度报错打印 `err_no`，最近一条录音存 `debug_audio/<dev>_last.wav`，
  `GET /debug-audio/<dev>`（设了 API_TOKEN 就带 `?token=`）直接在浏览器试听——
  **先听这条录音，糊 = 设备端问题，清楚却认不出 = ASR 问题。**
  识别为空时 `/chat` 直接回 `_ASR_EMPTY_REPLY`，不走 OpenClaw。
  **录音上限 30 秒**（`MAX_CHUNKS=120`，原 10 秒说一半就被截断），停顿 1.5 秒收尾
  （`SILENCE_CHUNKS=6`）。录音直接写进开机预留的整块缓冲 `snd._rec_buf`
  （`alloc_rec_buf()`，分配不到降级 20/10 秒），`_record_audio` 返回指向它的
  WAV memoryview，**下一次录音会覆盖**——上传/转 base64 之后才能再录。
  别改回逐块 `bytes()` + `join` + 拼头：30 秒录音那样要三份近 1MB。上传直接传
  memoryview（`chat._post_wav`，固件不认就退回 bytes）。说满上限时 rec 日志带 `CUT`。
- **`/chat` 超时**（LRN 2026-10-18，症状「回答一长就不播，设备 `network err: ETIMEDOUT`，
  服务端却打印了 `📤 WAV`」）：设备 `REQUEST_TIMEOUT_CHAT` 原为 30s，而 OpenClaw
  允许 120s，长回答 LLM + TTS 轻松超 30s——服务端照常发、设备早已放弃。现为 60s，
  服务端 `_DEVICE_CHAT_TIMEOUT` 要同步改；每条回复打印 `⏱️ asr/llm/tts/总`，
  超时会标 ⚠️。别随手再加大：阻塞期间发不了 MQTT ping（发请求前已
  `netsvc.mqtt_ping()` 清零计时），broker 约 90s 收不到包就断。
- **openclaw 并发**：`chat()` 有全局 Semaphore(2) + 每 session 串行锁。
- **摄像头固件差异**：抓帧走 `_cam_grab()`（优先 `camera.capture()`→bytes，
  回退 `camera.snapshot()`→`image.Image`），预览走 `_cam_show()`（优先
  `Lcd.drawRawBuf`，回退 `Lcd.show`，探测一次后固定）。帧是 raw RGB565，
  分辨率靠字节数反查 `_CAM_SIZES`——改这张表要同步服务端 `RGB565_SIZES`。
- **回退开关**（设备端顶部常量）：`WAKE_MIC_PERSISTENT`、`WATCHDOG_ENABLED`、
  `SHOW_CHAT_TEXT`、`VISUAL_ENABLED`、`USE_STATE_IMAGES`、`CAMERA_MODE_ENABLED`、
  `CAMERA_QVGA`、`PREVIEW_SWAP`、`MIC_GAPLESS`、`PLAY_STREAMING`、
  `HANDS_FREE_TH_RATIO`（改 1.0 = 免手模式不加门槛）、`STREAM_ENABLED`、`STREAM_QQVGA`、
  `TOUCH_FEEL_ENABLED`（整个触觉）、`FEEL_NOTIFY_ENABLED`（只关"主动开口"，
  保留反射层和体感层）、`FEEL_WAKE_ON_PICKUP`
  ——真机出问题先关开关再排查。

## 设备端模块结构（device/src）

依赖分层，**必须保持无环**（`tools/check_split.py` 会检查）：

```
cfg → hw → clock → ui → {wifisetup, snd} → cam → feel
    → diag → ota → netsvc → stream → chat → app
```

| 模块 | 职责 |
|---|---|
| `cfg` | 常量、回退开关、目录助手、`St`/`Feel` 状态类。不 import 任何 kagura 模块 |
| `hw` | LED/看门狗/麦克风/音量/RMS/触摸（含抚摸轨迹）/绘图原语 |
| `clock` | RTC 同步与读取。单独成模块是为打断 ui ↔ netsvc 环 |
| `ui` | 字体、环形可视化、离屏画布合成 `draw_state`、息屏唤醒 |
| `wifisetup` | 屏上配网（SSID 选择 + 软键盘），最自洽的一块 |
| `snd` | 录音 VAD、播放、包络、噪声校准。**不能叫 audio**——UIFlow2 固件里有同名冻结模块，冻结模块优先级在 sys.path 之前，我们的文件根本加载不到 |
| `cam` | 抓帧/预览/取景模式/拍照上传。**不能叫 camera**——MicroPython 的摄像头驱动就叫这名，同名会 import 到自己 |
| `feel` | 触觉三层 + IMU 本体感觉 |
| `diag` | 事件环形日志、崩溃上报、心跳遥测、网络分级自愈、画布探测 |
| `ota` | 设备文件同步：管理界面传的图 / 代码，校验、屏幕确认、回滚标记 |
| `netsvc` | MQTT、BLE 感知、UDP 发现 |
| `stream` | 摄像头直播推流与直播中插拍 |
| `chat` | 主对话、模式切换、IMU 摇晃彩蛋 |
| `app` | `setup()` / `loop()` / `main()`（含崩溃守护循环） |

> **模块命名踩过两次**（`camera` 撞驱动、`audio` 撞固件冻结模块），症状一模一样：
> **代码明明改了、也确实传上去了，设备行为却还是旧的**——因为固件里的冻结模块
> 优先级在 `sys.path` 之前，磁盘上那份根本没被加载，而且不报任何错。
> 新增模块取名前先在 REPL 验一句：
> `import 名字 as m; print(getattr(m, "__file__", "FROZEN——换个名字"))`

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

- `snd ↔ netsvc`（`play_wav` 要 `mqtt_check` 维持心跳、push 又要回调
  `play_wav`）→ `snd.set_pump(netsvc.mqtt_check)`。取景循环也要泵 MQTT，
  走同一个注入点（`snd._pump_safe()`），别再开第二个。
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
- 运行时产物（`push_audio/`、`tts_cache/`、`snapshots/`、`debug_audio/`、`roles_state.json`、`reminders.json`、
  `photo_schedules.json`）已 gitignore，勿提交。
- 设备目录：`/flash/kagura/src`（代码）、`/flash/kagura/resource`（图片，
  用 `cfg.res()` 取路径）、`/flash/kagura/data`（运行时状态，`cfg.data()`，
  `cfg.ensure_dirs()` 自动创建）。新增文件路径一律走这两个助手，别硬编码。
