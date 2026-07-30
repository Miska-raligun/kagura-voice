"""定时提醒：解析（quick_commands.match_reminder）与调度（reminders.fire_due）。"""

import datetime

import pytest

import quick_commands
import reminders


LT = "2026-05-15 14:23"
BASE = datetime.datetime(2026, 5, 15, 14, 23).timestamp()


# ── 解析：相对时间 ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("text,delta,task", [
    ("三分钟后提醒我关火", 180, "关火"),
    ("3分钟后提醒我关火", 180, "关火"),
    ("过10秒提醒我", 10, ""),
    ("半小时后叫我", 1800, ""),
    ("一小时后提醒我开会", 3600, "开会"),
    ("两个小时后提醒我吃药", 7200, "吃药"),
    ("十五分钟后提醒一下泡面好了", 900, "泡面好了"),
])
def test_relative_reminder(text, delta, task):
    fire_ts, parsed_task, reply = quick_commands.match_reminder(text, local_time=LT)
    assert fire_ts == pytest.approx(BASE + delta)
    assert parsed_task == task
    assert reply.startswith("好的")


# ── 解析：绝对时间 ───────────────────────────────────────────────────────────

def _abs_ts(day, hour, minute):
    return datetime.datetime(2026, 5, day, hour, minute).timestamp()


@pytest.mark.parametrize("text,day,hour,minute,task", [
    ("下午3点半提醒我开会", 15, 15, 30, "开会"),
    ("晚上八点提醒我追剧", 15, 20, 0, "追剧"),
    ("明天早上八点叫我起床", 16, 8, 0, "起床"),
    ("早上8点叫我", 16, 8, 0, ""),          # 已过时刻 → 顺延明天
    ("下午2点50分提醒我", 15, 14, 50, ""),
])
def test_absolute_reminder(text, day, hour, minute, task):
    fire_ts, parsed_task, _reply = quick_commands.match_reminder(text, local_time=LT)
    assert fire_ts == pytest.approx(_abs_ts(day, hour, minute))
    assert parsed_task == task


@pytest.mark.parametrize("text", [
    "现在几点", "提醒我一下下", "帮我拍张照片", "音量大一点", "",
])
def test_reminder_misses(text):
    assert quick_commands.match_reminder(text, local_time=LT) is None


# ── 音量指令 ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text,direction", [
    ("小声一点", "down"), ("声音小一点", "down"), ("音量调小", "down"),
    ("大声一点", "up"), ("声音大一点", "up"), ("音量调大", "up"),
])
def test_volume_match(text, direction):
    d, reply = quick_commands.match_volume(text)
    assert d == direction and reply.startswith("好的")


def test_volume_miss():
    assert quick_commands.match_volume("今天天气怎么样") is None


# ── 调度器 ───────────────────────────────────────────────────────────────────

@pytest.fixture()
def rem(tmp_path, monkeypatch):
    monkeypatch.setattr(reminders, "STORE_PATH", tmp_path / "reminders.json")
    monkeypatch.setattr(reminders, "_items", [])
    sent = []
    monkeypatch.setattr(reminders, "_send_fn", lambda text, dev: sent.append((text, dev)) or True)
    return sent


def test_fire_due_sends_and_removes(rem):
    reminders.schedule(1000.0, "关火", "cores3")
    reminders.schedule(2000.0, "开会", "cores3")
    assert reminders.fire_due(1500.0) == 1
    assert rem == [("叮咚，提醒时间到：关火", "cores3")]
    assert reminders.pending_count() == 1        # 未到期的保留


def test_fire_due_nothing_due(rem):
    reminders.schedule(9999.0, "x", "d")
    assert reminders.fire_due(100.0) == 0
    assert rem == []


def test_fire_failure_retries_then_drops(rem, monkeypatch):
    monkeypatch.setattr(reminders, "_send_fn", lambda t, d: False)
    reminders.schedule(1000.0, "任务", "d")
    now = 1000.0
    for attempt in range(reminders.MAX_ATTEMPTS):
        assert reminders.fire_due(now) == 0
        now += reminders.RETRY_DELAY + 1
    assert reminders.pending_count() == 0        # 重试超限后丢弃


def test_persistence_roundtrip(rem, tmp_path):
    reminders.schedule(1234.0, "持久化", "d1")
    reminders._items.clear()
    reminders._load()
    assert reminders.pending_count() == 1
    assert reminders._items[0]["task"] == "持久化"
