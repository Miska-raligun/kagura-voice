"""Kagura Voice 设备端 —— 摄像头：抓帧、预览、取景模式、拍照上传。

模块名是 cam 不是 camera——MicroPython 的摄像头驱动就叫 camera，
同名会让本模块 import 到自己。
"""

from M5 import *
import time
import gc
import ubinascii
import ujson
import requests as urequests

import cfg
import hw
import clock
import ui
import snd
import diag

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
        if cfg.CAMERA_QVGA and hasattr(camera, "QVGA") and hasattr(camera, "RGB565"):
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
    n = w * h if cfg.PREVIEW_LEN_IN_PIXELS else w * h * 2
    if _cam_draw_mode in (None, "raw"):
        try:
            Lcd.drawRawBuf(raw, x, y, w, h, n, cfg.PREVIEW_SWAP)
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


_CAM_PREVIEW_H = cfg.CAM_BAR_Y if cfg.CAM_PREVIEW_CLIP else 240


_CAM_ENTRY = (106, 0, 152, 34)  # 待机顶栏 "CAM" 键的命中区（与 ui 顶栏坐标同步）


_CAM_BTN_L = (0,   cfg.CAM_BAR_Y, 158, 239)


_CAM_BTN_R = (161, cfg.CAM_BAR_Y, 319, 239)


_cam_touch_evt = (None, (0, 0))


def _cam_poll_touch():
    """采样一次触摸并锁存首个事件。

    取景循环一帧要 ~100ms（抓帧+刷屏），每帧只采一次会漏掉 100ms 级的
    快速点按——按了没反应。故一帧内多采几次，事件锁存到被取走为止。
    """
    global _cam_touch_evt
    t, p = hw.check_touch()
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
    Lcd.setFont(ui._FONT_16)
    Lcd.setTextSize(1)
    for rect, label, bg in ((_CAM_BTN_L, left, l_bg), (_CAM_BTN_R, right, r_bg)):
        hw._fill_rect(rect[0], rect[1], rect[2] - rect[0] + 1, rect[3] - rect[1] + 1, bg)
        Lcd.setTextColor(0xffffff, bg)
        tx = rect[0] + ((rect[2] - rect[0]) - len(label) * 10) // 2
        Lcd.drawString(label, tx, rect[1] + 12)


def _cam_send(raw):
    """把确认后的帧交给神乐：POST /chat-vision（不带 wav，服务端用默认提问）。"""
    ui.draw_state("processing")
    b64 = ubinascii.b2a_base64(raw).decode("utf-8").replace("\n", "").replace("\r", "")
    gc.collect()
    payload = ujson.dumps({"image": b64})
    del b64
    gc.collect()
    try:
        hdrs = {"X-Device-Id": cfg.DEVICE_ID, "Content-Type": "application/json"}
        lt = clock.get_local_time_header()
        if lt:
            hdrs["X-Local-Time"] = lt
        resp = urequests.post(cfg.VISION_URL, data=payload.encode("utf-8"),
                              headers=hdrs, timeout=cfg.REQUEST_TIMEOUT_CHAT)
        if resp.status_code != 200:
            print("cam send err:", resp.status_code)
            resp.close()
            ui.draw_state("error")
            time.sleep(2)
            return
        ui._update_chat_text(resp.headers.get("X-User-Text", ""),
                          resp.headers.get("X-Reply-Text", ""))
        ui.draw_state("playing")
        n = snd.stream_play(resp)   # 边下边播，不把整段 WAV 拉进堆（见 snd.py）
        resp.close()
        if n <= 0:
            print("cam reply play failed")
            ui.draw_state("error")
            time.sleep(2)
            return
    except OSError as e:
        print("cam send net err:", e)
        ui.draw_state("error")
        time.sleep(2)
    finally:
        gc.collect()


def camera_mode():
    """
    取景模式主流程：实时预览 → 短按 SHOOT 定格 → RETAKE 重拍 / SEND 交给神乐。
    长按屏幕任意处随时退出；CAM_IDLE_TIMEOUT 秒无操作自动退出。
    """
    cfg.St.busy = True
    cfg.St.stage = "cam"
    cfg.St.last_activity = time.time()
    gc.collect()
    if not _camera_ensure():
        ui.draw_state("error")
        time.sleep(2)
        ui.draw_state("idle")
        cfg.St.busy = False
        return

    ui._ui_invalidate()               # 下面要整屏接管，作废分层缓存
    Widgets.fillScreen(0x000000)   # 帧小于屏幕时四周留黑，只清一次
    _cam_chrome(False)
    _cam_take_touch()              # 丢掉进来那一下点按的残留
    shot        = None             # 定格的帧（bytes 副本），None=取景中
    last_action = time.time()
    frames      = 0
    try:
        while True:
            hw._wdt_feed()
            if time.time() - last_action > cfg.CAM_IDLE_TIMEOUT:
                diag.dbg("cam idle exit")
                break

            if shot is None:
                _cam_poll_touch()
                frame = _cam_grab()
                _cam_poll_touch()
                if frame is None:
                    time.sleep(0.2)        # 抓帧失败别空转
                else:
                    _cam_show(frame, _CAM_PREVIEW_H)
                    if not cfg.CAM_PREVIEW_CLIP:
                        _cam_chrome(False)  # 整帧会盖住按钮条，得补画回来
                    frames += 1
                    if frames % cfg.CAM_GC_EVERY == 0:
                        gc.collect()
            else:
                time.sleep(0.05)           # 已定格，屏幕不用重画

            # 取景可能停留几十秒，超过 MQTT keepalive(60s) 就会被判掉线
            snd._pump_safe()
            # 注：心跳不在这里发——heartbeat_tick() 见 St.busy 就跳过，
            # 与录音/播放期间一样按"交互中不上报"处理，退出后自然补上。

            _cam_poll_touch()
            touch, pos = _cam_take_touch()
            if touch == 'long':
                break
            if touch != 'short':
                continue

            last_action = time.time()
            cfg.St.last_activity = last_action
            x, y = pos
            if shot is None:
                if hw._hit(x, y, _CAM_BTN_R):            # SHOOT：定格
                    frame = _cam_grab()
                    raw = _cam_bytes(frame) if frame is not None else None
                    if raw is None:
                        ui.draw_state("error")
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
                elif hw._hit(x, y, _CAM_BTN_L):          # EXIT
                    break
            else:
                if hw._hit(x, y, _CAM_BTN_R):            # SEND
                    _cam_send(shot)
                    break
                elif hw._hit(x, y, _CAM_BTN_L):          # RETAKE：丢掉重来
                    shot = None
                    _cam_chrome(False)
                    _cam_take_touch()      # 同上：别顺手连点成 EXIT
    finally:
        shot = None
        gc.collect()
        cfg.St.last_activity = time.time()
        cfg.St.busy = False
        ui.draw_state("idle")
        hw.drain_touch()


def _upload_photo(request_id, image_b64):
    """把拍到的图 POST 给服务端。远程拍照与直播插拍共用。"""
    payload = ujson.dumps({
        "request_id": request_id,
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
        return True
    except OSError as e:
        print("upload err:", e)
        return False
