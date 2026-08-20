"""Kagura Voice 设备端 —— 摄像头直播推流（TCP :5002）与直播中插拍。
"""

import time
import gc
import usocket

import cfg
import hw
import ui
import cam
import diag
import netsvc

_stream_deadline = 0     # 直播截止时间戳，收到 stream_start 就往后推


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
    while netsvc._pending_cmd:
        c = netsvc._pending_cmd.pop(0)
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
        netsvc._pending_cmd.append(c)
    return stop, capture


def _stream_hires_capture(cmd, switched):
    """直播中插拍一张高清照：临时切回 QVGA 拍一张上传，再切回直播分辨率。

    直播画面会停几秒（切分辨率 ×2 + 曝光收敛 + 205KB 上传）。用停顿换清晰度：
    直播帧只有 160×120，给 AI 识别太糊。switched=False 说明本来就是全分辨率，
    不用来回切，直接拍。
    """
    rid = cmd.get("request_id", "")
    print("stream: hi-res capture", rid)
    diag.dbg("stream hires")
    ui.draw_state("camera")
    try:
        if switched:
            cam._cam_set_framesize(False)          # 切回 QVGA
            for _ in range(cfg.STREAM_SETTLE_FRAMES):
                cam._cam_grab()
                hw._wdt_feed()
        image_b64 = cam.capture_photo()
        hw._wdt_feed()
        ui.draw_state("processing")
        cam._upload_photo(rid, image_b64)
        hw._wdt_feed()
    except Exception as e:
        print("stream hires capture err:", e)
    finally:
        if switched:
            cam._cam_set_framesize(True)           # 回到直播分辨率
            for _ in range(cfg.STREAM_SETTLE_FRAMES):
                cam._cam_grab()
                hw._wdt_feed()
        gc.collect()
        ui.draw_state("streaming")


def _run_stream_cmd(cmd):
    """执行直播命令（主循环调用），一直推到超时/收到停止/出错为止。"""
    global _stream_deadline
    if not cfg.STREAM_ENABLED:
        print("stream: disabled by switch")
        return
    if not cam._camera_ensure():
        print("stream: camera unavailable")
        return

    if cfg.St.sleeping:
        ui.wake_up()
    cfg.St.busy = True
    cfg.St.streaming = True
    cfg.St.last_activity = time.time()

    now = time.time()
    _stream_deadline = now + cmd.get("secs", 45)
    hard_stop = now + cfg.STREAM_MAX_SECS
    port = cmd.get("port", cfg.STREAM_PORT)

    switched = cam._cam_set_framesize(True) if cfg.STREAM_QQVGA else False
    if switched:
        # 换完分辨率后自动曝光/白平衡要重新收敛，先丢几帧再开播，
        # 否则开头几秒画面忽明忽暗。capture_photo() 里的 sleep(0.3) 同理。
        for _ in range(cfg.STREAM_SETTLE_FRAMES):
            cam._cam_grab()
            hw._wdt_feed()
    sock = None
    frames = 0
    try:
        ui.draw_state("streaming")
        sock = usocket.socket(usocket.AF_INET, usocket.SOCK_STREAM)
        sock.settimeout(10)
        try:
            # 发现流程里 MQTT_BROKER 就是服务端 IP
            sock.connect((cfg.MQTT_BROKER, port))
        except OSError as e:
            # 单独捕获连接失败：这一步超时几乎都是"端口没通"，而不是流本身的问题。
            # 服务端在 WSL 里时，Windows 侧要给这个端口加 portproxy + 防火墙，
            # 见 openclaw-startup.ps1 的 $StreamPort。
            print("stream: cannot connect to {}:{} ({}) —"
                  " server not listening, or port not forwarded".format(
                      cfg.MQTT_BROKER, port, e))
            diag.dbg("stream connect fail :{}".format(port))
            return
        hello = "KAGURA_STREAM v1 {} {}\n".format(cfg.DEVICE_ID, cfg.STREAM_TOKEN)
        if not _sock_write_all(sock, hello.encode("utf-8")):
            print("stream: handshake failed")
            return
        diag.dbg("stream start")
        print("stream: connected", cfg.MQTT_BROKER, port)

        while True:
            hw._wdt_feed()
            now = time.time()
            if now >= _stream_deadline or now >= hard_stop:
                print("stream: deadline reached")
                break

            frame = cam._cam_grab()
            if frame is None:
                time.sleep(0.2)              # 抓帧失败别空转
            else:
                raw = cam._cam_bytes(frame)
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
                    if frames % cfg.CAM_GC_EVERY == 0:
                        gc.collect()

            # 直播可能持续几分钟，不喂 MQTT 会被 keepalive(60s) 判掉线
            netsvc.mqtt_check()
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
            if netsvc._pending_push:
                netsvc._play_push(netsvc._pending_push.pop(0))
                ui.draw_state("streaming")   # _play_push 收尾会切 idle，切回来
                hw._wdt_feed()

            touch, _pos = hw.check_touch()
            if touch == 'long':
                print("stream: stopped by touch")
                break
    except OSError as e:
        print("stream error:", e)
        diag.dbg("stream err")
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
            cam._cam_set_framesize(False)        # 还原 QVGA，别影响之后的拍照识别
        gc.collect()
        cfg.St.streaming = False
        cfg.St.busy = False
        cfg.St.last_activity = time.time()
        ui.draw_state("idle")
        hw.drain_touch()
        print("stream: ended, frames =", frames)
