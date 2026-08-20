#!/usr/bin/env python3
"""用桩件模拟 MicroPython/M5 环境，真的 import 一遍全部设备模块。

静态分析看不到"模块级代码能否跑通"（如 _ring_rects 预计算、字体取值、
sys.path 顺序）。这里真跑一遍 import，并抽查几个纯函数的行为。
用法: python3 tools/import_sim.py
"""
import sys, types, os, math

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "device", "src"))

def stub(name, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m

class _Any:
    """吞掉任意属性访问与调用的万能桩。"""
    def __init__(self, name="?"): self._n = name
    def __getattr__(self, k): return _Any(self._n + "." + k)
    def __call__(self, *a, **kw): return None
    def __repr__(self): return "<stub %s>" % self._n

class _Fonts:
    DejaVu18 = "DejaVu18"
    # 故意不提供 EFontCN16/14：验证无中文字体时 ui 能优雅降级
class _Widgets:
    FONTS = _Fonts()
    Line = staticmethod(lambda *a: None)
    fillScreen = staticmethod(lambda *a: None)
    setRotation = staticmethod(lambda *a: None)

_M5 = stub("M5",
           begin=lambda *a: None, update=lambda *a: None,
           Lcd=_Any("Lcd"), Touch=_Any("Touch"), Power=_Any("Power"),
           Imu=_Any("Imu"), Widgets=_Widgets,
           Speaker=_Any("Speaker"), Mic=_Any("Mic"), Rgb=_Any("Rgb"))
# from M5 import * 提供的名字（与真机基线一致：Lcd/Mic/Rgb/Speaker/Widgets）
_M5.Widgets = _Widgets
for n in ("Lcd", "Mic", "Rgb", "Speaker"):
    setattr(_M5, n, _Any(n))
_M5.__all__ = ["Widgets", "Lcd", "Mic", "Rgb", "Speaker"]
# 注意：不给 M5.Rtc，模拟 CoreS3 SE 无 RTC 硬件的分支

# MicroPython 的 time 比 CPython 多几个 ticks_* ——diag 在模块级就调
# time.ticks_ms() 记开机时刻，不补上会 import 不起来。直接给真 time 模块
# 挂属性，比整个替换 sys.modules["time"] 安全（socket/json 等已持有引用）。
import time as _time
_time.ticks_ms   = lambda: int(_time.monotonic() * 1000)
_time.ticks_diff = lambda a, b: a - b
_time.ticks_add  = lambda a, b: a + b
_time.sleep_ms   = lambda ms: _time.sleep(ms / 1000.0)

stub("hardware")
stub("network", WLAN=lambda *a: _Any("WLAN"), STA_IF=1)
stub("machine", WDT=lambda **kw: _Any("WDT"), reset=lambda: None)
stub("camera", init=lambda: None, capture=lambda: b"\x00" * 100)

import binascii, json, socket, os as _os, struct as _struct
stub("ubinascii", b2a_base64=binascii.b2a_base64, a2b_base64=binascii.a2b_base64)
stub("ujson", loads=json.loads, dumps=json.dumps, load=json.load, dump=json.dump)
stub("usocket", socket=socket.socket, AF_INET=socket.AF_INET,
     SOCK_DGRAM=socket.SOCK_DGRAM, SOL_SOCKET=socket.SOL_SOCKET,
     SO_BROADCAST=socket.SO_BROADCAST)
stub("uos", mkdir=lambda p: None, remove=lambda p: None, rename=lambda a, b: None)
stub("requests", get=lambda *a, **kw: _Any("resp"), post=lambda *a, **kw: _Any("resp"))

print("=== 按依赖顺序 import ===")
order = ["cfg", "hw", "clock", "ui", "wifisetup", "audio", "cam",
         "feel", "diag", "netsvc", "stream", "chat", "app"]
for name in order:
    __import__(name)
    print("  ✓ import %s" % name)

import cfg, hw, ui, audio, clock

print("\n=== 模块级代码执行结果抽查 ===")
print("  cfg.res('img_bg.jpg')      =", cfg.res("img_bg.jpg"))
print("  cfg.data('wifi.json')      =", cfg.data("wifi.json"))
print("  ui._ring_rects 段数        =", len(ui._ring_rects))
assert len(ui._ring_rects) == cfg.RING_N, "环段数不对"
print("  ui._FONT_CN (无中文字体时)  =", ui._FONT_CN, "→ 应为 None，屏显文本自动跳过")
assert ui._FONT_CN is None
print("  clock._has_rtc (无 Rtc 时)  =", clock._has_rtc, "→ 应为 False，走软件时钟")
assert clock._has_rtc is False

print("\n=== 纯函数行为验证 ===")
# rms / rms_slices 一致性
buf = bytearray()
for i in range(800):
    buf += _struct.pack('<h', int(8000 * math.sin(i / 5.0)))
sub, whole = hw.rms_slices(buf)
print("  hw.rms(buf)                =", hw.rms(buf))
print("  hw.rms_slices -> 整体       =", whole, "子片", sub)
assert abs(hw.rms(buf) - whole) <= 1, "rms 与 rms_slices 整体值应一致"
assert len(sub) == 5

# WAV 头
hdr = hw.make_wav_header(1000)
assert len(hdr) == 44 and hdr[:4] == b'RIFF' and hdr[8:12] == b'WAVE'
print("  hw.make_wav_header(1000)   = 44 字节 RIFF/WAVE ✓")

# 包络（audio._wav_envelope 依赖 44 字节头约定）
pcm = bytearray()
for i in range(16000):
    amp = 12000 if i < 8000 else 1200
    pcm += _struct.pack('<h', int(amp * math.sin(2 * math.pi * 440 * i / 16000)))
env = audio._wav_envelope(b'R' * 44 + bytes(pcm))
print("  audio._wav_envelope 桶数    =", len(env), "响段均值 %.2f 轻段均值 %.2f"
      % (sum(env[:5]) / 5, sum(env[-5:]) / 5))
assert all(0.0 <= v <= 1.0 for v in env)
assert sum(env[:5]) / 5 > sum(env[-5:]) / 5 * 2

# 可变全局：模拟 discover_server 改写后，其他模块能否看到
print("\n=== 可变全局跨模块可见性（拆分最大的坑）===")
before = cfg.SERVER_BASE
cfg.SERVER_BASE = "http://10.0.0.9:5000"
import netsvc, chat
print("  改写后 cfg.SERVER_BASE     =", cfg.SERVER_BASE)
src = open(os.path.join(os.path.dirname(__file__), "..", "device", "src", "chat.py")).read()
assert "cfg.SERVER_URL" in src and "\nSERVER_URL" not in src
print("  chat.py 引用方式            = cfg.SERVER_URL（属性访问，能看到改写）✓")
cfg.SERVER_BASE = before

print("\n✅ 全部模块 import 成功，行为验证通过")
