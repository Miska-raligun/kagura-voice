"""网络服务：MQTT 推送/命令、BLE 在家感知、UDP 服务端发现。

MQTT 回调只入队，耗时操作（下载播放/拍照上传）在主循环
process_mqtt_queue() 里消费——否则长播放会阻塞心跳导致断连。
"""

import time
import ujson
import usocket
import requests as urequests

import cfg
import hw
import ui
import audio
import clock

# ── BLE 状态 ──────────────────────────────────────────────────
_ble = None
_ble_phone_found = False    # 本次扫描是否找到目标手机
_ble_last_scan   = 0        # 上次扫描时间
_ble_last_seen   = 0        # 上次检测到手机的时间
_ble_seen_count  = 0        # 连续检测到的次数
_user_home       = False    # 当前在家状态
_ble_status_sent = None     # 上次发送给服务端的状态（避免重复发送）

_mqtt_last_ping = 0         # 上次 MQTT ping 时间


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
        if cfg.St.busy:
            # 保留去重语义：对话期间 OpenClaw 触发的重复 push 直接丢弃
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
    if cfg.St.sleeping:
        ui.wake_up()
    cfg.St.last_activity = time.time()
    ui.draw_state("broadcast")
    try:
        resp = urequests.get(cfg.SERVER_BASE + url, timeout=cfg.REQUEST_TIMEOUT_SHORT)
        if resp.status_code == 200:
            audio.play_wav(resp.content)
        resp.close()
    except OSError as e:
        print("push download err:", e)
    ui.draw_state("idle")
    hw._set_led(0, 0, 0)


def _run_capture_cmd(cmd):
    """执行远程拍照命令（主循环调用）。"""
    if cfg.St.sleeping:
        ui.wake_up()
    cfg.St.last_activity = time.time()
    cfg.St.busy = True
    try:
        ui.draw_state("camera")
        image_b64 = hw.capture_photo()
        ui.draw_state("processing")
        payload = ujson.dumps({
            "request_id": cmd.get("request_id", ""),
            "image": image_b64 or "",
            "device_id": cfg.DEVICE_ID,
        })
        try:
            resp = urequests.post(
                cfg.UPLOAD_URL,
                data=payload.encode("utf-8"),
                headers={"Content-Type": "application/json"},
                timeout=cfg.REQUEST_TIMEOUT_UPLOAD,
            )
            resp.close()
        except OSError as e:
            print("upload err:", e)
    finally:
        ui.draw_state("idle")
        cfg.St.busy = False


def process_mqtt_queue():
    """主循环调用：每 tick 最多消费一项，空闲时才执行。"""
    if cfg.St.busy:
        return
    if _pending_push:
        _play_push(_pending_push.pop(0))
    elif _pending_cmd:
        cmd = _pending_cmd.pop(0)
        if cmd.get("action") == "capture":
            _run_capture_cmd(cmd)


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
            "kagura/push/{}".format(cfg.DEVICE_ID),
            "kagura/cmd/{}".format(cfg.DEVICE_ID),
        ]
        client = MQTTClient(cfg.DEVICE_ID, cfg.MQTT_BROKER, port=1883, keepalive=60)
        client.set_callback(_mqtt_callback)
        client.connect(clean_session=False)
        for t in _MQTT_TOPICS:
            client.subscribe(t, 1)
        _mqtt = client
        print("MQTT connected:", cfg.MQTT_BROKER)
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
        print("BLE: disabled (cfg.BLE_PHONE_NAME is empty)")
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

# ── UDP 自动发现服务端 ────────────────────────────────────────

def discover_server():
    """
    广播 KAGURA_DISCOVER，从回包源地址更新 cfg.SERVER_BASE 等全局变量。
    失败则保留硬编码 fallback 地址（最多等待 6 秒）。
    """

    ui.draw_state("discovering")

    sock = usocket.socket(usocket.AF_INET, usocket.SOCK_DGRAM)
    try:
        try:
            sock.setsockopt(usocket.SOL_SOCKET, usocket.SO_BROADCAST, 1)
        except Exception:
            pass   # 部分固件无此常量，ESP32 lwIP 默认允许广播

        sock.settimeout(cfg.DISC_TIMEOUT)

        for attempt in range(1, cfg.DISC_RETRIES + 1):
            print("discovery attempt", attempt)
            try:
                sock.sendto(cfg.DISC_MSG, ("255.255.255.255", cfg.DISC_PORT))
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
