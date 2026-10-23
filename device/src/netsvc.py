"""Kagura Voice 设备端 —— 网络服务：MQTT 推送/命令、BLE 在家感知、UDP 服务端发现。
"""

from M5 import *
import time
import ujson
import usocket
import requests as urequests

import cfg
import hw
import ui
import snd
import cam
import diag
import ota

# ── 回调注入：打断 netsvc ↔ stream 的环 ───────────────────────
# MQTT 收到 stream_start 要交给 stream 跑推流，而推流循环又要回来消费
# MQTT 命令队列。由 app.setup() 注入：
#     netsvc.set_stream_runner(stream._run_stream_cmd)
_stream_runner = None


def set_stream_runner(fn):
    global _stream_runner
    _stream_runner = fn

_mqtt_last_ping  = 0         # 上次 MQTT ping 时间


_ble = None


_ble_phone_found  = False    # 本次扫描是否找到目标手机


_ble_last_scan    = 0        # 上次扫描时间


_ble_last_seen    = 0        # 上次检测到手机的时间


_ble_seen_count   = 0        # 连续检测到的次数


_user_home        = False    # 当前在家状态


_ble_status_sent  = None     # 上次发送给服务端的状态（避免重复发送）


# ── MQTT 推送订阅 ─────────────────────────────────────────────
#
# 回调只解析+入队（毫秒级返回），下载/播放/拍照在主循环消费。
# 好处：长任务不再阻塞 MQTT 心跳（之前 30s+ 播放会触发 keepalive 超时断连）。

_mqtt = None


_MQTT_TOPICS = []


_pending_push = []   # 待播放的 push：(url, role)，role=None 表示用设备当前角色


_pending_cmd  = []   # 待执行的远程命令 dict


_role_redraw  = False  # MQTT 换了角色、还没重画


_role_gen = 0  # 每收到一次 role 命令 +1：push 临时换图播完后，据此判断要不要换回去


def _mqtt_callback(topic, msg):
    """MQTT 消息回调：只入队，不做任何耗时操作。"""
    global _role_redraw, _role_gen
    topic_str = topic.decode("utf-8") if isinstance(topic, bytes) else topic

    if "/push/" in topic_str:
        if cfg.St.busy and not cfg.St.streaming:
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
            # role：说这句话的角色（服务端按 agent 找）。和当前角色不同就临时换图播
            _pending_push.append((url, info.get("role")))

    elif "/cmd/" in topic_str:
        try:
            cmd = ujson.loads(msg)
        except Exception as e:
            print("[mqtt] cmd parse error:", e)
            return
        if cmd.get("action") == "role":
            _role_gen += 1
            # 就地换角色：只改一个变量、作废重绘缓存，不碰屏幕不碰网络，回调里做得起。
            # 不入队——队列里 push 优先，网页切角色后紧跟的问候会先用旧图播出来
            if ui.set_role(cmd.get("role", "")):
                _role_redraw = True      # 空闲时由 process_mqtt_queue 重画（主循环不会自己画）
            return
        _pending_cmd.append(cmd)


def _play_push(item):
    """下载并播放一条 push 音频（主循环调用）。

    item = (url, role)。role 和设备当前角色不同时，播放期间临时显示那个角色的图，
    播完换回去——一台设备多个角色共用时，谁说话就显示谁，不会「声音是 A、脸是 B」。
    播放中途收到了 role 命令（_role_gen 变了）就不换回，以命令为准。
    """
    url, role = item if isinstance(item, tuple) else (item, None)
    prev, gen = cfg.St.role, _role_gen
    temp = role is not None and role != prev
    if temp:
        ui.set_role(role)
    try:
        _play_push_url(url)
    finally:
        if temp and _role_gen == gen:
            ui.set_role(prev)
        ui.draw_state("idle")    # 先换回角色再画，免得多画一屏临时角色的待机图
        hw._set_led(0, 0, 0)


def _play_push_url(url):
    if cfg.St.sleeping:
        ui.wake_up()
    cfg.St.last_activity = time.time()
    diag.dbg("push recv")
    ui.draw_state("broadcast")
    try:
        resp = urequests.get(cfg.SERVER_BASE + url, timeout=cfg.REQUEST_TIMEOUT_SHORT)
        if resp.status_code == 200:
            _play_streamed(resp)
            resp.close()
        else:
            resp.close()
    except OSError as e:
        print("push download err:", e)


