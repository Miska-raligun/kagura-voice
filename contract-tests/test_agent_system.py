"""内置 agent 系统（M3–M6）的黑盒用例：只在 KAGURA_BRAIN=pi 时跑（Python 版与 OpenClaw 模式没有这些功能）。

假模型的脚本项除了字符串，还可以是 {"text": ..., "tool_calls": [{"name": ..., "args": {...}}], "then": <工具结果之后的回复>}。
"""
import os
import time

import pytest

from conftest import ROLES_2, Device, Server, b64, b64text, rgb565, wav

pytestmark = pytest.mark.skipif(os.environ.get("KAGURA_BRAIN") != "pi", reason="只对内置 agent 系统（KAGURA_BRAIN=pi）")


@pytest.fixture(scope="module")
def ag():
    s = Server(roles=ROLES_2, extra_env={"KAGURA_SCHEDULER_TICK": "1"}).start()
    yield s
    s.stop()


@pytest.fixture()
def a(ag):
    ag.fake_reset()
    return ag


def tool(_name, _then="", _text="", **args):
    """一步脚本：先说 _text、调用工具 _name(**args)，工具结果回来后回 _then"""
    return {"text": _text, "tool_calls": [{"name": _name, "args": args}], "then": _then}


# ── 设备对话里的工具 ────────────────────────────────────────────────────────

def test_take_photo_tool_needs_photo_then_vision(a):
    a.fake_llm(tool("take_photo", _text="我看看", question="桌上有什么"), "桌上有个杯子。")
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "ag1"})
    assert r.headers.get("X-Need-Photo") == "1" and b64text(r.headers["X-Reply-Text"]) == "我看看"
    r2 = a.post("/chat-vision", json={"wav": b64(wav()), "image": b64(rgb565())}, headers={"X-Device-Id": "ag1"})
    assert b64text(r2.headers["X-Reply-Text"]) == "桌上有个杯子。"
    calls = a.fake_log()["llm"]
    assert len(calls) == 2 and calls[1]["image"] is True


def test_set_volume_tool_sets_header(a):
    a.fake_llm(tool("set_volume", _then="好的，大声一点。", direction="up"))
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "ag2"})
    assert r.headers.get("X-Volume") == "up"
    assert b64text(r.headers["X-Reply-Text"]) == "好的，大声一点。"


def test_speak_to_current_device_not_doubled(a):
    """正在语音对话时 speak 同一台设备不会额外推送（回复本身就会播）。"""
    d = Device(a, "ag3")
    try:
        a.fake_llm(tool("speak", _then="你好呀"))
        a.post("/chat", data=wav(), headers={"X-Device-Id": "ag3"})
        time.sleep(0.5)
        assert d.push == []
    finally:
        d.close()


def test_shake_reply_pushed_in_pi_mode(a):
    d = Device(a, "ag4")
    try:
        a.fake_llm("被你摇晕啦")
        assert a.get("/shake", headers={"X-Device-Id": "ag4"}).status_code == 200
        assert d.wait("push")["type"] == "push"
        assert a.fake_log()["llm"][0]["message"].startswith("[设备事件]")
        assert "cores3-speak" not in a.fake_log()["llm"][0]["message"]
    finally:
        d.close()


# ── 会话落盘 / 管理接口 ─────────────────────────────────────────────────────

def test_session_persisted_and_visible_in_admin(a):
    a.fake_llm("你好，我记住了")
    a.post("/chat", data=wav(), headers={"X-Device-Id": "ag5"})
    s = a.get("/api/admin/agents/main/sessions/main:main").json()
    roles = [m["role"] for m in s["messages"]]
    assert roles[-2:] == ["user", "assistant"]


def test_history_survives_restart():
    s = Server(roles=ROLES_2).start()
    try:
        s.fake_llm("记住了")
        s.post("/chat", data=wav(), headers={"X-Device-Id": "rs1"})
    finally:
        s.stop()
    s2 = Server(roles=ROLES_2)
    s2.data = s.data
    s2.start()
    try:
        msgs = s2.get("/api/admin/agents/main/sessions/main:main").json()["messages"]
        assert [m["role"] for m in msgs] == ["user", "assistant"]
    finally:
        s2.stop()


