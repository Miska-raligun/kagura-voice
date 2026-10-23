"""Kagura Voice 设备端 —— 设备文件同步：管理界面传图 / 换代码，设备自己来拉。

服务端 MQTT 下发 {"action":"sync","scope":"res"|"code"|"all"}，主循环空闲时 run_sync()：
GET /device/files?scope=… 拿清单（路径 + 大小 + sha256）→ 跟本地比 → 只下载变了的 → 校验 → 装上。
开机也会悄悄同步一次图片（boot()），离线时传的图下次开机就到。

- 图片（resource/…）：下载成 .new、校验通过再替换，换完清 ui 的图片缓存，下次重画就是新图。
- 代码（src/…）：先把变了的全部下载成 .new 并校验，**屏幕上点「更新」才装**（20 秒不点作废）。
  装的时候先写 data/ota_pending.json，再把旧文件挪进 src.bak/、新文件换上，然后复位。
  新代码开机跑通（心跳成功一次）才 _mark_good() 删掉标记和备份；起不来或反复复位，
  /flash/main.py 看到标记还在，就从 src.bak/ 回滚（见 device/main.py 的 _ota_guard）。
  旧版 main.py 没有回滚逻辑——确认界面会提示，固件包里的新 main.py 要手动传一次。
- data/ota_state.json 记 {路径: sha256}，**只管自己装过的文件**：用 File Manager 手动传的
  文件不在里面，清单里没有它也不会被删。
"""

from M5 import *
import time
import gc
import uos
import ujson
import ubinascii
import requests as urequests

try:
    import hashlib
except ImportError:
    hashlib = None

import cfg
import hw
import ui
import diag

_STATE_PATH   = cfg.data("ota_state.json")


_PENDING_PATH = cfg.data("ota_pending.json")


_BAK_DIR      = cfg.BASE_DIR + "/src.bak"


_CONFIRM_SECS = 20


_state  = None       # ota_state.json 的内容（懒加载）


_pending = False     # 刚装完新代码、还没确认它跑通


# ── 小工具 ─────────────────────────────────────────────────────

def _load_state():
    global _state
    if _state is None:
        try:
            with open(_STATE_PATH) as f:
                _state = ujson.load(f)
        except Exception:
            _state = {}
        if not isinstance(_state.get("files"), dict):
            _state["files"] = {}
    return _state


def _save_state():
    try:
        tmp = _STATE_PATH + ".tmp"
        with open(tmp, "w") as f:
            ujson.dump(_load_state(), f)
        _remove(_STATE_PATH)
        uos.rename(tmp, _STATE_PATH)
    except Exception as e:
        print("[ota] state save err:", e)


def _publish_info():
    """把同步状态交给心跳上报。"""
    st = _load_state()
    info = {}
    for k_src, k_dst in (("code", "fw"), ("res", "res"), ("ver", "fwv")):
        if st.get(k_src):
            info[k_dst] = st[k_src]
    diag._ota_info = info


def _remove(path):
    try:
        uos.remove(path)
        return True
    except OSError:
        return False


def _size(path):
    try:
        return uos.stat(path)[6]
    except OSError:
        return -1


def _abs(p):
    return cfg.BASE_DIR + "/" + p


def _safe(p):
    """清单里的路径只认 src/<名>.py 和 resource/[角色/]<名>.jpg，防目录穿越。"""
    if not isinstance(p, str) or ".." in p or "//" in p or p.startswith("/"):
        return False
    parts = p.split("/")
    if parts[0] == "src":
        return len(parts) == 2 and p.endswith(".py")
    if parts[0] == "resource":
        return 2 <= len(parts) <= 3 and p.endswith(".jpg")
    return False


def _mkdirs(path):
    """建好 path 所在的各级目录。"""
    cur = ""
    for seg in path.split("/")[1:-1]:
        cur += "/" + seg
        try:
            uos.mkdir(cur)
        except OSError:
            pass


def _hex(h):
    return ubinascii.hexlify(h.digest()).decode()


def _file_sha(path):
    h = hashlib.sha256()
    buf = bytearray(2048)
    try:
        with open(path, "rb") as f:
            while True:
                hw._wdt_feed()
                n = f.readinto(buf)
                if not n:
                    break
                h.update(memoryview(buf)[:n])
    except OSError:
        return ""
    return _hex(h)


def _rev(entries):
    """一组文件的指纹，算法与服务端 DeviceFiles.rev 相同（按路径排序的 "p:h" 逐行拼接）。"""
    h = hashlib.sha256()
    h.update("\n".join(["{}:{}".format(e["p"], e["h"]) for e in entries]).encode())
    return _hex(h)[:12]


