#!/usr/bin/env python3
"""尼康 Z 系列 Wi-Fi 探测脚本（PTP/IP）：看相机在「连接至电脑」模式下支持哪些指令。

只用 Python 标准库，Windows / macOS / Linux 都能跑（Python 3.8+）。

默认只读：握手 → GetDeviceInfo → 打开会话 → 读存储卡信息 → 读所有能读的设置项 → 关会话。
加 --liveview 取一帧实时取景画面（不按快门）；加 --shoot 真的拍一张（照片存在卡上，缩略图存到本机）。

用法：
    python nikon_probe.py                 # 不写 IP：扫一遍本机所在网段，找开着 15740 端口的相机
    python nikon_probe.py 192.168.1.23
    python nikon_probe.py 192.168.1.23 --liveview --shoot
    python nikon_probe.py 192.168.1.1 --pair       # 配对（相机停在「请启动无线传输器实用程序」那一屏时）
    python nikon_probe.py 192.168.1.23 --discover   # 诊断：扫相机全部 TCP 端口 + mDNS / SSDP 问一圈（配对界面时用）

结果打印在屏幕上，同时写进当前目录的 nikon_probe_report.json（把它发回来就行）。
GUID（这台电脑在相机那里的身份）第一次随机生成，存在 nikon_probe_guid.txt，
以后每次用同一个——相机按它认电脑，换了就要重新配对。
"""

import argparse
import json
import os
import socket
import struct
import sys
import threading
import time
import uuid

PORT = 15740
VERSION = 0x00010000

# PTP/IP 包类型
P_INIT_CMD_REQ, P_INIT_CMD_ACK, P_INIT_EVT_REQ, P_INIT_EVT_ACK, P_INIT_FAIL = 1, 2, 3, 4, 5
P_OP_REQ, P_OP_RESP, P_EVENT, P_START_DATA, P_DATA = 6, 7, 8, 9, 10
P_CANCEL, P_END_DATA, P_PROBE_REQ, P_PROBE_RESP = 11, 12, 13, 14

OPS = {
    0x1001: "GetDeviceInfo", 0x1002: "OpenSession", 0x1003: "CloseSession",
    0x1004: "GetStorageIDs", 0x1005: "GetStorageInfo", 0x1006: "GetNumObjects",
    0x1007: "GetObjectHandles", 0x1008: "GetObjectInfo", 0x1009: "GetObject",
    0x100A: "GetThumb", 0x100B: "DeleteObject", 0x100C: "SendObjectInfo",
    0x100D: "SendObject", 0x100E: "InitiateCapture", 0x100F: "FormatStore",
    0x1014: "GetDevicePropDesc", 0x1015: "GetDevicePropValue",
    0x1016: "SetDevicePropValue", 0x101B: "GetPartialObject",
    0x90C0: "Nikon.Capture", 0x90C1: "Nikon.AfDrive", 0x90C2: "Nikon.SetControlMode",
    0x90C3: "Nikon.DelImageSDRAM", 0x90C4: "Nikon.GetLargeThumb",
    0x90C7: "Nikon.CheckEvent", 0x90C8: "Nikon.DeviceReady",
    0x90CA: "Nikon.GetVendorPropCodes", 0x90CB: "Nikon.AfCaptureSDRAM",
    0x9200: "Nikon.GetPreviewImg", 0x9201: "Nikon.StartLiveView",
    0x9202: "Nikon.EndLiveView", 0x9203: "Nikon.GetLiveViewImg",
    0x9204: "Nikon.MfDrive", 0x9205: "Nikon.ChangeAfArea", 0x9206: "Nikon.AfDriveCancel",
    0x9207: "Nikon.InitiateCaptureRecInMedia", 0x9208: "Nikon.GetVendorStorageIDs",
    0x9209: "Nikon.StartMovieRecInCard", 0x920A: "Nikon.EndMovieRec",
    0x920B: "Nikon.TerminateCapture", 0x920C: "Nikon.GetDevicePTPIPInfo",
    0x9400: "Nikon.GetPartialObjectHiSpeed",
    0x9010: "Nikon.AdvancedTransfer",
    0x952B: "Nikon.GetPairingCode", 0x935A: "Nikon.ConfirmPairing",
}

EVENTS = {
    0x4001: "CancelTransaction", 0x4002: "ObjectAdded", 0x4003: "ObjectRemoved",
    0x4004: "StoreAdded", 0x4005: "StoreRemoved", 0x4006: "DevicePropChanged",
    0x4007: "ObjectInfoChanged", 0x4008: "DeviceInfoChanged", 0x400A: "StoreFull",
    0x400C: "StorageInfoChanged", 0x400D: "CaptureComplete",
    0xC101: "Nikon.ObjectAddedInSDRAM", 0xC102: "Nikon.CaptureCompleteRecInSdram",
    0xC104: "Nikon.AdvancedTransfer", 0xC105: "Nikon.PreviewImageAdded",
}

