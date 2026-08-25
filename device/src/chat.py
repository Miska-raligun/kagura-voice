"""Kagura Voice 设备端 —— 对话主流程：录音→上传→播放、模式切换、IMU 摇晃彩蛋与本体感觉。
"""

import M5
from M5 import *
import time
import math
import gc
import ubinascii
import ujson
import requests as urequests

import cfg
import hw
import clock
import ui
import snd
import cam
import feel
import netsvc

_imu_shake_times  = []       # 超阈值时间戳列表


_imu_last_shake   = 0        # 上次触发彩蛋的时间


_imu_available    = False    # IMU 是否可用


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
        hw._mic_off()   # 退出唤醒模式时释放常开的麦克风
    ui.draw_state("wake_on" if cfg.St.wake else "wake_off")
    time.sleep(0.8)   # Bug 3 Fix: 1.5→0.8s，缩短切换反馈时间
    ui.draw_state("idle")


# ── 主对话（普通） ────────────────────────────────────────────

def record_and_send():
    """
    录音 → 发送服务端 → 播放回复。
    若 St.continuous 开启则自动进入下一轮；
    播放结束后有 1.5s 窗口，长按可退出连续模式。
    """
    cfg.St.busy = True
    cfg.St.last_activity = time.time()
    gc.collect()

    try:
        while True:
            hw._wdt_feed()
            ui.draw_state("recording")
            chunks = snd._record_audio()

            if chunks is None:         # 用户长按中断录音 → 退出当前模式
                if cfg.St.continuous:
                    toggle_continuous()
                elif cfg.St.wake:
                    toggle_wake_mode()
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
                feel._feel_headers(hdrs)      # 体感层：把"刚才被摸过"随对话一起捎过去
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
                ui._update_chat_text(resp.headers.get("X-User-Text", ""),
                                  resp.headers.get("X-Reply-Text", ""))
                # 分块落盘，不用 resp.content：长回复整段进堆是几百 KB~MB 的
                # 尖峰，而且读完之前一次狗都喂不上（见 snd.py 播放段口径）
                n = snd.save_stream(resp)
                resp.close()
                if vol_cmd in ("up", "down"):
                    hw._volume_adjust(vol_cmd)
            except OSError as e:
                print("network err:", e)
                ui.draw_state("error")
                time.sleep(2)
                if not cfg.St.continuous:
                    break
                continue

            if n <= 0:
                print("reply save failed")
                ui.draw_state("error")
                time.sleep(2)
                if not cfg.St.continuous:
                    break
                continue
            print("WAV size:", n)
            ui.draw_state("playing")
            snd.play_file()
            gc.collect()

            # ── 语音触发拍照：播完简短应答后立即拍照并发送 /chat-vision ──
            if need_photo:
                gc.collect()   # 回复 WAV 是直接落盘的，堆里本来就没有它
                wav_b64 = ubinascii.b2a_base64(wav).decode("utf-8").strip()
                del wav       # base64 字符串已持有数据，释放原始 bytes (~48KB)
                gc.collect()
                ui.draw_state("camera")
                image_b64 = cam.capture_photo()
                ui.draw_state("processing")
                payload = ujson.dumps({"wav": wav_b64, "image": image_b64 or ""})
                try:
                    v_hdrs = {"X-Device-Id": cfg.DEVICE_ID,
                              "Content-Type": "application/json"}
                    lt2 = clock.get_local_time_header()
                    if lt2:
                        v_hdrs["X-Local-Time"] = lt2
                    feel._feel_headers(v_hdrs)
                    resp2 = urequests.post(
                        cfg.VISION_URL,
                        data=payload.encode("utf-8"),
                        headers=v_hdrs,
                        timeout=cfg.REQUEST_TIMEOUT_CHAT,
                    )
                    if resp2.status_code == 200:
                        n2 = snd.save_stream(resp2)
                        resp2.close()
                        if n2 > 0:
                            ui.draw_state("playing")
                            snd.play_file()
                        else:
                            ui.draw_state("error")
                            time.sleep(2)
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
                netsvc.mqtt_check()   # 趁 St.busy=True 消费掉 OpenClaw 触发的重复 push
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
                    return
                time.sleep(0.05)
            hw.drain_touch()
            # 继续下一轮

        ui.draw_state("idle")
        time.sleep(1)
        hw.drain_touch()
    finally:
        # 无论从哪个出口离开都要还原 busy。卡在 True 等于整台设备装死：
        # 触摸不响应、心跳不发（heartbeat_tick 跳过 busy）、网络自愈不跑、
        # 也不会自动休眠——而播放里任何一个异常都能把它留在 True 上。
        cfg.St.busy = False


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
    if not _imu_available or cfg.St.busy:
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

    if cfg.TOUCH_FEEL_ENABLED:
        try:
            feel._imu_feel_detect(magnitude)
        except Exception as e:
            print("[feel] imu err:", e)
    _imu_shake_detect(magnitude)


def _imu_shake_detect(magnitude):
    """摇晃彩蛋：500ms 内 IMU_SHAKE_COUNT 次超阈值。"""
    global _imu_shake_times, _imu_last_shake

    now = time.time()
    if now - _imu_last_shake < cfg.IMU_SHAKE_COOLDOWN:
        return

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


def _show_shake_easter_egg():
    """显示摇晃彩蛋图片 2 秒，然后切换连续对话模式。continuous off→on 时额外调用 /shake 让 AI 主动聊天。"""
    global _imu_last_shake
    cfg.St.busy = True
    cfg.St.last_activity = time.time()
    try:
        was_off = not cfg.St.continuous
        try:
            ui._ui_invalidate()       # 彩蛋图整屏覆盖，之后必须整屏重建
            with open(cfg.res("img_shake.jpg"), "rb") as f:
                Lcd.drawJpg(f.read(), 0, 0)
        except Exception as e:
            print("[shake] img_shake.jpg unavailable, falling back to kaomoji:", e)
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
        hw.touch_reset()
        hw.drain_touch()
        _imu_last_shake = time.time()
    finally:
        cfg.St.busy = False
