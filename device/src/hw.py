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
    """幂等开麦。Mic 与 Speaker 共享音频通路，播放前必须 _mic_off()。

    返回 True 表示这次是**刚开**的：开麦后头一段录音常带启动爆音，
    调用方据此丢掉第一块，别让它触发 VAD 或抬高底噪校准。
    """
    global _mic_active
    if not _mic_active:
        Mic.begin()
        _mic_active = True
        return True
    return False


def _mic_off():
    global _mic_active
    if _mic_active:
        Mic.end()
        _mic_active = False


_wdt = None


_wdt_ms = 0        # 实际武装成功的超时（ms）。0 = 这台设备**没有**看门狗


def _wdt_init():
    """武装看门狗。在 setup() 末尾调用：配网 UI 等交互流程不受超时限制。

    **必须兜底，而且必须能被远程看见**（LRN 2026-08-26）：
    旧代码构造失败时只 print 一行就把 _wdt 留成 None——等于整台设备失去
    硬件自愈能力，而这件事除了串口谁都不知道。8/26 那次主循环停摆 4 小时
    51 分、没有任何复位，第一嫌疑就是它（前一天刚把超时从 120000 改成
    180000，固件对上限有没有自己的限制无从得知）。
    现在依次试配置值和 120000（8 月上旬真机产生过"看门狗复位"的已知可用值），
    结果记进 _wdt_ms 随心跳上报，一分钟内就能确认它到底武装成功没有。
    """
    global _wdt, _wdt_ms
    if not cfg.WATCHDOG_ENABLED or _wdt is not None:
        return
    for ms in (cfg.WATCHDOG_TIMEOUT_MS, 120000):
        try:
            from machine import WDT
            _wdt = WDT(timeout=ms)
            _wdt_ms = ms
            print("watchdog armed:", ms, "ms")
            return
        except Exception as e:
            print("watchdog init failed at", ms, "ms:", e)
    _wdt_ms = 0
    print("watchdog UNAVAILABLE —— 本次运行没有硬件自愈能力")


_boot_ms = time.ticks_ms()


_deadman_last = 0        # 上次做过期检查的时刻（ticks_ms）


_deadman_armed = False   # 开机门槛过了没。**一次性闩锁，不是每次比对开机时刻**——
                         # ticks_diff 只在约 6.2 天内有效，连续跑一周后拿它算
                         # uptime 会翻负，这道兜底就悄悄失效了

cfg.St.last_ok_ms = _boot_ms   # cfg 不 import time，初值在这里给


def _wdt_feed():
    if _wdt:
        try:
            _wdt.feed()
        except Exception:
            pass
    _deadman_check()


def _deadman_check():
    """喂狗顺带做的"死人开关"。

    **为什么判据在这里而不在主循环**（LRN 2026-08-26）：那次僵死 4h51m，
    看门狗武装着 180 秒却一次没响——卡住的循环一边转一边喂狗，
    netfix1/netfix2 又要主循环跑到 net_watch_tick 才有机会执行，三道自愈
    全都够不着。而 _wdt_feed() 是**唯一一个在每个这种循环里都还在转**的
    函数，把判据放进来，以后再冒出新的"喂狗死循环"也自动被兜住。

    判据仍是 CLAUDE.md 那条铁律：只认"服务端还认不认得我"，
    不看设备自己觉得健康不健康。

    **必须用 ticks_ms 而不是 time.time()**：开机后 clock.sync_rtc() 会把
    墙钟往前跳好几年，拿墙钟算年龄会一开机就判超时、直接进重启循环。
    """
    global _deadman_last, _deadman_armed
    if not cfg.DEADMAN_SECS:
        return
    now = time.ticks_ms()
    if time.ticks_diff(now, _deadman_last) < 10000:   # 10s 一次就够，别拖慢热循环
        return
    _deadman_last = now
    if not _deadman_armed:
        if time.ticks_diff(now, _boot_ms) < cfg.DEADMAN_MIN_UPTIME_MS:
            return
        _deadman_armed = True     # 闩上就不再回头看开机时刻，见上面的注释
    dead = time.ticks_diff(now, cfg.St.last_ok_ms) // 1000
    if dead >= cfg.DEADMAN_SECS:
        _deadman_reset(dead)


def _deadman_reset(dead):
    """留下临终留言再复位：下次开机上报直接告诉你它卡在哪个循环里。

    不走 diag._persist_dbg —— diag 在 hw 上层，这里只能自己写。
    格式与 crash.log 其它段落一致，_boot_report 会照常带走。
    """
    try:
        import uos
        full = False
        try:
            full = uos.stat(cfg.data("crash.log"))[6] > 32768
        except OSError:
            pass                                    # 还没这个文件，当然没满
        if not full:                                # 满了就别写，直接复位
            with open(cfg.data("crash.log"), "a") as f:
                f.write("=== deadman (stuck at {}, dead={}s) ===\n".format(
                    cfg.St.stage, dead))
    except Exception:
        pass
    print("deadman: stuck at", cfg.St.stage, "dead", dead, "s -> reset")
    try:
        import machine
        machine.reset()
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
    # **去直流**：麦克风若带直流偏置，不去掉的话"安静"也有几百的 RMS，
    # 开机校准 ×3 之后门槛就高过正常说话音量——说了也不触发。
    a = uarray.array('h', buf)
    n = len(a)
    if n == 0:
        return 0
    s1 = 0
    s2 = 0
    for v in a:
        s1 += v
        s2 += v * v
    m = s1 / n
    var = s2 / n - m * m
    return int(math.sqrt(var)) if var > 0 else 0


def rms_slices(buf, n=5):
    """单次遍历返回 (n 个子片 RMS, 整体 RMS)，都按整块均值去直流。

    子片供电平动画和 VAD 起说判定用（0.25s 的块拆成 5 个 50ms），
    整体值与 rms() 一致。总运算量与调一次 rms() 相同。
    """
    a = uarray.array('h', buf)
    total_n = len(a)
    if total_n == 0:
        return [0] * n, 0
    seg = total_n // n
    sums = []
    S1 = 0
    S2 = 0
    for s in range(n):
        start = s * seg
        end = total_n if s == n - 1 else start + seg
        s1 = 0
        s2 = 0
        for i in range(start, end):
            v = a[i]
            s1 += v
            s2 += v * v
        sums.append((s1, s2, end - start))
        S1 += s1
        S2 += s2
    m = S1 / total_n
    out = []
    for s1, s2, cnt in sums:
        var = (s2 - 2 * m * s1) / cnt + m * m if cnt else 0
        out.append(int(math.sqrt(var)) if var > 0 else 0)
    var = S2 / total_n - m * m
    return out, (int(math.sqrt(var)) if var > 0 else 0)


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


def drain_touch(timeout_ms=3000):
    """等待屏幕所有触摸点抬起。返回 True=已抬起，False=超时放弃。

    **这个等待必须有上限**（LRN 2026-08-26）：条件完全由触摸硬件决定，
    屏上压了东西、进水、驱动漏报一次抬手，它就永远转下去。而且原来这个
    循环一次狗都不喂——"主循环停摆 + 看门狗饿不死它"正是设备僵死却不复位
    的配方。现在既喂狗又有上限，卡住也只是丢掉这次去抖，不会拖垮整机。
    """
    t0 = time.ticks_ms()
    while M5.Touch.getCount() > 0:
        _wdt_feed()
        if time.ticks_diff(time.ticks_ms(), t0) > timeout_ms:
            print("drain_touch: 触摸迟迟不抬起，超时放弃")
            return False
        M5.update()
        time.sleep(0.05)
    return True


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
