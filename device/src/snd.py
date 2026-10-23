"""Kagura Voice 设备端 —— 音频：录音 VAD、播放、包络计算、开机噪声校准。
"""

import M5
from M5 import *
from hardware import *
import time
import struct
import math
import gc

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
#
# **无缝录音（MIC_GAPLESS）**：Mic.record 是异步排队的（M5Unified 的 Mic 有
# 一个等待位），所以始终让两块缓冲排着队：一块在录，另一块排在后面。
# 队首录满就拿出来算电平，算完立刻重新排到队尾——硬件那边从没断过。
# 旧做法是「排一块 → sleep(块长+50ms) → 算 RMS → 再排下一块」，块与块之间
# 麦克风是停的，每 250ms 丢掉 80ms 左右，上传的语音是断断续续的。
#
# 什么时候算"录满"：先按时间算出这块理应结束的时刻（硬件不停，所以第 k 块
# 必然在开录后 (k+1)×块长 结束），再用 isRecording() 确认（2=在录且队列满，
# 降到 1 说明队首那块已经交卷）。isRecording 不可用或语义不符时退回纯按
# 时间判，最多晚 150ms，不会读到半块。

last_rec = {}     # 最近一次录音的统计，chat 写进诊断日志（snd 在 diag 之前，不能自己 import 它）


def _is_recording():
    try:
        return Mic.isRecording()
    except Exception:
        return None


def _wait_until(ready_ms, levels):
    """等到 ready_ms 之后、且队首那块确实录完。期间推进电平动画。

    返回 True = 靠 isRecording 确认的；False = 纯按时间兜底（计入统计）。
    """
    step = 0
    while True:
        now = time.ticks_ms()
        late = time.ticks_diff(now, ready_ms)
        if late >= -30:
            ir = _is_recording()
            if ir is not None and ir < 2:
                return True
            if late >= 150:
                return False
        if cfg.VISUAL_ENABLED and levels:
            ui._vis_set_level(levels[step % len(levels)])
            ui.visual_tick()
            step += 1
        time.sleep_ms(10)


def _mic_chunks(stats):
    """逐块产出录满的缓冲（bytearray，调用方要留就自己 bytes() 复制）。

    产出的那块在调用方处理完、下一次 next() 时才重新排队，所以处理期间
    它不会被硬件改写；另一块此刻正在录。
    """
    rate = cfg.SAMPLE_RATE
    chunk_ms = int(cfg.CHUNK_SEC * 1000)
    levels = [0] * 5
    if not cfg.MIC_GAPLESS:
        buf = bytearray(cfg.CHUNK_SIZE)
        while True:
            Mic.record(buf, rate)
            # Mic.record 是异步的：等待缓冲填满的这段时间正好拿来跑动画
            ui._vis_wait(cfg.CHUNK_SEC + 0.05, levels)
            levels = yield buf
    bufs = [bytearray(cfg.CHUNK_SIZE), bytearray(cfg.CHUNK_SIZE)]
    Mic.record(bufs[0], rate)
    t0 = time.ticks_ms()
    Mic.record(bufs[1], rate)
    k = 0
    while True:
        ready = time.ticks_add(t0, (k + 1) * chunk_ms)
        if not _wait_until(ready, levels):
            stats["tmo"] = stats.get("tmo", 0) + 1
        if time.ticks_diff(time.ticks_ms(), ready) > chunk_ms:
            # 处理太慢、两块都录完了还没排上：这里会有一个缝，记下来
            stats["late"] = stats.get("late", 0) + 1
        buf = bufs[k % 2]
        levels = yield buf
        Mic.record(buf, rate)
        k += 1


_rec_buf = None      # 录音缓冲：44 字节 WAV 头 + rec_max_chunks 块 PCM，开机分配一次
_rec_mv = None
rec_max_chunks = 0


