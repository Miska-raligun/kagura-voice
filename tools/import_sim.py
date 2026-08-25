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
stub("uos", mkdir=lambda p: None, remove=_os.remove, rename=lambda a, b: None)
stub("requests", get=lambda *a, **kw: _Any("resp"), post=lambda *a, **kw: _Any("resp"))

print("=== 按依赖顺序 import ===")
order = ["cfg", "hw", "clock", "ui", "wifisetup", "snd", "cam",
         "feel", "diag", "netsvc", "stream", "chat", "app"]
for name in order:
    __import__(name)
    print("  ✓ import %s" % name)

import cfg, hw, ui, snd, clock

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

# 包络（snd._wav_envelope 依赖 44 字节头约定）
pcm = bytearray()
for i in range(16000):
    amp = 12000 if i < 8000 else 1200
    pcm += _struct.pack('<h', int(amp * math.sin(2 * math.pi * 440 * i / 16000)))
env = snd._wav_envelope(b'R' * 44 + bytes(pcm))
print("  snd._wav_envelope 桶数      =", len(env), "响段均值 %.2f 轻段均值 %.2f"
      % (sum(env[:5]) / 5, sum(env[-5:]) / 5))
assert all(0.0 <= v <= 1.0 for v in env)
assert sum(env[:5]) / 5 > sum(env[-5:]) / 5 * 2

# 落盘：分块写 + 短写（文件系统满）必须被发现，不能当成功
class _FakeFile:
    """write 只肯写 limit 字节的文件——模拟 flash 写满时的短写。"""
    def __init__(self, limit=None):
        self.data = bytearray()
        self.limit = limit
    def write(self, b):
        room = len(b) if self.limit is None else max(0, self.limit - len(self.data))
        n = min(len(b), room)
        self.data += bytes(b[:n])
        return n

payload = bytes(range(256)) * 200        # 51200 字节，跨多个 PLAY_CHUNK
f = _FakeFile()
assert snd._write_chunked(f, payload) == len(payload) and f.data == payload
short = _FakeFile(limit=10000)
assert snd._write_chunked(short, payload) == 10000, "短写必须如实返回已写字节数"
print("  snd._write_chunked         = 全写 %d ✓ / 写满时返回 %d（不静默成功）✓"
      % (len(payload), 10000))

class _FakeRaw:
    """按块吐数据的 socket 桩：readinto 到 EOF 返回 0。"""
    def __init__(self, data, step=1500):
        self.data, self.step, self.off = data, step, 0
    def readinto(self, buf):
        n = min(len(buf), self.step, len(self.data) - self.off)
        buf[:n] = self.data[self.off:self.off + n]
        self.off += n
        return n

class _FakeResp:
    def __init__(self, data, raw=True):
        self.raw = _FakeRaw(data) if raw else None
        self.content = data
        self.headers = {"Content-Length": str(len(data))}

_tmp = os.path.join(os.path.dirname(__file__), "..", "device", "_sim_play.wav")
assert snd.save_stream(_FakeResp(payload), _tmp) == len(payload)
assert open(_tmp, "rb").read() == payload, "分块搬运不能丢字节/错位"
assert snd.save_stream(_FakeResp(payload, raw=False), _tmp) == len(payload), \
    "固件不给 raw 时要能退回 resp.content"
print("  snd.save_stream            = 分块落盘字节一致 ✓ / 无 raw 时回退 ✓")

# 切段：超长音频才切，每段自带正确的 WAV 头，拼回去要和原音频逐字节相同
_seg_max, _seg_bytes, _fade = cfg.PLAY_SEG_MAX, cfg.PLAY_SEG_BYTES, cfg.PLAY_FADE_BYTES
cfg.PLAY_SEG_MAX, cfg.PLAY_SEG_BYTES, cfg.PLAY_FADE_BYTES = 8000, 4000, 0
body = bytes(bytearray((i * 7) % 256 for i in range(10000)))   # 10000 = 2 整段 + 尾巴
src = hw.make_wav_header(len(body)) + body
assert snd.save_stream(_FakeResp(src), _tmp) == len(body), "返回值应是音频字节数（不含头）"
assert len(snd._segs) == 3, "10000/4000 应切成 3 段"
rebuilt = b""
for _p, _n in snd._segs:
    raw_seg = open(_p, "rb").read()
    assert raw_seg[:44] == hw.make_wav_header(_n), "每段必须自带回填好的 WAV 头"
    assert len(raw_seg) - 44 == _n
    rebuilt += raw_seg[44:]
assert rebuilt == body, "切段拼回去必须与原音频逐字节相同"
print("  snd.save_stream 切段        = %d 段 %s ✓ 拼回逐字节相同 ✓"
      % (len(snd._segs), [n for _p, n in snd._segs]))

# 换一条短音频：不切段，且上一条留下的分段文件要被删掉
_stale = [p for p, _n in snd._segs[1:]]
assert snd.save_stream(_FakeResp(src[:2000]), _tmp) == 2000
assert len(snd._segs) == 1 and snd._segs[0][0] == _tmp, "短音频必须一段到底（零缝隙）"
assert not any(os.path.exists(p) for p in _stale), "上一条的分段文件必须清掉，否则占满 flash"
print("  短音频                      = 不切段 ✓ 旧分段文件已清理 ✓")
# 淡入淡出：接缝两头必须被拉到零，否则波形硬台阶就是那声"咔嚓"
cfg.PLAY_FADE_BYTES = 160
FLAT = 10000
flat_body = _struct.pack('<h', FLAT) * 5000        # 恒定幅度，斜坡一眼可见
assert snd.save_stream(_FakeResp(hw.make_wav_header(len(flat_body)) + flat_body),
                       _tmp) == len(flat_body)
assert len(snd._segs) == 3
half = cfg.PLAY_FADE_BYTES // 2
for si, (_p, _n) in enumerate(snd._segs):
    body_seg = open(_p, "rb").read()[44:]
    head = [_struct.unpack_from('<h', body_seg, 2 * i)[0] for i in range(half)]
    assert head == [FLAT * i // half for i in range(half)], "段首必须是从 0 起的斜坡"
    mid = _struct.unpack_from('<h', body_seg, 2 * half + 200)[0]
    assert mid == FLAT, "斜坡以外的采样一个都不许动"
    if si < len(snd._segs) - 1:       # 末段的结尾是音频真正的结尾，不淡出
        tail = [_struct.unpack_from('<h', body_seg, len(body_seg) - 2 * (half - i))[0]
                for i in range(half)]
        assert tail == [FLAT * (half - i) // half for i in range(half)], "段尾必须淡到零"
print("  snd._fade_edges            = 段首淡入/段尾淡出各 %d 采样 ✓ 区外零改动 ✓" % half)

cfg.PLAY_SEG_MAX, cfg.PLAY_SEG_BYTES, cfg.PLAY_FADE_BYTES = _seg_max, _seg_bytes, _fade
for _p, _n in snd._segs:      # 分段文件全清，别在仓库里留垃圾
    if os.path.exists(_p):
        os.remove(_p)

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