PROPS = {
    0x5001: "BatteryLevel", 0x5003: "ImageSize", 0x5004: "CompressionSetting",
    0x5005: "WhiteBalance", 0x5007: "FNumber", 0x5008: "FocalLength",
    0x500A: "FocusMode", 0x500B: "ExposureMeteringMode", 0x500C: "FlashMode",
    0x500D: "ExposureTime", 0x500E: "ExposureProgramMode", 0x500F: "ExposureIndex(ISO)",
    0x5010: "ExposureBiasCompensation", 0x5011: "DateTime", 0x5013: "StillCaptureMode",
    0x5018: "BurstNumber", 0x501C: "FocusMeteringMode",
    0xD100: "Nikon.ExposureTime", 0xD1A2: "Nikon.LiveViewStatus",
}

RESP = {
    0x2001: "OK", 0x2002: "GeneralError", 0x2003: "SessionNotOpen",
    0x2004: "InvalidTransactionID", 0x2005: "OperationNotSupported",
    0x2006: "ParameterNotSupported", 0x2007: "IncompleteTransfer",
    0x2008: "InvalidStorageId", 0x2009: "InvalidObjectHandle",
    0x200A: "DevicePropNotSupported", 0x200C: "StoreFull", 0x200D: "ObjectWriteProtected",
    0x200F: "AccessDenied", 0x2013: "StoreNotAvailable", 0x2019: "DeviceBusy",
    0x201D: "InvalidParameter", 0x201E: "SessionAlreadyOpen",
    0xA001: "Nikon.HardwareError", 0xA002: "Nikon.OutOfFocus",
    0xA003: "Nikon.ChangeCameraModeFailed", 0xA004: "Nikon.InvalidStatus",
    0xA005: "Nikon.SetPropertyNotSupported", 0xA00B: "Nikon.NotLiveView",
}

SCALAR = {1: "b", 2: "B", 3: "h", 4: "H", 5: "i", 6: "I", 7: "q", 8: "Q"}


def name(table, code):
    return "0x%04X %s" % (code, table.get(code, "?"))


class ProbeError(Exception):
    pass


# ── 收发 ─────────────────────────────────────────────────────────────

