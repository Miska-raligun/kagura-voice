"""设备文件同步（管理界面传图 / 换代码 → 设备自己拉）：新服务端才有，两种大脑都跑。

设备侧：GET /device/files、GET /device/file、POST /device/sync-result；管理侧：/api/admin/device-files*。
"""
import base64
import hashlib
import os

import pytest

from conftest import Device

pytestmark = pytest.mark.skipif("broker" not in os.environ.get("KAGURA_SERVER_PROVIDES", ""),
                                reason="只有新服务端（TS）有设备文件同步")

JPG = b"\xff\xd8\xff\xe0" + b"fake-jpeg" * 50


def _put(s, p, data):
    return s.request("PUT", "/api/admin/device-files", json={"p": p, "b64": base64.b64encode(data).decode()})


def test_builtin_firmware_in_manifest(srv):
    m = srv.get("/device/files?scope=code").json()
    names = {f["p"] for f in m["files"]}
    assert {"src/app.py", "src/cfg.py", "src/ota.py"} <= names, "构建时要把 device/src 打进来"
    f = next(x for x in m["files"] if x["p"] == "src/app.py")
    body = srv.get("/device/file?p=src/app.py").content
    assert len(body) == f["n"] and hashlib.sha256(body).hexdigest() == f["h"]
    assert len(m["rev"]) == 12 and m["version"]


def test_upload_image_syncs_device(srv):
    d = Device(srv, "files1")
    try:
        srv.post("/heartbeat", json={"device_id": "files1"})
        assert _put(srv, "resource/mio/img_bg.jpg", JPG).status_code == 200
        cmd = d.wait("cmd", lambda m: m.get("action") == "sync", timeout=8)
        assert cmd["scope"] == "res"
        m = srv.get("/device/files?scope=res").json()
        assert [f["p"] for f in m["files"]] == ["resource/mio/img_bg.jpg"]
        assert srv.get("/device/file?p=resource/mio/img_bg.jpg").content == JPG
        # 设备回报结果，管理界面看得到
        srv.post("/device/sync-result", json={"device_id": "files1", "scope": "res", "ok": True, "changed": 1})
        srv.post("/heartbeat", json={"device_id": "files1", "res": m["rev"]})
        st = srv.get("/api/admin/device-files").json()
        dev = next(x for x in st["devices"] if x["id"] == "files1")
        assert dev["res_rev"] == st["res_rev"] and dev["last_sync"]["ok"] is True
        assert any(s["base"] == "img_bg" for s in st["slots"])
        # 删除也会通知同步
        assert srv.request("DELETE", "/api/admin/device-files?p=resource/mio/img_bg.jpg").status_code == 200
        d.wait("cmd", lambda m: m.get("action") == "sync", timeout=8)
        assert srv.get("/device/files?scope=res").json()["files"] == []
    finally:
        d.close()


def test_code_override_and_manual_sync(srv):
    d = Device(srv, "files2")
    try:
        srv.post("/heartbeat", json={"device_id": "files2", "ota": 1})
        before = srv.get("/device/files?scope=code").json()["rev"]
        assert _put(srv, "src/app.py", b"print('mine')\n").status_code == 200
        assert srv.get("/device/file?p=src/app.py").content == b"print('mine')\n"
        assert srv.get("/device/files?scope=code").json()["rev"] != before
        r = srv.post("/api/admin/device-files/sync", json={"scope": "code", "device": "files2"})
        assert r.status_code == 200 and r.json()["sent"] == ["files2"]
        assert d.wait("cmd", lambda m: m.get("action") == "sync")["scope"] == "code"
        # 删覆盖 = 回到内置
        r = srv.request("DELETE", "/api/admin/device-files?p=src/app.py")
        assert r.json()["restored_builtin"] is True
        assert srv.get("/device/files?scope=code").json()["rev"] == before
    finally:
        d.close()


def test_rejects_bad_paths_and_content(srv):
    assert srv.get("/device/file?p=../config.json").status_code == 400
    assert srv.get("/device/file?p=resource/nope.jpg").status_code == 404
    assert _put(srv, "src/../../x.py", b"x").status_code == 400
    assert _put(srv, "resource/img_bg.jpg", b"\x89PNG not jpeg").status_code == 400
    assert _put(srv, "main.py", b"x").status_code == 400


def test_old_firmware_flagged_not_synced(srv):
    """旧固件（心跳里没有 ota 标记）不认 sync 命令：不发，明确告诉用户要先用 USB 刷一次。"""
    d = Device(srv, "files3")
    try:
        srv.post("/heartbeat", json={"device_id": "files3"})
        r = srv.post("/api/admin/device-files/sync", json={"scope": "code", "device": "files3"}).json()
        assert r["sent"] == [] and r["unsupported"] == ["files3"]
        st = srv.get("/api/admin/device-files").json()
        assert next(x for x in st["devices"] if x["id"] == "files3")["ota_capable"] is False
        # 已经是最新的不再打扰
        rev = srv.get("/device/files?scope=code").json()["rev"]
        srv.post("/heartbeat", json={"device_id": "files3", "ota": 1, "fw": rev})
        r = srv.post("/api/admin/device-files/sync", json={"scope": "code", "device": "files3"}).json()
        assert r["sent"] == [] and r["up_to_date"] == ["files3"]
    finally:
        d.close()


def test_pull_images_from_device(srv):
    """「从设备取回图片」：管理界面点了才收，受信设备、只收 JPEG、服务端已有的不覆盖。"""
    d = Device(srv, "files4")
    try:
        srv.post("/heartbeat", json={"device_id": "files4", "ota": 1})
        srv.post("/api/admin/devices/files4/trust", json={"trusted": True})
        up = lambda p, body=JPG: srv.request("POST", f"/device/upload-res?device_id=files4&p={p}", data=body,
                                             headers={"Content-Type": "image/jpeg", "X-Device-Id": "files4"})
        # 没点「取回」不收
        assert up("resource/img_bg.jpg").status_code == 403
        # 固件不认 → 管理界面直接说要先更新代码
        r = srv.post("/api/admin/device-files/pull", json={"device": "files4"})
        assert r.status_code == 409 and "更新设备代码" in r.json()["error"]
        srv.post("/heartbeat", json={"device_id": "files4", "ota": 1, "pull": 1})
        assert srv.post("/api/admin/device-files/pull", json={"device": "files4"}).status_code == 200
        d.wait("cmd", lambda m: m.get("action") == "upload_res", timeout=8)
        assert _put(srv, "resource/files4keep/img_bg.jpg", JPG + b"mine").status_code == 200
        assert up("resource/img_shake.jpg").status_code == 200
        assert up("resource/files4keep/img_bg.jpg").status_code == 409       # 服务端已有：不覆盖
        assert up("resource/img_bg.jpg", b"not a jpeg").status_code == 400
        assert up("src/app.py").status_code == 400
        assert srv.get("/device/file?p=resource/img_shake.jpg").content == JPG
        assert srv.get("/device/file?p=resource/files4keep/img_bg.jpg").content == JPG + b"mine"
        srv.post("/device/sync-result", json={"device_id": "files4", "scope": "upload", "ok": True, "changed": 1, "removed": 1})
        dev = next(x for x in srv.get("/api/admin/device-files").json()["devices"] if x["id"] == "files4")
        assert dev["can_pull"] and dev["last_sync"]["scope"] == "upload"
        # 回报完就关窗口
        assert up("resource/img_recording.jpg").status_code == 403
    finally:
        for p in ("resource/img_shake.jpg", "resource/files4keep/img_bg.jpg"):
            srv.request("DELETE", f"/api/admin/device-files?p={p}")
        d.close()
