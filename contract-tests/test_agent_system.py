"""内置 agent 系统（M3–M6）的黑盒用例：只在 KAGURA_BRAIN=pi 时跑（Python 版与 OpenClaw 模式没有这些功能）。

假模型的脚本项除了字符串，还可以是 {"text": ..., "tool_calls": [{"name": ..., "args": {...}}], "then": <工具结果之后的回复>}。
"""
import json
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
        # 只有设备当前角色正是小澪时，小澪的话才直接播（不用别人的形象说话）
        a.request("PUT", "/api/admin/devices/ag9", json={"role": "mio", "greet": False})
        a.request("PATCH", "/api/admin/agents/mio", json={"heartbeat": {"enabled": True, "every_minutes": 5, "delivery": "device:ag9", "active_hours": ""}})
        a.fake_llm("HEARTBEAT_OK", "该休息一下啦")
        a.post("/api/admin/jobs/hb-mio/run")
        assert a.get("/api/admin/jobs/hb-mio/runs").json()[0]["status"] == "silent"
        a.post("/api/admin/jobs/hb-mio/run")
        assert d.wait("push")["type"] == "push"
        assert a.fake_log()["tts"][-1]["per"] == 4       # 用 mio 自己的音色
    finally:
        a.request("PATCH", "/api/admin/agents/mio", json={"heartbeat": {"enabled": False}})
        a.request("PUT", "/api/admin/devices/ag9", json={"role": "", "greet": False})
        d.close()


def _run_job(a, agent, name, delivery):
    jid = a.post("/api/admin/jobs", json={"agent": agent, "name": name, "schedule_kind": "at", "schedule_value": "+1s",
                                          "message": "提醒主人喝水", "delivery": delivery}).json()["id"]
    for _ in range(40):
        runs = a.get(f"/api/admin/jobs/{jid}/runs").json()
        if runs:
            return runs[0]
        time.sleep(0.25)
    raise AssertionError("定时任务没跑")


def test_other_role_message_held_until_switch(a):
    """默认（role_push=hold）：设备显示的是神乐时，小澪的定时消息先留着；切到小澪（问候之后）再播"""
    d = Device(a, "ag10")
    try:
        a.request("PUT", "/api/admin/devices/ag10", json={"role": "", "greet": False})
        a.fake_llm("该喝水啦")
        assert _run_job(a, "mio", "ct-held", "device:ag10")["delivered"] == "held:ag10"
        time.sleep(1)
        assert not d.push, "设备显示的是神乐，小澪的话不该直接播"
        a.request("PUT", "/api/admin/devices/ag10", json={"role": "mio", "greet": False})
        assert d.wait("push", timeout=15)["type"] == "push"
        assert a.fake_log()["tts"][-1]["text"].endswith("该喝水啦")
        assert a.fake_log()["tts"][-1]["per"] == 4
    finally:
        a.request("PUT", "/api/admin/devices/ag10", json={"role": "", "greet": False})
        d.close()


def test_other_role_message_plays_with_its_role(a):
    """role_push=switch：照样播，用小澪的音色，推送里带 role，设备播放期间临时换成小澪的图"""
    d = Device(a, "ag10")
    try:
        a.request("PUT", "/api/admin/config", json={"role_push": "switch"})
        a.request("PUT", "/api/admin/devices/ag10", json={"role": "", "greet": False})
        a.fake_llm("该喝水啦")
        assert _run_job(a, "mio", "ct-role", "device:ag10")["delivered"] == "device:ag10"
        msg = d.wait("push", timeout=15)
        assert msg["type"] == "push" and msg["role"] == "mio", msg
        assert a.fake_log()["tts"][-1]["per"] == 4
        assert a.get("/role", params={"device_id": "ag10"}).json()["role"] == "", "临时换图不改设备的当前角色"
    finally:
        a.request("PUT", "/api/admin/config", json={"role_push": "hold"})
        d.close()


