#!/usr/bin/env python3
"""从 cores3_client.py 生成 device/src/*.py。

思路：单文件里每个顶层定义都有唯一归属模块，按归属抽取源码块（原样保留注释），
再用 AST 精确定位把跨模块的裸引用改写成 mod.attr。
"""
import ast, builtins, os, sys, collections

SRC = "cores3_client.py"
OUT = "device/src"

# ── 依赖分层（必须无环，check_split.py 会验）────────────────────
#   cfg → hw → clock → ui → {wifisetup, audio} → cam → feel
#       → diag → netsvc → stream → chat → app
LAYER = ["cfg", "hw", "clock", "ui", "wifisetup", "audio", "cam",
         "feel", "diag", "netsvc", "stream", "chat", "app"]

# ── 归属表：名字 → 模块 ────────────────────────────────────────
ASSIGN = {}

def own(mod, *names):
    for n in names:
        ASSIGN[n] = mod

own("cfg",
    "SERVER_BASE", "SERVER_URL", "VISION_URL", "UPLOAD_URL", "DEVICE_ID",
    "MQTT_BROKER", "REQUEST_TIMEOUT_CHAT", "REQUEST_TIMEOUT_SHORT",
    "REQUEST_TIMEOUT_UPLOAD", "STREAM_PORT", "STREAM_TOKEN",
    "SAMPLE_RATE", "CHUNK_SEC", "CHUNK_SIZE", "SILENCE_THRESHOLD",
    "SILENCE_CHUNKS", "MAX_CHUNKS", "WAKE_MIC_PERSISTENT", "WAKE_THRESHOLD",
    "WAKE_CHUNK_SIZE", "WAKE_LOUD_NEED", "WATCHDOG_ENABLED",
    "WATCHDOG_TIMEOUT_MS", "LONG_PRESS_MS", "SLEEP_TIMEOUT",
    "TOUCH_FEEL_ENABLED", "FEEL_NOTIFY_ENABLED", "STROKE_MIN_DIST",
    "STROKE_MIN_MS", "FEEL_STROKE_NOTIFY", "FEEL_REFLEX_LINGER",
    "_FEEL_LINGER_MS", "FEEL_NOTIFY_COOLDOWN", "FEEL_QUIET_SECS",
    "FEEL_WAKE_ON_PICKUP", "FEEL_DEBUG",
    "BLE_PHONE_NAME", "BLE_SCAN_INTERVAL", "BLE_SCAN_DURATION",
    "BLE_RSSI_THRESHOLD", "BLE_HOME_COUNT", "BLE_AWAY_TIMEOUT",
    "IMU_SHAKE_G", "IMU_SHAKE_COUNT", "IMU_SHAKE_COOLDOWN",
    "IMU_TAP_G", "IMU_TAP_CONFIRM_MS", "IMU_TAP_SPIKE_WIN",
    "IMU_MOTION_BAND", "IMU_PICKUP_STILL", "IMU_PICKUP_MOVE_MS",
    "IMU_CARRY_GAP",
    "STATE_UI", "SHOW_CHAT_TEXT", "VISUAL_ENABLED", "USE_STATE_IMAGES",
    "VIS_FRAME_MS", "RING_N", "RING_CX", "RING_CY", "RING_R", "RING_W",
    "USE_CANVAS", "CANVAS_PROBE",
    "CAMERA_QVGA", "PREVIEW_SWAP", "PREVIEW_LEN_IN_PIXELS",
    "CAMERA_MODE_ENABLED", "CAM_IDLE_TIMEOUT", "CAM_GC_EVERY",
    "CAM_BAR_Y", "CAM_PREVIEW_CLIP",
    "STREAM_ENABLED", "STREAM_MAX_SECS", "STREAM_QQVGA",
    "STREAM_SETTLE_FRAMES",
    "_HB_INTERVAL", "_NET_CHECK_IVL", "_NET_FIX1_SECS", "_NET_FIX2_SECS",
    "_DISC_PORT", "_DISC_MSG", "_DISC_TIMEOUT", "_DISC_RETRIES",
    "_WIFI_CONNECT_TIMEOUT",
    "St", "Feel")

