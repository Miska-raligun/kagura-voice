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


# ── 音量控制 ─────────────────────────────────────────────────────────────────

_VOL_UP   = re.compile(r"(大声|声音大|音量.{0,2}(大|高)|调高音量)")
_VOL_DOWN = re.compile(r"(小声|声音小|音量.{0,2}(小|低)|调低音量)")


def match_volume(text: str) -> tuple[str, str] | None:
    """命中返回 ("up"/"down", 确认回复)；设备端根据响应头调整扬声器音量。"""
    if not text:
        return None
    if _VOL_DOWN.search(text):
        return ("down", "好的，音量调小了。")
    if _VOL_UP.search(text):
        return ("up", "好的，音量调大了。")
    return None


# ── 定时提醒解析 ─────────────────────────────────────────────────────────────

_CN_DIGIT = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
             "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def _cn2int(s: str) -> int | None:
    """中文数字 → int，支持 1~99（十/两位组合）与阿拉伯数字。"""
    if s.isdigit():
        return int(s)
    if s == "十":
        return 10
    if "十" in s:
        head, _, tail = s.partition("十")
        tens = _CN_DIGIT.get(head, 1) if head else 1
        ones = _CN_DIGIT.get(tail, 0) if tail else 0
        return tens * 10 + ones
    if s in _CN_DIGIT:
        return _CN_DIGIT[s]
    return None

_NUM = r"[0-9]+|[一二两三四五六七八九十]+"
_TRIGGER = r"(?:提醒我|提醒一下|叫我|喊我)"

# 相对时间："三分钟后提醒我关火"、"半小时后叫我"、"过10秒提醒我"
_REL_RE = re.compile(
    rf"(?:过)?(半|{_NUM})\s*(秒钟?|分钟|个?小时|个?钟头)(半)?之?[后後]?\s*{_TRIGGER}(.*)"
)
# 绝对时间："明天早上八点叫我起床"、"下午3点半提醒我开会"
_ABS_RE = re.compile(
    rf"(明天)?(凌晨|早上|上午|中午|下午|晚上)?({_NUM})点(半|(?:{_NUM})分?)?\s*{_TRIGGER}(.*)"
)


def _clean_task(raw: str) -> str:
    return raw.strip().strip("，。,.!！?？ ") or ""


def match_reminder(text: str, local_time: str = "") -> tuple[float, str, str] | None:
    """
    解析定时提醒请求。命中返回 (触发时间戳, 提醒内容, 确认回复)；None 表示未命中。
    时间基准优先用设备 X-Local-Time（RTC 与服务端同步，时区一致）。
    """
    if not text:
        return None
    now = _parse_local_time(local_time)

    m = _REL_RE.search(text)
    if m:
        num_s, unit, extra_half, task_raw = m.group(1), m.group(2), m.group(3), m.group(4)
        if num_s == "半":
            seconds = 1800 if "时" in unit or "钟头" in unit else 30
        else:
            n = _cn2int(num_s)
            if n is None or n <= 0:
                return None
            if "秒" in unit:
                seconds = n
            elif "分" in unit:
                seconds = n * 60
            else:
                seconds = n * 3600
                if extra_half:          # "一小时半"
                    seconds += 1800
        if seconds < 5:
            return None
        task = _clean_task(task_raw)
        fire = now + datetime.timedelta(seconds=seconds)
        if seconds < 60:
            when = f"{seconds}秒"
        elif seconds < 3600:
            when = f"{seconds // 60}分钟"
        else:
            when = f"{seconds / 3600:g}小时"
        reply = f"好的，{when}后提醒你{task}。" if task else f"好的，{when}后提醒你。"
        return (fire.timestamp(), task, reply)

    m = _ABS_RE.search(text)
    if m:
        tomorrow, period, hour_s, minute_s, task_raw = (
            m.group(1), m.group(2), m.group(3), m.group(4), m.group(5))
        hour = _cn2int(hour_s)
        if hour is None or not 0 <= hour <= 23:
            return None
        minute = 0
        if minute_s == "半":
            minute = 30
        elif minute_s:
            minute = _cn2int(minute_s.rstrip("分")) or 0
        if not 0 <= minute <= 59:
            return None
        if period in ("下午", "晚上") and hour < 12:
            hour += 12
        if period == "中午" and hour < 11:
            hour += 12
        fire = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if tomorrow:
            fire += datetime.timedelta(days=1)
        elif fire <= now:
            fire += datetime.timedelta(days=1)   # 已过的时刻顺延到明天
        task = _clean_task(task_raw)
        day_str = "明天" if fire.date() != now.date() else ""
        reply = (f"好的，{day_str}{fire.hour}点{fire.minute:02d}分提醒你{task}。"
                 if task else f"好的，{day_str}{fire.hour}点{fire.minute:02d}分提醒你。")
        return (fire.timestamp(), task, reply)

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


# ── 免手模式（连续对话 / 声控唤醒）专用 ────────────────────────────────────────

_PUNCT_RE = re.compile(r"[\s，。！？、,.!?~～…]+")
_FILLER = set("嗯啊哦呃额唉哎噢喔哈呀诶欸嘿喂唔")
_EXIT_SHORT = ("不聊了", "先这样", "再见", "拜拜", "没事了", "退下吧", "退下", "停", "别说了", "就这样")
_EXIT_RE = re.compile(r"(退出|结束|关闭|停止|关掉)(连续)?(对话|聊天|模式)")


def is_filler(text: str) -> bool:
    """「嗯」「啊」「哦哦」这类：免手模式下多半是环境声被认成了字，不值得问 LLM。"""
    t = _PUNCT_RE.sub("", text or "")
    return not t or len(t) <= 1 or all(c in _FILLER for c in t)


def match_cont_exit(text: str) -> bool:
    """「退出连续对话」「不聊了」「拜拜」→ 结束免手模式。

    短句才认「再见/不聊了」——长句里带一句「先这样」不等于要走。
    """
    t = _PUNCT_RE.sub("", text or "")
    if _EXIT_RE.search(t):
        return True
    return len(t) <= 6 and any(k in t for k in _EXIT_SHORT)
