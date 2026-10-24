"""手机 / 平板网页客户端（/app）：新服务端才有。

配对（管理接口发令牌）→ 凭令牌拿身份、收 SSE 推送、打字聊天、用监控接口（令牌等同 API_TOKEN）→ 吊销后全部失效。
"""
import os
import threading
import time

import pytest
import requests

pytestmark = pytest.mark.skipif("broker" not in os.environ.get("KAGURA_SERVER_PROVIDES", ""),
                                reason="只有新服务端（TS）有手机客户端")


def _pair(s, name="测试手机"):
    r = s.post("/api/admin/clients", json={"name": name, "base": "https://kagura.example.ts.net"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["link"] == f"https://kagura.example.ts.net/app#pair={d['token']}"
    return d["client"]["id"], d["token"]


def _bare(s, method, path, token=None, **kw):
    """不带 API_TOKEN 的请求（模拟手机浏览器）"""
    h = dict(kw.pop("headers", {}))
    if token:
        h["Authorization"] = f"Bearer {token}"
    return requests.request(method, s.base + path, headers=h, timeout=kw.pop("timeout", 15), **kw)


def test_app_page_and_manifest(token_server):
    r = _bare(token_server, "GET", "/app")
    assert r.status_code == 200 and "text/html" in r.headers["Content-Type"] and "Kagura" in r.text
    m = _bare(token_server, "GET", "/app/manifest.webmanifest").json()
    assert m["start_url"] == "/app" and m["display"] == "standalone"


def test_pair_identity_push_monitor_revoke(token_server):
    s = token_server
    cid, token = _pair(s)
    assert _bare(s, "GET", "/client/me").status_code == 401
    me = _bare(s, "GET", "/client/me", token).json()
    assert me["id"] == cid and me["name"] == "测试手机" and me["roles"]
    # 手机和 CoreS3 在同一张设备表里（管理界面选角色）
    devs = s.get("/api/admin/devices").json()
    phone = next(d for d in devs if d["id"] == cid)
    assert phone["kind"] == "phone" and phone["name"] == "测试手机" and phone["trusted"] is True and phone["online"] is False

    # SSE：服务端推给这台手机的话经 /client/events 到达
    got, ready = [], threading.Event()

    def listen():
        with requests.get(s.base + f"/client/events?ct={token}", stream=True, timeout=20) as r:
            assert r.status_code == 200 and r.headers["Content-Type"].startswith("text/event-stream")
            ready.set()
            for line in r.iter_lines(decode_unicode=True):
                got.append(line)
                if line.startswith("data:") and "push-audio" in line:
                    return

    t = threading.Thread(target=listen, daemon=True)
    t.start()
    assert ready.wait(5)
    time.sleep(0.3)
    assert s.post("/push", json={"text": "到点啦，该喝水了。", "device_id": cid}).status_code == 200
    t.join(10)
    assert "event: push" in got, got
    url = next(l for l in got if l.startswith("data:")).split('"url":"')[1].split('"')[0]
    assert _bare(s, "GET", url).content[:4] == b"RIFF"

    # 令牌等同 API_TOKEN：看家页要用的监控接口能用；不带就 401
    assert _bare(s, "GET", "/api/monitor/state?device_id=cores3").status_code == 401
    assert _bare(s, "GET", "/api/monitor/state?device_id=cores3", token).status_code == 200
    assert _bare(s, "POST", "/role", token, json={"device_id": cid, "role": "", "greet": False}).status_code == 200

    # 吊销后全部失效
    assert s.request("DELETE", f"/api/admin/clients/{cid}").status_code == 200
    assert _bare(s, "GET", "/client/me", token).status_code == 401
    assert _bare(s, "GET", "/api/monitor/state?device_id=cores3", token).status_code == 401


def test_admin_pairing_is_local_only(token_server):
    # 跨站网页不能替你发令牌
    r = _bare(token_server, "POST", "/api/admin/clients", json={"name": "x"},
              headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403


def test_text_only_chat(token_server):
    s = token_server
    s.fake_reset()
    cid, token = _pair(s, "打字")
    s.fake_llm("收到，周六去爬山。")
    r = _bare(s, "POST", "/chat-vision", token, json={"text": "帮我记一下周六去爬山"}, headers={"X-Device-Id": cid}, timeout=30)
    assert r.status_code == 200, r.text
    assert r.content[:4] == b"RIFF"
    last = _bare(s, "GET", "/chat/last", headers={"X-Device-Id": cid}).json()
    assert last["user"] == "帮我记一下周六去爬山" and "爬山" in last["reply"]
    # 三样都没有还是 400；没配对的只发文字也是 400（设备的契约不变）
    assert _bare(s, "POST", "/chat-vision", token, json={}, headers={"X-Device-Id": cid}).status_code == 400
    assert _bare(s, "POST", "/chat-vision", json={"text": "x"}, headers={"X-Device-Id": cid}).status_code == 400


@pytest.mark.skipif(os.environ.get("KAGURA_BRAIN") != "pi", reason="出口（主动说话选设备）只有内置 agent 有")
def test_away_reminder_goes_to_open_phone(srv):
    """在 CoreS3 上设的提醒，人出门了：推到开着页面的手机，不推给 CoreS3；手机页面关了就不推"""
    from conftest import Device, wav
    d = Device(srv, "home1")
    try:
        srv.post("/heartbeat", json={"device_id": "home1"})
        cid, token = _pair(srv, "出门的手机")
        srv.fake_asr("5秒后提醒我喝水")
        r = srv.post("/chat", data=wav(), headers={"X-Device-Id": "home1"})
        assert r.status_code == 200
        assert srv.post("/presence", json={"status": "away", "device_id": "home1"}).status_code == 200

        got = []
        with requests.get(srv.base + f"/client/events?ct={token}", stream=True, timeout=20) as ev:
            for line in ev.iter_lines(decode_unicode=True):
                got.append(line)
                if line.startswith("data:") and "push-audio" in line:
                    break
        assert "event: push" in got
        assert not [m for m in d.push if m.get("type") == "push"], "人不在家，不该推给 CoreS3"

        # 手机页面关着：再来一条提醒，谁都不推
        srv.fake_asr("5秒后提醒我关窗")
        assert srv.post("/chat", data=wav(), headers={"X-Device-Id": "home1"}).status_code == 200
        srv.post("/presence", json={"status": "away", "device_id": "home1"})
        deadline = time.time() + 12
        while time.time() < deadline and "主人不在家，也没有开着的手机页面" not in srv.log():
            time.sleep(0.5)
        assert "主人不在家，也没有开着的手机页面" in srv.log()
        assert not [m for m in d.push if m.get("type") == "push"]
    finally:
        d.close()


def test_admin_sets_cores3_volume(srv):
    """管理界面调 CoreS3 音量：MQTT 下发 volume 命令（0.1~1.0），设备表显示心跳里的音量；试听用当前角色说一句"""
    from conftest import Device
    d = Device(srv, "vol1")
    try:
        assert srv.post("/heartbeat", json={"device_id": "vol1", "vol": 0.6}).status_code == 200
        row = next(x for x in srv.get("/api/admin/devices").json() if x["id"] == "vol1")
        assert row["vol"] == 60
        assert srv.post("/api/admin/devices/vol1/volume", json={"level": 5}).status_code == 400
        r = srv.post("/api/admin/devices/vol1/volume", json={"level": 85, "test": True})
        assert r.status_code == 200, r.text
        assert d.wait("cmd", lambda m: m.get("action") == "volume")["level"] == 0.85
        assert d.wait("push")["type"] == "push"                  # 试听
        row = next(x for x in srv.get("/api/admin/devices").json() if x["id"] == "vol1")
        assert row["vol"] == 85                                  # 下一次心跳之前先显示调成的值
    finally:
        d.close()
