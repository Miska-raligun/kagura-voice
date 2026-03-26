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
    "listening":      ("(ﾟДﾟ)",   "聆听中...",     0xff4444),
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
    """更新屏幕和 LED 到指定状态。"""
    face, status, color = STATE_UI.get(state, STATE_UI["idle"])
    r = (color >> 16) & 0xff
    g = (color >> 8)  & 0xff
    b = color & 0xff
    # LED 亮度降低，防止刺眼
    Rgb.setColorAll(r // 4, g // 4, b // 4)
    Widgets.fillScreen(0x222222)
    # 上方大表情（efontCN_24 支持中文及常用 Unicode）
    Widgets.Label(face, 30, 60, 2, color, 0x222222, Widgets.FONTS.efontCN_24)
    # 下方状态文字
    Widgets.Label(status, 30, 150, 2, 0xffffff, 0x222222, Widgets.FONTS.efontCN_16)
    # 空闲时显示触摸区域提示
    if state == "idle":
        Widgets.Label("[下方触摸:拍照]", 150, 210, 1, 0x444444, 0x222222,
                      Widgets.FONTS.efontCN_16)


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
    """长按切换连续对话模式。"""
    global continuous_mode
    continuous_mode = not continuous_mode
    draw_state("continuous_on" if continuous_mode else "continuous_off")
    time.sleep(1.5)
    draw_state("idle")


def toggle_wake_mode():
    """三击切换唤醒词模式（不需要触摸即可激活录音）。"""
    global WAKE_MODE
    WAKE_MODE = not WAKE_MODE
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
            started = True
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
    """将 WAV 数据写入 flash 并播放。"""
    with open("/flash/response.wav", "wb") as f:
        f.write(data)
    Speaker.begin()
    Speaker.setVolumePercentage(0.6)
    Speaker.playWavFile("/flash/response.wav")
    while Speaker.isPlaying():
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

def setup():
    M5.begin()
    Widgets.setRotation(1)
    Rgb.setColorAll(0, 0, 0)
    draw_state("idle")


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
