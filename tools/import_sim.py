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
stub("uos", mkdir=lambda p: None, remove=_os.remove, rename=lambda a, b: None,
     stat=_os.stat)
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

# 看门狗武装：固件拒绝配置值时必须回退，并且结果要能被远程看见
_wdt_calls = []
def _picky_wdt(timeout=0):
    """模拟一个只接受 <=120s 的固件。"""
    _wdt_calls.append(timeout)
    if timeout > 120000:
        raise ValueError("WDT timeout too long")
    return _Any("WDT")
sys.modules["machine"].WDT = _picky_wdt
_saved_to = cfg.WATCHDOG_TIMEOUT_MS
cfg.WATCHDOG_TIMEOUT_MS = 180000
hw._wdt, hw._wdt_ms = None, 0
hw._wdt_init()
assert _wdt_calls == [180000, 120000], "配置值失败后必须回退到 120000"
assert hw._wdt is not None and hw._wdt_ms == 120000, "回退成功要如实记进 _wdt_ms"
print("  hw._wdt_init 回退           = 180000 被拒 → 120000 武装成功，_wdt_ms=%d ✓" % hw._wdt_ms)

sys.modules["machine"].WDT = lambda timeout=0: (_ for _ in ()).throw(OSError("no wdt"))
hw._wdt, hw._wdt_ms = None, 0
hw._wdt_init()
assert hw._wdt is None and hw._wdt_ms == 0, "全失败必须留下 _wdt_ms=0，别假装有看门狗"
print("  hw._wdt_init 全失败         = _wdt_ms=0（心跳会报⚠️未武装）✓")
cfg.WATCHDOG_TIMEOUT_MS = _saved_to
sys.modules["machine"].WDT = lambda **kw: _Any("WDT")
hw._wdt, hw._wdt_ms = None, 0

# drain_touch：触摸永远不抬起时必须超时退出，不能把主循环拖死
class _StuckTouch:
    getCount = staticmethod(lambda: 1)
_saved_touch = _M5.Touch
_M5.Touch = _StuckTouch
_t0 = _time.monotonic()
assert hw.drain_touch(timeout_ms=200) is False, "卡住的触摸必须超时返回 False"
assert _time.monotonic() - _t0 < 2, "超时要按 timeout_ms 生效，不能傻等"
_M5.Touch = _saved_touch
print("  hw.drain_touch 卡死         = 200ms 超时退出 ✓（旧版在这里永远转下去）")

# 死人开关：主循环停摆时，喂狗点是唯一还在转的地方
_reset_calls = []
sys.modules["machine"].reset = lambda: _reset_calls.append(True)
_dm_log = os.path.join(os.path.dirname(__file__), "..", "device", "_sim_crash.log")
_saved_data, cfg.data = cfg.data, (lambda name: _dm_log)
_saved_dm = (cfg.DEADMAN_SECS, cfg.DEADMAN_MIN_UPTIME_MS)
cfg.DEADMAN_SECS, cfg.DEADMAN_MIN_UPTIME_MS = 60, 0
cfg.St.stage = "play"
cfg.St.last_ok_ms = _time.ticks_ms() - 120000      # 装作 2 分钟没联系上服务端
hw._deadman_last = _time.ticks_ms() - 999999       # 绕过 10s 节流
hw._wdt_feed()
assert _reset_calls == [True], "失联超过阈值必须复位"
assert "stuck at play" in open(_dm_log).read(), "复位前必须留下卡在哪一步的临终留言"
os.remove(_dm_log)
print("  hw._deadman_check 触发      = 失联超阈值 → 复位 + 留言\"stuck at play\" ✓")

_reset_calls.clear()
cfg.St.last_ok_ms = _time.ticks_ms()               # 刚联系过
hw._deadman_last = _time.ticks_ms() - 999999
hw._wdt_feed()
cfg.DEADMAN_MIN_UPTIME_MS = 3600000                # 开机不久
hw._deadman_armed = False                          # 闩锁复位，重新走门槛判断
cfg.St.last_ok_ms = _time.ticks_ms() - 120000
hw._deadman_last = _time.ticks_ms() - 999999
hw._wdt_feed()
assert _reset_calls == [], "刚联系过 / 开机不久都不许复位"
print("  hw._deadman_check 不误伤    = 刚联系过 ✓ 开机 1 小时内 ✓")
cfg.DEADMAN_SECS, cfg.DEADMAN_MIN_UPTIME_MS = _saved_dm
cfg.data = _saved_data
cfg.St.last_ok_ms = _time.ticks_ms()

