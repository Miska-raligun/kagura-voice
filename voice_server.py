#!/usr/bin/env python3
"""
OpenClaw 语音服务端
- 接收 Core2 发来的 WAV 音频
- 百度语音识别 → openclaw agent → edge-tts 合成
- 返回 MP3 给 Core2 播放

启动: python3 voice_server.py
端口: 5000
"""

import base64
import json
import os
import re
import subprocess
import time
import uuid
import urllib.request
import urllib.parse
from pathlib import Path
from flask import Flask, request, send_file, jsonify, Response

# ── 路径配置 ──────────────────────────────────────────────────────────────────

OPENCLAW_DIR = Path.home() / ".openclaw"
TTS_SCRIPT = str(OPENCLAW_DIR / "workspace/skills/edge-tts/scripts/tts-converter.js")
TTS_VOICE = "zh-CN-XiaoxiaoNeural"
OPENCLAW_BIN = str(Path.home() / ".npm-global/bin/openclaw")
AGENT_ID = "main"

PULSE_ENV = {**os.environ, "PULSE_SERVER": "unix:/mnt/wslg/PulseServer"}

WAV_PATH = "/tmp/oc_server_input.wav"
MP3_PATH = "/tmp/oc_server_response.mp3"
OUT_WAV_PATH = "/tmp/oc_server_response.wav"

SAMPLE_RATE = 16000

# ── 百度语音识别 ──────────────────────────────────────────────────────────────

from config import BAIDU_API_KEY, BAIDU_SECRET_KEY, BAIDU_TTS_API_KEY, BAIDU_TTS_SECRET_KEY

_baidu_token = None
_baidu_token_expire = 0
_baidu_tts_token = None
_baidu_tts_token_expire = 0


def _get_token(api_key, secret_key):
    url = (
        "https://aip.baidubce.com/oauth/2.0/token"
        f"?grant_type=client_credentials"
        f"&client_id={api_key}"
        f"&client_secret={secret_key}"
    )
    with urllib.request.urlopen(url, timeout=10) as resp:
        data = json.loads(resp.read())
    return data["access_token"], time.time() + data["expires_in"] - 60


def get_baidu_token():
    global _baidu_token, _baidu_token_expire
    if _baidu_token and time.time() < _baidu_token_expire:
        return _baidu_token
    _baidu_token, _baidu_token_expire = _get_token(BAIDU_API_KEY, BAIDU_SECRET_KEY)
    return _baidu_token


def get_baidu_tts_token():
    global _baidu_tts_token, _baidu_tts_token_expire
    if _baidu_tts_token and time.time() < _baidu_tts_token_expire:
        return _baidu_tts_token
    _baidu_tts_token, _baidu_tts_token_expire = _get_token(BAIDU_TTS_API_KEY, BAIDU_TTS_SECRET_KEY)
    return _baidu_tts_token


def transcribe(audio_path):
    with open(audio_path, "rb") as f:
        audio_data = f.read()
        payload = json.dumps({
            "format": "wav",
            "rate": SAMPLE_RATE,
            "channel": 1,
            "cuid": "core2_client",
            "token": get_baidu_token(),
            "speech": base64.b64encode(audio_data).decode("utf-8"),
            "len": len(audio_data),
            }).encode("utf-8")
    req = urllib.request.Request(
        "https://vop.baidu.com/server_api",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read())
    if result.get("err_no") != 0:
        return ""
    results = result.get("result", [])
    if not results:
        return ""
    return results[0].strip()

# ── 对话 ──────────────────────────────────────────────────────────────────────

def _extract_json(raw):
    clean = re.sub(r"\x1b\[[0-9;]*m", "", raw)
    depth = 0
    start = None
    for i, ch in enumerate(clean):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                return json.loads(clean[start: i + 1])
    raise ValueError(f"未找到完整 JSON: {raw[:200]}")


def chat(user_text, session_id, image_path=None):
    cmd = [
        OPENCLAW_BIN, "agent",
        "--agent", AGENT_ID,
        "--message", user_text,
        "--session-id", session_id,
        "--json",
        "--timeout", "120",
    ]
    if image_path:
        cmd += ["--image", image_path]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=130)
    if result.returncode != 0:
        raise RuntimeError(f"openclaw 失败: {result.stderr[:200]}")
    data = _extract_json(result.stdout)
    if data.get("status") != "ok":
        raise RuntimeError(f"agent 状态异常: {data.get('status')}")
    return data["result"]["payloads"][0]["text"]


