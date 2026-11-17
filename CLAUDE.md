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
- 服务端只有 `server/` 这一版。早期的 Python 版（`voice_server.py` 等）已于 2026-11 删除（最后带着它的版本是 `v1.0.0-rc.51`）；
  `docs/lrn/` 里有些早期条目还用着它的函数名（`_send_push`、`_capture_and_wait`、`stream_server.SOCKET_TIMEOUT` 等），
  机制没变，对应实现在 `server/src/`（`ctx.sendPush`、`routes/`、`stream.ts`、`shortcut/`、`jobs/`）。

## 文件

| 文件 | 说明 |
|---|---|
| `server/` | **服务端（主线）**：单文件可执行、内置 MQTT broker、内置 agent 系统（基于 pi：记忆、定时任务、heartbeat、agent 间通信、技能、扩展 / 扩展包 / MCP）、IM 渠道（飞书/QQ）、本机管理界面 `/admin`、Windows 托盘版。见 `server/README.md`、`docs/plan-kagura-agent.md`。|
| `device/src/*.py` | CoreS3 固件（**MicroPython**，不能用 CPython 特性/typing；改后需真机烧录验证） |
| `device/main.py` | 烧成 `/flash/main.py` 的引导：把 `/flash/kagura/src` 加进 sys.path |
| `web/monitor.html` | Web 监控页（单文件，无外部依赖）。构建时内联进服务端，`/monitor` 直出 |
| `web/app.html` | 手机 / 平板网页客户端（单文件，无外部依赖），`/app` 直出：对话 + 看家 |
| `contract-tests/` | 黑盒契约测试（Python + pytest）：起打包好的服务端，只走 HTTP / MQTT / UDP / TCP；`KAGURA_BRAIN=pi` 再跑一轮内置 agent |
| `openclaw-startup.ps1`、`discovery_relay.ps1` | 只给「服务端跑在 WSL 里」的用法：Windows 侧端口转发、UDP 发现中继 |

## 踩坑记录（改动前必读对应的那一份）

每个子系统的机制和「别改坏的点」在 `docs/lrn/` 下，**动哪块之前先把那一份读完**——里面每一条都是真机 / 线上踩出来的，
代码里看着多余的判断多半对应着其中一条。新踩的坑记进对应的文件（症状、原因、别改坏的点），不要再堆回这里。