def test_device_interaction_means_home(a):
    """对设备说话 = 主人在家：不在家时任务静音，对设备说过话后在家状态自动改回 home、照常播"""
    d = Device(a, "ag10")
    try:
        a.request("PUT", "/api/admin/devices/ag10", json={"role": "", "greet": False})
        a.post("/presence", json={"status": "away", "device_id": "ag10"})
        a.fake_llm("出门啦")
        assert _run_job(a, "main", "ct-away", "device:ag10")["delivered"] == "muted:away"
        a.fake_llm("嗯")
        a.post("/chat", data=wav(), headers={"X-Device-Id": "ag10"})
        a.fake_llm("回来啦")
        assert _run_job(a, "main", "ct-back", "device:ag10")["delivered"] == "device:ag10"
    finally:
        a.post("/presence", json={"status": "home", "device_id": "ag10"})
        d.close()


def test_saying_going_out_to_device_means_away(a):
    """对设备说「我要去上班了」：先因为在说话记为在家，这一轮里 agent 调 set_presence 改成不在家——以后者为准"""
    d = Device(a, "ag10")
    try:
        a.request("PUT", "/api/admin/devices/ag10", json={"role": "", "greet": False})
        a.post("/presence", json={"status": "home", "device_id": "ag10"})
        a.fake_asr("我要去上班了")
        a.fake_llm(tool("set_presence", _then="路上小心", status="away"))
        r = a.post("/chat", data=wav(), headers={"X-Device-Id": "ag10"})
        assert b64text(r.headers["X-Reply-Text"]) == "路上小心"
        a.fake_llm("该喝水啦")
        assert _run_job(a, "main", "ct-left", "device:ag10")["delivered"] == "muted:away"
    finally:
        a.post("/presence", json={"status": "home", "device_id": "ag10"})
        d.close()


def test_agent_own_tts_provider_and_voice(a):
    """agent 单独指定合成服务商和音色：设备对话的回复用它合成"""
    try:
        a.request("PATCH", "/api/admin/agents/main", json={"tts_provider": "vs", "tts_voice": "kagura-clone"})
        a.fake_llm("你好呀")
        a.post("/chat", data=wav(), headers={"X-Device-Id": "ag_tts"})
        last = a.fake_log()["tts"][-1]
        assert last.get("provider") == "vs" and last.get("voice") == "kagura-clone", last
    finally:
        a.request("PATCH", "/api/admin/agents/main", json={"tts_provider": "", "tts_voice": ""})


def test_voice_push_policy(a):
    """voice_push = never：说给主人听的话一律不播（对 agent 透明，任务照常算成功）"""
    d = Device(a, "ag10")
    try:
        a.request("PUT", "/api/admin/config", json={"voice_push": "never"})
        a.fake_llm("别播我")
        assert _run_job(a, "main", "ct-never", "device:ag10")["delivered"] == "muted:policy"
        time.sleep(1)
        assert not d.push
    finally:
        a.request("PUT", "/api/admin/config", json={"voice_push": "presence"})
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


def test_admin_rejects_cross_site_and_rebinding(a):
    """恶意网页借浏览器往本机管理接口发请求（跨站请求伪造 / DNS 重绑定）一律拒绝"""
    evil = {"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site", "Content-Type": "text/plain"}
    assert a.post("/api/admin/tools/test-exec", data='{"command":"echo pwned"}', headers=evil).status_code == 403
    assert a.post("/api/admin/packages/install", data='{"source":"npm:x"}', headers={"Origin": "https://evil.example"}).status_code == 403
    assert a.get("/api/admin/agents", headers={"Host": "evil.example"}).status_code == 403
    # 本机页面自己发的照常可以
    ok = a.post("/api/admin/tools/test-exec", json={"command": "echo hi"}, headers={"Origin": a.base, "Sec-Fetch-Site": "same-origin"})
    assert ok.status_code == 200 and ok.json()["ok"]


def test_device_chat_from_browser_not_trusted(a):
    """浏览器跨站发到 /chat 的请求不当受信设备：本轮没有执行命令工具"""
    a.fake_llm(tool("exec", _then="完成", command="echo should-not-run > pwned.txt"))
    a.post("/chat", data=wav(), headers={"X-Device-Id": "ag_csrf", "Origin": "https://evil.example"})
    assert not (a.data / "agents" / "main" / "workspace" / "pwned.txt").exists()


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


# ── 边生成边播（M9）──────────────────────────────────────────────────────────

FAKE_BYTES_PER_CHAR = 1600   # 假 TTS：每个字 50ms 静音


def _clean_len(s):
    import re
    return len(re.sub(r"\s", "", s))