def _play_streamed(resp):
    """边下边播一条 push 音频。长音频前后各留一条持久化面包屑。

    这两条是给下一次「播到一半黑屏」准备的证据：重启后 crash.log 里
    只有 `play` 没有 `played` = 死在播放中。大小按 Content-Length 判断
    （边下边播时没有"下载完的字节数"可看）；只给大音频写 flash，
    短播报不值得为它磨损闪存。
    """
    try:
        size = int(resp.headers.get("Content-Length", 0) or 0)
    except (ValueError, TypeError, AttributeError):
        size = 0
    big = size >= cfg.PLAY_BIG_BYTES
    if big:
        diag.dbg("play {}KB".format(size >> 10))
        diag._persist_dbg("play-big")
    n = snd.stream_play(resp)
    diag.dbg(snd.stream_summary())
    if n <= 0:
        diag.dbg("push play failed")
    if big:
        diag._persist_dbg("play-big-done")


def _run_capture_cmd(cmd):
    """执行远程拍照命令（主循环调用）。"""
    if cfg.St.sleeping:
        ui.wake_up()
    cfg.St.last_activity = time.time()
    cfg.St.busy = True
    try:
        ui.draw_state("camera")
        image_b64 = cam.capture_photo()
        ui.draw_state("processing")
        cam._upload_photo(cmd.get("request_id", ""), image_b64)
    finally:
        ui.draw_state("idle")
        cfg.St.busy = False


def process_mqtt_queue():
    """主循环调用：每 tick 最多消费一项，空闲时才执行。"""
    global _role_redraw
    if cfg.St.busy:
        return
    if _role_redraw:
        _role_redraw = False
        if not _pending_push:            # 有 push 的话它自己会画（broadcast 态）
            ui.draw_state("idle")
    if _pending_push:
        _play_push(_pending_push.pop(0))
    elif _pending_cmd:
        cmd = _pending_cmd.pop(0)
        action = cmd.get("action")
        if action == "capture":
            _run_capture_cmd(cmd)
        elif action == "stream_start":
            if _stream_runner:
                _stream_runner(cmd)
        elif action == "sync":
            ota.run_sync(cmd.get("scope", "res"))   # 管理界面传了图 / 点了「更新设备代码」


        # stream_stop：不在直播中收到就没有意义，丢弃即可
        #（直播中的续期/停止由 _stream_drain_cmds 自己消费）


def _reconnect_mqtt():
    """重连 MQTT 并重新订阅所有 topic。"""
    global _mqtt
    try:
        _mqtt.connect(clean_session=False)
        for t in _MQTT_TOPICS:
            _mqtt.subscribe(t, 1)
        diag._mqtt_ok = True
        diag.dbg("mqtt reconnected")
    except Exception as e:
        diag._mqtt_ok = False
        print("MQTT reconnect failed:", e)


def init_mqtt():
    """连接 MQTT broker 并订阅推送 topic。"""
    global _mqtt, _MQTT_TOPICS
    try:
        from umqtt.simple import MQTTClient
        _MQTT_TOPICS = [
            "kagura/push/{}".format(cfg.DEVICE_ID),
            "kagura/cmd/{}".format(cfg.DEVICE_ID),
        ]
        client = MQTTClient(cfg.DEVICE_ID, cfg.MQTT_BROKER, port=1883, keepalive=60)
        client.set_callback(_mqtt_callback)
        client.connect(clean_session=False)
        for t in _MQTT_TOPICS:
            client.subscribe(t, 1)
        _mqtt = client
        diag._mqtt_ok = True
        print("MQTT connected:", cfg.MQTT_BROKER)
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
        if diag._wifi_ok() and now - _mqtt_init_last >= 60:
            _mqtt_init_last = now
            init_mqtt()
            if _mqtt:
                diag.dbg("mqtt late-init ok")
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
            # LRN 2026-08-25：这里原来写的是 `global _mqtt_ok` + `if _mqtt_ok`，
            # 但本模块根本没有这个名字（状态在 diag 里，模块头注释也这么写的）。
            # 于是**任何一次 MQTT 掉线都被翻译成 NameError 逃出 mqtt_check**，
            # 主循环连吃 10 次 → loop-error-storm → machine.reset()。
            # 症状就是「毫无征兆黑屏重启」，crash_reports 里 4 份日志全是它。
            # 别再引入模块级 _mqtt_ok：一份状态只能有一个家。
            if diag._mqtt_ok:
                diag._mqtt_ok = False
                diag.dbg("mqtt disconnected: {}".format(e))
            now = time.time()
            if now - _mqtt_last_reconnect >= 5:
                _mqtt_last_reconnect = now
                _reconnect_mqtt()
                _mqtt_last_ping = time.time()


