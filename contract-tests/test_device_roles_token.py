"""设备诊断（心跳/崩溃上报/状态）、摇一摇与触摸、在家状态、角色切换、API_TOKEN。"""
import struct
import time

from conftest import ROLES_2, b64text, wav


def _wait_llm(srv, n=1, timeout=8):
    deadline = time.time() + timeout
    while time.time() < deadline:
        calls = srv.fake_log()["llm"]
        if len(calls) >= n:
            return calls
        time.sleep(0.1)
    raise AssertionError(f"{timeout}s 内 LLM 没被调用 {n} 次：{srv.fake_log()}")


# ── 基础 ─────────────────────────────────────────────────────────────────────

def test_time(srv):
    ts = srv.get("/time").json()["timestamp"]
    assert isinstance(ts, int) and abs(ts - time.time()) < 5


def test_test_tone_is_1s_wav(srv):
    r = srv.get("/test-tone")
    assert r.status_code == 200 and r.content[:4] == b"RIFF"
    assert struct.unpack_from("<I", r.content, 40)[0] == 32000


# ── 心跳 / 诊断 ──────────────────────────────────────────────────────────────

def test_heartbeat_and_status(srv):
    assert srv.post("/heartbeat", json={"device_id": "hb2", "heap": 50000, "rssi": -60,
                                        "wdt": 180000, "logs": ["12:00 hello", "12:01 world"]}).status_code == 200
    st = srv.get("/device-status").json()["hb2"]
    assert st["online"] is True and st["last_seen_secs_ago"] <= 2
    assert st["last_heartbeat"]["heap"] == 50000 and st["last_heartbeat"]["wdt"] == 180000
    assert "logs" not in st["last_heartbeat"], "日志落盘，不留在遥测里"
    assert any("12:01 world" in line for line in st["recent_logs"])


def test_heartbeat_without_body_ok(srv):
    assert srv.post("/heartbeat", data=b"").status_code == 200


def test_device_status_empty_info(srv):
    assert isinstance(srv.get("/device-status").json(), dict)


def test_crash_report_logged_with_reset_cause(srv):
    srv.post("/heartbeat", json={"device_id": "cr1"})
    assert srv.post("/crash-report", json={"device_id": "cr1", "log": "Traceback...\nNameError",
                                           "reset_cause": 3}).json() == {"status": "ok"}
    logs = srv.get("/device-status").json()["cr1"]["recent_logs"]
    assert any("BOOT" in l and "看门狗" in l for l in logs)


def test_presence_validation(srv):
    assert srv.post("/presence", json={"device_id": "pr1", "status": "home"}).json() == {"status": "ok"}
    assert srv.post("/presence", json={"device_id": "pr1", "status": "away"}).status_code == 200
    assert srv.post("/presence", json={"device_id": "pr1", "status": "maybe"}).status_code == 400
    assert srv.post("/presence", json={"device_id": "pr1"}).status_code == 400


# ── 摇一摇 / 触摸：立即返回，后台问 LLM ───────────────────────────────────────

def test_shake_returns_immediately_then_asks_llm(srv):
    t = time.time()
    r = srv.get("/shake", headers={"X-Device-Id": "sk1"})
    assert r.status_code == 200 and r.json() == {"status": "ok"} and time.time() - t < 2
    call = _wait_llm(srv)[0]
    assert "摇" in call["message"]


def test_touch_kinds(srv):
    assert srv.get("/touch", headers={"X-Device-Id": "tk1", "X-Touch-Kind": "nope"}).status_code == 400
    for kind, word in (("stroke", "摸"), ("pickup", "拿")):
        srv.fake_reset()
        r = srv.get("/touch", headers={"X-Device-Id": "tk1", "X-Touch-Kind": kind})
        assert r.status_code == 200
        assert word in _wait_llm(srv)[0]["message"]


def test_touch_rate_limited(srv):
    codes = [srv.get("/touch", headers={"X-Device-Id": "tkrl", "X-Touch-Kind": "tap"}).status_code
             for _ in range(21)]
    assert codes[20] == 429


# ── 角色（两个角色的服务端实例）───────────────────────────────────────────────

def test_role_get_lists_roles(roles_server):
    r = roles_server.get("/role?device_id=rd1").json()
    assert r["role"] == "" and [x["id"] for x in r["roles"]] == ["", "mio"]


def test_voice_switch_role_end_to_end(roles_server):
    s = roles_server
    s.fake_reset()
    s.fake_asr("切换到小澪", "你好呀")
    r1 = s.post("/chat", data=wav(), headers={"X-Device-Id": "rd2"})
    assert r1.headers["X-Role"] == "mio"
    assert s.fake_log()["llm"] == [] and s.fake_log()["tts"][-1]["per"] == 4
    r2 = s.post("/chat", data=wav(), headers={"X-Device-Id": "rd2"})
    assert r2.headers["X-Role"] == "mio"
    call = s.fake_log()["llm"][0]
    assert call["agent"] == "mio" and s.fake_log()["tts"][-1]["per"] == 4
    # 切回去：会话应与小澪的不同
    s.fake_asr("换回神乐", "再见")
    s.post("/chat", data=wav(), headers={"X-Device-Id": "rd2"})
    s.post("/chat", data=wav(), headers={"X-Device-Id": "rd2"})
    calls = s.fake_log()["llm"]
    assert calls[-1]["agent"] == "main" and calls[-1]["session"] != call["session"]