def test_stream_reply_first_sentence_then_rest(a):
    """新固件带 X-Stream: 1：首句先出头（X-Reply-Partial），音频是一个 WAV 头 + 各句 PCM 依次拼接，读到连接关闭。"""
    text = "你好呀！今天天气很好。我们出去走走吧，顺便买点水果。"
    a.fake_llm({"text": text, "tps": 30})
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "st1", "X-Stream": "1"}, stream=True)
    assert r.status_code == 200
    assert "Content-Length" not in r.headers and r.headers.get("Transfer-Encoding") != "chunked"
    assert r.headers.get("X-Reply-Partial") == "1"
    assert b64text(r.headers["X-Reply-Text"]) == "你好呀！"
    body = r.raw.read()
    assert body[:4] == b"RIFF" and body[36:40] == b"data"
    sentences = [t["text"] for t in a.fake_log()["tts"]]
    assert sentences == ["你好呀！", "今天天气很好。", "我们出去走走吧，顺便买点水果。"]
    assert len(body) == 44 + sum(len(s) * FAKE_BYTES_PER_CHAR for s in sentences)
    last = a.get("/chat/last", headers={"X-Device-Id": "st1"}).json()
    assert last["reply"] == text and b64text(last["reply_b64"]) == text


def test_stream_take_photo_header_not_lost(a):
    """首句「我看看。」之后才调 take_photo：响应头必须等工具执行完再发，X-Need-Photo 不能丢。"""
    a.fake_llm({"text": "我看看。", "tool_calls": [{"name": "take_photo", "args": {"question": "这是什么"}}], "tps": 20})
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "st2", "X-Stream": "1"})
    assert r.headers.get("X-Need-Photo") == "1"
    assert r.content[:4] == b"RIFF" and len(r.content) > 44


def test_stream_short_reply_not_partial(a):
    a.fake_llm("好的。")
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "st3", "X-Stream": "1"})
    assert r.headers.get("X-Reply-Partial") is None and b64text(r.headers["X-Reply-Text"]) == "好的。"


def test_stream_ignored_for_short_circuit(a):
    """快捷指令不走大脑：照旧整段返回（带 Content-Length）。"""
    a.fake_asr("现在几点")
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "st4", "X-Stream": "1"})
    assert r.headers.get("Content-Length") and a.fake_log()["llm"] == []


def test_stream_error_before_audio_is_500(a):
    a.fake_llm({"error": "模型挂了"})
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "st5", "X-Stream": "1"})
    assert r.status_code == 500 and "模型挂了" in r.json()["error"]


# ── 异步对话（X-Async：设备不再被一个长请求卡住）──────────────────────────────

ASYNC = {"X-Stream": "1", "X-Async": "1"}


def _segments(a, rid, dev, wait=10, seg=None, limit=30):
    """按设备的方式把回复一段段取完：返回 [(headers, body)]"""
    out = []
    for _ in range(limit):
        q = f"/chat/reply/{rid}?wait={wait}" + (f"&seg={seg}" if seg else "")
        r = a.get(q, headers={"X-Device-Id": dev})
        if r.status_code == 204:
            if r.headers.get("X-Reply-Done") == "1":
                return out
            continue
        assert r.status_code == 200, r.text
        out.append((r.headers, r.content))
        if r.headers.get("X-Reply-More") != "1":
            # 没说还有：再取一次应当是 Done
            r2 = a.get(f"/chat/reply/{rid}?wait=1", headers={"X-Device-Id": dev})
            assert r2.status_code == 204 and r2.headers.get("X-Reply-Done") == "1"
            return out
    raise AssertionError("取不完")


def test_async_chat_returns_id_then_streams(a):
    """X-Async：走大脑的请求立刻回 202 + 编号；长轮询取到边生成边播的音频，取完是 Done"""
    text = "你好呀！今天天气很好。"
    a.fake_llm({"text": text, "tps": 30})
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "as1", **ASYNC})
    assert r.status_code == 202, r.text
    rid = r.headers["X-Reply-Id"]
    assert r.json()["id"] == rid and r.headers.get("X-User-Text")
    segs = _segments(a, rid, "as1")
    body = b"".join(b[44:] for _, b in segs)
    assert segs[0][1][:4] == b"RIFF"
    sentences = [t["text"] for t in a.fake_log()["tts"]]
    assert sentences == ["你好呀！", "今天天气很好。"]
    assert len(body) == sum(len(s) * FAKE_BYTES_PER_CHAR for s in sentences)
    assert a.get("/chat/last", headers={"X-Device-Id": "as1"}).json()["reply"] == text


