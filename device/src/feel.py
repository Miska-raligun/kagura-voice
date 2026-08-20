"""Kagura Voice 设备端 —— 触觉三层：反射（本地即时换表情）/ 体感（聚合成 X-Touch 随对话捎走）/
惊动（显著接触才让 agent 主动开口，带冷却）。
"""

from M5 import *
import time
import requests as urequests

import cfg
import hw
import clock
import ui

_feel_reflex_state = None    # 反射层当前占用的屏幕状态


_feel_reflex_until = 0       # 反射表情的收回时间


_imu_tap_spikes    = []      # 近期尖峰时间戳（区分轻拍 vs 摇晃）


_imu_tap_pending   = None    # 待确认的轻拍时间戳（ms）


_imu_last_motion   = 0       # 最近一次"在动"的时间戳（秒）


_imu_move_since    = None    # 本段连续运动的起点（ms）


_imu_still_before  = 0       # 本段运动开始前静止了多久（秒）


_imu_carried       = False   # 当前是否处于"被端着/拿在手上"


_imu_carry_start   = 0       # 本次被端起来的时间戳（秒）


# ── 触觉：反射层 ──────────────────────────────────────────────

def feel_reflex(state, secs=cfg.FEEL_REFLEX_LINGER):
    """立刻切表情，secs 后由 feel_reflex_tick 自动收回。**不阻塞**。

    别在这里 sleep：主循环还要喂看门狗、收 MQTT。反射的全部意义就是
    "被摸的当下就有反应"，一旦阻塞，后面的触摸采样就断了。

    **同一个反射态重复调用绝不重画**，这条是治闪烁的关键，别去掉：
    抚摸期间本函数每轮主循环都被调（几十次每秒），原先每次都往 draw_state
    里送，指望它的 _drawn_key 比对挡住——但那个 key 里有电量百分比，
    而 `(v-3000)*100//1200` 里 12mV 就是 1%，ADC 读数本来就在跳（WiFi 发包
    时电压还会塌一下）。百分比一变 key 就变，于是整屏 JPEG 被反复重解码，
    肉眼就是持续闪烁。这里自己挡住，不依赖 key 比对。
    """
    global _feel_reflex_state, _feel_reflex_until
    if cfg.St.busy or cfg.St.sleeping:
        return
    _feel_reflex_until = time.time() + secs   # 续期总是要做的
    if _feel_reflex_state == state:
        return                                # 已经在这个表情上：一个像素都别动
    if cfg.FEEL_DEBUG:
        print("[feel] redraw ->", state, "(from", _feel_reflex_state, ")")
    _feel_reflex_state = state
    ui.draw_state(state)


def feel_reflex_clear():
    """放弃当前反射表情（业务流程要接管屏幕时调）。"""
    global _feel_reflex_state
    _feel_reflex_state = None


def feel_reflex_tick():
    """主循环调用：确认人真的不碰了，才收回待机屏。

    **收回的判据是"屏幕上还有没有手"，不是倒计时**，这是治来回闪的关键：
    抚摸天然是"划一下—停一下—再划一下"，停顿里手指还在屏幕上，或者刚离手
    半秒又落下。按倒计时收，停顿一超时就掉回 idle，下一划又切回表情图，
    两张整屏 JPEG 来回解码，看起来就是画面一直在闪。
    另外触摸驱动偶发漏报一帧（getCount 返回 0）也会走同一条老路。

    IMU 触发的反射（poked/held）屏幕上本来就没有手，`_touch_seen_ms` 是旧值，
    自然落到下面的时间判据上，两条路各走各的。
    """
    global _feel_reflex_state
    if _feel_reflex_state is None:
        return
    if cfg.St.busy or cfg.St.sleeping:
        _feel_reflex_state = None      # 屏幕已被别人接管，反射作废
        return
    if time.ticks_diff(time.ticks_ms(), hw._touch_seen_ms) < cfg._FEEL_LINGER_MS:
        return                         # 人还在摸（或刚离手），一个像素都别动
    if time.time() >= _feel_reflex_until:
        if cfg.FEEL_DEBUG:
            print("[feel] redraw -> idle (from", _feel_reflex_state, ")")
        _feel_reflex_state = None
        ui.draw_state("idle")


# ── 触觉：体感层 ──────────────────────────────────────────────

