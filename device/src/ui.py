"""Kagura Voice 设备端 —— 屏幕显示：字体、环形可视化、离屏画布合成、息屏唤醒。

draw_state 整屏背景图 + 透明文字，**不要再加实心条带**——
分层重绘垫黑底那版被否过（照片被上下黑边夹住）。
"""

import M5
from M5 import *
from hardware import *
import time
import math
import gc
import ubinascii

import cfg
import hw
import clock

# ── 字体 ───────────────────────────────────────────────────────
_FONT_16 = Widgets.FONTS.DejaVu18


# 中文字体：UIFlow2 固件带 EFontCN 系列则用于屏显对话文本，否则跳过文本显示
_FONT_CN = (getattr(Widgets.FONTS, "EFontCN16", None)
            or getattr(Widgets.FONTS, "EFontCN14", None))


_last_user_text  = ""


_last_reply_text = ""


def _update_chat_text(user_b64, reply_b64):
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

_IMG_MAP = {
    "recording":  "img_recording",
    "processing": "img_processing",
    "playing":    "img_playing",
    "broadcast":  "img_playing",   # broadcast 复用 playing 图片
    # 触觉三态先复用 processing 的图，不必额外准备素材。想各配一张就把值改成
    # img_petted / img_poked / img_held 再传图；缺图会退回 img_bg（见 _img_missing）。
    "petted":     "img_processing",   # 被抚摸（屏幕上有手指在滑）
    "poked":      "img_processing",   # 机身被轻拍
    "held":       "img_processing",   # 被从桌上拿起来
}


# 试过但确实不存在的背景图。没有这个缓存的话，缺图状态每次重绘都要白开一次
# 文件、打一行 img err、再解一次 img_bg——等于每次被摸都多花 100ms 在必然
# 失败的尝试上，而反射层是全设备最吃延迟的一条路径。
# 代价：传了新图必须重启设备才认（缓存只在开机时清空）。
_img_missing = set()


# 无视 USE_STATE_IMAGES 的强制背景。直播时屏幕不显示实时画面、也不写文字提示，
# 全靠换这张图告知摄像头正开着——属于功能，不是装饰，所以不跟随那个开关。
# 没上传 /flash/img_streaming.jpg 也不要紧，下面读文件失败会退回纯色。
_FORCED_IMG = {
    "streaming": "img_streaming",
}


# 上一次画上屏的内容键。draw_state 整屏一起重画，所以只需要一个键：
# 键相同 = 这一屏跟屏幕上现有的完全一样 → 直接跳过，不重解码 JPEG。
_drawn_key = None


_canvas = None          # 全屏离屏画布（懒分配，失败则永久退回直接画屏）


_canvas_tried = False


def _get_canvas():
    """取全屏离屏画布；不可用返回 None，调用方直接画屏。"""
    global _canvas, _canvas_tried
    if _canvas is not None or _canvas_tried:
        return _canvas
    _canvas_tried = True                 # 只试一次，失败别每帧白试
    if not cfg.USE_CANVAS or not hasattr(Lcd, "newCanvas"):
        return None
    try:
        _canvas = Lcd.newCanvas(w=320, h=240, bpp=16, psram=True)
        print("[ui] offscreen canvas ready")
    except Exception as e:
        print("[ui] canvas unavailable, direct draw:", e)
        _canvas = None
    return _canvas


def _canvas_disable():
    """画布出问题时永久退回直接画屏，并把这块内存还回去。"""
    global _canvas
    cv, _canvas = _canvas, None
    if cv is None:
        return
    try:
        cv.delete()          # binding 暴露的是 delete，没有 deleteSprite
    except Exception:
        pass
    gc.collect()


def _ui_invalidate():
    """整屏被 draw_state 之外的代码接管过之后必须调用。

    分层重绘的前提是"屏幕内容 == 缓存键描述的内容"。取景预览、摇晃彩蛋、
    WiFi 配网界面都会直接 fillScreen/drawJpg 铺满屏幕，此时缓存仍以为
    屏幕是它上次画的样子，下一次 draw_state 会判定"无变化"而跳过重绘，
    结果就是上一屏画面残留。谁盖了屏幕谁在盖之前调这个。
    """
    global _drawn_key
    _drawn_key = None
    _vis_invalidate()


