"""屏幕显示：字体、环形音频可视化、分层增量重绘、息屏唤醒。

依赖 cfg / hw / clock（都在下层，无环）。
"""

import M5
from M5 import *
import time
import math
import ubinascii

import cfg
import hw
import clock

# ── 字体 ───────────────────────────────────────────────────────
_FONT_16 = Widgets.FONTS.DejaVu18
# 中文字体：UIFlow2 固件带 EFontCN 系列则用于屏显对话文本，否则跳过
_FONT_CN = (getattr(Widgets.FONTS, "EFontCN16", None)
            or getattr(Widgets.FONTS, "EFontCN14", None))

# ── 屏显对话文本（服务端 X-User-Text / X-Reply-Text 头，b64 UTF-8）──
_last_user_text  = ""
_last_reply_text = ""


def update_chat_text(user_b64, reply_b64):
    """解码响应头里的对话文本，供待机界面显示。解码失败静默跳过。"""
    global _last_user_text, _last_reply_text
    if not cfg.SHOW_CHAT_TEXT:
        return
    try:
        if user_b64:
            _last_user_text = ubinascii.a2b_base64(user_b64).decode("utf-8")
        if reply_b64:
            _last_reply_text = ubinascii.a2b_base64(reply_b64).decode("utf-8")
    except Exception as e:
        print("[ui] chat text decode err:", e)


# ── 动态可视化：环形音频指示器 ─────────────────────────────────
#
# 24 段圆环，每帧在同一批矩形上原地重绘 —— 不需要擦除，也不关心背后
# 是纯色还是照片。只依赖 fillRect（代码里已验证可用），不需要
# fillCircle / canvas / pushImage 这些不确定的 API。
#   idle              → 彗星追逐（呼吸感）
#   recording         → 麦克风电平实时填充
#   playing/broadcast → 语音包络填充
#   其他（含 processing，HTTP 阻塞期主循环不转）→ 静态一帧
#
# 逐帧只重绘亮度变化的段（差分渲染），典型每帧仅几个 fillRect。


_ring_rects = []
for _i in range(cfg.RING_N):
    _a = 2 * math.pi * (_i / cfg.RING_N) - math.pi / 2
    _ring_rects.append((
        int(cfg.RING_CX + cfg.RING_R * math.cos(_a)) - cfg.RING_W // 2,
        int(cfg.RING_CY + cfg.RING_R * math.sin(_a)) - cfg.RING_W // 2,
        cfg.RING_W, cfg.RING_W,
    ))

_vis_mode    = "static"
_vis_theme   = None
_vis_shades  = None
_vis_level   = 0.0
_vis_ref     = 2000.0      # 自动增益参考值
_vis_phase   = 0.0
_vis_last    = None        # 上一帧各段亮度档位，用于差分重绘
_vis_last_ms = 0


def _shade(color, k):
    """按比例调暗颜色。"""
    return ((int(((color >> 16) & 0xff) * k) << 16)
            | (int(((color >> 8) & 0xff) * k) << 8)
            | int((color & 0xff) * k))


def _vis_invalidate():
    """标记整环失效，下一帧全量重绘。"""
    global _vis_last
    _vis_last = None


def _vis_set_state(state, color):
    """状态切换：换模式 + 调色板，并立即渲染一帧。"""
    global _vis_mode, _vis_theme, _vis_shades, _vis_level
    if state == "recording":
        _vis_mode = "level"
    elif state in ("playing", "broadcast"):
        _vis_mode = "level"
    elif state == "idle":
        _vis_mode = "comet"
    else:
        _vis_mode = "static"
    if color != _vis_theme:
        _vis_theme = color
        _vis_shades = [_shade(color, 0.10 + 0.90 * (i / 7.0)) for i in range(8)]
    _vis_level = 0.0
    _vis_invalidate()
    visual_tick(force=True)


def _vis_set_level(rms_val):
    """录音路径：传入原始 RMS，自动增益归一化到 0..1。"""
    global _vis_level, _vis_ref
    if rms_val > _vis_ref:
        _vis_ref = float(rms_val)
    else:
        _vis_ref = max(800.0, _vis_ref * 0.97)   # 缓慢回落，适应环境
    _vis_level = min(1.0, rms_val / _vis_ref) if _vis_ref > 0 else 0.0


def _vis_set_level_norm(v):
    """播放路径：包络已归一化，直接设置。"""
    global _vis_level
    _vis_level = 0.0 if v < 0 else (1.0 if v > 1 else v)


