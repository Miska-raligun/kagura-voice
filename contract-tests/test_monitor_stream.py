"""监控页：状态、网页拍照、定时拍照（端到端）、识别播报、快照留档；直播 TCP 协议与长轮询取帧。"""
import socket
import struct
import threading
import time

from conftest import b64, rgb565


def _poll(fn, timeout=10, every=0.1):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(every)
    raise AssertionError(f"{timeout}s 内条件未满足")


def _answer_captures(srv, device, n=1, image=None):
    """后台扮演设备：收到 capture 命令就上传一张 RGB565。"""
    def run():
        for _ in range(n):
            cmd = device.wait("cmd", lambda m: m.get("action") == "capture", timeout=15)
            srv.post("/upload-photo", json={"request_id": cmd["request_id"], "device_id": device.id,
                                            "image": image if image is not None else b64(rgb565())})
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


# ── 页面与状态 ───────────────────────────────────────────────────────────────

def test_monitor_page(srv):
    r = srv.get("/monitor")
    assert r.status_code == 200 and "text/html" in r.headers["Content-Type"] and "<script>" in r.text


def test_state_shape(srv):
    srv.post("/heartbeat", json={"device_id": "m1", "bat": 80, "rssi": -50})
    st = srv.get("/api/monitor/state?device_id=m1").json()
    for k in ("server_time", "mqtt", "auth_required", "devices", "schedules", "snapshots", "stream", "role", "roles"):
        assert k in st, k
    assert st["mqtt"] is True and st["auth_required"] is False
    assert st["devices"]["m1"]["online"] is True and st["devices"]["m1"]["bat"] == 80
    assert st["stream"] == {"live": False, "frames": 0, "fps": 0.0}


# ── 网页拍照 ─────────────────────────────────────────────────────────────────

def test_web_capture_via_device(srv, device):
    r = srv.post("/api/monitor/capture", json={"device_id": device.id}).json()
    assert r["status"] == "queued" and r["source"] == "device"
    _answer_captures(srv, device)
    body = _poll(lambda: (x := srv.get(f"/capture-result/{r['request_id']}")).status_code == 200 and x.json())
    assert srv.get(body["image_url"]).content[:2] == b"\xff\xd8"


def test_web_capture_rate_limited(srv):
    codes = [srv.post("/api/monitor/capture", json={"device_id": "mcrl"}).status_code for _ in range(31)]
    assert codes[30] == 429


# ── 定时拍照计划 ─────────────────────────────────────────────────────────────

def test_schedule_crud(srv):
    item = srv.post("/api/monitor/schedules", json={"time": "7:05", "device_id": "s1", "prompt": "看看猫"})
    assert item.status_code == 201
    it = item.json()
    assert it["time"] == "07:05" and it["enabled"] is True and it["prompt"] == "看看猫"
    sid = it["id"]
    assert any(x["id"] == sid for x in srv.get("/api/monitor/state").json()["schedules"])
    up = srv.request("PATCH", f"/api/monitor/schedules/{sid}", json={"enabled": False, "time": "08:00"}).json()
    assert up["enabled"] is False and up["time"] == "08:00"
    assert srv.request("PATCH", f"/api/monitor/schedules/{sid}", json={"time": "25:00"}).status_code == 400
    assert srv.request("DELETE", f"/api/monitor/schedules/{sid}").json() == {"status": "ok"}
    assert srv.request("DELETE", f"/api/monitor/schedules/{sid}").status_code == 404
    assert srv.request("PATCH", "/api/monitor/schedules/nope", json={}).status_code == 404
    assert srv.post("/api/monitor/schedules/nope/run").status_code == 404


def test_schedule_bad_time_400(srv):
    assert srv.post("/api/monitor/schedules", json={"time": "早上八点"}).status_code == 400