own("hw",
    "_has_rgb", "_set_led", "_VOLUME_PATH", "_volume", "_volume_load",
    "_volume_get", "_volume_adjust", "_mic_active", "_mic_on", "_mic_off",
    "_wdt", "_wdt_init", "_wdt_feed",
    "_touch_start", "_touch_pos", "_touch_maxd", "_touch_gesture",
    "_touch_last_ms", "_touch_seen_ms", "_FEEL_ONGOING",
    "check_touch", "drain_touch", "touch_reset",
    "make_wav_header", "rms", "rms_slices",
    "_fill_rect", "_stroke_rect", "_hit", "_wait_tap")

own("clock",
    "_rtc_synced", "_has_rtc", "_soft_time_offset",
    "sync_rtc", "get_rtc_time_str", "get_local_time_header", "_rtc_now")

own("ui",
    "_FONT_16", "_FONT_CN", "_last_user_text", "_last_reply_text",
    "_update_chat_text",
    "_ring_rects", "_vis_mode", "_vis_theme", "_vis_shades", "_vis_level",
    "_vis_ref", "_vis_phase", "_vis_last", "_vis_last_ms",
    "_shade", "_vis_invalidate", "_vis_set_state", "_vis_set_level",
    "visual_tick", "_vis_wait",
    "_IMG_MAP", "_img_missing", "_FORCED_IMG", "_drawn_key",
    "_ui_invalidate", "draw_state",
    "_canvas", "_canvas_tried", "_get_canvas",
    "_canvas_disable", "_mk_canvas",
    "enter_sleep", "wake_up")

own("wifisetup",
    "_WIFI_CONF_PATH", "_WIFI_CONF_TMP", "_wlan", "_wlan_if",
    "_wifi_load", "_wifi_save", "_wifi_scan", "_wifi_connect",
    "ensure_wifi", "_PICKER_ROW_H", "_PICKER_PER_PAGE", "_PICKER_Y0",
    "_PICKER_RESCAN", "_PICKER_MANUAL", "_PICKER_PAGE",
    "_draw_picker", "_pick_ssid", "_KBD_LAYOUTS", "_KBD_KEY_W",
    "_KBD_KEY_H", "_KBD_X0", "_KBD_Y0", "_KBD_SHIFT", "_KBD_SPACE",
    "_KBD_BKSP", "_KBD_OK", "_KBD_CX", "_draw_kbd", "_kbd_input")

own("audio",
    "calibrate_noise", "_record_audio", "play_wav", "_wav_envelope")

own("cam",
    "_CAM_SIZES", "_camera_inited", "_cam_grab_fn", "_cam_draw_mode",
    "_camera_ensure", "_cam_grab", "_cam_bytes", "_cam_show",
    "_cam_set_framesize", "capture_photo", "_upload_photo",
    "_CAM_PREVIEW_H", "_CAM_ENTRY", "_CAM_BTN_L", "_CAM_BTN_R",
    "_cam_touch_evt", "_cam_poll_touch", "_cam_take_touch",
    "_cam_chrome", "_cam_send", "camera_mode")

own("feel",
    "_feel_reflex_state", "_feel_reflex_until",
    "feel_reflex", "feel_reflex_clear", "feel_reflex_tick",
    "feel_touched", "feel_header", "_feel_headers",
    "feel_notify", "feel_on_touch_end",
    "_imu_tap_spikes", "_imu_tap_pending", "_imu_last_motion",
    "_imu_move_since", "_imu_still_before", "_imu_carried",
    "_imu_carry_start", "_imu_feel_detect", "_on_tapped", "_on_picked_up")

