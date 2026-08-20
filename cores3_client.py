import M5
from M5 import *
from hardware import *
import requests as urequests
import time
import struct
import math
import array as uarray
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
# 中文字体：UIFlow2 固件带 EFontCN 系列则用于屏显对话文本，否则跳过文本显示
_FONT_CN = (getattr(Widgets.FONTS, "EFontCN16", None)
            or getattr(Widgets.FONTS, "EFontCN14", None))

# ── 屏显对话文本（服务端 X-User-Text / X-Reply-Text 头，b64 UTF-8） ──
SHOW_CHAT_TEXT = True
_last_user_text  = ""
_last_reply_text = ""


def _update_chat_text(user_b64, reply_b64):
    """解码响应头里的对话文本，供待机界面显示。解码失败静默跳过。"""
    global _last_user_text, _last_reply_text
    if not SHOW_CHAT_TEXT:
        return
    try:
        if user_b64:
            _last_user_text = ubinascii.a2b_base64(user_b64).decode("utf-8")
        if reply_b64:
            _last_reply_text = ubinascii.a2b_base64(reply_b64).decode("utf-8")
    except Exception as e:
        print("[ui] chat text decode err:", e)

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
REQUEST_TIMEOUT_UPLOAD = 30  # /upload-photo（QVGA 帧 base64 约 205KB，15s 太紧）

# 直播推流：与服务端 stream_server.py 对接。留空 token = 不校验，
# 与 /upload-photo 等其它设备→服务端接口的口径一致。
STREAM_PORT   = 5002
STREAM_TOKEN  = ""

# ── 录音参数 ──────────────────────────────────────────────────

SAMPLE_RATE      = 16000
CHUNK_SEC        = 0.25   # 0.5→0.25：块越小，说话结束判定越快（需真机确认 VAD 稳定）
CHUNK_SIZE       = int(SAMPLE_RATE * 2 * CHUNK_SEC)
SILENCE_THRESHOLD = 500   # RMS 低于此值视为静音
SILENCE_CHUNKS   = 5      # 连续 N 个静音块后停止录音（5×0.25=1.25s，原为 2s）
MAX_CHUNKS       = 40     # 最大录音块数（上限：MAX_CHUNKS × CHUNK_SEC = 10 秒不变）

# 唤醒模式下麦克风常开（避免每 100ms 建拆一次 I2S 驱动）。
# 真机上如与 Speaker 冲突（无声/杂音），改回 False 即恢复旧行为。
WAKE_MIC_PERSISTENT = True

# ── 音量（语音可调："小声一点/大声一点"，服务端回 X-Volume 头） ──
_VOLUME_PATH = "/flash/volume.json"
_volume = 0.6


def _volume_load():
    global _volume
    try:
        with open(_VOLUME_PATH, "r") as f:
            v = ujson.load(f).get("volume")
        if isinstance(v, (int, float)) and 0.2 <= v <= 1.0:
            _volume = v
    except Exception:
        pass   # 无存档用默认值


def _volume_adjust(direction):
    """direction: 'up'/'down'，步进 0.2，范围 [0.2, 1.0]，持久化到 flash。"""
    global _volume
    step = 0.2 if direction == "up" else -0.2
    _volume = max(0.2, min(1.0, round(_volume + step, 1)))
    try:
        with open(_VOLUME_PATH, "w") as f:
            ujson.dump({"volume": _volume}, f)
    except Exception as e:
        print("[vol] save err:", e)
    print("[vol] volume =", _volume)

_mic_active = False


def _mic_on():
    """幂等开麦。Mic 与 Speaker 共享音频通路，播放前必须 _mic_off()。"""
    global _mic_active
    if not _mic_active:
        Mic.begin()
        _mic_active = True


def _mic_off():
    global _mic_active
    if _mic_active:
        Mic.end()
        _mic_active = False

# ── 远程诊断：事件环形日志 + 心跳上报 ─────────────────────────
# dbg() 记录网络/MQTT 关键事件到内存环形缓冲（40 条），随每分钟心跳
# POST /heartbeat 上传服务端落盘。设备"开着机但失联"期间发生了什么，
# 恢复后第一个心跳就能在服务端看到，无需 USB 串口。

_HB_INTERVAL   = 60    # 心跳间隔（秒）
_NET_CHECK_IVL = 15    # 网络自检间隔（秒）
_NET_FIX1_SECS = 600   # 与服务端失联 10 分钟 → WiFi 栈软重建
_NET_FIX2_SECS = 1500  # 失联 25 分钟 → 整机复位（uptime>1h 门槛=每小时最多一次）

_dbg_buf  = []
_dbg_sent      = 0     # 下一条未上传（心跳）日志的下标
_dbg_persisted = 0     # 下一条未持久化（flash）日志的下标
_hb_last  = 0
_net_last_check      = 0
_wifi_reconnect_last = 0
_wifi_was_ok = True
_mqtt_ok     = False
_net_dot     = None    # 屏幕右上角状态点当前色: 'g'/'y'/'r'
_pwr_last    = None    # USB 供电状态（isCharging）上次采样值
_boot_ticks  = time.ticks_ms()
_boot_time   = time.time()
_last_server_ok = time.time()   # 最近一次成功联络服务端（心跳 200）
_net_fix_stage  = 0             # 0=正常 1=已做过 WiFi 栈重建


def dbg(msg):
    """记录一条诊断事件（内存环形缓冲 + 串口）。"""
    global _dbg_buf, _dbg_sent, _dbg_persisted
    ts = get_rtc_time_str() or "--:--"
    _dbg_buf.append("{} {}".format(ts, msg))
    if len(_dbg_buf) > 40:
        drop = len(_dbg_buf) - 40
        _dbg_buf = _dbg_buf[drop:]
        _dbg_sent = max(0, _dbg_sent - drop)
        _dbg_persisted = max(0, _dbg_persisted - drop)
    print("[dbg]", msg)


def _persist_dbg(reason):
    """把未持久化的 dbg 日志追加进 /flash/crash.log——开机上报会带走它。
    失联期间的事件因此能挺过断电/硬重启（7/29 失联 4h 的证据就是这样丢的）。
    24KB 上限防反复写穿 flash。"""
    global _dbg_persisted
    try:
        try:
            if uos.stat("/flash/crash.log")[6] > 24576:
                return
        except OSError:
            pass
        lines = _dbg_buf[_dbg_persisted:]
        with open("/flash/crash.log", "a") as f:
            f.write("=== netlog ({}) ===\n".format(reason))
            for l in lines:
                f.write(l + "\n")
        _dbg_persisted = len(_dbg_buf)
    except Exception:
        pass


def _wifi_ok():
    try:
        return _wlan is not None and _wlan.isconnected()
    except Exception:
        return False


def _draw_net_dot(state):
    """右上角 5px 状态点：绿=在线 黄=WiFi通/MQTT断 红=WiFi断。"""
    color = {"g": 0x00cc44, "y": 0xffcc00, "r": 0xff3333}[state]
    try:
        Lcd.fillCircle(310, 10, 5, color)
    except Exception:
        try:
            Lcd.fillRect(305, 5, 10, 10, color)
        except Exception:
            pass


def net_watch_tick():
    """主循环调用：15s 一次连通性自检。WiFi 掉线自动重连（30s 退避），
    状态变化写 dbg 日志并更新屏幕状态点。"""
    global _net_last_check, _wifi_reconnect_last, _wifi_was_ok, _net_dot
    now = time.time()
    if now - _net_last_check < _NET_CHECK_IVL:
        return
    _net_last_check = now

    wifi_ok = _wifi_ok()
    if wifi_ok != _wifi_was_ok:
        dbg("wifi restored" if wifi_ok else "wifi LOST")
        _wifi_was_ok = wifi_ok

    if not wifi_ok and now - _wifi_reconnect_last >= 30:
        _wifi_reconnect_last = now
        cfg = _wifi_load()
        if cfg and cfg.get("ssid"):
            dbg("wifi reconnect -> {}".format(cfg["ssid"]))
            try:
                wlan = _wlan_if()
                try:
                    wlan.disconnect()
                except Exception:
                    pass
                # 非阻塞发起连接，结果由下轮自检确认
                if cfg.get("password"):
                    wlan.connect(cfg["ssid"], cfg["password"])
                else:
                    wlan.connect(cfg["ssid"])
            except Exception as e:
                dbg("wifi reconnect err: {}".format(e))

    dot = "r" if not wifi_ok else ("g" if _mqtt_ok else "y")
    if dot != _net_dot and not St.sleeping:
        _draw_net_dot(dot)
    globals()["_net_dot"] = dot

    # ── 供电监视（LRN 7/30：夜间"关机"疑似断电/掉电，非软件）──
    # USB 供电状态翻转立即记录并持久化——如果设备靠电池残喘，哪怕只有
    # 几十秒，flash 里也会留下"断电时刻"的证据。
    global _pwr_last
    try:
        chg = M5.Power.isCharging()
        if _pwr_last is not None and chg != _pwr_last:
            dbg("power: charging {}->{} bat={}%".format(
                _pwr_last, chg, M5.Power.getBatteryLevel()))
            _persist_dbg("power-change")
        _pwr_last = chg
    except Exception:
        pass

    # ── 自愈升级（LRN 7/29：WiFi 驱动 wedge 后软重连 4h 无效，断电才恢复）──
    # 失联 10 分钟：WiFi 栈整个关掉重建（active False→True），比裸 connect 更狠；
    # 失联 25 分钟：整机复位。uptime>1h 才允许复位 = 服务端长时间不在
    # （如 PC 关机）时最多每小时重启一次，不会无限快速重启。
    global _net_fix_stage
    dead_for = now - _last_server_ok
    if (not wifi_ok or not _mqtt_ok) and not St.busy:
        if _net_fix_stage == 0 and dead_for > _NET_FIX1_SECS:
            _net_fix_stage = 1
            dbg("netfix1 wifi-stack-reinit dead={}s".format(int(dead_for)))
            _persist_dbg("netfix1")
            try:
                wlan = _wlan_if()
                wlan.active(False)
                time.sleep(1)
                wlan.active(True)
                cfg = _wifi_load()
                if cfg and cfg.get("ssid"):
                    if cfg.get("password"):
                        wlan.connect(cfg["ssid"], cfg["password"])
                    else:
                        wlan.connect(cfg["ssid"])
            except Exception as e:
                dbg("netfix1 err: {}".format(e))
        elif _net_fix_stage == 1 and dead_for > _NET_FIX2_SECS \
                and time.time() - _boot_time > 3600:
            dbg("netfix2 machine-reset dead={}s".format(int(dead_for)))
            _persist_dbg("netfix2-reset")
            time.sleep(1)
            import machine
            machine.reset()


def heartbeat_tick():
    """主循环调用：每分钟向服务端上报状态 + 增量诊断日志。
    交互中(busy)或 WiFi 断开时跳过，不阻塞语音流程。"""
    global _hb_last, _dbg_sent
    now = time.time()
    if now - _hb_last < _HB_INTERVAL or St.busy or not _wifi_ok():
        return
    _hb_last = now
    payload = {
        "device_id": DEVICE_ID,
        "up": time.ticks_diff(time.ticks_ms(), _boot_ticks) // 1000,
        "heap": gc.mem_free(),
        "mqtt": _mqtt_ok,
        "sleeping": St.sleeping,
    }
    try:
        payload["rssi"] = _wlan.status("rssi")
    except Exception:
        pass
    try:
        payload["bat"] = M5.Power.getBatteryLevel()
        payload["chg"] = M5.Power.isCharging()
    except Exception:
        pass
    new_logs = _dbg_buf[_dbg_sent:]
    if new_logs:
        payload["logs"] = new_logs[-20:]
    try:
        resp = urequests.post(
            SERVER_BASE + "/heartbeat",
            data=ujson.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            timeout=5,
        )
        ok = resp.status_code == 200
        resp.close()
        if ok:
            _dbg_sent = len(_dbg_buf)
            globals()["_last_server_ok"] = now
            globals()["_net_fix_stage"] = 0
            if not _rtc_synced:
                sync_rtc()   # 开机时网络未就绪的话，恢复后补同步时间
    except Exception as e:
        print("hb fail:", e)   # 不进 dbg，避免失联期间刷满缓冲