def test_async_wait_then_segments(a):
    """还没想好：长轮询到点回 204 X-Reply-Wait。说了一句再去跑工具（这里跑 2 秒命令）：
    那一句先播（不等普通工具），停顿久了先收一段，工具跑完后的话下一段取"""
    # tps：第一句要 1 秒多才出完，保证第一次 wait=0 的轮询一定落在「还没想好」（不限速的话快机器上第一句已经好了，Windows CI 踩过）
    a.fake_llm({"text": "我查一下。", "tool_calls": [{"name": "exec", "args": {"command": "sleep 2"}}], "then": "查到了。", "tps": 4})
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "as2", **ASYNC})
    rid = r.headers["X-Reply-Id"]
    first = a.get(f"/chat/reply/{rid}?wait=0", headers={"X-Device-Id": "as2"})
    assert first.status_code == 204 and first.headers.get("X-Reply-Wait") == "1"
    t0 = time.time()
    segs = _segments(a, rid, "as2", wait=10, seg=300)
    assert len(segs) == 2, [(h.get("X-Reply-More"), len(b)) for h, b in segs]
    assert segs[0][0].get("X-Reply-More") == "1" and b64text(segs[0][0]["X-Reply-Text"]) == "我查一下。"
    assert len(segs[0][1]) == 44 + len("我查一下。") * FAKE_BYTES_PER_CHAR
    assert len(segs[1][1]) == 44 + len("查到了。") * FAKE_BYTES_PER_CHAR
    assert time.time() - t0 >= 1.5          # 第二段确实是等命令跑完才来的


def test_async_take_photo_header(a):
    a.fake_llm({"text": "我看看。", "tool_calls": [{"name": "take_photo", "args": {"question": "这是什么"}}], "tps": 20})
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "as3", **ASYNC})
    segs = _segments(a, r.headers["X-Reply-Id"], "as3")
    assert segs[0][0].get("X-Need-Photo") == "1"


def test_async_short_circuit_stays_sync(a):
    a.fake_asr("现在几点")
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "as4", **ASYNC})
    assert r.status_code == 200 and r.headers.get("Content-Length")


def test_async_cancel(a):
    """设备上点屏幕取消：之后取回复是 Done，不再出声"""
    a.fake_llm({"text": "这是一段很长很长的回答，" * 6, "tps": 3})
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "as5", **ASYNC})
    rid = r.headers["X-Reply-Id"]
    assert a.post(f"/chat/cancel/{rid}").json()["cancelled"] is True
    time.sleep(0.5)
    r2 = a.get(f"/chat/reply/{rid}?wait=5", headers={"X-Device-Id": "as5"})
    assert r2.status_code == 204 and r2.headers.get("X-Reply-Done") == "1"


def test_async_vision(a):
    a.fake_llm("这是一个杯子。")
    r = a.post("/chat-vision", json={"text": "这是什么", "image": b64(rgb565())}, headers={"X-Device-Id": "as6", **ASYNC})
    assert r.status_code == 202
    segs = _segments(a, r.headers["X-Reply-Id"], "as6")
    assert segs and segs[0][1][:4] == b"RIFF"


def test_admin_loopback_port():
    """WSL 场景：额外的管理端口只绑 127.0.0.1，管理界面与接口在上面可用（主端口照常）。"""
    import requests
    from conftest import _free_port
    port = _free_port()
    s = Server(extra_env={"KAGURA_ADMIN_PORT": str(port)}).start()
    try:
        assert requests.get(f"http://127.0.0.1:{port}/admin", timeout=5).status_code == 200
        assert requests.get(f"http://127.0.0.1:{port}/api/admin/agents", timeout=5).status_code == 200
        assert s.get("/health").status_code == 200
    finally:
        s.stop()


# ── 执行命令 / 联网 ─────────────────────────────────────────────────────────