own("diag",
    "_dbg_buf", "_dbg_sent", "_dbg_persisted", "_hb_last",
    "_net_last_check", "_wifi_reconnect_last", "_wifi_was_ok",
    "_mqtt_ok", "_net_dot", "_pwr_last", "_boot_ticks", "_boot_time",
    "_last_server_ok", "_net_fix_stage",
    "dbg", "_persist_dbg", "_wifi_ok", "_draw_net_dot",
    "net_watch_tick", "heartbeat_tick", "_boot_report", "_log_crash",
    "canvas_probe", "_canvas_probe")   # 画布探测是诊断，放这里才不成环

own("netsvc",
    "_mqtt", "_MQTT_TOPICS", "_pending_push", "_pending_cmd",
    "_mqtt_last_ping", "_mqtt_last_reconnect", "_mqtt_init_last",
    "init_mqtt", "_reconnect_mqtt", "_mqtt_callback", "mqtt_check",
    "process_mqtt_queue", "_play_push", "_run_capture_cmd",
    "_ble", "_ble_phone_found", "_ble_last_scan", "_ble_last_seen",
    "_ble_seen_count", "_user_home", "_ble_status_sent",
    "init_ble", "ble_scan_tick", "_ble_irq", "_decode_ble_name",
    "_report_presence", "discover_server")

own("stream",
    "_stream_deadline", "_sock_write_all", "_stream_drain_cmds",
    "_stream_hires_capture", "_run_stream_cmd")

own("chat",
    "_imu_shake_times", "_imu_last_shake", "_imu_available",
    "init_imu", "imu_tick", "_imu_shake_detect", "_show_shake_easter_egg",
    "record_and_send", "toggle_continuous", "toggle_wake_mode")

own("app", "setup", "loop", "main",
    "_wake_buf", "_wake_last_ms", "_wake_loud_count")   # 只有 loop() 用

