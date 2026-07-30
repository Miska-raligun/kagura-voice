"""路由层测试：transcribe / chat / synthesize / MQTT 全部打桩，只测 HTTP 行为。"""

import json


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.get_json()["status"] == "ok"


def test_time_returns_timestamp(client):
    data = client.get("/time").get_json()
    assert isinstance(data["timestamp"], int)


# ── /chat ────────────────────────────────────────────────────────────────────

def test_chat_quick_command_skips_openclaw(client, vs, fake_wav, monkeypatch):
    monkeypatch.setattr(vs, "transcribe", lambda p: "现在几点")

    def _boom(*a, **k):
        raise AssertionError("快捷指令命中时不应调用 openclaw")
    monkeypatch.setattr(vs, "chat", _boom)

    resp = client.post("/chat", data=b"fake-wav-bytes",
                       headers={"X-Device-Id": "t1", "X-Local-Time": "2026-05-15 14:23"})
    assert resp.status_code == 200
    assert resp.mimetype == "audio/wav"


def test_chat_normal_path_calls_openclaw(client, vs, fake_wav, monkeypatch):
    monkeypatch.setattr(vs, "transcribe", lambda p: "讲个笑话")
    monkeypatch.setattr(vs, "chat", lambda *a, **k: "好呀，哈哈")
    resp = client.post("/chat", data=b"fake-wav-bytes", headers={"X-Device-Id": "t2"})
    assert resp.status_code == 200
    assert "X-Need-Photo" not in resp.headers


def test_chat_photo_marker_sets_header(client, vs, fake_wav, monkeypatch):
    monkeypatch.setattr(vs, "transcribe", lambda p: "看看这是什么")
    monkeypatch.setattr(vs, "chat", lambda *a, **k: "[PHOTO]好的我看看")
    resp = client.post("/chat", data=b"fake-wav-bytes", headers={"X-Device-Id": "t3"})
    assert resp.status_code == 200
    assert resp.headers.get("X-Need-Photo") == "1"


def test_chat_empty_body_400(client):
    assert client.post("/chat", data=b"").status_code == 400


def test_chat_volume_command_sets_header(client, vs, fake_wav, monkeypatch):
    monkeypatch.setattr(vs, "transcribe", lambda p: "小声一点")
    resp = client.post("/chat", data=b"x", headers={"X-Device-Id": "tv"})
    assert resp.status_code == 200
    assert resp.headers.get("X-Volume") == "down"


def test_chat_reminder_schedules(client, vs, fake_wav, monkeypatch):
    scheduled = []
    monkeypatch.setattr(vs.reminders, "schedule",
                        lambda ts, task, dev: scheduled.append((task, dev)))
    monkeypatch.setattr(vs, "transcribe", lambda p: "三分钟后提醒我关火")
    resp = client.post("/chat", data=b"x",
                       headers={"X-Device-Id": "tr", "X-Local-Time": "2026-05-15 14:23"})
    assert resp.status_code == 200
    assert scheduled == [("关火", "tr")]


def test_chat_text_headers_present(client, vs, fake_wav, monkeypatch):
    import base64
    monkeypatch.setattr(vs, "transcribe", lambda p: "现在几点")
    resp = client.post("/chat", data=b"x",
                       headers={"X-Device-Id": "tt", "X-Local-Time": "2026-05-15 14:23"})
    user = base64.b64decode(resp.headers["X-User-Text"]).decode("utf-8")
    reply = base64.b64decode(resp.headers["X-Reply-Text"]).decode("utf-8")
    assert user == "现在几点"
    assert reply.startswith("现在是")


def test_quick_context_carried_to_llm(client, vs, fake_wav, monkeypatch):
    """快捷指令命中后，下一次 LLM 对话应带上该问答作为背景。"""
    monkeypatch.setattr(vs, "transcribe", lambda p: "现在几点")
    hdrs = {"X-Device-Id": "ctx", "X-Local-Time": "2026-05-15 14:23"}
    client.post("/chat", data=b"x", headers=hdrs)          # quick 命中

    seen = []
    monkeypatch.setattr(vs, "transcribe", lambda p: "那半小时后叫我")
    # 注意"半小时后叫我"会命中 reminder，为测上下文改用普通句子
    monkeypatch.setattr(vs, "transcribe", lambda p: "为什么天是蓝的")
    monkeypatch.setattr(vs, "chat", lambda text, *a, **k: seen.append(text) or "回答")
    client.post("/chat", data=b"x", headers=hdrs)
    assert len(seen) == 1
    assert "现在几点" in seen[0] and "为什么天是蓝的" in seen[0]


def test_chat_device_rate_limit_429(client, vs, fake_wav, monkeypatch):
    vs.state = vs.ServerState(rate_max=2)
    monkeypatch.setattr(vs, "transcribe", lambda p: "现在几点")
    hdrs = {"X-Device-Id": "spam"}
    assert client.post("/chat", data=b"x", headers=hdrs).status_code == 200
    assert client.post("/chat", data=b"x", headers=hdrs).status_code == 200
    assert client.post("/chat", data=b"x", headers=hdrs).status_code == 429


