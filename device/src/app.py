"""应用入口：setup() 初始化、loop() 主循环。

模块加载顺序（无环）：
    cfg → hw → clock → ui → {wifisetup, audio} → netsvc → chat → app
"""

import time
import machine
import M5
from M5 import *

import cfg
import hw
import clock
import ui
import wifisetup
import audio
import netsvc
import chat

# ── 声控唤醒检测状态 ──────────────────────────────────────────
_wake_buf        = bytearray(cfg.WAKE_CHUNK_SIZE)
_wake_last_ms    = 0
_wake_loud_count = 0


def setup():
    cfg.ensure_dirs()
    audio.set_pump(netsvc.mqtt_check)   # 打断 audio ↔ netsvc 循环依赖
    M5.begin()
    Widgets.setRotation(1)
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
    clock.sync_rtc()
    netsvc.init_mqtt()
    netsvc.init_ble()
    chat.init_imu()
    hw.volume_load()
    ui.draw_state("idle")       # 发现完成后恢复空闲界面
    audio.calibrate_noise()
    cfg.St.last_activity = time.time()


def loop():
    global _wake_last_ms, _wake_loud_count

    touch, pos = hw.check_touch()

    # ── 休眠中：触摸仅唤醒，不执行其他操作 ──
    if cfg.St.sleeping:
        if touch is not None:
            ui.wake_up()
            hw.drain_touch()
    elif not cfg.St.busy:
        if touch is not None:
            cfg.St.last_activity = time.time()
        if touch == 'long':
            chat.toggle_wake_mode()           # 长按：切换声控唤醒模式
        elif touch == 'short':
            chat.record_and_send()            # 短按：直接录音
        elif cfg.St.wake:
            # 简化的声控唤醒：连续 N×100ms 音量超阈值 → 触发录音
            now_ms = time.ticks_ms()
            if time.ticks_diff(now_ms, _wake_last_ms) >= 100:
                _wake_last_ms = now_ms
                if cfg.WAKE_MIC_PERSISTENT:
                    hw.mic_on()            # 幂等：常开，播放时由 play_wav 释放
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

    # BLE 在家感知（非阻塞定期扫描）
    netsvc.ble_scan_tick()

    # IMU 摇晃彩蛋检测
    chat.imu_shake_tick()

    # ── 自动休眠检查 ──
    now = time.time()
    if not cfg.St.sleeping and not cfg.St.busy:
        if now - cfg.St.last_activity > cfg.SLEEP_TIMEOUT:
            ui.enter_sleep()


def main():
    """引导：初始化 → arm 看门狗 → 主循环（异常不致设备假死）。"""
    setup()
    # 看门狗在 setup 之后启动：配网界面等待用户输入不受超时限制
    hw.wdt_arm()
    while True:
        try:
            loop()
            hw.wdt_feed()
        except Exception as e:
            # 未捕获异常不再让设备假死：报错后继续跑；连喂狗都做不到则 WDT 复位
            print("[loop] uncaught:", e)
            try:
                ui.draw_state("error")
                time.sleep(1)
                ui.draw_state("idle")
            except Exception:
                pass
        time.sleep(0.02)   # 空闲不再全速自旋；触摸按抬起时长判定，20ms 粒度无感