# ── 跨模块可变量的赋值改写（上游铁律 #2：global X 会在本模块另建一个同名
#    全局，原模块纹丝不动且不报错。这几处必须写成 mod.X = ...）──────────
FIXUPS = [
 ('app', 'def setup():\n    M5.begin()\n    Widgets.setRotation(1)\n    hw._set_led(0, 0, 0)', 'def setup():\n    M5.begin()\n    Widgets.setRotation(1)\n\n    # ── 拆分后的接线：目录 + 打断依赖环的回调注入 ──────────────\n    # 单文件时代这些都是直接调用；拆成模块后 audio→netsvc、netsvc→stream\n    # 会成环（tools/check_split.py 直接拦），所以改成在这里注入。\n    cfg.ensure_dirs()\n    audio.set_pump(netsvc.mqtt_check)              # 播放/取景期间维持 MQTT\n    netsvc.set_stream_runner(stream._run_stream_cmd)   # MQTT 收到直播命令时回调\n\n    hw._set_led(0, 0, 0)'),
 ('hw', '"/flash/volume.json"', 'cfg.data("volume.json")'),
 ('diag', '"/flash/crash.log"', 'cfg.data("crash.log")'),
 ('app', '"/flash/crash.log"', 'cfg.data("crash.log")'),
 ('wifisetup', '"/flash/wifi.json"', 'cfg.data("wifi.json")'),
 ('wifisetup', '"/flash/wifi.json.tmp"', 'cfg.data("wifi.json.tmp")'),
 ('audio', '"/flash/response.wav"', 'cfg.data("response.wav")'),
 ('ui', '"/flash/{}.jpg".format(want_bg)', 'cfg.res("{}.jpg".format(want_bg))'),
 ('ui', '"/flash/img_bg.jpg"', 'cfg.res("img_bg.jpg")'),
 ('chat', '"/flash/img_shake.jpg"', 'cfg.res("img_shake.jpg")'),
 ('diag', '"/flash/img_bg.jpg"', 'cfg.res("img_bg.jpg")'),
 ("audio",
  "    global SILENCE_THRESHOLD, WAKE_THRESHOLD\n",
  "    # 阈值属于 cfg，必须写 cfg.X = ...；用 global 会在本模块另建同名全局\n"),
 ("audio",
  '    SILENCE_THRESHOLD = max(200, noise_floor * 3)\n'
  '    WAKE_THRESHOLD    = max(300, noise_floor * 4)\n'
  '    print(f"校准完成：底噪={noise_floor}，说话阈值={SILENCE_THRESHOLD}，唤醒阈值={WAKE_THRESHOLD}")',
  '    cfg.SILENCE_THRESHOLD = max(200, noise_floor * 3)\n'
  '    cfg.WAKE_THRESHOLD    = max(300, noise_floor * 4)\n'
  '    print("校准完成：底噪={}，说话阈值={}，唤醒阈值={}".format(\n'
  '        noise_floor, cfg.SILENCE_THRESHOLD, cfg.WAKE_THRESHOLD))'),
 # _mqtt_ok 归 diag（netsvc → diag 单向依赖，反过来会成环）
 ("netsvc", "        _mqtt_ok = True\n", "        diag._mqtt_ok = True\n"),
 ("netsvc", "        _mqtt_ok = False\n", "        diag._mqtt_ok = False\n"),
 ("netsvc", '        globals()["_mqtt_ok"] = True\n', "        diag._mqtt_ok = True\n"),
 ("netsvc",
  "            global _mqtt_ok\n"
  "            if _mqtt_ok:\n"
  "                _mqtt_ok = False\n",
  "            if diag._mqtt_ok:\n"
  "                diag._mqtt_ok = False\n"),
 # UDP 发现改写服务端地址
 ("netsvc",
  "    global SERVER_BASE, SERVER_URL, VISION_URL, UPLOAD_URL, MQTT_BROKER\n",
  "    # 这五个是 cfg 的可变量，必须 cfg.X = ... 才能让其他模块看到\n"),
 ("netsvc",
  '                    SERVER_BASE = "http://{}:5000".format(ip)\n'
  '                    SERVER_URL  = SERVER_BASE + "/chat"\n'
  '                    VISION_URL  = SERVER_BASE + "/chat-vision"\n'
  '                    UPLOAD_URL  = SERVER_BASE + "/upload-photo"\n'
  '                    MQTT_BROKER = ip\n'
  '                    print("discovered:", SERVER_BASE)',
  '                    cfg.SERVER_BASE = "http://{}:5000".format(ip)\n'
  '                    cfg.SERVER_URL  = cfg.SERVER_BASE + "/chat"\n'
  '                    cfg.VISION_URL  = cfg.SERVER_BASE + "/chat-vision"\n'
  '                    cfg.UPLOAD_URL  = cfg.SERVER_BASE + "/upload-photo"\n'
  '                    cfg.MQTT_BROKER = ip\n'
  '                    print("discovered:", cfg.SERVER_BASE)'),
 ("netsvc",
  '        print("discovery failed, fallback:", SERVER_BASE)',
  '        print("discovery failed, fallback:", cfg.SERVER_BASE)'),
 ("netsvc", "    global _mqtt, _mqtt_ok\n", "    global _mqtt\n"),
 # ── 打断 audio ↔ netsvc 的环（play_wav 要维持心跳，netsvc 又要回调播放）──
 ("audio",
  "        netsvc.mqtt_check()   # 长播放期间维持心跳（回调只入队，不会嵌套播放）",
  "        _pump_safe()          # 长播放期间维持心跳（回调只入队，不会嵌套播放）"),
 # 取景循环同样要泵 MQTT——复用 audio 的注入点，不必再开一个
 ("cam", "            netsvc.mqtt_check()", "            audio._pump_safe()"),
 # ── 打断 netsvc ↔ stream 的环（推流循环要回来消费 MQTT 命令队列）────────
 ("netsvc",
  "            stream._run_stream_cmd(cmd)",
  "            if _stream_runner:\n                _stream_runner(cmd)"),
 # ── 铁律 #3：局部变量不能叫 cfg，会遮蔽 cfg 模块（上游同样改名 saved）──
 ("diag",
  '        cfg = wifisetup._wifi_load()\n'
  '        if cfg and cfg.get("ssid"):\n'
  '            dbg("wifi reconnect -> {}".format(cfg["ssid"]))',
  '        saved = wifisetup._wifi_load()\n'
  '        if saved and saved.get("ssid"):\n'
  '            dbg("wifi reconnect -> {}".format(saved["ssid"]))'),
 ("diag",
  '                if cfg.get("password"):\n'
  '                    wlan.connect(cfg["ssid"], cfg["password"])\n'
  '                else:\n'
  '                    wlan.connect(cfg["ssid"])',
  '                if saved.get("password"):\n'
  '                    wlan.connect(saved["ssid"], saved["password"])\n'
  '                else:\n'
  '                    wlan.connect(saved["ssid"])'),
 ("diag",
  '                cfg = wifisetup._wifi_load()\n'
  '                if cfg and cfg.get("ssid"):\n'
  '                    if cfg.get("password"):\n'
  '                        wlan.connect(cfg["ssid"], cfg["password"])\n'
  '                    else:\n'
  '                        wlan.connect(cfg["ssid"])',
  '                saved = wifisetup._wifi_load()\n'
  '                if saved and saved.get("ssid"):\n'
  '                    if saved.get("password"):\n'
  '                        wlan.connect(saved["ssid"], saved["password"])\n'
  '                    else:\n'
  '                        wlan.connect(saved["ssid"])'),
 ("wifisetup",
  '    cfg = _wifi_load()\n'
  '    if cfg:\n'
  '        ssid = cfg.get("ssid", "")\n'
  '        pwd  = cfg.get("password", "")',
  '    saved = _wifi_load()\n'
  '    if saved:\n'
  '        ssid = saved.get("ssid", "")\n'
  '        pwd  = saved.get("password", "")'),
]

