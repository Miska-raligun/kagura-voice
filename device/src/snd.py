"""Kagura Voice 设备端 —— 音频：录音 VAD、播放、包络计算、开机噪声校准。
"""

import M5
from M5 import *
from hardware import *
import time
import struct
import math

import uos

import cfg
import hw
import ui

# ── 回调注入：打断 snd ↔ netsvc 的环 ────────────────────────
# play_wav 长播放期间要泵一下 MQTT 维持心跳，而 netsvc 收到推送又要回调
# play_wav——直接 import 就成环（tools/check_split.py 会拦下）。
# 由 app.setup() 注入：snd.set_pump(netsvc.mqtt_check)
_pump = None


def set_pump(fn):
    """注入"播放期间维持连接"的泵函数。"""
    global _pump
    _pump = fn


def _pump_safe():
    if _pump:
        _pump()

def _wav_envelope(data, bucket_ms=100):
    """从 WAV 字节流稀疏采样出电平包络（0..1）。

    不用 array 整体转换（长回复可达 300KB，会撑爆堆），
    改为按桶稀疏 unpack，几毫秒即可完成。
    """
    off = 44                      # 服务端固定 44 字节标准 WAV 头
    total = len(data) - off
    if total <= 0:
        return []
    samples = total // 2
    n = max(1, (samples * 1000 // cfg.SAMPLE_RATE) // bucket_ms)
    per = max(1, samples // n)
    step = max(1, per // 24)      # 每桶取约 24 个采样点
    out = []
    peak = 1
    for b in range(n):
        base = off + b * per * 2
        acc = 0
        cnt = 0
        for k in range(0, per, step):
            pos = base + k * 2
            if pos + 2 > len(data):
                break
            v = struct.unpack_from('<h', data, pos)[0]
            acc += v * v
            cnt += 1
        r = int(math.sqrt(acc / cnt)) if cnt else 0
        out.append(r)
        if r > peak:
            peak = r
    return [v / peak for v in out]


# ── 音频录制 ──────────────────────────────────────────────────

def _record_audio():
    """
    启动麦克风，用 VAD 检测说话，返回 PCM 数据块列表。
    无说话返回空列表 []。
    若用户在录音期间长按屏幕，立即停止录音并返回 None（哨兵，表示用户主动中断）。
    """
    cfg.St.stage = "rec"
    hw._mic_on()
    chunks, silent, started = [], 0, False
    sub_levels = [0] * 5        # 上一块的子片电平，驱动等待期间的环形动画
    for _ in range(cfg.MAX_CHUNKS):
        hw._wdt_feed()   # 满长录音 10s，喂狗防误咬
        buf = bytearray(cfg.CHUNK_SIZE)
        Mic.record(buf, cfg.SAMPLE_RATE)
        # Mic.record 是异步的：等待缓冲填满的这段时间正好拿来跑动画
        ui._vis_wait(cfg.CHUNK_SEC + 0.05, sub_levels)
        # 长按优先检测：优先级高于录音，continuous/wake 模式均可退出
        t, _ = hw.check_touch()
        if t == 'long':
            hw._mic_off()
            return None          # 哨兵：用户请求退出当前模式
        sub_levels, level = hw.rms_slices(buf)
        if level > cfg.SILENCE_THRESHOLD:
            started = True
            silent  = 0
            chunks.append(bytes(buf))
        elif started:
            chunks.append(bytes(buf))
            silent += 1
            if silent >= cfg.SILENCE_CHUNKS:
                break
    hw._mic_off()
    return chunks


# ── 播放 ──────────────────────────────────────────────────────
#
# **长音频的口径（2026-08-25 排查「长语音播到一半黑屏」后定下，别退回去）**
#
# 一次早报推送可达 2.4MB / 74 秒，而整条链路原来是
# 「resp.content 整段进堆 → 一次 f.write 全写 flash → playWavFile」，
# 中间一次狗都没喂，WDT 窗口只有 120 秒——2026-08-11 08:10 那次
# 「看门狗复位⚠️」就是这么来的（08:10:49 下载，08:12:45 复位，
# 中间两次心跳全丢）。现在的三条硬规矩：
#   ① **下载不许用 resp.content**：分块 readinto 直接落盘，每块喂狗。
#      整段进堆是几 MB 的尖峰，读完之前还没人喂狗，两头都占。
#   ② **写盘分块**，每块喂狗；播放前后各补一次。
#   ③ **短写必须自己查**：文件系统写满时 MicroPython 的 f.write 只返回
#      少写的字节数、不抛异常。放着不管就是「WAV 头写着完整长度、
#      文件只有一半」——症状恰好也是「播到一半就没了」，极易误判。
# 还有一条留给下次：play_file 返回播放循环的轮数（iters）。非阻塞固件下
# 它约等于 时长×20；出现 0/1 就说明 playWavFile 是阻塞实现，整段播放
# 期间主循环根本没转，喂狗全靠进函数前那一次。

# ── 分段播放（只对超长音频生效）────────────────────────────────
#
# 为什么切：如果 playWavFile 是阻塞实现，一次调用就是一整段不喂狗的时间。
# 切成 10 秒一段，无论固件阻塞与否，最长不喂狗窗口都被钉死在 10 秒量级。
# **但只有超过 cfg.PLAY_SEG_MAX（约 50 秒）才切**——日常回复维持"一段到底"，
# 一条缝都没有。
#
# 为什么不让服务端拆成多条推送（2026-08-25 比过账）：那样每段之间要重走
# 「MQTT 通知 → HTTP GET → 下载几百 KB」，缝隙是**秒级**的，还各自多两次
# 全屏重绘（draw_state broadcast/idle，各 60~90ms）。设备端切段的缝隙只有
# 一次 playWavFile 启动——段文件早就躺在 flash 上了，几十毫秒的事。

_segs = []      # 上次落盘写下的待播清单：[(路径, 音频字节数), ...]


def _seg_path(base, i):
    return base if i == 0 else base[:-4] + str(i) + ".wav"


def _drop_stale_segs(base, start):
    """删掉上一条更长音频留下的分段文件。

    不删就一直占着 flash，而 flash 满的后果恰恰是「写出半个 WAV、
    播到一半就没了」——和我们要治的症状一模一样，别省这一步。
    """
    if start < 1:
        start = 1
    for i in range(start, start + 8):
        try:
            uos.remove(_seg_path(base, i))
        except OSError:
            break


def _fade_edges(buf, off, take, seg_len, seg_bytes):
    """把这次要写的字节里、落在段首/段尾淡化区的采样就地缩放。

    **段间那声"咔嚓"是波形的硬台阶**：上一段停在某个幅度上，中间夹几十毫秒
    静音，下一段又从另一个幅度起步——喇叭听到的就是两次瞬间跳变。
    5ms 的斜坡把接缝两头都拉到零，语音里听不出这点淡化，台阶却没了。
    （如果换成更长的段之后还有咔嚓，那就是功放启停的物理声，不是这里能治的，
    只能靠加长 PLAY_SEG_BYTES 减少次数。）

    只处理"两个字节都在本次写入范围内"的采样：跨块边界的那一个采样跳过，
    80 个采样的斜坡里漏一个毫无影响，换来的是不必跨块攒状态。
    """
    fb = cfg.PLAY_FADE_BYTES
    if fb <= 0:
        return
    half = fb // 2                      # 斜坡里的采样数
    end = seg_len + take
    for lo, rising in ((0, True), (seg_bytes - fb, False)):
        hi = lo + fb
        a = lo if lo > seg_len else seg_len          # 与本次写入区间求交
        b = hi if hi < end else end
        if a % 2:
            a += 1
        q = a
        while q + 2 <= b:
            k = (q - lo) // 2
            fac = k if rising else half - k
            pos = off + (q - seg_len)                # 段内偏移映射回 buf 位置
            v = struct.unpack_from('<h', buf, pos)[0] * fac // half
            struct.pack_into('<h', buf, pos, v)
            q += 2


def _write_chunked(f, data):
    """分块写入已打开的文件，每块喂狗。返回实际写入字节数。"""
    mv = memoryview(data)
    n = len(mv)
    off = 0
    while off < n:
        hw._wdt_feed()
        end = off + cfg.PLAY_CHUNK
        if end > n:
            end = n
        w = f.write(mv[off:end])
        if w is None:        # 部分固件的 write 返回 None 表示全部写出
            w = end - off
        if w <= 0:           # 写不动了：文件系统满
            break
        off += w
    return off


def save_wav(data, path=None):
    """WAV 字节流分块落盘。返回写入字节数（< len(data) 即 flash 满），失败 -1。"""
    global _segs
    path = path or cfg.PLAY_PATH
    try:
        with open(path, "wb") as f:
            n = _write_chunked(f, data)
    except OSError as e:
        print("save wav err:", e)
        return -1
    _segs = [(path, n - 44 if n > 44 else 0)]
    _drop_stale_segs(path, 1)
    return n


def save_stream(resp, path=None):
    """把 HTTP 响应体分块搬到 flash，返回字节数（-1=失败）。

    替代 resp.content：堆里不再出现整段 WAV，且每块都喂狗。
    body 靠读到 EOF 结束——urequests 本来就不支持 chunked 传输编码，
    服务端一律带 Content-Length + HTTP/1.0 关连接，口径一致。
    固件的 requests 万一不给 raw，退回老路（短音频照样能用）。
    """
    global _segs
    cfg.St.stage = "dl"
    path = path or cfg.PLAY_PATH
    _segs = []
    raw = getattr(resp, "raw", None)
    if raw is None or not hasattr(raw, "readinto"):
        data = resp.content
        n = save_wav(data, path)                # save_wav 自己会填 _segs
        return n if n == len(data) else -1      # 短写=flash 满，不能当成功放半段
    try:
        size = int(resp.headers.get("Content-Length", 0) or 0)
    except (ValueError, TypeError, AttributeError):
        size = 0                                # 长度未知就不切：不为一个猜测引入缝隙
    if size > cfg.PLAY_SEG_MAX:
        n = _save_segmented(raw, path, cfg.PLAY_SEG_BYTES)
        if n < 0:
            _segs = []
        return n
    total = 0
    buf = bytearray(cfg.PLAY_CHUNK)
    mv = memoryview(buf)
    try:
        with open(path, "wb") as f:
            while True:
                hw._wdt_feed()
                n = raw.readinto(buf)
                if not n:
                    break
                w = f.write(mv[:n])
                if w is None:
                    w = n
                if w < n:
                    print("save stream: flash full at", total)
                    return -1
                total += w
    except OSError as e:
        print("save stream err:", e)
        return -1
    _segs = [(path, total - 44 if total > 44 else 0)]
    _drop_stale_segs(path, 1)
    return total


def _save_segmented(raw, base, seg_bytes):
    """边下边切：跳过源 WAV 头，按 seg_bytes 切段，每段回填自己的头。

    切点必然落在采样边界（16bit 单声道 = 2 字节/采样，seg_bytes 是偶数），
    不会把一个采样劈成两半。段头的长度只有写完才知道，所以先写占位头、
    收尾 seek(0) 回填——这条路径不额外读写一遍，切段是白捡的。
    """
    global _segs
    buf = bytearray(cfg.PLAY_CHUNK)
    mv = memoryview(buf)
    hdr_left = 44          # 源 WAV 头：服务端固定 44 字节（synthesize 里写死），跳掉
    idx, seg_len, total = 0, 0, 0
    f = None
    try:
        while True:
            hw._wdt_feed()
            n = raw.readinto(buf)
            if not n:
                break
            off = 0
            if hdr_left:
                skip = hdr_left if hdr_left < n else n
                hdr_left -= skip
                off = skip
            while off < n:
                if f is None:
                    f = open(_seg_path(base, idx), "wb")
                    f.write(hw.make_wav_header(0))   # 占位，关段时回填
                    seg_len = 0
                take = seg_bytes - seg_len
                if take > n - off:
                    take = n - off
                _fade_edges(buf, off, take, seg_len, seg_bytes)
                w = f.write(mv[off:off + take])
                if w is None:
                    w = take
                if w < take:
                    print("save stream: flash full at", total)
                    return -1
                off += w
                seg_len += w
                total += w
                if seg_len >= seg_bytes:
                    f.seek(0)
                    f.write(hw.make_wav_header(seg_len))
                    f.close()
                    _segs.append((_seg_path(base, idx), seg_len))
                    f, idx = None, idx + 1
        if f is not None:
            f.seek(0)
            f.write(hw.make_wav_header(seg_len))
            f.close()
            _segs.append((_seg_path(base, idx), seg_len))
            f, idx = None, idx + 1
    except OSError as e:
        print("save segmented err:", e)
        return -1
    finally:
        if f is not None:
            try:
                f.close()
            except OSError:
                pass
    _drop_stale_segs(base, idx)
    return total


def play_file(path=None, env=None):
    """播放 flash 上的 WAV，返回播放等待循环的总轮数。触摸可随时中断。

    不带 path 就播落盘时记下的清单（日常回复只有一段）。
    **段与段之间不 end/begin 扬声器**：那会白搭上收尾的 150ms 消 pop 静音，
    缝隙从几十毫秒变成两百多毫秒，一耳朵就听得出来。
    """
    cfg.St.stage = "play"
    segs = [(path, 0)] if path else (_segs or [(cfg.PLAY_PATH, 0)])
    hw._mic_off()   # Mic/Speaker 共享音频通路：播放前确保麦克风已释放
    env = env or []
    Speaker.begin()
    Speaker.setVolumePercentage(hw._volume)
    t0 = time.ticks_ms()
    iters = 0
    stopped = False
    for spath, blen in segs:
        hw._wdt_feed()   # playWavFile 若是阻塞实现，这一段就靠这次喂狗
        Speaker.playWavFile(spath)
        # 知道这段多长，就能在收尾处把轮询收紧：50ms 的睡眠平均会把段间
        # 缝隙拖长 25ms，而这正是切段方案唯一听得见的代价
        dur = blen * 1000 // (cfg.SAMPLE_RATE * 2) if blen else 0
        st = time.ticks_ms()
        while Speaker.isPlaying():
            iters += 1
            hw._wdt_feed()   # 长音频播放可超过 WDT 窗口
            M5.update()
            if M5.Touch.getCount() > 0:   # Fix 6: 触摸中断
                Speaker.stop()
                time.sleep(0.2)           # 让扬声器余音散去
                hw.drain_touch()
                stopped = True
                break
            if env:
                idx = time.ticks_diff(time.ticks_ms(), t0) // 100
                ui._vis_set_level_norm(env[idx] if idx < len(env) else 0.0)
                ui.visual_tick()
            hw._wdt_feed()
            _pump_safe()      # 长播放期间维持心跳（回调只入队，不会嵌套播放）
            el = time.ticks_diff(time.ticks_ms(), st)
            time.sleep(0.005 if dur and el > dur - 250 else 0.05)
        if stopped:
            break
    ui._vis_set_level_norm(0.0)
    ui.visual_tick(force=True)
    time.sleep(0.15)   # 让音频信号归零，避免 Speaker.end() 产生 pop 声
    Speaker.end()
    hw._wdt_feed()
    return iters


def play_wav(data):
    """内存里的 WAV：落盘后播放。短音频与老调用方走这条。

    环形包络只有这条路径能算——落盘播放（save_stream + play_file）为了不把
    整段 WAV 拉回堆，故意不回读文件，VISUAL_ENABLED 打开时长音频没有包络动画。
    """
    hw._mic_off()
    # 先算包络：播放时按 elapsed 索引，环随语音起伏（不占播放时间）
    env = _wav_envelope(data) if cfg.VISUAL_ENABLED else []
    n = save_wav(data)
    if n < len(data):
        print("play skipped: flash full ({}/{})".format(n, len(data)))
        return 0
    return play_file(cfg.PLAY_PATH, env)


def calibrate_noise():
    """
    Fix 8: 启动时采样 1s 环境底噪，自动设置说话和唤醒阈值。
    阈值 = max(底噪峰值 × 倍数, 最低保障值)，避免安静环境误触发。
    """
    # 阈值属于 cfg，必须写 cfg.X = ...；用 global 会在本模块另建同名全局
    #Widgets.Label("Calibrating...", 40, 155, 1, 0x666666, 0x1a1a1a,_FONT_16)
    sample_buf = bytearray(int(16000 * 2 * 0.1))
    samples = []
    hw._mic_on()
    for _ in range(10):   # 10 × 100ms = 1s
        Mic.record(sample_buf, 16000)
        time.sleep(0.1)
        samples.append(hw.rms(sample_buf))
    hw._mic_off()
    noise_floor = max(samples)
    cfg.SILENCE_THRESHOLD = max(200, noise_floor * 3)
    cfg.WAKE_THRESHOLD    = max(300, noise_floor * 4)
    print("校准完成：底噪={}，说话阈值={}，唤醒阈值={}".format(
        noise_floor, cfg.SILENCE_THRESHOLD, cfg.WAKE_THRESHOLD))
