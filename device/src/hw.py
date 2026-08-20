"""硬件封装与底层工具：LED / 看门狗 / 麦克风 / 音量 / 摄像头 /
音频计算 / 触摸 / 绘图原语。

只依赖 cfg，不依赖任何上层模块。
"""

import M5
from M5 import *
from hardware import *
import time
import math
import struct
import array as uarray
import gc
import ubinascii
import ujson

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


# ── 硬件看门狗 ────────────────────────────────────────────────
# 未捕获异常/死循环时自动复位。ESP32 的 WDT 一旦创建无法关闭，
# 因此在 app.setup() 完成后才 arm（配网等待用户输入不受超时限制）。

_wdt = None


def wdt_arm():
    """启动看门狗。失败（固件不支持）只打印，不影响运行。"""
    global _wdt
    if not cfg.WATCHDOG_ENABLED:
        return
    try:
        from machine import WDT
        _wdt = WDT(timeout=cfg.WATCHDOG_TIMEOUT_MS)
        print("watchdog armed:", cfg.WATCHDOG_TIMEOUT_MS, "ms")
    except Exception as e:
        print("watchdog unavailable:", e)


def wdt_feed():
    if _wdt:
        try:
            _wdt.feed()
        except Exception:
            pass


# ── 音量（语音可调："小声一点/大声一点"，服务端回 X-Volume 头）──

_volume = 0.6


def volume_get():
    return _volume


def volume_load():
    """从 flash 恢复音量设置，无存档则用默认值。"""
    global _volume
    try:
        with open(cfg.data("volume.json"), "r") as f:
            v = ujson.load(f).get("volume")
        if isinstance(v, (int, float)) and 0.2 <= v <= 1.0:
            _volume = v
    except Exception:
        pass


def volume_adjust(direction):
    """direction: 'up'/'down'，步进 0.2，范围 [0.2, 1.0]，持久化到 flash。"""
    global _volume
    step = 0.2 if direction == "up" else -0.2
    _volume = max(0.2, min(1.0, round(_volume + step, 1)))
    try:
        with open(cfg.data("volume.json"), "w") as f:
            ujson.dump({"volume": _volume}, f)
    except Exception as e:
        print("[vol] save err:", e)
    print("[vol] volume =", _volume)


# ── 麦克风开关 ────────────────────────────────────────────────
# Mic 与 Speaker 共享音频通路，播放前必须 mic_off()。

_mic_active = False


def mic_on():
    """幂等开麦。"""
    global _mic_active
    if not _mic_active:
        Mic.begin()
        _mic_active = True


def mic_off():
    global _mic_active
    if _mic_active:
        Mic.end()
        _mic_active = False


# ── 摄像头 ────────────────────────────────────────────────────

_camera_inited = False


def capture_photo():
    """
    调用 CoreS3 摄像头拍一张 QQVGA raw RGB565 帧。
    首次调用时初始化摄像头，之后保持常驻（不 deinit）。
    返回 base64 字符串（无换行），失败返回 None。
    """
    global _camera_inited
    import camera

    if not _camera_inited:
        print("camera: initializing...")
        try:
            camera.init()
            _camera_inited = True
            print("camera: init OK")
        except Exception as e:
            print("camera init error:", e)
            return None

    time.sleep(0.3)   # 等待曝光稳定（替代 skip_frames）

    print("camera: capturing...")
    try:
        img = camera.capture()
    except Exception as e:
        print("camera capture error:", e)
        return None

    if img is None or isinstance(img, bool):
        print("camera: capture returned", img)
        return None

    print("camera: raw size =", len(img))
    b64 = ubinascii.b2a_base64(img).decode("utf-8").replace("\n", "").replace("\r", "")
    gc.collect()
    return b64


# ── WAV 工具 ──────────────────────────────────────────────────
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

_touch_start = None
_touch_pos   = (0, 0)

def check_touch():
    """
    返回 (事件类型, 坐标)。
    事件类型: 'short' / 'long' / None
    坐标: (x, y) 为按下时的位置
    """
    global _touch_start, _touch_pos
    M5.update()
    count = M5.Touch.getCount()
    if count > 0:
        if _touch_start is None:
            _touch_start = time.ticks_ms()
            _touch_pos   = (M5.Touch.getX(), M5.Touch.getY())
        return (None, (0, 0))
    else:
        if _touch_start is not None:
            duration = time.ticks_diff(time.ticks_ms(), _touch_start)
            pos      = _touch_pos
            _touch_start = None
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

# ── 绘图辅助 ──────────────────────────────────────────────────

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


def reset_touch():
    """清掉进行中的触摸判定（彩蛋/模式切换后避免误判为长按）。"""
    global _touch_start
    _touch_start = None
