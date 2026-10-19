#!/usr/bin/env python3
"""
OpenClaw 语音服务端
- 接收 Core2 发来的 WAV 音频
- 百度语音识别 → openclaw agent → edge-tts 合成
- 返回 MP3 给 Core2 播放

启动: python3 voice_server.py
端口: 5000
"""

import array
import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Optional
import shutil
import requests as http_requests
from flask import Flask, request, send_file, jsonify, Response, after_this_request
import paho.mqtt.client as mqtt

from baidu_tokens import BaiduTokenCache
import photo_schedules
import quick_commands
import reminders
import roles
import stream_server

# ── 路径配置 ──────────────────────────────────────────────────────────────────

OPENCLAW_DIR = Path.home() / ".openclaw"
TTS_SCRIPT = str(OPENCLAW_DIR / "workspace/skills/edge-tts/scripts/tts-converter.js")
TTS_VOICE = "zh-CN-XiaoxiaoNeural"
OPENCLAW_BIN = str(Path.home() / ".npm-global/bin/openclaw")
AGENT_ID = "main"

PULSE_ENV = {**os.environ, "PULSE_SERVER": "unix:/mnt/wslg/PulseServer"}

WAV_PATH = "/tmp/oc_server_input.wav"
MP3_PATH = "/tmp/oc_server_response.mp3"
PUSH_AUDIO_DIR = Path(__file__).parent / "push_audio"
PUSH_AUDIO_DIR.mkdir(exist_ok=True)
PUSH_AUDIO_MAX_FILES = 50    # 设备下载即删,这里只兜底清理下载失败的孤儿文件

# TTS 内容寻址缓存:同一文本+音色只调一次百度 API(固定提示语零成本/零延迟)
TTS_CACHE_DIR = Path(__file__).parent / "tts_cache"
TTS_CACHE_DIR.mkdir(exist_ok=True)
TTS_CACHE_MAX_FILES = 200

VISION_TMP_DIR = OPENCLAW_DIR / "workspace" / "tmp"
VISION_TMP_DIR.mkdir(parents=True, exist_ok=True)

# 定时拍照的留档：photo_results 5 分钟就清，这里长期保留供网页回看
SNAPSHOT_DIR = Path(__file__).parent / "snapshots"
SNAPSHOT_DIR.mkdir(exist_ok=True)
SNAPSHOT_MAX = 60

WEB_DIR = Path(__file__).parent / "web"

# 每台设备最近一次上传的录音（覆盖写，只留一条）：识别差时拿来试听，
# 分辨是「录音本身就糊」还是「百度没认出来」。GET /debug-audio/<device_id>
DEBUG_AUDIO_DIR = Path(__file__).parent / "debug_audio"

SAMPLE_RATE = 16000

# ── 百度语音识别 ──────────────────────────────────────────────────────────────

from config import BAIDU_API_KEY, BAIDU_SECRET_KEY, BAIDU_TTS_API_KEY, BAIDU_TTS_SECRET_KEY
from oc_utils import _extract_json, strip_markdown

# 可选共享密钥：config.py 里设置 API_TOKEN 后，/push 与 /capture-request 需携带
# X-Api-Token 头。留空（或旧版 config.py 没有此项）= 完全开放，行为与之前一致。
try:
    from config import API_TOKEN
except ImportError:
    API_TOKEN = ""

# 可选：角色表（多 agent）。没配就只有一个默认角色，行为与加角色前一致。见 config.example.py
try:
    from config import ROLES
except ImportError:
    ROLES = None
roles.init(ROLES)

# 直播流（TCP :5002）的握手密钥。默认留空 = 不校验，与 /upload-photo 等
# 其它「设备 → 服务端」接口口径一致。要启用得同时改设备端的 STREAM_TOKEN。
try:
    from config import STREAM_TOKEN
except ImportError:
    STREAM_TOKEN = ""

_asr_tokens = BaiduTokenCache(BAIDU_API_KEY, BAIDU_SECRET_KEY, name="ASR")
_tts_tokens = BaiduTokenCache(BAIDU_TTS_API_KEY, BAIDU_TTS_SECRET_KEY, name="TTS")

# 连接池复用：省去每次调百度 API 的 TLS 握手（每轮对话 ASR+TTS 各省 100-200ms）
_http = http_requests.Session()


