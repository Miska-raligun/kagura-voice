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
