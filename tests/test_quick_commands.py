import pytest

import quick_commands


LT = "2026-05-15 14:23"   # 星期五


@pytest.mark.parametrize("text", [
    "现在几点", "现在几点了", "几点了", "请问几点了", "报时", "当前时间",
])
def test_time_queries_hit(text):
    reply = quick_commands.match(text, local_time=LT)
    assert reply == "现在是下午2点23分。"


@pytest.mark.parametrize("text", ["今天几号", "今天日期是多少"])
def test_date_queries_hit(text):
    assert quick_commands.match(text, local_time=LT) == "今天是2026年5月15日。"


@pytest.mark.parametrize("text", ["今天星期几", "今天周几", "星期几"])
def test_weekday_queries_hit(text):
    assert quick_commands.match(text, local_time=LT) == "今天是星期五。"


@pytest.mark.parametrize("text", [
    "你好吗", "明天天气怎么样", "讲个笑话", "帮我拍张照片", "",
])
def test_misses_return_none(text):
    assert quick_commands.match(text, local_time=LT) is None


def test_time_periods_and_zero_minute():
    assert quick_commands.match("几点了", local_time="2026-05-15 08:00") == "现在是上午8点整。"
    assert quick_commands.match("几点了", local_time="2026-05-15 12:30") == "现在是中午12点30分。"
    assert quick_commands.match("几点了", local_time="2026-05-15 21:05") == "现在是晚上9点5分。"


def test_invalid_local_time_falls_back_to_server_clock():
    reply = quick_commands.match("现在几点", local_time="not-a-time")
    assert reply is not None and reply.startswith("现在是")


def test_seconds_format_accepted():
    assert quick_commands.match("几点了", local_time="2026-05-15 14:23:59") == "现在是下午2点23分。"