def feel_touched():
    """记一次"被碰到"，返回**被碰之前**已经安静了多久（秒）。

    返回值是"冷落时长"，惊动层用它判断这次触碰是不是久别重逢——
    连着摸十次不该让她十次都很惊喜，隔了两小时的第一次才该。
    """
    now = time.time()
    quiet = (now - cfg.Feel.last_touch) if cfg.Feel.last_touch else 0
    cfg.Feel.last_touch = now
    cfg.St.last_activity = now             # 被摸也算交互，顺延休眠计时
    return quiet


def feel_header():
    """打包体感窗口成 X-Touch 头（k=v,k=v）。**取走即清空**，没内容返回 ""。

    清空放在这里而不是等请求成功：请求失败就丢掉这一窗口的体感，是有意的——
    宁可漏报也不要把过期的"刚被摸了"在几分钟后才注入进对话。
    """
    parts = []
    if cfg.Feel.stroke_secs >= 1:
        parts.append("stroke=%d" % int(cfg.Feel.stroke_secs))
    if cfg.Feel.strokes:
        parts.append("strokes=%d" % cfg.Feel.strokes)
    if cfg.Feel.cradles:
        parts.append("cradles=%d" % cfg.Feel.cradles)
    if cfg.Feel.taps:
        parts.append("taps=%d" % cfg.Feel.taps)
    if cfg.Feel.pickups:
        parts.append("pickups=%d" % cfg.Feel.pickups)
    if cfg.Feel.carry_secs >= 1:
        parts.append("carry=%d" % int(cfg.Feel.carry_secs))
    if cfg.Feel.last_touch:
        quiet = int(time.time() - cfg.Feel.last_touch)
        if quiet >= cfg.FEEL_QUIET_SECS:
            parts.append("quiet=%d" % quiet)
    cfg.Feel.stroke_secs = 0.0
    cfg.Feel.strokes     = 0
    cfg.Feel.cradles     = 0
    cfg.Feel.taps        = 0
    cfg.Feel.pickups     = 0
    cfg.Feel.carry_secs  = 0.0
    return ",".join(parts)


def _feel_headers(base):
    """给已有请求头补上 X-Touch。没有体感可报就原样返回。"""
    if not cfg.TOUCH_FEEL_ENABLED:
        return base
    try:
        h = feel_header()
        if h:
            base["X-Touch"] = h
    except Exception as e:
        print("[feel] header err:", e)
    return base


# ── 触觉：惊动层 ──────────────────────────────────────────────

def feel_notify(kind, detail=""):
    """让 agent 主动开口。有冷却，且忙/休眠/直播时不打扰。返回是否真的发了。

    走 /touch，链路与 /shake 相同：服务端立即返回、后台跑 OpenClaw，
    回复经 cores3-speak → /push → MQTT 回到设备播放。
    """
    if not (cfg.TOUCH_FEEL_ENABLED and cfg.FEEL_NOTIFY_ENABLED):
        return False
    now = time.time()
    if cfg.St.busy or cfg.St.sleeping or cfg.St.streaming:
        return False
    if now - cfg.Feel.last_notify < cfg.FEEL_NOTIFY_COOLDOWN:
        return False
    cfg.Feel.last_notify = now
    feel_reflex_clear()
    cfg.St.busy = True
    try:
        ui.draw_state("processing")
        hdrs = {"X-Device-Id": cfg.DEVICE_ID, "X-Touch-Kind": kind}
        if detail:
            hdrs["X-Touch-Detail"] = detail
        lt = clock.get_local_time_header()
        if lt:
            hdrs["X-Local-Time"] = lt
        # 这里**故意不带 X-Touch**：feel_header() 取走即清空，而 /touch 只用
        # X-Touch-Detail 造 prompt，带上等于把体感窗口白白清掉，
        # 下次真正对话时就没得注入了。窗口只交给 /chat。
        resp = urequests.get(cfg.SERVER_BASE + "/touch", headers=hdrs,
                             timeout=cfg.REQUEST_TIMEOUT_SHORT)
        resp.close()
        print("[feel] notify:", kind, detail)
    except OSError as e:
        print("[feel] notify err:", e)
    finally:
        cfg.St.busy = False
        ui.draw_state("idle")
    return True


def feel_on_touch_end(kind):
    """屏幕上的抚摸/捧着结束：结算体感，够显著就惊动 agent。"""
    secs  = hw._touch_last_ms / 1000.0
    quiet = feel_touched()
    if kind == 'cradle':
        cfg.Feel.cradles += 1
    else:
        cfg.Feel.strokes    += 1
        cfg.Feel.stroke_secs += secs
    # 先问要不要惊动：feel_notify 会自己接管屏幕（processing → idle），
    # 反射表情画在它前面就是一次白扔的整屏 JPEG 解码（约 100ms）。
    # 冷却没过 / 关了开关时 feel_notify 返回 False，这时才补上留一会儿的表情。
    if ((secs >= cfg.FEEL_STROKE_NOTIFY or quiet >= cfg.FEEL_QUIET_SECS)
            and feel_notify(kind, "secs=%d,quiet=%d" % (int(secs), int(quiet)))):
        return
    feel_reflex("petted")              # 抬手之后表情再留一会儿