# ── 设备运行状态（跨子系统共享的 flag 全部集中在这里） ──────────
#
# 模式互斥/转移只应通过 toggle_continuous() / toggle_wake_mode() /
# enter_sleep() / wake_up() 这些入口函数改动，不要在业务代码里直接翻 flag。

class St:
    busy          = False   # 正在录音/请求/播放（MQTT push 会看它跳过重复播放）
    # 直播推流中。也置 busy，但 push 去重要放行：去重是为了挡住 OpenClaw
    # 用 cores3-speak 回复时的重复推送，直播期间收到的推送是真要播的
    # （比如你在网页抓拍后让它说一句），丢掉就变成"日志里回复了但没声音"。
    streaming     = False
    continuous    = False   # 连续对话模式
    wake          = False   # 声控唤醒模式（与 continuous 互斥）
    sleeping      = False   # 息屏休眠中
    last_activity = 0       # 最近一次交互时间戳（休眠计时）


WAKE_THRESHOLD   = 600      # 高于环境底噪，低于正常说话音量
WAKE_CHUNK_SIZE  = int(16000 * 2 * 0.1)  # 每次采样 100ms
WAKE_LOUD_NEED   = 3        # 连续 N 次超阈值触发（N×100ms）

# ── 硬件看门狗 ────────────────────────────────────────────────
# 未捕获异常/死循环时自动复位，always-on 设备不再假死。硬冻结（I2S/WiFi
# 驱动死锁等 Python 异常抓不到的情况）也会因停止喂狗被强制复位，并在
# 开机上报的 reset_cause 里留下"看门狗复位"的死因证据。
# 注意：ESP32 的 WDT 一旦创建无法关闭；设为 False 则完全不启用。
# 接 REPL 调试前必须改 False——主循环停止喂狗会导致每 2 分钟复位一次。
WATCHDOG_ENABLED = True
WATCHDOG_TIMEOUT_MS = 120000   # 必须大于最长合法阻塞（单次 HTTP 30s + 余量）

_wdt = None


def _wdt_init():
    """武装看门狗。在 setup() 末尾调用：配网 UI 等交互流程不受超时限制。"""
    global _wdt
    if WATCHDOG_ENABLED and _wdt is None:
        try:
            from machine import WDT
            _wdt = WDT(timeout=WATCHDOG_TIMEOUT_MS)
            print("watchdog armed:", WATCHDOG_TIMEOUT_MS, "ms")
        except Exception as e:
            print("watchdog unavailable:", e)


def _wdt_feed():
    if _wdt:
        try:
            _wdt.feed()
        except Exception:
            pass

# ── 触摸状态 ──────────────────────────────────────────────────

_touch_start = None
_touch_pos   = (0, 0)
LONG_PRESS_MS = 800         # 长按阈值（ms）

_touch_maxd     = 0         # 本次按下期间离起点的最大位移（曼哈顿距离，px）
_touch_gesture  = None      # 本次按下已判定的触觉手势：'stroke' / 'cradle' / None
_touch_last_ms  = 0         # 最近一次手势按住的时长（ms），供结算用
_touch_seen_ms  = 0         # 最近一次"屏幕上有手"的时刻（ms）。反射层靠它判断
                            # 人还在不在，而不是靠倒计时——见 feel_reflex_tick

# ── 触觉 ─────────────────────────────────────────────────────
#
# 三层结构，别混在一起：
#   反射层：设备端立刻改表情，不过网。触觉的"手感"全靠这层——走一趟
#           OpenClaw 是 3~10 秒，那不叫触觉，叫事后转述。
#   体感层：把触摸聚合成"最近被摸了多久 / 多久没人碰"，随下次 /chat 用
#           X-Touch 头捎给服务端注入 prompt。零额外请求，零额外延迟。
#   惊动层：只有显著事件才打 /touch 让 agent 主动开口，带冷却。
#
# 与现有按钮语义的分工（定死了，改之前想清楚）：点按仍是录音、长按不动仍是
# 切唤醒模式，**只有手指发生位移才判定为抚摸**并吞掉这一次 short/long。
# 好处是肌肉记忆完全不用改；代价是"手贴着不动"这个手势让给了长按。
TOUCH_FEEL_ENABLED   = True   # 回退开关：关掉则触摸行为与加触觉之前完全一致
FEEL_NOTIFY_ENABLED  = True   # 回退开关：只关"主动开口"，保留反射层和体感层
STROKE_MIN_DIST      = 24     # 判定抚摸的最小位移（px，约 4mm；点按抖动通常 <10px）
STROKE_MIN_MS        = 250    # 抚摸至少持续这么久才判定（挡住手滑误触）
FEEL_STROKE_NOTIFY   = 3.0    # 单轮抚摸累计超过这么久才值得让她开口（秒）
# 手离开屏幕后表情还保持多久。**别调太短**：摸是个反复的动作，一次抚摸中间
# 必然有短暂离手，收得太快就会 petted→idle→petted 来回切，每切一次都是一张
# 整屏 JPEG 重解码（约 100ms），看起来就是画面在闪。这个值要盖过离手的间隙。
FEEL_REFLEX_LINGER   = 2.5
_FEEL_LINGER_MS      = int(FEEL_REFLEX_LINGER * 1000)
FEEL_NOTIFY_COOLDOWN = 90     # 主动惊动的冷却（秒）。没有这个会非常聒噪
FEEL_QUIET_SECS      = 1800   # 超过这么久没被碰过，算"被冷落"（秒）
FEEL_WAKE_ON_PICKUP  = True   # 休眠中被拿起来自动醒
# 打开后每次反射层真正重画屏幕都打一行。屏幕闪不闪的问题只能靠这个定位——
# 正常抚摸一整段应该只有两行：进 petted、回 idle。刷屏就是判据还有漏。
FEEL_DEBUG           = False


class Feel:
    """体感累积量。语义同 St：只通过下面几个 feel_* 函数改，别在业务里直接翻。

    stroke_secs 等是"待上报窗口"——feel_header() 取走即清零，窗口边界就是
    上一次对话。所以注入给 LLM 的永远是"上次说完话之后发生的事"。
    """
    last_touch  = 0     # 最近一次被碰的时间戳（0 = 开机以来还没被碰过）
    stroke_secs = 0.0   # 窗口内被抚摸的累计秒数
    strokes     = 0     # 窗口内抚摸次数
    cradles     = 0     # 窗口内被"捧着"（多指同时按）次数
    taps        = 0     # 窗口内机身被轻拍次数（IMU）
    pickups     = 0     # 窗口内被拿起来次数（IMU）
    carry_secs  = 0.0   # 窗口内被抱着走的累计秒数（IMU）
    last_notify = 0     # 上次打 /touch 的时间（冷却用，不进窗口）


_feel_reflex_state = None    # 反射层当前占用的屏幕状态
_feel_reflex_until = 0       # 反射表情的收回时间

# ── 唤醒词检测状态 ─────────────────────────────────────────────

_wake_buf        = bytearray(WAKE_CHUNK_SIZE)
_wake_last_ms    = 0
_wake_loud_count = 0

_mqtt_last_ping  = 0         # 上次 MQTT ping 时间

# ── 自动休眠 ────────────────────────────────────────────────
SLEEP_TIMEOUT  = 300         # 5 分钟无操作后息屏

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

# ── IMU 本体感觉（被拿起/被轻拍/被抱着走）─────────────────────
# 阈值全是拍脑袋的起点值，**必须真机调**：桌面材质、放置姿态、机身重量
# 都会影响。调的时候把 _imu_feel_detect 里的 print 打开看实测幅值。
IMU_TAP_G          = 1.55    # 轻拍机身的加速度尖峰（要低于摇晃阈值）
# 轻拍要等这么久才确认，**必须大于摇晃的 500ms 判定窗**：否则"第三下来得慢"
# 的摇晃会先被确认成轻拍开一次口，紧接着彩蛋又触发一次。代价是轻拍的反射
# 表情慢半拍——没有硬件 tap 中断的话，这个歧义只能用时间换。
IMU_TAP_CONFIRM_MS = 600
IMU_TAP_SPIKE_WIN  = 700     # 尖峰计数的保留窗（要大于 CONFIRM，否则数不满 3 下）
IMU_MOTION_BAND    = 0.12    # |合加速度 - 1g| 超过这么多算"在动"
IMU_PICKUP_STILL   = 20      # 静止这么久之后才动，才算"被拿起来"（秒）
IMU_PICKUP_MOVE_MS = 300     # 持续运动这么久才确认拿起（挡桌面震动/关门震）
IMU_CARRY_GAP      = 3.0     # 运动中断这么久算"放下了"（秒）

_imu_tap_spikes    = []      # 近期尖峰时间戳（区分轻拍 vs 摇晃）
_imu_tap_pending   = None    # 待确认的轻拍时间戳（ms）
_imu_last_motion   = 0       # 最近一次"在动"的时间戳（秒）
_imu_move_since    = None    # 本段连续运动的起点（ms）
_imu_still_before  = 0       # 本段运动开始前静止了多久（秒）
_imu_carried       = False   # 当前是否处于"被端着/拿在手上"
_imu_carry_start   = 0       # 本次被端起来的时间戳（秒）

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
    # 直播：状态文字故意留空（不在屏幕上写"直播中"），画面换成 img_streaming.jpg
    "streaming":      ("(o_o)",   "",                  0xff0055),
    "continuous_on":  ("(^o^)",   "Continuous ON",     0x00ffff),
    "continuous_off": ("(^w^)",   "Continuous OFF",    0x888888),
    "wake_on":        ("(-_-)",   "Wake mode ON",      0x00ff88),
    "wake_off":       ("(^w^)",   "Wake mode OFF",     0x888888),
    "discovering":    ("(o_o)",   "Searching...",      0xffaa00),
    "shake":          ("(*/ω＼*)", "!",                 0xff88cc),
    # 触觉反射层。状态文字保持 ASCII——DejaVu18 里没有 ♡ 这类字符，画出来是方块。
    # 背景图走 _IMG_MAP，目前三态都复用 img_processing。**换图不额外花钱**：
    # draw_state 本来每次换状态就要整屏重解码一张 JPEG，换的是哪张不影响成本；
    # 真正贵的是图不存在时那次白试 + 回退，所以有 _img_missing 兜底。
    "petted":         ("(*^w^*)", "Being petted",      0xff88cc),
    "poked":          ("(o_O)",   "Poked!",            0xffaa88),
    "held":           ("(^o^)/",  "Picked up",         0xffcc44),
    "wifi_setup":     ("(o_o)",   "WiFi Setup",        0x00aaff),
    "wifi_connect":   ("(._.)",   "Connecting...",     0xffaa00),
    "wifi_ok":        ("(^_^)",   "WiFi OK",           0x44ff44),
    "wifi_fail":      ("(x_x)",   "WiFi Failed",       0xff4444),
}


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

