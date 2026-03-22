# Kagura Voice

基于 OpenClaw 的语音对话助手，支持本地麦克风模式和硬件终端模式（M5Stack CoreS3）。

## 功能

- 麦克风录音，自动检测说话开始/结束
- 百度语音识别（中文）
- OpenClaw Agent 对话
- Edge-TTS 语音合成播放

## 依赖

- [OpenClaw](https://openclaw.ai)（需在本机运行）
- ffmpeg / ffplay
- Node.js（用于 edge-tts）
- Python 3.10+

```bash
pip install flask numpy
```

## 配置

复制 `config.example.py` 为 `config.py`，填入百度语音识别的 API Key 和 Secret Key：

```bash
cp config.example.py config.py
```

百度语音识别 API 在[百度智能云](https://console.bce.baidu.com)申请，新用户有免费额度。

## 使用

### 本地语音模式

```bash
python3 voice_assistant.py
```

说话 → 识别 → OpenClaw 回复 → 语音播放，按 `Ctrl+C` 退出。

也可以用文字输入模式：

```bash
python3 voice_assistant.py --text
```

### 硬件终端模式（M5Stack CoreS3）

启动服务端：

```bash
python3 voice_server.py
```

服务端监听 `0.0.0.0:5000`，CoreS3 通过 WiFi 发送录音，服务端完成识别和对话后返回 MP3。

**WSL 用户**：需要在 Windows（管理员 PowerShell）中开启端口转发，让局域网设备能访问 WSL 内的服务：

```powershell
netsh interface portproxy add v4tov4 listenport=5000 listenaddress=0.0.0.0 connectport=5000 connectaddress=127.0.0.1
```

CoreS3 端代码待更新。

## 项目结构

```
├── voice_assistant.py   # 本地语音对话
├── voice_server.py      # CoreS3 服务端
├── config.py            # API Key 配置（不提交）
└── config.example.py    # 配置示例
```