def _imu_feel_detect(magnitude):
    """本体感觉：被轻拍 / 被拿起来 / 被抱着走 / 放下。

    与摇晃彩蛋共用同一个样本流，靠"尖峰个数"区分：孤立的一两下 = 轻拍，
    500ms 内三下以上 = 摇晃，交给彩蛋，这里必须放手（否则摇一摇会先被
    当成轻拍开一次口，再触发彩蛋又开一次）。
    """
    global _imu_tap_spikes, _imu_tap_pending
    global _imu_last_motion, _imu_move_since, _imu_still_before
    global _imu_carried, _imu_carry_start

    now    = time.time()
    now_ms = time.ticks_ms()
    dev    = abs(magnitude - 1.0)

    # ── 轻拍：孤立的中等尖峰，延后 IMU_TAP_CONFIRM_MS 确认 ──
    if magnitude >= cfg.IMU_TAP_G:
        _imu_tap_spikes.append(now_ms)
        if _imu_tap_pending is None:
            _imu_tap_pending = now_ms
    # 尖峰列表用 IMU_TAP_G 收，是摇晃检测（IMU_SHAKE_G）的超集，
    # 所以它数到 3 一定不晚于摇晃判定成立——摇晃永远能抢在确认前撤销轻拍。
    _imu_tap_spikes[:] = [t for t in _imu_tap_spikes
                          if time.ticks_diff(now_ms, t) < cfg.IMU_TAP_SPIKE_WIN]
    if _imu_tap_pending is not None:
        if len(_imu_tap_spikes) >= cfg.IMU_SHAKE_COUNT:
            _imu_tap_pending = None            # 是摇晃，让给彩蛋
        elif time.ticks_diff(now_ms, _imu_tap_pending) >= cfg.IMU_TAP_CONFIRM_MS:
            _imu_tap_pending = None
            _on_tapped()

    # ── 运动/静止：被拿起来 = 长时间静止之后的一段持续运动 ──
    if dev >= cfg.IMU_MOTION_BAND:
        if _imu_move_since is None:
            _imu_move_since   = now_ms
            # 运动开始前静止了多久，要在这一刻捕获：_imu_last_motion 随后
            # 每个采样都会被刷新，等确认拿起时再算就永远是 0。
            _imu_still_before = (now - _imu_last_motion) if _imu_last_motion else 0
        _imu_last_motion = now
        if (not _imu_carried
                and time.ticks_diff(now_ms, _imu_move_since) >= cfg.IMU_PICKUP_MOVE_MS):
            _imu_carried     = True
            _imu_carry_start = now
            if _imu_still_before >= cfg.IMU_PICKUP_STILL:
                _on_picked_up(_imu_still_before)
    elif _imu_move_since is not None and (now - _imu_last_motion) >= cfg.IMU_CARRY_GAP:
        # 走路时合加速度会反复穿过阈值，所以要静止满 IMU_CARRY_GAP 才算放下
        _imu_move_since = None
        if _imu_carried:
            _imu_carried = False
            cfg.Feel.carry_secs += now - _imu_carry_start


def _on_tapped():
    """机身被轻拍：反射 + 计数。轻拍意图明确（"喂，看这边"），值得开口。

    被端在手上时一律不算轻拍：走动本身就会不停制造 1.5g 以上的尖峰，
    不挡掉的话拿着她走两步就是几十次"被拍"，还会顶着冷却反复开口。
    """
    if _imu_carried:
        return
    quiet = feel_touched()
    cfg.Feel.taps += 1
    feel_reflex("poked")
    feel_notify("tap", "quiet=%d" % int(quiet))


def _on_picked_up(still_before):
    """被从桌上拿起来：这是最明确的"我想跟你互动"信号。"""
    quiet = feel_touched()
    cfg.Feel.pickups += 1
    if cfg.St.sleeping:
        if cfg.FEEL_WAKE_ON_PICKUP:
            ui.wake_up()
        return                     # 刚被叫醒就主动说话太吓人，这次不惊动
    feel_reflex("held")
    feel_notify("pickup", "quiet=%d,still=%d" % (int(quiet), int(still_before)))