def alloc_rec_buf():
    """开机时（堆还没碎）一次性分配录音缓冲。分配不到就降级，返回实际块数。

    逐块 bytes() 存列表、再 join、再拼 WAV 头，30 秒录音峰值要三份近 1MB；
    整块预留后录音直接写进去，上传也直接传 memoryview，一份都不多复制。
    """
    global _rec_buf, _rec_mv, rec_max_chunks
    if _rec_buf is not None:
        return rec_max_chunks
    for n in (cfg.MAX_CHUNKS, 80, 40):
        if n > cfg.MAX_CHUNKS:
            continue
        try:
            _rec_buf = bytearray(44 + n * cfg.CHUNK_SIZE)
            _rec_mv = memoryview(_rec_buf)
            rec_max_chunks = n
            return n
        except MemoryError:
            gc.collect()
    return 0


def _record_audio():
    """
    启动麦克风，用 VAD 检测说话，返回整段 WAV（memoryview，含 44 字节头）。
    无说话返回 b""。
    若用户在录音期间长按屏幕，立即停止录音并返回 None（哨兵，表示用户主动中断）。

    **返回值指向共享缓冲**：下一次录音会覆盖它，用完（上传/转 base64）再录下一段。
    """
    global last_rec
    cfg.St.stage = "rec"
    if not alloc_rec_buf():
        print("rec buffer alloc failed")
        return b""
    warm = hw._mic_on()          # 刚开麦：第一块常带启动爆音，丢掉
    th = cfg.SILENCE_THRESHOLD
    hands_free = cfg.St.continuous or cfg.St.wake
    if hands_free:
        # 免手模式没有"按一下才听"这道闸，门槛抬高一点：对着设备说话的人
        # 离得近、声音大，远处的电视声和隔壁说话大多够不着
        th = int(th * cfg.HANDS_FREE_TH_RATIO)
    th_end = int(th * cfg.VAD_END_RATIO)
    stats = {"th": th}
    voiced = 0                   # 开口后够响的块数：只响一下的磕碰声凑不够
    pre = []
    nchunks = 0
    csz = cfg.CHUNK_SIZE
    rmv = _rec_mv
    silent, waited, started, peak = 0, 0, False, 0
    t_start = time.ticks_ms()
    gen = _mic_chunks(stats)
    buf = next(gen)
    try:
        while True:
            hw._wdt_feed()   # 等 10s + 录 30s，喂狗防误咬
            # 触摸优先于录音：
            #   长按 = 退出当前模式（任何模式）；
            #   连续/唤醒模式下轻点也退出——旧版只认长按，而长按只在"正在听"
            #   的那几秒里有效，播放中一碰就只是打断播放，下一轮又开始听，
            #   用户很难掐准时机，表现就是"退不出去只能关机"；
            #   单次模式下轻点 = 我说完了，立刻发送（没开口就是取消）。
            t, _ = hw.check_touch()
            if t == 'long' or (t == 'short' and hands_free):
                return None          # 哨兵：用户请求退出当前模式
            if t == 'short':
                stats["tap"] = 1
                break
            sub, level = hw.rms_slices(buf)
            if warm:
                warm = False
            elif not started:
                # 起说：整块够响，或 5 个 50ms 子片里有 2 个够响（短促的字）。
                # 只有 1 个子片冒尖多半是磕碰声，不算
                loud = 0
                for v in sub:
                    if v > th:
                        loud += 1
                if level > th or loud >= 2:
                    started = True
                    for c in pre:
                        rmv[44 + nchunks * csz:44 + (nchunks + 1) * csz] = c
                        nchunks += 1
                    pre = []
                    rmv[44 + nchunks * csz:44 + (nchunks + 1) * csz] = buf
                    nchunks += 1
                    peak = level
                    voiced = 1
                else:
                    pre.append(bytes(buf))
                    if len(pre) > cfg.PREROLL_CHUNKS:
                        pre.pop(0)
                    waited += 1
                    if waited >= cfg.MAX_WAIT_CHUNKS:
                        break
            else:
                rmv[44 + nchunks * csz:44 + (nchunks + 1) * csz] = buf
                nchunks += 1
                if level > peak:
                    peak = level
                if level > th:
                    voiced += 1
                if level > th_end or max(sub) > th:
                    silent = 0
                else:
                    silent += 1
                    if silent >= cfg.SILENCE_CHUNKS:
                        break
                if nchunks >= rec_max_chunks:
                    stats["cut"] = 1        # 说满上限被截断（不是自然停顿结束）
                    break
            buf = gen.send(sub)
    finally:
        hw._mic_off()
        stats["n"] = nchunks
        stats["peak"] = peak
        stats["ms"] = time.ticks_diff(time.ticks_ms(), t_start)
        last_rec = stats
    if nchunks and voiced < cfg.MIN_VOICED_CHUNKS and not stats.get("tap"):
        # 开口后够响的只有一块：拍桌子、关门、咳一声。不上传——
        # 上传了百度认不出，连续模式下就是一轮白白的"没听清"
        stats["noise"] = 1
        return b""
    if not nchunks:
        return b""
    n = nchunks * csz
    rmv[0:44] = hw.make_wav_header(n)
    return rmv[:44 + n]


