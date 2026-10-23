"""每日定时拍照调度器：到点让设备拍一张 → 识别 → 播报。

与 reminders.py 的区别：提醒是一次性的绝对时间戳，这里是「每天 HH:MM」重复，
所以用 last_fired 记日期做当天去重；并设 MISS_WINDOW，避免服务端在计划时间
之后才启动时，把当天已经错过的计划一股脑补拍一遍。

实际的拍照/识别/播报由注入的 run_fn(schedule) 完成，本模块只管调度与持久化，
不碰 Flask / MQTT / OpenClaw。
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

STORE_PATH = Path(os.environ.get("KAGURA_DATA_DIR") or Path(__file__).parent) / "photo_schedules.json"
CHECK_INTERVAL = 20      # 扫描间隔（秒）；HH:MM 精度下足够
MISS_WINDOW = 900        # 迟到超过 15 分钟不再补拍，只标记当天已处理
MAX_SCHEDULES = 20       # 上限，防止网页误操作堆出几百条

_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")

_lock = threading.RLock()
_items: list[dict] = []
_run_fn: Optional[Callable[[dict], dict]] = None


# ── 持久化 ────────────────────────────────────────────────────────────────────

def _save() -> None:
    """调用方需持有 _lock。"""
    try:
        STORE_PATH.write_text(json.dumps(_items, ensure_ascii=False, indent=2))
    except OSError as e:
        print(f"[snapshot] 持久化失败: {e}")


def _load() -> None:
    global _items
    try:
        if not STORE_PATH.exists():
            return
        raw = json.loads(STORE_PATH.read_text())
        if not isinstance(raw, list):
            raise ValueError("photo_schedules.json 顶层应为列表")
        items = []
        for it in raw:
            if isinstance(it, dict) and normalize_time(it.get("time", "")):
                it.setdefault("id", uuid.uuid4().hex[:8])
                it["time"] = normalize_time(it["time"])
                it.setdefault("device_id", "cores3")
                it.setdefault("prompt", "")
                it.setdefault("enabled", True)
                items.append(it)
        _items = items
        _items.sort(key=lambda x: x["time"])
        print(f"[snapshot] 恢复 {len(_items)} 条定时拍照计划")
    except (OSError, ValueError) as e:
        print(f"[snapshot] 加载失败: {e}")
        _items = []


# ── 时间工具 ──────────────────────────────────────────────────────────────────

def normalize_time(raw: str) -> Optional[str]:
    """把 "8:5" / "08:05" 归一为 "08:05"；非法返回 None。"""
    m = _TIME_RE.match(str(raw or "").strip())
    if not m:
        return None
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def _today_target(hhmm: str, now: float) -> float:
    """now 所在这一天的 hhmm 对应的时间戳（服务端本地时区）。"""
    lt = time.localtime(now)
    h, m = int(hhmm[:2]), int(hhmm[3:5])
    return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, h, m, 0, 0, 0, -1))


# ── 增删改查 ──────────────────────────────────────────────────────────────────

def add(hhmm: str, device_id: str = "cores3", prompt: str = "",
        enabled: bool = True) -> dict:
    """新增一条每日计划。时间非法或超出上限抛 ValueError。"""
    norm = normalize_time(hhmm)
    if norm is None:
        raise ValueError(f"时间格式应为 HH:MM（00:00–23:59），收到 {hhmm!r}")
    now = time.time()
    item = {
        "id": uuid.uuid4().hex[:8],
        "time": norm,
        "device_id": device_id or "cores3",
        "prompt": (prompt or "").strip(),
        "enabled": bool(enabled),
        # 今天的点已经过了就直接记为已触发，避免"刚建好就立刻拍一张"
        "last_fired": time.strftime("%Y-%m-%d", time.localtime(now))
                      if now >= _today_target(norm, now) else None,
        "last_result": None,
    }
    with _lock:
        if len(_items) >= MAX_SCHEDULES:
            raise ValueError(f"定时计划最多 {MAX_SCHEDULES} 条")
        _items.append(item)
        _items.sort(key=lambda x: x["time"])
        _save()
    print(f"[snapshot] 已添加每日 {norm} 拍照计划 → {item['device_id']}")
    return dict(item)


def remove(sid: str) -> bool:
    with _lock:
        for i, it in enumerate(_items):
            if it["id"] == sid:
                del _items[i]
                _save()
                print(f"[snapshot] 已删除计划 {sid}")
                return True
    return False


def update(sid: str, **fields) -> Optional[dict]:
    """更新 time / device_id / prompt / enabled，返回更新后的条目。"""
    with _lock:
        for it in _items:
            if it["id"] != sid:
                continue
            if "time" in fields:
                norm = normalize_time(fields["time"])
                if norm is None:
                    raise ValueError(f"时间格式应为 HH:MM，收到 {fields['time']!r}")
                if norm != it["time"]:
                    it["time"] = norm
                    it["last_fired"] = None   # 改了时间，当天可以按新时间再触发
            if "device_id" in fields and fields["device_id"]:
                it["device_id"] = str(fields["device_id"])
            if "prompt" in fields:
                it["prompt"] = str(fields["prompt"] or "").strip()
            if "enabled" in fields:
                it["enabled"] = bool(fields["enabled"])
            _items.sort(key=lambda x: x["time"])
            _save()
            return dict(it)
    return None


def get(sid: str) -> Optional[dict]:
    with _lock:
        for it in _items:
            if it["id"] == sid:
                return dict(it)
    return None


def list_all() -> list[dict]:
    with _lock:
        return [dict(it) for it in _items]


def set_last_result(sid: str, result: dict) -> None:
    with _lock:
        for it in _items:
            if it["id"] == sid:
                it["last_result"] = result
                _save()
                return


# ── 调度 ──────────────────────────────────────────────────────────────────────

def _fire_one(item: dict) -> dict:
    """执行一条计划（阻塞：拍照 + OpenClaw 识别可能要几十秒）。"""
    print(f"[snapshot] ⏰ 触发定时拍照 {item['time']} → {item['device_id']}")
    result: dict = {"ok": False, "error": "run_fn 未注入"}
    if _run_fn is not None:
        try:
            result = _run_fn(item) or {}
        except Exception as e:
            result = {"ok": False, "error": str(e)}
            print(f"[snapshot] ⚠️ 执行异常: {e}")
    result.setdefault("ts", time.time())
    set_last_result(item["id"], result)
    return result


def run_now(sid: str) -> Optional[dict]:
    """网页「立即试跑」：执行但不动 last_fired，当天的正常触发照旧。"""
    item = get(sid)
    if item is None:
        return None
    return _fire_one(item)


def fire_due(now: Optional[float] = None) -> int:
    """触发所有到点的计划，返回实际执行条数。"""
    now = time.time() if now is None else now
    today = time.strftime("%Y-%m-%d", time.localtime(now))
    to_run: list[dict] = []
    with _lock:
        changed = False
        for it in _items:
            if not it.get("enabled", True) or it.get("last_fired") == today:
                continue
            target = _today_target(it["time"], now)
            if now < target:
                continue
            it["last_fired"] = today          # 先记账：执行失败也不在当天反复重试
            changed = True
            if now - target <= MISS_WINDOW:
                to_run.append(dict(it))
            else:
                late = int((now - target) / 60)
                print(f"[snapshot] ⏭  跳过已错过的计划 {it['time']}（迟 {late} 分钟）")
        if changed:
            _save()

    for it in to_run:
        _fire_one(it)
    return len(to_run)


def _loop() -> None:
    while True:
        time.sleep(CHECK_INTERVAL)
        try:
            fire_due()
        except Exception as e:
            print(f"[snapshot] 调度异常: {e}")


def init(run_fn: Callable[[dict], dict]) -> None:
    """注入执行函数，加载持久化数据，启动调度线程。"""
    global _run_fn
    _run_fn = run_fn
    _load()
    threading.Thread(target=_loop, daemon=True, name="photo-schedule").start()
