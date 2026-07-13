import voice_server
from voice_server import ServerState


def test_session_stable_per_device():
    st = ServerState()
    a = st.get_session("dev-a")
    assert st.get_session("dev-a") == a
    assert st.get_session("dev-b") != a


def test_session_lru_eviction():
    st = ServerState(max_sessions=2)
    first = st.get_session("d1")
    st.get_session("d2")
    st.get_session("d3")          # 挤掉 d1
    assert "d1" not in st.sessions
    assert st.get_session("d1") != first   # 重新分配新 session


def test_rate_limit_per_device():
    st = ServerState(rate_max=3)
    assert all(st.check_rate("dev") for _ in range(3))
    assert not st.check_rate("dev")
    assert st.check_rate("other-dev")      # 不同设备独立计数


def test_rate_limit_window_rollover(monkeypatch):
    st = ServerState(rate_max=1, rate_window=60)
    now = [1000.0]
    monkeypatch.setattr(voice_server.time, "time", lambda: now[0])
    assert st.check_rate("dev")
    assert not st.check_rate("dev")
    now[0] += 61                            # 窗口滚动后重新放行
    assert st.check_rate("dev")


def test_rate_buckets_independent():
    st = ServerState(rate_max=1)
    assert st.check_rate("dev", bucket="chat")
    assert st.check_rate("dev", bucket="upload", limit=5)   # 不同桶不互相占额
    assert not st.check_rate("dev", bucket="chat")


def test_rate_limit_override():
    st = ServerState(rate_max=1)
    assert st.check_rate("dev", bucket="upload", limit=2)
    assert st.check_rate("dev", bucket="upload", limit=2)
    assert not st.check_rate("dev", bucket="upload", limit=2)