# ── TTS ───────────────────────────────────────────────────────────────────────

def strip_markdown(text):
    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"`[^`]+`", "", text)
    text = re.sub(r"#{1,6}\s+", "", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"~~(.+?)~~", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n{2,}", "\n", text)
    return text.strip()


def synthesize(text):
    """百度 TTS：文字 → PCM → 干净 WAV"""
    clean = strip_markdown(text)
    if not clean:
        return None
    token = get_baidu_tts_token()
    params = urllib.parse.urlencode({
        "tex": clean,
        "tok": token,
        "cuid": "core2_client",
        "ctp": 1,
        "lan": "zh",
        "spd": 5,
        "pit": 5,
        "vol": 10,
        "per": 111,    # 111=度小萌(可爱女声)
        "aue": 4,       # 4=pcm-16k
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://tsn.baidu.com/text2audio",
        data=params,
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        ct = resp.headers.get("Content-Type", "")
        body = resp.read()
    # 如果返回 JSON 说明出错了
    if "json" in ct or body[:1] == b"{":
        raise RuntimeError(f"百度 TTS 失败: {body[:200]}")
    # body 是裸 PCM (16kHz, 16bit, mono)，加干净 WAV 头
    import struct as _struct
    sr, ch, bits = 16000, 1, 16
    data_len = len(body)
    header = _struct.pack('<4sI4s4sIHHIIHH4sI',
        b'RIFF', 36 + data_len, b'WAVE',
        b'fmt ', 16, 1, ch, sr, sr * ch * bits // 8, ch * bits // 8, bits,
        b'data', data_len)
    with open(OUT_WAV_PATH, "wb") as f:
        f.write(header + body)
    return OUT_WAV_PATH


# ── 消息队列（主动推送） ──────────────────────────────────────────────────────

_message_queue = {}  # device_id → [wav_bytes, ...]


# ── 会话管理 ──────────────────────────────────────────────────────────────────

# 每个设备 ID 对应一个独立会话
_sessions = {}


def get_session(device_id):
    if device_id not in _sessions:
        _sessions[device_id] = str(uuid.uuid4())
        print(f"[新设备] {device_id} → session {_sessions[device_id][:8]}...")
    return _sessions[device_id]


# ── Flask 路由 ────────────────────────────────────────────────────────────────

app = Flask(__name__)


@app.route("/chat", methods=["POST"])
def handle_chat():
    """
    接收 WAV 文件，返回 MP3 文件。
    请求头: X-Device-Id: <设备唯一ID>（用于区分会话）
    请求体: WAV 音频（16kHz, 单声道, 16bit）
    """
    device_id = request.headers.get("X-Device-Id", "default")
    session_id = get_session(device_id)

    # 保存 WAV
    audio_data = request.get_data()
    if not audio_data:
        return jsonify({"error": "没有收到音频数据"}), 400

    with open(WAV_PATH, "wb") as f:
        f.write(audio_data)

    try:
        # 1. 语音识别
        user_text = transcribe(WAV_PATH)
        print(f"[{device_id}] 🗣️  {user_text}")
        if not user_text:
            user_text = "我没有听清楚，请重说一遍"

        # 2. 对话
        reply = chat(user_text, session_id)
        preview = reply[:80].replace("\n", " ")
        print(f"[{device_id}] 💬  {preview}{'...' if len(reply) > 80 else ''}")

        # 3. TTS
        mp3_path = synthesize(reply)
        if not mp3_path:
            return jsonify({"error": "TTS 生成失败"}), 500

        with open(mp3_path, "rb") as f:
            wav_data = f.read()
        print(f"[{device_id}] 📤  WAV {len(wav_data)} bytes")
        return Response(wav_data, mimetype="audio/wav",
                        headers={"Content-Length": len(wav_data)})

    except Exception as e:
        print(f"[{device_id}] ⚠️  错误: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/push", methods=["POST"])
def push_message():
    """
    主动推送文字消息，TTS 转 WAV 后存入队列，等待设备轮询。
    请求体: {"text": "要播报的内容", "device_id": "cores3"}
    """
    data = request.get_json()
    if not data or not data.get("text"):
        return jsonify({"error": "text is required"}), 400
    text = data["text"]
    device_id = data.get("device_id", "cores3")
    try:
        wav_path = synthesize(text)
        if not wav_path:
            return jsonify({"error": "TTS 生成失败"}), 500
        with open(wav_path, "rb") as f:
            wav_data = f.read()
        _message_queue.setdefault(device_id, []).append(wav_data)
        print(f"[push] → {device_id}: {text[:50]}{'...' if len(text) > 50 else ''} ({len(wav_data)} bytes)")
        return jsonify({"status": "queued", "device_id": device_id})
    except Exception as e:
        print(f"[push] ⚠️  错误: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/pending/<device_id>", methods=["GET"])
def pending(device_id):
    """设备轮询接口。有消息返回 WAV (200)，没有返回 204。"""
    queue = _message_queue.get(device_id, [])
    if not queue:
        return "", 204
    wav_data = queue.pop(0)
    return Response(wav_data, mimetype="audio/wav",
                    headers={"Content-Length": len(wav_data)})


@app.route("/chat-vision", methods=["POST"])
def handle_chat_vision():
    """
    接收 JSON: {"wav": "<base64 WAV>", "image": "<base64 JPEG>"}
    图片可为空字符串（仅语音不含图片时）。
    返回 WAV 音频。
    """
    device_id  = request.headers.get("X-Device-Id", "default")
    session_id = get_session(device_id)

    data = request.get_json()
    if not data or "wav" not in data:
        return jsonify({"error": "missing wav"}), 400

    wav_bytes = base64.b64decode(data["wav"])
    image_b64 = data.get("image", "")

    with open(WAV_PATH, "wb") as f:
        f.write(wav_bytes)

    try:
        user_text = transcribe(WAV_PATH) or "请分析这张图片"
        print(f"[{device_id}] 🗣️  {user_text}")

        image_path = None
        if image_b64:
            image_path = "/tmp/oc_vision_input.jpg"
            with open(image_path, "wb") as f:
                f.write(base64.b64decode(image_b64))

        reply = chat(user_text, session_id, image_path=image_path)
        preview = reply[:80].replace("\n", " ")
        print(f"[{device_id}] 💬  {preview}{'...' if len(reply) > 80 else ''}")

        wav_path = synthesize(reply)
        if not wav_path:
            return jsonify({"error": "TTS 生成失败"}), 500

        with open(wav_path, "rb") as f:
            wav_data = f.read()
        print(f"[{device_id}] 📤  WAV {len(wav_data)} bytes")
        return Response(wav_data, mimetype="audio/wav",
                        headers={"Content-Length": len(wav_data)})

    except Exception as e:
        print(f"[{device_id}] ⚠️  vision 错误: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/test-tone", methods=["GET"])
def test_tone():
    """返回一个 1 秒 440Hz 正弦波 WAV，用于测试 CoreS3 扬声器。"""
    import struct, math
    sr = 16000
    duration = 1
    samples = sr * duration
    raw = bytearray()
    for i in range(samples):
        val = int(16000 * math.sin(2 * math.pi * 440 * i / sr))
        raw += struct.pack('<h', val)
    # WAV header
    data_len = len(raw)
    header = struct.pack('<4sI4s4sIHHIIHH4sI',
        b'RIFF', 36 + data_len, b'WAVE',
        b'fmt ', 16, 1, 1, sr, sr * 2, 2, 16,
        b'data', data_len)
    import io
    buf = io.BytesIO(header + raw)
    return send_file(buf, mimetype="audio/wav", download_name="test.wav")


# ── 启动 ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 50)
    print("  OpenClaw 语音服务端")
    print("=" * 50)
    print("获取百度 token...", end="", flush=True)
    get_baidu_token()
    print(" OK")
    print(f"Agent : {AGENT_ID}  |  TTS : {TTS_VOICE}")
    print("监听 0.0.0.0:5000，Ctrl+C 退出\n")
    app.run(host="0.0.0.0", port=5000, debug=False)
