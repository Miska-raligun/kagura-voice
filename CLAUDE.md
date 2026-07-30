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
| `baidu_tokens.py` | 百度 token 缓存（`BaiduTokenCache`，线程安全） |
| `oc_utils.py` | `_extract_json`（raw_decode 提取 CLI stdout 里的 JSON）、`strip_markdown` |
| `config.py` | 不提交。`config.example.py` 为模板；`API_TOKEN` 可选（留空=开放） |

## 关键机制（改动前必读）

- **短路链**（`/chat` 内）：提醒 → 音量 → 快捷指令 → OpenClaw。短路命中存
  `state.set_last_quick`，下次 LLM 对话作为背景注入（`pop_last_quick`）。
- **TTS 缓存**：`synthesize()` 按 md5(文本+音色参数) 缓存于 `tts_cache/`；
  改音色参数必须同步改 cache key。
- **响应头协议**（设备读取）：`X-Need-Photo`、`X-Volume: up/down`、
  `X-User-Text`/`X-Reply-Text`（b64 UTF-8，屏显用）。请求头：`X-Device-Id`、
  `X-Local-Time`、（可选）`X-Api-Token`。
- **MQTT topic**：`kagura/push/{device_id}`（播报通知）、`kagura/cmd/{device_id}`（拍照命令）。
- **设备端状态**：跨子系统 flag 全在 `St` 类（busy/continuous/wake/sleeping/last_activity）；
  模式转移只走 `toggle_continuous/toggle_wake_mode/enter_sleep/wake_up`。
- **push 去重 hack**：对话期间（`St.busy`）收到的 MQTT push 直接丢弃——OpenClaw
  用 cores3-speak 回复时会同时触发 push，不丢会播两遍。改播放逻辑时务必保留。
- **MQTT 回调只入队**：耗时操作（播放/拍照）在主循环 `process_mqtt_queue()` 消费，
  否则长播放阻塞心跳导致断连。
- **看门狗**：`WATCHDOG_TIMEOUT_MS=120s` 必须大于最长合法阻塞（HTTP 30s+余量）；
  长循环里要 `_wdt_feed()`。ESP32 WDT 创建后无法关闭。
- **openclaw 并发**：`chat()` 有全局 Semaphore(2) + 每 session 串行锁。
- **回退开关**（设备端顶部常量）：`WAKE_MIC_PERSISTENT`、`WATCHDOG_ENABLED`、
  `SHOW_CHAT_TEXT`——真机出问题先关开关再排查。

## 测试与验证

```bash
pip install -r requirements.txt
pytest tests/ -q                 # 82+ 例，外部依赖全打桩（conftest 注入 config/paho 桩）
python -c "import ast; ast.parse(open('cores3_client.py').read())"   # 设备端语法检查
```

- 服务端改动必须跑 pytest；`tests/conftest.py` 的 `vs` fixture 每测试重置 `ServerState`。
- `cores3_client.py` 无法本地运行，只能 AST 检查 + uiflow2.m5stack.com 真机烧录验证。
- paho-mqtt 用 1.x API（`mqtt.Client()`），勿升 2.x。

## 惯例

- 提交信息中文，格式 `类型: 摘要`（feat/fix/perf/refactor/docs/chore）。
- 注释中文为主；服务端有 type hints，设备端（MicroPython）没有。
- 运行时产物（`push_audio/`、`tts_cache/`、`reminders.json`）已 gitignore，勿提交。