def recv_exact(sock, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(min(n - len(buf), 1 << 20))
        if not chunk:
            raise ProbeError("相机断开了连接")
        buf += chunk
    return bytes(buf)


def recv_packet(sock):
    length, ptype = struct.unpack("<II", recv_exact(sock, 8))
    if length < 8 or length > 256 * 1024 * 1024:
        raise ProbeError("收到不像 PTP/IP 的数据（长度 %d）" % length)
    return ptype, recv_exact(sock, length - 8)


def send_packet(sock, ptype, payload=b""):
    sock.sendall(struct.pack("<II", 8 + len(payload), ptype) + payload)


def utf16z(s):
    return s.encode("utf-16-le") + b"\0\0"


def read_utf16z(b, off):
    end = off
    while end + 1 < len(b) and b[end:end + 2] != b"\0\0":
        end += 2
    return b[off:end].decode("utf-16-le", "replace"), end + 2


# ── 数据集解析 ───────────────────────────────────────────────────────

class Reader:
    def __init__(self, data):
        self.b, self.o = data, 0

    def take(self, n):
        if self.o + n > len(self.b):
            raise ProbeError("数据比预期短")
        v = self.b[self.o:self.o + n]
        self.o += n
        return v

    def unpack(self, fmt):
        return struct.unpack("<" + fmt, self.take(struct.calcsize("<" + fmt)))[0]

    def u8(self):
        return self.unpack("B")

    def u16(self):
        return self.unpack("H")

    def u32(self):
        return self.unpack("I")

    def u64(self):
        return self.unpack("Q")

    def string(self):
        n = self.u8()
        if n == 0:
            return ""
        return self.take(n * 2).decode("utf-16-le", "replace").rstrip("\0")

    def arr16(self):
        return [self.u16() for _ in range(self.u32())]

    def value(self, dt):
        if dt in SCALAR:
            return self.unpack(SCALAR[dt])
        if dt in (9, 10):
            return int.from_bytes(self.take(16), "little", signed=dt == 9)
        if dt == 0xFFFF:
            return self.string()
        if dt & 0x4000 and (dt & 0xFF) in SCALAR:
            return [self.value(dt & 0xFF) for _ in range(self.u32())]
        raise ProbeError("不认识的数据类型 0x%04X" % dt)


def parse_device_info(data):
    r = Reader(data)
    info = {
        "standard_version": r.u16(), "vendor_ext_id": r.u32(), "vendor_ext_version": r.u16(),
        "vendor_ext_desc": r.string(), "functional_mode": r.u16(),
        "operations": r.arr16(), "events": r.arr16(), "properties": r.arr16(),
        "capture_formats": r.arr16(), "image_formats": r.arr16(),
    }
    info.update(manufacturer=r.string(), model=r.string(), device_version=r.string(), serial=r.string())
    return info


def parse_storage_info(data):
    r = Reader(data)
    return {
        "type": r.u16(), "filesystem": r.u16(), "access": r.u16(),
        "max_bytes": r.u64(), "free_bytes": r.u64(), "free_images": r.u32(),
        "description": r.string(), "label": r.string(),
    }


def parse_prop_desc(data):
    r = Reader(data)
    d = {"code": r.u16(), "datatype": r.u16(), "writable": r.u8() == 1}
    d["default"] = r.value(d["datatype"])
    d["current"] = r.value(d["datatype"])
    form = r.u8()
    if form == 1:
        d["range"] = [r.value(d["datatype"]) for _ in range(3)]  # min, max, step
    elif form == 2:
        d["enum"] = [r.value(d["datatype"]) for _ in range(r.u16())]
    return d


def parse_object_info(data):
    r = Reader(data)
    o = {"storage": r.u32(), "format": r.u16(), "protection": r.u16(), "size": r.u32(),
         "thumb_format": r.u16(), "thumb_size": r.u32()}
    r.take(4 * 2 + 4 * 4 + 2 + 4 * 2)  # 缩略图宽高、图像宽高位深、父对象、关联类型、关联描述、序号
    o["filename"] = r.string()
    return o


def friendly(code, v):
    """几个常见设置翻成人话；拿不准的原样给。"""
    if not isinstance(v, int):
        return v
    if code == 0x5001:
        return "%d%%" % v
    if code == 0x5007:
        return "f/%g" % (v / 100)
    if code == 0x5008:
        return "%gmm" % (v / 100)
    if code == 0x500D:
        return ("1/%d s" % round(10000 / v)) if 0 < v < 10000 else "%g s" % (v / 10000)
    if code == 0x500F:
        return "ISO %d" % v
    if code == 0x5010:
        return "%+g EV" % (v / 1000)
    if code == 0xD100:
        n, d = v >> 16, v & 0xFFFF
        return "%d/%d s" % (n, d) if d else hex(v)
    return v


# ── PTP/IP 会话 ──────────────────────────────────────────────────────

class Camera:
    def __init__(self, host, port, guid, name, timeout):
        self.host, self.port, self.guid, self.name, self.timeout = host, port, guid, name, timeout
        self.cmd = self.evt = None
        self.tid = 0
        self.events = []
        self.event_cond = threading.Condition()
        self.closed = False

    def connect(self):
        self.cmd = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self.cmd.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        send_packet(self.cmd, P_INIT_CMD_REQ, self.guid.bytes + utf16z(self.name) + struct.pack("<I", VERSION))
        ptype, body = recv_packet(self.cmd)
        if ptype == P_INIT_FAIL:
            reason = struct.unpack("<I", body[:4])[0] if len(body) >= 4 else -1
            if reason == 1:
                raise ProbeError("相机拒绝了连接（InitFail 原因码 1）：这个网络配置已经和别的电脑（别的 GUID）配对过了。"
                                 "在相机上删掉这个网络配置重建，再用 --pair 配对")
            raise ProbeError("相机拒绝了连接（InitFail，原因码 0x%X）——多半是这台电脑还没和相机配对" % reason)
        if ptype != P_INIT_CMD_ACK:
            raise ProbeError("握手回了意外的包类型 %d" % ptype)
        conn_no = struct.unpack("<I", body[:4])[0]
        cam_guid = uuid.UUID(bytes=body[4:20])
        cam_name, off = read_utf16z(body, 20)
        cam_ver = struct.unpack("<I", body[off:off + 4])[0] if len(body) >= off + 4 else None

        self.evt = socket.create_connection((self.host, self.port), timeout=self.timeout)
        send_packet(self.evt, P_INIT_EVT_REQ, struct.pack("<I", conn_no))
        ptype, body = recv_packet(self.evt)
        if ptype != P_INIT_EVT_ACK:
            raise ProbeError("事件通道握手失败（包类型 %d）" % ptype)
        self.evt.settimeout(1.0)
        threading.Thread(target=self._event_loop, daemon=True).start()
        return {"connection": conn_no, "camera_guid": str(cam_guid), "camera_name": cam_name,
                "protocol_version": hex(cam_ver) if cam_ver is not None else None}

    def _event_loop(self):
        while not self.closed:
            try:
                ptype, body = recv_packet(self.evt)
            except socket.timeout:
                continue
            except (OSError, ProbeError):
                return
            if ptype == P_PROBE_REQ:
                try:
                    send_packet(self.evt, P_PROBE_RESP)
                except OSError:
                    return
            elif ptype == P_EVENT and len(body) >= 6:
                code, tid = struct.unpack("<HI", body[:6])
                params = list(struct.unpack("<%dI" % ((len(body) - 6) // 4), body[6:6 + (len(body) - 6) // 4 * 4]))
                ev = {"t": round(time.time(), 3), "code": code, "name": EVENTS.get(code, "?"), "params": params}
                print("    [事件] %s %s" % (name(EVENTS, code), " ".join("0x%X" % p for p in params)))
                with self.event_cond:
                    self.events.append(ev)
                    self.event_cond.notify_all()

    def wait_event(self, codes, since, timeout):
        end = time.time() + timeout
        with self.event_cond:
            while True:
                for ev in self.events[since:]:
                    if ev["code"] in codes:
                        return ev
                left = end - time.time()
                if left <= 0:
                    return None
                self.event_cond.wait(left)

    def transact(self, op, params=()):
        if op == 0x1002:  # PTP 规定 OpenSession 的事务号是 0，之后从 1 数起
            self.tid = -1
        self.tid += 1
        tid = self.tid
        send_packet(self.cmd, P_OP_REQ, struct.pack("<IHI", 1, op, tid) + struct.pack("<%dI" % len(params), *params))
        data = bytearray()
        while True:
            ptype, body = recv_packet(self.cmd)
            if ptype in (P_DATA, P_END_DATA):
                data += body[4:]
            elif ptype == P_START_DATA:
                pass
            elif ptype == P_OP_RESP:
                code = struct.unpack("<H", body[:2])[0]
                n = (len(body) - 6) // 4
                rparams = list(struct.unpack("<%dI" % n, body[6:6 + n * 4]))
                return code, rparams, bytes(data)
            elif ptype == P_PROBE_REQ:
                send_packet(self.cmd, P_PROBE_RESP)
            else:
                raise ProbeError("指令通道收到意外的包类型 %d" % ptype)

    def transact_retry(self, op, params=(), tries=20):
        """相机忙（DeviceBusy）就等一下再试。"""
        for _ in range(tries):
            code, rp, data = self.transact(op, params)
            if code != 0x2019:
                return code, rp, data
            time.sleep(0.2)
        return code, rp, data

    def wait_ready(self, seconds=5):
        """尼康的 DeviceReady：忙的时候回 DeviceBusy。"""
        end = time.time() + seconds
        code = None
        while time.time() < end:
            code, _, _ = self.transact(0x90C8)
            if code != 0x2019:
                return code
            time.sleep(0.1)
        return code

    def close(self):
        self.closed = True
        for s in (self.cmd, self.evt):
            try:
                if s:
                    s.close()
            except OSError:
                pass


# ── 主流程 ───────────────────────────────────────────────────────────

def load_guid(arg, path):
    if arg:
        return uuid.UUID(arg)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return uuid.UUID(f.read().strip())
    g = uuid.uuid4()
    with open(path, "w", encoding="utf-8") as f:
        f.write(str(g) + "\n")
    return g


def local_ips():
    """本机在局域网里的 IPv4 地址（不发包，只借 UDP connect 问系统走哪块网卡）。"""
    ips = set()
    for probe_ip in ("192.168.1.1", "10.0.0.1", "172.16.0.1", "8.8.8.8"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((probe_ip, 9))
            ips.add(s.getsockname()[0])
            s.close()
        except OSError:
            pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127.") and not ip.startswith("169.254."))


def scan(port, timeout=0.4):
    """把本机所在的每个 /24 网段扫一遍，返回开着 port 的地址。"""
    found = []
    lock = threading.Lock()
    nets = sorted({ip.rsplit(".", 1)[0] for ip in local_ips()})
    print("  扫描网段：%s" % ("、".join(n + ".0/24" for n in nets) or "（没找到本机地址）"))
    targets = ["%s.%d" % (n, i) for n in nets for i in range(1, 255)]

    def worker(chunk):
        for ip in chunk:
            try:
                socket.create_connection((ip, port), timeout=timeout).close()
                with lock:
                    found.append(ip)
            except OSError:
                pass

    threads = [threading.Thread(target=worker, args=(targets[i::64],), daemon=True) for i in range(64)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return sorted(found, key=lambda ip: tuple(int(x) for x in ip.split(".")))


# ── 诊断：配对界面时相机开了什么 ─────────────────────────────────────

def port_scan(host, ports=range(1, 65536), timeout=0.6, workers=256):
    found = []
    lock = threading.Lock()
    ports = list(ports)

    def worker(chunk):
        for p in chunk:
            try:
                socket.create_connection((host, p), timeout=timeout).close()
                with lock:
                    found.append(p)
                print("    端口 %d 开着" % p)
            except OSError:
                pass

    threads = [threading.Thread(target=worker, args=(ports[i::workers],), daemon=True) for i in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return sorted(found)


def dns_name(labels):
    out = b""
    for part in labels.split("."):
        out += bytes([len(part)]) + part.encode()
    return out + b"\0"


def printable_runs(b, n=4):
    runs, cur = [], bytearray()
    for c in b:
        if 32 <= c < 127:
            cur.append(c)
        else:
            if len(cur) >= n:
                runs.append(cur.decode())
            cur = bytearray()
    if len(cur) >= n:
        runs.append(cur.decode())
    return runs


def mdns_query(services, wait=3.0):
    """从临时端口发 mDNS 查询：对方会单播回给我们，不用占 5353。"""
    replies = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(0.3)
    for svc in services:
        q = struct.pack(">HHHHHH", 0, 0, 1, 0, 0, 0) + dns_name(svc) + struct.pack(">HH", 12, 0x8001)
        try:
            s.sendto(q, ("224.0.0.251", 5353))
        except OSError as e:
            replies.append({"error": str(e)})
    end = time.time() + wait
    while time.time() < end:
        try:
            data, addr = s.recvfrom(9000)
        except socket.timeout:
            continue
        except OSError:
            break
        replies.append({"from": addr[0], "strings": printable_runs(data)})
    s.close()
    return replies


def ssdp_search(wait=3.0):
    replies = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(0.3)
    msg = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\n"
           "MX: 2\r\nST: ssdp:all\r\n\r\n").encode()
    try:
        s.sendto(msg, ("239.255.255.250", 1900))
    except OSError as e:
        return [{"error": str(e)}]
    end = time.time() + wait
    while time.time() < end:
        try:
            data, addr = s.recvfrom(9000)
        except socket.timeout:
            continue
        except OSError:
            break
        replies.append({"from": addr[0], "text": data.decode("utf-8", "replace")})
    s.close()
    return replies


def discover(host, out):
    rep = {"host": host}
    step("诊断 1/3：扫 %s 的全部 TCP 端口（约 2~3 分钟）" % host)
    rep["open_tcp"] = port_scan(host)
    print("  开着的端口：%s" % (rep["open_tcp"] or "一个都没有"))
    step("诊断 2/3：mDNS")
    svcs = ["_services._dns-sd._udp.local", "_ptp._tcp.local", "_nikon._tcp.local", "_http._tcp.local"]
    rep["mdns"] = mdns_query(svcs)
    for r in rep["mdns"]:
        mark = "  ← 相机" if r.get("from") == host else ""
        print("  %s %s%s" % (r.get("from", ""), " | ".join(r.get("strings", [])) or r.get("error", ""), mark))
    if not rep["mdns"]:
        print("  没有回应")
    step("诊断 3/3：SSDP")
    rep["ssdp"] = ssdp_search()
    for r in rep["ssdp"]:
        if r.get("from") == host:
            print("  相机回应：\n    " + r["text"].strip().replace("\r\n", "\n    "))
    others = sorted({r["from"] for r in rep["ssdp"] if r.get("from") and r["from"] != host})
    if others:
        print("  其它设备回应：%s" % "、".join(others))
    if not any(r.get("from") == host for r in rep["ssdp"]):
        print("  相机没回应 SSDP")
    path = os.path.join(out, "nikon_discover_report.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=2)
    print("\n报告：%s" % os.path.abspath(path))
    return 0


# ── 配对（libgphoto2 issue #1314 逆向出来的流程，作者在 Nikon ZR 上验证；Z6 II 是否相同未知） ──

def parse_pair_code(data):
    """0x952B 的数据：uint32 位数 + 每位一个字节（0~9 的数值，不是 ASCII）。"""
    r = Reader(data)
    n = r.u32()
    digits = r.take(n)
    if any(d > 9 for d in digits):
        raise ProbeError("配对码格式不认识：%s" % data.hex())
    return "".join(str(d) for d in digits)


def pair(cam, report, err, ask=None, confirm_wait=120, reconnect_wait=60):
    ask = ask or input
    res = report.setdefault("pairing", {})
    h = cam.connect()
    res["handshake"] = h
    print("  ✅ 握手成功：相机「%s」" % h["camera_name"])
    code, _, _ = cam.transact(0x1002, (1,))  # 规定：OpenSession 之后紧接着取配对码，中间不能插别的指令
    res["open_session"] = name(RESP, code)
    if code not in (0x2001, 0x201E):
        err("配对 OpenSession", name(RESP, code))
        return False
    code, _, data = cam.transact(0x952B)
    res["get_code"] = name(RESP, code)
    if code != 0x2001:
        err("取配对码 0x952B", name(RESP, code) + "（相机可能不走这套配对流程）")
        return False
    pin = parse_pair_code(data)
    res["code"] = pin
    print("  配对码：%s" % pin)
    ans = ask("  相机屏幕上显示的也是 %s 吗？对得上直接回车，不对输入 n 回车：" % pin).strip().lower()
    if ans.startswith("n"):
        err("配对", "配对码对不上，已取消")
        return False
    since = len(cam.events)
    code, _, _ = cam.transact(0x935A, (0x2001,))
    res["confirm"] = name(RESP, code)
    if code != 0x2001:
        err("确认配对 0x935A", name(RESP, code))
        return False
    print("  现在请在相机上确认这台电脑（%d 秒内）…" % confirm_wait)
    ev = cam.wait_event({0x4008}, since, confirm_wait)
    res["confirmed_event"] = ev is not None
    if ev is None:
        print("  没等到相机的确认事件，照样试着重连")
    else:
        print("  ✅ 相机已确认")
    cam.close()  # 不发 CloseSession：相机会直接重置连接
    print("  相机会重启 Wi-Fi，等它回来…")
    end = time.time() + reconnect_wait
    time.sleep(2)
    while time.time() < end:
        c2 = Camera(cam.host, cam.port, cam.guid, cam.name, cam.timeout)
        try:
            c2.connect()
            c2.close()
            res["reconnected"] = True
            print("  ✅ 配对完成，用同一个 GUID 重新连上了")
            return True
        except (OSError, ProbeError) as e:
            c2.close()
            res["last_retry_error"] = str(e)
            time.sleep(2)
    err("配对后重连", res.get("last_retry_error", "超时"))
    return False


def step(title):
    print("\n== " + title)


def main(argv=None):
    ap = argparse.ArgumentParser(description="尼康 Z 系列 Wi-Fi（PTP/IP）探测")
    ap.add_argument("host", nargs="?", help="相机的 IP 地址（不写就扫描本机所在网段）")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--name", default="Kagura", help="在相机那里显示的电脑名（默认 Kagura）")
    ap.add_argument("--guid", help="指定 GUID（不填就用 nikon_probe_guid.txt 里的，没有就新生成）")
    ap.add_argument("--timeout", type=float, default=10.0)
    ap.add_argument("--liveview", action="store_true", help="取一帧实时取景画面（不按快门）")
    ap.add_argument("--shoot", action="store_true", help="真的拍一张，缩略图存到本机")
    ap.add_argument("--out", default=".", help="报告和图片放哪个目录（默认当前目录）")
    ap.add_argument("--discover", action="store_true", help="诊断：扫相机全部端口 + mDNS / SSDP（要写 IP）")
    ap.add_argument("--pair", action="store_true", help="先配对（相机停在配对界面时），成功后接着探测")
    a = ap.parse_args(argv)

    os.makedirs(a.out, exist_ok=True)
    if a.discover:
        if not a.host:
            print("--discover 要写相机的 IP")
            return 1
        return discover(a.host, a.out)
    if not a.host:
        step("0. 找相机（端口 %d）" % a.port)
        found = scan(a.port)
        if not found:
            print("  ❌ 没找到。确认相机停在配对 / 已连接的界面、和电脑连的是同一个 Wi-Fi；也可以直接写 IP 再试")
            return 1
        if len(found) > 1:
            print("  找到好几个：%s——请把相机的那个 IP 写在命令后面再跑一次" % "、".join(found))
            return 1
        a.host = found[0]
        print("  ✅ 找到相机：%s" % a.host)
    report = {"script": "nikon_probe 1", "host": a.host, "time": time.strftime("%Y-%m-%d %H:%M:%S"),
              "errors": []}
    guid = load_guid(a.guid, os.path.join(a.out, "nikon_probe_guid.txt"))
    report["our_guid"], report["our_name"] = str(guid), a.name
    cam = Camera(a.host, a.port, guid, a.name, a.timeout)
    report_path = os.path.join(a.out, "nikon_probe_report.json")

    def err(where, msg):
        print("  ❌ %s：%s" % (where, msg))
        report["errors"].append({"step": where, "error": msg})

    try:
        if a.pair:
            step("配对 %s:%d（GUID %s，名字 %s）" % (a.host, a.port, guid, a.name))
            try:
                ok = pair(cam, report, err)
            except OSError as e:
                raise ProbeError("配对时连不上 %s:%d（%s）" % (a.host, a.port, e))
            cam.close()
            if not ok:
                raise ProbeError("配对没成功")
            cam = Camera(a.host, a.port, guid, a.name, a.timeout)
        step("1. 连接 %s:%d（GUID %s，名字 %s）" % (a.host, a.port, guid, a.name))
        print("  如果相机屏幕上弹出确认，请在相机上点「是」。")
        try:
            report["handshake"] = cam.connect()
        except (socket.timeout, ConnectionRefusedError, OSError) as e:
            if isinstance(e, ProbeError):
                raise
            raise ProbeError("连不上 %s:%d（%s）。确认相机已在「连接至电脑」里开启 Wi-Fi 连接、"
                             "和这台电脑在同一个网络、IP 没写错" % (a.host, a.port, e))
        h = report["handshake"]
        print("  ✅ 握手成功：相机「%s」 GUID %s 协议 %s" % (h["camera_name"], h["camera_guid"], h["protocol_version"]))

        step("2. GetDeviceInfo")
        code, _, data = cam.transact(0x1001)
        if code != 0x2001:
            raise ProbeError("GetDeviceInfo 失败：%s" % name(RESP, code))
        info = parse_device_info(data)
        report["device_info"] = dict(info,
                                     operations=[name(OPS, c) for c in info["operations"]],
                                     events=[name(EVENTS, c) for c in info["events"]],
                                     properties=[name(PROPS, c) for c in info["properties"]],
                                     capture_formats=["0x%04X" % c for c in info["capture_formats"]],
                                     image_formats=["0x%04X" % c for c in info["image_formats"]])
        print("  %s %s 固件 %s 扩展 %s" % (info["manufacturer"], info["model"], info["device_version"], info["vendor_ext_desc"]))
        print("  支持 %d 个指令、%d 种事件、%d 个设置项" % (len(info["operations"]), len(info["events"]), len(info["properties"])))
        for c in info["operations"]:
            print("    " + name(OPS, c))
        ops = set(info["operations"])

        step("3. OpenSession")
        code, _, _ = cam.transact(0x1002, (1,))
        if code not in (0x2001, 0x201E):
            raise ProbeError("打开会话失败：%s" % name(RESP, code))
        print("  ✅ 会话已打开")

        step("4. 存储卡")
        code, _, data = cam.transact_retry(0x1004)
        storages = []
        if code == 0x2001:
            ids = Reader(data)
            for sid in [ids.u32() for _ in range(ids.u32())]:
                c2, _, d2 = cam.transact_retry(0x1005, (sid,))
                if c2 == 0x2001:
                    s = dict(parse_storage_info(d2), id="0x%08X" % sid)
                    print("  卡 %s：剩 %.1f/%.1f GB，约 %d 张 %s" % (s["id"], s["free_bytes"] / 1e9, s["max_bytes"] / 1e9,
                                                            s["free_images"], s["description"]))
                else:
                    s = {"id": "0x%08X" % sid, "error": name(RESP, c2)}
                    print("  卡 %s：%s" % (s["id"], s["error"]))
                storages.append(s)
        else:
            err("GetStorageIDs", name(RESP, code))
        report["storages"] = storages

        step("5. 设置项")
        props = list(info["properties"])
        if 0x90CA in ops:
            code, _, data = cam.transact_retry(0x90CA)
            if code == 0x2001 and data:
                extra = Reader(data).arr16()
                report["vendor_prop_codes"] = ["0x%04X" % c for c in extra]
                props += [c for c in extra if c not in props]
                print("  GetVendorPropCodes 额外给了 %d 个" % len(extra))
            else:
                err("GetVendorPropCodes", name(RESP, code))
        descs = []
        for pc in props:
            code, _, data = cam.transact_retry(0x1014, (pc,))
            if code != 0x2001:
                descs.append({"code": "0x%04X" % pc, "error": name(RESP, code)})
                continue
            try:
                d = parse_prop_desc(data)
            except ProbeError as e:
                descs.append({"code": "0x%04X" % pc, "error": str(e), "raw": data.hex()})
                continue
            d["code"] = "0x%04X" % pc
            d["name"] = PROPS.get(pc, "?")
            d["datatype"] = "0x%04X" % d["datatype"]
            d["current_friendly"] = friendly(pc, d["current"])
            descs.append(d)
            if pc in PROPS:
                opts = ""
                if "enum" in d:
                    opts = "，可选 %d 项" % len(d["enum"])
                elif "range" in d:
                    opts = "，范围 %s~%s 步长 %s" % tuple(d["range"])
                print("  %-28s = %s（%s%s）" % (name(PROPS, pc), d["current_friendly"], "可改" if d["writable"] else "只读", opts))
        ok = sum(1 for d in descs if "error" not in d)
        print("  共读到 %d/%d 个（其余的完整内容在报告里）" % (ok, len(descs)))
        report["properties"] = descs

        if a.liveview:
            step("6. 实时取景")
            report["liveview"] = liveview(cam, ops, a.out, err)

        if a.shoot:
            step("7. 拍一张")
            report["shoot"] = shoot(cam, ops, a.out, err)

        time.sleep(1.0)
        cam.transact(0x1003)
        print("\n✅ 探测完成")
    except ProbeError as e:
        err("致命", str(e))
    except Exception as e:  # 意外错误也写进报告
        err("意外", "%s: %s" % (type(e).__name__, e))
    finally:
        cam.close()
        report["events"] = [dict(ev, code="0x%04X" % ev["code"]) for ev in cam.events]
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print("报告：%s" % os.path.abspath(report_path))
    return 0 if not report["errors"] else 1


def liveview(cam, ops, out, err):
    res = {}
    if 0x9201 not in ops or 0x9203 not in ops:
        err("liveview", "相机没列出 StartLiveView / GetLiveViewImg")
        return res
    code, _, _ = cam.transact_retry(0x9201)
    res["start"] = name(RESP, code)
    if code != 0x2001:
        err("StartLiveView", name(RESP, code))
        return res
    res["ready"] = name(RESP, cam.wait_ready(5)) if 0x90C8 in ops else "n/a"
    try:
        frame = None
        for _ in range(20):
            code, _, data = cam.transact(0x9203)
            if code == 0x2001 and data:
                frame = data
                break
            time.sleep(0.2)
        res["get"] = name(RESP, code)
        if frame is None:
            err("GetLiveViewImg", name(RESP, code))
            return res
        soi = frame.find(b"\xff\xd8")
        res["bytes"], res["header_bytes"] = len(frame), soi
        res["header_hex"] = frame[:soi].hex() if soi > 0 else ""
        if soi < 0:
            err("GetLiveViewImg", "数据里找不到 JPEG")
            return res
        path = os.path.join(out, "nikon_liveview.jpg")
        with open(path, "wb") as f:
            f.write(frame[soi:])
        res["file"] = path
        print("  ✅ 取到一帧（%d 字节，头 %d 字节）→ %s" % (len(frame), soi, os.path.abspath(path)))
    finally:
        code, _, _ = cam.transact_retry(0x9202)
        res["end"] = name(RESP, code)
    return res


def shoot(cam, ops, out, err):
    res = {}
    since = len(cam.events)
    code, _, _ = cam.transact_retry(0x100E, (0, 0))
    res["initiate_capture"] = name(RESP, code)
    if code != 0x2001:
        err("InitiateCapture", name(RESP, code))
        return res
    print("  快门已触发，等相机报告新照片…")
    ev = cam.wait_event({0x4002}, since, 20)
    if ev is None:
        err("shoot", "20 秒内没等到 ObjectAdded 事件")
        return res
    handle = ev["params"][0] if ev["params"] else 0
    res["handle"] = "0x%08X" % handle
    if 0x90C8 in ops:
        cam.wait_ready(10)
    code, _, data = cam.transact_retry(0x1008, (handle,))
    if code == 0x2001:
        try:
            res["object"] = parse_object_info(data)
            print("  新照片：%s（%d 字节）" % (res["object"]["filename"], res["object"]["size"]))
        except ProbeError as e:
            res["object_raw"] = data.hex()
            err("GetObjectInfo", str(e))
    else:
        err("GetObjectInfo", name(RESP, code))
    code, _, data = cam.transact_retry(0x100A, (handle,))
    res["thumb"] = name(RESP, code)
    if code == 0x2001 and data:
        path = os.path.join(out, "nikon_shot_thumb.jpg")
        with open(path, "wb") as f:
            f.write(data)
        res["thumb_file"], res["thumb_bytes"] = path, len(data)
        print("  ✅ 缩略图 %d 字节 → %s" % (len(data), os.path.abspath(path)))
    else:
        err("GetThumb", name(RESP, code))
    return res


if __name__ == "__main__":
    sys.exit(main())
