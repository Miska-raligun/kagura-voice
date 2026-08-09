"""每日定时拍照调度：增删改、当天去重、错过窗口保护。"""

import datetime
import json

import pytest

import photo_schedules as ps


def _ts(y, mo, d, h, mi):
    return datetime.datetime(y, mo, d, h, mi).timestamp()


@pytest.fixture(autouse=True)
def clean_store(tmp_path, monkeypatch):
    """每个测试独立的空存储 + 空内存队列，避免串测和写脏工作区。"""
    monkeypatch.setattr(ps, "STORE_PATH", tmp_path / "photo_schedules.json")
    monkeypatch.setattr(ps, "_items", [])
    monkeypatch.setattr(ps, "_run_fn", None)
    yield


# ── 时间归一化 ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,want", [
    ("08:00", "08:00"), ("8:05", "08:05"), (" 23:59 ", "23:59"), ("0:00", "00:00"),
])
def test_normalize_time_ok(raw, want):
    assert ps.normalize_time(raw) == want


# 分钟必须两位："8:5" 到底是 8:05 还是 8:50 有歧义，宁可报错让用户重填
@pytest.mark.parametrize("raw", ["24:00", "08:60", "8点", "", "0800", None, "-1:00", "9:5"])
def test_normalize_time_reject(raw):
    assert ps.normalize_time(raw) is None


# ── 增删改 ───────────────────────────────────────────────────────────────────

def test_add_normalizes_and_persists():
    item = ps.add("9:05", device_id="cores3", prompt=" 看看猫在干嘛 ")
    assert item["time"] == "09:05"
    assert item["prompt"] == "看看猫在干嘛"
    assert item["enabled"] is True
    saved = json.loads(ps.STORE_PATH.read_text())
    assert [s["id"] for s in saved] == [item["id"]]


def test_add_rejects_bad_time():
    with pytest.raises(ValueError):
        ps.add("25:00")


def test_add_respects_max(monkeypatch):
    monkeypatch.setattr(ps, "MAX_SCHEDULES", 2)
    ps.add("08:00")
    ps.add("09:00")
    with pytest.raises(ValueError):
        ps.add("10:00")


def test_list_sorted_by_time():
    ps.add("22:00")
    ps.add("07:30")
    assert [s["time"] for s in ps.list_all()] == ["07:30", "22:00"]


def test_update_and_remove():
    sid = ps.add("08:00")["id"]
    assert ps.update(sid, enabled=False, prompt="换个问法")["enabled"] is False
    assert ps.get(sid)["prompt"] == "换个问法"
    assert ps.remove(sid) is True
    assert ps.remove(sid) is False
    assert ps.list_all() == []


def test_update_bad_time_raises():
    sid = ps.add("08:00")["id"]
    with pytest.raises(ValueError):
        ps.update(sid, time="99:99")
    assert ps.get(sid)["time"] == "08:00"


def test_update_time_clears_last_fired():
    """改了时间就该按新时间在当天再触发一次，不能被旧的 last_fired 挡住。"""
    sid = ps.add("08:00")["id"]
    ps.update(sid, enabled=True)
    ps.set_last_result(sid, {"ok": True})
    ps.update(sid, time="20:00")
    assert ps.get(sid)["last_fired"] is None


def test_unknown_id_is_none():
    assert ps.get("nope") is None
    assert ps.update("nope", enabled=False) is None


# ── 触发逻辑 ─────────────────────────────────────────────────────────────────

def _capture_runs(monkeypatch):
    runs = []
    monkeypatch.setattr(ps, "_run_fn", lambda item: runs.append(item["id"]) or {"ok": True})
    return runs


def _arm():
    """清掉 add() 写下的 last_fired，让计划在测试指定的时刻可以触发。"""
    for it in ps._items:
        it["last_fired"] = None


