# 旧版服务端（Python + OpenClaw + mosquitto）

> **已被 `server/`（TypeScript 单文件可执行）取代**，这里留作参考，直到旧版删除（计划 M11）。
> 从旧版迁移：`kagura migrate <本仓库目录>`（配置、提醒、定时拍照、快照、TTS 缓存都会搬过去）。

## 依赖

- [OpenClaw](https://openclaw.ai)（需在本机运行）
- ffmpeg / ffplay（本地模式需要）
- Python 3.10+

```bash
pip install -r requirements.txt
```

运行测试（服务端逻辑，无需硬件和外部服务）：

```bash
pytest tests/
```

## 配置

1. 复制 `config.example.py` 为 `config.py`：

```bash
cp config.example.py config.py
```

2. 在[百度智能云](https://console.bce.baidu.com)创建**两个应用**：
   - 语音识别应用 → 填入 `BAIDU_API_KEY` 和 `BAIDU_SECRET_KEY`
   - 语音合成应用（需开通语音合成权限）→ 填入 `BAIDU_TTS_API_KEY` 和 `BAIDU_TTS_SECRET_KEY`

### 安全说明

服务端设计为**在可信局域网内运行**，HTTP 接口默认不做鉴权（方便多个 agent
直接调用 `/push` 等接口协作）。请不要将 5000 端口暴露到公网。

如果局域网内有不可信设备，可在 `config.py` 中设置共享密钥：

```python
API_TOKEN = "随便一串足够长的字符串"
```

设置后 `/push` 与 `/capture-request`（远程拍照）需携带 `X-Api-Token` 头才能调用；
留空则完全开放（默认）。另外服务端对 `/chat` 类接口有按设备 + 按来源 IP
的双层限流，防止恶意刷 LLM 调用。

### 本地语音模式

```bash
python3 voice_assistant.py
```

说话 → 识别 → OpenClaw 回复 → 语音播放，按 `Ctrl+C` 退出。

文字输入模式：

```bash
python3 voice_assistant.py --text
```

### CoreS3 硬件终端模式

**服务端**（PC / WSL）：

```bash
python3 voice_server.py
```

**WSL 用户**需要在 Windows 管理员 PowerShell 中开启端口转发。设备用到的端口有四个，
**少转发一个就是对应功能单独失灵**（比如只漏 5002，其它都正常，唯独直播连不上）：

| 端口 | 协议 | 用途 | 漏了会怎样 |
|---|---|---|---|
| 5000 | TCP | HTTP 主服务 | 完全不能用 |
| 1883 | TCP | MQTT（播报/拍照命令） | 主动播报和远程拍照失效 |
| 5001 | UDP | 服务端自动发现 | 设备找不到服务端，退回写死的 IP |
| 5002 | TCP | 摄像头直播流 | 直播一直「正在唤醒摄像头」后超时 |

```powershell
# 推荐：直接跑仓库里的脚本（已包含全部端口 + 防火墙规则，且会自动取当前 WSL IP）
powershell -ExecutionPolicy Bypass -File openclaw-startup.ps1

# 或手动加单个端口
netsh interface portproxy add v4tov4 listenport=5000 listenaddress=0.0.0.0 connectport=5000 connectaddress=<WSL_IP>
```

> WSL 的 IP 每次重启都会变，所以别把 `<WSL_IP>` 写死——用脚本，它会现取。
> 查当前转发表：`netsh interface portproxy show v4tov4`

**CoreS3 端**：

设备端代码在 `device/` 目录下，按模块拆分。上传后的设备目录结构：

```
/flash/main.py                  ← device/main.py（三行引导）
/flash/kagura/src/*.py          ← device/src/ 全部文件
/flash/kagura/resource/*        ← 图片资源（jpg/png/bmp，见 device/resource/README.md）
/flash/kagura/data/             ← 运行时状态，首次启动自动创建
```

步骤：

1. 用 M5Burner 烧录 UIFlow2 固件（WiFi 可不配，见下文"在设备上配置 WiFi"）
2. 打开 uiflow2.m5stack.com 连接设备，点左侧 **webterminal → File** 打开文件管理
3. 建目录 `/flash/kagura/src`，把 `device/src/` 下 13 个 `.py` 全部上传进去
4. 把 `device/main.py` 上传为 `/flash/main.py`（开机自动运行）
5. 可选：建 `/flash/kagura/resource` 并上传背景图
6. 服务端 IP 由 UDP 广播自动发现，无需改 `cfg.SERVER_BASE`

> 之后改代码只需重传改动的那个模块，不必每次重贴整个文件。
> 单文件版 `cores3_client.py` 仍保留作为回退，内容烧成 `/flash/main.py`
> 并删掉 `/flash/kagura/` 即可退回旧行为。

## 项目结构

```
├── voice_assistant.py   # 本地语音对话（麦克风 + 扬声器）
├── voice_server.py      # CoreS3 服务端（ASR + OpenClaw + TTS）
├── device/              # CoreS3 设备端（MicroPython，按模块拆分）
│   ├── main.py          #   引导：加 sys.path 后启动 app
│   ├── src/             #   cfg/hw/clock/ui/wifisetup/audio/netsvc/chat/app
│   └── resource/        #   图片资源说明
├── tools/               # 设备端拆分的静态校验 + import 模拟
├── cores3_client.py     # 旧单文件版（已弃用，仅作回退）
├── baidu_tokens.py      # 百度 access token 缓存（线程安全）
├── quick_commands.py    # 快捷指令规则（时间/日期/星期/音量/定时提醒解析）
├── reminders.py         # 定时提醒调度器（持久化 + MQTT 播报）
├── photo_schedules.py   # 每日定时拍照调度器（持久化 + 当天去重 + 错过窗口）
├── stream_server.py     # 直播流接收（TCP :5002，裸 RGB565 帧 → JPEG，只留最新一帧）
├── oc_utils.py          # 共享工具（JSON 提取、Markdown 清洗）
├── web/monitor.html     # Web 监控页（远程快门 + 定时计划管理 + 快照回看）
├── tests/               # 服务端单元测试（外部依赖全打桩）
├── .github/workflows/   # CI：push/PR 自动跑测试
├── requirements.txt     # Python 依赖
├── CLAUDE.md            # 架构与开发约定（供 AI 协作参考）
├── config.py            # API Key 配置（不提交）
└── config.example.py    # 配置示例
```

## TODO

- [x] 主动播报：服务端推送消息，CoreS3 自动播放
- [x] 屏幕 UI 优化：不同状态显示不同表情/动画
- [x] 连续对话模式：不需要每次触摸，自动监听
- [x] 摄像头图像识别：语音触发拍照，发送给 OpenClaw 分析
- [x] 取景模式：屏幕实时预览 + 手动快门 + 重拍/发送确认
- [x] 中文显示：CoreS3 屏幕支持中文字体
- [x] 录音指示：录音/发送/播放时的 LED 或动画反馈
- [x] 离线唤醒词：不需要触摸，声音检测自动激活
- [x] BLE 在家感知：蓝牙扫描手机自动判断在家/出门
- [x] RTC 时间同步：屏幕显示时钟，对话时间感知
- [x] IMU 摇晃彩蛋：摇晃设备显示隐藏图片 + AI 主动聊天
- [x] 服务端可靠性：线程安全、内存泄漏修复、MQTT 容错
- [x] 快捷指令短路：时间/日期/星期等问题本地秒回，不走 LLM
- [x] 服务端单测 + 可选 API_TOKEN + IP 兜底限流 + openclaw 并发控制
- [x] 设备端功耗优化：主循环限速、唤醒模式麦克风常开、rms 提速
- [x] 语音定时提醒：相对/绝对时间解析，持久化调度，到点 MQTT 播报
- [x] Web 监控页：浏览器远程拍照 + 自动刷新 + 定时计划管理 + 快照回看
- [x] 每日定时拍照：到点拍照 → AI 识别 → 语音播报，照片与结果留档
- [x] 直播推流：常驻 TCP + QQVGA 裸帧，浏览器看约 10 fps 准实时画面
- [x] 音量语音控制 + 屏显对话文本 + 硬件看门狗 + MQTT 队列化
- [x] 延迟优化：VAD 尾静音减半、HTTP 连接复用、百度 API 重试
- [x] CI + CLAUDE.md
- [ ] 音色优化：寻找更符合神乐风格的 TTS 声音
- [ ] 流式 TTS：边合成边播，进一步降低首字延迟