def _report(scope, ok, changed=0, removed=0, error=""):
    try:
        resp = urequests.post(
            cfg.SERVER_BASE + "/device/sync-result",
            data=ujson.dumps({"device_id": cfg.DEVICE_ID, "scope": scope, "ok": ok,
                              "changed": changed, "removed": removed, "error": error}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            timeout=cfg.REQUEST_TIMEOUT_SHORT,
        )
        resp.close()
    except Exception as e:
        print("[ota] report err:", e)


def _fetch_manifest(scope):
    resp = urequests.get(cfg.SERVER_BASE + "/device/files?scope=" + scope,
                         timeout=cfg.REQUEST_TIMEOUT_SHORT)
    try:
        if resp.status_code != 200:
            raise OSError("manifest http {}".format(resp.status_code))
        return resp.json()
    finally:
        resp.close()


def _download(p, n, h, dest):
    """下载一个文件到 dest，边写边算 sha256。返回 "" = 成功，否则是错误原因（dest 已删）。"""
    _mkdirs(dest)
    err = ""
    resp = None
    try:
        resp = urequests.get(cfg.SERVER_BASE + "/device/file?p=" + p, timeout=cfg.REQUEST_TIMEOUT_SHORT)
        if resp.status_code != 200:
            err = "http {}".format(resp.status_code)
        else:
            sh = hashlib.sha256()
            total = 0
            raw = getattr(resp, "raw", None)
            with open(dest, "wb") as f:
                if raw is None or not hasattr(raw, "readinto"):
                    data = resp.content
                    sh.update(data)
                    w = f.write(data)
                    total = len(data) if w is None else w
                else:
                    buf = bytearray(4096)
                    mv = memoryview(buf)
                    while total < n:            # 按清单长度读，不指望连接一定会关
                        hw._wdt_feed()
                        k = raw.readinto(buf)
                        if not k:
                            break
                        w = f.write(mv[:k])
                        if w is None:
                            w = k
                        if w < k:               # flash 满了：f.write 只少写、不抛异常
                            err = "flash full"
                            break
                        sh.update(mv[:k])
                        total += k
            if not err and total != n:
                err = "size {}/{}".format(total, n)
            elif not err and _hex(sh) != h:
                err = "sha mismatch"
    except Exception as e:
        err = "dl {}".format(e)
    finally:
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass
    if err:
        _remove(dest)
        print("[ota] download", p, "failed:", err)
    return err


def _plan(entries, prefix):
    """对比清单与本地，返回 (要下载的条目, 要删除的路径)。大小对得上、hash 也对得上的直接认领。"""
    files = _load_state()["files"]
    want = {}
    todo = []
    for e in entries:
        p = e.get("p") or ""
        if not p.startswith(prefix) or not _safe(p):
            continue
        want[p] = True
        local = _abs(p)
        size = _size(local)
        if size == e["n"] and files.get(p) == e["h"]:
            continue
        if size == e["n"] and _file_sha(local) == e["h"]:
            files[p] = e["h"]                   # 手动传过一样的文件：认领，不重下
            continue
        todo.append(e)
    gone = [p for p in files if p.startswith(prefix) and p not in want]
    return todo, gone


# ── 图片 ───────────────────────────────────────────────────────

def _sync_res(entries):
    todo, gone = _plan(entries, "resource/")
    files = _load_state()["files"]
    changed = 0
    for e in todo:
        local = _abs(e["p"])
        err = _download(e["p"], e["n"], e["h"], local + ".new")
        if err:
            return changed, 0, "{}: {}".format(e["p"], err)
        _remove(local)
        uos.rename(local + ".new", local)
        files[e["p"]] = e["h"]
        changed += 1
        gc.collect()
    for p in gone:
        _remove(_abs(p))
        del files[p]
    if changed or gone:
        # 图片缓存都按路径记，换了图要清：否则「之前没有这张」的记录会让新图一直不显示
        ui._role_hit.clear()
        ui._img_missing.clear()
        ui._ui_invalidate()
    return changed, len(gone), ""


# ── 代码 ───────────────────────────────────────────────────────

def _main_has_guard():
    try:
        with open("/flash/main.py") as f:
            return "ota_pending" in f.read()
    except OSError:
        return False


def _confirm(n_files, ver):
    """屏幕上问一句。返回 True = 用户点了「更新」。"""
    ui._ui_invalidate()
    bg = 0x101828
    Lcd.fillScreen(bg)
    cn = ui._FONT_CN
    Lcd.setFont(cn or ui._FONT_16)
    Lcd.setTextColor(0xffffff, bg)
    guard = _main_has_guard()
    if cn:
        lines = ["有新的设备代码", "{} 个文件  版本 {}".format(n_files, ver or "?"),
                 "装完会自动重启" if guard else "注意：main.py 太旧，失败不能自动回滚"]
    else:
        lines = ["New device code", "{} files  v{}".format(n_files, ver or "?"),
                 "Will reboot after install" if guard else "Old main.py: no auto rollback"]
    y = 30
    for ln in lines:
        Lcd.drawString(ln, 16, y)
        y += 34
    Lcd.fillRect(10, 170, 145, 60, 0x1f7a3a)
    Lcd.fillRect(165, 170, 145, 60, 0x5a5a5a)
    Lcd.setTextColor(0xffffff, 0x1f7a3a)
    Lcd.drawString("更新" if cn else "UPDATE", 50 if cn else 40, 190)
    Lcd.setTextColor(0xffffff, 0x5a5a5a)
    Lcd.drawString("取消" if cn else "CANCEL", 210 if cn else 200, 190)
    hw.drain_touch()
    hw.touch_reset()
    t0 = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), t0) < _CONFIRM_SECS * 1000:
        hw._wdt_feed()
        ev, pos = hw.check_touch()
        if ev in ("short", "long") and pos[1] >= 160:
            return pos[0] < 160
        time.sleep(0.05)
    return False


