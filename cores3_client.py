import M5
from M5 import *
from hardware import *
import requests as urequests
import time
import struct
import math
import gc
import ubinascii
import ujson

# ── 服务端地址 ────────────────────────────────────────────────

# 修改为你的服务端地址
SERVER_BASE = "http://YOUR_SERVER_IP:5000"
SERVER_URL    = SERVER_BASE + "/chat"
VISION_URL    = SERVER_BASE + "/chat-vision"
PENDING_URL   = SERVER_BASE + "/pending/"
DEVICE_ID     = "cores3"

# ── 录音参数 ──────────────────────────────────────────────────

SAMPLE_RATE      = 16000
CHUNK_SEC        = 0.5
CHUNK_SIZE       = int(SAMPLE_RATE * 2 * CHUNK_SEC)
SILENCE_THRESHOLD = 500
SILENCE_CHUNKS   = 4
MAX_CHUNKS       = 20

# ── 连续对话 / 唤醒词模式 ──────────────────────────────────────

continuous_mode = False

WAKE_MODE        = False
WAKE_THRESHOLD   = 600      # 高于环境底噪，低于正常说话音量
WAKE_MIN_CHUNKS  = 2        # 至少 200ms 声音才触发
WAKE_MAX_CHUNKS  = 8        # 超过 800ms 视为持续噪音，忽略
WAKE_CHUNK_SIZE  = int(16000 * 2 * 0.1)  # 每次采样 100ms

# ── 触摸状态 ──────────────────────────────────────────────────

_touch_start = None
_touch_pos   = (0, 0)
LONG_PRESS_MS = 800         # 长按阈值（ms）
_tap_times    = []          # 用于三击检测

# ── 唤醒词检测状态 ─────────────────────────────────────────────

_wake_buf      = bytearray(WAKE_CHUNK_SIZE)
_wake_burst    = 0
_wake_in_burst = False
_wake_silent   = 0
_wake_last_ms  = 0

# ── 其他全局 ──────────────────────────────────────────────────

is_busy    = False
last_poll  = 0
POLL_INTERVAL = 3

# ── 屏幕状态 UI ───────────────────────────────────────────────
# (kaomoji, 状态文字, 主题颜色)

STATE_UI = {
    "idle":           ("(・ω・)",  "触摸屏幕说话",  0x888888),
    "listening":      ("(ﾟДﾟ)",   "等待说话...",   0xff4444),
    "recording":      ("(ﾟДﾟ)",   "录音中...",     0xff2222),  # VAD 触发后
    "processing":     ("(＠_＠)",  "思考中...",     0xffcc00),
    "playing":        ("(≧▽≦)",  "播放中...",     0x44ff44),
    "error":          ("(；ω；)",  "出错啦！",      0xff6600),
    "no_speech":      ("(　-_-)",  "没听到声音",    0x888888),
    "broadcast":      ("(＾▽＾)",  "广播消息",      0x00ccff),
    "camera":         ("(°o°)",   "拍照中...",     0xaa00ff),
    "continuous_on":  ("(＾o＾)",  "连续模式开启",  0x00ffff),
    "continuous_off": ("(・ω・)",  "连续模式关闭",  0x888888),
    "wake_on":        ("(・_・)",  "唤醒词模式",    0x00ff88),
    "wake_off":       ("(・ω・)",  "触摸模式",      0x888888),
}