def rec_summary():
    """最近一次录音的一行摘要：n=块数 peak=最高电平 th=门槛 ms=总耗时，
    tmo=isRecording 没确认的次数（多 = 固件语义不符，退回按时间），
    late=处理跟不上产生的缝（应为 0）。"""
    r = last_rec
    return "rec n={} peak={} th={} ms={} tmo={} late={}{}{}{}".format(
        r.get("n"), r.get("peak"), r.get("th"), r.get("ms"),
        r.get("tmo", 0), r.get("late", 0), " CUT" if r.get("cut") else "",
        " NOISE" if r.get("noise") else "", " TAP" if r.get("tap") else "")


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
            if size == 0 and total > 44:
                # 长度未知（边生成边播的流，头里的长度是占位值）：写完回填真实长度，
                # 否则 playWavFile 会按占位长度读到文件外
                f.seek(0)
                f.write(hw.make_wav_header(total - 44))
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


# ── 边下边播 ──────────────────────────────────────────────────
#
# M5Unified 的扬声器每个通道有两个槽：一个在播、一个排队。内存里的
# playWav/playRaw 只是把缓冲挂进槽就返回（非阻塞），所以三块缓冲轮转：
# 一块在播、一块排队、一块在收网络数据。往第 k 块写数据之前，第 k-3 块
# 必须已经播完——"队列有空位"时就保证了这一点（在播的只剩 k-1）。
#
# 每块前面留 44 字节写一个迷你 WAV 头，交给 playWav 解析：不依赖 playRaw
# 在 MicroPython 绑定里把缓冲当 int8 还是 int16 的不确定性。

last_play = {}      # 最近一次流式播放的统计，调用方写进诊断日志
_stream_bad = False  # 本次开机已确认内存播放不出声 → 直接走落盘


def _spk_depth():
    """通道队列深度 0/1/2；固件不支持按通道查询时返回 None（退回按时间估）。"""
    try:
        v = Speaker.isPlaying(cfg.STREAM_CH)
        if v is True or v is False:
            return None
        return int(v)
    except Exception:
        return None


def _spk_any():
    try:
        return bool(Speaker.isPlaying())
    except Exception:
        return False


def _touched():
    M5.update()
    return M5.Touch.getCount() > 0


def _read_full(raw, mv):
    """把 mv 读满或读到 EOF，返回读到的字节数。读的间隙喂狗、泵 MQTT。"""
    got = 0
    n = len(mv)
    while got < n:
        hw._wdt_feed()
        r = raw.readinto(mv[got:])
        if not r:
            break
        got += r
        _pump_safe()
    return got


class _Prefixed:
    """把已经读出来的字节"塞回"流的前面，供退回落盘路径时接着读。"""

    def __init__(self, head, raw):
        self._h = head
        self._raw = raw

    def readinto(self, buf):
        if self._h:
            n = len(self._h)
            if n > len(buf):
                n = len(buf)
            buf[:n] = self._h[:n]
            self._h = self._h[n:]
            return n
        return self._raw.readinto(buf)