def _post_with_retry(url: str, *, data, headers: Optional[dict] = None,
                     timeout: float = 15, attempts: int = 2):
    """百度 API 调用带一次退避重试，网络抖动不再直接把错误抛给用户。"""
    last_err: Exception = RuntimeError("unreachable")
    for i in range(attempts):
        try:
            return _http.post(url, data=data, headers=headers, timeout=timeout)
        except http_requests.RequestException as e:
            last_err = e
            if i + 1 < attempts:
                print(f"[http] 请求失败重试 ({i + 1}/{attempts}): {e}")
                time.sleep(0.5 * (i + 1))
    raise last_err


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
    resp = _post_with_retry(
        "https://vop.baidu.com/server_api",
        data=payload,
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    result = resp.json()
    if result.get("err_no") != 0:
        # 别静默吞掉：3301=音质差/无有效语音、3302=鉴权、3308=音频过长……
        # 这是区分「录音问题」和「API 问题」的第一手证据
        print(f"[asr] ❌ err_no={result.get('err_no')} {result.get('err_msg', '')}")
        return ""
    results = result.get("result", [])
    if not results:
        print("[asr] ❌ 返回成功但 result 为空")
        return ""
    return results[0].strip()


def _audio_stats(wav: bytes) -> Optional[dict]:
    """粗看一条 16bit 单声道 WAV 的电平：时长、去直流 RMS、峰值、削波比例、直流偏置。

    用来判断录音本身好不好：rms 只有几百 = 增益太低/离太远；
    clip 超过 1% = 增益太高、声音被削顶；dc 很大 = 麦克风有直流偏置。
    """
    if len(wav) < 44 + 2 or wav[:4] != b"RIFF":
        return None
    body = wav[44:]
    a = array.array("h")
    a.frombytes(body[: len(body) // 2 * 2])
    n = len(a)
    if n == 0:
        return None
    s = sum(a)
    s2 = sum(v * v for v in a)
    mean = s / n
    var = max(0.0, s2 / n - mean * mean)
    peak = max(abs(min(a)), abs(max(a)))
    clip = sum(1 for v in a if v >= 32000 or v <= -32000)
    return {
        "dur": round(n / SAMPLE_RATE, 2),
        "rms": int(var ** 0.5),
        "peak": peak,
        "clip_pct": round(clip * 100 / n, 2),
        "dc": int(mean),
    }


def _keep_debug_audio(device_id: str, wav: bytes) -> None:
    """留存最近一条录音并打印电平摘要。失败不影响对话。"""
    try:
        st = _audio_stats(wav)
        if st:
            print(f"[{device_id}] 🎙️  {st['dur']}s rms={st['rms']} peak={st['peak']}"
                  f" clip={st['clip_pct']}% dc={st['dc']}")
        DEBUG_AUDIO_DIR.mkdir(exist_ok=True)
        (DEBUG_AUDIO_DIR / f"{device_id}_last.wav").write_bytes(wav)
    except Exception as e:
        print(f"[{device_id}] debug audio 保存失败: {e}")

# ── 对话 ──────────────────────────────────────────────────────────────────────

# openclaw CLI 每次调用起一个子进程：全局最多 2 个并发；同一 session 串行，
# 避免两台设备（或 /shake 后台线程与 /chat）同时写同一 session 文件。
_chat_semaphore = threading.Semaphore(2)
_session_locks: dict = {}
_session_locks_guard = threading.Lock()


def _get_session_lock(session_id: str) -> threading.Lock:
    with _session_locks_guard:
        if len(_session_locks) > 200:
            for k in [k for k, v in _session_locks.items() if not v.locked()][:100]:
                del _session_locks[k]
        lock = _session_locks.get(session_id)
        if lock is None:
            lock = threading.Lock()
            _session_locks[session_id] = lock
        return lock


def chat(user_text: str, session_id: str, image_path: Optional[str] = None,
         local_time: Optional[str] = None, agent: Optional[str] = None) -> str:
    message = user_text
    if local_time:
        message = f"[当前时间: {local_time}] {message}"
    if image_path:
        message = f"{message}\n\n[用户通过CoreS3摄像头拍了一张照片，保存在 {image_path}，请识别这张图片来回答问题]"
    cmd = [
        OPENCLAW_BIN, "agent",
        "--agent", agent or AGENT_ID,
        "--message", message,
        "--session-id", session_id,
        "--json",
        "--timeout", "120",
    ]
    with _get_session_lock(session_id), _chat_semaphore:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=130)
    if result.returncode != 0:
        # stderr 开头常是无害的 state-migrations 警告，真实错误在末尾；
        # 去掉 ANSI 颜色码和警告行，只留最后几行有效内容
        err = re.sub(r"\x1b\[[0-9;]*m", "", result.stderr or "")
        lines = [l.strip() for l in err.splitlines()
                 if l.strip() and "state-migrations" not in l
                 and "migration warnings" not in l.lower()
                 and not l.strip().startswith("- Left")]
        detail = " | ".join(lines[-3:]) if lines else err[-300:]
        raise RuntimeError(f"openclaw 失败(rc={result.returncode}): {detail[:500]}")
    data = _extract_json(result.stdout)
    if data.get("status") != "ok":
        raise RuntimeError(f"agent 状态异常: {data.get('status')}")
    return data["result"]["payloads"][0]["text"]


# ── TTS ───────────────────────────────────────────────────────────────────────

def _prune_dir(dirpath: Path, max_files: int) -> None:
    """按 mtime 保留最新 max_files 个 wav，其余删除（LRU 兜底，防止目录无限膨胀）。"""
    files = sorted(dirpath.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in files[max_files:]:
        try:
            stale.unlink()
        except OSError:
            pass


def synthesize(text: str, per: int = 111) -> Optional[str]:
    """百度 TTS：文字 → PCM → 干净 WAV。

    结果按 md5(文本+音色参数) 缓存于 TTS_CACHE_DIR，命中直接返回，
    不再调百度 API——固定提示语（如 Claude 权限提醒）只合成一次。
    """
    clean = strip_markdown(text)
    if not clean:
        return None
    # key 带上音色参数：以后改音色/语速，旧缓存自动失效
    # per 进 key 且格式与旧版一致：默认音色 111 的旧缓存照样命中
    cache_key = hashlib.md5(f"{clean}|spd5|pit5|vol10|per{per}|aue4".encode("utf-8")).hexdigest()
    cache_path = TTS_CACHE_DIR / f"{cache_key}.wav"
    if cache_path.exists():
        cache_path.touch()  # 刷新 mtime，供 LRU 保留热门条目
        print(f"[tts] ♻️  缓存命中: {clean[:30]}{'...' if len(clean) > 30 else ''}")
        return str(cache_path)
    token = _tts_tokens.get()
    resp = _post_with_retry(
        "https://tsn.baidu.com/text2audio",
        data={
            "tex": clean,
            "tok": token,
            "cuid": "core2_client",
            "ctp": 1,
            "lan": "zh",
            "spd": 5,
            "pit": 5,
            "vol": 10,
            "per": per,    # 111=度小萌(可爱女声)；角色可各配一个（roles.py）
            "aue": 4,       # 4=pcm-16k
        },
        timeout=15,
    )
    ct = resp.headers.get("Content-Type", "")
    body = resp.content
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
    # 先写临时文件再原子改名：并发合成同一文本时不会读到半个 WAV
    fd, tmp = tempfile.mkstemp(suffix=".part", dir=TTS_CACHE_DIR)
    with os.fdopen(fd, "wb") as f:
        f.write(header + body)
    os.replace(tmp, cache_path)
    _prune_dir(TTS_CACHE_DIR, TTS_CACHE_MAX_FILES)
    return str(cache_path)


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

        # 快捷指令命中的问答暂存：下次走 LLM 时作为背景带上，避免上下文断层
        self.last_quick: dict[str, tuple[str, str]] = {}

    def set_last_quick(self, session_id: str, question: str, answer: str) -> None:
        with self.sessions_lock:
            self.last_quick[session_id] = (question, answer)

    def pop_last_quick(self, session_id: str) -> Optional[tuple[str, str]]:
        with self.sessions_lock:
            return self.last_quick.pop(session_id, None)

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


def _rgb565_to_jpeg_bytes(raw: bytes, quality: int = 85) -> Optional[bytes]:
    """RGB565 裸帧 → JPEG 字节。分辨率靠字节数反查，对不上返回 None。

    拍照与直播共用。设备端 _CAM_SIZES 要与 RGB565_SIZES 保持一致。
    """
    W, H = RGB565_SIZES.get(len(raw), (None, None))
    if W is None:
        return None
    import numpy as np
    from PIL import Image as PILImage
    import io as _io
    pixels = np.frombuffer(raw, dtype=np.uint16).byteswap()
    r = ((pixels >> 11) & 0x1F) * 255 // 31
    g = ((pixels >> 5)  & 0x3F) * 255 // 63
    b = (pixels         & 0x1F) * 255 // 31
    rgb = np.stack([r, g, b], axis=-1).astype(np.uint8).reshape(H, W, 3)
    buf = _io.BytesIO()
    PILImage.fromarray(rgb).save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def _stream_frame_to_jpeg(raw: bytes) -> Optional[bytes]:
    """直播帧转换：质量压到 70，单帧小一半，肉眼几乎看不出差别。"""
    return _rgb565_to_jpeg_bytes(raw, quality=70)


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

    jpeg = _rgb565_to_jpeg_bytes(decoded_bytes)
    if jpeg is not None:
        with open(image_path, "wb") as f:
            f.write(jpeg)
        print(f"[{tag}] {device_id} RGB565→JPEG: {len(jpeg)} bytes")
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


def _b64_header(text: str, max_chars: int = 60) -> str:
    """把 UTF-8 文本裁剪后 b64 编码，塞进 HTTP 响应头供设备屏显。"""
    return base64.b64encode(text[:max_chars].encode("utf-8")).decode("ascii")


# ── 触觉：X-Touch 体感摘要 ────────────────────────────────────
#
# 设备端把"上次对话之后被怎么碰过"聚合成 k=v,k=v 的紧凑摘要（见
# cores3_client.feel_header），这里翻译成一句中文背景注入 prompt。
# 走请求头而不是单独的路由，是为了不额外占一次 LLM 调用——体感是背景，
# 不是事件；真正值得让她开口的事件走 /touch。

_TOUCH_MAX_HEADER = 200          # 头长上限，超过视为异常直接忽略


def _touch_phrases(raw: str) -> list[str]:
    """解析 X-Touch 摘要为中文短句列表。无法解析的键值静默跳过。"""
    if not raw or len(raw) > _TOUCH_MAX_HEADER:
        return []
    vals: dict[str, int] = {}
    for item in raw.split(","):
        k, _, v = item.partition("=")
        k = k.strip()
        try:
            vals[k] = int(v)
        except ValueError:
            continue

    out: list[str] = []
    secs = vals.get("stroke", 0)
    if secs > 0:
        n = vals.get("strokes", 1)
        if n > 1:
            out.append(f"刚才用户摸了你 {n} 次，一共约 {secs} 秒")
        else:
            out.append(f"刚才用户摸了你大约 {secs} 秒")
    if vals.get("cradles", 0) > 0:
        out.append("用户把手掌整个覆在你身上，像捧着你")
    if vals.get("taps", 0) > 0:
        out.append(f"用户轻拍了你的机身 {vals['taps']} 下")
    if vals.get("pickups", 0) > 0:
        out.append("用户把你从桌上拿起来过")
    if vals.get("carry", 0) >= 5:
        out.append(f"你被端在手上移动了约 {vals['carry']} 秒")
    quiet = vals.get("quiet", 0)
    if quiet > 0:
        out.append(f"在此之前已经 {quiet // 60} 分钟没有人碰过你")
    return out


def _touch_background(raw: str) -> str:
    """X-Touch → 注入 prompt 的背景行。没有可报的体感返回空串。"""
    phrases = _touch_phrases(raw)
    if not phrases:
        return ""
    return "[身体感觉：" + "；".join(phrases) + "]"


def _with_touch(text: str, raw: str) -> str:
    """把体感背景拼到用户发言前面。"""
    bg = _touch_background(raw)
    return f"{bg}\n{text}" if bg else text


def _token_ok() -> bool:
    """API_TOKEN 未设置时永远放行（默认开放）；设置后校验 X-Api-Token 头。"""
    if not API_TOKEN:
        return True
    return request.headers.get("X-Api-Token", "") == API_TOKEN


_IP_RATE_MAX = 60   # 按来源 IP 的兜底限流（次/分钟）：防 device_id 换名刷请求


def _ip_rate_ok() -> bool:
    """来源 IP 兜底桶。注意 WSL 端口转发下所有设备共享代理 IP，上限须宽于单设备限额。"""
    ip = request.remote_addr or "unknown"
    return state.check_rate(ip, bucket="ip", limit=_IP_RATE_MAX)


_ASR_EMPTY_REPLY = "没听清，能再说一遍吗？"
_CONT_EXIT_REPLY = "好的，有事再叫我。"


def _role_ctx(device_id: str):
    """设备当前角色 + 该角色的会话。所有调 chat() 的地方都走这里，
    否则切了角色之后定时拍照/摇一摇还在找原来那个 agent。"""
    role = roles.get(device_id)
    return role, state.get_session(roles.session_key(device_id, role))

# 设备端 cfg.REQUEST_TIMEOUT_CHAT。超过它设备早已 ETIMEDOUT 放弃，
# 这边照常把 WAV 发出去也没人收——日志里那行「📤 WAV」会让人误以为送达了
_DEVICE_CHAT_TIMEOUT = 60


def _log_timing(device_id: str, t0: float, t_asr: float, t_llm: float) -> None:
    """一行分阶段耗时；超过设备超时就明确告警。"""
    now = time.time()
    total = now - t0
    warn = f"  ⚠️ 超过设备超时 {_DEVICE_CHAT_TIMEOUT}s，设备收不到这条" \
        if total > _DEVICE_CHAT_TIMEOUT else ""
    print(f"[{device_id}] ⏱️  asr={t_asr - t0:.1f}s llm={t_llm - t_asr:.1f}s"
          f" tts={now - t_llm:.1f}s 总={total:.1f}s{warn}")


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
    if not state.check_rate(device_id) or not _ip_rate_ok():
        return jsonify({"error": "请求过于频繁，请稍后再试"}), 429
    local_time = request.headers.get("X-Local-Time", "")
    role, session_id = _role_ctx(device_id)

    audio_data = request.get_data()
    if not audio_data:
        return jsonify({"error": "没有收到音频数据"}), 400
    if len(audio_data) > _MAX_AUDIO_BYTES:
        return jsonify({"error": "音频数据过大"}), 413

    # Fix 2: 请求级临时文件，避免并发路由互相覆盖
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_path = f.name
        f.write(audio_data)

    _keep_debug_audio(device_id, audio_data)
    _hb_seen(device_id)

    t0 = time.time()
    try:
        # 1. 语音识别
        user_text = transcribe(wav_path)
        t_asr = time.time()
        print(f"[{device_id}] 🗣️  {user_text}")

        # 2. 本地短路链：没听清 → 免手退出 → 角色 → 定时提醒 → 音量 → 快捷指令，
        #    命中则跳过 OpenClaw
        need_photo = False
        extra_headers: dict = {}
        reply = None
        remember = True          # 短路问答要不要记进 last_quick（没听清/退出/切角色都不记）
        hands_free = request.headers.get("X-Mode", "") in ("continuous", "wake")

        if user_text and hands_free and quick_commands.is_filler(user_text):
            # 免手模式下「嗯」「啊」多半是环境声被认成了字：当没听清处理，
            # 设备端收到 X-Asr-Empty 会悄悄接着听、攒够次数自动退出
            print(f"[{device_id}] 🙉  [filler] {user_text}")
            user_text = ""

        if not user_text:
            # 识别为空直接回固定句（TTS 有缓存，零成本）。旧做法是把
            # "我没有听清楚，请重说一遍"当成用户的话发给 agent——多等 3~10 秒，
            # 回答还常常驴唇不对马嘴；也不记 last_quick，免得污染下次对话
            reply = _ASR_EMPTY_REPLY
            user_text = "（没听清）"
            remember = False
            extra_headers["X-Asr-Empty"] = "1"
            print(f"[{device_id}] 🙉  [asr-empty] {reply}")

        if reply is None and hands_free and quick_commands.match_cont_exit(user_text):
            reply = _CONT_EXIT_REPLY
            remember = False
            extra_headers["X-Cont-Exit"] = "1"
            print(f"[{device_id}] 👋  [cont-exit] {user_text}")

        if reply is None:
            listing = roles.match_list(user_text)
            if listing:
                reply = listing
                print(f"[{device_id}] 🎭  [role-list]")
        if reply is None:
            target = roles.match_switch(user_text)
            if target is not None:
                remember = False
                if target["id"] == role["id"]:
                    reply = f"我就是{target['name']}呀。"
                else:
                    roles.set_role(device_id, target["id"])
                    role = target                      # 下面的 TTS 用新角色的音色
                    reply = roles.greeting(target)
                print(f"[{device_id}] 🎭  [role] → {target['name']} ({target['agent']})")

        rem = None if reply is not None else \
            quick_commands.match_reminder(user_text, local_time=local_time)
        if rem is not None:
            fire_ts, task, reply = rem
            reminders.schedule(fire_ts, task, device_id)
            print(f"[{device_id}] ⏰  [reminder] {reply}")
        if reply is None:
            vol = quick_commands.match_volume(user_text)
            if vol is not None:
                direction, reply = vol
                extra_headers["X-Volume"] = direction
                print(f"[{device_id}] 🔊  [volume] {direction}")
        if reply is None:
            quick = quick_commands.match(user_text, local_time=local_time)
            if quick is not None:
                reply = quick
                print(f"[{device_id}] ⚡  [quick] {reply}")

        if reply is not None and not remember:
            pass
        elif reply is not None:
            # 短路命中：记入 pending 上下文，下次走 LLM 时带给它
            state.set_last_quick(session_id, user_text, reply)
        else:
            # 3. 对话（由 OpenClaw 判断是否需要拍照，回复以 [PHOTO] 开头则触发）
            llm_text = user_text
            prev = state.pop_last_quick(session_id)
            if prev:
                llm_text = (f"[背景：用户刚才问「{prev[0]}」，快捷指令已回复「{prev[1]}」]\n"
                            f"{user_text}")
            # 体感背景：上次对话之后被怎么碰过（X-Touch，设备端聚合）
            llm_text = _with_touch(llm_text, request.headers.get("X-Touch", ""))
            reply = chat(llm_text, session_id, local_time=local_time, agent=role["agent"])

            if reply.startswith("[PHOTO]"):
                need_photo = True
                reply = reply[len("[PHOTO]"):].strip()
                print(f"[{device_id}] 📷  OpenClaw 请求拍照，返回 X-Need-Photo: 1")

        preview = reply[:80].replace("\n", " ")
        print(f"[{device_id}] 💬  {preview}{'...' if len(reply) > 80 else ''}")

        # 4. TTS
        t_llm = time.time()
        wav_out = synthesize(reply, per=role["per"])
        if not wav_out:
            return jsonify({"error": "TTS 生成失败"}), 500
        _log_timing(device_id, t0, t_asr, t_llm)
        _hb_seen(device_id)

        with open(wav_out, "rb") as f:
            wav_data = f.read()
        print(f"[{device_id}] 📤  WAV {len(wav_data)} bytes")
        resp_headers = {"Content-Length": len(wav_data), **extra_headers}
        if need_photo:
            resp_headers["X-Need-Photo"] = "1"
        # 屏显文本（HTTP 头只能 ASCII，b64 编码 UTF-8）
        resp_headers["X-User-Text"] = _b64_header(user_text)
        resp_headers["X-Reply-Text"] = _b64_header(reply)
        resp_headers["X-Role"] = role["id"]     # 设备据此换背景图（id 只许 ASCII，见 roles.py）
        return Response(wav_data, mimetype="audio/wav", headers=resp_headers)

    except Exception as e:
        print(f"[{device_id}] ⚠️  错误: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(wav_path)


def _send_push(text: str, device_id: str) -> bool:
    """TTS 合成 → 存盘 → MQTT 通知设备下载播放。/push 路由与提醒调度共用。"""
    if _mqtt_client is None:
        return False
    wav_path = synthesize(text, per=roles.get(device_id)["per"])   # 用设备当前角色的音色
    if not wav_path:
        return False
    fname = f"{uuid.uuid4().hex[:8]}.wav"
    dest = PUSH_AUDIO_DIR / fname
    shutil.copy(wav_path, dest)
    _prune_dir(PUSH_AUDIO_DIR, PUSH_AUDIO_MAX_FILES)
    notify = json.dumps({"type": "push", "url": f"/push-audio/{fname}"})
    _mqtt_client.publish(f"kagura/push/{device_id}", notify, qos=1)
    print(f"[push] → {device_id} via MQTT notify: {text[:50]}{'...' if len(text) > 50 else ''}")
    return True


@app.route("/push", methods=["POST"])
def push_message():
    """
    主动推送文字消息，TTS 转 WAV 后存到磁盘，通过 MQTT 发 JSON 通知，
    设备收到后 HTTP GET 下载音频。
    请求体: {"text": "要播报的内容", "device_id": "cores3"}
    """
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    data = request.get_json()
    if not data or not data.get("text"):
        return jsonify({"error": "text is required"}), 400
    text = data["text"]
    device_id = _validate_device_id(data.get("device_id", "cores3"))
    if _mqtt_client is None:
        return jsonify({"error": "MQTT 不可用，推送功能已禁用"}), 503
    try:
        if not _send_push(text, device_id):
            return jsonify({"error": "TTS 生成失败"}), 500
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


_CAPTURE_RATE_MAX = 30   # 拍照命令每设备每分钟上限：网页自动刷新最快 5s 一张也够用


def _issue_capture(device_id: str) -> str:
    """登记一条 pending 记录并通过 MQTT 下发拍照命令，返回 request_id。

    调用方需先确认 _mqtt_client 不为 None。
    """
    request_id = str(uuid.uuid4())[:8]
    cmd = {"action": "capture", "request_id": request_id}
    with state.photos_lock:
        _cleanup_photo_results()
        state.photo_results[request_id] = {"status": "pending", "_ts": time.time()}
    _mqtt_client.publish(f"kagura/cmd/{device_id}", json.dumps(cmd), qos=1)
    print(f"[capture] 📷  MQTT 拍照命令 {request_id} → {device_id}")
    return request_id


def _capture_from_stream(device_id: str) -> Optional[str]:
    """直播中抓拍：把手上最新一帧存成照片，返回 request_id；没有活跃直播返回 None。

    不能走 MQTT 让设备拍——设备正忙着推流，_stream_drain_cmds 会把拍照命令
    压回队列，要等直播结束才执行。而且直播时服务端本来就有画面，直接用就是
    所见即所得。代价：分辨率是直播的 QQVGA(160×120)，比正常拍照糊。
    """
    rec = stream_server.latest(device_id)
    if not rec or not rec.get("jpeg"):
        return None
    if time.time() - rec["ts"] > stream_server.STALE_AFTER:
        return None          # 直播已经停了，最新一帧是陈的，交给正常拍照流程
    image_path = str(VISION_TMP_DIR / f"oc_vision_{uuid.uuid4().hex[:8]}.jpg")
    try:
        with open(image_path, "wb") as f:
            f.write(rec["jpeg"])
    except OSError as e:
        print(f"[capture] ⚠️  直播抓拍写盘失败: {e}")
        return None
    request_id = str(uuid.uuid4())[:8]
    with state.photos_lock:
        _cleanup_photo_results()
        state.photo_results[request_id] = {
            "status": "done", "image_path": image_path, "_ts": time.time()}
    print(f"[capture] 📸  {device_id} 直播抓拍 {request_id}（第 {rec['seq']} 帧）")
    return request_id


def _capture_and_wait(device_id: str, timeout: float = 45.0) -> tuple[Optional[str], Optional[str]]:
    """下发拍照命令并同步等设备上传，返回 (image_path, error)。

    只在后台线程里用（定时任务 / 网页试跑），HTTP 路由请走 _issue_capture + 轮询。
    设备离线时会一直等到超时——上层要把这个错误如实报出来。
    """
    if _mqtt_client is None:
        return None, "MQTT 不可用，无法下发拍照命令"
    request_id = _issue_capture(device_id)
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.5)
        with state.photos_lock:
            rec = state.photo_results.get(request_id)
        if rec is None:
            return None, "拍照记录已被清理"
        if rec["status"] == "done":
            return rec.get("image_path"), None
        if rec["status"] == "error":
            return None, rec.get("error", "设备拍照失败")
    return None, f"等待设备上传超时（{int(timeout)}s），设备可能离线或摄像头不可用"


@app.route("/capture-request", methods=["POST"])
def capture_request():
    """OpenClaw skill 调用：通过 MQTT 发送拍照命令给设备，返回 request_id。"""
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    data = request.get_json(silent=True) or {}
    device_id = _validate_device_id(data.get("device_id", "cores3"))
    if not state.check_rate(device_id, bucket="capture", limit=_CAPTURE_RATE_MAX):
        return jsonify({"error": "拍照过于频繁，请稍后再试"}), 429
    if _mqtt_client is None:
        return jsonify({"error": "MQTT 不可用"}), 503
    return jsonify({"request_id": _issue_capture(device_id), "status": "queued"})


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
    """Skill 轮询拍照结果。pending→202, done→200, 未知→404。

    done 时同时给出 image_path（本机路径，OpenClaw skill 直接读文件）和
    image_url（HTTP 路径，网页用）——skill 依赖 image_path，勿删。
    """
    with state.photos_lock:
        result = state.photo_results.get(request_id)
    if result is None:
        return jsonify({"error": "unknown request_id"}), 404
    if result["status"] == "pending":
        return jsonify({"status": "pending"}), 202
    if result["status"] == "error":
        return jsonify(result), 500
    return jsonify({**result, "image_url": f"/photo/{request_id}"}), 200


@app.route("/photo/<request_id>", methods=["GET"])
def serve_photo(request_id: str):
    """网页读取一次拍照的 JPEG。照片 5 分钟后被清理线程删除，之后返回 404。"""
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    with state.photos_lock:
        result = state.photo_results.get(request_id)
    if not result or result.get("status") != "done":
        return jsonify({"error": "no photo for this request_id"}), 404
    path = result.get("image_path")
    if not path or not os.path.exists(path):
        return jsonify({"error": "photo file已过期"}), 404
    return send_file(path, mimetype="image/jpeg")


# 设备取景模式手动拍照时没有提问，用它当默认提问交给 OpenClaw
_PHOTO_ONLY_PROMPT = "我用 CoreS3 摄像头拍了一张照片给你看，看看这是什么吧"


@app.route("/chat-vision", methods=["POST"])
def handle_chat_vision():
    """
    接收 JSON: {"wav": "<base64 WAV>", "text": "<提问文本>", "image": "<base64 图片>"}
    三个字段都可选，但 wav 与 image 至少要有一个：

      - wav + image：语音触发拍照的第二段（ASR 出提问 + 照片一起给 OpenClaw）
      - 仅 image   ：设备取景模式手动拍照，没有提问 → 用 _PHOTO_ONLY_PROMPT
      - text       ：无 wav 时作为提问文本（有 wav 时以 ASR 结果为准）

    返回 WAV 音频，响应头带 X-User-Text / X-Reply-Text（b64 UTF-8，供设备屏显）。
    """
    device_id  = _validate_device_id(request.headers.get("X-Device-Id"))
    if not state.check_rate(device_id) or not _ip_rate_ok():
        return jsonify({"error": "请求过于频繁，请稍后再试"}), 429
    local_time = request.headers.get("X-Local-Time", "")
    role, session_id = _role_ctx(device_id)

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "missing json body"}), 400

    wav_b64   = data.get("wav", "")
    image_b64 = data.get("image", "")
    if not wav_b64 and not image_b64:
        return jsonify({"error": "wav or image is required"}), 400

    # Fix 2: 请求级临时文件
    wav_path = None
    if wav_b64:
        if len(wav_b64) > _MAX_AUDIO_BYTES:
            return jsonify({"error": "WAV 数据过大"}), 413
        try:
            wav_bytes = base64.b64decode(wav_b64)
        except Exception:
            return jsonify({"error": "WAV base64 解码失败"}), 400
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            wav_path = f.name
            f.write(wav_bytes)
        _keep_debug_audio(device_id, wav_bytes)
    _hb_seen(device_id)

    t0 = time.time()
    try:
        if wav_path:
            user_text = transcribe(wav_path) or _PHOTO_ONLY_PROMPT
        else:
            user_text = (data.get("text") or "").strip() or _PHOTO_ONLY_PROMPT
        t_asr = time.time()
        print(f"[{device_id}] 🗣️  {user_text}")

        image_path = _decode_image_b64(image_b64, device_id, tag="vision") if image_b64 else None

        llm_text = _with_touch(user_text, request.headers.get("X-Touch", ""))
        reply = chat(llm_text, session_id, image_path=image_path,
                     local_time=local_time, agent=role["agent"])
        preview = reply[:80].replace("\n", " ")
        print(f"[{device_id}] 💬  {preview}{'...' if len(reply) > 80 else ''}")

        t_llm = time.time()
        wav_out = synthesize(reply, per=role["per"])
        if not wav_out:
            return jsonify({"error": "TTS 生成失败"}), 500
        _log_timing(device_id, t0, t_asr, t_llm)
        _hb_seen(device_id)

        with open(wav_out, "rb") as f:
            wav_data = f.read()
        print(f"[{device_id}] 📤  WAV {len(wav_data)} bytes")
        return Response(wav_data, mimetype="audio/wav", headers={
            "Content-Length": len(wav_data),
            "X-User-Text":  _b64_header(user_text),
            "X-Reply-Text": _b64_header(reply),
            "X-Role":       role["id"],
        })

    except Exception as e:
        print(f"[{device_id}] ⚠️  vision 错误: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if wav_path:
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


# ── 设备心跳 / 远程诊断 ──────────────────────────────────────────────────────
# 设备每分钟 POST /heartbeat（状态 + 增量 dbg 日志）。日志落盘 device_logs/，
# 失联/恢复在服务端日志留下带时长的记录。GET /device-status 随时查当前状态。

DEVICE_LOGS_DIR = Path("device_logs")
_HB_SILENT_SECS = 200          # 超过此秒数无心跳视为失联（心跳间隔 60s）

_hb_devices: dict = {}         # device_id → {"ts", "data", "alerted"}
_hb_lock = threading.Lock()


def _hb_seen(device_id: str) -> None:
    """设备发来的任何业务请求都证明它活着，顺手刷新心跳时刻。

    设备在对话期间（busy）不发心跳：LLM 40 秒 + 播放一分钟，再叠上前一次心跳
    的间隔，就超过 _HB_SILENT_SECS，日志里冒出假的「心跳中断/恢复」。
    只刷新已知设备的时刻，不动 data（遥测仍以真心跳为准）。
    """
    with _hb_lock:
        rec = _hb_devices.get(device_id)
        if rec is not None:
            rec["ts"] = time.time()
            rec["alerted"] = False


def _vad_note(data: dict) -> str:
    """心跳里的录音门槛：[底噪, 说话阈值, 唤醒阈值]。说话识别不灵先看这个。"""
    v = data.get("vad")
    if not v or len(v) < 3:
        return ""
    return f" vad=底噪{v[0]}/说话{v[1]}/唤醒{v[2]}"


def _wdt_note(data: dict) -> str:
    """把心跳里的看门狗状态翻成一眼能看懂的字样。

    设备僵死却不复位时，第一个要问的就是"它到底有没有看门狗"——
    8/26 那次查了半天才想到这一层，之后每条心跳都自己带着答案。
    旧固件不上报这个字段，显示为"未知"。
    """
    ms = data.get("wdt")
    if ms is None:
        return "wdt=未知(旧固件)"
    return f"wdt={ms // 1000}s" if ms else "wdt=⚠️未武装"


@app.route("/heartbeat", methods=["POST"])
def device_heartbeat():
    """设备心跳：{"device_id", "up", "heap", "mqtt", "rssi", "logs": [...]}"""
    data = request.get_json(silent=True) or {}
    device_id = _validate_device_id(data.get("device_id", "cores3"))
    logs = data.pop("logs", None) or []
    now = time.time()
    with _hb_lock:
        prev = _hb_devices.get(device_id)
        _hb_devices[device_id] = {"ts": now, "data": data, "alerted": False}
    if prev is None:
        print(f"[{device_id}] 💓 心跳开始 heap={data.get('heap')} rssi={data.get('rssi')}"
              f" bat={data.get('bat')}% chg={data.get('chg')} {_wdt_note(data)}{_vad_note(data)}")
    elif now - prev["ts"] > _HB_SILENT_SECS:
        gap = int(now - prev["ts"])
        print(f"[{device_id}] 💓 心跳恢复（中断 {gap // 60}分{gap % 60}秒）"
              f" heap={data.get('heap')} rssi={data.get('rssi')} mqtt={data.get('mqtt')}"
              f" bat={data.get('bat')}% chg={data.get('chg')} {_wdt_note(data)}")
    if logs:
        DEVICE_LOGS_DIR.mkdir(exist_ok=True)
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(DEVICE_LOGS_DIR / f"{device_id}.log", "a", encoding="utf-8") as f:
            for line in logs[:40]:
                f.write(f"[{stamp}] {str(line)[:200]}\n")
        for line in logs[:40]:
            print(f"[{device_id}] 📟 {str(line)[:200]}")
    return jsonify({"status": "ok"})


@app.route("/device-status", methods=["GET"])
def device_status():
    """诊断视图：每台设备最近心跳 + 距今秒数 + 最近设备日志。curl 即可查看。"""
    now = time.time()
    out = {}
    with _hb_lock:
        snapshot = {k: dict(v) for k, v in _hb_devices.items()}
    for device_id, rec in snapshot.items():
        log_tail = []
        log_file = DEVICE_LOGS_DIR / f"{device_id}.log"
        if log_file.exists():
            log_tail = log_file.read_text(encoding="utf-8").splitlines()[-20:]
        out[device_id] = {
            "last_seen_secs_ago": int(now - rec["ts"]),
            "online": (now - rec["ts"]) < _HB_SILENT_SECS,
            "last_heartbeat": rec["data"],
            "recent_logs": log_tail,
        }
    return jsonify(out or {"info": "尚未收到任何设备心跳"})


def _hb_watch_loop() -> None:
    """后台线程：设备心跳静默超阈值时打一条失联记录（每次失联仅一条）。"""
    while True:
        time.sleep(30)
        now = time.time()
        with _hb_lock:
            for device_id, rec in _hb_devices.items():
                if now - rec["ts"] > _HB_SILENT_SECS and not rec["alerted"]:
                    rec["alerted"] = True
                    last = time.strftime("%H:%M:%S", time.localtime(rec["ts"]))
                    print(f"[{device_id}] 🔇 设备失联（最后心跳 {last}，"
                          f"heap={rec['data'].get('heap')} mqtt={rec['data'].get('mqtt')} "
                          f"{_wdt_note(rec['data'])}）")


@app.route("/crash-report", methods=["POST"])
def crash_report():
    """
    设备开机上报：每次重启后调用一次，log 非空时为上次崩溃的堆栈。
    请求体: {"device_id": "cores3", "log": "<crash.log 内容，可为空>"}
    日志落盘 crash_reports/，同时打印到控制台，用于远程排查设备死机。
    """
    data = request.get_json(silent=True) or {}
    device_id = _validate_device_id(data.get("device_id", "cores3"))
    log = str(data.get("log", ""))[:65536]
    # MicroPython esp32 machine.reset_cause() 取值
    _RESET_CAUSES = {1: "上电/复位键", 2: "硬复位", 3: "看门狗复位⚠️", 4: "深睡唤醒", 5: "软复位"}
    cause = _RESET_CAUSES.get(data.get("reset_cause"), f"未知({data.get('reset_cause')})")
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    # 重启原因必须落盘：服务端 stdout 通常挂在某个终端上，翻不到历史，
    # 而"上次是怎么死的"恰恰是排查设备黑屏唯一的硬证据。写进设备日志，
    # /device-status 的 recent_logs 直接就能看见。
    # 注意 MicroPython 的口径：**brownout（掉电）会被归进 1「上电/复位键」，
    # panic/guru meditation 会被归进 5「软复位」**——1 不等于"有人拔了电"，
    # 5 也不等于"程序主动重启"，别照字面下结论。
    try:
        DEVICE_LOGS_DIR.mkdir(exist_ok=True)
        with open(DEVICE_LOGS_DIR / f"{device_id}.log", "a", encoding="utf-8") as f:
            f.write(f"[{ts}] BOOT reset_cause={cause} crashlog={len(log)}B\n")
    except OSError as e:
        print(f"[{device_id}] boot log 写入失败: {e}")
    if log:
        report_dir = Path("crash_reports")
        report_dir.mkdir(exist_ok=True)
        fname = report_dir / f"{device_id}_{time.strftime('%Y%m%d_%H%M%S')}.log"
        fname.write_text(log)
        print(f"[{device_id}] 💥 开机上报携带崩溃日志 {len(log)} bytes → {fname}（{cause}）")
    else:
        print(f"[{device_id}] 🔄 设备重启（无崩溃日志，{cause}）@ {ts}")
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
    role, session_id = _role_ctx(device_id)

    def _bg():
        prompt = (
            "用户摇了摇你——她现在就在你面前的 Cores3 设备旁。"
            "你必须用 cores3-speak skill 把语音说出来，跟她随便聊几句。"
            "这是硬性要求：收到摇一摇必须用 Cores3 语音回复，"
            "不要只回文字（纯文字她根本听不到）。"
        )
        # openclaw CLI 偶发瞬态失败（升级迁移、gateway 忙等），重试一次
        for attempt in (1, 2):
            try:
                reply = chat(prompt, session_id, local_time=local_time, agent=role["agent"])
                preview = reply[:80].replace("\n", " ")
                print(f"[{device_id}] 🫨  shake → {preview}{'...' if len(reply) > 80 else ''}")
                return
            except Exception as e:
                print(f"[{device_id}] ⚠️  shake 错误(第{attempt}次): {e}")
                if attempt == 1:
                    time.sleep(3)

    threading.Thread(target=_bg, daemon=True).start()
    return jsonify({"status": "ok"})


_TOUCH_KIND_DESC = {
    "stroke": "用户正在摸你——手指贴着你的屏幕慢慢滑过",
    "cradle": "用户把手整个覆在你身上，像是把你捧在手里",
    "tap":    "用户轻轻拍了拍你的机身，像在叫你",
    "pickup": "用户把你从桌上拿了起来，你现在在她手里",
}


@app.route("/touch", methods=["GET"])
def handle_touch():
    """
    触觉惊动层：设备判定发生了值得开口的身体接触时调用。立即返回，后台发消息。

    设备端已经做了冷却（FEEL_NOTIFY_COOLDOWN）和显著性筛选，能到这里的都是
    "长时间抚摸结束 / 被拿起来 / 被拍打"这类明确信号——**不要在这里放宽**，
    每次触摸都惊动 LLM 会让她变成一个话痨玩具，而且很贵。

    请求头：X-Touch-Kind（stroke/cradle/tap/pickup）、X-Touch-Detail（k=v 摘要）、
           X-Touch（体感窗口，同 /chat）。链路与 /shake 相同。
    """
    device_id = _validate_device_id(request.headers.get("X-Device-Id"))
    if not state.check_rate(device_id):
        return jsonify({"error": "请求过于频繁，请稍后再试"}), 429
    kind = request.headers.get("X-Touch-Kind", "")
    desc = _TOUCH_KIND_DESC.get(kind)
    if desc is None:
        return jsonify({"error": "unknown touch kind"}), 400
    local_time = request.headers.get("X-Local-Time", "")
    detail = _touch_phrases(request.headers.get("X-Touch-Detail", ""))
    extra = ("（" + "；".join(detail) + "）") if detail else ""
    role, session_id = _role_ctx(device_id)

    def _bg():
        prompt = (
            f"{desc}{extra}。她现在就在你面前的 CoreS3 设备旁。"
            "这是身体接触，不是提问——用一句话回应被碰到的感觉就好，别开启新话题，"
            "也别追问她想干什么。"
            "你必须用 cores3-speak skill 把话说出来，"
            "这是硬性要求：纯文字她根本听不到。"
        )
        for attempt in (1, 2):
            try:
                reply = chat(prompt, session_id, local_time=local_time, agent=role["agent"])
                preview = reply[:80].replace("\n", " ")
                print(f"[{device_id}] 🖐️  touch/{kind} → {preview}{'...' if len(reply) > 80 else ''}")
                return
            except Exception as e:
                print(f"[{device_id}] ⚠️  touch 错误(第{attempt}次): {e}")
                if attempt == 1:
                    time.sleep(3)

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


# ── 监控网页 / 定时快照 ──────────────────────────────────────────────────────
#
# 两件事共用一条链路：_capture_and_wait 拿照片 → chat() 识别 → _send_push 播报。
#   - 网页「拍一张」：只走 _issue_capture，前端轮询 /capture-result，不识别不播报
#   - 定时计划到点  ：_run_scheduled_capture 走完整链路，照片与识别结果留档 snapshots/

_SNAPSHOT_NAME_RE = re.compile(r"^[0-9]{8}_[0-9]{6}_[0-9a-f]{4}$")

# 定时任务与网页抓拍共用的默认提问，只给个开口的由头，剩下交给 agent 自己的人设。
# 「有照片、要识别」这层不用在这里重复——chat() 已经在消息里加了
# 「用户通过CoreS3摄像头拍了一张照片，保存在 xxx，请识别这张图片来回答问题」。
_DEFAULT_PHOTO_PROMPT = "看看这张照片，跟我说说吧。"

# 播报由服务端负责，必须拦住 agent 自己再调 cores3-speak，否则设备会念两遍
_SPEAK_HINT = (
    "\n\n[你的文字回复会由服务端合成语音播报出来。请只回复要说的那句话本身，"
    "不要调用 cores3-speak skill，不要加任何前后缀。]"
)


def _prune_snapshots() -> None:
    """按文件名（前缀是时间戳）保留最新 SNAPSHOT_MAX 条，连同配对的 jpg 一起删。"""
    metas = sorted(SNAPSHOT_DIR.glob("*.json"), reverse=True)
    for stale in metas[SNAPSHOT_MAX:]:
        for p in (stale, stale.with_suffix(".jpg")):
            try:
                p.unlink()
            except OSError:
                pass


def _save_snapshot(image_path: Optional[str], meta: dict) -> Optional[str]:
    """把定时拍照的图片+识别结果留档，返回快照名。image_path 为 None 时只存元信息。"""
    ts = meta.get("ts", time.time())
    name = f"{time.strftime('%Y%m%d_%H%M%S', time.localtime(ts))}_{uuid.uuid4().hex[:4]}"
    try:
        if image_path and os.path.exists(image_path):
            shutil.copy(image_path, SNAPSHOT_DIR / f"{name}.jpg")
        (SNAPSHOT_DIR / f"{name}.json").write_text(
            json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    except OSError as e:
        print(f"[snapshot] 留档失败: {e}")
        return None
    _prune_snapshots()
    return name


def _list_snapshots(limit: int = 30) -> list[dict]:
    """按时间倒序列出留档快照（新的在前）。"""
    out = []
    for meta_path in sorted(SNAPSHOT_DIR.glob("*.json"), reverse=True)[:limit]:
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        name = meta_path.stem
        out.append({
            **meta,
            "name": name,
            "has_image": (SNAPSHOT_DIR / f"{name}.jpg").exists(),
            "image_url": f"/snapshot/{name}",
        })
    return out


def _describe_and_speak(image_path: str, device_id: str, prompt: str,
                        label: str = "", started: Optional[float] = None) -> dict:
    """识别一张照片 → 留档 → 语音播报。定时计划与网页「拍完说一句」共用。

    识别失败也照样留档：照片还在，至少能看见当时拍到了什么。
    """
    started = started if started is not None else time.time()
    result: dict = {"ts": started, "ok": False, "error": None, "reply": "",
                    "snapshot": None, "spoken": False, "device_id": device_id}
    try:
        role, session_id = _role_ctx(device_id)
        local_time = time.strftime("%Y-%m-%d %H:%M")
        reply = chat(prompt + _SPEAK_HINT, session_id,
                     image_path=image_path, local_time=local_time, agent=role["agent"])
        preview = reply[:80].replace("\n", " ")
        print(f"[snapshot] 👁  {label or '手动'} 识别: {preview}"
              f"{'...' if len(reply) > 80 else ''}")
        result["reply"] = reply
        result["ok"] = True
    except Exception as e:
        print(f"[snapshot] ⚠️  识别失败: {e}")
        result["error"] = str(e)

    result["snapshot"] = _save_snapshot(image_path, {
        "ts": started, "device_id": device_id, "time": label,
        "prompt": prompt, "reply": result["reply"], "error": result["error"],
    })

    if result["reply"]:
        try:
            result["spoken"] = _send_push(result["reply"], device_id)
        except Exception as e:
            print(f"[snapshot] ⚠️  播报失败: {e}")
            result["error"] = result["error"] or f"播报失败: {e}"
    return result


def _run_scheduled_capture(sched: dict) -> dict:
    """定时计划的执行体（photo_schedules 注入）：拍照 → 识别 → 留档 → 播报。"""
    device_id = _validate_device_id(sched.get("device_id", "cores3"))
    prompt = sched.get("prompt") or _DEFAULT_PHOTO_PROMPT
    label = sched.get("time", "?")
    started = time.time()

    image_path, err = _capture_and_wait(device_id)
    if err:
        print(f"[snapshot] ⚠️  {label} 拍照失败: {err}")
        return {
            "ts": started, "ok": False, "error": err, "reply": "", "spoken": False,
            "device_id": device_id,
            "snapshot": _save_snapshot(None, {
                "ts": started, "device_id": device_id, "time": label,
                "prompt": prompt, "reply": "", "error": err,
            }),
        }
    return _describe_and_speak(image_path, device_id, prompt, label=label, started=started)


@app.route("/monitor", methods=["GET"])
def monitor_page():
    """远程监控网页。页面本身不校验 token，数据接口才校验（否则没地方填 token）。"""
    page = WEB_DIR / "monitor.html"
    if not page.exists():
        return "monitor.html 缺失，请检查 web/ 目录", 500
    return send_file(page, mimetype="text/html")


@app.route("/role", methods=["GET"])
def get_role():
    """设备开机取回当前角色；也给网页/agent 列角色表。"""
    device_id = _validate_device_id(request.args.get("device_id"))
    cur = roles.get(device_id)
    return jsonify({"role": cur["id"], "name": cur["name"],
                    "roles": [{"id": r["id"], "name": r["name"]} for r in roles.all_roles()]})


@app.route("/role", methods=["POST"])
def post_role():
    """网页/agent 切换角色：{"device_id", "role"}。落盘后 MQTT 通知设备换图。"""
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    data = request.get_json(silent=True) or {}
    device_id = _validate_device_id(data.get("device_id"))
    target = roles.set_role(device_id, str(data.get("role", "")))
    if target is None:
        return jsonify({"error": "unknown role"}), 400
    if _mqtt_client is not None:
        # 先发换图命令再推问候：设备在 MQTT 回调里就地换角色，问候播出时已是新图
        _mqtt_client.publish(f"kagura/cmd/{device_id}",
                             json.dumps({"action": "role", "role": target["id"]}), qos=1)
        if data.get("greet", True):
            _send_push(roles.greeting(target), device_id)
    print(f"[{device_id}] 🎭  [role/api] → {target['name']} ({target['agent']})")
    return jsonify({"role": target["id"], "name": target["name"]})


@app.route("/role/cycle", methods=["POST"])
def cycle_role():
    """设备顶栏 ROLE 键：切到下一个角色，直接回新角色的问候语音（同 /chat 的响应头）。

    设备上行接口与 /chat 一致不要 token（设备端没有密钥），靠限流兜底。
    """
    device_id = _validate_device_id(request.headers.get("X-Device-Id"))
    if not state.check_rate(device_id) or not _ip_rate_ok():
        return jsonify({"error": "请求过于频繁，请稍后再试"}), 429
    target = roles.set_role(device_id, roles.next_role(device_id)["id"])
    text = roles.greeting(target)
    wav_out = synthesize(text, per=target["per"])
    if not wav_out:
        return jsonify({"error": "TTS 生成失败"}), 500
    with open(wav_out, "rb") as f:
        wav_data = f.read()
    print(f"[{device_id}] 🎭  [role/tap] → {target['name']} ({target['agent']})")
    return Response(wav_data, mimetype="audio/wav", headers={
        "Content-Length": len(wav_data),
        "X-Role": target["id"],
        "X-Reply-Text": _b64_header(text),
    })


@app.route("/debug-audio/<device_id>", methods=["GET"])
def serve_debug_audio(device_id: str):
    """试听设备最近一次上传的录音。浏览器直接打开没法带请求头，所以 token 也可以走 ?token=。"""
    if API_TOKEN and request.args.get("token", "") != API_TOKEN and not _token_ok():
        return jsonify({"error": "invalid or missing token"}), 401
    device_id = _validate_device_id(device_id)
    fpath = DEBUG_AUDIO_DIR / f"{device_id}_last.wav"
    if not fpath.exists():
        return jsonify({"error": "no audio yet"}), 404
    return send_file(fpath, mimetype="audio/wav", max_age=0)


@app.route("/snapshot/<name>", methods=["GET"])
def serve_snapshot(name: str):
    """读取一张留档快照的 JPEG。"""
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    if not _SNAPSHOT_NAME_RE.match(name):
        return jsonify({"error": "bad snapshot name"}), 400
    fpath = SNAPSHOT_DIR / f"{name}.jpg"
    if not fpath.exists():
        return jsonify({"error": "snapshot not found"}), 404
    return send_file(fpath, mimetype="image/jpeg")


@app.route("/api/monitor/state", methods=["GET"])
def monitor_state():
    """网页一次拉齐：设备在线状态 + 定时计划 + 快照留档。"""
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    now = time.time()
    with _hb_lock:
        snapshot = {k: dict(v) for k, v in _hb_devices.items()}
    devices = {
        device_id: {
            "last_seen_secs_ago": int(now - rec["ts"]),
            "online": (now - rec["ts"]) < _HB_SILENT_SECS,
            **{k: rec["data"].get(k) for k in ("heap", "rssi", "mqtt", "bat", "chg", "wdt")},
        }
        for device_id, rec in snapshot.items()
    }
    want = _validate_device_id(request.args.get("device_id", "cores3"))
    return jsonify({
        "server_time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "mqtt": _mqtt_client is not None,
        "auth_required": bool(API_TOKEN),
        "devices": devices,
        "schedules": photo_schedules.list_all(),
        "snapshots": _list_snapshots(),
        "stream": stream_server.stats(want),
        "role": roles.get(want)["id"],
        "roles": [{"id": r["id"], "name": r["name"]} for r in roles.all_roles()],
    })


_STREAM_RENEW_SECS = 45   # 每次续期给设备的直播时长：网页关掉后设备最多再撑这么久
_STREAM_POLL_WAIT = 3.0   # 取帧接口的长轮询上限，避免前端空转刷请求


@app.route("/api/monitor/stream", methods=["POST"])
def monitor_stream():
    """开/续/停直播。网页需按 _STREAM_RENEW_SECS 的一半周期反复调 start 续期——
    这样页面被关掉或断网时，设备会自己超时收摊，不会把摄像头一直开着。"""
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    data = request.get_json(silent=True) or {}
    device_id = _validate_device_id(data.get("device_id", "cores3"))
    action = data.get("action", "start")
    if action not in ("start", "stop"):
        return jsonify({"error": "action must be 'start' or 'stop'"}), 400
    if _mqtt_client is None:
        return jsonify({"error": "MQTT 不可用，无法下发直播命令"}), 503

    if action == "start":
        cmd = {"action": "stream_start", "secs": _STREAM_RENEW_SECS,
               "port": stream_server.PORT}
    else:
        cmd = {"action": "stream_stop"}
        stream_server.drop(device_id)
    _mqtt_client.publish(f"kagura/cmd/{device_id}", json.dumps(cmd), qos=1)
    return jsonify({"status": "ok", "action": action,
                    "stream": stream_server.stats(device_id)})


@app.route("/stream/<device_id>/frame.jpg", methods=["GET"])
def stream_frame(device_id: str):
    """取直播的最新一帧。带 ?after=<seq> 时长轮询：没有更新就挂住，直到有新帧或超时。

    用长轮询而不是 MJPEG，是因为 <img src> 没法带 X-Api-Token 头，
    把 token 塞进 URL 会被 access log 记下来。
    """
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    device_id = _validate_device_id(device_id)
    try:
        after = int(request.args.get("after", -1))
    except ValueError:
        after = -1

    deadline = time.time() + _STREAM_POLL_WAIT
    while True:
        rec = stream_server.latest(device_id)
        if rec and rec.get("jpeg") and rec["seq"] != after:
            return Response(rec["jpeg"], mimetype="image/jpeg", headers={
                "X-Frame-Seq": str(rec["seq"]),
                "Cache-Control": "no-store",
            })
        if time.time() >= deadline:
            return ("", 204)          # 无新帧：前端据此决定继续等还是提示未开播
        time.sleep(0.05)


@app.route("/api/monitor/describe", methods=["POST"])
def monitor_describe():
    """网页「拍完让它说一句」：对已拍到的照片做识别 + 播报，后台跑。

    请求体: {"request_id": "<拍照的 request_id>", "prompt": "可选提问"}
    结果不在这里返回——识别要几十秒，完成后会出现在 /api/monitor/state 的快照留档里。
    """
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    data = request.get_json(silent=True) or {}
    request_id = data.get("request_id", "")
    with state.photos_lock:
        rec = state.photo_results.get(request_id)
    if not rec or rec.get("status") != "done":
        return jsonify({"error": "没有这张照片，或它还没拍好"}), 404
    image_path = rec.get("image_path")
    if not image_path or not os.path.exists(image_path):
        return jsonify({"error": "照片文件已过期"}), 404

    device_id = _validate_device_id(data.get("device_id", "cores3"))
    prompt = (data.get("prompt") or "").strip() or _DEFAULT_PHOTO_PROMPT
    threading.Thread(
        target=_describe_and_speak, args=(image_path, device_id, prompt),
        kwargs={"label": "手动"}, daemon=True, name="describe").start()
    return jsonify({"status": "started"}), 202


@app.route("/api/monitor/capture", methods=["POST"])
def monitor_capture():
    """网页「拍一张」：下发命令即返回，前端自行轮询 /capture-result/<id>。"""
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    data = request.get_json(silent=True) or {}
    device_id = _validate_device_id(data.get("device_id", "cores3"))
    if not state.check_rate(device_id, bucket="capture", limit=_CAPTURE_RATE_MAX):
        return jsonify({"error": "拍照过于频繁，请稍后再试"}), 429

    # 直播中默认抓当前帧：所见即所得、瞬时完成，也不打扰正在推流的设备。
    # hires=true 则跳过这条快路径，照常下发拍照命令——设备会在推流循环里
    # 临时切回 QVGA 拍一张（画面停几秒），换 4 倍像素给 AI 看。
    if not data.get("hires"):
        request_id = _capture_from_stream(device_id)
        if request_id:
            return jsonify({"request_id": request_id, "status": "done", "source": "stream"})

    if _mqtt_client is None:
        return jsonify({"error": "MQTT 不可用，无法下发拍照命令"}), 503
    return jsonify({"request_id": _issue_capture(device_id),
                    "status": "queued", "source": "device"})


@app.route("/api/monitor/schedules", methods=["POST"])
def monitor_add_schedule():
    """新增每日定时拍照计划。请求体: {"time": "08:00", "device_id", "prompt"}"""
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    data = request.get_json(silent=True) or {}
    try:
        item = photo_schedules.add(
            data.get("time", ""),
            device_id=_validate_device_id(data.get("device_id", "cores3")),
            prompt=data.get("prompt", ""),
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(item), 201


@app.route("/api/monitor/schedules/<sid>", methods=["PATCH", "DELETE"])
def monitor_edit_schedule(sid: str):
    """PATCH 改字段（time/prompt/enabled/device_id），DELETE 删除。"""
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    if request.method == "DELETE":
        if not photo_schedules.remove(sid):
            return jsonify({"error": "unknown schedule id"}), 404
        return jsonify({"status": "ok"})
    data = request.get_json(silent=True) or {}
    fields = {k: v for k, v in data.items()
              if k in ("time", "prompt", "enabled", "device_id")}
    try:
        item = photo_schedules.update(sid, **fields)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if item is None:
        return jsonify({"error": "unknown schedule id"}), 404
    return jsonify(item)


@app.route("/api/monitor/schedules/<sid>/run", methods=["POST"])
def monitor_run_schedule(sid: str):
    """立即试跑一条计划：后台执行（拍照+识别可能几十秒），结果去 state 里看。"""
    if not _token_ok():
        return jsonify({"error": "invalid or missing X-Api-Token"}), 401
    if photo_schedules.get(sid) is None:
        return jsonify({"error": "unknown schedule id"}), 404
    threading.Thread(target=photo_schedules.run_now, args=(sid,),
                     daemon=True, name=f"snapshot-run-{sid}").start()
    return jsonify({"status": "started"}), 202


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
    threading.Thread(target=_hb_watch_loop, daemon=True, name="hb-watch").start()
    reminders.init(_send_push)
    photo_schedules.init(_run_scheduled_capture)
    stream_server.init(_stream_frame_to_jpeg, token=STREAM_TOKEN)
    print(f"Agent : {AGENT_ID}  |  TTS : {TTS_VOICE}")
    print("监听 0.0.0.0:5000，Ctrl+C 退出")
    print("监控网页: http://<本机IP>:5000/monitor\n")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