def visual_tick(force=False):
    """推进并渲染一帧环形动画。主循环与各轮询循环调用，自带限帧。"""
    global _vis_last, _vis_last_ms, _vis_phase
    if not cfg.VISUAL_ENABLED or cfg.St.sleeping or _vis_shades is None:
        return
    now = time.ticks_ms()
    if not force and time.ticks_diff(now, _vis_last_ms) < cfg.VIS_FRAME_MS:
        return
    _vis_last_ms = now

    if _vis_mode == "comet":
        _vis_phase = (_vis_phase + 0.035) % 1.0
    elif _vis_mode == "level":
        _vis_phase = (_vis_phase + 0.02) % 1.0

    lit = _vis_level * cfg.RING_N
    lit_i = int(lit)
    cur = []
    for i in range(cfg.RING_N):
        if _vis_mode == "level":
            if i < lit_i:
                k = 7
            elif i == lit_i:
                k = 2 + int(5 * (lit - lit_i))
            else:
                k = 1
        elif _vis_mode == "comet":
            d = ((i / cfg.RING_N) - _vis_phase) % 1.0
            k = 7 - int(d * 22)
            if k < 1:
                k = 1
        else:
            k = 4 if (i % 3 == 0) else 1
        cur.append(k)

    prev = _vis_last
    for i in range(cfg.RING_N):
        if prev is not None and prev[i] == cur[i]:
            continue          # 差分：亮度没变的段不重绘
        x, y, w, h = _ring_rects[i]
        Lcd.fillRect(x, y, w, h, _vis_shades[cur[i]])
    _vis_last = cur


def _vis_wait(duration, levels):
    """等待 duration 秒，其间按 levels（子片 RMS 序列）推进电平动画。"""
    if not cfg.VISUAL_ENABLED or not levels:
        time.sleep(duration)
        return
    step = duration / len(levels)
    for lv in levels:
        _vis_set_level(lv)
        visual_tick()
        time.sleep(step)

# ── 分层重绘 ──────────────────────────────────────────────────
#
# 旧实现每次 draw_state 都全屏重解码 JPEG（约 100ms+），一轮对话调用
# 6~8 次 → 肉眼可见的连续闪烁。现在拆成独立图层，各自只在内容真正
# 变化时重绘；顶栏/文字用实心条带打底，才能局部擦除而不破坏背景。


# ── 图片加载（自动适配 jpg / png / bmp）──────────────────────
#
# 固件是否提供 drawPng / drawBmp 因版本而异，这里做能力探测：
# 只把真实存在的绘制方法登记进 _IMG_FORMATS，缺失的格式直接跳过。
# 资源文件不带扩展名调用，例如 draw_image("img_bg")。

_IMG_FORMATS = []
for _ext, _fname in ((".jpg", "drawJpg"), (".jpeg", "drawJpg"),
                     (".png", "drawPng"), (".bmp", "drawBmp")):
    _f = getattr(Lcd, _fname, None)
    if _f is not None:
        _IMG_FORMATS.append((_ext, _f))


def draw_image(basename, x=0, y=0):
    """在 resource 目录下按 jpg→png→bmp 顺序找图并绘制。

    画出返回 True；文件不存在或固件不支持该格式返回 False（调用方降级）。
    """
    for ext, fn in _IMG_FORMATS:
        path = cfg.res(basename + ext)
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            continue                  # 换下一个扩展名
        try:
            fn(data, x, y)
            return True
        except Exception as e:
            print("[ui] draw", path, "failed:", e)
    return False


_drawn_bg     = None
_drawn_chrome = None
_drawn_face   = None
_drawn_status = None
_drawn_chat   = None


