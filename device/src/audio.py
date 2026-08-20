"""Kagura Voice 设备端 —— 音频：录音 VAD、播放、包络计算、开机噪声校准。
"""

import M5
from M5 import *
from hardware import *
import time
import struct
import math

import cfg
import hw
import ui

# ── 回调注入：打断 audio ↔ netsvc 的环 ────────────────────────
# play_wav 长播放期间要泵一下 MQTT 维持心跳，而 netsvc 收到推送又要回调
# play_wav——直接 import 就成环（tools/check_split.py 会拦下）。
# 由 app.setup() 注入：audio.set_pump(netsvc.mqtt_check)
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

def play_wav(data):
    """将 WAV 数据写入 flash 并播放。触摸屏幕可随时中断播放。"""
    hw._mic_off()   # Mic/Speaker 共享音频通路：播放前确保麦克风已释放
    # 先算包络：播放时按 elapsed 索引，环随语音起伏（不占播放时间）
    env = _wav_envelope(data) if cfg.VISUAL_ENABLED else []
    with open(cfg.data("response.wav"), "wb") as f:
        f.write(data)
    Speaker.begin()
    Speaker.setVolumePercentage(hw._volume)
    Speaker.playWavFile(cfg.data("response.wav"))
    t0 = time.ticks_ms()
    while Speaker.isPlaying():
        hw._wdt_feed()   # 长音频播放可超过 WDT 窗口
        M5.update()
        if M5.Touch.getCount() > 0:   # Fix 6: 触摸中断
            Speaker.stop()
            time.sleep(0.2)           # 让扬声器余音散去
            hw.drain_touch()
            break
        if env:
            idx = time.ticks_diff(time.ticks_ms(), t0) // 100
            ui._vis_set_level_norm(env[idx] if idx < len(env) else 0.0)
            ui.visual_tick()
        hw._wdt_feed()
        _pump_safe()          # 长播放期间维持心跳（回调只入队，不会嵌套播放）
        time.sleep(0.05)
    ui._vis_set_level_norm(0.0)
    ui.visual_tick(force=True)
    time.sleep(0.15)   # 让音频信号归零，避免 Speaker.end() 产生 pop 声
    Speaker.end()


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
