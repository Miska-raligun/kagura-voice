"""直播流：TCP 接收协议 + 取帧/控制路由。"""

import socket
import struct
import threading
import time

import pytest

import stream_server as ss


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture()
def stream_port(monkeypatch):
    """每个测试一个独立端口 + 干净的帧表；转换函数打桩成可辨认的假 JPEG。"""
    monkeypatch.setattr(ss, "_latest", {})
    monkeypatch.setattr(ss, "_server_sock", None)
    port = _free_port()
    assert ss.init(lambda raw: b"JPEG:" + raw[:4] if len(raw) >= 4 else None,
                   token="", port=port)
    yield port
    try:
        ss._server_sock.close()
    except Exception:
        pass


def _connect(port, device_id="cores3", token="", version="v1"):
    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
    sock.sendall(f"KAGURA_STREAM {version} {device_id} {token}\n".encode())
    return sock


def _send_frame(sock, payload):
    sock.sendall(struct.pack(">I", len(payload)) + payload)


def _wait_for(pred, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        got = pred()
        if got:
            return got
        time.sleep(0.02)
    return None


# ── 协议 ─────────────────────────────────────────────────────────────────────

def test_frames_become_latest(stream_port):
    sock = _connect(stream_port)
    _send_frame(sock, b"ABCDxxxx")
    rec = _wait_for(lambda: ss.latest("cores3") and ss.latest("cores3")["jpeg"])
    assert rec == b"JPEG:ABCD"
    assert ss.stats("cores3")["live"] is True
    sock.close()


def test_only_latest_frame_kept(stream_port):
    sock = _connect(stream_port)
    for tag in (b"0001", b"0002", b"0003"):
        _send_frame(sock, tag + b"pad")
    rec = _wait_for(lambda: ss.latest("cores3") if
                    (ss.latest("cores3") or {}).get("jpeg") == b"JPEG:0003" else None)
    assert rec is not None
    assert rec["seq"] == 3 and rec["frames"] == 3
    sock.close()


def test_zero_length_ends_stream(stream_port):
    sock = _connect(stream_port)
    _send_frame(sock, b"ABCDx")
    _wait_for(lambda: ss.latest("cores3") and ss.latest("cores3")["jpeg"])
    sock.sendall(struct.pack(">I", 0))
    time.sleep(0.3)
    sock.close()
    assert ss.latest("cores3")["frames"] == 1     # 结束后最后一帧仍可取


def test_undecodable_frame_skipped_not_fatal(stream_port):
    """尺寸对不上的帧要跳过而不是断流，否则一帧异常就毁掉整场直播。"""
    sock = _connect(stream_port)
    _send_frame(sock, b"xy")                      # 转换函数对 <4 字节返回 None
    _send_frame(sock, b"GOODpad")
    rec = _wait_for(lambda: ss.latest("cores3") and ss.latest("cores3")["jpeg"])
    assert rec == b"JPEG:GOOD"
    assert ss.stats("cores3")["frames"] == 1      # 坏帧不计数
    sock.close()


def test_oversized_frame_disconnects(stream_port):
    sock = _connect(stream_port)
    sock.sendall(struct.pack(">I", ss.MAX_FRAME_BYTES + 1))
    time.sleep(0.3)
    assert (ss.latest("cores3") or {}).get("jpeg") is None
    sock.close()


@pytest.mark.parametrize("line", [
    b"GARBAGE\n", b"KAGURA_STREAM v9 cores3 \n", b"KAGURA_STREAM v1 bad!id \n",
])
def test_bad_handshake_rejected(stream_port, line):
    sock = socket.create_connection(("127.0.0.1", stream_port), timeout=5)
    sock.sendall(line)
    _send_frame(sock, b"ABCDx")
    time.sleep(0.3)
    assert ss.latest("cores3") is None
    sock.close()


def test_token_enforced(monkeypatch):
    monkeypatch.setattr(ss, "_latest", {})
    port = _free_port()
    assert ss.init(lambda raw: b"JPEG", token="s3cret", port=port)
    try:
        bad = _connect(port, token="wrong")
        _send_frame(bad, b"ABCDx")
        time.sleep(0.3)
        assert ss.latest("cores3") is None
        bad.close()

        good = _connect(port, token="s3cret")
        _send_frame(good, b"ABCDx")
        assert _wait_for(lambda: ss.latest("cores3")) is not None
        good.close()
    finally:
        ss._server_sock.close()


def test_drop_clears_device(stream_port):
    sock = _connect(stream_port)
    _send_frame(sock, b"ABCDx")
    _wait_for(lambda: ss.latest("cores3"))
    ss.drop("cores3")
    assert ss.latest("cores3") is None
    assert ss.stats("cores3") == {"live": False, "frames": 0, "fps": 0.0}
    sock.close()


def test_stats_marks_stale(stream_port, monkeypatch):
    sock = _connect(stream_port)
    _send_frame(sock, b"ABCDx")
    _wait_for(lambda: ss.latest("cores3"))
    with ss._lock:
        ss._latest["cores3"]["ts"] -= ss.STALE_AFTER + 1
    assert ss.stats("cores3")["live"] is False
    sock.close()


# ── 路由 ─────────────────────────────────────────────────────────────────────

def test_stream_control_requires_mqtt(client, vs, monkeypatch):
    monkeypatch.setattr(vs, "_mqtt_client", None)
    assert client.post("/api/monitor/stream", json={"action": "start"}).status_code == 503


def test_stream_start_publishes(client, vs, monkeypatch):
    published = []
    monkeypatch.setattr(vs, "_mqtt_client",
                        type("M", (), {"publish": lambda s, t, p, qos=0:
                                       published.append((t, __import__("json").loads(p)))})())
    resp = client.post("/api/monitor/stream", json={"action": "start", "device_id": "cores3"})
    assert resp.status_code == 200
    topic, payload = published[0]
    assert topic == "kagura/cmd/cores3"
    assert payload["action"] == "stream_start"
    assert payload["secs"] == vs._STREAM_RENEW_SECS


def test_stream_stop_drops_frames(client, vs, monkeypatch):
    monkeypatch.setattr(vs, "_mqtt_client",
                        type("M", (), {"publish": lambda *a, **k: None})())
    dropped = []
    monkeypatch.setattr(vs.stream_server, "drop", lambda d: dropped.append(d))
    assert client.post("/api/monitor/stream", json={"action": "stop"}).status_code == 200
    assert dropped == ["cores3"]


def test_stream_bad_action_400(client, vs, monkeypatch):
    monkeypatch.setattr(vs, "_mqtt_client", type("M", (), {"publish": lambda *a, **k: None})())
    assert client.post("/api/monitor/stream", json={"action": "explode"}).status_code == 400


def test_frame_endpoint_204_when_no_stream(client, vs, monkeypatch):
    monkeypatch.setattr(vs, "_STREAM_POLL_WAIT", 0.1)
    assert client.get("/stream/cores3/frame.jpg").status_code == 204


def test_frame_endpoint_returns_jpeg(client, vs, monkeypatch):
    monkeypatch.setattr(vs.stream_server, "latest",
                        lambda d: {"jpeg": b"\xff\xd8data", "seq": 7, "ts": time.time()})
    resp = client.get("/stream/cores3/frame.jpg")
    assert resp.status_code == 200
    assert resp.mimetype == "image/jpeg"
    assert resp.headers["X-Frame-Seq"] == "7"
    assert resp.data == b"\xff\xd8data"


def test_frame_endpoint_long_polls_on_same_seq(client, vs, monkeypatch):
    """?after= 与当前 seq 相同时应挂住等新帧，而不是立刻回同一张。"""
    monkeypatch.setattr(vs, "_STREAM_POLL_WAIT", 0.2)
    monkeypatch.setattr(vs.stream_server, "latest",
                        lambda d: {"jpeg": b"\xff\xd8data", "seq": 7, "ts": time.time()})
    t0 = time.time()
    resp = client.get("/stream/cores3/frame.jpg?after=7")
    assert resp.status_code == 204
    assert time.time() - t0 >= 0.15


def test_rgb565_to_jpeg_roundtrip(vs):
    raw = bytes(160 * 120 * 2)                  # 全黑 QQVGA 帧
    jpeg = vs._rgb565_to_jpeg_bytes(raw)
    assert jpeg[:2] == b"\xff\xd8"
    assert vs._rgb565_to_jpeg_bytes(b"\x00" * 7) is None   # 尺寸对不上


def test_stream_frame_uses_lower_quality(vs):
    raw = bytes(160 * 120 * 2)
    assert len(vs._stream_frame_to_jpeg(raw)) <= len(vs._rgb565_to_jpeg_bytes(raw))


# ── 直播中抓拍 ───────────────────────────────────────────────────────────────

def test_capture_uses_live_frame_when_streaming(client, vs, monkeypatch):
    """直播中按快门要用服务端手上的帧，绝不能走 MQTT——设备正忙着推流，
    命令会被压回队列，等直播结束才执行。"""
    monkeypatch.setattr(vs.stream_server, "latest",
                        lambda d: {"jpeg": b"\xff\xd8live", "seq": 42, "ts": time.time()})

    def _no_mqtt(*a, **k):
        raise AssertionError("直播中不应下发 MQTT 拍照命令")
    monkeypatch.setattr(vs, "_issue_capture", _no_mqtt)

    data = client.post("/api/monitor/capture", json={}).get_json()
    assert data["status"] == "done" and data["source"] == "stream"
    photo = client.get("/photo/" + data["request_id"])
    assert photo.status_code == 200 and photo.data == b"\xff\xd8live"


def test_hires_bypasses_live_frame(client, vs, mqtt, monkeypatch):
    """hires=true 时即使直播开着也要下发拍照命令——要的就是设备切回高分辨率重拍。"""
    monkeypatch.setattr(vs.stream_server, "latest",
                        lambda d: {"jpeg": b"\xff\xd8live", "seq": 3, "ts": time.time()})
    data = client.post("/api/monitor/capture", json={"hires": True}).get_json()
    assert data["status"] == "queued" and data["source"] == "device"
    topic, payload, _ = mqtt.published[0]
    assert topic == "kagura/cmd/cores3" and payload["action"] == "capture"


def test_capture_falls_back_to_device_when_frame_stale(client, vs, mqtt, monkeypatch):
    """直播停了以后，最后那帧不该被当成"当前画面"，要退回正常拍照。"""
    monkeypatch.setattr(vs.stream_server, "latest",
                        lambda d: {"jpeg": b"\xff\xd8old", "seq": 1,
                                   "ts": time.time() - vs.stream_server.STALE_AFTER - 1})
    data = client.post("/api/monitor/capture", json={}).get_json()
    assert data["status"] == "queued" and data["source"] == "device"


def test_capture_falls_back_when_never_streamed(client, vs, mqtt):
    data = client.post("/api/monitor/capture", json={}).get_json()
    assert data["status"] == "queued" and data["source"] == "device"


def test_live_grab_can_be_described(client, vs, monkeypatch, snap_dir):
    """抓拍 → 说一句：整条要能串起来（这是直播最有用的组合）。"""
    monkeypatch.setattr(vs.stream_server, "latest",
                        lambda d: {"jpeg": b"\xff\xd8live", "seq": 9, "ts": time.time()})
    rid = client.post("/api/monitor/capture", json={}).get_json()["request_id"]
    done = threading.Event()
    monkeypatch.setattr(vs, "chat", lambda *a, **k: "画面里有只猫在桌上")
    monkeypatch.setattr(vs, "_send_push", lambda t, d: done.set() or True)
    assert client.post("/api/monitor/describe", json={"request_id": rid}).status_code == 202
    assert done.wait(5)
    assert vs._list_snapshots()[0]["reply"] == "画面里有只猫在桌上"


# ── 拍完让它说一句 ───────────────────────────────────────────────────────────

def test_describe_requires_existing_photo(client, vs):
    assert client.post("/api/monitor/describe", json={"request_id": "nope"}).status_code == 404


def test_describe_accepts_custom_prompt(client, vs, tmp_path, monkeypatch, snap_dir):
    """调用方给了 prompt 就用它，不塞任何默认提问。"""
    img = tmp_path / "shot.jpg"
    img.write_bytes(b"\xff\xd8jpg")
    with vs.state.photos_lock:
        vs.state.photo_results["m1"] = {"status": "done", "image_path": str(img),
                                        "_ts": time.time()}
    done = threading.Event()
    seen = {}

    def _chat(msg, session_id, **kw):
        seen["msg"] = msg
        return "好"
    monkeypatch.setattr(vs, "chat", _chat)
    monkeypatch.setattr(vs, "_send_push", lambda t, d: done.set() or True)
    client.post("/api/monitor/describe",
                json={"request_id": "m1", "prompt": "桌上那杯水还在吗"})
    assert done.wait(5)
    assert seen["msg"].startswith("桌上那杯水还在吗")
    assert vs._DEFAULT_PHOTO_PROMPT not in seen["msg"]


def test_describe_runs_in_background(client, vs, tmp_path, monkeypatch, snap_dir):
    img = tmp_path / "shot.jpg"
    img.write_bytes(b"\xff\xd8jpg")
    with vs.state.photos_lock:
        vs.state.photo_results["r1"] = {"status": "done", "image_path": str(img),
                                        "_ts": time.time()}
    done = threading.Event()
    seen = {}

    def _chat(msg, session_id, image_path=None, local_time=None, **kw):
        seen["image"] = image_path
        return "看到一只猫"
    monkeypatch.setattr(vs, "chat", _chat)
    monkeypatch.setattr(vs, "_send_push", lambda t, d: done.set() or True)

    resp = client.post("/api/monitor/describe", json={"request_id": "r1"})
    assert resp.status_code == 202
    assert done.wait(5)
    assert seen["image"] == str(img)
    assert vs._list_snapshots()[0]["reply"] == "看到一只猫"