def test_schedule_run_end_to_end(srv, device):
    """试跑：设备拍照 → LLM 识别 → 留档快照 → 推送播报。"""
    sid = srv.post("/api/monitor/schedules", json={"time": "03:00", "device_id": device.id,
                                                   "prompt": "猫在干嘛"}).json()["id"]
    srv.fake_llm("猫在睡觉。")
    t0 = time.time()
    r = srv.post(f"/api/monitor/schedules/{sid}/run")
    assert r.status_code == 202 and time.time() - t0 < 2, "试跑应立即返回"
    _answer_captures(srv, device)
    push = device.wait("push", timeout=15)
    assert push["type"] == "push"
    call = srv.fake_log()["llm"][0]
    assert call["image"] is True and "猫在干嘛" in call["message"]
    snap = _poll(lambda: [s for s in srv.get("/api/monitor/state").json()["snapshots"]
                          if s.get("device_id") == device.id])[0]
    assert snap["reply"] == "猫在睡觉。" and snap["has_image"] is True
    img = srv.get(snap["image_url"])
    assert img.status_code == 200 and img.content[:2] == b"\xff\xd8"
    sched = [x for x in srv.get("/api/monitor/state").json()["schedules"] if x["id"] == sid][0]
    assert sched["last_result"] is not None
    srv.request("DELETE", f"/api/monitor/schedules/{sid}")


def test_schedule_run_llm_failure_still_archives(srv, device):
    sid = srv.post("/api/monitor/schedules", json={"time": "03:00", "device_id": device.id}).json()["id"]
    srv.fake_llm({"error": "openclaw 挂了"})
    srv.post(f"/api/monitor/schedules/{sid}/run")
    _answer_captures(srv, device)
    snap = _poll(lambda: [s for s in srv.get("/api/monitor/state").json()["snapshots"]
                          if s.get("device_id") == device.id])[0]
    assert snap["error"] and snap["has_image"] is True
    srv.request("DELETE", f"/api/monitor/schedules/{sid}")


def test_snapshot_name_validated(srv):
    assert srv.get("/snapshot/..%2F..%2Fetc").status_code in (400, 404)
    assert srv.get("/snapshot/bad-name").status_code == 400
    assert srv.get("/snapshot/20260101_000000_abcd").status_code == 404


# ── 识别播报（网页「拍完让它说一句」）──────────────────────────────────────────

def test_describe(srv, device):
    assert srv.post("/api/monitor/describe", json={"request_id": "nope"}).status_code == 404
    rid = srv.post("/capture-request", json={"device_id": device.id}).json()["request_id"]
    _answer_captures(srv, device).join(15)
    srv.fake_llm("是一盆绿萝。")
    r = srv.post("/api/monitor/describe", json={"request_id": rid, "device_id": device.id, "prompt": "这是什么植物"})
    assert r.status_code == 202
    device.wait("push", timeout=10)
    call = srv.fake_log()["llm"][0]
    assert "这是什么植物" in call["message"] and call["image"] is True


# ── 直播 ─────────────────────────────────────────────────────────────────────

class StreamClient:
    def __init__(self, srv, dev, token=""):
        self.s = socket.create_connection(("127.0.0.1", srv.stream_port), timeout=5)
        self.hello = f"KAGURA_STREAM v1 {dev} {token}\n".encode()

    def send_hello_with_first_frame(self, frame):
        # 握手行和第一帧粘在同一次 send 里：服务端必须用缓冲接着读，不能丢字节
        self.s.sendall(self.hello + struct.pack(">I", len(frame)) + frame)

    def frame(self, frame):
        self.s.sendall(struct.pack(">I", len(frame)) + frame)

    def end(self):
        self.s.sendall(struct.pack(">I", 0))
        self.s.close()


def test_stream_start_stop_commands(srv, device):
    r = srv.post("/api/monitor/stream", json={"device_id": device.id, "action": "start"}).json()
    assert r["status"] == "ok" and r["action"] == "start"
    cmd = device.wait("cmd")
    assert cmd["action"] == "stream_start" and cmd["port"] == srv.stream_port and cmd["secs"] > 0
    srv.post("/api/monitor/stream", json={"device_id": device.id, "action": "stop"})
    assert device.wait("cmd") == {"action": "stream_stop"}
    assert srv.post("/api/monitor/stream", json={"device_id": device.id, "action": "pause"}).status_code == 400


