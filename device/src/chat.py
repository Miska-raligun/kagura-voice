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
import diag
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


def cycle_role():
    """顶栏 ROLE 键：切到下一个角色，播新角色的问候（用它自己的音色），背景图同时换掉。"""
    cfg.St.busy = True
    cfg.St.last_activity = time.time()
    try:
        ui.draw_state("processing")
        netsvc.mqtt_ping()
        resp = urequests.post(cfg.SERVER_BASE + "/role/cycle",
                              headers={"X-Device-Id": cfg.DEVICE_ID},
                              timeout=cfg.REQUEST_TIMEOUT_SHORT)
        if resp.status_code != 200:
            print("cycle role err:", resp.status_code)
            resp.close()
            ui.draw_state("error")
            time.sleep(1)
            return
        ui.set_role(resp.headers.get("X-Role", ""))
        ui._update_chat_text("", resp.headers.get("X-Reply-Text", ""))
        ui.draw_state("playing")
        snd.stream_play(resp)
        resp.close()
    except OSError as e:
        print("cycle role net err:", e)
        ui.draw_state("error")
        time.sleep(1)
    finally:
        cfg.St.busy = False
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

_post_mv_ok = True    # 固件 requests 能直接发 memoryview（不能就退回 bytes 复制一份）


def _want_stream(hdrs):
    """边生成边播：只在内存流式播放可用时请求（见 cfg.STREAM_REPLY）"""
    if cfg.STREAM_REPLY and cfg.PLAY_STREAMING and not snd._stream_bad:
        hdrs["X-Stream"] = "1"


def _fetch_full_text(partial):
    """边生成边播时屏幕上只有首句：播完取全文刷新。失败无所谓，只是屏显少几个字"""
    if not partial:
        return
    try:
        r = urequests.get(cfg.SERVER_BASE + "/chat/last", headers={"X-Device-Id": cfg.DEVICE_ID},
                          timeout=cfg.REQUEST_TIMEOUT_SHORT)
        if r.status_code == 200:
            j = r.json()
            ui._update_chat_text(j.get("user_b64", ""), j.get("reply_b64", ""))
        r.close()
    except Exception as e:
        print("chat/last err:", e)


def _post_wav(wav, hdrs):
    """上传录音。wav 是共享录音缓冲的 memoryview：socket.write 认缓冲协议，
    直接发就不用为 30 秒录音再复制近 1MB。固件的 requests 万一只认 bytes/str
    （TypeError），退回 bytes() 并记住，本次开机不再试。"""
    global _post_mv_ok
    if _post_mv_ok:
        try:
            return urequests.post(cfg.SERVER_URL, data=wav, headers=hdrs,
                                  timeout=cfg.REQUEST_TIMEOUT_CHAT)
        except TypeError as e:
            print("post memoryview unsupported:", e)
            _post_mv_ok = False
    return urequests.post(cfg.SERVER_URL, data=bytes(wav), headers=hdrs,
                          timeout=cfg.REQUEST_TIMEOUT_CHAT)

