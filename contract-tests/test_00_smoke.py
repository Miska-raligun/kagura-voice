"""框架自检：服务端起得来、假服务商可控、模拟设备收得到 push。"""
from conftest import wav


def test_health(srv):
    assert srv.get("/health").json()["status"] == "ok"


def test_fake_control(srv):
    srv.fake_asr("讲个笑话")
    srv.fake_llm("从前有座山。")
    r = srv.post("/chat", data=wav(), headers={"X-Device-Id": "smoke"})
    assert r.status_code == 200
    log = srv.fake_log()
    assert log["asr"] == 1 and log["llm"][0]["message"].endswith("讲个笑话")
    assert log["tts"][-1]["text"] == "从前有座山。"


def test_device_receives_push(srv, device):
    r = srv.post("/push", json={"text": "开饭啦", "device_id": device.id})
    assert r.status_code == 200
    msg = device.wait("push")
    assert msg["type"] == "push" and msg["url"].startswith("/push-audio/")
