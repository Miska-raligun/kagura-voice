"""对话主流程：录音→上传→播放、模式切换、IMU 摇晃彩蛋。

依赖 netsvc（单向：chat → netsvc，netsvc 不 import chat）。
"""

import time
import math
import gc
import ujson
import ubinascii
import requests as urequests
import M5

import cfg
import hw
import ui
import audio
import clock
import netsvc

# ── IMU 状态 ──────────────────────────────────────────────────
_imu_shake_times = []       # 超阈值时间戳列表
_imu_last_shake  = 0        # 上次触发彩蛋的时间
_imu_available   = False    # IMU 是否可用


# ── 模式切换 ──────────────────────────────────────────────────

def toggle_continuous():
    """摇晃切换连续对话模式。开启时自动关闭声控唤醒（两者互斥）。"""
    cfg.St.continuous = not cfg.St.continuous
    if cfg.St.continuous:
        cfg.St.wake = False
    ui.draw_state("continuous_on" if cfg.St.continuous else "continuous_off")
    time.sleep(0.8)
    ui.draw_state("idle")


def toggle_wake_mode():
    """长按切换声控唤醒模式。开启时自动关闭连续对话（两者互斥）。"""
    cfg.St.wake = not cfg.St.wake
    if cfg.St.wake:
        cfg.St.continuous = False
    else:
        hw.mic_off()   # 退出唤醒模式时释放常开的麦克风
    ui.draw_state("wake_on" if cfg.St.wake else "wake_off")
    time.sleep(0.8)   # Bug 3 Fix: 1.5→0.8s，缩短切换反馈时间
    ui.draw_state("idle")


# ── 主对话 ────────────────────────────────────────────────────

def record_and_send():
    """
    录音 → 发送服务端 → 播放回复。
    若 cfg.St.continuous 开启则自动进入下一轮；
    播放结束后有 1.5s 窗口，长按可退出连续模式。
    """
    cfg.St.busy = True
    cfg.St.last_activity = time.time()
    gc.collect()

    while True:
        hw.wdt_feed()
        ui.draw_state("recording")
        chunks = audio._record_audio()

        if chunks is None:         # 用户长按中断录音 → 退出当前模式
            if cfg.St.continuous:
                toggle_continuous()
            elif cfg.St.wake:
                toggle_wake_mode()
            cfg.St.busy = False
            return

        if not chunks:
            ui.draw_state("no_speech")
            time.sleep(1)
            if not cfg.St.continuous:
                break
            continue

        ui.draw_state("processing")
        audio = b''.join(chunks)
        wav   = hw.make_wav_header(len(audio)) + audio
        del chunks, audio   # wav 已包含全部数据，释放 ~96KB
        gc.collect()

        try:
            hdrs = {"X-Device-Id": cfg.DEVICE_ID}
            lt = clock.get_local_time_header()
            if lt:
                hdrs["X-Local-Time"] = lt
            resp = urequests.post(cfg.SERVER_URL, data=wav, headers=hdrs, timeout=cfg.REQUEST_TIMEOUT_CHAT)
            if resp.status_code != 200:
                print("chat err:", resp.text)
                resp.close()
                ui.draw_state("error")
                time.sleep(2)
                if not cfg.St.continuous:
                    break
                continue
            need_photo = resp.headers.get("X-Need-Photo", "") == "1"
            vol_cmd = resp.headers.get("X-Volume", "")
            ui.update_chat_text(resp.headers.get("X-User-Text", ""),
                              resp.headers.get("X-Reply-Text", ""))
            data = resp.content
            resp.close()
            if vol_cmd in ("up", "down"):
                hw.volume_adjust(vol_cmd)
        except OSError as e:
            print("network err:", e)
            ui.draw_state("error")
            time.sleep(2)
            if not cfg.St.continuous:
                break
            continue

        print("WAV size:", len(data))
        ui.draw_state("playing")
        audio.play_wav(data)
        gc.collect()

        # ── 语音触发拍照：播完简短应答后立即拍照并发送 /chat-vision ──
        if need_photo:
            del data      # 回复 WAV 已写入 flash 并播完，释放 ~52KB 给摄像头
            gc.collect()
            wav_b64 = ubinascii.b2a_base64(wav).decode("utf-8").strip()
            del wav       # base64 字符串已持有数据，释放原始 bytes (~48KB)
            gc.collect()
            ui.draw_state("camera")
            image_b64 = hw.capture_photo()
            ui.draw_state("processing")
            payload = ujson.dumps({"wav": wav_b64, "image": image_b64 or ""})
            try:
                v_hdrs = {"X-Device-Id": cfg.DEVICE_ID,
                          "Content-Type": "application/json"}
                lt2 = clock.get_local_time_header()
                if lt2:
                    v_hdrs["X-Local-Time"] = lt2
                resp2 = urequests.post(
                    cfg.VISION_URL,
                    data=payload.encode("utf-8"),
                    headers=v_hdrs,
                    timeout=cfg.REQUEST_TIMEOUT_CHAT,
                )
                if resp2.status_code == 200:
                    data2 = resp2.content
                    resp2.close()
                    ui.draw_state("playing")
                    audio.play_wav(data2)
                    gc.collect()
                else:
                    resp2.close()
                    ui.draw_state("error")
                    time.sleep(2)
            except OSError as e:
                print("vision follow-up err:", e)
                ui.draw_state("error")
                time.sleep(2)

        if not cfg.St.continuous:
            netsvc.mqtt_check()   # 趁 cfg.St.busy=True 消费掉 OpenClaw 触发的重复 push
            break

        # ── 连续模式：轮间检查主动播报 ───────────────────────────
        netsvc.mqtt_check()

        # ── 连续模式：1.5s 退出窗口（长按退出）──────────────────
        ui.draw_state("idle")
        t_start = time.ticks_ms()
        while time.ticks_diff(time.ticks_ms(), t_start) < 1500:
            touch, pos = hw.check_touch()
            if touch == 'long':
                toggle_continuous()   # 关闭连续模式
                cfg.St.busy = False
                return
            time.sleep(0.05)
        hw.drain_touch()
        # 继续下一轮

    ui.draw_state("idle")
    time.sleep(1)
    hw.drain_touch()
    cfg.St.busy = False


