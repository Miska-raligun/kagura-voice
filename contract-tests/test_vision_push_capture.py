"""/chat-vision、/push、远程拍照全流程（capture-request → MQTT → 设备上传 → capture-result → photo）。"""
from conftest import b64, b64text, rgb565, wav


# ── /chat-vision 三种入参 ────────────────────────────────────────────────────

def test_vision_requires_wav_or_image(srv):
    assert srv.post("/chat-vision", json={}, headers={"X-Device-Id": "v0"}).status_code == 400
    assert srv.post("/chat-vision", json={"text": "这是什么"}, headers={"X-Device-Id": "v0"}).status_code == 400


def test_vision_image_only_uses_default_prompt(srv):
    srv.fake_llm("是一只猫。")
    r = srv.post("/chat-vision", json={"image": b64(rgb565())}, headers={"X-Device-Id": "v1"})
    assert r.status_code == 200 and r.content[:4] == b"RIFF"
    call = srv.fake_log()["llm"][0]
    assert call["image"] is True and "照片" in call["message"]
    assert srv.fake_log()["asr"] == 0
    assert b64text(r.headers["X-Reply-Text"]) == "是一只猫。"


def test_vision_text_used_as_question(srv):
    r = srv.post("/chat-vision", json={"image": b64(rgb565()), "text": "这是什么颜色"},
                 headers={"X-Device-Id": "v2"})
    assert r.status_code == 200
    assert srv.fake_log()["llm"][0]["message"] == "这是什么颜色"
    assert b64text(r.headers["X-User-Text"]) == "这是什么颜色"


def test_vision_wav_transcribed(srv):
    srv.fake_asr("桌上有什么")
    r = srv.post("/chat-vision", json={"wav": b64(wav()), "image": b64(rgb565())},
                 headers={"X-Device-Id": "v3"})
    assert r.status_code == 200
    log = srv.fake_log()
    assert log["asr"] == 1 and log["llm"][0]["message"] == "桌上有什么" and log["llm"][0]["image"]


def test_vision_jpeg_image_accepted(srv):
    jpeg = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + b"\x00" * 100
    r = srv.post("/chat-vision", json={"image": b64(jpeg), "text": "看"}, headers={"X-Device-Id": "v4"})
    assert r.status_code == 200 and srv.fake_log()["llm"][0]["image"] is True


def test_vision_bad_wav_b64_400(srv):
    r = srv.post("/chat-vision", json={"wav": "!!!不是base64", "image": b64(rgb565())},
                 headers={"X-Device-Id": "v5"})
    assert r.status_code == 400


def test_vision_touch_background(srv):
    srv.post("/chat-vision", json={"image": b64(rgb565()), "text": "这是什么"},
             headers={"X-Device-Id": "v6", "X-Touch": "pickups=1"})
    msg = srv.fake_log()["llm"][0]["message"]
    assert "拿起来" in msg and msg.endswith("这是什么")


# ── /push ────────────────────────────────────────────────────────────────────

def test_push_requires_text(srv):
    assert srv.post("/push", json={"device_id": "x"}).status_code == 400


def test_push_audio_downloadable_once(srv, device):
    assert srv.post("/push", json={"text": "开饭啦", "device_id": device.id}).json()["status"] == "ok"
    url = device.wait("push")["url"]
    r = srv.get(url)
    assert r.status_code == 200 and r.content[:4] == b"RIFF"
    assert srv.get(url).status_code == 404, "设备下载后文件应删除"
    assert srv.fake_log()["tts"][-1]["text"] == "开饭啦"


def test_push_audio_unknown_404(srv):
    assert srv.get("/push-audio/nope.wav").status_code == 404


# ── 远程拍照全流程 ───────────────────────────────────────────────────────────

def _upload(srv, device, request_id, image):
    return srv.post("/upload-photo", json={"request_id": request_id, "image": image, "device_id": device.id})


def test_capture_lifecycle(srv, device):
    r = srv.post("/capture-request", json={"device_id": device.id})
    assert r.status_code == 200 and r.json()["status"] == "queued"
    rid = r.json()["request_id"]
    cmd = device.wait("cmd")
    assert cmd == {"action": "capture", "request_id": rid}

    assert srv.get(f"/capture-result/{rid}").status_code == 202
    assert _upload(srv, device, rid, b64(rgb565())).json() == {"status": "ok", "request_id": rid}

    res = srv.get(f"/capture-result/{rid}")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "done" and body["image_path"] and body["image_url"] == f"/photo/{rid}"
    photo = srv.get(body["image_url"])
    assert photo.status_code == 200 and photo.content[:2] == b"\xff\xd8"


def test_capture_bad_image_is_error(srv, device):
    rid = srv.post("/capture-request", json={"device_id": device.id}).json()["request_id"]
    device.wait("cmd")
    _upload(srv, device, rid, b64(b"garbage"))
    r = srv.get(f"/capture-result/{rid}")
    assert r.status_code == 500 and r.json()["status"] == "error"
    assert srv.get(f"/photo/{rid}").status_code == 404


def test_upload_unknown_request_404(srv, device):
    assert _upload(srv, device, "nope1234", b64(rgb565())).status_code == 404
    assert srv.post("/upload-photo", json={"image": "x"}).status_code == 400


def test_capture_result_unknown_404(srv):
    assert srv.get("/capture-result/nope1234").status_code == 404
    assert srv.get("/photo/nope1234").status_code == 404


def test_capture_request_rate_limited(srv):
    codes = [srv.post("/capture-request", json={"device_id": "caprl"}).status_code for _ in range(31)]
    assert codes[:30] == [200] * 30 and codes[30] == 429


def test_upload_rate_limited(srv):
    codes = [srv.post("/upload-photo", json={"request_id": "x", "device_id": "uprl"}).status_code
             for _ in range(31)]
    assert codes[30] == 429 and 429 not in codes[:30]


def test_need_photo_followup_flow(srv, device):
    """/chat 回 X-Need-Photo → 设备拍照 → /chat-vision 带上原录音与照片。"""
    srv.fake_asr("看看我手里拿的什么")
    srv.fake_llm("[PHOTO]好的我看看", "是一个苹果。")
    audio = wav()
    r = srv.post("/chat", data=audio, headers={"X-Device-Id": device.id})
    assert r.headers.get("X-Need-Photo") == "1"
    srv.fake_asr("看看我手里拿的什么")
    r2 = srv.post("/chat-vision", json={"wav": b64(audio), "image": b64(rgb565())},
                  headers={"X-Device-Id": device.id})
    assert b64text(r2.headers["X-Reply-Text"]) == "是一个苹果。"
    calls = srv.fake_log()["llm"]
    assert calls[1]["image"] is True and calls[1]["message"] == "看看我手里拿的什么"
