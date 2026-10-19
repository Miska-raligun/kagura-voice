"""Kagura Voice 设备端 —— 启动与主循环。
"""

import M5
from M5 import *
from hardware import *
import time
import gc

import cfg
import hw
import clock
import ui
import wifisetup
import snd
import cam
import feel
import diag
import netsvc
import stream
import chat

# ── 唤醒词检测状态 ─────────────────────────────────────────────

_wake_buf        = bytearray(cfg.WAKE_CHUNK_SIZE)


_wake_last_ms    = 0


_wake_loud_count = 0


def setup():
    M5.begin()
    Widgets.setRotation(1)

    # ── 拆分后的接线：目录 + 打断依赖环的回调注入 ──────────────
    # 单文件时代这些都是直接调用；拆成模块后 snd→netsvc、netsvc→stream
    # 会成环（tools/check_split.py 直接拦），所以改成在这里注入。
    cfg.ensure_dirs()
    snd.set_pump(netsvc.mqtt_check)              # 播放/取景期间维持 MQTT
    netsvc.set_stream_runner(stream._run_stream_cmd)   # MQTT 收到直播命令时回调

    hw._set_led(0, 0, 0)
    ui.draw_state("idle")

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
        hw.drain_touch()

    if not wifisetup.ensure_wifi(force_setup=force_wifi):
        ui.draw_state("wifi_fail")
        time.sleep(2)
        import machine
        machine.reset()

    netsvc.discover_server()
    netsvc.fetch_role()           # 角色专属背景图：要在第一次 draw_state 前定下来
    diag._boot_report()
    clock.sync_rtc()
    netsvc.init_mqtt()
    netsvc.init_ble()
    chat.init_imu()
    hw._volume_load()
    diag.canvas_probe()           # 一次性诊断；CANVAS_PROBE=False 即整段跳过
    ui.draw_state("idle")       # 发现完成后恢复空闲界面
    snd.alloc_rec_buf()           # 开机堆还没碎时一次性预留录音缓冲（约 960KB）
    snd.calibrate_noise()
    diag.dbg("vad floor={} th={} wake={} max={}s".format(
        cfg.NOISE_FLOOR, cfg.SILENCE_THRESHOLD, cfg.WAKE_THRESHOLD,
        snd.rec_max_chunks * cfg.CHUNK_SIZE // (cfg.SAMPLE_RATE * 2)))
    cfg.St.last_activity = time.time()
    hw._wdt_init()   # 最后再武装看门狗：WiFi 配置 UI 等交互流程不受 2 分钟窗口限制


def loop():
    global _wake_last_ms, _wake_loud_count

    cfg.St.stage = "loop"    # 死人开关的临终留言用；长循环各自改写它

    # feel=True 只在这里传：主循环是唯一把屏幕当皮肤的地方
    touch, pos = hw.check_touch(feel=True)

    # ── 休眠中：触摸仅唤醒，不执行其他操作 ──
    if cfg.St.sleeping:
        if touch is not None:
            ui.wake_up()
            hw.drain_touch()
            hw.touch_reset()      # 抚摸在按住期间就唤醒了，别让抬手再触发一次结算
    elif not cfg.St.busy:
        if touch is not None:
            cfg.St.last_activity = time.time()
        if touch in ('stroking', 'cradling'):
            # 反射层：摸到的当下就换表情，不过网。draw_state 的键比对保证
            # 抚摸全程只重画第一帧
            feel.feel_reflex("petted")
        elif touch in ('stroke', 'cradle'):
            feel.feel_on_touch_end(touch)     # 抬手：结算体感，够显著才惊动 agent
        elif touch == 'long':
            chat.toggle_wake_mode()           # 长按：切换声控唤醒模式
        elif touch == 'short':
            if cfg.CAMERA_MODE_ENABLED and hw._hit(pos[0], pos[1], cam._CAM_ENTRY):
                cam.camera_mode()            # 短按顶栏 CAM 键：手动取景拍照
            else:
                chat.record_and_send()        # 短按其他位置：直接录音
        elif cfg.St.wake:
            # 简化的声控唤醒：连续 N×100ms 音量超阈值 → 触发录音
            now_ms = time.ticks_ms()
            if time.ticks_diff(now_ms, _wake_last_ms) >= 100:
                _wake_last_ms = now_ms
                if cfg.WAKE_MIC_PERSISTENT:
                    hw._mic_on()            # 幂等：常开，播放时由 play_wav 释放
                    Mic.record(_wake_buf, 16000)
                    time.sleep(0.05)
                else:
                    Mic.begin()          # 旧行为：每次建拆驱动（回退开关）
                    Mic.record(_wake_buf, 16000)
                    time.sleep(0.05)
                    Mic.end()
                level = hw.rms(_wake_buf)
                if level > cfg.WAKE_THRESHOLD:
                    _wake_loud_count += 1
                    if _wake_loud_count >= cfg.WAKE_LOUD_NEED:
                        _wake_loud_count = 0
                        cfg.St.last_activity = time.time()
                        chat.record_and_send()
                else:
                    _wake_loud_count = 0

    # 空闲呼吸动画（自带 20fps 限帧；休眠时自动跳过）
    ui.visual_tick()

    # MQTT 推送消息 + 命令（回调只入队，这里接收；下面统一消费）
    netsvc.mqtt_check()
    netsvc.process_mqtt_queue()

    # 网络自检（WiFi 掉线自动重连）+ 心跳上报
    diag.net_watch_tick()
    diag.heartbeat_tick()

    # BLE 在家感知（非阻塞定期扫描）
    netsvc.ble_scan_tick()

    # IMU：摇晃彩蛋 + 本体感觉（被拿起/被轻拍/被抱着走）
    chat.imu_tick()

    # 触觉反射表情到期收回
    feel.feel_reflex_tick()

    # ── 自动休眠检查 ──
    now = time.time()
    if not cfg.St.sleeping and not cfg.St.busy:
        if now - cfg.St.last_activity > cfg.SLEEP_TIMEOUT:
            ui.enter_sleep()


def main():
    """入口：装配 + 带崩溃守护的主循环。由 /flash/main.py 调用。

    单文件时代这段是文件末尾的 `if __name__ == "__main__":`，拆分后
    收成函数——引导文件 device/main.py 只负责加 sys.path 再调它。
    """
    setup()
    last_gc = time.time()
    err_count = 0
    while True:
        try:
            loop()
            hw._wdt_feed()
            err_count = 0
            if time.time() - last_gc > 30:   # 空闲期定期 GC，缓解长时间运行的堆碎片化
                gc.collect()
                last_gc = time.time()
        except Exception as e:
            # 单次异常不复位：记录现场后继续跑（复位会丢失上下文且中断服务）。
            # 连续 10 次说明陷入了出不来的坏状态 → 复位自愈；真卡死则 WDT 兜底。
            err_count += 1
            diag._log_crash(e)
            print("[loop] uncaught:", e)
            try:
                ui.draw_state("error")
                time.sleep(1)
                ui.draw_state("idle")
            except Exception:
                pass
            if err_count >= 10:
                diag._persist_dbg("loop-error-storm")
                time.sleep(1)
                import machine
                machine.reset()