# 注入到模块头部的额外代码（回调注入点）
MAIN = '\n\ndef main():\n    """入口：装配 + 带崩溃守护的主循环。由 /flash/main.py 调用。\n\n    单文件时代这段是文件末尾的 `if __name__ == "__main__":`，拆分后\n    收成函数——引导文件 device/main.py 只负责加 sys.path 再调它。\n    """\n    setup()\n    last_gc = time.time()\n    err_count = 0\n    while True:\n        try:\n            loop()\n            hw._wdt_feed()\n            err_count = 0\n            if time.time() - last_gc > 30:   # 空闲期定期 GC，缓解长时间运行的堆碎片化\n                gc.collect()\n                last_gc = time.time()\n        except Exception as e:\n            # 单次异常不复位：记录现场后继续跑（复位会丢失上下文且中断服务）。\n            # 连续 10 次说明陷入了出不来的坏状态 → 复位自愈；真卡死则 WDT 兜底。\n            err_count += 1\n            diag._log_crash(e)\n            print("[loop] uncaught:", e)\n            try:\n                ui.draw_state("error")\n                time.sleep(1)\n                ui.draw_state("idle")\n            except Exception:\n                pass\n            if err_count >= 10:\n                diag._persist_dbg("loop-error-storm")\n                time.sleep(1)\n                import machine\n                machine.reset()\n'

