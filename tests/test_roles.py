"""角色切换 + 免手模式（连续对话/声控唤醒）的服务端行为。"""

import pytest

import quick_commands
import roles

_ROLES = [
    {"id": "", "name": "神乐", "agent": "main", "per": 111, "aliases": ["kagura"]},
    {"id": "mio", "name": "小澪", "agent": "mio", "per": 4, "aliases": ["小玲"]},
]


@pytest.fixture()
def two_roles(tmp_path):
    state = tmp_path / "roles_state.json"
    roles.init(_ROLES, state_file=state)
    yield state
    roles.init(None, state_file=state)


# ── 语音指令匹配 ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text,want", [
    ("切换到小澪", "mio"),
    ("换成小澪吧。", "mio"),
    ("叫小澪出来", "mio"),
    ("我想和小玲说话", "mio"),          # 别名：百度常把「澪」认成「玲」
    ("换回神乐", ""),
    ("换个话题吧", None),               # 没有角色名
    ("让神乐唱首歌", None),             # 「让」只认「让 XX 来」
    ("小澪今天好可爱", None),           # 没有切换意图
])
def test_match_switch(two_roles, text, want):
    r = roles.match_switch(text)
    assert (r["id"] if r else None) == want


def test_single_role_never_switches():
    roles.init(None)
    assert roles.match_switch("切换到神乐") is None
    assert roles.match_list("有哪些角色") is None


def test_bad_role_id_rejected(tmp_path):
    with pytest.raises(ValueError):
        roles.init([{"id": "小澪", "name": "x"}], state_file=tmp_path / "s.json")
    roles.init(None, state_file=tmp_path / "s.json")


def test_role_persists_across_restart(two_roles):
    roles.set_role("d1", "mio")
    roles.init(_ROLES, state_file=two_roles)          # 模拟服务端重启
    assert roles.get("d1")["id"] == "mio"
    assert roles.session_key("d1", roles.get("d1")) == "d1~mio"
    assert roles.session_key("d1", roles.default()) == "d1"   # 默认角色沿用老会话


# ── /chat 里的角色切换 ─────────────────────────────────────────────────────────

def test_chat_switch_role_end_to_end(client, vs, fake_wav, two_roles, monkeypatch):
    texts = iter(["切换到小澪", "你好呀"])
    monkeypatch.setattr(vs, "transcribe", lambda p: next(texts))
    voices, agents = [], []
    monkeypatch.setattr(vs, "synthesize", lambda t, per=111: voices.append(per) or str(fake_wav))

    def _chat(text, sid, agent=None, **k):
        agents.append((agent, sid))
        return "嗨"
    monkeypatch.setattr(vs, "chat", _chat)

    r1 = client.post("/chat", data=b"x", headers={"X-Device-Id": "d1"})
    assert r1.headers["X-Role"] == "mio"
    assert voices == [4], "切换的那句回复就要用新角色的音色"
    assert agents == [], "切换是短路指令，不该问 LLM"

    r2 = client.post("/chat", data=b"x", headers={"X-Device-Id": "d1"})
    assert r2.headers["X-Role"] == "mio"
    assert agents[0][0] == "mio"
    assert agents[0][1] == vs.state.get_session("d1~mio"), "新角色要用自己的会话"
    assert agents[0][1] != vs.state.get_session("d1")


def test_role_api(client, vs, two_roles):
    r = client.get("/role?device_id=d2").get_json()
    assert r["role"] == "" and [x["id"] for x in r["roles"]] == ["", "mio"]
    assert client.post("/role", json={"device_id": "d2", "role": "nope"}).status_code == 400
    assert client.post("/role", json={"device_id": "d2", "role": "mio"}).get_json()["name"] == "小澪"
    assert client.get("/role?device_id=d2").get_json()["role"] == "mio"


# ── 免手模式：语气词当没听清、口头退出 ─────────────────────────────────────────

def test_filler_and_exit_matchers():
    assert quick_commands.is_filler("嗯。") and quick_commands.is_filler("哦哦")
    assert not quick_commands.is_filler("嗯，几点了")
    assert quick_commands.match_cont_exit("不聊了")
    assert quick_commands.match_cont_exit("退出连续对话")
    assert not quick_commands.match_cont_exit("我们先这样安排明天的行程然后再说别的")


@pytest.mark.parametrize("mode,empty", [("continuous", True), ("single", False)])
def test_filler_only_filtered_in_hands_free(client, vs, fake_wav, monkeypatch, mode, empty):
    monkeypatch.setattr(vs, "transcribe", lambda p: "嗯")
    called = []
    monkeypatch.setattr(vs, "chat", lambda *a, **k: called.append(1) or "嗯？")
    r = client.post("/chat", data=b"x", headers={"X-Device-Id": "d3", "X-Mode": mode})
    assert (r.headers.get("X-Asr-Empty") == "1") is empty
    assert bool(called) is (not empty)


@pytest.mark.parametrize("mode,exits", [("continuous", True), ("wake", True), ("single", False)])
def test_voice_exit(client, vs, fake_wav, monkeypatch, mode, exits):
    monkeypatch.setattr(vs, "transcribe", lambda p: "不聊了")
    monkeypatch.setattr(vs, "chat", lambda *a, **k: "好吧")
    r = client.post("/chat", data=b"x", headers={"X-Device-Id": "d4", "X-Mode": mode})
    assert (r.headers.get("X-Cont-Exit") == "1") is exits


# ── 非语音的切换入口：设备顶栏 ROLE 键、网页下拉 ─────────────────────────────────

def test_role_cycle_from_device(client, vs, fake_wav, two_roles, monkeypatch):
    voices = []
    monkeypatch.setattr(vs, "synthesize", lambda t, per=111: voices.append((t, per)) or str(fake_wav))
    r = client.post("/role/cycle", headers={"X-Device-Id": "d5"})
    assert r.status_code == 200 and r.mimetype == "audio/wav"
    assert r.headers["X-Role"] == "mio" and voices[-1] == (roles.greeting(roles.find("mio")), 4)
    r = client.post("/role/cycle", headers={"X-Device-Id": "d5"})
    assert r.headers["X-Role"] == "", "转到头回到第一个"


def test_role_api_notifies_device_then_greets(client, vs, fake_wav, two_roles, mqtt):
    client.post("/role", json={"device_id": "d6", "role": "mio"})
    topics = [(t, p.get("action") or p.get("type")) for t, p, _ in mqtt.published]
    assert topics == [("kagura/cmd/d6", "role"), ("kagura/push/d6", "push")], \
        "先发换图命令再推问候，问候播出时才是新图"
    client.post("/role", json={"device_id": "d6", "role": "", "greet": False})
    assert len(mqtt.published) == 3


def test_monitor_state_lists_roles(client, vs, two_roles):
    roles.set_role("d7", "mio")
    st = client.get("/api/monitor/state?device_id=d7").get_json()
    assert st["role"] == "mio" and [r["name"] for r in st["roles"]] == ["神乐", "小澪"]
