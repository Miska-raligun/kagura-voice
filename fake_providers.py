"""契约测试用的假服务商：替换百度 ASR/TTS 与 OpenClaw，并开放 /__fake/* 控制接口。

只在 KAGURA_FAKE_PROVIDERS=1 时由 voice_server 的 __main__ 装上，正常运行不会 import 本文件。

**/__fake/* 是新旧两版服务端共同遵守的测试协议**（见 contract-tests/README.md）：
TypeScript 版也实现同样的接口，同一套契约用例才能两边都跑。改这里要同步改那边。

  POST /__fake/reset              清空脚本、调用记录与限流计数
  POST /__fake/asr  {"queue":[…]} 追加接下来 ASR 依次返回的文本（空串 = 没识别出来）
  POST /__fake/llm  {"queue":[…]} 追加接下来 LLM 依次返回的回复；元素为 {"error": "…"} 时本次调用抛错
  GET  /__fake/log                调用记录：{"asr": 次数, "llm": [...], "tts": [...]}

队列用完后的默认值：ASR 返回「你好」，LLM 返回「好的。」。
"""

import hashlib
import struct
import threading
from typing import Optional

from flask import jsonify, request

_lock = threading.Lock()
_asr_queue: list = []
_llm_queue: list = []
_log: dict = {"asr": 0, "llm": [], "tts": []}

DEFAULT_ASR = "你好"
DEFAULT_LLM = "好的。"
BYTES_PER_CHAR = 1600          # 每个字 50ms 的静音，回复越长 WAV 越大，便于测长度相关行为


def _reset() -> None:
    with _lock:
        _asr_queue.clear()
        _llm_queue.clear()
        _log["asr"] = 0
        _log["llm"] = []
        _log["tts"] = []


def install(vs) -> None:
    """把 voice_server 模块里的三个外部依赖换成假的，并注册控制接口。"""

    def transcribe(audio_path: str) -> str:
        with _lock:
            _log["asr"] += 1
            return _asr_queue.pop(0) if _asr_queue else DEFAULT_ASR

    def chat(user_text: str, session_id: str, image_path: Optional[str] = None,
             local_time: Optional[str] = None, agent: Optional[str] = None) -> str:
        with _lock:
            _log["llm"].append({
                "message": user_text,
                "session": session_id,
                "agent": agent or vs.AGENT_ID,
                "image": bool(image_path),
                "local_time": local_time or "",
            })
            item = _llm_queue.pop(0) if _llm_queue else DEFAULT_LLM
        if isinstance(item, dict) and "error" in item:
            raise RuntimeError(item["error"])
        return item

    def synthesize(text: str, per: int = 111) -> Optional[str]:
        clean = vs.strip_markdown(text)
        if not clean:
            return None
        with _lock:
            _log["tts"].append({"text": clean, "per": per})
        key = hashlib.md5(f"fake|{clean}|{per}".encode("utf-8")).hexdigest()
        path = vs.TTS_CACHE_DIR / f"{key}.wav"
        if not path.exists():
            body = b"\x00" * (BYTES_PER_CHAR * len(clean))
            header = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + len(body), b'WAVE',
                                 b'fmt ', 16, 1, 1, 16000, 32000, 2, 16, b'data', len(body))
            path.write_bytes(header + body)
        return str(path)

    vs.transcribe = transcribe
    vs.chat = chat
    vs.synthesize = synthesize

    app = vs.app

    @app.route("/__fake/reset", methods=["POST"])
    def _fake_reset():
        _reset()
        # 限流计数也清掉：所有用例都从 127.0.0.1 发请求，按 IP 的兜底限流
        # （60 次/分钟）会让后面的用例莫名 429。限流本身由专门的用例测
        with vs.state.rate_lock:
            vs.state.rate_buckets.clear()
        return jsonify({"ok": True})

    @app.route("/__fake/asr", methods=["POST"])
    def _fake_asr():
        with _lock:
            _asr_queue.extend((request.get_json(silent=True) or {}).get("queue", []))
        return jsonify({"ok": True})

    @app.route("/__fake/llm", methods=["POST"])
    def _fake_llm():
        with _lock:
            _llm_queue.extend((request.get_json(silent=True) or {}).get("queue", []))
        return jsonify({"ok": True})

    @app.route("/__fake/log", methods=["GET"])
    def _fake_log():
        with _lock:
            return jsonify({"asr": _log["asr"], "llm": list(_log["llm"]), "tts": list(_log["tts"])})

    print("[fake] 假服务商已启用：ASR/LLM/TTS 由 /__fake/* 控制")