def draw_state(state):
    """
    更新屏幕和 LED 到指定状态。

    屏幕布局（320×240，横屏）:
      y=0-2   : 3px 彩色顶部状态条（当前状态主题色）
      y=3-25  : 模式指示行（● 连续 / ★ 唤醒，亮色=激活）
      y=26    : 分割线
      y=27-167: 主内容区（kaomoji + 状态文字）
      y=168   : 分割线
      y=168-240: 底部触摸分区提示（[ 说话 ] | [ 拍照 ]）
    """
    face, status, color = STATE_UI.get(state, STATE_UI["idle"])
    r = (color >> 16) & 0xff
    g = (color >> 8)  & 0xff
    b = color & 0xff
    # LED 亮度降低，防止刺眼
    Rgb.setColorAll(r // 4, g // 4, b // 4)

    Widgets.fillScreen(0x1a1a1a)

    # 顶部 3px 彩色状态条
    Widgets.Line(0, 0, 320, 0, color)
    Widgets.Line(0, 1, 320, 1, color)
    Widgets.Line(0, 2, 320, 2, color)

    # 模式指示行：亮色=激活，暗灰=关闭
    cm_color = 0x00ffcc if continuous_mode else 0x3a3a3a
    wm_color = 0xffcc00 if WAKE_MODE       else 0x3a3a3a
    Widgets.Label("● 连续", 10, 6, 1, cm_color, 0x1a1a1a, Widgets.FONTS.efontCN_16)
    Widgets.Label("★ 唤醒", 115, 6, 1, wm_color, 0x1a1a1a, Widgets.FONTS.efontCN_16)

    # 分割线（模式行底边）
    Widgets.Line(0, 26, 320, 26, 0x2e2e2e)

    # 主表情（大）
    Widgets.Label(face, 40, 55, 2, color, 0x1a1a1a, Widgets.FONTS.efontCN_24)
    # 状态文字
    Widgets.Label(status, 40, 122, 2, 0xcccccc, 0x1a1a1a, Widgets.FONTS.efontCN_16)

    # 底部触摸分区（始终显示，帮助用户了解操作）
    Widgets.Line(0, 168, 320, 168, 0x2e2e2e)
    Widgets.Line(160, 169, 160, 240, 0x2e2e2e)
    Widgets.Label("[ 说话 ]", 25, 192, 1, 0x664444, 0x1a1a1a, Widgets.FONTS.efontCN_16)
    Widgets.Label("[ 拍照 ]", 185, 192, 1, 0x553366, 0x1a1a1a, Widgets.FONTS.efontCN_16)


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
    n = len(buf) // 2
    if n == 0:
        return 0
    total = 0
    for i in range(0, len(buf), 2):
        val = struct.unpack_from('<h', buf, i)[0]
        total += val * val
    return int(math.sqrt(total / n))


# ── 触摸检测 ──────────────────────────────────────────────────

def check_touch():
    """
    返回 (事件类型, 坐标)。
    事件类型: 'short' / 'long' / 'triple' / None
    坐标: (x, y) 为按下时的位置
    """
    global _touch_start, _touch_pos, _tap_times
    M5.update()
    count = M5.Touch.getCount()
    if count > 0:
        if _touch_start is None:
            _touch_start = time.ticks_ms()
            _touch_pos   = (M5.Touch.getX(0), M5.Touch.getY(0))
        return (None, (0, 0))
    else:
        if _touch_start is not None:
            duration = time.ticks_diff(time.ticks_ms(), _touch_start)
            pos      = _touch_pos
            _touch_start = None
            if duration >= LONG_PRESS_MS:
                return ('long', pos)
            elif duration > 0:
                now = time.ticks_ms()
                _tap_times.append(now)
                # 只保留最近 1500ms 内的点击
                _tap_times[:] = [t for t in _tap_times
                                 if time.ticks_diff(now, t) < 1500]
                if len(_tap_times) >= 3:
                    _tap_times.clear()
                    return ('triple', pos)
                return ('short', pos)
    return (None, (0, 0))


def drain_touch():
    """等待屏幕所有触摸点抬起。"""
    while M5.Touch.getCount() > 0:
        M5.update()
        time.sleep(0.05)


# ── 模式切换 ──────────────────────────────────────────────────

def toggle_continuous():
    """长按切换连续对话模式。开启时自动关闭声控唤醒（两者互斥）。"""
    global continuous_mode, WAKE_MODE
    continuous_mode = not continuous_mode
    if continuous_mode:
        WAKE_MODE = False   # Fix 5: 互斥
    draw_state("continuous_on" if continuous_mode else "continuous_off")
    time.sleep(1.5)
    draw_state("idle")


def toggle_wake_mode():
    """三击切换声控唤醒模式。开启时自动关闭连续对话（两者互斥）。"""
    global WAKE_MODE, continuous_mode
    WAKE_MODE = not WAKE_MODE
    if WAKE_MODE:
        continuous_mode = False   # Fix 5: 互斥
    draw_state("wake_on" if WAKE_MODE else "wake_off")
    time.sleep(1.5)
    draw_state("idle")


# ── 音频录制 ──────────────────────────────────────────────────

def _record_audio():
    """
    启动麦克风，用 VAD 检测说话，返回 PCM 数据块列表。
    无说话返回空列表。
    """
    Mic.begin()
    chunks  = []
    silent  = 0
    started = False
    for _ in range(MAX_CHUNKS):
        buf = bytearray(CHUNK_SIZE)
        Mic.record(buf, SAMPLE_RATE)
        time.sleep(CHUNK_SEC + 0.05)
        level = rms(buf)
        if level > SILENCE_THRESHOLD:
            if not started:
                started = True
                draw_state("recording")   # Fix 4: 声音检测到，切换到录音状态
            silent  = 0
            chunks.append(bytes(buf))
        elif started:
            chunks.append(bytes(buf))
            silent += 1
            if silent >= SILENCE_CHUNKS:
                break
    Mic.end()
    return chunks


# ── 播放 ──────────────────────────────────────────────────────

def play_wav(data):
    """将 WAV 数据写入 flash 并播放。触摸屏幕可随时中断播放。"""
    with open("/flash/response.wav", "wb") as f:
        f.write(data)
    Speaker.begin()
    Speaker.setVolumePercentage(0.6)
    Speaker.playWavFile("/flash/response.wav")
    while Speaker.isPlaying():
        M5.update()
        if M5.Touch.getCount() > 0:   # Fix 6: 触摸中断
            Speaker.stop()
            time.sleep(0.2)           # 让扬声器余音散去
            drain_touch()
            break
        time.sleep(0.1)
    Speaker.end()


# ── 主对话（普通） ────────────────────────────────────────────

def record_and_send():
    """
    录音 → 发送服务端 → 播放回复。
    若 continuous_mode 开启则自动进入下一轮；
    播放结束后有 1.5s 窗口，长按可退出连续模式。
    """
    global is_busy
    is_busy = True
    gc.collect()

    while True:
        draw_state("listening")
        chunks = _record_audio()

        if not chunks:
            draw_state("no_speech")
            time.sleep(1)
            if not continuous_mode:
                break
            continue

        draw_state("processing")
        audio = b''.join(chunks)
        wav   = make_wav_header(len(audio)) + audio

        try:
            resp = urequests.post(SERVER_URL, data=wav,
                                  headers={"X-Device-Id": DEVICE_ID})
            if resp.status_code != 200:
                print("chat err:", resp.text)
                resp.close()
                draw_state("error")
                time.sleep(2)
                if not continuous_mode:
                    break
                continue
            need_photo = resp.headers.get("X-Need-Photo", "") == "1"
            data = resp.content
            resp.close()
        except OSError as e:
            print("network err:", e)
            draw_state("error")
            time.sleep(2)
            if not continuous_mode:
                break
            continue

        print("WAV size:", len(data))
        draw_state("playing")
        play_wav(data)
        gc.collect()

        # ── 语音触发拍照：播完简短应答后立即拍照并发送 /chat-vision ──
        if need_photo:
            draw_state("camera")
            image_b64 = capture_photo()
            draw_state("processing")
            wav_b64 = ubinascii.b2a_base64(wav).decode("utf-8").strip()
            payload = ujson.dumps({"wav": wav_b64, "image": image_b64 or ""})
            try:
                resp2 = urequests.post(
                    VISION_URL,
                    data=payload.encode("utf-8"),
                    headers={"X-Device-Id": DEVICE_ID,
                             "Content-Type": "application/json"},
                )
                if resp2.status_code == 200:
                    data2 = resp2.content
                    resp2.close()
                    draw_state("playing")
                    play_wav(data2)
                    gc.collect()
                else:
                    resp2.close()
                    draw_state("error")
                    time.sleep(2)
            except OSError as e:
                print("vision follow-up err:", e)
                draw_state("error")
                time.sleep(2)

        if not continuous_mode:
            break

        # ── 连续模式：1.5s 退出窗口（长按退出）──────────────────
        draw_state("idle")
        t_start = time.ticks_ms()
        while time.ticks_diff(time.ticks_ms(), t_start) < 1500:
            touch, pos = check_touch()
            if touch == 'long':
                toggle_continuous()   # 关闭连续模式
                is_busy = False
                return
            time.sleep(0.05)
        drain_touch()
        # 继续下一轮

    draw_state("idle")
    time.sleep(1)
    drain_touch()
    is_busy = False


# ── 摄像头对话 ────────────────────────────────────────────────

def capture_photo():
    """
    调用 CoreS3 摄像头拍一张 QQVGA JPEG。
    返回 base64 字符串，失败返回 None。
    """
    try:
        import camera
        camera.init(0, format=camera.JPEG, framesize=camera.FRAME_QQVGA)
        time.sleep(0.3)
        img = camera.capture()
        camera.deinit()
        if img is None:
            return None
        return ubinascii.b2a_base64(img).decode("utf-8").strip()
    except Exception as e:
        print("camera error:", e)
        return None


def record_and_send_vision():
    """
    拍照 + 录音 → 发送 /chat-vision → 播放回复。
    触发方式：触摸屏幕下方区域（y > 160）。
    """
    global is_busy
    is_busy = True
    gc.collect()

    draw_state("camera")
    image_b64 = capture_photo()

    draw_state("listening")
    chunks = _record_audio()

    if not chunks:
        draw_state("no_speech")
        time.sleep(1)
        draw_state("idle")
        is_busy = False
        return

    draw_state("processing")
    audio   = b''.join(chunks)
    wav     = make_wav_header(len(audio)) + audio
    wav_b64 = ubinascii.b2a_base64(wav).decode("utf-8").strip()
    payload = ujson.dumps({"wav": wav_b64, "image": image_b64 or ""})

    try:
        resp = urequests.post(
            VISION_URL,
            data=payload.encode("utf-8"),
            headers={"X-Device-Id": DEVICE_ID,
                     "Content-Type": "application/json"},
        )
        if resp.status_code != 200:
            print("vision err:", resp.text)
            resp.close()
            draw_state("error")
            time.sleep(2)
            draw_state("idle")
            is_busy = False
            return
        data = resp.content
        resp.close()
    except OSError as e:
        print("network err:", e)
        draw_state("error")
        time.sleep(2)
        draw_state("idle")
        is_busy = False
        return

    gc.collect()
    print("Vision WAV size:", len(data))
    draw_state("playing")
    play_wav(data)
    draw_state("idle")
    time.sleep(1)
    drain_touch()
    is_busy = False


# ── 主动推送轮询 ──────────────────────────────────────────────

def check_pending():
    """轮询服务端，有推送消息则播放。"""
    global is_busy
    try:
        resp = urequests.get(PENDING_URL + DEVICE_ID)
        if resp.status_code == 204:
            resp.close()
            return
        is_busy = True
        data = resp.content
        resp.close()
        print("Push WAV size:", len(data))
        draw_state("broadcast")
        play_wav(data)
        draw_state("idle")
        Rgb.setColorAll(0, 0, 0)
        is_busy = False
    except OSError as e:
        print("pending err:", e)


# ── 主循环 ────────────────────────────────────────────────────

def calibrate_noise():
    """
    Fix 8: 启动时采样 1s 环境底噪，自动设置说话和唤醒阈值。
    阈值 = max(底噪峰值 × 倍数, 最低保障值)，避免安静环境误触发。
    """
    global SILENCE_THRESHOLD, WAKE_THRESHOLD
    Widgets.Label("校准环境噪音...", 40, 155, 1, 0x666666, 0x1a1a1a,
                  Widgets.FONTS.efontCN_16)
    sample_buf = bytearray(int(16000 * 2 * 0.1))
    samples = []
    Mic.begin()
    for _ in range(10):   # 10 × 100ms = 1s
        Mic.record(sample_buf, 16000)
        time.sleep(0.1)
        samples.append(rms(sample_buf))
    Mic.end()
    noise_floor = max(samples)
    SILENCE_THRESHOLD = max(200, noise_floor * 3)
    WAKE_THRESHOLD    = max(300, noise_floor * 4)
    print(f"校准完成：底噪={noise_floor}，说话阈值={SILENCE_THRESHOLD}，唤醒阈值={WAKE_THRESHOLD}")


def setup():
    M5.begin()
    Widgets.setRotation(1)
    Rgb.setColorAll(0, 0, 0)
    draw_state("idle")
    calibrate_noise()   # Fix 8: 自动噪音校准


def loop():
    global last_poll, _wake_burst, _wake_in_burst, _wake_silent, _wake_last_ms

    touch, pos = check_touch()

    if not is_busy:
        if touch == 'long':
            # 长按：切换连续对话模式
            toggle_continuous()
        elif touch == 'triple':
            # 三击：切换唤醒词模式
            toggle_wake_mode()
        elif touch == 'short':
            # 短按上方 → 普通对话；短按下方 → 拍照对话
            if pos[1] > 160:
                record_and_send_vision()
            else:
                record_and_send()
        elif WAKE_MODE:
            # 唤醒词检测：每 100ms 采样一次，检测短促语音爆发
            now_ms = time.ticks_ms()
            if time.ticks_diff(now_ms, _wake_last_ms) >= 100:
                _wake_last_ms = now_ms
                Mic.begin()
                Mic.record(_wake_buf, 16000)
                time.sleep(0.05)
                Mic.end()
                level = rms(_wake_buf)
                if level > WAKE_THRESHOLD:
                    if not _wake_in_burst:
                        _wake_in_burst = True
                        _wake_burst    = 0
                    _wake_burst  += 1
                    _wake_silent  = 0
                elif _wake_in_burst:
                    _wake_silent += 1
                    if _wake_silent >= 2:
                        # 声音爆发时长在合理范围内 → 触发录音
                        if WAKE_MIN_CHUNKS <= _wake_burst <= WAKE_MAX_CHUNKS:
                            record_and_send()
                        _wake_burst    = 0
                        _wake_in_burst = False
                        _wake_silent   = 0

    # 推送消息轮询
    now = time.time()
    if not is_busy and now - last_poll > POLL_INTERVAL:
        last_poll = now
        check_pending()


if __name__ == '__main__':
    setup()
    while True:
        loop()