# 环形动画默认关闭：待机时一直转的圈观感上像"卡在加载中"。
# 想要音频反馈（录音跟音量跳、播放跟包络跳）把它改回 True——环会画在
# 背景图上，draw_state 整屏重画后由 visual_tick 补回。
VISUAL_ENABLED   = False
# True=每状态各自的背景图（img_recording/img_playing…），与 draw_state
# 的整屏渲染配套；False=所有状态统一用 img_bg。
USE_STATE_IMAGES = True
VIS_FRAME_MS     = 50      # 动画帧间隔（20fps）

RING_N  = 24
RING_CX = 160
RING_CY = 90
RING_R  = 56
RING_W  = 9                # 每段方块边长

_ring_rects = []
for _i in range(RING_N):
    _a = 2 * math.pi * (_i / RING_N) - math.pi / 2
    _ring_rects.append((
        int(RING_CX + RING_R * math.cos(_a)) - RING_W // 2,
        int(RING_CY + RING_R * math.sin(_a)) - RING_W // 2,
        RING_W, RING_W,
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
    if not VISUAL_ENABLED or St.sleeping or _vis_shades is None:
        return
    now = time.ticks_ms()
    if not force and time.ticks_diff(now, _vis_last_ms) < VIS_FRAME_MS:
        return
    _vis_last_ms = now

    if _vis_mode == "comet":
        _vis_phase = (_vis_phase + 0.035) % 1.0
    elif _vis_mode == "level":
        _vis_phase = (_vis_phase + 0.02) % 1.0

    lit = _vis_level * RING_N
    lit_i = int(lit)
    cur = []
    for i in range(RING_N):
        if _vis_mode == "level":
            if i < lit_i:
                k = 7
            elif i == lit_i:
                k = 2 + int(5 * (lit - lit_i))
            else:
                k = 1
        elif _vis_mode == "comet":
            d = ((i / RING_N) - _vis_phase) % 1.0
            k = 7 - int(d * 22)
            if k < 1:
                k = 1
        else:
            k = 4 if (i % 3 == 0) else 1
        cur.append(k)

    prev = _vis_last
    for i in range(RING_N):
        if prev is not None and prev[i] == cur[i]:
            continue          # 差分：亮度没变的段不重绘
        x, y, w, h = _ring_rects[i]
        Lcd.fillRect(x, y, w, h, _vis_shades[cur[i]])
    _vis_last = cur


def _vis_wait(duration, levels):
    """等待 duration 秒，其间按 levels（子片 RMS 序列）推进电平动画。"""
    if not VISUAL_ENABLED or not levels:
        time.sleep(duration)
        return
    step = duration / len(levels)
    for lv in levels:
        _vis_set_level(lv)
        visual_tick()
        time.sleep(step)


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
    n = max(1, (samples * 1000 // SAMPLE_RATE) // bucket_ms)
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

# ── 离屏画布合成 ──────────────────────────────────────────────
#
# 原先 draw_state 是一层层往**屏幕**上画（背景 → 彩条 → 顶栏 → 状态文字），
# 全过程约 58ms 而且用户全程看得见，观感就是"背景先刷上去、文字再一个个冒
# 出来"。开这个开关后改成全部画进离屏画布、最后一次 push 上屏：屏幕在推屏
# 那一刻整屏同时更新，中间过程不可见。
#
# 真机实测（2026-08，CoreS3）：
#   直接上屏 58ms ┊ 画进 PSRAM 画布 54ms ┊ 整屏 push 35ms
# 也就是总耗时 58 → 89ms，**反而慢 50%**，换的是"瞬间完成"而不是"看着它画"。
# 觉得不值就把开关改 False，行为立刻回到逐层直画。
#
# 两个真机结论，改之前必读：
#   ① PSRAM 带宽不是瓶颈（54 vs 58ms）——JPEG 解码是 CPU 密集，写哪块内存无所谓
#   ② **整屏画布必须 psram=True**：内部 SRAM 凑不出 150KB 连续空间，
#      分配会"成功"但没有缓冲区，之后所有绘制静默变成 no-op（实测表现为
#      drawJpg 耗时 0ms、屏幕纹丝不动），排查起来极其费解
USE_CANVAS = True

_canvas = None          # 全屏离屏画布（懒分配，失败则永久退回直接画屏）
_canvas_tried = False


def _get_canvas():
    """取全屏离屏画布；不可用返回 None，调用方直接画屏。"""
    global _canvas, _canvas_tried
    if _canvas is not None or _canvas_tried:
        return _canvas
    _canvas_tried = True                 # 只试一次，失败别每帧白试
    if not USE_CANVAS or not hasattr(Lcd, "newCanvas"):
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
    face, status, color = STATE_UI.get(state, STATE_UI["idle"])

    # ── 先算出这一屏的全部内容，再决定要不要重画 ──────────────
    # _FORCED_IMG 不看 USE_STATE_IMAGES：直播态换图是功能需求（屏幕上不写
    # "直播中"，靠画面本身告知摄像头开着），不是装饰性的每状态配图。
    want_bg = (_FORCED_IMG.get(state)
               or (_IMG_MAP.get(state) if USE_STATE_IMAGES else None)
               or "img_bg")
    # 已知缺图的直接改成 img_bg：要赶在算 key 之前，否则 key 记的是"想画的图"、
    # 屏幕上是"实际画的图"，两者不一致会让缓存判断失去意义。
    if want_bg in _img_missing:
        want_bg = "img_bg"
    cm_color = 0x00ffcc if St.continuous else 0x3a3a3a
    wm_color = 0xffcc00 if St.wake       else 0x3a3a3a
    time_str = get_rtc_time_str()
    try:
        v = M5.Power.getBatteryVoltage()   # mV，3000-4200
        bat = max(0, min(100, (v - 3000) * 100 // 1200))
        bat_str = "{}%".format(bat)
    except Exception:
        bat_str = "--"
    right_str = "{} {}".format(time_str, bat_str) if time_str else bat_str
    show_chat = (state == "idle" and SHOW_CHAT_TEXT and _FONT_CN
                 and _last_reply_text)
    chat_key = (_last_user_text[:18], _last_reply_text[:19]) if show_chat else None

    key = (want_bg, cm_color, wm_color, right_str, color, face, status, chat_key)
    if not force and key == _drawn_key:
        return
    _drawn_key = key

    r = (color >> 16) & 0xff
    g = (color >> 8)  & 0xff
    b = color & 0xff
    _set_led(r // 4, g // 4, b // 4)

    # 画到离屏画布还是直接画屏。tgt 拿到什么，下面所有绘制就都往那儿去——
    # 画布暴露的方法名跟 Lcd 一致（drawJpg/drawString/setFont/fillRect…），
    # 所以这里只换目标，不分叉两套绘制代码。
    tgt = _get_canvas() or Lcd

    # ── 1：背景层（整屏 320×240 从 0,0 开始）────────────────
    img_shown = False
    try:
        with open("/flash/{}.jpg".format(want_bg), "rb") as _f:
            tgt.drawJpg(_f.read(), 0, 0)
        img_shown = True
    except Exception as e:
        print("img err:", e)
        if want_bg != "img_bg":
            _img_missing.add(want_bg)   # 记下来，下次别再白试
    if not img_shown and want_bg != "img_bg":
        try:
            with open("/flash/img_bg.jpg", "rb") as _f:
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
    if CAMERA_MODE_ENABLED:
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


# ── WAV 工具 ──────────────────────────────────────────────────

# ── 离屏画布探测（一次性诊断，测完把 CANVAS_PROBE 改回 False）────
#
# 要判断的是：能不能把"整屏重绘"改成"离屏合成 + 一次推屏"。
# 现在 draw_state 是一层层往屏幕上画（背景 → 彩条 → 顶栏 → 状态文字），
# 全过程约 100ms 且**用户看得见**，所以换图像是"背景先上、文字再冒出来"。
# 画布方案是全画进离屏缓冲再一次推屏，总耗时不变，但屏幕上是瞬间完成的。
#
# 更重要的是它能解开当初被否掉的分层重绘：CLAUDE.md 记着"分层增量重绘要垫
# 实心底才能擦字，结果照片被黑边夹住"。有画布就不用垫底——擦除变成"从背景
# 重新合成"，时钟/电量就能局部更新，不必整屏重解 JPEG。
#
# 四个数字决定方案生死：
#   ① 画布暴露了哪些方法——没有 drawString/setFont 就画不了文字，方案作废
#   ② 画进 PSRAM 画布 vs 直接画屏谁快——PSRAM 走 QSPI，逐像素写可能更慢
#   ③ 整屏 push 多少毫秒——一帧到位的固定开销
#   ④ 顶栏小画布 文字+push 多少毫秒——这是"时钟每秒刷新"的实际成本
# 结果同时进串口和 dbg 环形缓冲，随心跳上报（voice_server.log 里的 📟 行）。
#
# 2026-08 已测完，结论写在 USE_CANVAS 那段注释里。代码保留：以后换固件版本
# 或改画布尺寸想重测，改回 True 烧一次就行。
CANVAS_PROBE = False


def canvas_probe():
    """开机跑一次画布能力探测。异常一律吞掉，绝不能拖累正常启动。"""
    if not CANVAS_PROBE:
        return
    try:
        _canvas_probe()
    except Exception as e:
        dbg("cv: probe crashed {}".format(e))
    finally:
        # 探测直接铺过屏，必须作废缓存键，否则下次 draw_state 判定"没变"跳过重绘
        _ui_invalidate()


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


def _canvas_probe():
    has = hasattr(Lcd, "newCanvas")
    dbg("cv: newCanvas={}".format(has))
    if not has:
        return
    try:
        img = open("/flash/img_bg.jpg", "rb").read()
    except Exception as e:
        dbg("cv: no img_bg {}".format(e))
        return

    # 基准线：现在 draw_state 的做法，直接解码上屏
    t = time.ticks_ms()
    Lcd.drawJpg(img, 0, 0)
    dbg("cv: direct jpg {}ms".format(time.ticks_diff(time.ticks_ms(), t)))

    for psram in (True, False):
        gc.collect()
        free0 = gc.mem_free()
        try:
            cv, form = _mk_canvas(320, 240, psram)
        except Exception as e:
            dbg("cv: alloc psram={} FAIL {}".format(psram, e))
            continue
        gc.collect()
        # 堆掉得少 = 画布真的落在 PSRAM 而不是内部 RAM（整屏 16bpp 应为 153600 字节）
        dbg("cv: alloc psram={} form{} heapdrop={}".format(
            psram, form, free0 - gc.mem_free()))

        if psram:
            names = dir(cv)
            want = ("drawJpg", "drawPng", "drawImage", "drawString", "setFont",
                    "setTextColor", "setTextSize", "fillRect", "fillScreen",
                    "push", "drawRawBuf", "deleteSprite", "delete")
            dbg("cv: has " + ",".join([n for n in want if n in names]))
            miss = [n for n in want if n not in names]
            if miss:
                dbg("cv: MISS " + ",".join(miss))

        draw = getattr(cv, "drawJpg", None) or getattr(cv, "drawImage", None)
        if draw:
            t = time.ticks_ms()
            draw(img, 0, 0)
            dbg("cv: psram={} jpg {}ms".format(
                psram, time.ticks_diff(time.ticks_ms(), t)))
        try:
            t = time.ticks_ms()
            cv.push(0, 0)
            dbg("cv: psram={} push {}ms".format(
                psram, time.ticks_diff(time.ticks_ms(), t)))
        except Exception as e:
            dbg("cv: push FAIL {}".format(e))
        del cv
        gc.collect()

    # 顶栏尺寸的小画布：分层局部更新的真实成本。这个数字最关键——
    # 够小的话时钟就能每秒走，状态切换也不用再整屏重解 JPEG。
    try:
        bar, _form = _mk_canvas(320, 26, False)
        if hasattr(bar, "drawString"):
            for setter, arg in (("setFont", _FONT_16), ("setTextColor", 0xffffff)):
                fn = getattr(bar, setter, None)
                if fn:
                    try:
                        fn(arg)
                    except Exception as e:
                        dbg("cv: bar {} {}".format(setter, e))
            t = time.ticks_ms()
            bar.drawString("12:34 100%", 0, 4)
            bar.push(0, 3)
            dbg("cv: bar text+push {}ms".format(
                time.ticks_diff(time.ticks_ms(), t)))
        else:
            dbg("cv: bar no drawString")
        del bar
        gc.collect()
    except Exception as e:
        dbg("cv: bar FAIL {}".format(e))


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
    # array('h') 直接迭代比逐样本 struct.unpack_from 快约一个数量级；
    # calibrate_noise() 与此同函数，阈值尺度自洽，无需重新校准。
    a = uarray.array('h', buf)
    n = len(a)
    if n == 0:
        return 0
    total = 0
    for v in a:
        total += v * v
    return int(math.sqrt(total / n))


def rms_slices(buf, n=5):
    """单次遍历返回 (n 个子片 RMS, 整体 RMS)。

    子片供电平动画用（0.25s 的块拆成 5 帧 → 20fps 音频响应），
    整体值供 VAD 判定用。总运算量与调一次 rms() 相同，等于白送。
    """
    a = uarray.array('h', buf)
    total_n = len(a)
    if total_n == 0:
        return [0] * n, 0
    seg = total_n // n
    out = []
    grand = 0
    for s in range(n):
        start = s * seg
        end = total_n if s == n - 1 else start + seg
        acc = 0
        for i in range(start, end):
            v = a[i]
            acc += v * v
        cnt = end - start
        out.append(int(math.sqrt(acc / cnt)) if cnt else 0)
        grand += acc
    return out, int(math.sqrt(grand / total_n))


# ── 触摸检测 ──────────────────────────────────────────────────

_FEEL_ONGOING = {'stroke': 'stroking', 'cradle': 'cradling'}


def check_touch(feel=False):
    """
    返回 (事件类型, 坐标)。
    事件类型: 'short' / 'long' / None；feel=True 时还可能是：
      'stroking' / 'cradling' —— 手势进行中，按住期间每轮都返回（喂反射层）
      'stroke'   / 'cradle'   —— 手势结束。此时**不再产生 short/long**
    坐标: (x, y) 为按下时的位置

    feel 默认 False = 与加触觉之前逐字节等价的行为。取景模式、配网界面、
    播放中断这些地方要的就是纯按钮，别让一次手滑变成抚摸把点击吞掉；
    只有主循环 loop() 传 True。

    位移用"离起点的最大曼哈顿距离"而不是累计路径长度：累计路径会把长按
    期间的手指抖动一点点攒过阈值，把静止长按误判成抚摸；最大位移不会，
    而来回摩挲在两端自然会超阈值，照样判得出来。
    """
    global _touch_start, _touch_pos, _touch_maxd, _touch_gesture, _touch_last_ms
    global _touch_seen_ms
    M5.update()
    count = M5.Touch.getCount()
    if count > 0:
        _touch_seen_ms = time.ticks_ms()
        x, y = M5.Touch.getX(), M5.Touch.getY()
        if _touch_start is None:
            _touch_start   = time.ticks_ms()
            _touch_pos     = (x, y)
            _touch_maxd    = 0
            _touch_gesture = None
        if feel and TOUCH_FEEL_ENABLED:
            d = abs(x - _touch_pos[0]) + abs(y - _touch_pos[1])
            if d > _touch_maxd:
                _touch_maxd = d
            held = time.ticks_diff(time.ticks_ms(), _touch_start)
            if count > 1:
                # 多指同时按住 =「被捧着」。UIFlow2 是否真的透传多点待真机确认，
                # 不透传的话这条分支永远不进，其余功能不受影响。
                _touch_gesture = 'cradle'
            elif _touch_maxd >= STROKE_MIN_DIST and held >= STROKE_MIN_MS:
                _touch_gesture = 'stroke'
            if _touch_gesture is not None:
                return (_FEEL_ONGOING[_touch_gesture], _touch_pos)
        return (None, (0, 0))
    else:
        if _touch_start is not None:
            duration = time.ticks_diff(time.ticks_ms(), _touch_start)
            pos      = _touch_pos
            gesture  = _touch_gesture
            _touch_start   = None
            _touch_gesture = None
            _touch_last_ms = duration
            if gesture is not None:
                return (gesture, pos)      # 判成触觉就吞掉 short/long，不录音
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


def touch_reset():
    """丢弃当前这一次按下：抬手后不再产生任何事件。

    抚摸是**按住期间**就判定的（不像 short/long 要等抬手），所以拿它当触发器
    的地方必须显式作废这次按下，否则抬手时还会再吐一个手势事件出来。
    """
    global _touch_start, _touch_gesture, _touch_maxd
    _touch_start   = None
    _touch_gesture = None
    _touch_maxd    = 0


# ── 触觉：反射层 ──────────────────────────────────────────────

def feel_reflex(state, secs=FEEL_REFLEX_LINGER):
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
    if St.busy or St.sleeping:
        return
    _feel_reflex_until = time.time() + secs   # 续期总是要做的
    if _feel_reflex_state == state:
        return                                # 已经在这个表情上：一个像素都别动
    if FEEL_DEBUG:
        print("[feel] redraw ->", state, "(from", _feel_reflex_state, ")")
    _feel_reflex_state = state
    draw_state(state)


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
    if St.busy or St.sleeping:
        _feel_reflex_state = None      # 屏幕已被别人接管，反射作废
        return
    if time.ticks_diff(time.ticks_ms(), _touch_seen_ms) < _FEEL_LINGER_MS:
        return                         # 人还在摸（或刚离手），一个像素都别动
    if time.time() >= _feel_reflex_until:
        if FEEL_DEBUG:
            print("[feel] redraw -> idle (from", _feel_reflex_state, ")")
        _feel_reflex_state = None
        draw_state("idle")


# ── 触觉：体感层 ──────────────────────────────────────────────

def feel_touched():
    """记一次"被碰到"，返回**被碰之前**已经安静了多久（秒）。

    返回值是"冷落时长"，惊动层用它判断这次触碰是不是久别重逢——
    连着摸十次不该让她十次都很惊喜，隔了两小时的第一次才该。
    """
    now = time.time()
    quiet = (now - Feel.last_touch) if Feel.last_touch else 0
    Feel.last_touch = now
    St.last_activity = now             # 被摸也算交互，顺延休眠计时
    return quiet


def feel_header():
    """打包体感窗口成 X-Touch 头（k=v,k=v）。**取走即清空**，没内容返回 ""。

    清空放在这里而不是等请求成功：请求失败就丢掉这一窗口的体感，是有意的——
    宁可漏报也不要把过期的"刚被摸了"在几分钟后才注入进对话。
    """
    parts = []
    if Feel.stroke_secs >= 1:
        parts.append("stroke=%d" % int(Feel.stroke_secs))
    if Feel.strokes:
        parts.append("strokes=%d" % Feel.strokes)
    if Feel.cradles:
        parts.append("cradles=%d" % Feel.cradles)
    if Feel.taps:
        parts.append("taps=%d" % Feel.taps)
    if Feel.pickups:
        parts.append("pickups=%d" % Feel.pickups)
    if Feel.carry_secs >= 1:
        parts.append("carry=%d" % int(Feel.carry_secs))
    if Feel.last_touch:
        quiet = int(time.time() - Feel.last_touch)
        if quiet >= FEEL_QUIET_SECS:
            parts.append("quiet=%d" % quiet)
    Feel.stroke_secs = 0.0
    Feel.strokes     = 0
    Feel.cradles     = 0
    Feel.taps        = 0
    Feel.pickups     = 0
    Feel.carry_secs  = 0.0
    return ",".join(parts)


def _feel_headers(base):
    """给已有请求头补上 X-Touch。没有体感可报就原样返回。"""
    if not TOUCH_FEEL_ENABLED:
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
    if not (TOUCH_FEEL_ENABLED and FEEL_NOTIFY_ENABLED):
        return False
    now = time.time()
    if St.busy or St.sleeping or St.streaming:
        return False
    if now - Feel.last_notify < FEEL_NOTIFY_COOLDOWN:
        return False
    Feel.last_notify = now
    feel_reflex_clear()
    St.busy = True
    try:
        draw_state("processing")
        hdrs = {"X-Device-Id": DEVICE_ID, "X-Touch-Kind": kind}
        if detail:
            hdrs["X-Touch-Detail"] = detail
        lt = get_local_time_header()
        if lt:
            hdrs["X-Local-Time"] = lt
        # 这里**故意不带 X-Touch**：feel_header() 取走即清空，而 /touch 只用
        # X-Touch-Detail 造 prompt，带上等于把体感窗口白白清掉，
        # 下次真正对话时就没得注入了。窗口只交给 /chat。
        resp = urequests.get(SERVER_BASE + "/touch", headers=hdrs,
                             timeout=REQUEST_TIMEOUT_SHORT)
        resp.close()
        print("[feel] notify:", kind, detail)
    except OSError as e:
        print("[feel] notify err:", e)
    finally:
        St.busy = False
        draw_state("idle")
    return True


def feel_on_touch_end(kind):
    """屏幕上的抚摸/捧着结束：结算体感，够显著就惊动 agent。"""
    secs  = _touch_last_ms / 1000.0
    quiet = feel_touched()
    if kind == 'cradle':
        Feel.cradles += 1
    else:
        Feel.strokes    += 1
        Feel.stroke_secs += secs
    # 先问要不要惊动：feel_notify 会自己接管屏幕（processing → idle），
    # 反射表情画在它前面就是一次白扔的整屏 JPEG 解码（约 100ms）。
    # 冷却没过 / 关了开关时 feel_notify 返回 False，这时才补上留一会儿的表情。
    if ((secs >= FEEL_STROKE_NOTIFY or quiet >= FEEL_QUIET_SECS)
            and feel_notify(kind, "secs=%d,quiet=%d" % (int(secs), int(quiet)))):
        return
    feel_reflex("petted")              # 抬手之后表情再留一会儿


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
    _ui_invalidate()   # 配网界面整屏接管
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
    _ui_invalidate()   # 配网界面整屏接管
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
            # 无人值守设备：存档凭据连不上时循环重试（≈15 分钟）后整机复位
            # 刷新 WiFi 栈，绝不停在配置 UI 等人——那会失联到有人来按键为止。
            # 凭据真的变了时：开机 2 秒内按住屏幕仍可强制进入配置界面。
            for attempt in range(20):
                if _wifi_connect(ssid, pwd):
                    print("wifi restored from file:", ssid)
                    return True
                print("wifi retry {}/20".format(attempt + 1))
                time.sleep(30)
            import machine
            machine.reset()

    return wifi_setup_flow()


# ── 模式切换 ──────────────────────────────────────────────────

def toggle_continuous():
    """摇晃切换连续对话模式。开启时自动关闭声控唤醒（两者互斥）。"""
    St.continuous = not St.continuous
    if St.continuous:
        St.wake = False
    draw_state("continuous_on" if St.continuous else "continuous_off")
    time.sleep(0.8)
    draw_state("idle")


def toggle_wake_mode():
    """长按切换声控唤醒模式。开启时自动关闭连续对话（两者互斥）。"""
    St.wake = not St.wake
    if St.wake:
        St.continuous = False
    else:
        _mic_off()   # 退出唤醒模式时释放常开的麦克风
    draw_state("wake_on" if St.wake else "wake_off")
    time.sleep(0.8)   # Bug 3 Fix: 1.5→0.8s，缩短切换反馈时间
    draw_state("idle")


# ── 音频录制 ──────────────────────────────────────────────────

def _record_audio():
    """
    启动麦克风，用 VAD 检测说话，返回 PCM 数据块列表。
    无说话返回空列表 []。
    若用户在录音期间长按屏幕，立即停止录音并返回 None（哨兵，表示用户主动中断）。
    """
    _mic_on()
    chunks, silent, started = [], 0, False
    sub_levels = [0] * 5        # 上一块的子片电平，驱动等待期间的环形动画
    for _ in range(MAX_CHUNKS):
        _wdt_feed()   # 满长录音 10s，喂狗防误咬
        buf = bytearray(CHUNK_SIZE)
        Mic.record(buf, SAMPLE_RATE)
        # Mic.record 是异步的：等待缓冲填满的这段时间正好拿来跑动画
        _vis_wait(CHUNK_SEC + 0.05, sub_levels)
        # 长按优先检测：优先级高于录音，continuous/wake 模式均可退出
        t, _ = check_touch()
        if t == 'long':
            _mic_off()
            return None          # 哨兵：用户请求退出当前模式
        sub_levels, level = rms_slices(buf)
        if level > SILENCE_THRESHOLD:
            started = True
            silent  = 0
            chunks.append(bytes(buf))
        elif started:
            chunks.append(bytes(buf))
            silent += 1
            if silent >= SILENCE_CHUNKS:
                break
    _mic_off()
    return chunks


# ── 播放 ──────────────────────────────────────────────────────

def play_wav(data):
    """将 WAV 数据写入 flash 并播放。触摸屏幕可随时中断播放。"""
    _mic_off()   # Mic/Speaker 共享音频通路：播放前确保麦克风已释放
    # 先算包络：播放时按 elapsed 索引，环随语音起伏（不占播放时间）
    env = _wav_envelope(data) if VISUAL_ENABLED else []
    with open("/flash/response.wav", "wb") as f:
        f.write(data)
    Speaker.begin()
    Speaker.setVolumePercentage(_volume)
    Speaker.playWavFile("/flash/response.wav")
    t0 = time.ticks_ms()
    while Speaker.isPlaying():
        _wdt_feed()   # 长音频播放可超过 WDT 窗口
        M5.update()
        if M5.Touch.getCount() > 0:   # Fix 6: 触摸中断
            Speaker.stop()
            time.sleep(0.2)           # 让扬声器余音散去
            drain_touch()
            break
        if env:
            idx = time.ticks_diff(time.ticks_ms(), t0) // 100
            _vis_set_level_norm(env[idx] if idx < len(env) else 0.0)
            visual_tick()
        _wdt_feed()
        mqtt_check()   # 长播放期间维持心跳（回调只入队，不会嵌套播放）
        time.sleep(0.05)
    _vis_set_level_norm(0.0)
    visual_tick(force=True)
    time.sleep(0.15)   # 让音频信号归零，避免 Speaker.end() 产生 pop 声
    Speaker.end()


# ── 主对话（普通） ────────────────────────────────────────────

def record_and_send():
    """
    录音 → 发送服务端 → 播放回复。
    若 St.continuous 开启则自动进入下一轮；
    播放结束后有 1.5s 窗口，长按可退出连续模式。
    """
    St.busy = True
    St.last_activity = time.time()
    gc.collect()

    while True:
        _wdt_feed()
        draw_state("recording")
        chunks = _record_audio()

        if chunks is None:         # 用户长按中断录音 → 退出当前模式
            if St.continuous:
                toggle_continuous()
            elif St.wake:
                toggle_wake_mode()
            St.busy = False
            return

        if not chunks:
            draw_state("no_speech")
            time.sleep(1)
            if not St.continuous:
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
            _feel_headers(hdrs)      # 体感层：把"刚才被摸过"随对话一起捎过去
            resp = urequests.post(SERVER_URL, data=wav, headers=hdrs, timeout=REQUEST_TIMEOUT_CHAT)
            if resp.status_code != 200:
                print("chat err:", resp.text)
                resp.close()
                draw_state("error")
                time.sleep(2)
                if not St.continuous:
                    break
                continue
            need_photo = resp.headers.get("X-Need-Photo", "") == "1"
            vol_cmd = resp.headers.get("X-Volume", "")
            _update_chat_text(resp.headers.get("X-User-Text", ""),
                              resp.headers.get("X-Reply-Text", ""))
            data = resp.content
            resp.close()
            if vol_cmd in ("up", "down"):
                _volume_adjust(vol_cmd)
        except OSError as e:
            print("network err:", e)
            draw_state("error")
            time.sleep(2)
            if not St.continuous:
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
                _feel_headers(v_hdrs)
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

        if not St.continuous:
            mqtt_check()   # 趁 St.busy=True 消费掉 OpenClaw 触发的重复 push
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
                St.busy = False
                return
            time.sleep(0.05)
        drain_touch()
        # 继续下一轮

    draw_state("idle")
    time.sleep(1)
    drain_touch()
    St.busy = False


# ── 摄像头 ────────────────────────────────────────────────────
#
# 帧格式是 raw RGB565（服务端 _decode_image_b64 按字节数反查分辨率再转 JPEG）。
# 固件差异用运行时探测抹平：抓帧优先 camera.capture()（返回 bytes，本机验证过），
# 回退 camera.snapshot()（新固件，返回 image.Image）；预览同理，见 _cam_show()。

# 回退开关：True=按 QVGA(320×240) 初始化，取景铺满屏且识别更清楚；
# 真机若初始化失败/画面异常，改 False 即回到固件默认分辨率（旧行为）。
CAMERA_QVGA = True

# drawRawBuf 的字节序开关。摄像头 RGB565 是高字节在前，M5GFX 的 raw buffer
# 默认也按这个顺序读，所以不需要交换——swap 是留给小端来源（PC 生成的数组）的。
# 真机验证过：True 会花屏（轮廓在、彩虹色、逐帧闪），False 才正常。
PREVIEW_SWAP = False

# drawRawBuf 的 len 参数按"像素个数"还是"字节数"算。底层是 LovyanGFX 的
# pushPixels(data, len, swap)，len 按像素计——传字节数（=2 倍）会让显示窗口
# 铺完一屏后绕回原点，再用越界读到的数据（多半是摄像头的另一块 framebuffer）
# 盖一遍，症状就是错块 + 竖条纹 + 逐帧乱跳。
# 真机若改成 True 后只画了上半屏，说明这版固件按字节算，改回 False。
PREVIEW_LEN_IN_PIXELS = True

# 字节数 → 分辨率。与服务端 voice_server.py 的 RGB565_SIZES 保持一致
# （这里只列摄像头模块支持的档位）。
_CAM_SIZES = {
    160 * 120 * 2: (160, 120),
    176 * 144 * 2: (176, 144),
    240 * 176 * 2: (240, 176),
    240 * 240 * 2: (240, 240),
    320 * 240 * 2: (320, 240),
}

_camera_inited = False
_cam_grab_fn   = None   # 探测到的抓帧函数
_cam_draw_mode = None   # 'raw'=drawRawBuf / 'show'=Lcd.show / 'none'=不支持预览


def _camera_ensure():
    """幂等初始化摄像头。首次成功后常驻（不 deinit）。返回是否可用。"""
    global _camera_inited
    if _camera_inited:
        return True
    import camera
    print("camera: initializing...")
    try:
        if CAMERA_QVGA and hasattr(camera, "QVGA") and hasattr(camera, "RGB565"):
            camera.init(pixformat=camera.RGB565, framesize=camera.QVGA)
            print("camera: init OK (QVGA)")
        else:
            camera.init()   # 老固件的无参形态，分辨率由固件决定
            print("camera: init OK (firmware default)")
        _camera_inited = True
        return True
    except Exception as e:
        print("camera init error:", e)
        return False


def _cam_grab():
    """抓一帧，返回帧对象（bytes 或 image.Image），失败返回 None。"""
    global _cam_grab_fn
    import camera
    if _cam_grab_fn is None:
        _cam_grab_fn = getattr(camera, "capture", None) or getattr(camera, "snapshot", None)
        if _cam_grab_fn is None:
            print("camera: no capture()/snapshot() in this firmware")
            return None
    try:
        frame = _cam_grab_fn()
    except Exception as e:
        print("camera capture error:", e)
        return None
    if frame is None or isinstance(frame, bool):
        print("camera: capture returned", frame)
        return None
    return frame


def _cam_bytes(frame):
    """取帧的原始字节。capture() 已经是 bytes；snapshot() 给 image.Image。"""
    if isinstance(frame, (bytes, bytearray, memoryview)):
        return frame
    try:
        return frame.bytearray()
    except Exception as e:
        print("camera: frame bytes err:", e)
        return None


def _cam_show(frame, max_h=240):
    """把一帧居中画到屏幕。首帧探测绘制方式，之后固定。返回是否画上了。

    max_h 限制绘制高度：取景时只画到按钮条上沿，按钮条就不会被每帧盖住、
    也就不用每帧补画（否则底栏肉眼可见地闪）。帧是行优先连续存储，前
    w*max_h 个像素正好是最上面 max_h 行，所以窗口和 len 一起缩小即可。
    """
    global _cam_draw_mode
    if _cam_draw_mode == "none":
        return False
    raw = _cam_bytes(frame)
    if raw is None:
        return False
    w, h = _CAM_SIZES.get(len(raw), (0, 0))
    if not w:
        print("camera: unknown frame size", len(raw), "— 预览关闭")
        _cam_draw_mode = "none"
        return False
    h = min(h, max_h)
    x = (320 - w) // 2
    y = (max_h - h) // 2
    # len 跟着窗口一起缩——之前裁剪失败就是因为这里还按整帧算，等于又传了 2 倍
    n = w * h if PREVIEW_LEN_IN_PIXELS else w * h * 2
    if _cam_draw_mode in (None, "raw"):
        try:
            Lcd.drawRawBuf(raw, x, y, w, h, n, PREVIEW_SWAP)
            _cam_draw_mode = "raw"
            return True
        except Exception as e:
            if _cam_draw_mode == "raw":
                return False        # 已选定方式，单帧失败不重新探测
            print("camera: drawRawBuf unavailable:", e)
    try:
        Lcd.show(frame, x, y, w, h)   # 新固件路径（配 snapshot() 的 image.Image）
        _cam_draw_mode = "show"
        return True
    except Exception as e:
        if _cam_draw_mode == "show":
            return False              # 已选定方式，单帧失败不重新探测
        print("camera: Lcd.show unavailable:", e, "— 预览关闭")
        _cam_draw_mode = "none"
        return False


def capture_photo():
    """
    拍一张 raw RGB565 帧，返回 base64 字符串（无换行），失败返回 None。
    语音触发拍照与 MQTT 远程拍照共用。
    """
    if not _camera_ensure():
        return None
    time.sleep(0.3)   # 等待曝光稳定（替代 skip_frames）
    print("camera: capturing...")
    frame = _cam_grab()
    if frame is None:
        return None
    raw = _cam_bytes(frame)
    if raw is None:
        return None
    print("camera: raw size =", len(raw))
    b64 = ubinascii.b2a_base64(raw).decode("utf-8").replace("\n", "").replace("\r", "")
    gc.collect()
    return b64


# ── 直播推流 ──────────────────────────────────────────────────
#
# 网页要看实时画面。走 /upload-photo 那条路每帧都要新建 HTTP 连接 + base64
# （体积 +33%），实测一张 5~8 秒，根本不成流。这里改成一条常驻 TCP 连到
# 服务端 5002，每帧只发 4 字节大端长度 + RGB565 裸字节。
#
# 还要把分辨率降到 QQVGA(160×120)：单帧 38KB，是 QVGA 的四分之一。
# 两项加起来才够 2~4 fps——这仍是"连拍流"，不是设备本地预览那种流畅画面。
#
# 切分辨率需要 deinit + 重新 init，固件不一定有 deinit；没有就按当前分辨率
# 照传，只是慢一些，不至于整个功能不可用。

STREAM_ENABLED  = True   # 回退开关：False 则忽略所有直播命令
STREAM_MAX_SECS = 300    # 单次直播硬上限，服务端失联也不会让摄像头一直开着
STREAM_QQVGA    = True   # 直播降到 160×120；False=保持当前分辨率（更清晰更慢）
STREAM_SETTLE_FRAMES = 5 # 切完分辨率先丢几帧等曝光收敛，开头才不会忽明忽暗

_stream_deadline = 0     # 直播截止时间戳，收到 stream_start 就往后推


def _cam_set_framesize(qqvga):
    """切换摄像头分辨率，成功返回 True。固件没有 deinit 就返回 False（照常推流）。"""
    global _camera_inited, _cam_grab_fn
    import camera
    if not hasattr(camera, "deinit") or not hasattr(camera, "RGB565"):
        return False
    want = getattr(camera, "QQVGA", None) if qqvga else getattr(camera, "QVGA", None)
    if want is None:
        return False
    try:
        camera.deinit()
        _camera_inited = False
        camera.init(pixformat=camera.RGB565, framesize=want)
        _camera_inited = True
        _cam_grab_fn = None          # 重新探测抓帧函数，保守起见
        print("camera: framesize ->", "QQVGA" if qqvga else "QVGA")
        return True
    except Exception as e:
        print("camera: framesize switch failed:", e)
        try:                          # 尽力恢复到能用的状态，别把拍照也弄坏
            camera.init(pixformat=camera.RGB565, framesize=camera.QVGA)
            _camera_inited = True
            _cam_grab_fn = None
        except Exception as e2:
            print("camera: restore failed:", e2)
            _camera_inited = False
        return False


def _sock_write_all(sock, data):
    """把 data 全部写出去。write() 返回 None 的固件视为一次写完。"""
    mv = memoryview(data)
    total = 0
    while total < len(mv):
        try:
            n = sock.write(mv[total:])
        except OSError as e:
            print("stream write err:", e)
            return False
        if n is None:
            return True
        if n <= 0:
            return False
        total += n
    return True


def _stream_drain_cmds():
    """直播期间自己消费命令队列，返回 (是否停止, 待插拍的 capture 命令)。

    capture 必须就地处理，不能留回队列——留回去要等直播结束才执行，
    用户按下快门后就成了"没反应"。一轮只取一条，多的留到下一轮。
    其余命令原样留回队列，等直播结束后由主循环处理。
    """
    global _stream_deadline
    stop = False
    capture = None
    keep = []
    while _pending_cmd:
        c = _pending_cmd.pop(0)
        action = c.get("action")
        if action == "stream_start":
            _stream_deadline = time.time() + c.get("secs", 45)
        elif action == "stream_stop":
            stop = True
        elif action == "capture" and capture is None:
            capture = c
        else:
            keep.append(c)
    for c in keep:
        _pending_cmd.append(c)
    return stop, capture


def _stream_hires_capture(cmd, switched):
    """直播中插拍一张高清照：临时切回 QVGA 拍一张上传，再切回直播分辨率。

    直播画面会停几秒（切分辨率 ×2 + 曝光收敛 + 205KB 上传）。用停顿换清晰度：
    直播帧只有 160×120，给 AI 识别太糊。switched=False 说明本来就是全分辨率，
    不用来回切，直接拍。
    """
    rid = cmd.get("request_id", "")
    print("stream: hi-res capture", rid)
    dbg("stream hires")
    draw_state("camera")
    try:
        if switched:
            _cam_set_framesize(False)          # 切回 QVGA
            for _ in range(STREAM_SETTLE_FRAMES):
                _cam_grab()
                _wdt_feed()
        image_b64 = capture_photo()
        _wdt_feed()
        draw_state("processing")
        _upload_photo(rid, image_b64)
        _wdt_feed()
    except Exception as e:
        print("stream hires capture err:", e)
    finally:
        if switched:
            _cam_set_framesize(True)           # 回到直播分辨率
            for _ in range(STREAM_SETTLE_FRAMES):
                _cam_grab()
                _wdt_feed()
        gc.collect()
        draw_state("streaming")


def _run_stream_cmd(cmd):
    """执行直播命令（主循环调用），一直推到超时/收到停止/出错为止。"""
    global _stream_deadline
    if not STREAM_ENABLED:
        print("stream: disabled by switch")
        return
    if not _camera_ensure():
        print("stream: camera unavailable")
        return

    if St.sleeping:
        wake_up()
    St.busy = True
    St.streaming = True
    St.last_activity = time.time()

    now = time.time()
    _stream_deadline = now + cmd.get("secs", 45)
    hard_stop = now + STREAM_MAX_SECS
    port = cmd.get("port", STREAM_PORT)

    switched = _cam_set_framesize(True) if STREAM_QQVGA else False
    if switched:
        # 换完分辨率后自动曝光/白平衡要重新收敛，先丢几帧再开播，
        # 否则开头几秒画面忽明忽暗。capture_photo() 里的 sleep(0.3) 同理。
        for _ in range(STREAM_SETTLE_FRAMES):
            _cam_grab()
            _wdt_feed()
    sock = None
    frames = 0
    try:
        draw_state("streaming")
        sock = usocket.socket(usocket.AF_INET, usocket.SOCK_STREAM)
        sock.settimeout(10)
        try:
            # 发现流程里 MQTT_BROKER 就是服务端 IP
            sock.connect((MQTT_BROKER, port))
        except OSError as e:
            # 单独捕获连接失败：这一步超时几乎都是"端口没通"，而不是流本身的问题。
            # 服务端在 WSL 里时，Windows 侧要给这个端口加 portproxy + 防火墙，
            # 见 openclaw-startup.ps1 的 $StreamPort。
            print("stream: cannot connect to {}:{} ({}) —"
                  " server not listening, or port not forwarded".format(
                      MQTT_BROKER, port, e))
            dbg("stream connect fail :{}".format(port))
            return
        hello = "KAGURA_STREAM v1 {} {}\n".format(DEVICE_ID, STREAM_TOKEN)
        if not _sock_write_all(sock, hello.encode("utf-8")):
            print("stream: handshake failed")
            return
        dbg("stream start")
        print("stream: connected", MQTT_BROKER, port)

        while True:
            _wdt_feed()
            now = time.time()
            if now >= _stream_deadline or now >= hard_stop:
                print("stream: deadline reached")
                break

            frame = _cam_grab()
            if frame is None:
                time.sleep(0.2)              # 抓帧失败别空转
            else:
                raw = _cam_bytes(frame)
                if raw is not None:
                    # 立刻复制一份再发：一帧 38KB 走 TCP 要上百毫秒，这期间驱动
                    # 很可能已经在往同一块 framebuffer 里写下一帧了，直接发原缓冲
                    # 会发出半新半旧的撕裂画面（看起来就是频闪）。取景模式定格那里
                    # 也是出于同样原因复制的。
                    raw = bytes(raw)
                    n = len(raw)
                    head = bytes([(n >> 24) & 0xFF, (n >> 16) & 0xFF,
                                  (n >> 8) & 0xFF, n & 0xFF])
                    if not _sock_write_all(sock, head) or not _sock_write_all(sock, raw):
                        print("stream: send failed, stopping")
                        break
                    frames += 1
                    if frames % CAM_GC_EVERY == 0:
                        gc.collect()

            # 直播可能持续几分钟，不喂 MQTT 会被 keepalive(60s) 判掉线
            mqtt_check()
            stop, cap = _stream_drain_cmds()
            if stop:
                print("stream: stopped by server")
                break
            if cap is not None:
                # 插拍高清照，画面停几秒。把耗时补回截止时间，
                # 免得拍完正好撞上超时、直播刚续上就断
                t0 = time.time()
                _stream_hires_capture(cap, switched)
                _stream_deadline += time.time() - t0

            # 直播期间收到的播报（如网页抓拍后让它说一句）就地播出来。
            # 画面会停几秒再续上——比"日志里回复了但没声音"好得多。
            if _pending_push:
                _play_push(_pending_push.pop(0))
                draw_state("streaming")   # _play_push 收尾会切 idle，切回来
                _wdt_feed()

            touch, _pos = check_touch()
            if touch == 'long':
                print("stream: stopped by touch")
                break
    except OSError as e:
        print("stream error:", e)
        dbg("stream err")
    finally:
        if sock is not None:
            try:
                _sock_write_all(sock, b"\x00\x00\x00\x00")   # 正常结束标记
            except Exception:
                pass
            try:
                sock.close()
            except Exception:
                pass
        if switched:
            _cam_set_framesize(False)        # 还原 QVGA，别影响之后的拍照识别
        gc.collect()
        St.streaming = False
        St.busy = False
        St.last_activity = time.time()
        draw_state("idle")
        drain_touch()
        print("stream: ended, frames =", frames)


# ── 取景模式（手动拍照） ──────────────────────────────────────
#
# 与语音触发拍照的唯一区别是"拍什么由眼睛决定"：实时预览 → 快门 → 确认，
# 确认后走的仍是 /chat-vision，同一套识别链路（服务端无 wav 时用默认提问）。

CAMERA_MODE_ENABLED = True      # 回退开关：False 则顶栏 CAM 键失效，短按一律录音
CAM_IDLE_TIMEOUT    = 90        # 取景/确认界面无操作自动退出（秒）
CAM_GC_EVERY        = 20        # 每 N 帧 gc 一次，压住抓帧的堆碎片

CAM_BAR_Y  = 200                # 底部按钮条上沿
# 预览只画到按钮条上沿，底栏就不用每帧补画（否则底部 40px 会轻微频闪）。
# 代价：取景框看到的是画面上面 200 行，发出去的仍是完整 240 行。
# 若裁剪后画面异常，改 False 即回到整帧铺满 + 每帧补画底栏的行为。
CAM_PREVIEW_CLIP = True
_CAM_PREVIEW_H = CAM_BAR_Y if CAM_PREVIEW_CLIP else 240
_CAM_ENTRY = (136, 0, 200, 34)  # 待机顶栏 "CAM" 键的命中区
_CAM_BTN_L = (0,   CAM_BAR_Y, 158, 239)
_CAM_BTN_R = (161, CAM_BAR_Y, 319, 239)


_cam_touch_evt = (None, (0, 0))


def _cam_poll_touch():
    """采样一次触摸并锁存首个事件。

    取景循环一帧要 ~100ms（抓帧+刷屏），每帧只采一次会漏掉 100ms 级的
    快速点按——按了没反应。故一帧内多采几次，事件锁存到被取走为止。
    """
    global _cam_touch_evt
    t, p = check_touch()
    if t is not None and _cam_touch_evt[0] is None:
        _cam_touch_evt = (t, p)


def _cam_take_touch():
    """取走锁存的触摸事件（取走即清空）。"""
    global _cam_touch_evt
    evt = _cam_touch_evt
    _cam_touch_evt = (None, (0, 0))
    return evt


def _cam_chrome(review):
    """底部按钮条。review=False 取景中 [EXIT|SHOOT]，True 已拍待确认 [RETAKE|SEND]。"""
    if review:
        left, l_bg, right, r_bg = "RETAKE", 0x883311, "SEND", 0x117744
    else:
        left, l_bg, right, r_bg = "EXIT", 0x333333, "SHOOT", 0x8822aa
    Lcd.setFont(_FONT_16)
    Lcd.setTextSize(1)
    for rect, label, bg in ((_CAM_BTN_L, left, l_bg), (_CAM_BTN_R, right, r_bg)):
        _fill_rect(rect[0], rect[1], rect[2] - rect[0] + 1, rect[3] - rect[1] + 1, bg)
        Lcd.setTextColor(0xffffff, bg)
        tx = rect[0] + ((rect[2] - rect[0]) - len(label) * 10) // 2
        Lcd.drawString(label, tx, rect[1] + 12)


def _cam_send(raw):
    """把确认后的帧交给神乐：POST /chat-vision（不带 wav，服务端用默认提问）。"""
    draw_state("processing")
    b64 = ubinascii.b2a_base64(raw).decode("utf-8").replace("\n", "").replace("\r", "")
    gc.collect()
    payload = ujson.dumps({"image": b64})
    del b64
    gc.collect()
    try:
        hdrs = {"X-Device-Id": DEVICE_ID, "Content-Type": "application/json"}
        lt = get_local_time_header()
        if lt:
            hdrs["X-Local-Time"] = lt
        resp = urequests.post(VISION_URL, data=payload.encode("utf-8"),
                              headers=hdrs, timeout=REQUEST_TIMEOUT_CHAT)
        if resp.status_code != 200:
            print("cam send err:", resp.status_code)
            resp.close()
            draw_state("error")
            time.sleep(2)
            return
        _update_chat_text(resp.headers.get("X-User-Text", ""),
                          resp.headers.get("X-Reply-Text", ""))
        data = resp.content
        resp.close()
        draw_state("playing")
        play_wav(data)
    except OSError as e:
        print("cam send net err:", e)
        draw_state("error")
        time.sleep(2)
    finally:
        gc.collect()


def camera_mode():
    """
    取景模式主流程：实时预览 → 短按 SHOOT 定格 → RETAKE 重拍 / SEND 交给神乐。
    长按屏幕任意处随时退出；CAM_IDLE_TIMEOUT 秒无操作自动退出。
    """
    St.busy = True
    St.last_activity = time.time()
    gc.collect()
    if not _camera_ensure():
        draw_state("error")
        time.sleep(2)
        draw_state("idle")
        St.busy = False
        return

    _ui_invalidate()               # 下面要整屏接管，作废分层缓存
    Widgets.fillScreen(0x000000)   # 帧小于屏幕时四周留黑，只清一次
    _cam_chrome(False)
    _cam_take_touch()              # 丢掉进来那一下点按的残留
    shot        = None             # 定格的帧（bytes 副本），None=取景中
    last_action = time.time()
    frames      = 0
    try:
        while True:
            _wdt_feed()
            if time.time() - last_action > CAM_IDLE_TIMEOUT:
                dbg("cam idle exit")
                break

            if shot is None:
                _cam_poll_touch()
                frame = _cam_grab()
                _cam_poll_touch()
                if frame is None:
                    time.sleep(0.2)        # 抓帧失败别空转
                else:
                    _cam_show(frame, _CAM_PREVIEW_H)
                    if not CAM_PREVIEW_CLIP:
                        _cam_chrome(False)  # 整帧会盖住按钮条，得补画回来
                    frames += 1
                    if frames % CAM_GC_EVERY == 0:
                        gc.collect()
            else:
                time.sleep(0.05)           # 已定格，屏幕不用重画

            # 取景可能停留几十秒，超过 MQTT keepalive(60s) 就会被判掉线
            mqtt_check()
            # 注：心跳不在这里发——heartbeat_tick() 见 St.busy 就跳过，
            # 与录音/播放期间一样按"交互中不上报"处理，退出后自然补上。

            _cam_poll_touch()
            touch, pos = _cam_take_touch()
            if touch == 'long':
                break
            if touch != 'short':
                continue

            last_action = time.time()
            St.last_activity = last_action
            x, y = pos
            if shot is None:
                if _hit(x, y, _CAM_BTN_R):            # SHOOT：定格
                    frame = _cam_grab()
                    raw = _cam_bytes(frame) if frame is not None else None
                    if raw is None:
                        draw_state("error")
                        time.sleep(1)
                        Widgets.fillScreen(0x000000)
                        _cam_chrome(False)
                        _cam_take_touch()
                        continue
                    # 复制一份再定格：驱动可能复用同一块 framebuffer。
                    # 屏上画的是原帧对象（Lcd.show 路径只认 image.Image），
                    # 定格后不再抓帧，这一帧就一直留在屏幕上。
                    shot = bytes(raw)
                    _cam_show(frame, _CAM_PREVIEW_H)
                    _cam_chrome(True)
                    _cam_take_touch()      # 手抖连点两下别直接发出去
                elif _hit(x, y, _CAM_BTN_L):          # EXIT
                    break
            else:
                if _hit(x, y, _CAM_BTN_R):            # SEND
                    _cam_send(shot)
                    break
                elif _hit(x, y, _CAM_BTN_L):          # RETAKE：丢掉重来
                    shot = None
                    _cam_chrome(False)
                    _cam_take_touch()      # 同上：别顺手连点成 EXIT
    finally:
        shot = None
        gc.collect()
        St.last_activity = time.time()
        St.busy = False
        draw_state("idle")
        drain_touch()


# ── MQTT 推送订阅 ─────────────────────────────────────────────
#
# 回调只解析+入队（毫秒级返回），下载/播放/拍照在主循环消费。
# 好处：长任务不再阻塞 MQTT 心跳（之前 30s+ 播放会触发 keepalive 超时断连）。

_mqtt = None
_MQTT_TOPICS = []
_pending_push = []   # 待播放的 push 音频 URL
_pending_cmd  = []   # 待执行的远程命令 dict


def _mqtt_callback(topic, msg):
    """MQTT 消息回调：只入队，不做任何耗时操作。"""
    topic_str = topic.decode("utf-8") if isinstance(topic, bytes) else topic

    if "/push/" in topic_str:
        if St.busy and not St.streaming:
            # 保留去重语义：对话期间 OpenClaw 触发的重复 push 直接丢弃。
            # 直播期间不算"对话中"，照收——由推流循环负责播出来。
            print("push skipped: device busy")
            return
        try:
            info = ujson.loads(msg)
        except Exception as e:
            print("[mqtt] push parse error:", e)
            return
        url = info.get("url", "")
        if url:
            _pending_push.append(url)

    elif "/cmd/" in topic_str:
        try:
            cmd = ujson.loads(msg)
        except Exception as e:
            print("[mqtt] cmd parse error:", e)
            return
        _pending_cmd.append(cmd)


def _play_push(url):
    """下载并播放一条 push 音频（主循环调用）。"""
    if St.sleeping:
        wake_up()
    St.last_activity = time.time()
    dbg("push recv")
    draw_state("broadcast")
    try:
        resp = urequests.get(SERVER_BASE + url, timeout=REQUEST_TIMEOUT_SHORT)
        if resp.status_code == 200:
            play_wav(resp.content)
        resp.close()
    except OSError as e:
        print("push download err:", e)
    draw_state("idle")
    _set_led(0, 0, 0)


def _upload_photo(request_id, image_b64):
    """把拍到的图 POST 给服务端。远程拍照与直播插拍共用。"""
    payload = ujson.dumps({
        "request_id": request_id,
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
        return True
    except OSError as e:
        print("upload err:", e)
        return False


def _run_capture_cmd(cmd):
    """执行远程拍照命令（主循环调用）。"""
    if St.sleeping:
        wake_up()
    St.last_activity = time.time()
    St.busy = True
    try:
        draw_state("camera")
        image_b64 = capture_photo()
        draw_state("processing")
        _upload_photo(cmd.get("request_id", ""), image_b64)
    finally:
        draw_state("idle")
        St.busy = False


def process_mqtt_queue():
    """主循环调用：每 tick 最多消费一项，空闲时才执行。"""
    if St.busy:
        return
    if _pending_push:
        _play_push(_pending_push.pop(0))
    elif _pending_cmd:
        cmd = _pending_cmd.pop(0)
        action = cmd.get("action")
        if action == "capture":
            _run_capture_cmd(cmd)
        elif action == "stream_start":
            _run_stream_cmd(cmd)
        # stream_stop：不在直播中收到就没有意义，丢弃即可
        #（直播中的续期/停止由 _stream_drain_cmds 自己消费）


def _reconnect_mqtt():
    """重连 MQTT 并重新订阅所有 topic。"""
    global _mqtt, _mqtt_ok
    try:
        _mqtt.connect(clean_session=False)
        for t in _MQTT_TOPICS:
            _mqtt.subscribe(t, 1)
        _mqtt_ok = True
        dbg("mqtt reconnected")
    except Exception as e:
        _mqtt_ok = False
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
        globals()["_mqtt_ok"] = True
        print("MQTT connected:", MQTT_BROKER)
    except Exception as e:
        print("MQTT init error:", e)
        _mqtt = None


_mqtt_last_reconnect = 0     # 重连退避：WiFi 长时间断开时避免每 20ms 重连一次打爆 socket 池


_mqtt_init_last = 0


def mqtt_check():
    """主循环调用：非阻塞检查 MQTT 消息，定期 ping 保活，断连时自动重连（5s 退避）。"""
    global _mqtt_last_ping, _mqtt_last_reconnect, _mqtt_init_last
    if _mqtt is None:
        # 开机时网络未就绪导致 init 失败的话，之前永远不会再试 → 补 60s 重试
        now = time.time()
        if _wifi_ok() and now - _mqtt_init_last >= 60:
            _mqtt_init_last = now
            init_mqtt()
            if _mqtt:
                dbg("mqtt late-init ok")
        return
    if _mqtt:
        try:
            _mqtt.check_msg()
            # 每 30 秒发送 ping 保活（keepalive=60s，需在超时前 ping）
            now = time.time()
            if now - _mqtt_last_ping > 30:
                _mqtt.ping()
                _mqtt_last_ping = now
        except OSError as e:
            global _mqtt_ok
            if _mqtt_ok:
                _mqtt_ok = False
                dbg("mqtt disconnected: {}".format(e))
            now = time.time()
            if now - _mqtt_last_reconnect >= 5:
                _mqtt_last_reconnect = now
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


def imu_tick():
    """主循环调用：一次采样同时喂给摇晃彩蛋和触觉检测。

    合并读取不是为了省那 1ms I2C，是为了两个检测器看到的是同一个样本——
    分开读会出现"摇晃检测到尖峰、触觉那边读到的却是尖峰之间的谷值"，
    于是一次摇晃被同时算成三次轻拍。
    """
    if not _imu_available or St.busy:
        return
    try:
        acc = M5.Imu.getAccel()
        if acc is None:
            return
        ax, ay, az = acc
        # 总加速度幅值（静止时约等于重力 1g）
        magnitude = math.sqrt(ax * ax + ay * ay + az * az)
    except Exception:
        return

    if TOUCH_FEEL_ENABLED:
        try:
            _imu_feel_detect(magnitude)
        except Exception as e:
            print("[feel] imu err:", e)
    _imu_shake_detect(magnitude)


def _imu_shake_detect(magnitude):
    """摇晃彩蛋：500ms 内 IMU_SHAKE_COUNT 次超阈值。"""
    global _imu_shake_times, _imu_last_shake

    now = time.time()
    if now - _imu_last_shake < IMU_SHAKE_COOLDOWN:
        return

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
    if magnitude >= IMU_TAP_G:
        _imu_tap_spikes.append(now_ms)
        if _imu_tap_pending is None:
            _imu_tap_pending = now_ms
    # 尖峰列表用 IMU_TAP_G 收，是摇晃检测（IMU_SHAKE_G）的超集，
    # 所以它数到 3 一定不晚于摇晃判定成立——摇晃永远能抢在确认前撤销轻拍。
    _imu_tap_spikes[:] = [t for t in _imu_tap_spikes
                          if time.ticks_diff(now_ms, t) < IMU_TAP_SPIKE_WIN]
    if _imu_tap_pending is not None:
        if len(_imu_tap_spikes) >= IMU_SHAKE_COUNT:
            _imu_tap_pending = None            # 是摇晃，让给彩蛋
        elif time.ticks_diff(now_ms, _imu_tap_pending) >= IMU_TAP_CONFIRM_MS:
            _imu_tap_pending = None
            _on_tapped()

    # ── 运动/静止：被拿起来 = 长时间静止之后的一段持续运动 ──
    if dev >= IMU_MOTION_BAND:
        if _imu_move_since is None:
            _imu_move_since   = now_ms
            # 运动开始前静止了多久，要在这一刻捕获：_imu_last_motion 随后
            # 每个采样都会被刷新，等确认拿起时再算就永远是 0。
            _imu_still_before = (now - _imu_last_motion) if _imu_last_motion else 0
        _imu_last_motion = now
        if (not _imu_carried
                and time.ticks_diff(now_ms, _imu_move_since) >= IMU_PICKUP_MOVE_MS):
            _imu_carried     = True
            _imu_carry_start = now
            if _imu_still_before >= IMU_PICKUP_STILL:
                _on_picked_up(_imu_still_before)
    elif _imu_move_since is not None and (now - _imu_last_motion) >= IMU_CARRY_GAP:
        # 走路时合加速度会反复穿过阈值，所以要静止满 IMU_CARRY_GAP 才算放下
        _imu_move_since = None
        if _imu_carried:
            _imu_carried = False
            Feel.carry_secs += now - _imu_carry_start


def _on_tapped():
    """机身被轻拍：反射 + 计数。轻拍意图明确（"喂，看这边"），值得开口。

    被端在手上时一律不算轻拍：走动本身就会不停制造 1.5g 以上的尖峰，
    不挡掉的话拿着她走两步就是几十次"被拍"，还会顶着冷却反复开口。
    """
    if _imu_carried:
        return
    quiet = feel_touched()
    Feel.taps += 1
    feel_reflex("poked")
    feel_notify("tap", "quiet=%d" % int(quiet))


def _on_picked_up(still_before):
    """被从桌上拿起来：这是最明确的"我想跟你互动"信号。"""
    quiet = feel_touched()
    Feel.pickups += 1
    if St.sleeping:
        if FEEL_WAKE_ON_PICKUP:
            wake_up()
        return                     # 刚被叫醒就主动说话太吓人，这次不惊动
    feel_reflex("held")
    feel_notify("pickup", "quiet=%d,still=%d" % (int(quiet), int(still_before)))


def _show_shake_easter_egg():
    """显示摇晃彩蛋图片 2 秒，然后切换连续对话模式。continuous off→on 时额外调用 /shake 让 AI 主动聊天。"""
    global _imu_last_shake
    St.busy = True
    St.last_activity = time.time()
    try:
        was_off = not St.continuous
        try:
            _ui_invalidate()       # 彩蛋图整屏覆盖，之后必须整屏重建
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
        touch_reset()
        drain_touch()
        _imu_last_shake = time.time()
    finally:
        St.busy = False


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
    """息屏休眠：关闭背光和 LED，释放麦克风。"""
    St.sleeping = True
    _set_led(0, 0, 0)
    _mic_off()
    M5.Lcd.setBrightness(0)


def wake_up():
    """唤醒：恢复背光，重置活动计时。"""
    St.sleeping = False
    St.last_activity = time.time()
    M5.Lcd.setBrightness(64)
    draw_state("idle", force=True)   # 休眠期间跳过了动画，整屏重画一次


def calibrate_noise():
    """
    Fix 8: 启动时采样 1s 环境底噪，自动设置说话和唤醒阈值。
    阈值 = max(底噪峰值 × 倍数, 最低保障值)，避免安静环境误触发。
    """
    global SILENCE_THRESHOLD, WAKE_THRESHOLD
    #Widgets.Label("Calibrating...", 40, 155, 1, 0x666666, 0x1a1a1a,_FONT_16)
    sample_buf = bytearray(int(16000 * 2 * 0.1))
    samples = []
    _mic_on()
    for _ in range(10):   # 10 × 100ms = 1s
        Mic.record(sample_buf, 16000)
        time.sleep(0.1)
        samples.append(rms(sample_buf))
    _mic_off()
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


def _boot_report():
    """开机上报服务端：携带上次崩溃日志（如有），成功后删除本地日志。

    作用：1) 服务端能记录设备每次重启的时间点；2) 崩溃堆栈自动送达
    服务端 crash_reports/，无需 USB 连接取证。失败静默，不阻塞启动。
    """
    log = ""
    try:
        with open("/flash/crash.log", "r") as f:
            log = f.read(8192)   # 只取前 8KB，防大文件撑爆内存
    except OSError:
        pass                     # 无崩溃记录，仅作开机通知
    try:
        import machine
        cause = machine.reset_cause()
    except Exception:
        cause = -1
    try:
        resp = urequests.post(
            SERVER_BASE + "/crash-report",
            data=ujson.dumps({"device_id": DEVICE_ID, "log": log,
                              "reset_cause": cause}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            timeout=REQUEST_TIMEOUT_SHORT,
        )
        ok = resp.status_code == 200
        resp.close()
        if ok and log:
            uos.remove("/flash/crash.log")
            print("crash log uploaded")
    except Exception as e:
        print("boot report failed:", e)


def setup():
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
    _boot_report()
    sync_rtc()
    init_mqtt()
    init_ble()
    init_imu()
    _volume_load()
    canvas_probe()           # 一次性诊断；CANVAS_PROBE=False 即整段跳过
    draw_state("idle")       # 发现完成后恢复空闲界面
    calibrate_noise()
    St.last_activity = time.time()
    _wdt_init()   # 最后再武装看门狗：WiFi 配置 UI 等交互流程不受 2 分钟窗口限制


def loop():
    global _wake_last_ms, _wake_loud_count

    # feel=True 只在这里传：主循环是唯一把屏幕当皮肤的地方
    touch, pos = check_touch(feel=True)

    # ── 休眠中：触摸仅唤醒，不执行其他操作 ──
    if St.sleeping:
        if touch is not None:
            wake_up()
            drain_touch()
            touch_reset()      # 抚摸在按住期间就唤醒了，别让抬手再触发一次结算
    elif not St.busy:
        if touch is not None:
            St.last_activity = time.time()
        if touch in ('stroking', 'cradling'):
            # 反射层：摸到的当下就换表情，不过网。draw_state 的键比对保证
            # 抚摸全程只重画第一帧
            feel_reflex("petted")
        elif touch in ('stroke', 'cradle'):
            feel_on_touch_end(touch)     # 抬手：结算体感，够显著才惊动 agent
        elif touch == 'long':
            toggle_wake_mode()           # 长按：切换声控唤醒模式
        elif touch == 'short':
            if CAMERA_MODE_ENABLED and _hit(pos[0], pos[1], _CAM_ENTRY):
                camera_mode()            # 短按顶栏 CAM 键：手动取景拍照
            else:
                record_and_send()        # 短按其他位置：直接录音
        elif St.wake:
            # 简化的声控唤醒：连续 N×100ms 音量超阈值 → 触发录音
            now_ms = time.ticks_ms()
            if time.ticks_diff(now_ms, _wake_last_ms) >= 100:
                _wake_last_ms = now_ms
                if WAKE_MIC_PERSISTENT:
                    _mic_on()            # 幂等：常开，播放时由 play_wav 释放
                    Mic.record(_wake_buf, 16000)
                    time.sleep(0.05)
                else:
                    Mic.begin()          # 旧行为：每次建拆驱动（回退开关）
                    Mic.record(_wake_buf, 16000)
                    time.sleep(0.05)
                    Mic.end()
                level = rms(_wake_buf)
                if level > WAKE_THRESHOLD:
                    _wake_loud_count += 1
                    if _wake_loud_count >= WAKE_LOUD_NEED:
                        _wake_loud_count = 0
                        St.last_activity = time.time()
                        record_and_send()
                else:
                    _wake_loud_count = 0

    # 空闲呼吸动画（自带 20fps 限帧；休眠时自动跳过）
    visual_tick()

    # MQTT 推送消息 + 命令（回调只入队，这里接收；下面统一消费）
    mqtt_check()
    process_mqtt_queue()

    # 网络自检（WiFi 掉线自动重连）+ 心跳上报
    net_watch_tick()
    heartbeat_tick()

    # BLE 在家感知（非阻塞定期扫描）
    ble_scan_tick()

    # IMU：摇晃彩蛋 + 本体感觉（被拿起/被轻拍/被抱着走）
    imu_tick()

    # 触觉反射表情到期收回
    feel_reflex_tick()

    # ── 自动休眠检查 ──
    now = time.time()
    if not St.sleeping and not St.busy:
        if now - St.last_activity > SLEEP_TIMEOUT:
            enter_sleep()


def _log_crash(e):
    """崩溃现场写入 /flash/crash.log，供重启后排查死因。"""
    try:
        import sys, io
        try:
            if uos.stat("/flash/crash.log")[6] > 32768:
                return   # 上限 32KB：反复崩溃复位时避免写穿 flash
        except OSError:
            pass
        buf = io.StringIO()
        sys.print_exception(e, buf)
        with open("/flash/crash.log", "a") as f:
            f.write("=== crash @ {} uptime={}s ===\n{}\n".format(
                get_rtc_time_str() or "?", int(time.time()), buf.getvalue()))
    except Exception:
        pass


if __name__ == '__main__':
    setup()
    _last_gc = time.time()
    _err_count = 0
    while True:
        try:
            loop()
            _wdt_feed()
            _err_count = 0
            if time.time() - _last_gc > 30:   # 空闲期定期 GC，缓解长时间运行的堆碎片化
                gc.collect()
                _last_gc = time.time()
        except Exception as e:
            # 单次异常不复位：记录现场后继续跑（复位会丢失上下文且中断服务）。
            # 连续 10 次说明陷入了出不来的坏状态 → 复位自愈；真卡死则 WDT 兜底。
            _err_count += 1
            _log_crash(e)
            print("[loop] uncaught:", e)
            try:
                draw_state("error")
                time.sleep(1)
                draw_state("idle")
            except Exception:
                pass
            if _err_count >= 10:
                _persist_dbg("loop-error-storm")
                time.sleep(1)
                import machine
                machine.reset()
        time.sleep(0.02)   # 空闲时不再全速自旋；触摸按抬起时长判定，20ms 粒度无感
