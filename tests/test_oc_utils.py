import pytest

from oc_utils import _extract_json, strip_markdown


def test_extract_json_with_ansi_noise():
    raw = '\x1b[32m[info]\x1b[0m starting\n{"status": "ok", "result": {"payloads": [{"text": "你好"}]}}\ntrailing log'
    data = _extract_json(raw)
    assert data["status"] == "ok"
    assert data["result"]["payloads"][0]["text"] == "你好"


def test_extract_json_nested_objects():
    raw = 'x {"a": {"b": {"c": 1}}} y'
    assert _extract_json(raw) == {"a": {"b": {"c": 1}}}


def test_extract_json_no_json_raises():
    with pytest.raises(ValueError):
        _extract_json("plain log output without json")


def test_extract_json_braces_inside_string_values():
    """LLM 回复文本里带不成对的花括号，不应导致解析错位。"""
    raw = 'log {invalid} more {"status": "ok", "text": "这里有个}括号{哈哈"} tail'
    data = _extract_json(raw)
    assert data["text"] == "这里有个}括号{哈哈"


def test_extract_json_skips_non_json_brace_noise():
    raw = "\x1b[33m{warn}\x1b[0m\n{\"a\": 1}"
    assert _extract_json(raw) == {"a": 1}


def test_strip_markdown():
    text = "# 标题\n**加粗** 和 *斜体*，`代码`，[链接](http://x.com)\n- 列表项\n1. 有序项"
    out = strip_markdown(text)
    assert "**" not in out and "#" not in out and "`" not in out
    assert "加粗" in out and "斜体" in out and "链接" in out
    assert "http://x.com" not in out
    assert "列表项" in out and "有序项" in out


def test_strip_markdown_code_block_removed():
    out = strip_markdown("看代码：\n```python\nprint(1)\n```\n结束")
    assert "print" not in out
    assert "看代码" in out and "结束" in out