def test_chat_ip_backstop_blocks_device_id_rotation(client, vs, fake_wav, monkeypatch):
    """device_id 每次换名字也躲不过按 IP 的兜底桶。"""
    vs.state = vs.ServerState(rate_max=1000)
    monkeypatch.setattr(vs, "_IP_RATE_MAX", 3)
    monkeypatch.setattr(vs, "transcribe", lambda p: "现在几点")
    codes = [client.post("/chat", data=b"x", headers={"X-Device-Id": f"d{i}"}).status_code
             for i in range(5)]
    assert codes[:3] == [200, 200, 200]
    assert set(codes[3:]) == {429}


# ── /push ────────────────────────────────────────────────────────────────────

def test_push_requires_text(client, vs):
    vs._mqtt_client = object()
    assert client.post("/push", json={}).status_code == 400


def test_push_503_without_mqtt(client, vs):
    vs._mqtt_client = None
    resp = client.post("/push", json={"text": "hi"})
    assert resp.status_code == 503


def test_push_open_by_default_and_publishes(client, vs, fake_wav):
    published = []

    class FakeMqtt:
        def publish(self, topic, payload, qos=0):
            published.append((topic, payload))
    vs._mqtt_client = FakeMqtt()

    resp = client.post("/push", json={"text": "早上好", "device_id": "cores3"})
    assert resp.status_code == 200
    topic, payload = published[0]
    assert topic == "kagura/push/cores3"
    assert json.loads(payload)["type"] == "push"


def test_push_401_when_token_set_and_missing(client, vs, monkeypatch):
    monkeypatch.setattr(vs, "API_TOKEN", "sekrit")
    assert client.post("/push", json={"text": "hi"}).status_code == 401


def test_push_ok_with_correct_token(client, vs, fake_wav, monkeypatch):
    monkeypatch.setattr(vs, "API_TOKEN", "sekrit")

    class FakeMqtt:
        def publish(self, *a, **k):
            pass
    vs._mqtt_client = FakeMqtt()
    resp = client.post("/push", json={"text": "hi"},
                       headers={"X-Api-Token": "sekrit"})
    assert resp.status_code == 200


# ── /capture-request 与 /upload-photo ───────────────────────────────────────

def test_capture_request_401_with_wrong_token(client, vs, monkeypatch):
    monkeypatch.setattr(vs, "API_TOKEN", "sekrit")
    resp = client.post("/capture-request", json={},
                       headers={"X-Api-Token": "wrong"})
    assert resp.status_code == 401


def test_capture_request_open_by_default(client, vs):
    published = []

    class FakeMqtt:
        def publish(self, topic, payload, qos=0):
            published.append(topic)
    vs._mqtt_client = FakeMqtt()
    resp = client.post("/capture-request", json={"device_id": "cores3"})
    assert resp.status_code == 200
    assert resp.get_json()["status"] == "queued"
    assert published == ["kagura/cmd/cores3"]


def test_upload_photo_unknown_request_404(client, vs):
    resp = client.post("/upload-photo", json={"request_id": "nope", "image": ""})
    assert resp.status_code == 404


def test_upload_photo_rate_limited(client, vs, monkeypatch):
    monkeypatch.setattr(vs, "_UPLOAD_RATE_MAX", 1)
    client.post("/upload-photo", json={"request_id": "r1", "image": ""})
    resp = client.post("/upload-photo", json={"request_id": "r1", "image": ""})
    assert resp.status_code == 429


def test_capture_result_lifecycle(client, vs):
    class FakeMqtt:
        def publish(self, *a, **k):
            pass
    vs._mqtt_client = FakeMqtt()
    rid = client.post("/capture-request", json={}).get_json()["request_id"]
    assert client.get(f"/capture-result/{rid}").status_code == 202     # pending
    assert client.get("/capture-result/unknown").status_code == 404


def test_heartbeat_and_device_status(client, vs, tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "DEVICE_LOGS_DIR", tmp_path / "device_logs")
    r = client.post("/heartbeat", json={
        "device_id": "cores3", "up": 120, "heap": 100000,
        "mqtt": True, "rssi": -55, "logs": ["12:00 wifi LOST", "12:01 wifi restored"],
    })
    assert r.status_code == 200
    s = client.get("/device-status").get_json()
    assert s["cores3"]["online"] is True
    assert s["cores3"]["last_heartbeat"]["heap"] == 100000
    assert any("wifi LOST" in l for l in s["cores3"]["recent_logs"])


def test_heartbeat_missing_body_ok(client):
    # 设备端 payload 异常也不该 500——心跳链路必须皮实
    assert client.post("/heartbeat", json={}).status_code == 200