def draw_state(state, force=False):
    """
    更新屏幕和 LED 到指定状态（分层增量重绘）。

    屏幕布局（320×240，横屏）:
      y=0-2    : 彩色主题条
      y=3-25   : 顶栏（CONT / WAKE / 时间 + 电量）
      y=26-150 : 环形动画区（环心为表情面板）
      y=152-205: 最近一轮对话文本（仅 idle）
      y=208-240: 状态文字
    """
    global _drawn_bg, _drawn_chrome, _drawn_face, _drawn_status, _drawn_chat
    face, status, color = cfg.STATE_UI.get(state, cfg.STATE_UI["idle"])
    r = (color >> 16) & 0xff
    g = (color >> 8)  & 0xff
    b = color & 0xff
    hw._set_led(r // 4, g // 4, b // 4)

    # ── 层 1：背景（只在目标背景真正变化时重绘）──────────────
    want_bg = (cfg.IMG_MAP.get(state) if cfg.USE_STATE_IMAGES else None) or "img_bg"
    if force or want_bg != _drawn_bg:
        if not draw_image(want_bg):
            Widgets.fillScreen(0x0a0a0a)   # 无图片资源：纯色背景
        _drawn_bg = want_bg
        # 背景重画后所有叠加层失效
        _drawn_chrome = None
        _drawn_face   = None
        _drawn_status = None
        _drawn_chat   = None
        _vis_invalidate()

    # ── 层 2：顶栏（值变化才重绘该条带）──────────────────────
    cm_color = 0x00ffcc if cfg.St.continuous else 0x3a3a3a
    wm_color = 0xffcc00 if cfg.St.wake       else 0x3a3a3a
    time_str = clock.get_rtc_time_str()
    try:
        v = M5.Power.getBatteryVoltage()   # mV，3000-4200
        bat = max(0, min(100, (v - 3000) * 100 // 1200))
        bat_str = "{}%".format(bat)
    except Exception:
        bat_str = "--"
    right_str = "{} {}".format(time_str, bat_str) if time_str else bat_str
    chrome_key = (cm_color, wm_color, right_str, color)
    if chrome_key != _drawn_chrome:
        hw._fill_rect(0, 0, 320, 26, cfg.CHROME_BG)
        Widgets.Line(0, 0, 320, 0, color)
        Widgets.Line(0, 1, 320, 1, color)
        Widgets.Line(0, 2, 320, 2, color)
        Lcd.setFont(_FONT_16)
        Lcd.setTextSize(1)
        Lcd.setTextColor(cm_color, cfg.CHROME_BG)
        Lcd.drawString("CONT", 10, 6)
        Lcd.setTextColor(wm_color, cfg.CHROME_BG)
        Lcd.drawString("WAKE", 90, 6)
        Lcd.setTextColor(0x888888, cfg.CHROME_BG)
        Lcd.drawString(right_str, max(180, 310 - len(right_str) * 10), 6)
        _drawn_chrome = chrome_key

    # ── 层 3：环心表情面板 ───────────────────────────────────
    face_key = (face, color)
    if face_key != _drawn_face:
        hw._fill_rect(cfg.RING_CX - 48, cfg.RING_CY - 11, 96, 22, cfg.PLATE_BG)
        Lcd.setFont(_FONT_16)
        Lcd.setTextSize(1)
        Lcd.setTextColor(color, cfg.PLATE_BG)
        Lcd.drawString(face, max(cfg.RING_CX - 46, cfg.RING_CX - len(face) * 6), cfg.RING_CY - 8)
        _drawn_face = face_key

    # ── 层 4：状态文字条带 ───────────────────────────────────
    if status != _drawn_status:
        hw._fill_rect(0, 208, 320, 32, cfg.BAND_BG)
        Lcd.setFont(_FONT_16)
        Lcd.setTextSize(1)
        Lcd.setTextColor(0xdddddd, cfg.BAND_BG)
        Lcd.drawString(status, max(0, (320 - len(status) * 11) // 2), 216)
        _drawn_status = status

    # ── 层 5：待机界面最近一轮对话（需固件带中文字体）────────
    if cfg.SHOW_CHAT_TEXT and _FONT_CN:
        chat_key = (state, _last_user_text, _last_reply_text)
        if chat_key != _drawn_chat:
            if state == "idle" and _last_reply_text:
                hw._fill_rect(0, 152, 320, 54, cfg.BAND_BG)
                Lcd.setFont(_FONT_CN)
                Lcd.setTextSize(1)
                Lcd.setTextColor(0x88ccff, cfg.BAND_BG)
                Lcd.drawString("> " + _last_user_text[:18], 8, 156)
                Lcd.setTextColor(0xbbbbbb, cfg.BAND_BG)
                Lcd.drawString(_last_reply_text[:19], 8, 180)
                Lcd.setFont(_FONT_16)
            elif _drawn_chat is not None:
                hw._fill_rect(0, 152, 320, 54, cfg.BAND_BG)   # 离开 idle：清掉
            _drawn_chat = chat_key

    # ── 层 6：环形动画切换到新状态 ───────────────────────────
    _vis_set_state(state, color)


# ── 息屏 / 唤醒 ───────────────────────────────────────────────

def enter_sleep():
    """息屏休眠：关闭背光和 LED，释放麦克风。"""
    cfg.St.sleeping = True
    hw._set_led(0, 0, 0)
    hw.mic_off()
    M5.Lcd.setBrightness(0)


def wake_up():
    """唤醒：恢复背光，重置活动计时。"""
    cfg.St.sleeping = False
    cfg.St.last_activity = time.time()
    M5.Lcd.setBrightness(64)
    draw_state("idle", force=True)   # 休眠期间跳过了动画，整屏重画一次
