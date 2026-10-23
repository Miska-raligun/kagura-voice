"""/chat：短路链、LLM 路径、响应头协议、限流、触觉与免手模式。"""
import time

from conftest import b64text, wav


def _chat(srv, dev, text=None, headers=None, data=None):
    if text is not None:
        srv.fake_asr(text)
    h = {"X-Device-Id": dev}
    h.update(headers or {})
    return srv.post("/chat", data=wav() if data is None else data, headers=h)


# ── 基本协议 ─────────────────────────────────────────────────────────────────

def test_returns_wav_with_text_headers(srv):
    srv.fake_llm("天是蓝的因为瑞利散射。")
    r = _chat(srv, "c1", "为什么天是蓝的")
    assert r.status_code == 200
    assert r.headers["Content-Type"].startswith("audio/wav")
    assert r.content[:4] == b"RIFF" and r.content[8:12] == b"WAVE"
    assert int(r.headers["Content-Length"]) == len(r.content)
    assert b64text(r.headers["X-User-Text"]) == "为什么天是蓝的"
    assert b64text(r.headers["X-Reply-Text"]) == "天是蓝的因为瑞利散射。"
    log = srv.fake_log()
    assert len(log["llm"]) == 1 and log["llm"][0]["message"] == "为什么天是蓝的"
    assert log["tts"] == [{"text": "天是蓝的因为瑞利散射。", "per": 111}]


def test_empty_body_400(srv):
    assert srv.post("/chat", data=b"", headers={"X-Device-Id": "c2"}).status_code == 400


def test_local_time_passed_to_llm(srv):
    _chat(srv, "c3", "你好呀", {"X-Local-Time": "2026-05-15 14:23"})
    assert srv.fake_log()["llm"][0]["local_time"] == "2026-05-15 14:23"


def test_llm_error_500(srv):
    srv.fake_llm({"error": "openclaw 挂了"})
    assert _chat(srv, "c4", "随便聊聊").status_code == 500


def test_long_reply_header_truncated_but_full_audio(srv):
    long = "很长的回答。" * 40
    srv.fake_llm(long)
    r = _chat(srv, "c5", "讲个长故事")
    assert len(b64text(r.headers["X-Reply-Text"])) <= 60
    assert srv.fake_log()["tts"][0]["text"] == long


# ── 短路链：不走 LLM ─────────────────────────────────────────────────────────

def test_quick_time_skips_llm(srv):
    r = _chat(srv, "q1", "现在几点", {"X-Local-Time": "2026-05-15 14:23"})
    assert r.status_code == 200
    assert b64text(r.headers["X-Reply-Text"]).startswith("现在是")
    assert srv.fake_log()["llm"] == []


def test_quick_context_carried_to_next_llm_turn(srv):
    _chat(srv, "q2", "现在几点", {"X-Local-Time": "2026-05-15 14:23"})
    _chat(srv, "q2", "为什么天是蓝的")
    msg = srv.fake_log()["llm"][0]["message"]
    assert "现在几点" in msg and msg.endswith("为什么天是蓝的")


def test_volume_command_header(srv):
    r = _chat(srv, "q3", "小声一点")
    assert r.headers.get("X-Volume") == "down"
    r = _chat(srv, "q3", "大声一点")
    assert r.headers.get("X-Volume") == "up"
    assert srv.fake_log()["llm"] == []


def test_reminder_fires_as_push(srv, device):
    r = _chat(srv, device.id, "5秒后提醒我关火")
    assert b64text(r.headers["X-Reply-Text"]) == "好的，5秒后提醒你关火。"
    assert srv.fake_log()["llm"] == []
    msg = device.wait("push", timeout=12)
    assert msg["type"] == "push"
    assert any("关火" in t["text"] for t in srv.fake_log()["tts"])


def test_empty_asr_fixed_reply_no_llm(srv):
    r = _chat(srv, "q4", "")
    assert r.status_code == 200
    assert r.headers.get("X-Asr-Empty") == "1"
    assert b64text(r.headers["X-Reply-Text"]) == "没听清，能再说一遍吗？"
    assert srv.fake_log()["llm"] == []


