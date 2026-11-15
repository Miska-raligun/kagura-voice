"""tools/nikon_probe.py：用一台假的 PTP/IP 相机把握手、取数据、事件、取景、拍照都走一遍。"""

import importlib.util
import json
import os
import socket
import struct
import threading

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "nikon_probe", os.path.join(os.path.dirname(__file__), "..", "tools", "nikon_probe.py"))
probe = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(probe)

JPEG = b"\xff\xd8\xff\xe0fake-jpeg\xff\xd9"


def ptp_str(s):
    return struct.pack("<B", len(s) + 1) + (s + "\0").encode("utf-16-le")


def arr16(xs):
    return struct.pack("<I", len(xs)) + struct.pack("<%dH" % len(xs), *xs)


def device_info():
    return (struct.pack("<HIH", 100, 0x0A, 100) + ptp_str("microsoft.com: 1.0;") + struct.pack("<H", 0)
            + arr16([0x1001, 0x1002, 0x1003, 0x1004, 0x1005, 0x1008, 0x100A, 0x100E, 0x1014,
                     0x90C8, 0x90CA, 0x9201, 0x9202, 0x9203])
            + arr16([0x4002, 0x4006]) + arr16([0x5001, 0x5007, 0x500D])
            + arr16([0x3801]) + arr16([0x3801, 0x3000])
            + ptp_str("Nikon Corporation") + ptp_str("Z 6_2") + ptp_str("V1.70") + ptp_str("1234567"))


PROPS = {
    # BatteryLevel：u8，范围 0~100 步长 1
    0x5001: struct.pack("<HHB", 0x5001, 2, 0) + struct.pack("<BB", 100, 80) + b"\x01" + struct.pack("<BBB", 0, 100, 1),
    # FNumber：u16 枚举
    0x5007: struct.pack("<HHB", 0x5007, 4, 1) + struct.pack("<HH", 400, 560) + b"\x02" + struct.pack("<H", 3) + struct.pack("<3H", 400, 560, 800),
    # 厂商额外给的、读不了
    0xD1A2: None,
}


def object_info():
    return (struct.pack("<IHHIHI", 0x00010001, 0x3801, 0, 24_000_000, 0x3801, len(JPEG))
            + struct.pack("<6I", 160, 120, 6048, 4024, 24, 0) + struct.pack("<HII", 0, 0, 0) + ptp_str("DSC_0001.JPG"))