| 文件 | 什么时候读 | 里面有 |
|---|---|---|
| [`docs/lrn/protocol.md`](docs/lrn/protocol.md) | 改 /chat、/chat-vision、响应头、MQTT 命令、角色切换、短路链、边生成边播、异步对话前 | 短路链 · 角色切换 · 免手模式 · 语音合成失败不能让整个请求报错 · 响应头协议 · 带图的那一轮不给 take_photo · /chat-vision 三种入参形态 · MQTT topic · WSL 端口转发 · 拍照两条路径 · 定时拍照 · 边生成边播 · 异步对话 · /chat 超时 · openclaw 并发 |
| [`docs/lrn/camera-stream.md`](docs/lrn/camera-stream.md) | 改直播推流、监控页画面、拍照取帧前 | 直播链路 · 推流必须复制帧 · 网页画面「频闪」查过一次，不在设备端 · 直播分辨率 · 摄像头固件差异 |
| [`docs/lrn/device-ui.md`](docs/lrn/device-ui.md) | 改 draw_state、图片资源、触摸手势、触觉三层、IMU 前 | 设备端状态 · 图片资源 · 触觉三层 · 触摸屏的双重身份 · IMU 一次采样喂两个检测器 · 屏幕渲染 · 离屏画布合成 · _ui_invalidate · 环形可视化 · 音频响应 · 设备线程能力 |
| [`docs/lrn/device-audio.md`](docs/lrn/device-audio.md) | 改录音 VAD、播放（落盘 / 边下边播）、推送播放、插话前 | push 去重 hack · MQTT 回调只入队 · 长音频播放：整条链路都得喂狗，别再用 resp.content · 边下边播 · 录音 VAD · 插话 |
| [`docs/lrn/device-reliability.md`](docs/lrn/device-reliability.md) | 改看门狗、网络自愈、崩溃日志、设备文件同步（OTA），或新写设备端长循环前 | 看门狗 · global 声明必须有主 · 崩溃日志取尾不取头 · "设备僵死但没复位"的排查判据 · 看门狗武装失败必须回退，而且必须能被远程看见 · 死人开关 · 纯硬件条件的等待一律要有上限并喂狗 · 网络自愈的判据只看 dead_for · 设备文件同步 · 回退开关 |
| [`docs/lrn/agent-runtime.md`](docs/lrn/agent-runtime.md) | 改 runtime / 压缩 / 上下文预算 / 单轮上限 / 会话页实时过程 / agent 间通信 / 运行状况前 | agent/runtime.ts 拆过一次 · 会话锁不能被无限占着 · Agent 通信按会话看 · 借鉴 DeepSeek Super-agent 的几处 · 用户消息发出去前合成一段 · 系统提示瘦身 · 运行状况 |
| [`docs/lrn/agent-memory.md`](docs/lrn/agent-memory.md) | 改系统提示组装、人设文件、记忆读写与整理、近况、待办队列、工作目录前 | 人设文件按场景加载 · 共享人设与系统守则 · 近况 · 待办必须写状态行才算完成 · 待办 / 延迟执行 · agent 工作目录可自定义 · 记忆整理 |
| [`docs/lrn/agent-tools.md`](docs/lrn/agent-tools.md) | 加内置工具、改工具权限、文件 / 执行 / 发文件工具、扩展、MCP 管理器前 | 工具权限按场景 · 执行命令 / 联网 · 发文件给主人 · 文件工具 · 扩展 / MCP · MCP 服务器主动通知 · mcp.json 直接改也生效 · 自带的 MCP 服务器 · 自带 MCP 组件单独更新 |
| [`docs/lrn/voice.md`](docs/lrn/voice.md) | 改 TTS 缓存、推送播报（出口）、语音服务商、朗读版前 | TTS 缓存 · 出口 · 语音服务商 |
| [`docs/lrn/phone.md`](docs/lrn/phone.md) | 改 web/app.html、配对、SSE 推送、手机图片前 | 手机 / 平板客户端 |
| [`docs/lrn/ops.md`](docs/lrn/ops.md) | 加管理接口、改托盘 / 日志 / 在线更新 / 导出导入 / 进程退出 / 管理界面列表前 | 日志与 Windows 托盘 · 管理接口与设备信任 · Windows 托盘版 · 导出 / 导入 · 优雅退出 · 管理界面的长列表 · 新版本提醒 |
| [`docs/lrn/printer-cad.md`](docs/lrn/printer-cad.md) | 改 server/src/printer、blender、cad 前 | 拓竹打印机 = 自带的 MCP 服务器 · Blender 建模 = 自带的 MCP 服务器 · build123d 建模 = 自带的 MCP 服务器 |

### 跨子系统的规矩（最容易漏的）

- **agent 主动说话一律走出口** `Outbox.say()`，别直接 `ctx.sendPush`；合成语音传 `roleVoice(role)`，别只传 `per`（→ voice.md）。
- **新加管理接口走 `guard`**；设备触发 agent 的入口传 `trusted: ctx.deviceTrusted(req, dev)`；「替别人跑一轮」的入口把可信度带上（→ ops.md、agent-tools.md）。
- **在会话锁里 await 的东西都要有时限、能取消**；后台替她跑一轮的入口传 `signal: scope.cancel`，a2a 入口传 `trace` / `a2aCall`（→ agent-runtime.md）。
- **附在用户消息里的系统块**（回忆、备注）放在主人的话前面、落盘前去掉；`kctx` / `ksrc` 发给模型前去掉；截历史只能在一轮开头切（→ agent-runtime.md）。
- **新加内置工具**默认不给陌生人；想清楚进不进按需加载的组；扩展 / MCP 的工具用 `addTools(p, { plugin: true })`（→ agent-tools.md）。
- **外部设备 / 服务做成 MCP 服务器**（要主动说话用 `notify`，要她自己看了再说用 `wake`），别往核心里加模块；打印机、Blender、build123d 是独立组件（→ printer-cad.md）。
- **数据目录里新加的文件**要在 `backup.ts` 的 `catalog` / `filesOf` / `itemOf` 登记；**退出进程**走 `gracefulExit`，别直接 `process.exit`（→ ops.md）。
- **新加兜底 / 降级逻辑**顺手 `health.record` 一条，不然总览上看不出它在起作用（→ agent-runtime.md）。
- **设备端**：长循环里 `hw._wdt_feed()`、纯硬件条件的等待要有上限；会直接铺满屏幕的地方先 `_ui_invalidate()`；出问题先关回退开关（→ device-reliability.md、device-ui.md）。
- **改了设备协议**（响应头、状态码、流式音频、MQTT 命令）：两头一起改，跑契约测试和 `tools/device_e2e.py`（→ protocol.md）。

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