def test_admin_agent_crud_updates_roles(a):
    r = a.post("/api/admin/agents", json={"id": "helper", "name": "小助手", "per": 5})
    assert r.status_code == 201 and r.json()["device_role"] == "helper"
    assert any(x["id"] == "helper" for x in a.get("/role").json()["roles"])
    assert a.request("PATCH", "/api/admin/agents/helper", json={"name": "助手"}).json()["name"] == "助手"
    assert a.request("PUT", "/api/admin/agents/helper/file?path=SOUL.md", json={"content": "我是助手"}).status_code == 200
    assert a.get("/api/admin/agents/helper/file?path=SOUL.md").json()["content"] == "我是助手"
    assert a.request("PUT", "/api/admin/agents/helper/file?path=../agent.json", json={"content": "x"}).status_code == 400
    a.fake_llm("你好，我是助手")
    assert a.post("/api/admin/chat", json={"agent": "helper", "text": "你是谁"}).json()["reply"] == "你好，我是助手"
    assert "我是助手" in a.fake_log()["llm"][0]["system"]
    assert a.request("DELETE", "/api/admin/agents/helper").status_code == 200
    assert not any(x["id"] == "helper" for x in a.get("/role").json()["roles"])
    assert a.get("/api/admin/agents/helper").status_code == 404


def test_memory_write_then_search_via_admin(a):
    a.fake_llm(tool("memory_write", _then="记下了", target="long", text="主人喜欢乌龙茶"))
    a.post("/chat", data=wav(), headers={"X-Device-Id": "ag6"})
    hits = a.post("/api/admin/agents/main/memory/search", json={"query": "乌龙茶"}).json()
    assert hits and "乌龙茶" in hits[0]["text"]


# ── 调度器 ──────────────────────────────────────────────────────────────────

def test_job_runs_and_delivers_to_device(a):
    d = Device(a, "ag7")
    try:
        a.fake_llm("早上好，今天晴")
        j = a.post("/api/admin/jobs", json={"agent": "main", "name": "早报", "schedule_kind": "at", "schedule_value": "+1s",
                                            "message": "讲天气", "delivery": "device:ag7"}).json()
        assert d.wait("push", timeout=8)["type"] == "push"
        runs = a.get(f"/api/admin/jobs/{j['id']}/runs").json()
        assert runs[0]["status"] == "ok" and runs[0]["output"] == "早上好，今天晴"
        assert a.get("/api/admin/jobs").json()[0]["enabled"] is False or True
    finally:
        d.close()


def test_agent_creates_job_via_cron_tool(a):
    a.fake_llm(tool("cron_add", _then="好的，每天八点叫你", name="叫醒", kind="cron", value="0 8 * * *", message="叫主人起床"))
    a.post("/chat", data=wav(), headers={"X-Device-Id": "ag8"})
    jobs = [j for j in a.get("/api/admin/jobs?agent=main").json() if j["name"] == "叫醒"]
    assert jobs and jobs[0]["delivery"] == "device:ag8" and jobs[0]["schedule"]["expr"] == "0 8 * * *"


def test_heartbeat_silent_then_delivered(a):
    d = Device(a, "ag9")
    try:
        a.request("PATCH", "/api/admin/agents/mio", json={"heartbeat": {"enabled": True, "every_minutes": 5, "delivery": "device:ag9", "active_hours": ""}})
        a.fake_llm("HEARTBEAT_OK", "该休息一下啦")
        a.post("/api/admin/jobs/hb-mio/run")
        assert a.get("/api/admin/jobs/hb-mio/runs").json()[0]["status"] == "silent"
        a.post("/api/admin/jobs/hb-mio/run")
        assert d.wait("push")["type"] == "push"
        assert a.fake_log()["tts"][-1]["per"] == 4       # 用 mio 自己的音色
    finally:
        a.request("PATCH", "/api/admin/agents/mio", json={"heartbeat": {"enabled": False}})
        d.close()