def record_and_send():
    """
    录音 → 发送服务端 → 播放回复。
    若 St.continuous 开启则播完立刻进入下一轮录音；
    退出连续模式的路子（LRN 2026-10-19，旧版只有"录音时长按"一条，
    一有点声音就触发新一轮，用户掐不准时机，只能关机）：
      ① 听的时候轻点或长按屏幕；② 说"退出/不聊了/再见"之类（服务端回 X-Cont-Exit）；
      ③ 连续 CONT_EMPTY_EXIT 次识别为空；④ CONT_IDLE_EXIT_SECS 内没有一轮有效对话。
    """
    cfg.St.busy = True
    cfg.St.stage = "chat"
    cfg.St.last_activity = time.time()
    gc.collect()
    empties = 0                 # 连续"识别为空"的次数
    last_real = time.time()     # 最近一轮有效对话（或进入本函数）的时刻

    try:
        while True:
            hw._wdt_feed()
            if cfg.St.continuous and time.time() - last_real > cfg.CONT_IDLE_EXIT_SECS:
                diag.dbg("cont exit: idle")
                toggle_continuous()
                return
            ui.draw_state("recording")
            wav = snd._record_audio()     # 整段 WAV（指向共享录音缓冲，零复制）
            if wav is not None and len(wav) > 44:
                # 门槛/峰值/有没有缝：识别不灵时先看这行。空录音不记——
                # 连续模式没人说话时每 10 秒一条，会把环形日志里的证据挤掉
                diag.dbg(snd.rec_summary())

            if wav is None:            # 用户长按中断录音 → 退出当前模式
                if cfg.St.continuous:
                    toggle_continuous()
                elif cfg.St.wake:
                    toggle_wake_mode()
                return

            if len(wav) <= 44:
                if cfg.St.continuous:
                    continue          # 连续模式：没人说话就接着听，别停 1 秒、别闪屏
                ui.draw_state("no_speech")
                time.sleep(1)
                break

            ui.draw_state("processing")
            gc.collect()

            try:
                hdrs = {"X-Device-Id": cfg.DEVICE_ID,
                        # 服务端据此决定是否过滤"嗯/啊"这类免手模式误触
                        "X-Mode": "continuous" if cfg.St.continuous
                                  else ("wake" if cfg.St.wake else "single")}
                lt = clock.get_local_time_header()
                if lt:
                    hdrs["X-Local-Time"] = lt
                feel._feel_headers(hdrs)      # 体感层：把"刚才被摸过"随对话一起捎过去
                _want_stream(hdrs)
                netsvc.mqtt_ping()            # 下面最多阻塞 60 秒，先保活
                resp = _post_wav(wav, hdrs)
                if resp.status_code != 200:
                    print("chat err:", resp.text)
                    resp.close()
                    ui.draw_state("error")
                    time.sleep(2)
                    if not cfg.St.continuous:
                        break
                    continue
                ui.set_role(resp.headers.get("X-Role", ""))   # 角色切换后这里换图
                if resp.headers.get("X-Asr-Empty", "") == "1" and cfg.St.continuous:
                    # 连续模式下没听清就别播"没听清"了——环境噪声能让它一直念叨。
                    # 悄悄接着听，攒够次数自动退出
                    resp.close()
                    empties += 1
                    if empties >= cfg.CONT_EMPTY_EXIT:
                        diag.dbg("cont exit: {} empty".format(empties))
                        toggle_continuous()
                        return
                    continue
                empties = 0
                last_real = time.time()
                cont_exit = resp.headers.get("X-Cont-Exit", "") == "1"
                need_photo = resp.headers.get("X-Need-Photo", "") == "1"
                vol_cmd = resp.headers.get("X-Volume", "")
                ui._update_chat_text(resp.headers.get("X-User-Text", ""),
                                  resp.headers.get("X-Reply-Text", ""))
                if vol_cmd in ("up", "down"):
                    hw._volume_adjust(vol_cmd)    # 先调音量，这条回复就按新音量播
                # 边下边播：收到 2 秒就出声，播放期间 MQTT 照常保活。
                # 不用 resp.content（整段进堆 + 读完前喂不上狗，见 snd.py 播放段口径）
                partial = resp.headers.get("X-Reply-Partial", "") == "1"
                ui.draw_state("playing")
                n = snd.stream_play(resp)
                resp.close()
                diag.dbg(snd.stream_summary())
                _fetch_full_text(partial)
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
            gc.collect()
            if cont_exit:
                # 用户说了"退出/不聊了"：播完告别语就收（单次模式下这个头无害）
                if cfg.St.continuous:
                    toggle_continuous()
                elif cfg.St.wake:
                    toggle_wake_mode()
                return

            # ── 语音触发拍照：播完简短应答后立即拍照并发送 /chat-vision ──
            if need_photo:
                gc.collect()   # 回复 WAV 是直接落盘的，堆里本来就没有它
                wav_b64 = ubinascii.b2a_base64(wav).decode("utf-8").strip()
                del wav       # 只是放掉对共享录音缓冲的引用（缓冲本身常驻）
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
                    _want_stream(v_hdrs)
                    netsvc.mqtt_ping()
                    resp2 = urequests.post(
                        cfg.VISION_URL,
                        data=payload.encode("utf-8"),
                        headers=v_hdrs,
                        timeout=cfg.REQUEST_TIMEOUT_CHAT,
                    )
                    if resp2.status_code == 200:
                        partial2 = resp2.headers.get("X-Reply-Partial", "") == "1"
                        ui._update_chat_text(resp2.headers.get("X-User-Text", ""), resp2.headers.get("X-Reply-Text", ""))
                        ui.draw_state("playing")
                        n2 = snd.stream_play(resp2)
                        resp2.close()
                        _fetch_full_text(partial2)
                        if n2 <= 0:
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

            # 旧版这里有个 1.5 秒的"长按退出"窗口，期间麦克风是关的——
            # 人习惯回复一结束就接话，正好落进这个聋区。录音循环本身就认长按退出，
            # 窗口是多余的，直接进下一轮
            hw.drain_touch()

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
            with open(ui.img_path("img_shake"), "rb") as f:
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
