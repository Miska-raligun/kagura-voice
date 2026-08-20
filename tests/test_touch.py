"""触觉：X-Touch 体感摘要解析 + /touch 惊动路由。"""


# ── X-Touch 摘要解析 ─────────────────────────────────────────────────────────

def test_touch_background_empty_when_no_header(vs):
    assert vs._touch_background("") == ""
    assert vs._touch_background("stroke") == ""          # 没有 = 号
    assert vs._touch_background("stroke=abc") == ""      # 值不是整数


def test_touch_background_stroke(vs):
    bg = vs._touch_background("stroke=12,strokes=1")
    assert bg.startswith("[身体感觉：") and bg.endswith("]")
    assert "12 秒" in bg


def test_touch_background_multiple_strokes(vs):
    assert "3 次" in vs._touch_background("stroke=20,strokes=3")


def test_touch_background_combines_phrases(vs):
    bg = vs._touch_background("stroke=8,strokes=1,taps=2,pickups=1")
    assert "；" in bg
    assert "8 秒" in bg and "2 下" in bg and "拿起来" in bg


def test_touch_background_quiet_reported_in_minutes(vs):
    assert "30 分钟" in vs._touch_background("quiet=1830")


def test_touch_background_ignores_short_carry(vs):
    """carry < 5s 是路过的震动，不值得当成"被抱着走"上报。"""
    assert vs._touch_background("carry=2") == ""
    assert "10 秒" in vs._touch_background("carry=10")


def test_touch_background_rejects_oversized_header(vs):
    assert vs._touch_background("stroke=1," + "x" * 300) == ""


def test_touch_background_skips_garbage_pairs(vs):
    """一个键值坏掉不该让整条摘要作废。"""
    assert "5 秒" in vs._touch_background("junk,stroke=5,=,also=bad!")


def test_with_touch_prepends_background(vs):
    out = vs._with_touch("你在干嘛", "stroke=6,strokes=1")
    assert out.endswith("你在干嘛")
    assert out.startswith("[身体感觉：")


def test_with_touch_passthrough_without_header(vs):
    assert vs._with_touch("你在干嘛", "") == "你在干嘛"


# ── /chat 注入 ───────────────────────────────────────────────────────────────

def _spy_chat(vs, monkeypatch, seen):
    def _fake(text, *a, **k):
        seen["text"] = text
        return "在的"
    monkeypatch.setattr(vs, "chat", _fake)


def test_chat_injects_touch_background(client, vs, fake_wav, monkeypatch):
    seen = {}
    monkeypatch.setattr(vs, "transcribe", lambda p: "你在干嘛")
    _spy_chat(vs, monkeypatch, seen)

    resp = client.post("/chat", data=b"x",
                       headers={"X-Device-Id": "tt1", "X-Touch": "stroke=9,strokes=1"})
    assert resp.status_code == 200
    assert "身体感觉" in seen["text"] and "9 秒" in seen["text"]


def test_chat_without_touch_header_unchanged(client, vs, fake_wav, monkeypatch):
    seen = {}
    monkeypatch.setattr(vs, "transcribe", lambda p: "你在干嘛")
    _spy_chat(vs, monkeypatch, seen)

    client.post("/chat", data=b"x", headers={"X-Device-Id": "tt2"})
    assert seen["text"] == "你在干嘛"


def test_chat_vision_injects_touch_background(client, vs, fake_wav, monkeypatch):
    seen = {}
    monkeypatch.setattr(vs, "_decode_image_b64", lambda b64, dev, tag="": "/tmp/shot.jpg")
    _spy_chat(vs, monkeypatch, seen)

    resp = client.post("/chat-vision", json={"image": "Zm9v", "text": "这是什么"},
                       headers={"X-Device-Id": "tt4", "X-Touch": "pickups=1"})
    assert resp.status_code == 200
    assert "拿起来" in seen["text"] and seen["text"].endswith("这是什么")


def test_chat_quick_command_does_not_touch_openclaw(client, vs, fake_wav, monkeypatch):
    """短路链命中时不该因为带了 X-Touch 就绕去 LLM。"""
    monkeypatch.setattr(vs, "transcribe", lambda p: "现在几点")

    def _boom(*a, **k):
        raise AssertionError("快捷指令命中时不应调用 openclaw")
    monkeypatch.setattr(vs, "chat", _boom)

    resp = client.post("/chat", data=b"x",
                       headers={"X-Device-Id": "tt3", "X-Touch": "stroke=9"})
    assert resp.status_code == 200


# ── /touch 路由 ──────────────────────────────────────────────────────────────

def test_touch_route_rejects_unknown_kind(client):
    assert client.get("/touch", headers={"X-Device-Id": "tk"}).status_code == 400
    assert client.get("/touch", headers={"X-Device-Id": "tk",
                                         "X-Touch-Kind": "lick"}).status_code == 400


def test_touch_route_accepts_known_kinds(client, vs, monkeypatch):
    monkeypatch.setattr(vs, "chat", lambda *a, **k: "唔…")
    for kind in ("stroke", "cradle", "tap", "pickup"):
        resp = client.get("/touch", headers={"X-Device-Id": "tk2", "X-Touch-Kind": kind})
        assert resp.status_code == 200, kind
        assert resp.get_json()["status"] == "ok"


def test_touch_route_prompt_mentions_contact_and_speak(client, vs, monkeypatch):
    """后台线程发出的 prompt 必须说清是身体接触，并强制 cores3-speak。"""
    import threading
    seen = {}
    done = threading.Event()

    def _fake_chat(text, *a, **k):
        seen["text"] = text
        done.set()
        return "唔…"
    monkeypatch.setattr(vs, "chat", _fake_chat)

    client.get("/touch", headers={"X-Device-Id": "tk3", "X-Touch-Kind": "pickup",
                                  "X-Touch-Detail": "quiet=1830"})
    assert done.wait(5)
    assert "拿了起来" in seen["text"]
    assert "cores3-speak" in seen["text"]
    assert "30 分钟" in seen["text"]      # X-Touch-Detail 也要进 prompt


def test_touch_route_rate_limited(client, vs, monkeypatch):
    monkeypatch.setattr(vs, "chat", lambda *a, **k: "唔…")
    monkeypatch.setattr(vs.state, "check_rate", lambda *a, **k: False)
    resp = client.get("/touch", headers={"X-Device-Id": "tk4", "X-Touch-Kind": "tap"})
    assert resp.status_code == 429