def test_empty_asr_not_remembered_as_context(srv):
    _chat(srv, "q5", "")
    _chat(srv, "q5", "随便聊聊")
    assert srv.fake_log()["llm"][0]["message"] == "随便聊聊"


# ── [PHOTO] 前缀 ─────────────────────────────────────────────────────────────

def test_photo_marker_sets_header_and_strips_prefix(srv):
    srv.fake_llm("[PHOTO]好的，我看看。")
    r = _chat(srv, "p1", "看看这是什么")
    assert r.headers.get("X-Need-Photo") == "1"
    assert b64text(r.headers["X-Reply-Text"]) == "好的，我看看。"
    assert srv.fake_log()["tts"][0]["text"] == "好的，我看看。"


def test_no_photo_header_by_default(srv):
    r = _chat(srv, "p2", "你好")
    assert "X-Need-Photo" not in r.headers


# ── 触觉背景（X-Touch）────────────────────────────────────────────────────────

def test_touch_background_injected(srv):
    _chat(srv, "t1", "你在干嘛", {"X-Touch": "stroke=9,strokes=1"})
    msg = srv.fake_log()["llm"][0]["message"]
    assert "身体感觉" in msg and "9 秒" in msg and msg.endswith("你在干嘛")


def test_no_touch_header_message_unchanged(srv):
    _chat(srv, "t2", "你在干嘛")
    assert srv.fake_log()["llm"][0]["message"] == "你在干嘛"


def test_quick_command_ignores_touch(srv):
    _chat(srv, "t3", "现在几点", {"X-Touch": "stroke=9"})
    assert srv.fake_log()["llm"] == []


# ── 免手模式（X-Mode）────────────────────────────────────────────────────────

def test_filler_filtered_only_in_hands_free(srv):
    r = _chat(srv, "h1", "嗯", {"X-Mode": "continuous"})
    assert r.headers.get("X-Asr-Empty") == "1" and srv.fake_log()["llm"] == []
    r = _chat(srv, "h1", "嗯", {"X-Mode": "single"})
    assert "X-Asr-Empty" not in r.headers and len(srv.fake_log()["llm"]) == 1


def test_voice_exit_in_hands_free(srv):
    for mode in ("continuous", "wake"):
        r = _chat(srv, "h2", "不聊了", {"X-Mode": mode})
        assert r.headers.get("X-Cont-Exit") == "1", mode
    assert srv.fake_log()["llm"] == []
    r = _chat(srv, "h2", "不聊了", {"X-Mode": "single"})
    assert "X-Cont-Exit" not in r.headers


# ── 限流 ─────────────────────────────────────────────────────────────────────

def test_device_rate_limit(srv):
    codes = [_chat(srv, "rl1", "现在几点").status_code for _ in range(21)]
    assert codes[:20] == [200] * 20 and codes[20] == 429


def test_ip_backstop_blocks_device_id_rotation(srv):
    codes = [_chat(srv, f"rot{i}", "现在几点").status_code for i in range(61)]
    assert codes[:60] == [200] * 60 and codes[60] == 429


# ── 录音留档 + 心跳刷新 ───────────────────────────────────────────────────────

def test_last_audio_kept_for_debug(srv):
    data = wav(0.3, amp=1234)
    _chat(srv, "dbg1", "你好", data=data)
    r = srv.get("/debug-audio/dbg1")
    assert r.status_code == 200 and r.content == data
    assert srv.get("/debug-audio/nobody").status_code == 404


def test_chat_counts_as_device_alive(srv):
    srv.post("/heartbeat", json={"device_id": "hb1", "heap": 123})
    time.sleep(1.2)
    before = srv.get("/device-status").json()["hb1"]["last_seen_secs_ago"]
    _chat(srv, "hb1", "你好")
    st = srv.get("/device-status").json()["hb1"]
    assert st["last_seen_secs_ago"] <= before and st["last_heartbeat"]["heap"] == 123