def test_role_cycle_returns_greeting_in_new_voice(roles_server):
    s = roles_server
    s.fake_reset()
    s.post("/role", json={"device_id": "rd3", "role": "", "greet": False})
    r = s.post("/role/cycle", headers={"X-Device-Id": "rd3"})
    assert r.status_code == 200 and r.content[:4] == b"RIFF" and r.headers["X-Role"] == "mio"
    assert "小澪" in b64text(r.headers["X-Reply-Text"]) and s.fake_log()["tts"][-1]["per"] == 4
    assert s.post("/role/cycle", headers={"X-Device-Id": "rd3"}).headers["X-Role"] == ""


def test_role_post_notifies_device_then_greets(roles_server):
    from conftest import Device
    s = roles_server
    s.fake_reset()
    d = Device(s, "rd4")
    try:
        assert s.post("/role", json={"device_id": "rd4", "role": "nope"}).status_code == 400
        assert s.post("/role", json={"device_id": "rd4", "role": "mio"}).json()["name"] == "小澪"
        assert d.wait("cmd") == {"action": "role", "role": "mio"}
        assert d.wait("push")["type"] == "push"
        assert s.get("/role?device_id=rd4").json()["role"] == "mio"
        assert s.get("/api/monitor/state?device_id=rd4").json()["role"] == "mio"
    finally:
        d.close()


def test_role_persists_across_restart():
    from conftest import Server
    s = Server(roles=ROLES_2).start()
    s.post("/role", json={"device_id": "rd5", "role": "mio", "greet": False})
    s.stop()
    s2 = Server(roles=ROLES_2)
    s2.data = s.data          # 同一个数据目录重启
    s2.start()
    try:
        assert s2.get("/role?device_id=rd5").json()["role"] == "mio"
    finally:
        s2.stop()


# ── API_TOKEN ────────────────────────────────────────────────────────────────

PROTECTED = [
    ("POST", "/push", {"text": "x", "device_id": "tk"}),
    ("POST", "/capture-request", {"device_id": "tk"}),
    ("GET", "/api/monitor/state", None),
    ("POST", "/api/monitor/capture", {"device_id": "tk"}),
    ("POST", "/api/monitor/stream", {"device_id": "tk", "action": "stop"}),
    ("POST", "/api/monitor/schedules", {"time": "08:00"}),
    ("POST", "/role", {"device_id": "tk", "role": ""}),
    ("GET", "/photo/abc", None),
    ("GET", "/snapshot/20260101_000000_abcd", None),
    ("GET", "/stream/tk/frame.jpg", None),
]


def test_token_required_on_protected_routes(token_server):
    for method, path, body in PROTECTED:
        r = token_server.request(method, path, headers={"X-Api-Token": "wrong"}, json=body)
        assert r.status_code == 401, (method, path, r.status_code)


def test_token_accepted(token_server):
    assert token_server.request("POST", "/push", json={"text": "x", "device_id": "tk"}).status_code == 200
    assert token_server.get("/api/monitor/state").status_code == 200


def test_device_uplinks_stay_open_with_token(token_server):
    """设备端没有密钥：设备上行接口在设了 API_TOKEN 后仍然开放。"""
    s = token_server
    h = {"X-Api-Token": ""}
    assert s.post("/chat", data=wav(), headers={**h, "X-Device-Id": "tk2"}).status_code == 200
    assert s.post("/heartbeat", json={"device_id": "tk2"}, headers=h).status_code == 200
    assert s.get("/time", headers=h).status_code == 200
    assert s.get("/monitor", headers=h).status_code == 200, "页面本身不校验（否则没地方填 token）"


def test_debug_audio_accepts_query_token(token_server):
    s = token_server
    s.post("/chat", data=wav(), headers={"X-Device-Id": "tk3"})
    assert s.get("/debug-audio/tk3", headers={"X-Api-Token": ""}).status_code == 401
    assert s.get("/debug-audio/tk3?token=s3cret", headers={"X-Api-Token": ""}).status_code == 200


def test_vision_follows_current_role(roles_server):
    from conftest import b64, rgb565
    s = roles_server
    s.fake_reset()
    s.post("/role", json={"device_id": "rd6", "role": "mio", "greet": False})
    r = s.post("/chat-vision", json={"image": b64(rgb565()), "text": "这是什么"}, headers={"X-Device-Id": "rd6"})
    assert r.headers["X-Role"] == "mio"
    assert s.fake_log()["llm"][0]["agent"] == "mio" and s.fake_log()["tts"][-1]["per"] == 4


def test_push_uses_current_role_voice(roles_server):
    s = roles_server
    s.fake_reset()
    s.post("/role", json={"device_id": "rd7", "role": "mio", "greet": False})
    s.post("/push", json={"text": "开饭啦", "device_id": "rd7"})
    assert s.fake_log()["tts"][-1] == {"text": "开饭啦", "per": 4}


def test_shake_goes_to_current_role_agent(roles_server):
    s = roles_server
    s.fake_reset()
    s.post("/role", json={"device_id": "rd8", "role": "mio", "greet": False})
    s.get("/shake", headers={"X-Device-Id": "rd8"})
    assert _wait_llm(s)[0]["agent"] == "mio"
