"""定时提醒调度器：到点通过 MQTT push 播报（复用 voice_server 的推送链路）。

- schedule() 入队并持久化到 reminders.json，服务端重启不丢
- 后台线程每秒检查到期项，调用注入的 send_fn(text, device_id)
- 发送失败（如 MQTT 暂时不可用）60 秒后重试，最多 3 次
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Callable, Optional

STORE_PATH = Path(os.environ.get("KAGURA_DATA_DIR") or Path(__file__).parent) / "reminders.json"
MAX_ATTEMPTS = 3
RETRY_DELAY = 60

_lock = threading.Lock()
_items: list[dict] = []
_send_fn: Optional[Callable[[str, str], bool]] = None


def _save() -> None:
    try:
        STORE_PATH.write_text(json.dumps(_items, ensure_ascii=False))
    except OSError as e:
        print(f"[reminder] 持久化失败: {e}")


def _load() -> None:
    global _items
    try:
        if STORE_PATH.exists():
            _items = json.loads(STORE_PATH.read_text())
            print(f"[reminder] 恢复 {len(_items)} 条未触发提醒")
    except (OSError, ValueError) as e:
        print(f"[reminder] 加载失败: {e}")
        _items = []


def schedule(fire_ts: float, task: str, device_id: str) -> None:
    """入队一条提醒并落盘。"""
    with _lock:
        _items.append({"ts": fire_ts, "task": task,
                       "device_id": device_id, "attempts": 0})
        _items.sort(key=lambda it: it["ts"])
        _save()
    when = time.strftime("%H:%M:%S", time.localtime(fire_ts))
    print(f"[reminder] 已安排 {when} → {device_id}: {task or '(无内容)'}")


def pending_count() -> int:
    with _lock:
        return len(_items)


def fire_due(now: float) -> int:
    """触发所有到期提醒，返回成功发送条数。失败项退避重试，超限丢弃。"""
    with _lock:
        due = [it for it in _items if it["ts"] <= now]
        if not due:
            return 0
        for it in due:
            _items.remove(it)

    sent = 0
    requeue = []
    for it in due:
        task = it["task"]
        text = f"叮咚，提醒时间到：{task}" if task else "叮咚，你设置的提醒时间到了。"
        ok = False
        if _send_fn is not None:
            try:
                ok = _send_fn(text, it["device_id"])
            except Exception as e:
                print(f"[reminder] 发送异常: {e}")
        if ok:
            sent += 1
            print(f"[reminder] ✅ 已播报 → {it['device_id']}: {task or '(无内容)'}")
        else:
            it["attempts"] += 1
            if it["attempts"] < MAX_ATTEMPTS:
                it["ts"] = now + RETRY_DELAY
                requeue.append(it)
                print(f"[reminder] ⚠️ 发送失败，{RETRY_DELAY}s 后重试 ({it['attempts']}/{MAX_ATTEMPTS})")
            else:
                print(f"[reminder] ❌ 重试超限，丢弃: {task}")

    with _lock:
        _items.extend(requeue)
        _items.sort(key=lambda it: it["ts"])
        _save()
    return sent


def _loop() -> None:
    while True:
        time.sleep(1)
        try:
            fire_due(time.time())
        except Exception as e:
            print(f"[reminder] 调度异常: {e}")


def init(send_fn: Callable[[str, str], bool]) -> None:
    """注入推送函数，加载持久化数据，启动调度线程。"""
    global _send_fn
    _send_fn = send_fn
    _load()
    threading.Thread(target=_loop, daemon=True, name="reminder-loop").start()