class _Resp:
    def __init__(self, raw, size):
        self.raw = raw
        self.headers = {"Content-Length": str(size)}


def _fallback(resp, raw, head):
    """内存播放不可用：把已读出的字节接回流前面，走原来的落盘 + play_file。"""
    try:
        size = int(resp.headers.get("Content-Length", 0) or 0)
    except (ValueError, TypeError, AttributeError):
        size = 0
    n = save_stream(_Resp(_Prefixed(head, raw), size))
    if n > 0:
        play_file()
    return n


def stream_play(resp):
    """边下边播 HTTP 响应里的 WAV，返回收到的字节数（-1=失败）。触摸可中断。

    固件不给 raw、或关了 PLAY_STREAMING、或之前探测过内存播放不出声，
    就走老路 save_stream + play_file。
    """
    global last_play, _stream_bad
    raw = getattr(resp, "raw", None)
    if (not cfg.PLAY_STREAMING or _stream_bad
            or raw is None or not hasattr(raw, "readinto")):
        n = save_stream(resp)
        if n > 0:
            play_file()
        last_play = {"mode": "file", "kb": n >> 10 if n > 0 else 0}
        return n

    cfg.St.stage = "play"
    hw._mic_off()          # Mic/Speaker 共享音频通路
    blk = cfg.STREAM_BLOCK_BYTES
    bufs = [bytearray(44 + blk) for _ in range(3)]
    mvs = [memoryview(b) for b in bufs]
    t0 = time.ticks_ms()
    stats = {"mode": "stream", "gaps": 0}
    last_play = stats
    try:
        src_hdr = bytearray(44)
        if _read_full(raw, memoryview(src_hdr)) < 44:
            return -1
        total = 44
        Speaker.begin()
        Speaker.setVolumePercentage(hw._volume)
        lens = [0, 0, 0]       # 每块缓冲当前装的 PCM 字节数
        k = 0                  # 已填满的块数
        queued = 0             # 已交给扬声器的块数
        ends = []              # 每块的预计播完时刻（isPlaying 不支持按通道时用）
        stopped = False
        while True:
            i = k % 3
            n = _read_full(raw, mvs[i][44:])
            n &= ~1            # 16bit 采样边界
            if n:
                bufs[i][0:44] = hw.make_wav_header(n)
                lens[i] = n
                total += n
                k += 1
            eof = n < blk
            # 攒够预缓冲（或已经到头）才开始往扬声器里送
            while queued < k and (queued > 0 or k >= cfg.STREAM_PREBUF or eof):
                if _wait_room(queued, ends):
                    stopped = True
                    break
                j = queued % 3
                if queued >= 2 and not _spk_any():
                    stats["gaps"] += 1          # 网络跟不上，扬声器断过粮
                try:
                    Speaker.playWav(bufs[j], 1, cfg.STREAM_CH, False)
                    ok = True
                except Exception as e:      # 签名不符等：只在第一块容忍，退回落盘
                    if queued:
                        raise
                    print("stream playWav unsupported:", e)
                    ok = False
                now = time.ticks_ms()
                prev = ends[-1] if ends else now
                start = prev if time.ticks_diff(prev, now) > 0 else now
                dur = lens[j] * 1000 // (cfg.SAMPLE_RATE * 2)
                ends.append(time.ticks_add(start, dur))
                queued += 1
                if queued == 1:
                    stats["first_ms"] = time.ticks_diff(now, t0)
                    # 探测：挂槽是同步的，挂完立刻查就该在播；给 100ms 宽限
                    # 还不在播 = 本固件内存 playWav 不出声。别固定先睡再查——
                    # 短回复睡醒时早播完了，会被误判
                    t_p = time.ticks_ms()
                    while ok and not _spk_any() and time.ticks_diff(time.ticks_ms(), t_p) < 100:
                        time.sleep_ms(5)
                    if not ok or not _spk_any():
                        _stream_bad = True
                        Speaker.stop()
                        Speaker.end()
                        # 此刻 k ≤ 2，还没有缓冲被复用：按顺序把已读的拼回去
                        head = bytes(src_hdr)
                        for q in range(k):
                            head += bytes(mvs[q][44:44 + lens[q]])
                        stats["mode"] = "fallback"
                        return _fallback(resp, raw, head)
            if stopped or eof:
                break
        # 等最后几块播完
        while not stopped and _spk_any():
            hw._wdt_feed()
            if _touched():
                stopped = True
                break
            _pump_safe()
            time.sleep_ms(20)
        if stopped:
            Speaker.stop()
            time.sleep(0.2)
            hw.drain_touch()
        stats["kb"] = total >> 10
        stats["ms"] = time.ticks_diff(time.ticks_ms(), t0)
        stats["stopped"] = stopped
        return total
    except OSError as e:
        print("stream play err:", e)
        stats["err"] = str(e)
        return -1
    finally:
        time.sleep(0.15)   # 让音频信号归零，避免 Speaker.end() 产生 pop 声
        Speaker.end()
        hw._wdt_feed()


