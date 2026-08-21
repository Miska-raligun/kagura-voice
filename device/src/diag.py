"""Kagura Voice 设备端 —— 远程诊断与网络自愈：事件环形日志、崩溃上报、心跳遥测、分级自救。

mqtt_ok 由 netsvc 写入（netsvc → diag 单向依赖，避免成环）。
"""

import M5
from M5 import *
from hardware import *
import time
import gc
import ujson
import uos
import requests as urequests

import cfg
import clock
import ui
import wifisetup

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
    ts = clock.get_rtc_time_str() or "--:--"
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
            if uos.stat(cfg.data("crash.log"))[6] > 24576:
                return
        except OSError:
            pass
        lines = _dbg_buf[_dbg_persisted:]
        with open(cfg.data("crash.log"), "a") as f:
            f.write("=== netlog ({}) ===\n".format(reason))
            for l in lines:
                f.write(l + "\n")
        _dbg_persisted = len(_dbg_buf)
    except Exception:
        pass


def _wifi_ok():
    try:
        return wifisetup._wlan is not None and wifisetup._wlan.isconnected()
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
    if now - _net_last_check < cfg._NET_CHECK_IVL:
        return
    _net_last_check = now

    wifi_ok = _wifi_ok()
    if wifi_ok != _wifi_was_ok:
        dbg("wifi restored" if wifi_ok else "wifi LOST")
        _wifi_was_ok = wifi_ok

    if not wifi_ok and now - _wifi_reconnect_last >= 30:
        _wifi_reconnect_last = now
        saved = wifisetup._wifi_load()
        if saved and saved.get("ssid"):
            dbg("wifi reconnect -> {}".format(saved["ssid"]))
            try:
                wlan = wifisetup._wlan_if()
                try:
                    wlan.disconnect()
                except Exception:
                    pass
                # 非阻塞发起连接，结果由下轮自检确认
                if saved.get("password"):
                    wlan.connect(saved["ssid"], saved["password"])
                else:
                    wlan.connect(saved["ssid"])
            except Exception as e:
                dbg("wifi reconnect err: {}".format(e))

    dot = "r" if not wifi_ok else ("g" if _mqtt_ok else "y")
    if dot != _net_dot and not cfg.St.sleeping:
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
    #
    # 判据只看 dead_for（多久没成功联系上服务端），**不看 wifi_ok / _mqtt_ok**。
    # LRN 8/21：曾经加了 `(not wifi_ok or not _mqtt_ok)` 这道前置条件，结果
    # 8/21 13:31 那次失联 79 分钟自愈一次都没触发——因为 WiFi 驱动 wedge 的
    # 典型表现就是 isconnected() 仍返回 True、MQTT socket 对象也还在，
    # 设备自认为健康，可包一个都出不去。**"看起来好不好"不可信，
    # "服务端还认不认得我"才是唯一可信的判据。**
    global _net_fix_stage
    dead_for = now - _last_server_ok
    if not cfg.St.busy:
        if _net_fix_stage == 0 and dead_for > cfg._NET_FIX1_SECS:
            _net_fix_stage = 1
            dbg("netfix1 wifi-stack-reinit dead={}s".format(int(dead_for)))
            _persist_dbg("netfix1")
            try:
                wlan = wifisetup._wlan_if()
                wlan.active(False)
                time.sleep(1)
                wlan.active(True)
                saved = wifisetup._wifi_load()
                if saved and saved.get("ssid"):
                    if saved.get("password"):
                        wlan.connect(saved["ssid"], saved["password"])
                    else:
                        wlan.connect(saved["ssid"])
            except Exception as e:
                dbg("netfix1 err: {}".format(e))
        elif _net_fix_stage == 1 and dead_for > cfg._NET_FIX2_SECS \
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
    if now - _hb_last < cfg._HB_INTERVAL or cfg.St.busy or not _wifi_ok():
        return
    _hb_last = now
    payload = {
        "device_id": cfg.DEVICE_ID,
        "up": time.ticks_diff(time.ticks_ms(), _boot_ticks) // 1000,
        "heap": gc.mem_free(),
        "mqtt": _mqtt_ok,
        "sleeping": cfg.St.sleeping,
    }
    try:
        payload["rssi"] = wifisetup._wlan.status("rssi")
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
            cfg.SERVER_BASE + "/heartbeat",
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
            if not clock._rtc_synced:
                clock.sync_rtc()   # 开机时网络未就绪的话，恢复后补同步时间
    except Exception as e:
        print("hb fail:", e)   # 不进 dbg，避免失联期间刷满缓冲


def canvas_probe():
    """开机跑一次画布能力探测。异常一律吞掉，绝不能拖累正常启动。"""
    if not cfg.CANVAS_PROBE:
        return
    try:
        _canvas_probe()
    except Exception as e:
        dbg("cv: probe crashed {}".format(e))
    finally:
        # 探测直接铺过屏，必须作废缓存键，否则下次 draw_state 判定"没变"跳过重绘
        ui._ui_invalidate()


def _canvas_probe():
    has = hasattr(Lcd, "newCanvas")
    dbg("cv: newCanvas={}".format(has))
    if not has:
        return
    try:
        img = open(cfg.res("img_bg.jpg"), "rb").read()
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
            cv, form = ui._mk_canvas(320, 240, psram)
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
        bar, _form = ui._mk_canvas(320, 26, False)
        if hasattr(bar, "drawString"):
            for setter, arg in (("setFont", ui._FONT_16), ("setTextColor", 0xffffff)):
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


def _boot_report():
    """开机上报服务端：携带上次崩溃日志（如有），成功后删除本地日志。

    作用：1) 服务端能记录设备每次重启的时间点；2) 崩溃堆栈自动送达
    服务端 crash_reports/，无需 USB 连接取证。失败静默，不阻塞启动。
    """
    log = ""
    try:
        with open(cfg.data("crash.log"), "r") as f:
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
            cfg.SERVER_BASE + "/crash-report",
            data=ujson.dumps({"device_id": cfg.DEVICE_ID, "log": log,
                              "reset_cause": cause}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            timeout=cfg.REQUEST_TIMEOUT_SHORT,
        )
        ok = resp.status_code == 200
        resp.close()
        if ok and log:
            uos.remove(cfg.data("crash.log"))
            print("crash log uploaded")
    except Exception as e:
        print("boot report failed:", e)


def _log_crash(e):
    """崩溃现场写入 /flash/crash.log，供重启后排查死因。"""
    try:
        import sys, io
        try:
            if uos.stat(cfg.data("crash.log"))[6] > 32768:
                return   # 上限 32KB：反复崩溃复位时避免写穿 flash
        except OSError:
            pass
        buf = io.StringIO()
        sys.print_exception(e, buf)
        with open(cfg.data("crash.log"), "a") as f:
            f.write("=== crash @ {} uptime={}s ===\n{}\n".format(
                clock.get_rtc_time_str() or "?", int(time.time()), buf.getvalue()))
    except Exception:
        pass