EXTRA = {
 "cfg": '\n# ── 设备上的目录布局（与上游一致）──────────────────────────────\n# /flash/main.py              三行引导，把 SRC_DIR 加进 sys.path\n# /flash/kagura/src/*.py      本模块及其他代码\n# /flash/kagura/resource/*    图片等只读资源（用户上传）\n# /flash/kagura/data/*        运行时可写状态（wifi/音量/崩溃日志，自动创建）\n\nBASE_DIR = "/flash/kagura"\nSRC_DIR  = BASE_DIR + "/src"\nRES_DIR  = BASE_DIR + "/resource"\nDATA_DIR = BASE_DIR + "/data"\n\n\ndef res(name):\n    """资源文件绝对路径。新增资源一律走这里，别硬编码 /flash。"""\n    return RES_DIR + "/" + name\n\n\ndef data(name):\n    """可写状态文件绝对路径。"""\n    return DATA_DIR + "/" + name\n\n\ndef ensure_dirs():\n    """确保可写目录存在（资源目录由用户上传时创建）。"""\n    import uos\n    for d in (BASE_DIR, DATA_DIR):\n        try:\n            uos.mkdir(d)\n        except OSError:\n            pass          # 已存在\n\n',
 "audio": '''
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
''',
 "netsvc": '''
# ── 回调注入：打断 netsvc ↔ stream 的环 ───────────────────────
# MQTT 收到 stream_start 要交给 stream 跑推流，而推流循环又要回来消费
# MQTT 命令队列。由 app.setup() 注入：
#     netsvc.set_stream_runner(stream._run_stream_cmd)
_stream_runner = None


def set_stream_runner(fn):
    global _stream_runner
    _stream_runner = fn
''',
}

# 补漏
own("ui", "_vis_set_level_norm")
own("wifisetup", "_kbd_key_rect", "_prompt_text", "wifi_setup_flow")
own("clock", "_get_datetime")
own("netsvc", "_is_apple_device", "_notify_presence")


def main():
    src = open(SRC).read()
    tree = ast.parse(src)
    lines = src.split("\n")

    # 1. 收集每个顶层语句绑定的名字 + 源码范围
    blocks = []          # (mod, start, end, names)
    unassigned = []
    for n in tree.body:
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            continue                       # import 由各模块头部自己写
        names = []
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
            names = [n.name]
        elif isinstance(n, ast.Assign):
            names = [t.id for t in n.targets if isinstance(t, ast.Name)]
        elif isinstance(n, ast.Try):
            names = ["_has_rgb"]           # RGB 探测
        elif isinstance(n, ast.For):
            names = ["_ring_rects"]        # 环形几何预计算
        elif isinstance(n, ast.If):
            continue                       # if __name__ 之类，app 自己写
        mods = {ASSIGN[x] for x in names if x in ASSIGN}
        if not mods:
            unassigned.append((n.lineno, names))
            continue
        if len(mods) > 1:
            print("!! 一条语句跨模块:", n.lineno, names, mods)
        blocks.append((mods.pop(), n.lineno, getattr(n, "end_lineno", n.lineno), names))

    if unassigned:
        print("!! 未归属的顶层语句:")
        for ln, nm in unassigned:
            print("   {:>5} {}".format(ln, nm))
        return 1

    # 顶层语句之间的独立注释块不属于任何 AST 节点，直接按 lineno 抽取会把
    # 「# ── 触觉 ──」这类段头和大段说明全部丢掉——而踩坑记录都在那里面。
    # 所以每块向上吞掉紧邻的注释/空行，边界是上一条语句的末行。
    blocks.sort(key=lambda x: x[1])
    prev_end = 0
    widened = []
    for mod, a, b, names in blocks:
        s0 = a
        while s0 - 1 > prev_end:
            up = lines[s0 - 2].strip()
            if up == "" or up.startswith("#"):
                s0 -= 1
            else:
                break
        while s0 < a and lines[s0 - 1].strip() == "":
            s0 += 1                      # 去掉吞进来的前导空行
        widened.append((mod, s0, b, names))
        prev_end = b
    blocks = widened

    by_mod = collections.OrderedDict((m, []) for m in LAYER)
    for mod, a, b, names in blocks:
        by_mod[mod].append((a, b, names))
    for m in by_mod:
        by_mod[m].sort()

    # 2. 逐模块拼源码 + 改写跨模块引用
    os.makedirs(OUT, exist_ok=True)
    for mod in LAYER:
        body = []
        for a, b, _ in by_mod[mod]:
            body.append("\n".join(lines[a - 1:b]))
        text = "\n\n\n".join(body) + "\n"
        text, warns = rewrite(mod, text)
        for fm, old, new in FIXUPS:
            if fm != mod:
                continue
            if old not in text:
                print("  !! {}: FIXUP 未命中 → {!r}".format(mod, old[:48]))
            text = text.replace(old, new)
        if mod == "app":
            text += MAIN     # 必须在算模块头之前追加，否则 gc/time 的 import 漏掉
        head = header(mod, text)
        extra = EXTRA.get(mod, "")
        open(os.path.join(OUT, mod + ".py"), "w").write(head + extra + "\n" + text)
        for w in warns:
            print("  !! {}: {}".format(mod, w))
    print("已生成 {} 个模块".format(len(LAYER)))
    return 0


