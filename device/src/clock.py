"""RTC 时间同步与读取。

单独成模块是为了打断依赖环：ui.draw_state 需要读时间（顶栏时钟），
而 netsvc 需要 ui.draw_state。若把 RTC 放进 netsvc 就会形成
ui ↔ netsvc 循环 import。这里只依赖 cfg，谁都能安全 import。
"""

import M5
import time
import ujson
import requests as urequests

import cfg

_rtc_synced = False            # RTC 是否已同步
_has_rtc = hasattr(M5, 'Rtc')  # CoreS3 SE 无 RTC 硬件
_soft_time_offset = 0          # 软件时间偏移（秒），用于无 RTC 时


def sync_rtc():
    """从服务端获取时间并设置 RTC（无 RTC 硬件时用软件偏移代替）。"""
    global _rtc_synced, _soft_time_offset
    try:
        resp = urequests.get(cfg.SERVER_BASE + "/time", timeout=cfg.REQUEST_TIMEOUT_SHORT)
        if resp.status_code == 200:
            data = ujson.loads(resp.text)
            ts = data.get("timestamp", 0)
            resp.close()
            if ts > 0:
                # UIFlow2 的 time.localtime() 使用 Unix epoch (1970)
                tm = time.localtime(ts + 8 * 3600)  # UTC+8
                if _has_rtc:
                    M5.Rtc.setDateTime(tm[0], tm[1], tm[2], tm[3], tm[4], tm[5])
                    print("RTC synced:", tm[:6])
                else:
                    # 无 RTC：记录服务端时间与本地 ticks 的偏移
                    _soft_time_offset = (ts + 8 * 3600) - time.time()
                    print("Soft time synced:", tm[:6])
                _rtc_synced = True
                return
        else:
            resp.close()
    except Exception as e:
        print("RTC sync error:", e)
    print("RTC sync failed")


def _get_datetime():
    """返回 (year, month, day, hour, minute, second) 元组，兼容有/无 RTC。"""
    if _has_rtc:
        return M5.Rtc.getDateTime()
    # 无 RTC：用 MicroPython time + 偏移计算
    t = time.localtime(int(time.time() + _soft_time_offset))
    return t  # (year, month, mday, hour, minute, second, weekday, yearday)


def get_rtc_time_str():
    """返回当前时间字符串 "HH:MM"，未同步则返回空字符串。"""
    if not _rtc_synced:
        return ""
    try:
        dt = _get_datetime()
        return "{:02d}:{:02d}".format(dt[3], dt[4])
    except Exception:
        return ""


def get_local_time_header():
    """返回用于 X-Local-Time header 的时间字符串。"""
    if not _rtc_synced:
        return ""
    try:
        dt = _get_datetime()
        return "{:04d}-{:02d}-{:02d} {:02d}:{:02d}".format(dt[0], dt[1], dt[2], dt[3], dt[4])
    except Exception:
        return ""