def fetch_role():
    """开机问服务端当前角色（角色状态落在服务端，设备重启不丢）。失败就用默认图。"""
    try:
        resp = urequests.get(cfg.SERVER_BASE + "/role?device_id=" + cfg.DEVICE_ID,
                             timeout=cfg.REQUEST_TIMEOUT_SHORT)
        if resp.status_code == 200:
            info = resp.json()
            ui.role_count = len(info.get("roles", []))
            ui.set_role(info.get("role", ""))
        resp.close()
    except Exception as e:
        print("fetch role err:", e)


def mqtt_ping():
    """立刻补一次 MQTT ping。长阻塞（/chat 最多等 REQUEST_TIMEOUT_CHAT）前调用：
    阻塞期间主循环不转、发不了保活包，先把计时清零，免得等回复时被 broker 踢掉。"""
    global _mqtt_last_ping
    if _mqtt:
        try:
            _mqtt.ping()
            _mqtt_last_ping = time.time()
        except OSError:
            pass          # 掉线交给 mqtt_check 的重连逻辑，这里不抢


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
        if rssi < cfg.BLE_RSSI_THRESHOLD:
            return
        raw = bytes(adv_data)
        # 优先：设备名称匹配（部分 Android 等会广播名称）
        name = _decode_ble_name(raw)
        if name and cfg.BLE_PHONE_NAME and cfg.BLE_PHONE_NAME in name:
            _ble_phone_found = True
            return
        # Fallback：iPhone 不广播名称，检测 Apple 厂商 ID
        if _is_apple_device(raw):
            _ble_phone_found = True


def init_ble():
    """初始化 BLE 扫描器（仅当配置了手机名称时启用）。"""
    global _ble
    if not cfg.BLE_PHONE_NAME:
        print("BLE: disabled (BLE_PHONE_NAME is empty)")
        return
    try:
        import bluetooth
        _ble = bluetooth.BLE()
        _ble.active(True)
        _ble.irq(_ble_irq)
        print("BLE: initialized, target name:", cfg.BLE_PHONE_NAME)
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
    if now - _ble_last_scan < cfg.BLE_SCAN_INTERVAL:
        return

    _ble_last_scan = now
    _ble_phone_found = False

    try:
        # active scan 以获取 Scan Response 中的设备名称
        _ble.gap_scan(cfg.BLE_SCAN_DURATION, 100000, 50000, True)
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
    if not _user_home and _ble_seen_count >= cfg.BLE_HOME_COUNT:
        _user_home = True
        print("BLE: 在家 (detected {} times)".format(_ble_seen_count))
    elif _user_home and _ble_last_seen > 0 and (now - _ble_last_seen > cfg.BLE_AWAY_TIMEOUT):
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
        url = cfg.SERVER_BASE + "/presence"
        payload = ujson.dumps({"device_id": cfg.DEVICE_ID, "status": status})
        resp = urequests.post(url, data=payload.encode("utf-8"),
                              headers={"Content-Type": "application/json"},
                              timeout=cfg.REQUEST_TIMEOUT_SHORT)
        print("BLE presence →", status, ":", resp.status_code)
        resp.close()
    except Exception as e:
        print("BLE presence notify error:", e)


def discover_server():
    """
    广播 KAGURA_DISCOVER，从回包源地址更新 SERVER_BASE 等全局变量。
    失败则保留硬编码 fallback 地址（最多等待 6 秒）。
    """
    # 这五个是 cfg 的可变量，必须 cfg.X = ... 才能让其他模块看到

    ui.draw_state("discovering")

    sock = usocket.socket(usocket.AF_INET, usocket.SOCK_DGRAM)
    try:
        try:
            sock.setsockopt(usocket.SOL_SOCKET, usocket.SO_BROADCAST, 1)
        except Exception:
            pass   # 部分固件无此常量，ESP32 lwIP 默认允许广播

        sock.settimeout(cfg._DISC_TIMEOUT)

        for attempt in range(1, cfg._DISC_RETRIES + 1):
            print("discovery attempt", attempt)
            try:
                sock.sendto(cfg._DISC_MSG, ("255.255.255.255", cfg._DISC_PORT))
                data, addr = sock.recvfrom(32)
                if data.strip() == b"KAGURA_HERE":
                    ip = addr[0]
                    cfg.SERVER_BASE = "http://{}:5000".format(ip)
                    cfg.SERVER_URL  = cfg.SERVER_BASE + "/chat"
                    cfg.VISION_URL  = cfg.SERVER_BASE + "/chat-vision"
                    cfg.UPLOAD_URL  = cfg.SERVER_BASE + "/upload-photo"
                    cfg.MQTT_BROKER = ip
                    print("discovered:", cfg.SERVER_BASE)
                    return True
            except OSError:
                pass   # timeout，继续下一次

        print("discovery failed, fallback:", cfg.SERVER_BASE)
        return False
    finally:
        sock.close()
