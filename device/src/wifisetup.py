"""屏上 WiFi 配网：扫描 → 选择 SSID → 软键盘输密码 → 连接 → 存档。

凭据持久化到 cfg.data("wifi.json")，下次开机自动连接。
开机前 2 秒内按住屏幕可强制进入配置界面（app.setup() 入口检测）。
"""

import time
import ujson
import uos
import network
from M5 import *

import cfg
import hw
import ui

_WIFI_CONF_PATH = cfg.data("wifi.json")
_WIFI_CONF_TMP  = cfg.data("wifi.json.tmp")

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
        timeout = cfg.WIFI_CONNECT_TIMEOUT
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
    Lcd.setFont(ui._FONT_16)
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
            hw._stroke_rect(6, y, 308, _PICKER_ROW_H - 2, 0x333366)
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
                hw._fill_rect(bx + bi * 10, base_y + 18 - bh, 6, bh, rc)

    # 底栏按钮
    hw._fill_rect(_PICKER_RESCAN[0], _PICKER_RESCAN[1],
               _PICKER_RESCAN[2] - _PICKER_RESCAN[0],
               _PICKER_RESCAN[3] - _PICKER_RESCAN[1], 0x224466)
    hw._fill_rect(_PICKER_MANUAL[0], _PICKER_MANUAL[1],
               _PICKER_MANUAL[2] - _PICKER_MANUAL[0],
               _PICKER_MANUAL[3] - _PICKER_MANUAL[1], 0x224466)
    hw._fill_rect(_PICKER_PAGE[0], _PICKER_PAGE[1],
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
        pos = hw._wait_tap()
        x, y = pos
        if hw._hit(x, y, _PICKER_RESCAN):
            return ("__rescan__", False)
        if hw._hit(x, y, _PICKER_MANUAL):
            return ("__manual__", False)
        if hw._hit(x, y, _PICKER_PAGE):
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
                if hw._hit(x, y, row_rect):
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
    Lcd.setFont(ui._FONT_16)
    Lcd.setTextSize(1)
    Lcd.setTextColor(0x00aaff, 0x000000)
    tlabel = title
    if len(tlabel) > 30:
        tlabel = tlabel[:29] + ">"
    Lcd.drawString(tlabel, 6, 6)

    # 输入框
    hw._stroke_rect(6, 24, 308, 30, 0x555588)
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
            hw._fill_rect(r[0], r[1], r[2] - r[0], r[3] - r[1], 0x222244)
            hw._stroke_rect(r[0], r[1], r[2] - r[0], r[3] - r[1], 0x444488)
            Lcd.setTextColor(0xffffff, 0x222244)
            Lcd.drawString(chars[col], r[0] + 10, r[1] + 9)

    # 控制行
    hw._fill_rect(_KBD_SHIFT[0], _KBD_SHIFT[1],
               _KBD_SHIFT[2] - _KBD_SHIFT[0],
               _KBD_SHIFT[3] - _KBD_SHIFT[1], 0x224466)
    hw._fill_rect(_KBD_SPACE[0], _KBD_SPACE[1],
               _KBD_SPACE[2] - _KBD_SPACE[0],
               _KBD_SPACE[3] - _KBD_SPACE[1], 0x222244)
    hw._fill_rect(_KBD_BKSP[0], _KBD_BKSP[1],
               _KBD_BKSP[2] - _KBD_BKSP[0],
               _KBD_BKSP[3] - _KBD_BKSP[1], 0x663333)
    hw._fill_rect(_KBD_OK[0], _KBD_OK[1],
               _KBD_OK[2] - _KBD_OK[0],
               _KBD_OK[3] - _KBD_OK[1], 0x225522)
    hw._fill_rect(_KBD_CX[0], _KBD_CX[1],
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
        t, pos = hw.check_touch()
        # 定时清除明文回显
        if masked and reveal_until and time.ticks_diff(reveal_until, time.ticks_ms()) <= 0:
            reveal_until = 0
            _draw_kbd(title, buf, shift_mode, masked, reveal_until)
        if t not in ('short', 'long') or pos == (0, 0):
            time.sleep(0.01)
            continue
        x, y = pos
        if hw._hit(x, y, _KBD_OK):
            return buf
        if hw._hit(x, y, _KBD_CX):
            return None
        if hw._hit(x, y, _KBD_BKSP):
            if buf:
                buf = buf[:-1]
            reveal_until = 0
            _draw_kbd(title, buf, shift_mode, masked, reveal_until)
            continue
        if hw._hit(x, y, _KBD_SPACE):
            if len(buf) < 63:
                buf += " "
            reveal_until = 0
            _draw_kbd(title, buf, shift_mode, masked, reveal_until)
            continue
        if hw._hit(x, y, _KBD_SHIFT):
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
                if hw._hit(x, y, r):
                    if len(buf) < 63:
                        buf += chars[col]
                    if masked:
                        reveal_until = time.ticks_add(time.ticks_ms(), 500)
                    _draw_kbd(title, buf, shift_mode, masked, reveal_until)
                    hit = True
                    break
            if hit:
                break

# ── 配网主流程 ──────────────────────────────────────────────

def wifi_setup_flow():
    """显示 WiFi 配置界面，循环直到连接成功返回 True。

    取消密码输入会返回 picker 继续选择；取消不会让 setup() 继续引导。
    """
    while True:
        ui.draw_state("wifi_setup")
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

        ui.draw_state("wifi_connect")
        if _wifi_connect(ssid, pwd):
            _wifi_save(ssid, pwd, is_open)
            ui.draw_state("wifi_ok")
            time.sleep(1)
            return True
        ui.draw_state("wifi_fail")
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

    saved = _wifi_load()          # 注意：不能叫 cfg，会遮蔽 cfg 模块
    if saved:
        ssid = saved.get("ssid", "")
        pwd  = saved.get("password", "")
        if ssid:
            ui.draw_state("wifi_connect")
            if _wifi_connect(ssid, pwd):
                print("wifi restored from file:", ssid)
                return True
            print("stored wifi failed, entering setup")

    return wifi_setup_flow()
