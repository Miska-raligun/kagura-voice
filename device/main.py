"""烧录到 /flash/main.py —— 把 src 目录加进 sys.path 并启动。

设备目录布局：
    /flash/main.py               本文件
    /flash/kagura/src/*.py       代码
    /flash/kagura/resource/*     图片资源（自行上传，jpg/png/bmp）
    /flash/kagura/data/*         运行时状态（自动创建）

启动失败必须看得见：黑屏什么都不告诉你，红屏能直接指出缺哪个模块。
所以这里把 traceback 同时打到 REPL、屏幕和 /flash/boot_error.log
（写 /flash 根目录而不是 data/，因为失败时那个目录可能还没建出来）。
"""

import sys

sys.path.insert(0, "/flash/kagura/src")

try:
    import app
    app.main()
except Exception as e:                     # noqa: BLE001 —— 引导层要兜住一切
    try:
        sys.print_exception(e)             # REPL
    except Exception:
        print("boot failed:", e)

    try:                                   # 落盘，断电也能回看
        with open("/flash/boot_error.log", "w") as _f:
            sys.print_exception(e, _f)
    except Exception:
        pass

    try:                                   # 上屏：只用最底层 API，不碰 kagura 模块
        import M5
        from M5 import Lcd, Widgets
        M5.begin()
        Widgets.setRotation(1)
        Widgets.fillScreen(0x400000)
        Lcd.setFont(Widgets.FONTS.DejaVu18)
        Lcd.setTextColor(0xffffff, 0x400000)
        Lcd.drawString("BOOT FAILED", 10, 10)
        msg = "{}: {}".format(type(e).__name__, e)
        y = 40
        while msg and y < 230:             # 逐行折断，屏幕只有 320px 宽
            Lcd.drawString(msg[:30], 10, y)
            msg = msg[30:]
            y += 22
        Lcd.drawString("see /flash/boot_error.log", 10, 215)
    except Exception:
        pass
