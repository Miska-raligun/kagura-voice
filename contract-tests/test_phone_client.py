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
