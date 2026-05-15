"""快捷指令：把高频简单查询（时间/日期/星期）短路掉，不走 OpenClaw 与 LLM。

用法：
    from quick_commands import match
    reply = match(text, local_time=header_value)
    if reply is None:
        # 走原有 OpenClaw 流程
"""

from __future__ import annotations

import datetime
import re

_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]


def _parse_local_time(local_time: str) -> datetime.datetime:
    """解析设备 X-Local-Time header (YYYY-MM-DD HH:MM[:SS])；失败回退服务器本地时间。"""
    if local_time:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                return datetime.datetime.strptime(local_time, fmt)
            except ValueError:
                continue
    return datetime.datetime.now()


def _say_time(dt: datetime.datetime) -> str:
    h, m = dt.hour, dt.minute
    if h < 5:
        period = "凌晨"
    elif h < 12:
        period = "上午"
    elif h < 14:
        period = "中午"
    elif h < 18:
        period = "下午"
    else:
        period = "晚上"
    hour12 = h if h <= 12 else h - 12
    if m == 0:
        return f"现在是{period}{hour12}点整。"
    return f"现在是{period}{hour12}点{m}分。"


def _say_date(dt: datetime.datetime) -> str:
    return f"今天是{dt.year}年{dt.month}月{dt.day}日。"


def _say_weekday(dt: datetime.datetime) -> str:
    return f"今天是星期{_WEEKDAYS[dt.weekday()]}。"


# 规则注册：(正则, 处理函数)。先匹配先返回；想加新指令直接 append。
_RULES: list[tuple[re.Pattern[str], "callable"]] = [
    (re.compile(r"(现在|当前).{0,3}(几点|时间)"), _say_time),
    (re.compile(r"几点了"), _say_time),
    (re.compile(r"报时"), _say_time),
    (re.compile(r"今天.{0,4}(几号|日期)"), _say_date),
    (re.compile(r"今天.{0,4}星期"), _say_weekday),
    (re.compile(r"星期几"), _say_weekday),
    (re.compile(r"周几"), _say_weekday),
]


def match(text: str, local_time: str = "") -> str | None:
    """命中返回快捷回复文本；None 表示应走 OpenClaw。"""
    if not text:
        return None
    dt = _parse_local_time(local_time)
    for pattern, handler in _RULES:
        if pattern.search(text):
            return handler(dt)
    return None


if __name__ == "__main__":
    # 手动验证
    samples = [
        "现在几点", "现在几点了", "几点了", "请问几点了",
        "今天几号", "今天日期是多少", "今天星期几", "今天周几",
        "你好吗", "明天天气怎么样",   # 这两个应返回 None
    ]
    for s in samples:
        r = match(s, local_time="2026-05-15 14:23")
        print(f"{s!r:30s} → {r!r}")
