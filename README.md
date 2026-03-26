# Kagura Voice

基于 OpenClaw 的语音对话助手，支持本地麦克风模式和 M5Stack CoreS3 硬件终端模式。

## 功能

- 百度语音识别（中文 ASR）
- OpenClaw Agent 对话
- 百度语音合成（中文 TTS）
- M5Stack CoreS3 硬件终端：触摸录音、VAD 自动停止、语音播放
- 本地模式：麦克风录音、自动检测说话开始/结束
- 屏幕 UI：状态 kaomoji + 彩色主题条 + 模式指示灯
- LED 指示灯：不同颜色对应不同工作状态
- 连续对话模式：长按切换，自动循环对话无需反复触摸
- 摄像头图像识别：触摸下方区域，或直接说出拍照关键词自动触发
- 声控唤醒模式：三击切换，检测短促声音自动激活录音

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
4. 修改 `SERVER_BASE` 为服务端的局域网 IP
5. 点击下载按钮写入设备（开机自动运行）

### 操作手势（CoreS3）

| 手势 | 功能 |
|---|---|
| 短按上方区域 | 普通语音对话 |
| 短按下方区域 | 拍照 + 语音对话 |
| 说出拍照关键词 | 自动触发拍照（"看看"、"拍照"、"图片"等） |
| 长按 | 切换连续对话模式（再次长按退出） |
| 三击 | 切换声控唤醒模式 |

### LED 状态指示

| 颜色 | 状态 |
|---|---|
| 熄灭 | 空闲 |
| 红 | 录音中 |
| 黄 | 思考中 |
| 绿 | 播放中 |
| 青 | 广播消息 |
| 紫 | 拍照中 |

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
- [x] 屏幕 UI 优化：不同状态显示不同表情/动画
- [x] 连续对话模式：不需要每次触摸，自动监听
- [x] 摄像头图像识别：语音触发拍照，发送给 OpenClaw 分析
- [x] 中文显示：CoreS3 屏幕支持中文字体
- [x] 录音指示：录音/发送/播放时的 LED 或动画反馈
- [x] 离线唤醒词：不需要触摸，声音检测自动激活
- [ ] 音色优化：寻找更符合神乐风格的 TTS 声音
