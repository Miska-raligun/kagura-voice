#!/usr/bin/env python3
"""设备端模块的桩件环境：模拟 MicroPython / M5 的模块，让 device/src 能在电脑上 import。

import_sim.py（逐模块行为验证）和 device_e2e.py（对着真的服务端跑对话）共用。import 这个模块就装好桩件。
"""
import sys, types, os

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
stub("ubinascii", b2a_base64=binascii.b2a_base64, a2b_base64=binascii.a2b_base64,
     hexlify=binascii.hexlify)
stub("ujson", loads=json.loads, dumps=json.dumps, load=json.load, dump=json.dump)
stub("usocket", socket=socket.socket, AF_INET=socket.AF_INET,
     SOCK_DGRAM=socket.SOCK_DGRAM, SOL_SOCKET=socket.SOL_SOCKET,
     SO_BROADCAST=socket.SO_BROADCAST)
stub("uos", mkdir=lambda p: None, remove=_os.remove, rename=lambda a, b: None,
     stat=_os.stat)
# 已经 import 了真的 requests（device_e2e 要真的发请求）就不换成桩
if "requests" not in sys.modules:
    stub("requests", get=lambda *a, **kw: _Any("resp"), post=lambda *a, **kw: _Any("resp"))



class QSpeaker:
    """两槽队列的扬声器桩：挂进去的缓冲按时长依次"播完"。

    播完那一刻才取缓冲内容，与挂入时的快照比对——真机上扬声器是播放时
    才读缓冲的，挂进去之后被改写就会播出下一块的声音。
    """
    def __init__(self, depth_ok=True, silent=False):
        self.q, self.out, self.overwritten = [], bytearray(), 0
        self.depth_ok, self.silent = depth_ok, silent
    def _tick(self):
        now = _time.monotonic()
        while self.q and self.q[0][2] <= now:
            ref, snap, _ = self.q.pop(0)
            if bytes(ref) != snap:
                self.overwritten += 1
            n = _struct.unpack_from('<I', snap, 40)[0]
            self.out += snap[44:44 + n]
            if self.q:   # 下一块从此刻开始播
                r2, s2, _ = self.q[0]
                self.q[0] = (r2, s2, now + self._dur(s2))
    def _dur(self, snap):
        return _struct.unpack_from('<I', snap, 40)[0] / 32000.0
    def begin(self): pass
    def end(self): pass
    def stop(self): self.q = []
    def setVolumePercentage(self, v): pass
    def playWav(self, buf, repeat=1, ch=-1, stop=False):
        if self.silent:
            return False
        self._tick()
        assert len(self.q) < 2, "队列满了还往里塞：缓冲复用的前提被破坏"
        snap = bytes(buf)
        start = self.q[-1][2] if self.q else _time.monotonic()
        self.q.append((buf, snap, start + self._dur(snap)))
        return True
    def isPlaying(self, ch=None):
        self._tick()
        if ch is not None and not self.depth_ok:
            raise TypeError("no channel arg")
        return len(self.q) if ch is not None else bool(self.q)
    def playWavFile(self, p): pass