设备端最初是从单文件版（`cores3_client.py`，已删除）用生成器拆出来的，现在 `device/src/` 就是源头，直接改。

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
cd server && npm ci && npx tsc --noEmit -p . && npx tsc --noEmit -p admin-ui && npx vitest run   # 类型检查 + 单测
node scripts/build.mjs           # 打出 dist/kagura.cjs（契约测试测的是它）
cd ../contract-tests && pip install -r requirements.txt
KAGURA_SERVER_CMD="node server/dist/kagura.cjs" python -m pytest -q                  # OpenClaw 适配器（假的）
KAGURA_BRAIN=pi KAGURA_SERVER_CMD="node server/dist/kagura.cjs" python -m pytest -q  # 内置 agent
cd .. && python3 tools/check_split.py     # 设备端静态校验（5 项）
python3 tools/import_sim.py      # 桩件环境下真的 import 一遍设备模块
KAGURA_SERVER_CMD="node server/dist/kagura.cjs" python3 tools/device_e2e.py   # 真的设备代码（硬件打桩）对着真服务端跑对话
# 监控页 JS 语法检查（node --check 只认真实文件，不能用进程替换）
python3 -c "import re;open('/tmp/m.js','w').write(re.search(r'<script>(.*)</script>', \
  open('web/monitor.html').read(), re.S).group(1))" && node --check /tmp/m.js
```

- 服务端改动必须跑 vitest；碰到设备协议（路由、响应头、MQTT、直播）的再跑契约测试——它起的是构建产物，**改完先重新 build**。
- 设备端无法本地运行，但有两层静态兜底（CI 也跑）：
  - `tools/check_split.py`：名字解析、import 无环、可变全局导入方式、
    跨模块 `mod.attr` 是否悬空、`global` 声明是否有主；固件星号导入提供的名字（`Lcd`、`Mic` 等）
    登记在脚本的 `baseline` 里，用到新的要加
  - `tools/import_sim.py`：用桩件模拟 M5/MicroPython 环境**真的 import 一遍**，
    并验证 `rms`/`rms_slices` 一致性、WAV 头、包络等纯函数行为
  - `tools/device_e2e.py`：设备代码（硬件打桩，桩件在 `tools/device_stubs.py`，和 import_sim 共用）对着打包好的服务端真跑几轮对话——
    快捷指令、202 + 长轮询 + 流式音频、`X-Volume`、`X-Need-Photo` → `/chat-vision`。import_sim 和契约测试各用假的另一头，
    协议两头对不上只有这里看得出来；改了设备协议就在这里加一段
  - 最终仍需 uiflow2.m5stack.com 真机烧录确认
- 契约测试里的模拟设备用 paho-mqtt 1.x API（`mqtt.Client()`），勿升 2.x。

## 惯例

- 提交信息中文，格式 `类型: 摘要`（feat/fix/perf/refactor/docs/chore）。
- 注释中文为主；设备端是 MicroPython，不写类型标注。
- 设备目录：`/flash/kagura/src`（代码）、`/flash/kagura/resource`（图片，
  用 `cfg.res()` 取路径）、`/flash/kagura/data`（运行时状态，`cfg.data()`，
  `cfg.ensure_dirs()` 自动创建）。新增文件路径一律走这两个助手，别硬编码。
