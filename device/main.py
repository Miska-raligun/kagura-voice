"""烧录到 /flash/main.py —— 把 src 目录加进 sys.path 并启动。

设备目录布局：
    /flash/main.py               本文件
    /flash/kagura/src/*.py       代码
    /flash/kagura/resource/*     图片资源（自行上传，jpg/png/bmp）
    /flash/kagura/data/*         运行时状态（自动创建）
    /flash/kagura/src.bak/*      管理界面更新代码时的旧代码备份（新代码跑通后删除）

启动失败必须看得见：黑屏什么都不告诉你，红屏能直接指出缺哪个模块。
所以这里把 traceback 同时打到 REPL、屏幕和 /flash/boot_error.log
（写 /flash 根目录而不是 data/，因为失败时那个目录可能还没建出来）。

管理界面更新设备代码（ota.py）之后，新代码起不来或连续复位 3 次，这里自动换回旧代码。
本文件自己不经 OTA 更新（它坏了就只能接 USB 救），换新版要手动传一次。
"""

import sys

_OTA_BASE = "/flash/kagura"


def _ota_rollback(base, m):
    """把管理界面装的新代码换回 src.bak/ 里的旧代码（ota.py 装代码时备份的）。"""
    import uos
    src, bak = base + "/src", base + "/src.bak"
    try:
        names = uos.listdir(bak)
    except OSError:
        names = []
    for name in names:
        try:
            uos.remove(src + "/" + name)
        except OSError:
            pass
        uos.rename(bak + "/" + name, src + "/" + name)
    for name in m.get("added", []):           # 这次新加的模块：旧版本里没有，删掉
        try:
            uos.remove(src + "/" + name)
        except OSError:
            pass
    try:
        for name in uos.listdir(src):
            if name.endswith(".new"):
                uos.remove(src + "/" + name)
        uos.rmdir(bak)
    except OSError:
        pass
    for f in ("/data/ota_pending.json", "/data/ota_state.json"):
        try:
            uos.remove(base + f)
        except OSError:
            pass
    try:                                       # 开机上报会把这行带给服务端
        with open(base + "/data/crash.log", "a") as f:
            f.write("ota rollback: new code {} failed to boot, restored backup\n".format(m.get("ver", "?")))
    except OSError:
        pass


def _ota_guard(base, failed=False, max_boots=3):
    """刚 OTA 过（data/ota_pending.json 还在）：起不来就回滚；反复复位 max_boots 次也回滚。
    返回 True = 回滚了，调用方应复位。新代码心跳成功一次后 ota.py 会删掉这个标记。"""
    import ujson
    mark = base + "/data/ota_pending.json"
    try:
        with open(mark) as f:
            m = ujson.load(f)
    except Exception:
        return False
    m["boots"] = m.get("boots", 0) + 1
    if failed or m["boots"] > max_boots:
        _ota_rollback(base, m)
        return True
    with open(mark, "w") as f:
        ujson.dump(m, f)
    return False


try:
    if _ota_guard(_OTA_BASE):
        import machine
        machine.reset()
except Exception as e:                     # noqa: BLE001 —— 回滚逻辑本身出错也别挡住开机
    print("ota guard err:", e)

sys.path.insert(0, _OTA_BASE + "/src")

try:
    import app
    app.main()
except Exception as e:                     # noqa: BLE001 —— 引导层要兜住一切
    try:                                   # 刚换的新代码起不来：回滚并复位，不停在红屏
        if _ota_guard(_OTA_BASE, failed=True):
            import machine
            machine.reset()
    except Exception:
        pass
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