BUILTINS = set(dir(builtins)) | {"__name__", "__file__", "const", "self"}

# 各模块需要的外部符号（按用到才写，贴近上游风格）
# 只列单文件版里**顶层** import 的那些。bluetooth/machine/camera/image
# 在原代码里是函数内惰性 import，会随源码块一起被抽走，别在这儿重复加
# ——桩件环境没有它们，顶层 import 会直接炸。
STDLIB = ["time", "struct", "math", "gc", "ubinascii", "ujson",
          "usocket", "uos", "network"]
M5NAMES = ("Widgets", "Lcd", "Mic", "Speaker", "Power", "Imu", "Touch", "Rgb", "BLE")
HWNAMES = ("Mic", "Speaker", "Power")

DOC = {
 "cfg": "全局配置、回退开关与运行状态。\n\n本模块不 import 任何其他 kagura 模块，是依赖图的最底层。\n运行时可变量（SERVER_* / MQTT_BROKER / *_THRESHOLD）必须用 cfg.X 访问，\n写 `from cfg import X` 拿到的是值拷贝，改了看不到且不报错。",
 "hw": "硬件封装：LED / 看门狗 / 麦克风 / 音量 / RMS / 触摸 / 绘图原语。\n\n触摸检测带 feel 参数——主循环传 True 时才做抚摸轨迹判定，\n取景/配网这些地方要的是纯按钮，别让手滑变成抚摸把点击吞掉。",
 "clock": "RTC 同步与读取。单独成模块是为了打断 ui ↔ netsvc 的环。",
 "ui": "屏幕显示：字体、环形可视化、离屏画布合成、息屏唤醒。\n\ndraw_state 整屏背景图 + 透明文字，**不要再加实心条带**——\n分层重绘垫黑底那版被否过（照片被上下黑边夹住）。",
 "wifisetup": "屏上 WiFi 配网：SSID 扫描选择 + 软键盘输入 + 凭据落盘。",
 "audio": "音频：录音 VAD、播放、包络计算、开机噪声校准。",
 "cam": "摄像头：抓帧、预览、取景模式、拍照上传。\n\n模块名是 cam 不是 camera——MicroPython 的摄像头驱动就叫 camera，\n同名会让本模块 import 到自己。",
 "feel": "触觉三层：反射（本地即时换表情）/ 体感（聚合成 X-Touch 随对话捎走）/\n惊动（显著接触才让 agent 主动开口，带冷却）。",
 "diag": "远程诊断与网络自愈：事件环形日志、崩溃上报、心跳遥测、分级自救。\n\nmqtt_ok 由 netsvc 写入（netsvc → diag 单向依赖，避免成环）。",
 "netsvc": "网络服务：MQTT 推送/命令、BLE 在家感知、UDP 服务端发现。",
 "stream": "摄像头直播推流（TCP :5002）与直播中插拍。",
 "chat": "对话主流程：录音→上传→播放、模式切换、IMU 摇晃彩蛋与本体感觉。",
 "app": "启动与主循环。",
}


