# 设备接入指南（CoreS3 只是参考实现）

Kagura 的服务端并不绑定 CoreS3。协议只有两层：**HTTP（对话、状态、文件）** 和 **MQTT（推送、命令）**。
只要一个终端能录音、放音、跑 HTTP + MQTT，就能作为「设备」接进来——树莓派、ESP32、手机 App、
电脑上的麦克风程序都可以，不需要公网 IP，也不需要给服务端反向连你。

> **设备是客户端，不是服务端。** 你不需要在设备上开端口等 Kagura 来连。
> 设备主动 POST 请求、保持一条 MQTT 连接就够了。服务端只负责监听 5000 / 1883 / 5001 / 5002。

`device/` 下这份是 CoreS3（MicroPython）的参考实现，包含屏幕、摄像头、触摸、IMU、OTA 这些
**可选能力**；只做语音对话的话，不需要实现它们。

---

## 一、最小接入要求

| 要求 | 说明 |
|---|---|
| 录音 | **16 kHz、16-bit、单声道 PCM WAV**（百度 ASR 的要求，也是参考固件的格式） |
| 放音 | 能播放服务端返回的 WAV（16 kHz / 16-bit / 单声道） |
| HTTP | 能 POST 原始 WAV、GET 下载文件 |
| MQTT | 3.1.1 客户端，能订阅两个 topic、保持 keepalive |
| 身份 | 一个稳定的 `device_id`（字母/数字/`_`/`-`，1–32 字符），放在 `X-Device-Id` |

有了这四样，对话和「主动播报」就能跑。拍照、直播、触感、在线升级都是可选扩展。

---

## 二、协议

### 1. 对话 `POST /chat`

- Body：**原始 WAV 字节**（不是 multipart、不是 base64）
- 请求头：

| 头 | 必填 | 说明 |
|---|---|---|
| `X-Device-Id` | 是 | 设备标识，例如 `cores3`、`livingroom-pi` |
| `X-Local-Time` | 否 | 设备本地时间，给模型做时间上下文 |
| `X-Mode` | 否 | `continuous` / `wake` 表示免手模式（服务端会把「嗯/啊」当没听清） |
| `X-Touch` | 否 | 体感摘要，`k=v,k=v`，服务端会翻成一句背景注入 |
| `X-Stream` | 否 | `1` = 要「边生成边播」的流式 WAV |
| `X-Api-Token` | 否 | 服务端配了 `api_token` 时必填 |

- 响应：`audio/wav`，响应头：

| 头 | 说明 |
|---|---|
| `X-Reply-Text` | 回复文本，base64(UTF-8)，用于屏幕显示 |
| `X-User-Text` | 服务端 ASR 出来的用户文本，base64 |
| `X-Role` | 当前角色 id |
| `X-Need-Photo` | `1` = 模型想拍照，播完这条回复后拍一张发 `/chat-vision` |
| `X-Volume` | `up` / `down`，调音量 |
| `X-Cont-Exit` | `1` = 用户说「不聊了」，退出免手模式 |
| `X-Asr-Empty` | `1` = 没听清（免手模式下不要播报） |
| `X-Reply-Partial` | `1` = 流式回复，`X-Reply-Text` 只有首句，播完可 `GET /chat/last` 取全文 |

**超时**：服务端一条回复最多约 60 秒（LLM + TTS）。设备端 HTTP 超时要 ≥ 60s，否则会出现
「服务端打印已发送、设备早就 ETIMEDOUT」。

**流式**（可选）：带 `X-Stream: 1` 时响应没有 `Content-Length`、不用 chunked，读到连接关闭为止；
每段是「一个占位 WAV 头 + 多句 PCM」。不想处理就別带这个头，拿整段 WAV 更简单。

### 2. 看图 `POST /chat-vision`

JSON Body（三者至少一个）：

```json
{ "image": "<base64 JPEG>", "wav": "<base64 WAV>", "text": "帮我看看这是什么" }
```

