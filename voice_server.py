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
import tempfile
import threading
import time
import uuid
import urllib.request
import urllib.parse
from pathlib import Path
from typing import Optional
import shutil
from flask import Flask, request, send_file, jsonify, Response, after_this_request
import paho.mqtt.client as mqtt

from baidu_tokens import BaiduTokenCache
import quick_commands

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

PUSH_AUDIO_DIR = Path(__file__).parent / "push_audio"
PUSH_AUDIO_DIR.mkdir(exist_ok=True)

VISION_TMP_DIR = OPENCLAW_DIR / "workspace" / "tmp"
VISION_TMP_DIR.mkdir(parents=True, exist_ok=True)

SAMPLE_RATE = 16000

# ── 百度语音识别 ──────────────────────────────────────────────────────────────

from config import BAIDU_API_KEY, BAIDU_SECRET_KEY, BAIDU_TTS_API_KEY, BAIDU_TTS_SECRET_KEY
from oc_utils import _extract_json, strip_markdown

_asr_tokens = BaiduTokenCache(BAIDU_API_KEY, BAIDU_SECRET_KEY, name="ASR")
_tts_tokens = BaiduTokenCache(BAIDU_TTS_API_KEY, BAIDU_TTS_SECRET_KEY, name="TTS")


def transcribe(audio_path: str) -> str:
    with open(audio_path, "rb") as f:
        audio_data = f.read()
        payload = json.dumps({
            "format": "wav",
            "rate": SAMPLE_RATE,
            "channel": 1,
            "cuid": "core2_client",
            "token": _asr_tokens.get(),
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

def chat(user_text: str, session_id: str, image_path: Optional[str] = None, local_time: Optional[str] = None) -> str:
    message = user_text
    if local_time:
        message = f"[当前时间: {local_time}] {message}"
    if image_path:
        message = f"{message}\n\n[用户通过CoreS3摄像头拍了一张照片，保存在 {image_path}，请识别这张图片来回答问题]"
    cmd = [
        OPENCLAW_BIN, "agent",
        "--agent", AGENT_ID,
        "--message", message,
        "--session-id", session_id,
        "--json",
        "--timeout", "120",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=130)
    if result.returncode != 0:
        raise RuntimeError(f"openclaw 失败: {result.stderr[:200]}")
    data = _extract_json(result.stdout)
    if data.get("status") != "ok":
        raise RuntimeError(f"agent 状态异常: {data.get('status')}")
    return data["result"]["payloads"][0]["text"]


# ── TTS ───────────────────────────────────────────────────────────────────────

def synthesize(text: str) -> Optional[str]:
    """百度 TTS：文字 → PCM → 干净 WAV"""
    clean = strip_markdown(text)
    if not clean:
        return None
    token = _tts_tokens.get()
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


# ── MQTT 推送客户端 ──────────────────────────────────────────────────────────

_mqtt_client = None


def _init_mqtt() -> None:
    """延迟初始化 MQTT 客户端，broker 不可用时不影响服务端启动。"""
    global _mqtt_client
    try:
        client = mqtt.Client()
        client.connect("localhost", 1883)
        client.loop_start()
        _mqtt_client = client
        print("MQTT 已连接 localhost:1883")
    except Exception as e:
        print(f"⚠️  MQTT 连接失败（推送功能不可用）: {e}")
        _mqtt_client = None


# ── 共享服务端状态（会话 / 限流 / 拍照结果） ───────────────────────────────

class ServerState:
    """集中管理 Flask 路由共享的可变状态。锁按用途拆开，互不阻塞。

    - sessions     : device_id → openclaw session_id（LRU 淘汰，上限 max_sessions）
    - rate_buckets : "<bucket>:<device_id>" → (window_start, count)
    - photo_results: request_id → {"status", "image_path", "_ts", ...}
    """

    def __init__(
        self,
        max_sessions: int = 100,
        rate_window: float = 60.0,
        rate_max: int = 20,
    ) -> None:
        self.sessions: dict[str, str] = {}
        self.sessions_lock = threading.Lock()
        self.max_sessions = max_sessions

        self.rate_buckets: dict[str, tuple[float, int]] = {}
        self.rate_lock = threading.Lock()
        self.rate_window = rate_window
        self.rate_max = rate_max

        self.photo_results: dict[str, dict] = {}
        self.photos_lock = threading.Lock()

    def get_session(self, device_id: str) -> str:
        with self.sessions_lock:
            if device_id not in self.sessions:
                if len(self.sessions) >= self.max_sessions:
                    oldest = next(iter(self.sessions))
                    del self.sessions[oldest]
                self.sessions[device_id] = str(uuid.uuid4())
                print(f"[新设备] {device_id} → session {self.sessions[device_id][:8]}...")
            return self.sessions[device_id]

    def check_rate(self, device_id: str, *, bucket: str = "chat", limit: Optional[int] = None) -> bool:
        """每设备 + bucket 维度的滑动窗口限流。limit 缺省取 self.rate_max。"""
        max_count = limit if limit is not None else self.rate_max
        key = f"{bucket}:{device_id}"
        now = time.time()
        with self.rate_lock:
            window = self.rate_buckets.get(key)
            if window is None or now - window[0] > self.rate_window:
                self.rate_buckets[key] = (now, 1)
                return True
            if window[1] >= max_count:
                return False
            self.rate_buckets[key] = (window[0], window[1] + 1)
            return True


state = ServerState()


# ── Flask 路由 ────────────────────────────────────────────────────────────────

app = Flask(__name__)

_DEVICE_ID_RE = re.compile(r'^[a-zA-Z0-9_-]{1,32}$')

RGB565_SIZES = {
    160*120*2: (160,120),
    176*144*2: (176,144),
    240*176*2: (240,176),
    240*240*2: (240,240),
    320*240*2: (320,240),
    480*320*2: (480,320),
    640*480*2: (640,480),
    800*600*2: (800,600),
}


_MAX_IMAGE_B64_BYTES = 5 * 1024 * 1024   # 5 MB base64 上限（约 3.75 MB 解码后）
_MAX_AUDIO_BYTES    = 5 * 1024 * 1024   # 5 MB WAV 上限


def _decode_image_b64(image_b64: str, device_id: str = "unknown", tag: str = "") -> Optional[str]:
    """解码 base64 图片（RGB565 或 JPEG），保存为 JPEG，返回路径。失败返回 None。"""
    if len(image_b64) > _MAX_IMAGE_B64_BYTES:
        print(f"[{tag}] {device_id} image base64 过大: {len(image_b64)} bytes，拒绝")
        return None
    image_b64_clean = image_b64.replace("\n", "").replace("\r", "")
    padding = len(image_b64_clean) % 4
    if padding:
        image_b64_clean += "=" * (4 - padding)
    try:
        decoded_bytes = base64.b64decode(image_b64_clean)
    except Exception as e:
        print(f"[{tag}] {device_id} base64 解码失败: {e}")
        return None
    n = len(decoded_bytes)
    image_path = str(VISION_TMP_DIR / f"oc_vision_{uuid.uuid4().hex[:8]}.jpg")

    W, H = RGB565_SIZES.get(n, (None, None))
    if W is not None:
        import numpy as np
        from PIL import Image as PILImage
        import io as _io
        pixels = np.frombuffer(decoded_bytes, dtype=np.uint16).byteswap()
        r = ((pixels >> 11) & 0x1F) * 255 // 31
        g = ((pixels >> 5)  & 0x3F) * 255 // 63
        b = (pixels         & 0x1F) * 255 // 31
        rgb = np.stack([r, g, b], axis=-1).astype(np.uint8).reshape(H, W, 3)
        buf = _io.BytesIO()
        PILImage.fromarray(rgb).save(buf, format="JPEG", quality=85)
        with open(image_path, "wb") as f:
            f.write(buf.getvalue())
        print(f"[{tag}] {device_id} RGB565→JPEG: {buf.tell()} bytes")
        return image_path
    elif n >= 4 and decoded_bytes[0] == 0xFF and decoded_bytes[1] == 0xD8:
        with open(image_path, "wb") as f:
            f.write(decoded_bytes)
        print(f"[{tag}] {device_id} JPEG direct: {n} bytes")
        return image_path
    else:
        print(f"[{tag}] {device_id} unknown image format size={n}, skipping")
        return None


def _validate_device_id(raw: Optional[str]) -> str:
    """校验 device_id，不合法时返回安全的默认值。"""
    if raw and _DEVICE_ID_RE.match(raw):
        return raw
    return "default"


@app.route("/chat", methods=["POST"])
def handle_chat():
    """
    接收 WAV 文件，返回 WAV 文件。
    请求头: X-Device-Id: <设备唯一ID>（用于区分会话）
    请求体: WAV 音频（16kHz, 单声道, 16bit）

    若识别到拍照关键词，响应头额外携带 X-Need-Photo: 1，
    客户端收到后应拍照并将原始音频+图片发送至 /chat-vision。
    """
    device_id = _validate_device_id(request.headers.get("X-Device-Id"))
    if not state.check_rate(device_id):
        return jsonify({"error": "请求过于频繁，请稍后再试"}), 429
    local_time = request.headers.get("X-Local-Time", "")
    session_id = state.get_session(device_id)

    audio_data = request.get_data()
    if not audio_data:
        return jsonify({"error": "没有收到音频数据"}), 400
    if len(audio_data) > _MAX_AUDIO_BYTES:
        return jsonify({"error": "音频数据过大"}), 413

    # Fix 2: 请求级临时文件，避免并发路由互相覆盖
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_path = f.name
        f.write(audio_data)

    try:
        # 1. 语音识别
        user_text = transcribe(wav_path)
        print(f"[{device_id}] 🗣️  {user_text}")
        if not user_text:
            user_text = "我没有听清楚，请重说一遍"

        # 2. 快捷指令短路（时间/日期/星期），命中则跳过 OpenClaw
        quick = quick_commands.match(user_text, local_time=local_time)
        need_photo = False
        if quick is not None:
            reply = quick
            print(f"[{device_id}] ⚡  [quick] {reply}")
        else:
            # 3. 对话（由 OpenClaw 判断是否需要拍照，回复以 [PHOTO] 开头则触发）
            reply = chat(user_text, session_id, local_time=local_time)

            if reply.startswith("[PHOTO]"):
                need_photo = True
                reply = reply[len("[PHOTO]"):].strip()
                print(f"[{device_id}] 📷  OpenClaw 请求拍照，返回 X-Need-Photo: 1")

        preview = reply[:80].replace("\n", " ")
        print(f"[{device_id}] 💬  {preview}{'...' if len(reply) > 80 else ''}")

        # 4. TTS
        wav_out = synthesize(reply)
        if not wav_out:
            return jsonify({"error": "TTS 生成失败"}), 500

        with open(wav_out, "rb") as f:
            wav_data = f.read()
        print(f"[{device_id}] 📤  WAV {len(wav_data)} bytes")
        resp_headers = {"Content-Length": len(wav_data)}
        if need_photo:
            resp_headers["X-Need-Photo"] = "1"
        return Response(wav_data, mimetype="audio/wav", headers=resp_headers)

    except Exception as e:
        print(f"[{device_id}] ⚠️  错误: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(wav_path)


@app.route("/push", methods=["POST"])
def push_message():
    """
    主动推送文字消息，TTS 转 WAV 后存到磁盘，通过 MQTT 发 JSON 通知，
    设备收到后 HTTP GET 下载音频。
    请求体: {"text": "要播报的内容", "device_id": "cores3"}
    """
    data = request.get_json()
    if not data or not data.get("text"):
        return jsonify({"error": "text is required"}), 400
    text = data["text"]
    device_id = _validate_device_id(data.get("device_id", "cores3"))
    if _mqtt_client is None:
        return jsonify({"error": "MQTT 不可用，推送功能已禁用"}), 503
    try:
        wav_path = synthesize(text)
        if not wav_path:
            return jsonify({"error": "TTS 生成失败"}), 500
        fname = f"{uuid.uuid4().hex[:8]}.wav"
        dest = PUSH_AUDIO_DIR / fname
        shutil.copy(wav_path, dest)
        notify = json.dumps({"type": "push", "url": f"/push-audio/{fname}"})
        _mqtt_client.publish(f"kagura/push/{device_id}", notify, qos=1)
        print(f"[push] → {device_id} via MQTT notify: {text[:50]}{'...' if len(text) > 50 else ''}")
        return jsonify({"status": "ok", "device_id": device_id})
    except Exception as e:
        print(f"[push] ⚠️  错误: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/push-audio/<filename>", methods=["GET"])
def serve_push_audio(filename):
    """设备下载推送音频。下载后自动删除文件。"""
    fpath = PUSH_AUDIO_DIR / filename
    if not fpath.exists():
        return "", 404

    @after_this_request
    def cleanup(response):
        try:
            os.unlink(fpath)
        except OSError:
            pass
        return response

    return send_file(fpath, mimetype="audio/wav")


# ── 远程拍照命令 ──────────────────────────────────────────────────────────────

_UPLOAD_RATE_MAX = 30   # /upload-photo 每设备每分钟上限（与 /chat 的桶相互独立）


def _cleanup_photo_results() -> None:
    """清理超过 5 分钟的旧记录，同时删除对应磁盘文件。调用方需持 photos_lock。"""
    now = time.time()
    expired = [k for k, v in state.photo_results.items() if now - v.get("_ts", 0) > 300]
    for k in expired:
        entry = state.photo_results.pop(k)
        img = entry.get("image_path")
        if img:
            try:
                os.unlink(img)
            except OSError:
                pass


def _photo_cleanup_loop() -> None:
    """后台定期（每 5 分钟）清理过期照片记录，不依赖请求触发。"""
    while True:
        time.sleep(300)
        with state.photos_lock:
            _cleanup_photo_results()


@app.route("/capture-request", methods=["POST"])
def capture_request():
    """OpenClaw skill 调用：通过 MQTT 发送拍照命令给设备，返回 request_id。"""
    data = request.get_json() or {}
    device_id = _validate_device_id(data.get("device_id", "cores3"))
    if _mqtt_client is None:
        return jsonify({"error": "MQTT 不可用"}), 503
    request_id = str(uuid.uuid4())[:8]
    cmd = {"action": "capture", "request_id": request_id}
    with state.photos_lock:
        _cleanup_photo_results()
        state.photo_results[request_id] = {"status": "pending", "_ts": time.time()}
    _mqtt_client.publish(f"kagura/cmd/{device_id}", json.dumps(cmd), qos=1)
    print(f"[capture] 📷  MQTT 拍照命令 {request_id} → {device_id}")
    return jsonify({"request_id": request_id, "status": "queued"})


@app.route("/upload-photo", methods=["POST"])
def upload_photo():
    """设备拍照后上传图片。复用 RGB565→JPEG 转换逻辑。"""
    data = request.get_json()
    if not data or "request_id" not in data:
        return jsonify({"error": "missing request_id"}), 400

    request_id = data["request_id"]
    image_b64 = data.get("image", "")
    device_id = _validate_device_id(data.get("device_id", "cores3"))

    if not state.check_rate(device_id, bucket="upload", limit=_UPLOAD_RATE_MAX):
        return jsonify({"error": "上传过于频繁，请稍后再试"}), 429

    with state.photos_lock:
        if request_id not in state.photo_results:
            return jsonify({"error": "unknown request_id"}), 404

    image_path = _decode_image_b64(image_b64, device_id, tag="upload") if image_b64 else None

    with state.photos_lock:
        if image_path:
            state.photo_results[request_id] = {"status": "done", "image_path": image_path, "_ts": time.time()}
            print(f"[upload] ✅  {request_id} 照片已保存: {image_path}")
        else:
            state.photo_results[request_id] = {"status": "error", "error": "no valid image", "_ts": time.time()}
            print(f"[upload] ⚠️  {request_id} 无有效图片")

    return jsonify({"status": "ok", "request_id": request_id})


@app.route("/capture-result/<request_id>", methods=["GET"])
def capture_result(request_id: str):
    """Skill 轮询拍照结果。pending→202, done→200, 未知→404。"""
    with state.photos_lock:
        result = state.photo_results.get(request_id)
    if result is None:
        return jsonify({"error": "unknown request_id"}), 404
    if result["status"] == "pending":
        return jsonify({"status": "pending"}), 202
    if result["status"] == "error":
        return jsonify(result), 500
    return jsonify(result), 200


@app.route("/chat-vision", methods=["POST"])
def handle_chat_vision():
    """
    接收 JSON: {"wav": "<base64 WAV>", "image": "<base64 JPEG>"}
    图片可为空字符串（仅语音不含图片时）。
    返回 WAV 音频。
    """
    device_id  = _validate_device_id(request.headers.get("X-Device-Id"))
    if not state.check_rate(device_id):
        return jsonify({"error": "请求过于频繁，请稍后再试"}), 429
    local_time = request.headers.get("X-Local-Time", "")
    session_id = state.get_session(device_id)

    data = request.get_json()
    if not data or "wav" not in data:
        return jsonify({"error": "missing wav"}), 400

    wav_b64 = data["wav"]
    if len(wav_b64) > _MAX_AUDIO_BYTES:
        return jsonify({"error": "WAV 数据过大"}), 413
    try:
        wav_bytes = base64.b64decode(wav_b64)
    except Exception:
        return jsonify({"error": "WAV base64 解码失败"}), 400
    image_b64 = data.get("image", "")

    # Fix 2: 请求级临时文件
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_path = f.name
        f.write(wav_bytes)

    try:
        user_text = transcribe(wav_path) or "请分析这张图片"
        print(f"[{device_id}] 🗣️  {user_text}")

        image_path = _decode_image_b64(image_b64, device_id, tag="vision") if image_b64 else None

        reply = chat(user_text, session_id, image_path=image_path, local_time=local_time)
        preview = reply[:80].replace("\n", " ")
        print(f"[{device_id}] 💬  {preview}{'...' if len(reply) > 80 else ''}")

        wav_out = synthesize(reply)
        if not wav_out:
            return jsonify({"error": "TTS 生成失败"}), 500

        with open(wav_out, "rb") as f:
            wav_data = f.read()
        print(f"[{device_id}] 📤  WAV {len(wav_data)} bytes")
        return Response(wav_data, mimetype="audio/wav",
                        headers={"Content-Length": len(wav_data)})

    except Exception as e:
        print(f"[{device_id}] ⚠️  vision 错误: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(wav_path)


@app.route("/presence", methods=["POST"])
def handle_presence():
    """
    接收设备端 BLE 在家/出门状态变化通知。
    请求体: {"device_id": "cores3", "status": "home"|"away"}
    写入 OpenClaw workspace 状态文件，供 agent 读取。
    """
    data = request.get_json()
    if not data or "status" not in data:
        return jsonify({"error": "status is required"}), 400

    device_id = _validate_device_id(data.get("device_id", "cores3"))
    status = data["status"]
    if status not in ("home", "away"):
        return jsonify({"error": "status must be 'home' or 'away'"}), 400

    # 写入 OpenClaw workspace 状态文件
    presence_file = OPENCLAW_DIR / "workspace" / "tmp" / "user_presence.txt"
    presence_file.parent.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%S+08:00")
    presence_file.write_text(f"{status}\n{timestamp}\n{device_id}\n")

    # 同步更新 mio-home-status.json（OpenClaw agent 实际读取的文件）
    home_status_file = OPENCLAW_DIR / "workspace" / "tmp" / "mio-home-status.json"
    home_status = {
        "at_home": status == "home",
        "last_updated": timestamp,
        "last_action": "ble_detected_home" if status == "home" else "ble_detected_away",
    }
    home_status_file.write_text(json.dumps(home_status, ensure_ascii=False))

    print(f"[presence] {device_id} → {status} @ {timestamp}")

    return jsonify({"status": "ok"})


@app.route("/time", methods=["GET"])
def get_time():
    """返回服务端当前 Unix 时间戳，供设备同步 RTC。"""
    return jsonify({"timestamp": int(time.time())})


@app.route("/shake", methods=["GET"])
def handle_shake():
    """
    摇晃触发：立即返回，后台发消息给 OpenClaw。
    OpenClaw 处理后自动通过 /push 推送语音，设备通过 MQTT 接收播放。
    """
    device_id = _validate_device_id(request.headers.get("X-Device-Id"))
    if not state.check_rate(device_id):
        return jsonify({"error": "请求过于频繁，请稍后再试"}), 429
    local_time = request.headers.get("X-Local-Time", "")
    session_id = state.get_session(device_id)

    def _bg():
        try:
            reply = chat("用户摇了摇你，用语音跟她随便聊几句吧", session_id, local_time=local_time)
            preview = reply[:80].replace("\n", " ")
            print(f"[{device_id}] 🫨  shake → {preview}{'...' if len(reply) > 80 else ''}")
        except Exception as e:
            print(f"[{device_id}] ⚠️  shake 错误: {e}")

    threading.Thread(target=_bg, daemon=True).start()
    return jsonify({"status": "ok"})


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
    _asr_tokens.get()
    print(" OK")
    _init_mqtt()
    threading.Thread(target=_photo_cleanup_loop, daemon=True, name="photo-cleanup").start()
    print(f"Agent : {AGENT_ID}  |  TTS : {TTS_VOICE}")
    print("监听 0.0.0.0:5000，Ctrl+C 退出\n")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