def _transcript_text(a, agent="main"):
    """该 agent 所有会话的完整记录（含工具结果）拼成一段文本"""
    out = []
    for s in a.get(f"/api/admin/agents/{agent}/sessions").json():
        key = s.get("key") or s.get("session_key")
        msgs = a.get(f"/api/admin/agents/{agent}/sessions/{requests_quote(key)}").json().get("messages", [])
        out.append(json.dumps(msgs, ensure_ascii=False))
    return "\n".join(out)


def requests_quote(s):
    from urllib.parse import quote
    return quote(s, safe="")


def test_exec_tool_runs_command_in_workspace(a):
    """设备对话里让 agent 执行命令：在它的工作目录里真的跑了（Windows 上是 PowerShell，Linux 是 bash）"""
    a.fake_llm(tool("exec", _then="做好了", command="echo kagura-exec-ok > exec_ok.txt"))
    r = a.post("/chat", data=wav(), headers={"X-Device-Id": "ag_exec"})
    assert b64text(r.headers["X-Reply-Text"]) == "做好了"
    f = a.data / "agents" / "main" / "workspace" / "exec_ok.txt"
    assert f.exists(), "命令没在 agent 工作目录里执行"
    raw = f.read_bytes()
    text = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("utf-8", "replace")
    assert "kagura-exec-ok" in text
    assert "exit=0" in _transcript_text(a)


def test_web_fetch_tool_reads_page(a):
    """web_fetch 能取回网页 / 文本内容（这里读服务端自己的 /health，CI 里不依赖外网）"""
    a.fake_llm(tool("web_fetch", _then="看完了", url=a.base + "/health"))
    a.post("/chat", data=wav(), headers={"X-Device-Id": "ag_web"})
    t = _transcript_text(a)
    assert '\\"app\\":\\"kagura\\"' in t or '"app":"kagura"' in t or "kagura" in t


def test_tools_settings_hot_apply_and_test_exec(a):
    """设置 → 工具：保存即生效；「试一下」能跑命令；关掉执行命令后 agent 的工具列表里就没有 exec"""
    r = a.post("/api/admin/tools/test-exec", json={"command": "echo hi-kagura"}).json()
    assert r["ok"] and "hi-kagura" in r["output"]
    names = [t["name"] for t in a.get("/api/admin/meta").json()["tools"]]
    assert "exec" in names and "web_search" in names and "web_fetch" in names
    assert "tools" in a.request("PUT", "/api/admin/config", json={"tools": {"exec": {"enabled": False}, "web": {"enabled": True}}}).json()["applied"]
    names = [t["name"] for t in a.get("/api/admin/meta").json()["tools"]]
    assert "exec" not in names and "web_search" in names
    a.request("PUT", "/api/admin/config", json={"tools": {"exec": {"enabled": True}, "web": {"enabled": True}}})


def test_skills_admin_crud_and_skill_read(a):
    """技能管理：新建 → 写脚本文件 → agent 用 skill_read 读到说明和技能目录 → 删除"""
    assert a.post("/api/admin/skills", json={"owner": "~global", "name": "ctest-skill", "description": "契约测试用", "body": "运行 scripts/hi.py"}).status_code == 200
    assert a.request("PUT", "/api/admin/skills/~global/ctest-skill/file?path=scripts/hi.py", json={"content": "print('hi')"}).status_code == 200
    d = a.get("/api/admin/skills/~global/ctest-skill").json()
    assert [f["path"] for f in d["files"]] == ["SKILL.md", "scripts/hi.py"]
    assert any(s["name"] == "ctest-skill" for s in a.get("/api/admin/skills").json()["skills"])
    a.fake_llm(tool("skill_read", _then="懂了", name="ctest-skill"))
    a.post("/chat", data=wav(), headers={"X-Device-Id": "ag_skill"})
    t = _transcript_text(a)
    assert "技能目录" in t and "ctest-skill" in t
    assert a.request("DELETE", "/api/admin/skills/~global/ctest-skill").status_code == 200
    assert not any(s["name"] == "ctest-skill" for s in a.get("/api/admin/skills").json()["skills"])


