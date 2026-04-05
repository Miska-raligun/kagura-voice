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
import usocket

# ── RGB LED 安全封装（CoreS3 SE 无 RGB）──────────────────────
try:
    _has_rgb = Rgb is not None
except NameError:
    _has_rgb = False


def _set_led(r, g, b):
    if _has_rgb:
        try:
            Rgb.setColorAll(r, g, b)
        except:
            pass

# ── 字体 ───────────────────────────────────────────────────────
_FONT_16 = Widgets.FONTS.DejaVu18

# ── 服务端地址 ────────────────────────────────────────────────

# UDP 发现失败时的 fallback 地址
SERVER_BASE = "http://192.168.31.66:5000"
SERVER_URL    = SERVER_BASE + "/chat"
VISION_URL    = SERVER_BASE + "/chat-vision"
DEVICE_ID     = "cores3"
MQTT_BROKER   = "192.168.31.66"

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

# ── 自动休眠 ────────────────────────────────────────────────
SLEEP_TIMEOUT  = 300         # 5 分钟无操作后息屏
_last_activity = 0
_is_sleeping   = False

# ── 屏幕状态 UI ───────────────────────────────────────────────
# (kaomoji, 状态文字, 主题颜色)

STATE_UI = {
    "idle":           ("(^w^)",   "Touch to talk",    0x888888),
    "recording":      ("(O_O)",   "Recording...",      0xff4444),  # Bug 4 Fix: 合并 listening/recording
    "processing":     ("(@_@)",   "Thinking...",       0xffcc00),
    "playing":        ("(>v<)",   "Talking...",        0x44ff44),
    "error":          ("(;_;)",   "Error!",            0xff6600),
    "no_speech":      ("(-_-)",   "No speech",         0x888888),
    "broadcast":      ("(^o^)",   "Talking...",        0x00ccff),
    "camera":         ("(0o0)",   "Camera...",         0xaa00ff),
    "continuous_on":  ("(^o^)",   "Continuous ON",     0x00ffff),
    "continuous_off": ("(^w^)",   "Continuous OFF",    0x888888),
    "wake_on":        ("(-_-)",   "Wake mode ON",      0x00ff88),
    "wake_off":       ("(^w^)",   "Wake mode OFF",     0x888888),
    "discovering":    ("(o_o)",   "Searching...",      0xffaa00),
}