def _clear_bak():
    try:
        for name in uos.listdir(_BAK_DIR):
            _remove(_BAK_DIR + "/" + name)
        uos.rmdir(_BAK_DIR)
    except OSError:
        pass


def _mark_good():
    """新代码跑通了：删掉回滚标记与备份。"""
    global _pending
    _pending = False
    _remove(_PENDING_PATH)
    _clear_bak()
    diag.dbg("ota: new code ok")


def _sync_code(entries, rev, ver):
    todo, gone = _plan(entries, "src/")
    st = _load_state()
    if not todo and not gone:
        st["code"] = rev
        st["ver"] = ver
        return 0, 0, ""
    # 1. 全部下载、校验成 .new —— 任何一个失败就全部作废，绝不装半套
    for e in todo:
        err = _download(e["p"], e["n"], e["h"], _abs(e["p"]) + ".new")
        if err:
            for x in todo:
                _remove(_abs(x["p"]) + ".new")
            return 0, 0, "{}: {}".format(e["p"], err)
        gc.collect()
    # 2. 用户确认
    ok = _confirm(len(todo) + len(gone), ver)
    ui.draw_state("idle", force=True)
    if not ok:
        for x in todo:
            _remove(_abs(x["p"]) + ".new")
        return 0, 0, "设备上没有确认"
    # 3. 先写回滚标记，再换文件（中途断电，main.py 也能凭标记回滚）
    _clear_bak()
    try:
        uos.mkdir(_BAK_DIR)
    except OSError:
        pass
    added = [e["p"].split("/")[1] for e in todo if _size(_abs(e["p"])) < 0]
    with open(_PENDING_PATH, "w") as f:
        ujson.dump({"ver": ver, "boots": 0, "added": added}, f)
    for e in todo:
        local = _abs(e["p"])
        name = e["p"].split("/")[1]
        if _size(local) >= 0:
            uos.rename(local, _BAK_DIR + "/" + name)
        uos.rename(local + ".new", local)
        st["files"][e["p"]] = e["h"]
    for p in gone:
        local = _abs(p)
        if _size(local) >= 0:
            uos.rename(local, _BAK_DIR + "/" + p.split("/")[1])
        del st["files"][p]
    st["code"] = rev
    st["ver"] = ver
    return len(todo), len(gone), ""


# ── 入口 ───────────────────────────────────────────────────────

def run_sync(scope, quiet=False):
    """主循环空闲时调用（MQTT sync 命令 / 开机）。quiet=True：开机那次，没变化就不上报。"""
    if scope not in ("res", "code", "all"):
        return
    if hashlib is None:
        _report(scope, False, error="固件没有 hashlib，无法校验")
        return
    cfg.St.stage = "ota"
    diag.dbg("ota sync " + scope)
    try:
        man = _fetch_manifest(scope)
    except Exception as e:
        print("[ota] manifest err:", e)
        if not quiet:
            _report(scope, False, error="拿不到清单: {}".format(e))
        return
    entries = man.get("files", [])
    ver = man.get("version", "")
    changed = removed = 0
    err = ""
    code_changed = 0
    try:
        if scope in ("res", "all"):
            res = [e for e in entries if e.get("p", "").startswith("resource/")]
            c, r, err = _sync_res(res)
            changed += c
            removed += r
            if not err:
                _load_state()["res"] = _rev(res)
        if not err and scope in ("code", "all"):
            code = [e for e in entries if e.get("p", "").startswith("src/")]
            code_changed, r, err = _sync_code(code, _rev(code), ver)
            changed += code_changed
            removed += r
            code_changed += r
    except Exception as e:
        err = "{}".format(e)
    _save_state()
    _publish_info()
    diag.dbg("ota {} changed={} removed={} {}".format(scope, changed, removed, err or "ok"))
    if changed or removed or err or not quiet:
        _report(scope, not err, changed, removed, err)
    if code_changed and not err:
        diag._persist_dbg("ota-reboot")
        time.sleep(1)
        import machine
        machine.reset()
    if changed or removed:
        ui.draw_state("idle", force=True)


def boot():
    """开机调用（setup 里，发现服务端之后）：读同步状态、看看上次装的新代码是不是待确认，再同步一次图片。"""
    global _pending
    _publish_info()
    _pending = _size(_PENDING_PATH) >= 0
    if _pending:
        diag.dbg("ota: running new code, waiting for first heartbeat")
    run_sync("res", quiet=True)


def tick():
    """主循环调用：新代码跑到心跳成功一次，就算它跑通了。"""
    if _pending and diag._hb_ok:
        _mark_good()