def _code_only(text):
    """去掉注释和字符串字面量后再判断"用到了哪些符号"。

    朴素子串匹配会被 STATE_UI 里的 "Touch to talk" 骗到，给 cfg 塞进一个
    无谓的 from M5 import *——而 cfg 是开机第一个被 import 的叶子模块，
    不该背任何硬件依赖。
    """
    import re
    t = re.sub(r'"""[\s\S]*?"""', "", text)
    t = re.sub(r"\'\'\'[\s\S]*?\'\'\'", "", t)
    t = re.sub(r'"(?:[^"\\\n]|\\.)*"', '""', t)
    t = re.sub(r"'(?:[^'\\\n]|\\.)*'", "''", t)
    t = re.sub(r"#[^\n]*", "", t)
    return t


def header(mod, text):
    """按实际用到的符号生成模块头。"""
    out = ['"""Kagura Voice 设备端 —— {}\n"""'.format(DOC[mod]), ""]
    code = _code_only(text)
    if "M5." in code:
        out.append("import M5")
    # 用词边界而不是子串：BLE_PHONE_NAME 里的 BLE、TOUCH_FEEL 里的 TOUCH
    # 都会让子串匹配误判，给叶子模块塞进无谓的硬件 import。
    import re as _re
    used = lambda names: any(_re.search(r"\b" + n + r"\b", code) for n in names)
    if used(M5NAMES):
        out.append("from M5 import *")
    if used(HWNAMES):
        out.append("from hardware import *")
    for m in STDLIB:
        if m + "." in code:
            out.append("import " + ("array as uarray" if m == "uarray" else m))
    if "uarray." in code:
        out.append("import array as uarray")
    if "urequests." in code:
        out.append("import requests as urequests")
    deps = sorted({ASSIGN[n] for n in ASSIGN
                   if ASSIGN[n] != mod and (ASSIGN[n] + "." + n) in code},
                  key=LAYER.index)
    if deps:
        out.append("")
        for d in deps:
            out.append("import " + d)
    return "\n".join(out) + "\n"


def bound_names(node):
    """一个函数/类作用域里绑定的所有名字（过度近似：深度收集）。"""
    out = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            out.add(n.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(n.name)
        elif isinstance(n, ast.arg):
            out.add(n.arg)
        elif isinstance(n, ast.Global):
            out.update(n.names)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for al in n.names:
                out.add(al.asname or al.name.split(".")[0])
        elif isinstance(n, ast.ExceptHandler) and n.name:
            out.add(n.name)
    return out


def rewrite(mod, text):
    """把跨模块的裸引用改写成 mod.attr，返回 (新文本, 警告列表)。"""
    tree = ast.parse(text)
    warns = []
    top = {n.name for n in tree.body
           if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
    for n in tree.body:
        if isinstance(n, ast.Assign):
            top |= {t.id for t in n.targets if isinstance(t, ast.Name)}
        elif isinstance(n, (ast.For, ast.Try)):
            top |= bound_names(n)

    edits = []

    def scan(node, local):
        for ch in ast.walk(node):
            if isinstance(ch, ast.Global):
                for g in ch.names:
                    if g in ASSIGN and ASSIGN[g] != mod:
                        warns.append("global {} 属于 {} 模块，需改成 {}.{} = ..."
                                     .format(g, ASSIGN[g], ASSIGN[g], g))
            if isinstance(ch, ast.Name) and isinstance(ch.ctx, ast.Load):
                nm = ch.id
                if nm in local or nm in top or nm in BUILTINS:
                    continue
                owner = ASSIGN.get(nm)
                if owner and owner != mod:
                    edits.append((ch.lineno, ch.col_offset,
                                  ch.col_offset + len(nm), owner + "." + nm))

    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
            scan(n, bound_names(n))
        else:
            scan(n, set())

    L = text.split("\n")
    for ln, c0, c1, new in sorted(edits, key=lambda e: (-e[0], -e[1])):
        s = L[ln - 1]
        L[ln - 1] = s[:c0] + new + s[c1:]
    return "\n".join(L), warns


if __name__ == "__main__":
    sys.exit(main())
