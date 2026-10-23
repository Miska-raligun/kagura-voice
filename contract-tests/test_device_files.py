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
        srv.post("/heartbeat", json={"device_id": "files2"})
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
