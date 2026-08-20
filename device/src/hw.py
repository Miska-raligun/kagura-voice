"""Kagura Voice 设备端 —— 硬件封装：LED / 看门狗 / 麦克风 / 音量 / RMS / 触摸 / 绘图原语。

触摸检测带 feel 参数——主循环传 True 时才做抚摸轨迹判定，
取景/配网这些地方要的是纯按钮，别让手滑变成抚摸把点击吞掉。
"""

import M5
from M5 import *
from hardware import *
import time
import struct
import math
import ujson
import array as uarray

import cfg

# ── RGB LED 安全封装（CoreS3 SE 无 RGB）──────────────────────
try:
    _has_rgb = Rgb is not None
except NameError:
    _has_rgb = False


def _set_led(r, g, b):
    if _has_rgb:
        try:
            Rgb.setColorAll(r, g, b)
        except Exception:
            pass


# ── 音量（语音可调："小声一点/大声一点"，服务端回 X-Volume 头） ──
_VOLUME_PATH = cfg.data("volume.json")


_volume = 0.6


def _volume_load():
    global _volume
    try:
        with open(_VOLUME_PATH, "r") as f:
            v = ujson.load(f).get("volume")
        if isinstance(v, (int, float)) and 0.2 <= v <= 1.0:
            _volume = v
    except Exception:
        pass   # 无存档用默认值


def _volume_adjust(direction):
    """direction: 'up'/'down'，步进 0.2，范围 [0.2, 1.0]，持久化到 flash。"""
    global _volume
    step = 0.2 if direction == "up" else -0.2
    _volume = max(0.2, min(1.0, round(_volume + step, 1)))
    try:
        with open(_VOLUME_PATH, "w") as f:
            ujson.dump({"volume": _volume}, f)
    except Exception as e:
        print("[vol] save err:", e)
    print("[vol] volume =", _volume)


_mic_active = False


def _mic_on():
    """幂等开麦。Mic 与 Speaker 共享音频通路，播放前必须 _mic_off()。"""
    global _mic_active
    if not _mic_active:
        Mic.begin()
        _mic_active = True


def _mic_off():
    global _mic_active
    if _mic_active:
        Mic.end()
        _mic_active = False


_wdt = None


def _wdt_init():
    """武装看门狗。在 setup() 末尾调用：配网 UI 等交互流程不受超时限制。"""
    global _wdt
    if cfg.WATCHDOG_ENABLED and _wdt is None:
        try:
            from machine import WDT
            _wdt = WDT(timeout=cfg.WATCHDOG_TIMEOUT_MS)
            print("watchdog armed:", cfg.WATCHDOG_TIMEOUT_MS, "ms")
        except Exception as e:
            print("watchdog unavailable:", e)


def _wdt_feed():
    if _wdt:
        try:
            _wdt.feed()
        except Exception:
            pass


# ── 触摸状态 ──────────────────────────────────────────────────

_touch_start = None


_touch_pos   = (0, 0)


_touch_maxd     = 0         # 本次按下期间离起点的最大位移（曼哈顿距离，px）


_touch_gesture  = None      # 本次按下已判定的触觉手势：'stroke' / 'cradle' / None


_touch_last_ms  = 0         # 最近一次手势按住的时长（ms），供结算用


_touch_seen_ms  = 0         # 最近一次"屏幕上有手"的时刻（ms）。反射层靠它判断


def make_wav_header(data_len, sample_rate=16000, channels=1, bits=16):
    byte_rate   = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    header = struct.pack('<4sI4s4sIHHIIHH4sI',
        b'RIFF', 36 + data_len, b'WAVE',
        b'fmt ', 16, 1, channels, sample_rate,
        byte_rate, block_align, bits,
        b'data', data_len)
    return header


def rms(buf):
    # array('h') 直接迭代比逐样本 struct.unpack_from 快约一个数量级；
    # calibrate_noise() 与此同函数，阈值尺度自洽，无需重新校准。
    a = uarray.array('h', buf)
    n = len(a)
    if n == 0:
        return 0
    total = 0
    for v in a:
        total += v * v
    return int(math.sqrt(total / n))


def rms_slices(buf, n=5):
    """单次遍历返回 (n 个子片 RMS, 整体 RMS)。

    子片供电平动画用（0.25s 的块拆成 5 帧 → 20fps 音频响应），
    整体值供 VAD 判定用。总运算量与调一次 rms() 相同，等于白送。
    """
    a = uarray.array('h', buf)
    total_n = len(a)
    if total_n == 0:
        return [0] * n, 0
    seg = total_n // n
    out = []
    grand = 0
    for s in range(n):
        start = s * seg
        end = total_n if s == n - 1 else start + seg
        acc = 0
        for i in range(start, end):
            v = a[i]
            acc += v * v
        cnt = end - start
        out.append(int(math.sqrt(acc / cnt)) if cnt else 0)
        grand += acc
    return out, int(math.sqrt(grand / total_n))


