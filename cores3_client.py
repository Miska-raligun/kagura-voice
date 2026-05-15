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
import uos
import network

# ── RGB LED 安全封装（CoreS3 SE 无 RGB）──────────────────────
try:
    _has_rgb = Rgb is not None
except NameError:
    _has_rgb = False


def _set_led(r, g, b):
    if _has_rgb:
        try:
            Rgb.setColorAll(r, g, b)
        except Exception:
            pass

# ── 字体 ───────────────────────────────────────────────────────
_FONT_16 = Widgets.FONTS.DejaVu18

# ── 服务端地址 ────────────────────────────────────────────────

# UDP 发现失败时的 fallback 地址
SERVER_BASE = "http://192.168.31.66:5000"
SERVER_URL    = SERVER_BASE + "/chat"
VISION_URL    = SERVER_BASE + "/chat-vision"
UPLOAD_URL    = SERVER_BASE + "/upload-photo"
DEVICE_ID     = "cores3"
MQTT_BROKER   = "192.168.31.66"

# ── 网络超时 ──────────────────────────────────────────────────
# 服务端处理包含 LLM 推理，时间较长；设备无线程，超时可避免永久挂起
REQUEST_TIMEOUT_CHAT  = 30   # /chat、/chat-vision（含 LLM 推理）
REQUEST_TIMEOUT_SHORT = 10   # /time、/shake、/presence 等短请求
REQUEST_TIMEOUT_UPLOAD = 15  # /upload-photo

# ── 录音参数 ──────────────────────────────────────────────────

SAMPLE_RATE      = 16000
CHUNK_SEC        = 0.5
CHUNK_SIZE       = int(SAMPLE_RATE * 2 * CHUNK_SEC)
SILENCE_THRESHOLD = 500   # RMS 低于此值视为静音
SILENCE_CHUNKS   = 4      # 连续 N 个静音块后停止录音
MAX_CHUNKS       = 20     # 最大录音块数（上限：MAX_CHUNKS × CHUNK_SEC 秒）

# ── 连续对话 / 唤醒词模式 ──────────────────────────────────────

continuous_mode = False

WAKE_MODE        = False
WAKE_THRESHOLD   = 600      # 高于环境底噪，低于正常说话音量
WAKE_CHUNK_SIZE  = int(16000 * 2 * 0.1)  # 每次采样 100ms
WAKE_LOUD_NEED   = 3        # 连续 N 次超阈值触发（N×100ms）

# ── 触摸状态 ──────────────────────────────────────────────────

_touch_start = None
_touch_pos   = (0, 0)
LONG_PRESS_MS = 800         # 长按阈值（ms）

# ── 唤醒词检测状态 ─────────────────────────────────────────────

_wake_buf        = bytearray(WAKE_CHUNK_SIZE)
_wake_last_ms    = 0
_wake_loud_count = 0

_mqtt_last_ping  = 0         # 上次 MQTT ping 时间

# ── 其他全局 ──────────────────────────────────────────────────

is_busy    = False

# ── 自动休眠 ────────────────────────────────────────────────
SLEEP_TIMEOUT  = 300         # 5 分钟无操作后息屏
_last_activity = 0
_is_sleeping   = False

# ── BLE 在家感知 ─────────────────────────────────────────────
BLE_PHONE_NAME    = ""       # 用户手机蓝牙名称（部分匹配），为空则禁用
BLE_SCAN_INTERVAL = 30       # 扫描间隔（秒）
BLE_SCAN_DURATION = 3000     # 每次扫描时长（毫秒）
BLE_RSSI_THRESHOLD = -70     # RSSI 阈值（> 此值视为在附近）
BLE_HOME_COUNT    = 2        # 连续检测到 N 次 → 判定在家
BLE_AWAY_TIMEOUT  = 300      # 未检测到 N 秒 → 判定出门

_ble = None
_ble_phone_found  = False    # 本次扫描是否找到目标手机
_ble_last_scan    = 0        # 上次扫描时间
_ble_last_seen    = 0        # 上次检测到手机的时间
_ble_seen_count   = 0        # 连续检测到的次数
_user_home        = False    # 当前在家状态
_ble_status_sent  = None     # 上次发送给服务端的状态（避免重复发送）

# ── IMU 摇晃彩蛋 ─────────────────────────────────────────────
IMU_SHAKE_G       = 2.5      # 加速度阈值（g）
IMU_SHAKE_COUNT   = 3        # 500ms 内需要达到的次数
IMU_SHAKE_COOLDOWN = 2.0     # 冷却时间（秒）
_imu_shake_times  = []       # 超阈值时间戳列表
_imu_last_shake   = 0        # 上次触发彩蛋的时间
_imu_available    = False    # IMU 是否可用