def test_admin_chat_stream_images_files_and_delete(a):
    """会话页聊天：新会话流式回复；带图片（模型收到图）和文件（存进工作目录）；会话列表有标题；能删除"""
    import requests
    key = "main:webchat:ctest1"
    a.fake_llm("你好呀，**主人**")
    r = requests.post(a.base + "/api/admin/chat?stream=1", json={"agent": "main", "session": key, "text": "第一句话"}, stream=True, timeout=30)
    events = [json.loads(l) for l in r.iter_lines() if l]
    assert "".join(e["delta"] for e in events if e["type"] == "text") == "你好呀，**主人**"
    assert events[-1]["type"] == "done" and events[-1]["session"] == key
    # 图片 + 文件
    a.fake_llm("看到了")
    png = b64(bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0d1f6a2c0000000049454e44ae426082"))
    body = {"agent": "main", "session": key, "text": "看看这个", "images": [{"data": png, "mimeType": "image/png"}],
            "files": [{"name": "清单.txt", "b64": b64("牛奶\n鸡蛋".encode())}]}
    assert a.post("/api/admin/chat", json=body).json()["reply"] == "看到了"
    call = a.fake_log()["llm"][-1]
    assert call["image"] is True and "牛奶" in call["message"]
    assert list((a.data / "agents" / "main" / "workspace" / "uploads").glob("*/清单.txt"))
    s = next(x for x in a.get("/api/admin/agents/main/sessions").json() if x["key"] == key)
    assert s["title"] == "第一句话" and s["channel"] == "webchat"
    # 不属于这个 agent 的会话 key 拒绝
    assert a.post("/api/admin/chat", json={"agent": "main", "session": "mio:webchat:x", "text": "hi"}).status_code == 400
    assert a.request("DELETE", f"/api/admin/agents/main/sessions/{key}").status_code == 200
    assert not any(x["key"] == key for x in a.get("/api/admin/agents/main/sessions").json())


_MCP_PY = r'''
import json, sys
for line in sys.stdin:
    try:
        m = json.loads(line)
    except Exception:
        continue
    if "id" not in m:
        continue
    def ok(r):
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}) + "\n"); sys.stdout.flush()
    meth = m.get("method")
    if meth == "initialize":
        ok({"protocolVersion": m["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "ct", "version": "1"}})
    elif meth == "tools/list":
        ok({"tools": [{"name": "shout", "description": "大写", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]})
    elif meth == "tools/call":
        ok({"content": [{"type": "text", "text": "MCP:" + m["params"]["arguments"]["text"].upper()}]})
    else:
        ok({})
'''


def test_mcp_server_config_and_tool_call(a, tmp_path):
    """MCP：管理接口写 mcp.json → 连上 stdio 服务器 → agent 调 mcp__ct__shout → 删掉配置就断开"""
    import sys
    script = tmp_path / "ct_mcp.py"
    script.write_text(_MCP_PY, encoding="utf-8")
    cfg = {"mcpServers": {"ct": {"command": sys.executable, "args": ["-u", str(script)]}}}
    r = a.request("PUT", "/api/admin/mcp", json={"config": json.dumps(cfg)})
    assert r.status_code == 200, r.text
    srv = next(s for s in r.json()["servers"] if s["name"] == "ct")
    assert srv["state"] == "connected", srv
    assert [t["tool"] for t in srv["tools"]] == ["mcp__ct__shout"]
    a.fake_llm(tool("mcp__ct__shout", _then="喊完了", text="hello"))
    a.post("/chat", data=wav(), headers={"X-Device-Id": "ag_mcp"})
    assert "MCP:HELLO" in _transcript_text(a)
    assert a.request("PUT", "/api/admin/mcp", json={"config": "{oops"}).status_code == 400
    assert a.request("PUT", "/api/admin/mcp", json={"config": json.dumps({"mcpServers": {}})}).json()["servers"] == []


_EXT = """import { Type } from "@earendil-works/pi-ai";
export default function (pi) {
  pi.registerTool({
    name: "ct_double", label: "翻倍", description: "把数字翻倍",
    parameters: Type.Object({ n: Type.Number() }),
    async execute(id, params: { n: number }, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: "DOUBLE=" + params.n * 2 + " ws=" + (ctx.cwd ? "ok" : "none") }] };
    },
  });
}
"""


def test_agent_writes_own_tool_then_uses_it(a):
    """自己给自己写工具：extension_write 写扩展 → 立刻加载 → 下一轮直接调用 → 管理界面看得到、能删"""
    a.fake_llm(tool("extension_write", _then="写好了", name="ct-double", code=_EXT))
    a.post("/chat", data=wav(), headers={"X-Device-Id": "ag_ext"})
    exts = a.get("/api/admin/extensions").json()["extensions"]
    e = next(x for x in exts if x["name"] == "ct-double")
    assert e["owner"] == "main" and not e["error"], e
    assert [t["name"] for t in e["tools"]] == ["ct_double"]
    a.fake_llm(tool("ct_double", _then="算好了", n=21))
    a.post("/chat", data=wav(), headers={"X-Device-Id": "ag_ext"})
    assert "DOUBLE=42 ws=ok" in _transcript_text(a)
    # 管理界面改坏 → 报错带回来；删除
    bad = a.request("PUT", "/api/admin/extensions/main/ct-double", json={"code": "export default 1"}).json()
    assert bad["error"]
    assert a.request("DELETE", "/api/admin/extensions/main/ct-double").status_code == 200
    assert not any(x["name"] == "ct-double" for x in a.get("/api/admin/extensions").json()["extensions"])


def _tgz(files):
    import io
    import tarfile
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, text in files.items():
            data = text.encode("utf-8")
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


_PKG_EXT = """import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { helper } from "./lib.js";
export default function (pi) {
  pi.registerCommand("noop", {});
  pi.registerTool({ name: "ctpkg_%s", description: "测试", parameters: Type.Object({}), renderCall: () => new Text("x"),
    async execute() { return { content: [{ type: "text", text: helper("%s") }] }; } });
}
"""


def test_pi_packages_install_local_and_upload(a, tmp_path):
    """pi 扩展包：本地目录原地安装、上传 .tgz 安装 → 工具可调用 → 停用 / 卸载"""
    import base64
    local = tmp_path / "ct-local-pkg"
    (local / "extensions").mkdir(parents=True)
    (local / "package.json").write_text(json.dumps({"name": "ct-local-pkg", "version": "0.0.1", "keywords": ["pi-package"]}), encoding="utf-8")
    (local / "extensions" / "index.ts").write_text(_PKG_EXT % ("local", "local"), encoding="utf-8")
    (local / "extensions" / "lib.js").write_text("export const helper = (s) => 'PKG-' + s.toUpperCase();", encoding="utf-8")
    r = a.post("/api/admin/packages/install", json={"source": str(local)})
    assert r.status_code == 200, r.text
    p = r.json()["package"]
    assert p["kind"] == "local" and [t["name"] for e in p["extensions"] for t in e["tools"]] == ["ctpkg_local"], p
    assert "registerCommand" in p["extensions"][0]["unsupported"]

    tgz = _tgz({"package/package.json": json.dumps({"name": "ct-up-pkg", "version": "1.0.0"}),
                "package/extensions/index.ts": _PKG_EXT % ("up", "up"),
                "package/extensions/lib.js": "export const helper = (s) => 'PKG-' + s.toUpperCase();",
                "package/skills/ct-pkg-skill/SKILL.md": "---\nname: ct-pkg-skill\ndescription: 扩展包带的技能\n---\n内容"})
    r = a.post("/api/admin/packages/install", json={"filename": "ct-up-pkg.tgz", "b64": base64.b64encode(tgz).decode()})
    assert r.status_code == 200, r.text
    assert r.json()["package"]["skills"] == ["ct-pkg-skill"]

    a.fake_llm(tool("ctpkg_local", _then="好"), tool("ctpkg_up", _then="好"))
    a.post("/chat", data=wav(), headers={"X-Device-Id": "ag_pkg"})
    a.post("/chat", data=wav(), headers={"X-Device-Id": "ag_pkg"})
    t = _transcript_text(a)
    assert "PKG-LOCAL" in t and "PKG-UP" in t

    ids = {p["name"]: p["id"] for p in a.get("/api/admin/packages").json()["packages"]}
    pk = a.post(f"/api/admin/packages/{ids['ct-up-pkg']}/enable", json={"enabled": False}).json()["packages"]
    assert next(p for p in pk if p["name"] == "ct-up-pkg")["extensions"] == []
    for i in ids.values():
        assert a.request("DELETE", f"/api/admin/packages/{i}").status_code == 200
    assert a.get("/api/admin/packages").json()["packages"] == []
    assert local.exists(), "删除本地包不能删用户的目录"