# ── 录音 VAD：去直流 / 字头预录 / 无缝双缓冲 / 开机校准 ─────────────
print("\n=== 录音 VAD ===")
_dc = bytearray()
for i in range(1000):
    _dc += _struct.pack('<h', 3000 + int(100 * math.sin(i / 3.0)))
assert hw.rms(_dc) < 120, "直流偏置不能算进电平（旧版这里是 ~3000）"
_sub, _whole = hw.rms_slices(_dc)
assert abs(_whole - hw.rms(_dc)) <= 1 and max(_sub) < 120
print("  hw.rms 去直流               = 偏置 3000 + 抖动 100 → %d ✓" % hw.rms(_dc))

def _tone(amp, n, dc=500):
    b = bytearray()
    for i in range(n):
        b += _struct.pack('<h', dc + int(amp * math.sin(i / 2.0)))
    return bytes(b)

class _FakeMic:
    """按 record() 的调用顺序依次填入脚本里的块（硬件也是按排队顺序录的）。"""
    def __init__(self, script):
        self.script = list(script); self.calls = 0
    def begin(self): pass
    def end(self): pass
    def record(self, buf, rate):
        self.calls += 1
        seg = self.script.pop(0) if self.script else _tone(0, len(buf) // 2)
        buf[:] = seg[:len(buf)]
    def isRecording(self):
        return 1

_saved_rec = (cfg.CHUNK_SEC, cfg.CHUNK_SIZE, cfg.SILENCE_THRESHOLD, snd.Mic, hw.Mic)
cfg.CHUNK_SEC = 0.02
cfg.CHUNK_SIZE = 640                    # 320 采样 = 20ms，测试跑得快
cfg.SILENCE_THRESHOLD = 500
_saved_touch = hw.check_touch
hw.check_touch = lambda *a, **k: (None, None)
_n = 320
_script = ([_tone(9000, _n)] +          # 开麦爆音：必须丢掉，不能触发起说
           [_tone(50, _n)] * 6 +        # 安静
           [_tone(300, _n, dc=2500)] +  # 字头：低于门槛但该被预录带上
           [_tone(4000, _n)] * 4 +      # 说话
           [_tone(50, _n)] * 6)         # 句尾静音 → 收尾
snd.Mic = hw.Mic = _FakeMic(_script)
hw._mic_active = False
_chunks = snd._record_audio()
_onset = _tone(300, _n, dc=2500)
assert _chunks is not None and len(_chunks) == 2 + 4 + cfg.SILENCE_CHUNKS, len(_chunks)
assert _chunks[1] == _onset, "起说前一块（字头）必须被预录带上"
assert _tone(9000, _n) not in _chunks, "开麦第一块（爆音）必须丢掉"
assert snd.last_rec.get("late", 0) == 0 and snd.last_rec.get("tmo", 0) == 0
print("  snd._record_audio           = 爆音丢弃 ✓ 字头预录 ✓ 共 %d 块 ✓" % len(_chunks))
print("  " + snd.rec_summary())

# 一直没人说话：等满 MAX_WAIT_CHUNKS 返回 []
snd.Mic = hw.Mic = _FakeMic([])
hw._mic_active = False
_saved_wait = cfg.MAX_WAIT_CHUNKS
cfg.MAX_WAIT_CHUNKS = 5
assert snd._record_audio() == []
cfg.MAX_WAIT_CHUNKS = _saved_wait
print("  snd._record_audio 无人说话  = 返回 [] ✓")

# 校准：前 3 段（含开麦爆音）丢掉、取中位数，不再被一段尖峰带飞
_cal = [_tone(20000, 1600)] * 3 + [_tone(80, 1600)] * 9 + [_tone(15000, 1600)]
snd.Mic = hw.Mic = _FakeMic(_cal)
hw._mic_active = False
snd.calibrate_noise()
assert cfg.NOISE_FLOOR < 120 and cfg.SILENCE_THRESHOLD == 200, (cfg.NOISE_FLOOR, cfg.SILENCE_THRESHOLD)
assert cfg.WAKE_THRESHOLD > cfg.SILENCE_THRESHOLD
print("  snd.calibrate_noise         = 底噪 %d 说话 %d 唤醒 %d（爆音/偶发尖峰不抬门槛）✓"
      % (cfg.NOISE_FLOOR, cfg.SILENCE_THRESHOLD, cfg.WAKE_THRESHOLD))
# 一直很吵也要封顶，免得门槛高到说话够不着
snd.Mic = hw.Mic = _FakeMic([_tone(3000, 1600)] * 13)
hw._mic_active = False
snd.calibrate_noise()
assert cfg.SILENCE_THRESHOLD == cfg.VAD_MAX_THRESHOLD
print("  snd.calibrate_noise 很吵    = 门槛封顶 %d ✓" % cfg.SILENCE_THRESHOLD)

(cfg.CHUNK_SEC, cfg.CHUNK_SIZE, cfg.SILENCE_THRESHOLD, snd.Mic, hw.Mic) = _saved_rec
hw.check_touch = _saved_touch
hw._mic_active = False

# ── 边下边播：顺序完整、在播的缓冲不被覆盖、固件不支持时退回落盘 ─────
print("\n=== 边下边播 ===")
class _NoTouch:
    @staticmethod
    def getCount(): return 0

class _QSpeaker:
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

_saved_play = (snd.Speaker, snd.M5.Touch, cfg.STREAM_BLOCK_BYTES, cfg.PLAY_PATH)
snd.M5.Touch = _NoTouch
cfg.STREAM_BLOCK_BYTES = 320            # 10ms 一块，测试跑得快
_pcm = bytes((i * 7) & 0xff for i in range(320 * 23 + 100))   # 不整块的尾巴
_wav = hw.make_wav_header(len(_pcm)) + _pcm
for _depth_ok in (True, False):
    snd.Speaker = _QSpeaker(depth_ok=_depth_ok)
    snd._stream_bad = False
    _n = snd.stream_play(_FakeResp(_wav))
    assert _n == len(_wav), (_n, len(_wav))
    assert bytes(snd.Speaker.out) == _pcm, "播出的 PCM 必须与源逐字节一致、顺序不乱"
    assert snd.Speaker.overwritten == 0, "在播/排队中的缓冲被下一块覆盖了"
    if _depth_ok:   # 按时间估时测试块只有 10ms，20ms 余量必然断粮；真机 1 秒一块无此问题
        assert snd.last_play["gaps"] == 0, "能查队列深度时不该断粮"
    print("  snd.stream_play %-12s = %d 块按序播完 ✓ 缓冲零覆盖 ✓  %s"
          % ("(按通道查深度)" if _depth_ok else "(按时间估)", len(_pcm) // 320 + 1,
             snd.stream_summary()))

# 固件内存 playWav 不出声：自动退回落盘，文件要与源 WAV 一致，之后不再尝试
cfg.PLAY_PATH = _tmp
snd.Speaker = _QSpeaker(silent=True)
snd._stream_bad = False
assert snd.stream_play(_FakeResp(_wav)) == len(_wav)
assert open(_tmp, "rb").read() == _wav, "退回落盘时已读出的那几块必须接回去"
assert snd._stream_bad and snd.last_play["mode"] == "fallback"
print("  snd.stream_play 不出声      = 退回落盘，文件逐字节一致 ✓ 本次开机不再尝试 ✓")
# 签名不符直接抛 TypeError：同样退回，不能把异常甩给只接 OSError 的调用方
class _BadSigSpeaker(_QSpeaker):
    def playWav(self, buf, *a):
        if a:
            raise TypeError("function takes 2 positional arguments")
snd.Speaker = _BadSigSpeaker()
snd._stream_bad = False
assert snd.stream_play(_FakeResp(_wav)) == len(_wav)
assert open(_tmp, "rb").read() == _wav and snd.last_play["mode"] == "fallback"
print("  snd.stream_play 签名不符    = 不抛异常，退回落盘 ✓")
if os.path.exists(_tmp):
    os.remove(_tmp)           # 别在仓库里留垃圾
snd._stream_bad = False
(snd.Speaker, snd.M5.Touch, cfg.STREAM_BLOCK_BYTES, cfg.PLAY_PATH) = _saved_play

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