def test_fires_at_time(monkeypatch):
    runs = _capture_runs(monkeypatch)
    sid = ps.add("08:00")["id"]
    _arm()
    assert ps.fire_due(_ts(2026, 8, 9, 8, 0) + 30) == 1
    assert runs == [sid]


def test_not_before_time(monkeypatch):
    runs = _capture_runs(monkeypatch)
    ps.add("08:00")
    _arm()
    assert ps.fire_due(_ts(2026, 8, 9, 7, 59)) == 0
    assert runs == []


def test_only_once_per_day(monkeypatch):
    runs = _capture_runs(monkeypatch)
    ps.add("08:00")
    _arm()
    ps.fire_due(_ts(2026, 8, 9, 8, 0))
    ps.fire_due(_ts(2026, 8, 9, 8, 5))
    ps.fire_due(_ts(2026, 8, 9, 23, 0))
    assert len(runs) == 1
    # 换一天可以再触发
    ps.fire_due(_ts(2026, 8, 10, 8, 1))
    assert len(runs) == 2


def test_missed_window_marks_but_skips(monkeypatch):
    """半夜重启服务端，不该把白天错过的计划全补拍一遍。"""
    runs = _capture_runs(monkeypatch)
    ps.add("08:00")
    _arm()
    assert ps.fire_due(_ts(2026, 8, 9, 23, 30)) == 0
    assert runs == []
    assert ps._items[0]["last_fired"] == "2026-08-09"


def test_within_miss_window_still_fires(monkeypatch):
    runs = _capture_runs(monkeypatch)
    ps.add("08:00")
    _arm()
    assert ps.fire_due(_ts(2026, 8, 9, 8, 10)) == 1
    assert len(runs) == 1


def test_disabled_never_fires(monkeypatch):
    runs = _capture_runs(monkeypatch)
    sid = ps.add("08:00")["id"]
    ps.update(sid, enabled=False)
    _arm()
    assert ps.fire_due(_ts(2026, 8, 9, 8, 1)) == 0
    assert runs == []


def test_add_after_time_does_not_fire_immediately(monkeypatch):
    """9 点建一条 8 点的计划，不该当场拍一张。"""
    runs = _capture_runs(monkeypatch)
    now = _ts(2026, 8, 9, 9, 0)
    monkeypatch.setattr(ps.time, "time", lambda: now)
    ps.add("08:00")
    assert ps.fire_due(now) == 0
    assert runs == []


def test_run_fn_exception_recorded(monkeypatch):
    def _boom(item):
        raise RuntimeError("设备离线")
    monkeypatch.setattr(ps, "_run_fn", _boom)
    sid = ps.add("08:00")["id"]
    _arm()
    ps.fire_due(_ts(2026, 8, 9, 8, 1))
    last = ps.get(sid)["last_result"]
    assert last["ok"] is False and "设备离线" in last["error"]


def test_run_now_ignores_last_fired(monkeypatch):
    """试跑不看当天是否已触发，也不该改 last_fired。"""
    runs = _capture_runs(monkeypatch)
    sid = ps.add("08:00")["id"]      # add 时今天已记为触发过
    before = ps.get(sid)["last_fired"]
    ps.run_now(sid)
    assert runs == [sid]
    assert ps.get(sid)["last_fired"] == before


def test_run_now_unknown_id():
    assert ps.run_now("nope") is None


# ── 持久化 ───────────────────────────────────────────────────────────────────

def test_load_drops_corrupt_entries(monkeypatch):
    ps.STORE_PATH.write_text(json.dumps([
        {"id": "good", "time": "7:00", "device_id": "cores3"},
        {"id": "bad", "time": "99:99"},
        "not-a-dict",
    ]), encoding="utf-8")
    ps._load()
    items = ps.list_all()
    assert [i["id"] for i in items] == ["good"]
    assert items[0]["time"] == "07:00"
    assert items[0]["enabled"] is True


def test_load_survives_broken_json():
    ps.STORE_PATH.write_text("{ not json", encoding="utf-8")
    ps._load()
    assert ps.list_all() == []