- `wav` + `image`：语音触发拍照（`X-Need-Photo` 之后）
- 仅 `image`：取景模式手动拍一张，服务端用默认提问
- `text` + `image`：直接问

响应同 `/chat`（`audio/wav` + `X-Reply-Text` 等）。图片 base64 有大小上限，参考固件压到 QVGA JPEG。

### 3. 主动播报（服务端 → 设备）

服务端把 TTS 结果存成文件，通过 MQTT 通知，设备自己去下载：

```
topic: kagura/push/<device_id>
payload: {"type":"push","url":"/push-audio/ab12cd34.wav"}
```

设备收到后 `GET <server>/push-audio/ab12cd34.wav` 播放即可（文件下载后服务端会删）。
参考固件在「正在对话」时会丢弃这期间的 push，避免和对话回复播两遍——新设备建议也做同样的去重。

### 4. 命令（服务端 → 设备）

```
topic: kagura/cmd/<device_id>
```

| payload | 设备要做什么 |
|---|---|
| `{"action":"capture","request_id":"..."}` | 拍一张，`POST /upload-photo` 带 `request_id` + base64 图片；服务端轮询 `/capture-result/<id>` |
| `{"action":"stream_start"}` / `{"action":"stream_stop"}` | 连/断 TCP 直播（可选） |
| `{"action":"role","role":"anon"}` | 切角色（改音色/图片，不用重连） |
| `{"action":"sync","scope":"res"\|"code"\|"all"}` | 去 `GET /device/files` 比对文件、下载变化项（可选 OTA） |

### 5. 心跳 `POST /heartbeat`

JSON，字段自由，服务端会存下来并展示在管理界面：

```json
{ "device_id": "cores3", "bat": 96, "rssi": -51, "heap": 6612992, "wdt": 180000, "fw": "0.1.0-beta.15" }
```

建议 30–60 秒一次。`logs` 字段可以带最近几行设备日志（服务端会存成 `device_logs/<id>.log`）。

### 6. 在家状态 `POST /presence`

```json
{ "device_id": "cores3", "status": "home" }
```

`status` 只能是 `home` / `away`。服务端会：
- 更新 `get_presence` 的结果（agent 决定要不要语音播报）
- 持久化到 `tmp/mio-home-status.json`，**重启后自动恢复**
- 写 `tmp/user_presence.txt`

没有蓝牙/地理围栏的设备，也可以让主人对 agent 说「我到家了」——服务端有 `set_presence` 工具和
`/home` `/away` 命令，效果一样。

### 7. 角色

- `GET /role`：当前角色 + 角色列表（开机时拉一次）
- `POST /role/cycle`：切到下一个角色，返回新角色的问候 WAV
- `POST /role`：指定角色（管理界面用，需要 token）

角色 = agent + 百度音色 + 一套设备图片。纯语音设备可以忽略图片，只按 `X-Role` 换音色。

### 8. 触感 / 摇一摇（可选）

- `POST /touch`：轻拍/拿起/抚摸，服务端转成一句背景交给 agent
- `GET /shake`：摇一摇，服务端触发一次「主动开口」

### 9. 服务端发现（可选）

UDP 5001 广播 `KAGURA_DISCOVER`，服务端回 `KAGURA_HERE`，设备从回包源地址得到服务端 IP。
不想做就写死 IP / 域名，HTTP 和 MQTT 都能直接连。

### 10. 直播（可选）

设备主动连服务端 TCP 5002，先发一行握手，然后每帧：`4 字节大端长度 + RGB565 裸字节`，
长度 0 表示结束。服务端只保留最新一帧给监控页。

---

## 三、多设备

- `device_id` 就是主键：路由、`device:<id>` 投递、角色会话、心跳、日志都按它分。
- 定时任务投递写 `device:livingroom-pi` 就会推到那台。
- 每个设备的当前角色存在 `roles_state.json`，互不影响。
- 设备能力不同（有的没摄像头/屏幕）不影响协议，服务端不会强制要求可选接口。