# ── IMU 摇晃彩蛋 ──────────────────────────────────────────────

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


def imu_shake_tick():
    """主循环调用：检测摇晃手势，触发彩蛋图片显示。"""
    global _imu_shake_times, _imu_last_shake

    if not _imu_available or cfg.St.busy:
        return

    now = time.time()
    if now - _imu_last_shake < cfg.IMU_SHAKE_COOLDOWN:
        return

    try:
        acc = M5.Imu.getAccel()
        if acc is None:
            return
        ax, ay, az = acc
        # 计算总加速度幅值（含重力约 1g）
        magnitude = math.sqrt(ax * ax + ay * ay + az * az)
        if magnitude > cfg.IMU_SHAKE_G:
            now_ms = time.ticks_ms()
            _imu_shake_times.append(now_ms)
            _imu_shake_times[:] = [t for t in _imu_shake_times if time.ticks_diff(now_ms, t) < 500]
            if len(_imu_shake_times) >= cfg.IMU_SHAKE_COUNT:
                _imu_shake_times.clear()
                _imu_last_shake = now
                _show_shake_easter_egg()
        else:
            if _imu_shake_times:
                now_ms = time.ticks_ms()
                _imu_shake_times[:] = [t for t in _imu_shake_times if time.ticks_diff(now_ms, t) < 500]
    except Exception:
        pass


def _show_shake_easter_egg():
    """显示摇晃彩蛋图片 2 秒，然后切换连续对话模式。continuous off→on 时额外调用 /shake 让 AI 主动聊天。"""
    global _imu_last_shake
    cfg.St.busy = True
    cfg.St.last_activity = time.time()
    try:
        was_off = not cfg.St.continuous
        if not ui.draw_image("img_shake"):
            print("[shake] 无 img_shake 图片资源，改用 kaomoji")
            ui.draw_state("shake")
        time.sleep(2)
        toggle_continuous()
        if was_off:
            ui.draw_state("processing")
            try:
                hdrs = {"X-Device-Id": cfg.DEVICE_ID}
                lt = clock.get_local_time_header()
                if lt:
                    hdrs["X-Local-Time"] = lt
                resp = urequests.get(cfg.SERVER_BASE + "/shake", headers=hdrs, timeout=cfg.REQUEST_TIMEOUT_SHORT)
                resp.close()
            except OSError as e:
                print("shake network err:", e)
            ui.draw_state("idle")
        hw.reset_touch()
        hw.drain_touch()
        _imu_last_shake = time.time()
    finally:
        cfg.St.busy = False
