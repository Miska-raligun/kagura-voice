"""
共享工具函数，供 voice_assistant.py 和 voice_server.py 共同使用。
"""

from __future__ import annotations

import json
import re
from typing import Any


def _extract_json(raw: str) -> dict[str, Any]:
    """
    从混有 ANSI 日志的 stdout 中提取第一个完整的顶层 JSON 对象。
    用 raw_decode 而非括号计数：字符串值里出现不成对的 {} 也不会解析错位。
    """
    clean = re.sub(r"\x1b\[[0-9;]*m", "", raw)  # 去除所有 ANSI 转义
    decoder = json.JSONDecoder()
    idx = clean.find("{")
    while idx != -1:
        try:
            obj, _end = decoder.raw_decode(clean, idx)
            if isinstance(obj, dict):
                return obj
        except ValueError:
            pass
        idx = clean.find("{", idx + 1)
    raise ValueError(f"未找到完整 JSON 对象: {raw[:200]}")


def strip_markdown(text: str) -> str:
    """去除常见 Markdown 标记，避免 TTS 读出符号。"""
    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"`[^`]+`", "", text)
    text = re.sub(r"#{1,6}\s+", "", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"~~(.+?)~~", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n{2,}", "\n", text)
    return text.strip()