# ── RTC 时间 ─────────────────────────────────────────────────
_rtc_synced = False          # RTC 是否已同步
_has_rtc = hasattr(M5, 'Rtc')  # CoreS3 SE 无 RTC 硬件
_soft_time_offset = 0        # 软件时间偏移（秒），用于无 RTC 时

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
    "shake":          ("(*/ω＼*)", "!",                 0xff88cc),
    "wifi_setup":     ("(o_o)",   "WiFi Setup",        0x00aaff),
    "wifi_connect":   ("(._.)",   "Connecting...",     0xffaa00),
    "wifi_ok":        ("(^_^)",   "WiFi OK",           0x44ff44),
    "wifi_fail":      ("(x_x)",   "WiFi Failed",       0xff4444),
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
        except Exception as e:
            print("[ui] bg fallback to solid color:", e)
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
    # 右侧：时间 + 电量
    time_str = get_rtc_time_str()
    try:
        v = M5.Power.getBatteryVoltage()   # mV，3000-4200
        bat = max(0, min(100, (v - 3000) * 100 // 1200))
        bat_str = "{}%".format(bat)
    except Exception:
        bat_str = "--"
    right_str = "{} {}".format(time_str, bat_str) if time_str else bat_str
    right_x = max(180, 310 - len(right_str) * 10)
    Lcd.setTextColor(0x666666, 0x666666)
    Lcd.drawString(right_str, right_x, 6)

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
    事件类型: 'short' / 'long' / None
    坐标: (x, y) 为按下时的位置
    """
    global _touch_start, _touch_pos
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
                return ('long', pos)
            elif duration > 0:
                return ('short', pos)
    return (None, (0, 0))


def drain_touch():
    """等待屏幕所有触摸点抬起。"""
    while M5.Touch.getCount() > 0:
        M5.update()
        time.sleep(0.05)


# ── WiFi 配置 ─────────────────────────────────────────────────
#
# 在设备屏幕上完成 WiFi 配置：扫描 → 选择 → 键盘输入密码 → 连接 → 保存。
# 凭据持久化到 /flash/wifi.json，下次开机自动连接。
# 开机前 2 秒内按住屏幕可强制进入配置界面（setup() 入口检测）。

_WIFI_CONF_PATH = "/flash/wifi.json"
_WIFI_CONF_TMP  = "/flash/wifi.json.tmp"
_WIFI_CONNECT_TIMEOUT = 15   # seconds

_wlan = None


def _wlan_if():
    """获取 STA 接口，幂等启用。"""
    global _wlan
    if _wlan is None:
        _wlan = network.WLAN(network.STA_IF)
    try:
        if not _wlan.active():
            _wlan.active(True)
    except Exception as e:
        print("[wifi] STA activate failed:", e)
    return _wlan


def _wifi_load():
    """读取 /flash/wifi.json，失败返回 None。"""
    try:
        with open(_WIFI_CONF_PATH, "r") as f:
            obj = ujson.load(f)
        if not isinstance(obj, dict) or "ssid" not in obj:
            return None
        return obj
    except Exception:
        return None


def _wifi_save(ssid, pwd, is_open):
    """原子写入凭据：先写 .tmp 再 rename，避免断电损坏。"""
    try:
        obj = {
            "ssid": ssid,
            "password": pwd,
            "open": bool(is_open),
            "saved_at": int(time.time()),
        }
        with open(_WIFI_CONF_TMP, "w") as f:
            ujson.dump(obj, f)
        try:
            uos.remove(_WIFI_CONF_PATH)
        except Exception:
            pass
        uos.rename(_WIFI_CONF_TMP, _WIFI_CONF_PATH)
        return True
    except Exception as e:
        print("wifi save err:", e)
        return False


def _wifi_connect(ssid, pwd, timeout=None):
    """同步连接 WiFi。成功返回 True，超时/失败返回 False。"""
    if timeout is None:
        timeout = _WIFI_CONNECT_TIMEOUT
    wlan = _wlan_if()
    try:
        try:
            wlan.disconnect()
        except Exception:
            pass
        if pwd:
            wlan.connect(ssid, pwd)
        else:
            wlan.connect(ssid)
    except Exception as e:
        print("wifi connect err:", e)
        return False
    t_end = time.ticks_add(time.ticks_ms(), int(timeout * 1000))
    while time.ticks_diff(t_end, time.ticks_ms()) > 0:
        try:
            if wlan.isconnected():
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def _wifi_scan():
    """扫描并按 SSID 去重（保留最大 RSSI），按 RSSI 降序返回。

    返回 [(ssid_str, rssi, authmode), ...]
    authmode 0 表示开放网络。
    """
    wlan = _wlan_if()
    try:
        raw = wlan.scan()
    except Exception as e:
        print("wifi scan err:", e)
        return []
    best = {}
    for entry in raw:
        try:
            ssid_raw = entry[0]
            rssi     = entry[3]
            auth     = entry[4]
        except Exception:
            continue
        if isinstance(ssid_raw, bytes):
            try:
                ssid = ssid_raw.decode("utf-8")
            except Exception:
                continue
        else:
            ssid = str(ssid_raw)
        if not ssid:
            continue
        prev = best.get(ssid)
        if prev is None or rssi > prev[1]:
            best[ssid] = (ssid, rssi, auth)
    nets = list(best.values())
    nets.sort(key=lambda e: e[1], reverse=True)
    return nets


# ── 绘图辅助 ────────────────────────────────────────────────

def _fill_rect(x, y, w, h, color):
    """填充矩形，优先使用 Lcd.fillRect，回退为逐行 Line。"""
    try:
        Lcd.fillRect(x, y, w, h, color)
    except Exception:
        for yy in range(y, y + h):
            Widgets.Line(x, yy, x + w - 1, yy, color)


def _stroke_rect(x, y, w, h, color):
    """画矩形边框（4 条 Line）。"""
    Widgets.Line(x, y, x + w - 1, y, color)
    Widgets.Line(x, y + h - 1, x + w - 1, y + h - 1, color)
    Widgets.Line(x, y, x, y + h - 1, color)
    Widgets.Line(x + w - 1, y, x + w - 1, y + h - 1, color)


def _hit(x, y, rect):
    """点 (x,y) 是否落在 rect=(x1,y1,x2,y2) 内。"""
    return rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]


def _wait_tap():
    """阻塞等待一次抬起事件，返回 (x, y)。"""
    while True:
        t, pos = check_touch()
        if t in ('short', 'long') and pos != (0, 0):
            return pos
        time.sleep(0.01)


# ── SSID 选择页 ──────────────────────────────────────────────

_PICKER_ROW_H    = 28
_PICKER_PER_PAGE = 6
_PICKER_Y0       = 30

_PICKER_RESCAN = (6,   208, 100, 234)
_PICKER_MANUAL = (106, 208, 206, 234)
_PICKER_PAGE   = (212, 208, 314, 234)


def _draw_picker(nets, page):
    Widgets.fillScreen(0x000000)
    # 顶部状态栏
    Widgets.Line(0, 0, 320, 0, 0x00aaff)
    Widgets.Line(0, 1, 320, 1, 0x00aaff)
    Widgets.Line(0, 2, 320, 2, 0x00aaff)
    Lcd.setFont(_FONT_16)
    Lcd.setTextSize(1)
    Lcd.setTextColor(0x00aaff, 0x000000)
    Lcd.drawString("WiFi Setup", 6, 6)

    total = len(nets)
    pages = max(1, (total + _PICKER_PER_PAGE - 1) // _PICKER_PER_PAGE)
    if page >= pages:
        page = 0

    if total == 0:
        Lcd.setTextColor(0x888888, 0x000000)
        Lcd.drawString("No networks found", 60, 100)
    else:
        start = page * _PICKER_PER_PAGE
        end   = min(start + _PICKER_PER_PAGE, total)
        for i in range(start, end):
            ssid, rssi, auth = nets[i]
            n  = i - start
            y  = _PICKER_Y0 + n * _PICKER_ROW_H
            _stroke_rect(6, y, 308, _PICKER_ROW_H - 2, 0x333366)
            Lcd.setTextColor(0xffffff, 0x000000)
            label = ssid
            if len(label) > 20:
                label = label[:19] + ">"
            Lcd.drawString(label, 12, y + 6)
            # 加锁标记
            if auth and auth != 0:
                Lcd.setTextColor(0xffcc00, 0x000000)
                Lcd.drawString("L", 232, y + 6)
            # RSSI 3 格强度
            if rssi > -60:
                rc = 0x44ff44
            elif rssi > -75:
                rc = 0xffcc00
            else:
                rc = 0xff4444
            bx = 252
            base_y = y + 4
            for bi in range(3):
                bh = 6 + bi * 5
                _fill_rect(bx + bi * 10, base_y + 18 - bh, 6, bh, rc)

    # 底栏按钮
    _fill_rect(_PICKER_RESCAN[0], _PICKER_RESCAN[1],
               _PICKER_RESCAN[2] - _PICKER_RESCAN[0],
               _PICKER_RESCAN[3] - _PICKER_RESCAN[1], 0x224466)
    _fill_rect(_PICKER_MANUAL[0], _PICKER_MANUAL[1],
               _PICKER_MANUAL[2] - _PICKER_MANUAL[0],
               _PICKER_MANUAL[3] - _PICKER_MANUAL[1], 0x224466)
    _fill_rect(_PICKER_PAGE[0], _PICKER_PAGE[1],
               _PICKER_PAGE[2] - _PICKER_PAGE[0],
               _PICKER_PAGE[3] - _PICKER_PAGE[1], 0x224466)
    Lcd.setTextColor(0xffffff, 0x224466)
    Lcd.drawString("Rescan", _PICKER_RESCAN[0] + 16, _PICKER_RESCAN[1] + 6)
    Lcd.drawString("Manual", _PICKER_MANUAL[0] + 20, _PICKER_MANUAL[1] + 6)
    Lcd.drawString("{}/{}".format(page + 1, pages),
                   _PICKER_PAGE[0] + 30, _PICKER_PAGE[1] + 6)
    return page, pages


def _pick_ssid(nets):
    """显示 SSID 选择页，返回 (选择项, is_open)。

    选择项可能是：
      - SSID 字符串：用户选中某个网络
      - "__rescan__"：请求重扫
      - "__manual__"：手动输入隐藏 SSID
    """
    page = 0
    page, pages = _draw_picker(nets, page)
    while True:
        pos = _wait_tap()
        x, y = pos
        if _hit(x, y, _PICKER_RESCAN):
            return ("__rescan__", False)
        if _hit(x, y, _PICKER_MANUAL):
            return ("__manual__", False)
        if _hit(x, y, _PICKER_PAGE):
            page = (page + 1) % pages
            page, pages = _draw_picker(nets, page)
            continue
        if nets:
            start = page * _PICKER_PER_PAGE
            end   = min(start + _PICKER_PER_PAGE, len(nets))
            for i in range(start, end):
                n = i - start
                ry = _PICKER_Y0 + n * _PICKER_ROW_H
                row_rect = (6, ry, 313, ry + _PICKER_ROW_H - 2)
                if _hit(x, y, row_rect):
                    ssid, _rssi, auth = nets[i]
                    return (ssid, auth == 0)


# ── 软键盘 ──────────────────────────────────────────────────

_KBD_LAYOUTS = [
    # 0: 小写
    ["qwertyuiop",
     "asdfghjkl_",
     "zxcvbnm,.-"],
    # 1: 大写
    ["QWERTYUIOP",
     "ASDFGHJKL_",
     "ZXCVBNM;:?"],
    # 2: 符号
    ["1234567890",
     "!@#$%^&*()",
     "-_=+[]{};:"],
]

_KBD_KEY_W = 30
_KBD_KEY_H = 34
_KBD_X0    = 6
_KBD_Y0    = 58

_KBD_SHIFT = (6,   172, 70,  212)
_KBD_SPACE = (74,  172, 182, 212)
_KBD_BKSP  = (186, 172, 226, 212)
_KBD_OK    = (230, 172, 274, 212)
_KBD_CX    = (278, 172, 318, 212)


def _kbd_key_rect(row, col):
    x1 = _KBD_X0 + col * 31
    y1 = _KBD_Y0 + row * 38
    return (x1, y1, x1 + _KBD_KEY_W, y1 + _KBD_KEY_H)


def _draw_kbd(title, buf, shift_mode, masked, reveal_until):
    Widgets.fillScreen(0x000000)
    Widgets.Line(0, 0, 320, 0, 0x00aaff)
    Widgets.Line(0, 1, 320, 1, 0x00aaff)
    Widgets.Line(0, 2, 320, 2, 0x00aaff)
    Lcd.setFont(_FONT_16)
    Lcd.setTextSize(1)
    Lcd.setTextColor(0x00aaff, 0x000000)
    tlabel = title
    if len(tlabel) > 30:
        tlabel = tlabel[:29] + ">"
    Lcd.drawString(tlabel, 6, 6)

    # 输入框
    _stroke_rect(6, 24, 308, 30, 0x555588)
    if masked:
        n = len(buf)
        now = time.ticks_ms()
        if reveal_until and time.ticks_diff(reveal_until, now) > 0 and n > 0:
            disp = "*" * (n - 1) + buf[-1]
        else:
            disp = "*" * n
    else:
        disp = buf
    if len(disp) > 26:
        disp = disp[-26:]
    Lcd.setTextColor(0xffffff, 0x000000)
    Lcd.drawString(disp, 12, 32)

    # 字符按键
    layout = _KBD_LAYOUTS[shift_mode]
    for row in range(3):
        chars = layout[row]
        for col in range(len(chars)):
            r = _kbd_key_rect(row, col)
            _fill_rect(r[0], r[1], r[2] - r[0], r[3] - r[1], 0x222244)
            _stroke_rect(r[0], r[1], r[2] - r[0], r[3] - r[1], 0x444488)
            Lcd.setTextColor(0xffffff, 0x222244)
            Lcd.drawString(chars[col], r[0] + 10, r[1] + 9)

    # 控制行
    _fill_rect(_KBD_SHIFT[0], _KBD_SHIFT[1],
               _KBD_SHIFT[2] - _KBD_SHIFT[0],
               _KBD_SHIFT[3] - _KBD_SHIFT[1], 0x224466)
    _fill_rect(_KBD_SPACE[0], _KBD_SPACE[1],
               _KBD_SPACE[2] - _KBD_SPACE[0],
               _KBD_SPACE[3] - _KBD_SPACE[1], 0x222244)
    _fill_rect(_KBD_BKSP[0], _KBD_BKSP[1],
               _KBD_BKSP[2] - _KBD_BKSP[0],
               _KBD_BKSP[3] - _KBD_BKSP[1], 0x663333)
    _fill_rect(_KBD_OK[0], _KBD_OK[1],
               _KBD_OK[2] - _KBD_OK[0],
               _KBD_OK[3] - _KBD_OK[1], 0x225522)
    _fill_rect(_KBD_CX[0], _KBD_CX[1],
               _KBD_CX[2] - _KBD_CX[0],
               _KBD_CX[3] - _KBD_CX[1], 0x552222)
    Lcd.setTextColor(0xffffff, 0x000000)
    shift_lbl = ["abc", "ABC", "!@#"][shift_mode]
    Lcd.drawString(shift_lbl, _KBD_SHIFT[0] + 18, _KBD_SHIFT[1] + 12)
    Lcd.drawString("space", _KBD_SPACE[0] + 38, _KBD_SPACE[1] + 12)
    Lcd.drawString("<-", _KBD_BKSP[0] + 10, _KBD_BKSP[1] + 12)
    Lcd.drawString("OK", _KBD_OK[0] + 12, _KBD_OK[1] + 12)
    Lcd.drawString("X", _KBD_CX[0] + 14, _KBD_CX[1] + 12)


def _prompt_text(title, masked=False):
    """弹出软键盘，返回输入字符串（可能为空）或 None（用户取消）。"""
    buf = ""
    shift_mode = 0
    reveal_until = 0
    _draw_kbd(title, buf, shift_mode, masked, reveal_until)
    while True:
        t, pos = check_touch()
        # 定时清除明文回显
        if masked and reveal_until and time.ticks_diff(reveal_until, time.ticks_ms()) <= 0:
            reveal_until = 0
            _draw_kbd(title, buf, shift_mode, masked, reveal_until)
        if t not in ('short', 'long') or pos == (0, 0):
            time.sleep(0.01)
            continue
        x, y = pos
        if _hit(x, y, _KBD_OK):
            return buf
        if _hit(x, y, _KBD_CX):
            return None
        if _hit(x, y, _KBD_BKSP):
            if buf:
                buf = buf[:-1]
            reveal_until = 0
            _draw_kbd(title, buf, shift_mode, masked, reveal_until)
            continue
        if _hit(x, y, _KBD_SPACE):
            if len(buf) < 63:
                buf += " "
            reveal_until = 0
            _draw_kbd(title, buf, shift_mode, masked, reveal_until)
            continue
        if _hit(x, y, _KBD_SHIFT):
            shift_mode = (shift_mode + 1) % 3
            _draw_kbd(title, buf, shift_mode, masked, reveal_until)
            continue
        # 字符键命中检测
        layout = _KBD_LAYOUTS[shift_mode]
        hit = False
        for row in range(3):
            chars = layout[row]
            for col in range(len(chars)):
                r = _kbd_key_rect(row, col)
                if _hit(x, y, r):
                    if len(buf) < 63:
                        buf += chars[col]
                    if masked:
                        reveal_until = time.ticks_add(time.ticks_ms(), 500)
                    _draw_kbd(title, buf, shift_mode, masked, reveal_until)
                    hit = True
                    break
            if hit:
                break


# ── 配置主流程 ──────────────────────────────────────────────

def wifi_setup_flow():
    """显示 WiFi 配置界面，循环直到连接成功返回 True。

    取消密码输入会返回 picker 继续选择；取消不会让 setup() 继续引导。
    """
    while True:
        draw_state("wifi_setup")
        nets = _wifi_scan()
        choice, is_open = _pick_ssid(nets)

        if choice == "__rescan__":
            continue
        if choice == "__manual__":
            ssid = _prompt_text("Enter SSID", masked=False)
            if not ssid:
                continue
            is_open = False
        else:
            ssid = choice

        if is_open:
            pwd = ""
        else:
            pwd = _prompt_text("Pwd: " + ssid, masked=True)
            if pwd is None:
                continue   # 回到 picker

        draw_state("wifi_connect")
        if _wifi_connect(ssid, pwd):
            _wifi_save(ssid, pwd, is_open)
            draw_state("wifi_ok")
            time.sleep(1)
            return True
        draw_state("wifi_fail")
        time.sleep(1.5)


def ensure_wifi(force_setup=False):
    """保证 WiFi 可用。

    优先级：
      1. force_setup  → 直接进入 on-device 配置 UI
      2. 已连接 (UIFlow2 预设 / 前次运行残留) → 返回 True
      3. /flash/wifi.json 存档 → 尝试连接一次
      4. 以上都失败 → on-device 配置 UI
    """
    wlan = _wlan_if()

    if force_setup:
        return wifi_setup_flow()

    # 给 UIFlow2 预设凭据最多 5 秒完成连接
    try:
        for _ in range(20):
            if wlan.isconnected():
                print("wifi already connected")
                return True
            time.sleep(0.25)
    except Exception:
        pass

    cfg = _wifi_load()
    if cfg:
        ssid = cfg.get("ssid", "")
        pwd  = cfg.get("password", "")
        if ssid:
            draw_state("wifi_connect")
            if _wifi_connect(ssid, pwd):
                print("wifi restored from file:", ssid)
                return True
            print("stored wifi failed, entering setup")

    return wifi_setup_flow()


# ── 模式切换 ──────────────────────────────────────────────────

def toggle_continuous():
    """摇晃切换连续对话模式。开启时自动关闭声控唤醒（两者互斥）。"""
    global continuous_mode, WAKE_MODE
    continuous_mode = not continuous_mode
    if continuous_mode:
        WAKE_MODE = False
    draw_state("continuous_on" if continuous_mode else "continuous_off")
    time.sleep(0.8)
    draw_state("idle")


def toggle_wake_mode():
    """长按切换声控唤醒模式。开启时自动关闭连续对话（两者互斥）。"""
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
            hdrs = {"X-Device-Id": DEVICE_ID}
            lt = get_local_time_header()
            if lt:
                hdrs["X-Local-Time"] = lt
            resp = urequests.post(SERVER_URL, data=wav, headers=hdrs, timeout=REQUEST_TIMEOUT_CHAT)
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
                v_hdrs = {"X-Device-Id": DEVICE_ID,
                          "Content-Type": "application/json"}
                lt2 = get_local_time_header()
                if lt2:
                    v_hdrs["X-Local-Time"] = lt2
                resp2 = urequests.post(
                    VISION_URL,
                    data=payload.encode("utf-8"),
                    headers=v_hdrs,
                    timeout=REQUEST_TIMEOUT_CHAT,
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
            mqtt_check()   # 趁 is_busy=True 消费掉 OpenClaw 触发的重复 push
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
        v_hdrs = {"X-Device-Id": DEVICE_ID,
                  "Content-Type": "application/json"}
        lt = get_local_time_header()
        if lt:
            v_hdrs["X-Local-Time"] = lt
        resp = urequests.post(
            VISION_URL,
            data=payload.encode("utf-8"),
            headers=v_hdrs,
            timeout=REQUEST_TIMEOUT_CHAT,
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
    mqtt_check()   # 趁 is_busy=True 消费掉 OpenClaw 触发的重复 push
    draw_state("idle")
    time.sleep(1)
    drain_touch()
    is_busy = False


# ── MQTT 推送订阅 ─────────────────────────────────────────────

_mqtt = None
_MQTT_TOPICS = []


def _mqtt_callback(topic, msg):
    """MQTT 消息回调：广播音频或拍照命令。"""
    global _last_activity, is_busy
    topic_str = topic.decode("utf-8") if isinstance(topic, bytes) else topic

    if "/push/" in topic_str:
        # 广播通知：JSON → HTTP GET 下载 WAV → 播放
        if is_busy:
            print("push skipped: device busy")
            return
        try:
            info = ujson.loads(msg)
        except Exception as e:
            print("[mqtt] push parse error:", e)
            return
        url = info.get("url", "")
        if not url:
            return
        if _is_sleeping:
            wake_up()
        _last_activity = time.time()
        draw_state("broadcast")
        try:
            full_url = SERVER_BASE + url
            resp = urequests.get(full_url, timeout=REQUEST_TIMEOUT_SHORT)
            if resp.status_code == 200:
                play_wav(resp.content)
            resp.close()
        except OSError as e:
            print("push download err:", e)
        draw_state("idle")
        _set_led(0, 0, 0)

    elif "/cmd/" in topic_str:
        # 远程命令：JSON payload
        try:
            cmd = ujson.loads(msg)
        except Exception as e:
            print("[mqtt] cmd parse error:", e)
            return
        if cmd.get("action") == "capture":
            if _is_sleeping:
                wake_up()
            _last_activity = time.time()
            is_busy = True
            try:
                draw_state("camera")
                image_b64 = capture_photo()
                draw_state("processing")
                payload = ujson.dumps({
                    "request_id": cmd.get("request_id", ""),
                    "image": image_b64 or "",
                    "device_id": DEVICE_ID,
                })
                try:
                    resp = urequests.post(
                        UPLOAD_URL,
                        data=payload.encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        timeout=REQUEST_TIMEOUT_UPLOAD,
                    )
                    resp.close()
                except OSError as e:
                    print("upload err:", e)
            finally:
                draw_state("idle")
                is_busy = False


def _reconnect_mqtt():
    """重连 MQTT 并重新订阅所有 topic。"""
    global _mqtt
    try:
        _mqtt.connect(clean_session=False)
        for t in _MQTT_TOPICS:
            _mqtt.subscribe(t, 1)
        print("MQTT reconnected")
    except Exception as e:
        print("MQTT reconnect failed:", e)


def init_mqtt():
    """连接 MQTT broker 并订阅推送 topic。"""
    global _mqtt, _MQTT_TOPICS
    try:
        from umqtt.simple import MQTTClient
        _MQTT_TOPICS = [
            "kagura/push/{}".format(DEVICE_ID),
            "kagura/cmd/{}".format(DEVICE_ID),
        ]
        client = MQTTClient(DEVICE_ID, MQTT_BROKER, port=1883, keepalive=60)
        client.set_callback(_mqtt_callback)
        client.connect(clean_session=False)
        for t in _MQTT_TOPICS:
            client.subscribe(t, 1)
        _mqtt = client
        print("MQTT connected:", MQTT_BROKER)
    except Exception as e:
        print("MQTT init error:", e)
        _mqtt = None


def mqtt_check():
    """主循环调用：非阻塞检查 MQTT 消息，定期 ping 保活，断连时自动重连。"""
    global _mqtt_last_ping
    if _mqtt:
        try:
            _mqtt.check_msg()
            # 每 30 秒发送 ping 保活（keepalive=60s，需在超时前 ping）
            now = time.time()
            if now - _mqtt_last_ping > 30:
                _mqtt.ping()
                _mqtt_last_ping = now
        except OSError as e:
            print("MQTT disconnected:", e)
            _reconnect_mqtt()
            _mqtt_last_ping = time.time()


# ── RTC 时间同步 ─────────────────────────────────────────────

def sync_rtc():
    """从服务端获取时间并设置 RTC（无 RTC 硬件时用软件偏移代替）。"""
    global _rtc_synced, _soft_time_offset
    try:
        resp = urequests.get(SERVER_BASE + "/time", timeout=REQUEST_TIMEOUT_SHORT)
        if resp.status_code == 200:
            data = ujson.loads(resp.text)
            ts = data.get("timestamp", 0)
            resp.close()
            if ts > 0:
                # UIFlow2 的 time.localtime() 使用 Unix epoch (1970)
                tm = time.localtime(ts + 8 * 3600)  # UTC+8
                if _has_rtc:
                    M5.Rtc.setDateTime(tm[0], tm[1], tm[2], tm[3], tm[4], tm[5])
                    print("RTC synced:", tm[:6])
                else:
                    # 无 RTC：记录服务端时间与本地 ticks 的偏移
                    _soft_time_offset = (ts + 8 * 3600) - time.time()
                    print("Soft time synced:", tm[:6])
                _rtc_synced = True
                return
        else:
            resp.close()
    except Exception as e:
        print("RTC sync error:", e)
    print("RTC sync failed")


def _get_datetime():
    """返回 (year, month, day, hour, minute, second) 元组，兼容有/无 RTC。"""
    if _has_rtc:
        return M5.Rtc.getDateTime()
    # 无 RTC：用 MicroPython time + 偏移计算
    t = time.localtime(int(time.time() + _soft_time_offset))
    return t  # (year, month, mday, hour, minute, second, weekday, yearday)


def get_rtc_time_str():
    """返回当前时间字符串 "HH:MM"，未同步则返回空字符串。"""
    if not _rtc_synced:
        return ""
    try:
        dt = _get_datetime()
        return "{:02d}:{:02d}".format(dt[3], dt[4])
    except Exception:
        return ""


def get_local_time_header():
    """返回用于 X-Local-Time header 的时间字符串。"""
    if not _rtc_synced:
        return ""
    try:
        dt = _get_datetime()
        return "{:04d}-{:02d}-{:02d} {:02d}:{:02d}".format(dt[0], dt[1], dt[2], dt[3], dt[4])
    except Exception:
        return ""


# ── IMU 摇晃检测 ─────────────────────────────────────────────

def init_imu():
    """尝试初始化 IMU，失败则静默跳过。"""
    global _imu_available
    try:
        val = M5.Imu.getAccel()
        if val is not None:
            _imu_available = True
            print("IMU: available")
    except Exception as e:
        print("IMU: not available:", e)
        _imu_available = False


def imu_shake_tick():
    """主循环调用：检测摇晃手势，触发彩蛋图片显示。"""
    global _imu_shake_times, _imu_last_shake

    if not _imu_available or is_busy:
        return

    now = time.time()
    if now - _imu_last_shake < IMU_SHAKE_COOLDOWN:
        return

    try:
        acc = M5.Imu.getAccel()
        if acc is None:
            return
        ax, ay, az = acc
        # 计算总加速度幅值（含重力约 1g）
        magnitude = math.sqrt(ax * ax + ay * ay + az * az)
        if magnitude > IMU_SHAKE_G:
            now_ms = time.ticks_ms()
            _imu_shake_times.append(now_ms)
            _imu_shake_times[:] = [t for t in _imu_shake_times if time.ticks_diff(now_ms, t) < 500]
            if len(_imu_shake_times) >= IMU_SHAKE_COUNT:
                _imu_shake_times.clear()
                _imu_last_shake = now
                _show_shake_easter_egg()
        else:
            if _imu_shake_times:
                now_ms = time.ticks_ms()
                _imu_shake_times[:] = [t for t in _imu_shake_times if time.ticks_diff(now_ms, t) < 500]
    except Exception:
        pass


def _show_shake_easter_egg():
    """显示摇晃彩蛋图片 2 秒，然后切换连续对话模式。continuous off→on 时额外调用 /shake 让 AI 主动聊天。"""
    global _last_activity, is_busy, _imu_last_shake, _touch_start
    is_busy = True
    _last_activity = time.time()
    try:
        was_off = not continuous_mode
        try:
            with open("/flash/img_shake.jpg", "rb") as f:
                Lcd.drawJpg(f.read(), 0, 0)
        except Exception as e:
            print("[shake] img_shake.jpg unavailable, falling back to kaomoji:", e)
            draw_state("shake")
        time.sleep(2)
        toggle_continuous()
        if was_off:
            draw_state("processing")
            try:
                hdrs = {"X-Device-Id": DEVICE_ID}
                lt = get_local_time_header()
                if lt:
                    hdrs["X-Local-Time"] = lt
                resp = urequests.get(SERVER_BASE + "/shake", headers=hdrs, timeout=REQUEST_TIMEOUT_SHORT)
                resp.close()
            except OSError as e:
                print("shake network err:", e)
            draw_state("idle")
        _touch_start = None
        drain_touch()
        _imu_last_shake = time.time()
    finally:
        is_busy = False


# ── BLE 扫描 ─────────────────────────────────────────────────

def _decode_ble_name(adv_data):
    """从 BLE 广播数据中解析设备名称（Complete/Short Local Name）。"""
    i = 0
    while i < len(adv_data):
        length = adv_data[i]
        if length == 0:
            break
        if i + length >= len(adv_data):
            break
        ad_type = adv_data[i + 1]
        if ad_type in (0x08, 0x09):  # Short / Complete Local Name
            try:
                return adv_data[i + 2:i + 1 + length].decode('utf-8')
            except Exception:
                pass
        i += 1 + length
    return None


def _is_apple_device(adv_data):
    """检查 BLE 广播是否包含 Apple 厂商数据（company ID 0x004C）。"""
    i = 0
    while i < len(adv_data):
        length = adv_data[i]
        if length == 0:
            break
        if i + length >= len(adv_data):
            break
        ad_type = adv_data[i + 1]
        if ad_type == 0xFF and length >= 3:  # Manufacturer Specific Data
            company_id = adv_data[i + 2] | (adv_data[i + 3] << 8)
            if company_id == 0x004C:  # Apple Inc.
                return True
        i += 1 + length
    return False


def _ble_irq(event, data):
    """BLE 扫描回调：检测目标手机（Apple 厂商 ID 或设备名称匹配）。"""
    global _ble_phone_found
    if event == 5:  # _IRQ_SCAN_RESULT
        addr_type, addr, adv_type, rssi, adv_data = data
        if rssi < BLE_RSSI_THRESHOLD:
            return
        raw = bytes(adv_data)
        # 优先：设备名称匹配（部分 Android 等会广播名称）
        name = _decode_ble_name(raw)
        if name and BLE_PHONE_NAME and BLE_PHONE_NAME in name:
            _ble_phone_found = True
            return
        # Fallback：iPhone 不广播名称，检测 Apple 厂商 ID
        if _is_apple_device(raw):
            _ble_phone_found = True


def init_ble():
    """初始化 BLE 扫描器（仅当配置了手机名称时启用）。"""
    global _ble
    if not BLE_PHONE_NAME:
        print("BLE: disabled (BLE_PHONE_NAME is empty)")
        return
    try:
        import bluetooth
        _ble = bluetooth.BLE()
        _ble.active(True)
        _ble.irq(_ble_irq)
        print("BLE: initialized, target name:", BLE_PHONE_NAME)
    except Exception as e:
        print("BLE init error:", e)
        _ble = None


def ble_scan_tick():
    """主循环调用：定期执行 BLE 扫描并更新在家状态。"""
    global _ble_last_scan, _ble_phone_found, _ble_last_seen, _ble_seen_count
    global _user_home, _ble_status_sent

    if _ble is None:
        return

    now = time.time()
    if now - _ble_last_scan < BLE_SCAN_INTERVAL:
        return

    _ble_last_scan = now
    _ble_phone_found = False

    try:
        # active scan 以获取 Scan Response 中的设备名称
        _ble.gap_scan(BLE_SCAN_DURATION, 100000, 50000, True)
    except Exception as e:
        print("BLE scan error:", e)
        return

    # 扫描是异步的，结果在回调中处理。
    # 下次 tick 时检查上一轮扫描结果。
    # 这里检查的是上一轮的结果（扫描回调在期间已触发）。
    print("BLE scan:", "found" if _ble_phone_found else "not found",
          "count={}".format(_ble_seen_count))
    if _ble_phone_found:
        _ble_last_seen = now
        _ble_seen_count += 1
    else:
        _ble_seen_count = 0

    # 状态机：判定在家/出门
    prev_home = _user_home
    if not _user_home and _ble_seen_count >= BLE_HOME_COUNT:
        _user_home = True
        print("BLE: 在家 (detected {} times)".format(_ble_seen_count))
    elif _user_home and _ble_last_seen > 0 and (now - _ble_last_seen > BLE_AWAY_TIMEOUT):
        _user_home = False
        print("BLE: 出门 (not seen for {}s)".format(int(now - _ble_last_seen)))

    # 状态变化时通知服务端
    if _user_home != prev_home:
        _notify_presence("home" if _user_home else "away")


def _notify_presence(status):
    """通知服务端用户在家/出门状态变化。"""
    global _ble_status_sent
    if _ble_status_sent == status:
        return
    _ble_status_sent = status
    try:
        url = SERVER_BASE + "/presence"
        payload = ujson.dumps({"device_id": DEVICE_ID, "status": status})
        resp = urequests.post(url, data=payload.encode("utf-8"),
                              headers={"Content-Type": "application/json"},
                              timeout=REQUEST_TIMEOUT_SHORT)
        print("BLE presence →", status, ":", resp.status_code)
        resp.close()
    except Exception as e:
        print("BLE presence notify error:", e)


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
    global SERVER_BASE, SERVER_URL, VISION_URL, UPLOAD_URL, MQTT_BROKER

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
                    UPLOAD_URL  = SERVER_BASE + "/upload-photo"
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

    # ── WiFi 引导：开机 2 秒内按住屏幕强制进入配置界面 ──
    force_wifi = False
    t0 = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), t0) < 2000:
        M5.update()
        if M5.Touch.getCount() > 0:
            force_wifi = True
            break
        time.sleep(0.05)
    if force_wifi:
        drain_touch()

    if not ensure_wifi(force_setup=force_wifi):
        draw_state("wifi_fail")
        time.sleep(2)
        import machine
        machine.reset()

    discover_server()
    sync_rtc()
    init_mqtt()
    init_ble()
    init_imu()
    draw_state("idle")       # 发现完成后恢复空闲界面
    calibrate_noise()
    _last_activity = time.time()


def loop():
    global _last_activity, _wake_last_ms, _wake_loud_count

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
            toggle_wake_mode()           # 长按：切换声控唤醒模式
        elif touch == 'short':
            record_and_send()            # 短按：直接录音
        elif WAKE_MODE:
            # 简化的声控唤醒：连续 N×100ms 音量超阈值 → 触发录音
            now_ms = time.ticks_ms()
            if time.ticks_diff(now_ms, _wake_last_ms) >= 100:
                _wake_last_ms = now_ms
                Mic.begin()
                Mic.record(_wake_buf, 16000)
                time.sleep(0.05)
                Mic.end()
                level = rms(_wake_buf)
                if level > WAKE_THRESHOLD:
                    _wake_loud_count += 1
                    if _wake_loud_count >= WAKE_LOUD_NEED:
                        _wake_loud_count = 0
                        _last_activity = time.time()
                        record_and_send()
                else:
                    _wake_loud_count = 0

    # MQTT 推送消息 + 命令（非阻塞，回调在 _mqtt_callback 中处理）
    mqtt_check()

    # BLE 在家感知（非阻塞定期扫描）
    ble_scan_tick()

    # IMU 摇晃彩蛋检测
    imu_shake_tick()

    # ── 自动休眠检查 ──
    now = time.time()
    if not _is_sleeping and not is_busy:
        if now - _last_activity > SLEEP_TIMEOUT:
            enter_sleep()


if __name__ == '__main__':
    setup()
    while True:
        loop()