# ── 触摸检测 ──────────────────────────────────────────────────

_FEEL_ONGOING = {'stroke': 'stroking', 'cradle': 'cradling'}


def check_touch(feel=False):
    """
    返回 (事件类型, 坐标)。
    事件类型: 'short' / 'long' / None；feel=True 时还可能是：
      'stroking' / 'cradling' —— 手势进行中，按住期间每轮都返回（喂反射层）
      'stroke'   / 'cradle'   —— 手势结束。此时**不再产生 short/long**
    坐标: (x, y) 为按下时的位置

    feel 默认 False = 与加触觉之前逐字节等价的行为。取景模式、配网界面、
    播放中断这些地方要的就是纯按钮，别让一次手滑变成抚摸把点击吞掉；
    只有主循环 loop() 传 True。

    位移用"离起点的最大曼哈顿距离"而不是累计路径长度：累计路径会把长按
    期间的手指抖动一点点攒过阈值，把静止长按误判成抚摸；最大位移不会，
    而来回摩挲在两端自然会超阈值，照样判得出来。
    """
    global _touch_start, _touch_pos, _touch_maxd, _touch_gesture, _touch_last_ms
    global _touch_seen_ms
    M5.update()
    count = M5.Touch.getCount()
    if count > 0:
        _touch_seen_ms = time.ticks_ms()
        x, y = M5.Touch.getX(), M5.Touch.getY()
        if _touch_start is None:
            _touch_start   = time.ticks_ms()
            _touch_pos     = (x, y)
            _touch_maxd    = 0
            _touch_gesture = None
        if feel and cfg.TOUCH_FEEL_ENABLED:
            d = abs(x - _touch_pos[0]) + abs(y - _touch_pos[1])
            if d > _touch_maxd:
                _touch_maxd = d
            held = time.ticks_diff(time.ticks_ms(), _touch_start)
            if count > 1:
                # 多指同时按住 =「被捧着」。UIFlow2 是否真的透传多点待真机确认，
                # 不透传的话这条分支永远不进，其余功能不受影响。
                _touch_gesture = 'cradle'
            elif _touch_maxd >= cfg.STROKE_MIN_DIST and held >= cfg.STROKE_MIN_MS:
                _touch_gesture = 'stroke'
            if _touch_gesture is not None:
                return (_FEEL_ONGOING[_touch_gesture], _touch_pos)
        return (None, (0, 0))
    else:
        if _touch_start is not None:
            duration = time.ticks_diff(time.ticks_ms(), _touch_start)
            pos      = _touch_pos
            gesture  = _touch_gesture
            _touch_start   = None
            _touch_gesture = None
            _touch_last_ms = duration
            if gesture is not None:
                return (gesture, pos)      # 判成触觉就吞掉 short/long，不录音
            if duration >= cfg.LONG_PRESS_MS:
                return ('long', pos)
            elif duration > 0:
                return ('short', pos)
    return (None, (0, 0))


def drain_touch():
    """等待屏幕所有触摸点抬起。"""
    while M5.Touch.getCount() > 0:
        M5.update()
        time.sleep(0.05)


def touch_reset():
    """丢弃当前这一次按下：抬手后不再产生任何事件。

    抚摸是**按住期间**就判定的（不像 short/long 要等抬手），所以拿它当触发器
    的地方必须显式作废这次按下，否则抬手时还会再吐一个手势事件出来。
    """
    global _touch_start, _touch_gesture, _touch_maxd
    _touch_start   = None
    _touch_gesture = None
    _touch_maxd    = 0


# ── 绘图辅助 ────────────────────────────────────────────────

def _fill_rect(x, y, w, h, color):
    """填充矩形，优先使用 Lcd.fillRect，回退为逐行 Line。"""
    try:
        Lcd.fillRect(x, y, w, h, color)
    except Exception:
        for yy in range(y, y + h):
            Widgets.Line(x, yy, x + w - 1, yy, color)


def _stroke_rect(x, y, w, h, color):
    """画矩形边框（4 条 Line）。"""
    Widgets.Line(x, y, x + w - 1, y, color)
    Widgets.Line(x, y + h - 1, x + w - 1, y + h - 1, color)
    Widgets.Line(x, y, x, y + h - 1, color)
    Widgets.Line(x + w - 1, y, x + w - 1, y + h - 1, color)


def _hit(x, y, rect):
    """点 (x,y) 是否落在 rect=(x1,y1,x2,y2) 内。"""
    return rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]


def _wait_tap():
    """阻塞等待一次抬起事件，返回 (x, y)。"""
    while True:
        t, pos = check_touch()
        if t in ('short', 'long') and pos != (0, 0):
            return pos
        time.sleep(0.01)