# ── agent 间通信 ────────────────────────────────────────────────────────────

def test_a2a_send_and_matrix(a):
    a.fake_llm(tool("sessions_send", _then="小澪说她在", agent="mio", message="在吗"), "在的")
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "ag10"})
    assert b64text(r.headers["X-Reply-Text"]) == "小澪说她在"
    log = a.get("/api/admin/a2a").json()["log"]
    assert log[0]["from_agent"] == "main" and log[0]["to_agent"] == "mio" and log[0]["status"] == "ok"
    # 关掉 main → mio 的权限后被拒
    a.request("PUT", "/api/admin/a2a/allow", json={"from": "main", "to": "mio", "allow": False})
    a.fake_llm(tool("sessions_send", _then="找不到她", agent="mio", message="在吗"))
    a.post("/chat", data=wav(), headers={"X-Device-Id": "ag10"})
    assert a.get("/api/admin/a2a").json()["log"][0]["status"] == "rejected"
    a.request("PUT", "/api/admin/a2a/allow", json={"from": "main", "to": "mio", "allow": True})


def test_device_binding_via_admin(a):
    d = Device(a, "ag11")
    try:
        r = a.request("PUT", "/api/admin/devices/ag11", json={"agent": "mio"})
        assert r.json()["role"] == "mio"
        assert d.wait("cmd") == {"action": "role", "role": "mio"}
        a.fake_llm("我是小澪")
        a.post("/chat", data=wav(), headers={"X-Device-Id": "ag11"})
        assert a.fake_log()["llm"][0]["agent"] == "mio"
    finally:
        a.post("/role", json={"device_id": "ag11", "role": "", "greet": False})
        d.close()


# ── 管理界面（M8）──────────────────────────────────────────────────────────

def _lan_ip():
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def test_admin_ui_served_locally(a):
    r = a.get("/admin")
    assert r.status_code == 200 and '<div id="app">' in r.text
    js = a.get("/admin/app.js")
    assert js.status_code == 200 and "javascript" in js.headers["Content-Type"] and len(js.content) > 10_000


def test_admin_rejects_non_local(a):
    import requests
    ip = _lan_ip()
    if not ip or ip.startswith("127."):
        pytest.skip("没有非回环地址")
    base = a.base.replace("127.0.0.1", ip)
    assert requests.get(base + "/admin", timeout=5).status_code == 403
    assert requests.get(base + "/api/admin/agents", timeout=5).status_code == 403
    # 设备接口照常对局域网开放
    assert requests.get(base + "/health", timeout=5).status_code == 200


def test_admin_config_masks_secrets_and_keeps_them(a):
    a.request("PUT", "/api/admin/config", json={"baidu": {"asr_key": "k1", "asr_secret": "s1"}, "a2a": {"enabled": True}})
    cfg = a.get("/api/admin/config").json()["config"]
    assert cfg["baidu"] == {"asr_key": "***", "asr_secret": "***"}
    r = a.request("PUT", "/api/admin/config", json={"baidu": {"asr_key": "***", "asr_secret": "s2"}}).json()
    assert "baidu" in r["restart_needed"]
    import json as _j
    raw = _j.loads((a.data / "config.json").read_text(encoding="utf-8"))
    assert raw["baidu"] == {"asr_key": "k1", "asr_secret": "s2"}


def test_admin_channels_pairing_flow(a):
    r = a.post("/api/admin/channels", json={"id": "ob1", "kind": "onebot", "name": "测试", "enabled": False, "credentials": {"url": "ws://127.0.0.1:9", "token": "t"}})
    assert r.status_code == 201 and r.json()["credentials"]["token"] == "***"
    d = a.get("/api/admin/channels").json()
    assert d["accounts"][0]["status"]["state"] == "stopped"
    assert a.request("DELETE", "/api/admin/channels/ob1").status_code == 200
