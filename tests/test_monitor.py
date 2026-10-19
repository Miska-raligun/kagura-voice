"""监控网页的路由层 + 定时拍照执行体（拍照/识别/播报全部打桩）。"""

import json
import time

import pytest

import photo_schedules as ps


@pytest.fixture()
def sched_store(tmp_path, monkeypatch):
    """定时计划用独立空存储，别写脏工作区的 photo_schedules.json。"""
    monkeypatch.setattr(ps, "STORE_PATH", tmp_path / "sched.json")
    monkeypatch.setattr(ps, "_items", [])
    monkeypatch.setattr(ps, "_run_fn", None)
    return ps


# ── 网页与状态 ───────────────────────────────────────────────────────────────

def test_monitor_page_served(client):
    resp = client.get("/monitor")
    assert resp.status_code == 200
    assert b"<title>" in resp.data


def test_monitor_state_shape(client, sched_store):
    data = client.get("/api/monitor/state").get_json()
    assert set(["server_time", "mqtt", "devices", "schedules", "snapshots"]) <= set(data)
    assert data["schedules"] == []


def test_monitor_state_lists_devices(client, vs, sched_store):
    client.post("/heartbeat", json={"device_id": "cores3", "heap": 40000, "bat": 88})
    devices = client.get("/api/monitor/state").get_json()["devices"]
    assert devices["cores3"]["online"] is True
    assert devices["cores3"]["bat"] == 88


# ── 手动拍照 ─────────────────────────────────────────────────────────────────

def test_capture_without_mqtt_503(client, vs, monkeypatch):
    monkeypatch.setattr(vs, "_mqtt_client", None)
    assert client.post("/api/monitor/capture", json={}).status_code == 503


def test_capture_publishes_command(client, mqtt):
    data = client.post("/api/monitor/capture", json={"device_id": "cores3"}).get_json()
    assert data["status"] == "queued"
    topic, payload, _ = mqtt.published[0]
    assert topic == "kagura/cmd/cores3"
    assert payload["action"] == "capture"
    assert payload["request_id"] == data["request_id"]


def test_capture_rate_limited(client, vs, mqtt, monkeypatch):
    monkeypatch.setattr(vs, "_CAPTURE_RATE_MAX", 2)
    assert client.post("/api/monitor/capture", json={}).status_code == 200
    assert client.post("/api/monitor/capture", json={}).status_code == 200
    assert client.post("/api/monitor/capture", json={}).status_code == 429


def test_capture_result_carries_image_url(client, vs, mqtt, tmp_path):
    rid = client.post("/api/monitor/capture", json={}).get_json()["request_id"]
    assert client.get(f"/capture-result/{rid}").status_code == 202
    img = tmp_path / "shot.jpg"
    img.write_bytes(b"\xff\xd8fake-jpeg")
    with vs.state.photos_lock:
        vs.state.photo_results[rid] = {"status": "done", "image_path": str(img), "_ts": time.time()}
    data = client.get(f"/capture-result/{rid}").get_json()
    assert data["image_url"] == f"/photo/{rid}"
    assert data["image_path"] == str(img)      # OpenClaw skill 仍依赖这个字段


def test_serve_photo(client, vs, tmp_path):
    img = tmp_path / "shot.jpg"
    img.write_bytes(b"\xff\xd8fake-jpeg")
    with vs.state.photos_lock:
        vs.state.photo_results["abc"] = {"status": "done", "image_path": str(img), "_ts": time.time()}
    resp = client.get("/photo/abc")
    assert resp.status_code == 200
    assert resp.mimetype == "image/jpeg"
    assert resp.data == b"\xff\xd8fake-jpeg"


def test_serve_photo_unknown_404(client):
    assert client.get("/photo/nope").status_code == 404


def test_serve_photo_missing_file_404(client, vs, tmp_path):
    with vs.state.photos_lock:
        vs.state.photo_results["gone"] = {
            "status": "done", "image_path": str(tmp_path / "deleted.jpg"), "_ts": time.time()}
    assert client.get("/photo/gone").status_code == 404


# ── 快照留档 ─────────────────────────────────────────────────────────────────

def test_snapshot_name_validated(client, snap_dir):
    assert client.get("/snapshot/../../etc/passwd").status_code in (400, 404)
    assert client.get("/snapshot/not-a-valid-name").status_code == 400
    assert client.get("/snapshot/20260809_080000_ab12").status_code == 404


