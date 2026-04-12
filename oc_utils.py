"""
共享工具函数，供 voice_assistant.py 和 voice_server.py 共同使用。
"""

import json
import re


def _extract_json(raw):
    """
    从混有 ANSI 日志的 stdout 中提取完整的顶层 JSON 对象。
    用括号计数法定位，避免被嵌套 { 干扰。
    """
    clean = re.sub(r"\x1b\[[0-9;]*m", "", raw)  # 去除所有 ANSI 转义
    depth = 0
    start = None
    for i, ch in enumerate(clean):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                return json.loads(clean[start: i + 1])
    raise ValueError(f"未找到完整 JSON 对象: {raw[:200]}")


def strip_markdown(text):
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