def draw_state(state, force=False):
    """
    更新屏幕和 LED 到指定状态。

    渲染方式：整屏背景图 + 透明文字直接压在图上（不铺实心条带）。
    代价是擦不掉单独一处文字，任一处内容变化都得整屏重建；换来的是
    照片能铺满，没有上下黑边和表情面板。

    但保留了内容键比对：**内容没变就整个跳过**。旧实现是每次调用都无条件
    全屏重解码 JPEG（单次约 100ms），一轮对话调用 6~8 次，肉眼可见连续闪烁；
    现在同一状态被反复调用（心跳/轮询/连续模式）不会再重画。

    屏幕布局（320×240，横屏）:
      y=0-2   : 彩色主题条
      y=3-25  : 顶栏（CONT / WAKE / CAM / 时间 + 电量）
      y=90    : kaomoji（仅在背景图缺失时显示）
      y=152-205: 最近一轮对话文本（仅 idle）
      y=216   : 状态文字
    """
    global _drawn_key
    face, status, color = cfg.STATE_UI.get(state, cfg.STATE_UI["idle"])

    # ── 先算出这一屏的全部内容，再决定要不要重画 ──────────────
    # _FORCED_IMG 不看 USE_STATE_IMAGES：直播态换图是功能需求（屏幕上不写
    # "直播中"，靠画面本身告知摄像头开着），不是装饰性的每状态配图。
    want_bg = (_FORCED_IMG.get(state)
               or (_IMG_MAP.get(state) if cfg.USE_STATE_IMAGES else None)
               or "img_bg")
    # 已知缺图的直接改成 img_bg：要赶在算 key 之前，否则 key 记的是"想画的图"、
    # 屏幕上是"实际画的图"，两者不一致会让缓存判断失去意义。
    if want_bg in _img_missing:
        want_bg = "img_bg"
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
    show_chat = (state == "idle" and cfg.SHOW_CHAT_TEXT and _FONT_CN
                 and _last_reply_text)
    chat_key = (_last_user_text[:18], _last_reply_text[:19]) if show_chat else None

    key = (want_bg, cm_color, wm_color, right_str, color, face, status, chat_key)
    if not force and key == _drawn_key:
        return
    _drawn_key = key

    r = (color >> 16) & 0xff
    g = (color >> 8)  & 0xff
    b = color & 0xff
    hw._set_led(r // 4, g // 4, b // 4)

    # 画到离屏画布还是直接画屏。tgt 拿到什么，下面所有绘制就都往那儿去——
    # 画布暴露的方法名跟 Lcd 一致（drawJpg/drawString/setFont/fillRect…），
    # 所以这里只换目标，不分叉两套绘制代码。
    tgt = _get_canvas() or Lcd

    # ── 1：背景层（整屏 320×240 从 0,0 开始）────────────────
    img_shown = False
    try:
        with open(cfg.res("{}.jpg".format(want_bg)), "rb") as _f:
            tgt.drawJpg(_f.read(), 0, 0)
        img_shown = True
    except Exception as e:
        print("img err:", e)
        if want_bg != "img_bg":
            _img_missing.add(want_bg)   # 记下来，下次别再白试
    if not img_shown and want_bg != "img_bg":
        try:
            with open(cfg.res("img_bg.jpg"), "rb") as _f:
                tgt.drawJpg(_f.read(), 0, 0)
            img_shown = True
        except Exception as e:
            print("[ui] bg fallback to solid color:", e)
    if not img_shown:
        # 用 fillRect 而不是 fillScreen：fillRect 在 Lcd 和画布上都验证过，
        # 少一个"应该有吧"的 API 赌注
        tgt.fillRect(0, 0, 320, 240, 0x1a1a1a)

    # ── 2：彩色状态条 + 顶栏（透明背景，悬浮在图片上）────────
    tgt.fillRect(0, 0, 320, 3, color)     # 原先是三条 Widgets.Line，等价
    tgt.setFont(_FONT_16)
    tgt.setTextSize(1)
    tgt.setTextColor(cm_color, cm_color)
    tgt.drawString("CONT", 10, 6)
    tgt.setTextColor(wm_color, wm_color)
    tgt.drawString("WAKE", 90, 6)
    # CAM：可点的键（命中区 _CAM_ENTRY），点它进取景模式
    if cfg.CAMERA_MODE_ENABLED:
        tgt.setTextColor(0xaa66ff, 0xaa66ff)
        tgt.drawString("CAM", 145, 6)
    tgt.setTextColor(0x666666, 0x666666)
    tgt.drawString(right_str, max(180, 310 - len(right_str) * 10), 6)

    # ── 3：kaomoji（只在背景图都没读到时兜底显示）────────────
    if not img_shown:
        tgt.setTextSize(3)
        tgt.setTextColor(color, color)
        tgt.drawString(face, max(0, (320 - len(face) * 34) // 2), 90)
        tgt.setTextSize(1)

    # ── 4：状态文字 ─────────────────────────────────────────
    tgt.setTextColor(0xffffff if img_shown else 0x999999,
                     0xffffff if img_shown else 0x999999)
    tgt.drawString(status, max(0, (320 - len(status) * 11) // 2), 216)

    # ── 5：待机界面显示最近一轮对话（需固件带中文字体）────────
    if show_chat:
        tgt.setFont(_FONT_CN)
        tgt.setTextColor(0x88ccff, 0x88ccff)
        tgt.drawString("> " + _last_user_text[:18], 8, 160)
        tgt.setTextColor(0xcccccc, 0xcccccc)
        tgt.drawString(_last_reply_text[:19], 8, 184)
        tgt.setFont(_FONT_16)

    # ── 6：一次性推屏。到这里为止屏幕一个像素都没变过，push 完整屏同时更新 ──
    if tgt is not Lcd:
        try:
            tgt.push(0, 0)
        except Exception as e:
            # 推屏失败等于这一帧白画了，屏幕还停在上一屏。作废画布退回直接画屏，
            # 并清掉 _drawn_key，让下一次 draw_state 无条件重画一遍。
            print("[ui] canvas push failed, falling back to direct draw:", e)
            _canvas_disable()
            _drawn_key = None

    # ── 7：环形动画切换到新状态（VISUAL_ENABLED=False 时为空操作）──
    # 必须在 push 之后：它直接往屏幕上画，画在画布合成期间会被 push 盖掉
    _vis_set_state(state, color)


def _mk_canvas(w, h, psram):
    """挨个试 newCanvas 的调用形式，返回 (画布, 用的第几种)。

    别因为签名对不上就误判成"固件不支持"——文档写的是关键字参数，但 binding
    到底是关键字还是位置、psram 参数在不在，都是猜的。一次烧录机会别浪费在
    TypeError 上。返回的形式编号很重要：3/4 号忽略 psram，那两种情况下
    psram=True/False 的对比数据没有意义。
    """
    forms = (
        lambda: Lcd.newCanvas(w=w, h=h, bpp=16, psram=psram),
        lambda: Lcd.newCanvas(w, h, 16, psram),
        lambda: Lcd.newCanvas(w, h, 16),
        lambda: Lcd.newCanvas(w, h),
    )
    last = None
    for i in range(len(forms)):
        try:
            cv = forms[i]()
            if cv is not None:
                return cv, i + 1
        except Exception as e:
            last = e
    if last:
        raise last
    raise OSError("newCanvas returned None")


# ── 主循环 ────────────────────────────────────────────────────

def enter_sleep():
    """息屏休眠：关闭背光和 LED，释放麦克风。"""
    cfg.St.sleeping = True
    hw._set_led(0, 0, 0)
    hw._mic_off()
    M5.Lcd.setBrightness(0)


def wake_up():
    """唤醒：恢复背光，重置活动计时。"""
    cfg.St.sleeping = False
    cfg.St.last_activity = time.time()
    M5.Lcd.setBrightness(64)
    draw_state("idle", force=True)   # 休眠期间跳过了动画，整屏重画一次
