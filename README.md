# Kagura Voice

基于 OpenClaw 的语音对话助手，支持本地麦克风模式和 M5Stack CoreS3 硬件终端模式。

## 功能

- 百度语音识别（中文 ASR）
- OpenClaw Agent 对话
- 百度语音合成（中文 TTS）
- M5Stack CoreS3 硬件终端：触摸录音、VAD 自动停止、语音播放
- 本地模式：麦克风录音、自动检测说话开始/结束

## 硬件要求（CoreS3 模式）

- M5Stack CoreS3（或 CoreS3 SE）
- 运行 OpenClaw 的服务器（PC / WSL / Linux）
- CoreS3 和服务器在同一局域网

## 依赖

- [OpenClaw](https://openclaw.ai)（需在本机运行）
- ffmpeg / ffplay（本地模式需要）
- Python 3.10+

```bash
pip install flask numpy
```

## 配置

1. 复制 `config.example.py` 为 `config.py`：

```bash
cp config.example.py config.py
```

2. 在[百度智能云](https://console.bce.baidu.com)创建**两个应用**：
   - 语音识别应用 → 填入 `BAIDU_API_KEY` 和 `BAIDU_SECRET_KEY`
   - 语音合成应用（需开通语音合成权限）→ 填入 `BAIDU_TTS_API_KEY` 和 `BAIDU_TTS_SECRET_KEY`

## 使用

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

**WSL 用户**需要在 Windows 管理员 PowerShell 中开启端口转发：

```powershell
netsh interface portproxy add v4tov4 listenport=5000 listenaddress=0.0.0.0 connectport=5000 connectaddress=<WSL_IP>
```

**CoreS3 端**：

1. 用 M5Burner 烧录 UIFlow2 固件，配置 WiFi
2. 打开 uiflow2.m5stack.com 连接设备
3. 将 `cores3_client.py` 的内容粘贴到编辑器
4. 修改 `SERVER_URL` 为服务端的局域网 IP
5. 点击下载按钮写入设备（开机自动运行）

### 主动播报

服务端提供 `/push` 接口，可通过 HTTP 推送文字消息，CoreS3 会自动轮询并播放：

```bash
curl -X POST http://localhost:5000/push \
  -H "Content-Type: application/json" \
  -d '{"text": "主人，今天多云转晴，气温25度", "device_id": "cores3"}'
```

可配合 OpenClaw 的定时任务使用，例如每天早上播报天气。

## 项目结构

```
├── voice_assistant.py   # 本地语音对话（麦克风 + 扬声器）
├── voice_server.py      # CoreS3 服务端（ASR + OpenClaw + TTS）
├── cores3_client.py     # CoreS3 设备端代码（MicroPython）
├── config.py            # API Key 配置（不提交）
└── config.example.py    # 配置示例
```

## TODO

- [x] 主动播报：服务端推送消息，CoreS3 自动播放
- [ ] 屏幕 UI 优化：不同状态显示不同表情/动画
- [ ] 连续对话模式：不需要每次触摸，自动监听
- [ ] 摄像头图像识别：语音触发拍照，发送给 OpenClaw 分析
- [ ] 音色优化：寻找更符合神乐风格的 TTS 声音
- [ ] 中文显示：CoreS3 屏幕支持中文字体
- [ ] 录音指示：录音/发送/播放时的 LED 或动画反馈
- [ ] 离线唤醒词：不需要触摸，说唤醒词激活