---

## 四、开发指南

### 1. 先用 curl 把链路跑通

```bash
# 1) 心跳（确认服务端认识你）
curl -s -X POST http://127.0.0.1:5000/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"device_id":"my-device","bat":100}'

# 2) 对话（需要一段 16k 单声道 WAV）
curl -s -X POST http://127.0.0.1:5000/chat \
  -H 'X-Device-Id: my-device' \
  -H 'Content-Type: audio/wav' \
  --data-binary @question.wav -o reply.wav -D headers.txt
# headers.txt 里看 X-Reply-Text（base64 解码就是文字）

# 3) 在家状态
curl -s -X POST http://127.0.0.1:5000/presence \
  -H 'Content-Type: application/json' \
  -d '{"device_id":"my-device","status":"home"}'
```

### 2. 再接 MQTT

订阅 `kagura/push/my-device` 和 `kagura/cmd/my-device`，收到 `push` 就下载 `url` 播放。
MQTT keepalive 建议 30–60 秒；长时间播放/阻塞时注意别把心跳饿死。

### 3. 最后加可选能力

摄像头（`/chat-vision` + `/upload-photo`）、触摸（`/touch`）、OTA（`/device/files`）按需实现，
每加一块先用 curl 单独验证，再接进主循环。

### 4. 常见坑

- **超时**：`/chat` 服务端可能跑 60 秒；设备超时短了就成了「服务端发了、设备没收到」。
- **WAV 头**：必须是标准 44 字节 RIFF 头，16 kHz / 16-bit / 单声道；错一个字段 ASR 就废。
- **HTTP 分块**：参考固件的 HTTP 客户端不认 `Transfer-Encoding: chunked`，服务端流式回复也刻意不用它；新设备如果自己实现 HTTP，注意这一点。
- **MQTT 阻塞**：不要在 MQTT 回调里直接播长音频/拍照，先入队，主循环处理，否则心跳断连。
- **重复播报**：对话回复本身已经由 `/chat` 返回并播放；服务端在主人私聊时还会额外 `push` 一条语音，设备要避免同时播两遍（参考固件对话期间直接丢弃 push）。
- **token**：服务端配了 `api_token` 后，除 `/chat`、`/chat-vision`、`/presence` 等设备上行路由外，下载/监控类接口要带 `X-Api-Token`（或 `?token=`）。

---

## 五、参考实现（CoreS3）

`device/src/` 是按职责拆开的 MicroPython 固件，依赖必须无环：

```
cfg → hw → clock → ui → {wifisetup, snd} → cam → feel → diag → ota → netsvc → stream → chat → app
```

| 模块 | 作用 |
|---|---|
| `cfg` | 常量、开关、`St`/`Feel` 状态 |
| `hw` | 屏幕/麦克风/扬声器/看门狗/触摸/IMU 底层 |
| `snd` | 录音 VAD、流式播放、分段、喂狗 |
| `cam` | 抓帧、取景、拍照上传 |
| `feel` | 触觉三层 |
| `netsvc` | MQTT、BLE 在家感知、UDP 发现 |
| `stream` | 摄像头直播 |
| `chat` | 主对话、模式切换、摇一摇 |
| `ota` | 在线更新设备代码/图片 |
| `app` | `setup()` / `loop()` |

烧录与目录约定见仓库根的 `使用说明.txt` / `docs/device.md`；改固件后必须真机验证，
`tools/check_split.py` 和 `tools/import_sim.py` 只能做静态兜底。

---

## 六、一句话总结

**Kagura 设备协议 = 「HTTP 传 WAV + MQTT 收推送」**。CoreS3 只是把这套协议实现得比较完整的一份固件；
你要用别的硬件，按上面的最小要求实现客户端即可，服务端不用改。