def draw_state(state):
    """
    更新屏幕和 LED 到指定状态。

    屏幕布局（320×240，横屏）:
      y=0-2   : 3px 彩色顶部状态条
      y=3-25  : 顶部信息行（左:CONT  中:WAKE  右:电量%）
      y=26    : 分割线
      y=27-240: 主内容区（大号 kaomoji + 小号状态文字）
    """
    face, status, color = STATE_UI.get(state, STATE_UI["idle"])
    r = (color >> 16) & 0xff
    g = (color >> 8)  & 0xff
    b = color & 0xff
    _set_led(r // 4, g // 4, b // 4)

    # ── 步骤 1：背景层（图片优先，全屏 320×240 从 0,0 开始）────────
    _IMG_MAP = {
        "recording":  "img_recording",
        "processing": "img_processing",
        "playing":    "img_playing",
        "broadcast":  "img_playing",   # broadcast 复用 playing 图片
    }
    img_name = _IMG_MAP.get(state)
    img_shown = False
    if img_name:
        try:
            with open("/flash/{}.jpg".format(img_name), "rb") as _f:
                Lcd.drawJpg(_f.read(), 0, 0)
            img_shown = True
        except Exception as e:
            print("img err:", e)
    if not img_shown:
        try:
            with open("/flash/img_bg.jpg", "rb") as _f:
                Lcd.drawJpg(_f.read(), 0, 0)
            img_shown = True
        except Exception:
            Widgets.fillScreen(0x1a1a1a)

    # ── 步骤 2：彩色状态条 + 标签（透明背景，悬浮在图片上）──────
    Widgets.Line(0, 0, 320, 0, color)
    Widgets.Line(0, 1, 320, 1, color)
    Widgets.Line(0, 2, 320, 2, color)
    cm_color = 0x00ffcc if continuous_mode else 0x3a3a3a
    wm_color = 0xffcc00 if WAKE_MODE       else 0x3a3a3a
    Lcd.setFont(_FONT_16)
    Lcd.setTextSize(1)
    Lcd.setTextColor(cm_color, cm_color)
    Lcd.drawString("CONT", 10, 6)
    Lcd.setTextColor(wm_color, wm_color)
    Lcd.drawString("WAKE", 90, 6)
    try:
        v = M5.Power.getBatteryVoltage()   # mV，3000-4200
        bat = max(0, min(100, (v - 3000) * 100 // 1200))
        bat_str = "{}%".format(bat)
    except Exception:
        bat_str = "--"
    bat_x = max(220, 310 - len(bat_str) * 10)
    Lcd.setTextColor(0x666666, 0x666666)
    Lcd.drawString(bat_str, bat_x, 6)

    # ── 步骤 3：非图片状态显示 kaomoji（透明背景，悬浮在背景图上）──
    if not img_shown:
        face_x = max(0, (320 - len(face) * 34) // 2)
        Lcd.setFont(_FONT_16)
        Lcd.setTextSize(3)
        Lcd.setTextColor(color, color)
        Lcd.drawString(face, face_x, 90)

    # ── 步骤 4：状态文字（透明背景，悬浮在图片上）────────────────
    status_x = max(0, (320 - len(status) * 11) // 2)
    txt_color = 0xffffff if img_shown else 0x999999
    Lcd.setFont(_FONT_16)
    Lcd.setTextSize(1)
    Lcd.setTextColor(txt_color, txt_color)
    Lcd.drawString(status, status_x, 216)


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
            _touch_pos   = (M5.Touch.getX(), M5.Touch.getY())
        return (None, (0, 0))
    else:
        if _touch_start is not None:
            duration = time.ticks_diff(time.ticks_ms(), _touch_start)
            pos      = _touch_pos
            _touch_start = None
            if duration >= LONG_PRESS_MS:
                _tap_times.clear()   # Bug 3 Fix: 防止长按后残留点击记录意外触发三击
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
        WAKE_MODE = False
    draw_state("continuous_on" if continuous_mode else "continuous_off")
    time.sleep(0.8)   # Bug 3 Fix: 1.5→0.8s，缩短切换反馈时间
    draw_state("idle")


def toggle_wake_mode():
    """三击切换声控唤醒模式。开启时自动关闭连续对话（两者互斥）。"""
    global WAKE_MODE, continuous_mode
    WAKE_MODE = not WAKE_MODE
    if WAKE_MODE:
        continuous_mode = False
    draw_state("wake_on" if WAKE_MODE else "wake_off")
    time.sleep(0.8)   # Bug 3 Fix: 1.5→0.8s，缩短切换反馈时间
    draw_state("idle")


# ── 音频录制 ──────────────────────────────────────────────────

def _record_audio():
    """
    启动麦克风，用 VAD 检测说话，返回 PCM 数据块列表。
    无说话返回空列表 []。
    若用户在录音期间长按屏幕，立即停止录音并返回 None（哨兵，表示用户主动中断）。
    """
    Mic.begin()
    chunks, silent, started = [], 0, False
    for _ in range(MAX_CHUNKS):
        buf = bytearray(CHUNK_SIZE)
        Mic.record(buf, SAMPLE_RATE)
        time.sleep(CHUNK_SEC + 0.05)
        # 长按优先检测：优先级高于录音，continuous/wake 模式均可退出
        t, _ = check_touch()
        if t == 'long':
            Mic.end()
            return None          # 哨兵：用户请求退出当前模式
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
    time.sleep(0.15)   # 让音频信号归零，避免 Speaker.end() 产生 pop 声
    Speaker.end()


# ── 主对话（普通） ────────────────────────────────────────────

def record_and_send():
    """
    录音 → 发送服务端 → 播放回复。
    若 continuous_mode 开启则自动进入下一轮；
    播放结束后有 1.5s 窗口，长按可退出连续模式。
    """
    global is_busy, _last_activity
    is_busy = True
    _last_activity = time.time()
    gc.collect()

    while True:
        draw_state("recording")
        chunks = _record_audio()

        if chunks is None:         # 用户长按中断录音 → 退出当前模式
            if continuous_mode:
                toggle_continuous()
            elif WAKE_MODE:
                toggle_wake_mode()
            is_busy = False
            return

        if not chunks:
            draw_state("no_speech")
            time.sleep(1)
            if not continuous_mode:
                break
            continue

        draw_state("processing")
        audio = b''.join(chunks)
        wav   = make_wav_header(len(audio)) + audio
        del chunks, audio   # wav 已包含全部数据，释放 ~96KB
        gc.collect()

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
            del data      # 回复 WAV 已写入 flash 并播完，释放 ~52KB 给摄像头
            gc.collect()
            wav_b64 = ubinascii.b2a_base64(wav).decode("utf-8").strip()
            del wav       # base64 字符串已持有数据，释放原始 bytes (~48KB)
            gc.collect()
            draw_state("camera")
            image_b64 = capture_photo()
            draw_state("processing")
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

        # ── 连续模式：轮间检查主动播报 ───────────────────────────
        mqtt_check()

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

_camera_inited = False

def capture_photo():
    """
    调用 CoreS3 摄像头拍一张 QQVGA raw RGB565 帧。
    首次调用时初始化摄像头，之后保持常驻（不 deinit）。
    返回 base64 字符串（无换行），失败返回 None。
    """
    global _camera_inited
    import camera

    if not _camera_inited:
        print("camera: initializing...")
        try:
            camera.init()
            _camera_inited = True
            print("camera: init OK")
        except Exception as e:
            print("camera init error:", e)
            return None

    time.sleep(0.3)   # 等待曝光稳定（替代 skip_frames）

    print("camera: capturing...")
    try:
        img = camera.capture()
    except Exception as e:
        print("camera capture error:", e)
        return None

    if img is None or isinstance(img, bool):
        print("camera: capture returned", img)
        return None

    print("camera: raw size =", len(img))
    b64 = ubinascii.b2a_base64(img).decode("utf-8").replace("\n", "").replace("\r", "")
    gc.collect()
    return b64


def record_and_send_vision():
    """
    拍照 + 录音 → 发送 /chat-vision → 播放回复。
    触发方式：触摸屏幕下方区域（y > 160）。
    """
    global is_busy, _last_activity
    is_busy = True
    _last_activity = time.time()
    gc.collect()

    draw_state("camera")
    image_b64 = capture_photo()

    draw_state("recording")   # Bug 4 Fix: 立刻显示录音状态
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


# ── MQTT 推送订阅 ─────────────────────────────────────────────

_mqtt = None


def _mqtt_callback(topic, msg):
    """收到服务端推送的 WAV bytes → 播放。休眠中自动唤醒。"""
    global _last_activity
    print("MQTT push:", len(msg), "bytes")
    if _is_sleeping:
        wake_up()
    _last_activity = time.time()
    draw_state("broadcast")
    play_wav(msg)
    draw_state("idle")
    _set_led(0, 0, 0)


def init_mqtt():
    """连接 MQTT broker 并订阅推送 topic。"""
    global _mqtt
    try:
        from umqtt.robust import MQTTClient
        client = MQTTClient(DEVICE_ID, MQTT_BROKER, port=1883, keepalive=60)
        client.set_callback(_mqtt_callback)
        client.connect()
        client.subscribe("kagura/push/{}".format(DEVICE_ID))
        _mqtt = client
        print("MQTT connected:", MQTT_BROKER)
    except Exception as e:
        print("MQTT init error:", e)
        _mqtt = None


def mqtt_check():
    """主循环调用：非阻塞检查是否有待处理的 MQTT 消息。"""
    if _mqtt:
        try:
            _mqtt.check_msg()
        except Exception as e:
            print("MQTT check error:", e)


# ── 主循环 ────────────────────────────────────────────────────

def enter_sleep():
    """息屏休眠：关闭背光和 LED。"""
    global _is_sleeping
    _is_sleeping = True
    _set_led(0, 0, 0)
    M5.Lcd.setBrightness(0)


def wake_up():
    """唤醒：恢复背光，重置活动计时。"""
    global _is_sleeping, _last_activity
    _is_sleeping = False
    _last_activity = time.time()
    M5.Lcd.setBrightness(64)
    draw_state("idle")


def calibrate_noise():
    """
    Fix 8: 启动时采样 1s 环境底噪，自动设置说话和唤醒阈值。
    阈值 = max(底噪峰值 × 倍数, 最低保障值)，避免安静环境误触发。
    """
    global SILENCE_THRESHOLD, WAKE_THRESHOLD
    #Widgets.Label("Calibrating...", 40, 155, 1, 0x666666, 0x1a1a1a,_FONT_16)
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


# ── UDP 自动发现服务端 ────────────────────────────────────────────────────────

_DISC_PORT    = 5001
_DISC_MSG     = b"KAGURA_DISCOVER"
_DISC_TIMEOUT = 2
_DISC_RETRIES = 3

def discover_server():
    """
    广播 KAGURA_DISCOVER，从回包源地址更新 SERVER_BASE 等全局变量。
    失败则保留硬编码 fallback 地址（最多等待 6 秒）。
    """
    global SERVER_BASE, SERVER_URL, VISION_URL, MQTT_BROKER

    draw_state("discovering")

    sock = usocket.socket(usocket.AF_INET, usocket.SOCK_DGRAM)
    try:
        try:
            sock.setsockopt(usocket.SOL_SOCKET, usocket.SO_BROADCAST, 1)
        except Exception:
            pass   # 部分固件无此常量，ESP32 lwIP 默认允许广播

        sock.settimeout(_DISC_TIMEOUT)

        for attempt in range(1, _DISC_RETRIES + 1):
            print("discovery attempt", attempt)
            try:
                sock.sendto(_DISC_MSG, ("255.255.255.255", _DISC_PORT))
                data, addr = sock.recvfrom(32)
                if data.strip() == b"KAGURA_HERE":
                    ip = addr[0]
                    SERVER_BASE = "http://{}:5000".format(ip)
                    SERVER_URL  = SERVER_BASE + "/chat"
                    VISION_URL  = SERVER_BASE + "/chat-vision"
                    MQTT_BROKER = ip
                    print("discovered:", SERVER_BASE)
                    return True
            except OSError:
                pass   # timeout，继续下一次

        print("discovery failed, fallback:", SERVER_BASE)
        return False
    finally:
        sock.close()


def setup():
    global _last_activity
    M5.begin()
    Widgets.setRotation(1)
    _set_led(0, 0, 0)
    draw_state("idle")
    discover_server()
    init_mqtt()
    draw_state("idle")       # 发现完成后恢复空闲界面
    calibrate_noise()
    _last_activity = time.time()


def loop():
    global _last_activity, _wake_burst, _wake_in_burst, _wake_silent, _wake_last_ms

    touch, pos = check_touch()

    # ── 休眠中：触摸仅唤醒，不执行其他操作 ──
    if _is_sleeping:
        if touch is not None:
            wake_up()
            drain_touch()
    elif not is_busy:
        if touch is not None:
            _last_activity = time.time()
        if touch == 'long':
            toggle_continuous()          # 长按：切换连续模式（在模式内再次长按则退出）
        elif touch == 'triple':
            toggle_wake_mode()           # 三击：切换唤醒模式（在模式内再次三击则退出）
        elif touch == 'short':
            # 350ms 等待窗口：判断是否为三击的第一击
            triggered = False
            t0 = time.ticks_ms()
            while time.ticks_diff(time.ticks_ms(), t0) < 350:
                t2, _ = check_touch()
                if t2 == 'triple':
                    toggle_wake_mode()
                    triggered = True
                    break
                elif t2 == 'short':
                    t0 = time.ticks_ms()   # 有第二击，重置计时等待第三击
                time.sleep(0.05)
            if not triggered:
                record_and_send()
        elif WAKE_MODE:
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
                        if WAKE_MIN_CHUNKS <= _wake_burst <= WAKE_MAX_CHUNKS:
                            _last_activity = time.time()
                            record_and_send()
                        _wake_burst    = 0
                        _wake_in_burst = False
                        _wake_silent   = 0

    # MQTT 推送消息（非阻塞，回调在 _mqtt_callback 中处理）
    mqtt_check()

    # ── 自动休眠检查 ──
    now = time.time()
    if not _is_sleeping and not is_busy:
        if now - _last_activity > SLEEP_TIMEOUT:
            enter_sleep()


if __name__ == '__main__':
    setup()
    while True:
        loop()