def test_save_and_list_snapshots(vs, snap_dir, tmp_path):
    img = tmp_path / "src.jpg"
    img.write_bytes(b"\xff\xd8jpg")
    name = vs._save_snapshot(str(img), {"ts": time.time(), "reply": "桌上有杯咖啡", "error": None})
    listed = vs._list_snapshots()
    assert len(listed) == 1
    assert listed[0]["name"] == name
    assert listed[0]["has_image"] is True
    assert listed[0]["reply"] == "桌上有杯咖啡"


def test_save_snapshot_without_image(vs, snap_dir):
    vs._save_snapshot(None, {"ts": time.time(), "reply": "", "error": "设备离线"})
    listed = vs._list_snapshots()
    assert listed[0]["has_image"] is False
    assert listed[0]["error"] == "设备离线"


def test_snapshot_pruning(vs, snap_dir, tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "SNAPSHOT_MAX", 3)
    img = tmp_path / "src.jpg"
    img.write_bytes(b"\xff\xd8jpg")
    for i in range(6):
        vs._save_snapshot(str(img), {"ts": time.time() + i * 60, "reply": f"第{i}张"})
    assert len(list(snap_dir.glob("*.json"))) == 3
    assert len(list(snap_dir.glob("*.jpg"))) == 3


# ── 定时计划 CRUD ────────────────────────────────────────────────────────────

def test_schedule_crud(client, sched_store):
    created = client.post("/api/monitor/schedules",
                          json={"time": "8:05", "prompt": "看看猫"})
    assert created.status_code == 201
    sid = created.get_json()["id"]
    assert created.get_json()["time"] == "08:05"

    listed = client.get("/api/monitor/state").get_json()["schedules"]
    assert [s["id"] for s in listed] == [sid]

    patched = client.patch(f"/api/monitor/schedules/{sid}", json={"enabled": False})
    assert patched.get_json()["enabled"] is False

    assert client.delete(f"/api/monitor/schedules/{sid}").status_code == 200
    assert client.get("/api/monitor/state").get_json()["schedules"] == []


def test_schedule_bad_time_400(client, sched_store):
    resp = client.post("/api/monitor/schedules", json={"time": "25:00"})
    assert resp.status_code == 400
    assert "HH:MM" in resp.get_json()["error"]


def test_schedule_unknown_id_404(client, sched_store):
    assert client.patch("/api/monitor/schedules/nope", json={"enabled": True}).status_code == 404
    assert client.delete("/api/monitor/schedules/nope").status_code == 404
    assert client.post("/api/monitor/schedules/nope/run").status_code == 404


def test_schedule_run_returns_immediately(client, sched_store, monkeypatch):
    ran = []
    monkeypatch.setattr(ps, "_run_fn", lambda item: ran.append(item["id"]) or {"ok": True})
    sid = client.post("/api/monitor/schedules", json={"time": "08:00"}).get_json()["id"]
    assert client.post(f"/api/monitor/schedules/{sid}/run").status_code == 202
    for _ in range(50):                    # 后台线程，给它一点时间
        if ran:
            break
        time.sleep(0.02)
    assert ran == [sid]


# ── 定时拍照执行体 ───────────────────────────────────────────────────────────

def test_scheduled_capture_happy_path(vs, snap_dir, tmp_path, monkeypatch):
    img = tmp_path / "cap.jpg"
    img.write_bytes(b"\xff\xd8jpg")
    monkeypatch.setattr(vs, "_capture_and_wait", lambda dev, **kw: (str(img), None))
    seen = {}

    def _chat(msg, session_id, image_path=None, local_time=None, **kw):
        seen["msg"], seen["image"] = msg, image_path
        return "桌上有一杯没喝完的咖啡"
    monkeypatch.setattr(vs, "chat", _chat)
    monkeypatch.setattr(vs, "_send_push", lambda text, dev: True)

    result = vs._run_scheduled_capture({"time": "08:00", "device_id": "cores3", "prompt": "看看桌上"})
    assert result["ok"] is True
    assert result["spoken"] is True
    assert result["reply"] == "桌上有一杯没喝完的咖啡"
    assert seen["image"] == str(img)
    assert "cores3-speak" in seen["msg"]      # 必须拦住 agent 自己播报，否则念两遍
    assert vs._list_snapshots()[0]["has_image"] is True