def _wait_room(queued, ends):
    """等扬声器通道腾出一个槽。返回 True = 用户触摸要求停止。

    前两块直接进（一个在播一个排队）。之后：能按通道查深度就等到 <2；
    查不了就按预计时刻等第 queued-2 块播完；扬声器已经闲了（断粮）立刻送。
    """
    if queued < 2:
        return False
    deadline = time.ticks_add(ends[queued - 2], 20)
    while True:
        hw._wdt_feed()
        if _touched():
            return True
        d = _spk_depth()
        if d is not None:
            if d < 2:
                return False
        elif time.ticks_diff(time.ticks_ms(), deadline) >= 0 or not _spk_any():
            return False
        _pump_safe()
        time.sleep_ms(10)


def stream_summary():
    p = last_play
    return "play {} kb={} first={}ms ms={} gaps={}{}".format(
        p.get("mode"), p.get("kb"), p.get("first_ms"), p.get("ms"), p.get("gaps", 0),
        " stopped" if p.get("stopped") else (" err=" + p["err"] if p.get("err") else ""))


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
    Fix 8: 启动时采样环境底噪，自动设置说话和唤醒阈值。

    旧实现取 10 次采样的**最大值** ×3：开麦头一段的启动爆音、校准那一秒
    旁边的一句话，都会被当成"底噪"，门槛跟着翻几倍，之后正常说话就再也
    触发不了。现在：丢掉开麦后的前 3 段 → 取中位数 → 封顶 VAD_MAX_THRESHOLD。
    """
    # 阈值属于 cfg，必须写 cfg.X = ...；用 global 会在本模块另建同名全局
    sample_buf = bytearray(int(16000 * 2 * 0.1))
    samples = []
    hw._mic_on()
    for i in range(13):   # 3 段预热 + 10 段采样，每段 100ms
        hw._wdt_feed()
        Mic.record(sample_buf, 16000)
        t0 = time.ticks_ms()
        time.sleep_ms(100)
        while _is_recording() and time.ticks_diff(time.ticks_ms(), t0) < 300:
            time.sleep_ms(5)
        if i >= 3:
            samples.append(hw.rms(sample_buf))
    hw._mic_off()
    samples.sort()
    noise_floor = samples[len(samples) // 2]
    cfg.NOISE_FLOOR = noise_floor
    cfg.SILENCE_THRESHOLD = min(cfg.VAD_MAX_THRESHOLD, max(200, noise_floor * 3))
    cfg.WAKE_THRESHOLD    = max(300, cfg.SILENCE_THRESHOLD * 4 // 3)
    print("校准完成：底噪={}（采样 {}），说话阈值={}，唤醒阈值={}".format(
        noise_floor, samples, cfg.SILENCE_THRESHOLD, cfg.WAKE_THRESHOLD))