def test_stream_frames_and_long_poll(srv):
    dev = "st1"
    assert srv.get(f"/stream/{dev}/frame.jpg").status_code == 204
    c = StreamClient(srv, dev)
    c.send_hello_with_first_frame(rgb565(160, 120))
    r = _poll(lambda: (x := srv.get(f"/stream/{dev}/frame.jpg")).status_code == 200 and x)
    assert r.content[:2] == b"\xff\xd8" and r.headers["X-Frame-Seq"] == "1"
    # 同一个 seq 长轮询：挂住，直到有新帧
    t0 = time.time()
    threading.Timer(0.8, lambda: c.frame(rgb565(160, 120))).start()
    r2 = srv.get(f"/stream/{dev}/frame.jpg?after=1")
    assert r2.status_code == 200 and r2.headers["X-Frame-Seq"] == "2" and time.time() - t0 >= 0.6
    st = srv.get(f"/api/monitor/state?device_id={dev}").json()["stream"]
    assert st["live"] is True and st["frames"] == 2
    # 尺寸对不上的帧跳过、不断流
    c.frame(b"\x00" * 1000)
    c.frame(rgb565(160, 120))
    _poll(lambda: srv.get(f"/stream/{dev}/frame.jpg?after=2").headers.get("X-Frame-Seq") == "3")
    c.end()


def test_capture_uses_live_frame_while_streaming(srv, device):
    c = StreamClient(srv, device.id)
    c.send_hello_with_first_frame(rgb565(160, 120))
    _poll(lambda: srv.get(f"/stream/{device.id}/frame.jpg").status_code == 200)
    r = srv.post("/api/monitor/capture", json={"device_id": device.id}).json()
    assert r["status"] == "done" and r["source"] == "stream"
    assert srv.get(f"/capture-result/{r['request_id']}").json()["status"] == "done"
    hi = srv.post("/api/monitor/capture", json={"device_id": device.id, "hires": True}).json()
    assert hi["source"] == "device" and device.wait("cmd")["action"] == "capture"
    c.end()


def test_stream_stop_drops_frames(srv):
    dev = "st2"
    c = StreamClient(srv, dev)
    c.send_hello_with_first_frame(rgb565(160, 120))
    _poll(lambda: srv.get(f"/stream/{dev}/frame.jpg").status_code == 200)
    srv.post("/api/monitor/stream", json={"device_id": dev, "action": "stop"})
    assert srv.get(f"/stream/{dev}/frame.jpg").status_code == 204
    c.s.close()


def test_stream_oversized_frame_disconnects(srv):
    c = StreamClient(srv, "st3")
    c.s.sendall(c.hello + struct.pack(">I", 10 * 1024 * 1024))
    c.s.settimeout(5)
    assert c.s.recv(10) == b"", "服务端应断开"


def test_stream_bad_handshake_rejected(srv):
    s = socket.create_connection(("127.0.0.1", srv.stream_port), timeout=5)
    s.sendall(b"HELLO\n")
    assert s.recv(10) == b""


def test_stream_token_enforced(token_server):
    s = token_server
    bad = StreamClient(s, "st4", token="wrong")
    bad.send_hello_with_first_frame(rgb565(160, 120))
    time.sleep(0.5)
    assert s.get("/stream/st4/frame.jpg").status_code == 204
    good = StreamClient(s, "st5", token="st0k")
    good.send_hello_with_first_frame(rgb565(160, 120))
    _poll(lambda: s.get("/stream/st5/frame.jpg").status_code == 200)
    good.end()


# ── UDP 自动发现 ─────────────────────────────────────────────────────────────

def test_udp_discovery(srv):
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    u.settimeout(3)
    for _ in range(10):          # 中继进程可能还在绑端口，重发几次
        u.sendto(b"KAGURA_DISCOVER", ("127.0.0.1", srv.disc_port))
        try:
            data, _ = u.recvfrom(64)
            break
        except socket.timeout:
            continue
    else:
        raise AssertionError("UDP 发现无应答")
    assert data.strip() == b"KAGURA_HERE"


def test_stream_zero_length_frame_ends_stream(srv):
    c = StreamClient(srv, "st6")
    c.send_hello_with_first_frame(rgb565(160, 120))
    _poll(lambda: srv.get("/stream/st6/frame.jpg").status_code == 200)
    c.s.sendall(struct.pack(">I", 0))
    c.s.settimeout(5)
    assert c.s.recv(10) == b"", "0 长度帧 = 结束，服务端应断开"