def test_scheduled_capture_uses_default_prompt(vs, snap_dir, tmp_path, monkeypatch):
    img = tmp_path / "cap.jpg"
    img.write_bytes(b"\xff\xd8jpg")
    monkeypatch.setattr(vs, "_capture_and_wait", lambda dev, **kw: (str(img), None))
    seen = {}

    def _chat(msg, session_id, **kw):
        seen["msg"] = msg
        return "好"
    monkeypatch.setattr(vs, "chat", _chat)
    monkeypatch.setattr(vs, "_send_push", lambda text, dev: True)
    vs._run_scheduled_capture({"time": "08:00", "device_id": "cores3", "prompt": ""})
    assert vs._DEFAULT_PHOTO_PROMPT in seen["msg"]


def test_scheduled_capture_device_offline(vs, snap_dir, monkeypatch):
    monkeypatch.setattr(vs, "_capture_and_wait", lambda dev, **kw: (None, "等待设备上传超时"))
    monkeypatch.setattr(vs, "chat", lambda *a, **k: pytest.fail("拍照失败时不该调 openclaw"))
    result = vs._run_scheduled_capture({"time": "08:00", "device_id": "cores3"})
    assert result["ok"] is False
    assert "超时" in result["error"]
    snaps = vs._list_snapshots()
    assert snaps[0]["has_image"] is False and "超时" in snaps[0]["error"]


def test_scheduled_capture_chat_failure_still_archives(vs, snap_dir, tmp_path, monkeypatch):
    img = tmp_path / "cap.jpg"
    img.write_bytes(b"\xff\xd8jpg")
    monkeypatch.setattr(vs, "_capture_and_wait", lambda dev, **kw: (str(img), None))
    monkeypatch.setattr(vs, "chat", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("openclaw 挂了")))
    pushed = []
    monkeypatch.setattr(vs, "_send_push", lambda text, dev: pushed.append(text) or True)
    result = vs._run_scheduled_capture({"time": "08:00", "device_id": "cores3"})
    assert result["ok"] is False and "openclaw 挂了" in result["error"]
    assert pushed == []                       # 没有识别结果就别播报
    assert vs._list_snapshots()[0]["has_image"] is True   # 照片仍然留档


def test_capture_and_wait_returns_image(vs, mqtt, tmp_path):
    """设备上传后 _capture_and_wait 应立刻拿到路径。"""
    import threading
    img = tmp_path / "cap.jpg"
    img.write_bytes(b"\xff\xd8jpg")

    def _upload_soon():
        for _ in range(100):
            time.sleep(0.02)
            with vs.state.photos_lock:
                pending = [k for k, v in vs.state.photo_results.items() if v["status"] == "pending"]
                if pending:
                    vs.state.photo_results[pending[0]] = {
                        "status": "done", "image_path": str(img), "_ts": time.time()}
                    return

    threading.Thread(target=_upload_soon, daemon=True).start()
    path, err = vs._capture_and_wait("cores3", timeout=5)
    assert err is None and path == str(img)


def test_capture_and_wait_timeout(vs, mqtt):
    path, err = vs._capture_and_wait("cores3", timeout=1.0)
    assert path is None and "超时" in err


def test_capture_and_wait_without_mqtt(vs, monkeypatch):
    monkeypatch.setattr(vs, "_mqtt_client", None)
    path, err = vs._capture_and_wait("cores3")
    assert path is None and "MQTT" in err


# ── 鉴权 ─────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("method,path", [
    ("get", "/api/monitor/state"),
    ("post", "/api/monitor/capture"),
    ("post", "/api/monitor/schedules"),
    ("get", "/photo/abc"),
    ("get", "/snapshot/20260809_080000_ab12"),
])
def test_token_required_when_configured(client, vs, monkeypatch, sched_store, method, path):
    monkeypatch.setattr(vs, "API_TOKEN", "s3cret")
    assert getattr(client, method)(path).status_code == 401
    resp = getattr(client, method)(path, headers={"X-Api-Token": "s3cret"})
    assert resp.status_code != 401


def test_monitor_page_open_without_token(client, vs, monkeypatch):
    """页面本身必须能打开，否则没地方填 token。"""
    monkeypatch.setattr(vs, "API_TOKEN", "s3cret")
    assert client.get("/monitor").status_code == 200