class FakeCamera:
    def __init__(self, reject=False):
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(2)
        self.port = self.srv.getsockname()[1]
        self.reject = reject
        self.seen_ops = []
        self.guid = None
        self.busy_once = True
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        while True:  # 扫描时「连上就断」的空连接跳过
            cmd, _ = self.srv.accept()
            try:
                ptype, body = probe.recv_packet(cmd)
                break
            except probe.ProbeError:
                cmd.close()
        assert ptype == probe.P_INIT_CMD_REQ
        self.guid = body[:16]
        if self.reject:
            probe.send_packet(cmd, probe.P_INIT_FAIL, struct.pack("<I", 1))
            cmd.close()
            return
        probe.send_packet(cmd, probe.P_INIT_CMD_ACK,
                          struct.pack("<I", 7) + b"\x11" * 16 + probe.utf16z("Z_6_2") + struct.pack("<I", 0x10000))
        evt, _ = self.srv.accept()
        ptype, body = probe.recv_packet(evt)
        assert ptype == probe.P_INIT_EVT_REQ and struct.unpack("<I", body)[0] == 7
        probe.send_packet(evt, probe.P_INIT_EVT_ACK)
        probe.send_packet(evt, probe.P_PROBE_REQ)  # 相机偶尔探活，脚本要回
        try:
            while True:
                ptype, body = probe.recv_packet(cmd)
                if ptype == probe.P_PROBE_RESP:
                    continue
                _, op, tid = struct.unpack("<IHI", body[:10])
                params = struct.unpack("<%dI" % ((len(body) - 10) // 4), body[10:])
                self.seen_ops.append(op)
                code, data = self.handle(op, params, evt)
                if data is not None:
                    probe.send_packet(cmd, probe.P_START_DATA, struct.pack("<IQ", tid, len(data)))
                    half = len(data) // 2
                    probe.send_packet(cmd, probe.P_DATA, struct.pack("<I", tid) + data[:half])
                    probe.send_packet(cmd, probe.P_END_DATA, struct.pack("<I", tid) + data[half:])
                probe.send_packet(cmd, probe.P_OP_RESP, struct.pack("<HI", code, tid))
        except (probe.ProbeError, OSError):
            pass

    def handle(self, op, params, evt):
        if op == 0x1001:
            return 0x2001, device_info()
        if op == 0x1004:
            return 0x2001, struct.pack("<II", 1, 0x00010001)
        if op == 0x1005:
            return 0x2001, struct.pack("<HHHQQI", 4, 3, 0, 64_000_000_000, 32_000_000_000, 900) + ptp_str("CFexpress") + ptp_str("")
        if op == 0x90CA:
            return 0x2001, arr16([0xD1A2])
        if op == 0x1014:
            d = PROPS.get(params[0])
            return (0x2001, d) if d else (0x200A, None)
        if op == 0x90C8:
            if self.busy_once:
                self.busy_once = False
                return 0x2019, None
            return 0x2001, None
        if op == 0x9203:
            return 0x2001, b"\x00" * 384 + JPEG
        if op == 0x100E:
            probe.send_packet(evt, probe.P_EVENT, struct.pack("<HII", 0x4002, 0, 0x0001ABCD))
            return 0x2001, None
        if op == 0x1008:
            assert params[0] == 0x0001ABCD
            return 0x2001, object_info()
        if op == 0x100A:
            return 0x2001, JPEG
        return 0x2001, None  # OpenSession / CloseSession / Start/EndLiveView


def test_full_probe(tmp_path):
    cam = FakeCamera()
    rc = probe.main(["127.0.0.1", "--port", str(cam.port), "--out", str(tmp_path), "--liveview", "--shoot"])
    report = json.loads((tmp_path / "nikon_probe_report.json").read_text(encoding="utf-8"))
    assert rc == 0, report["errors"]
    assert report["device_info"]["model"] == "Z 6_2"
    assert report["device_info"]["device_version"] == "V1.70"
    assert "0x9203 Nikon.GetLiveViewImg" in report["device_info"]["operations"]
    assert report["storages"][0]["free_images"] == 900
    props = {p["code"]: p for p in report["properties"]}
    assert props["0x5007"]["current_friendly"] == "f/5.6" and props["0x5007"]["enum"] == [400, 560, 800]
    assert props["0x5001"]["range"] == [0, 100, 1] and props["0x5001"]["writable"] is False
    assert "error" in props["0x500D"] and "error" in props["0xD1A2"]
    assert report["liveview"]["header_bytes"] == 384
    assert (tmp_path / "nikon_liveview.jpg").read_bytes() == JPEG
    assert report["shoot"]["object"]["filename"] == "DSC_0001.JPG"
    assert (tmp_path / "nikon_shot_thumb.jpg").read_bytes() == JPEG
    assert cam.seen_ops[-1] == 0x1003  # 最后关会话
    # GUID 落盘、下次沿用
    saved = (tmp_path / "nikon_probe_guid.txt").read_text().strip()
    assert cam.guid == probe.uuid.UUID(saved).bytes


def test_rejected_pairing(tmp_path):
    cam = FakeCamera(reject=True)
    rc = probe.main(["127.0.0.1", "--port", str(cam.port), "--out", str(tmp_path)])
    report = json.loads((tmp_path / "nikon_probe_report.json").read_text(encoding="utf-8"))
    assert rc == 1
    assert "配对" in report["errors"][0]["error"]


def test_unreachable(tmp_path):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    rc = probe.main(["127.0.0.1", "--port", str(port), "--out", str(tmp_path), "--timeout", "2"])
    report = json.loads((tmp_path / "nikon_probe_report.json").read_text(encoding="utf-8"))
    assert rc == 1 and "连不上" in report["errors"][0]["error"]


def test_scan_finds_fake_camera(tmp_path, monkeypatch):
    cam = FakeCamera()
    monkeypatch.setattr(probe, "local_ips", lambda: ["127.0.0.5"])
    assert probe.scan(cam.port, timeout=0.2) == ["127.0.0.1"]
    rc = probe.main(["--port", str(cam.port), "--out", str(tmp_path)])
    assert rc == 0
