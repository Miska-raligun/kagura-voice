"""设备直播流接收端：一条常驻 TCP 连接收 RGB565 裸帧，只保留最新一帧。

为什么不复用 /upload-photo：那条路每帧都要新建 TCP 连接、拼 JSON、base64
（体积 +33%）、再走一遍 HTTP 头解析。ESP32 上这些开销比传输本身还贵。
这里改成常驻 socket + 4 字节长度前缀的裸帧，把每帧成本压到只剩传输。

协议（设备 → 服务端，全大端）：
    握手  : b"KAGURA_STREAM v1 <device_id> <token>\\n"
    每帧  : <4 字节长度><该长度的 RGB565 裸字节>
    结束  : <4 字节 0>
服务端不回任何数据——设备只管发，断了就重连。
"""

from __future__ import annotations

import re
import socket
import struct
import threading
import time
from typing import Callable, Optional

HOST = "0.0.0.0"
PORT = 5002
MAX_FRAME_BYTES = 400 * 1024     # 单帧上限：QVGA RGB565 是 150KB，留足余量
HANDSHAKE_MAX = 256
# 设备静默超过这个秒数就断开，防止死连接占线程。放宽到 45s 是因为直播中
# 插拍高清照时设备会停发十几秒（切分辨率 ×2 + 曝光收敛 + 205KB 上传），
# 按 20s 算会把正常的插拍误判成掉线。
SOCKET_TIMEOUT = 45.0
STALE_AFTER = 10.0               # 最新帧超过这个秒数没更新，视为已经不在直播

_DEVICE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,32}$")

_lock = threading.Lock()
_latest: dict[str, dict] = {}    # device_id → {"jpeg", "ts", "seq", "started", "frames"}
_to_jpeg: Optional[Callable[[bytes], Optional[bytes]]] = None
_token: str = ""
_server_sock: Optional[socket.socket] = None


# ── 查询接口（给 Flask 路由用） ───────────────────────────────────────────────

def latest(device_id: str) -> Optional[dict]:
    """最新一帧的副本，没有则 None。"""
    with _lock:
        rec = _latest.get(device_id)
        return dict(rec) if rec else None


def stats(device_id: str) -> dict:
    """直播状态：是否活跃、已收帧数、实测 fps。"""
    with _lock:
        rec = _latest.get(device_id)
        if not rec:
            return {"live": False, "frames": 0, "fps": 0.0}
        age = time.time() - rec["ts"]
        # 下限 1 秒：刚开播时 elapsed 接近 0，不夹一下会算出几万 fps 这种鬼数字
        elapsed = max(rec["ts"] - rec["started"], 1.0)
        return {
            "live": age < STALE_AFTER,
            "frames": rec["frames"],
            "fps": round(rec["frames"] / elapsed, 1) if rec["frames"] > 1 else 0.0,
            "age": round(age, 1),
            "size": rec.get("size", 0),
        }


def drop(device_id: str) -> None:
    """清掉某设备的最新帧（停止直播时调用，免得网页一直显示最后一张）。"""
    with _lock:
        _latest.pop(device_id, None)


# ── 接收 ─────────────────────────────────────────────────────────────────────

class _Reader:
    """带缓冲的 socket 读取器。

    握手行和紧随其后的第一帧多半会被 TCP 合并进同一个 segment，
    所以读握手时必然会多收到帧的头几个字节——这些必须留在缓冲里给帧解析，
    丢掉就会让整条流错位（表现为"帧长度离谱然后断开"）。
    """

    def __init__(self, conn: socket.socket) -> None:
        self.conn = conn
        self.buf = bytearray()

    def _fill(self) -> bool:
        try:
            chunk = self.conn.recv(65536)
        except (socket.timeout, OSError):
            return False
        if not chunk:
            return False
        self.buf += chunk
        return True

    def read_line(self, limit: int) -> Optional[bytes]:
        while b"\n" not in self.buf:
            if len(self.buf) > limit:
                return None
            if not self._fill():
                return None
        line, _, rest = bytes(self.buf).partition(b"\n")
        self.buf = bytearray(rest)
        return line

    def read_exactly(self, n: int) -> Optional[bytes]:
        while len(self.buf) < n:
            if not self._fill():
                return None
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out


def _read_handshake(reader: "_Reader") -> Optional[tuple[str, str]]:
    """读到第一个换行为止，解析 device_id 与 token。"""
    line = reader.read_line(HANDSHAKE_MAX)
    if line is None:
        return None
    parts = line.decode("utf-8", "replace").strip().split()
    if len(parts) < 3 or parts[0] != "KAGURA_STREAM" or parts[1] != "v1":
        return None
    device_id = parts[2]
    token = parts[3] if len(parts) > 3 else ""
    if not _DEVICE_ID_RE.match(device_id):
        return None
    return device_id, token


def _handle_conn(conn: socket.socket, addr) -> None:
    conn.settimeout(SOCKET_TIMEOUT)
    device_id = None
    reader = _Reader(conn)
    frames = 0
    started = time.time()
    try:
        hs = _read_handshake(reader)
        if hs is None:
            print(f"[stream] ⚠️  {addr} 握手失败，断开")
            return
        device_id, token = hs
        if _token and token != _token:
            print(f"[stream] ⚠️  {device_id} token 不匹配，拒绝")
            return

        print(f"[stream] ▶️  {device_id} 开始直播 (来自 {addr[0]})")
        started = time.time()
        with _lock:
            _latest[device_id] = {"jpeg": None, "ts": started, "seq": 0,
                                  "started": started, "frames": 0, "size": 0}

        while True:
            head = reader.read_exactly(4)
            if head is None:
                break
            (n,) = struct.unpack(">I", head)
            if n == 0:
                print(f"[stream] ⏹  {device_id} 正常结束")
                break
            if n > MAX_FRAME_BYTES:
                print(f"[stream] ⚠️  {device_id} 帧过大 {n}，断开")
                break
            raw = reader.read_exactly(n)
            if raw is None:
                break
            jpeg = _to_jpeg(raw) if _to_jpeg else None
            if jpeg is None:
                continue                      # 尺寸对不上等：跳过这帧，别断流
            frames += 1
            with _lock:
                rec = _latest.get(device_id)
                if rec is None:               # 期间被 drop 了，说明已要求停止
                    break
                rec.update(jpeg=jpeg, ts=time.time(), seq=rec["seq"] + 1,
                           frames=frames, size=len(jpeg))
    except Exception as e:
        print(f"[stream] ⚠️  连接异常 {addr}: {e}")
    finally:
        try:
            conn.close()
        except OSError:
            pass
        if device_id:
            # 用本地计数而不是 stats()：停止直播时 drop() 已经把记录清掉了，
            # 查 stats 只会拿到 0，日志就成了"共 0 帧"这种假消息。
            fps = round(frames / max(time.time() - started, 1.0), 1)
            print(f"[stream] ⏹  {device_id} 直播结束，共 {frames} 帧 / {fps} fps")


def _accept_loop() -> None:
    while True:
        try:
            conn, addr = _server_sock.accept()
        except OSError as e:
            print(f"[stream] accept 失败: {e}")
            time.sleep(1)
            continue
        threading.Thread(target=_handle_conn, args=(conn, addr),
                         daemon=True, name="stream-conn").start()


def init(to_jpeg: Callable[[bytes], Optional[bytes]], token: str = "",
         port: int = PORT) -> bool:
    """启动 TCP 接收线程。端口占用等失败时返回 False，不影响主服务启动。"""
    global _server_sock, _to_jpeg, _token, PORT
    _to_jpeg = to_jpeg
    PORT = port          # 下发 stream_start 时告诉设备连哪个端口，必须是实际监听的那个
    _token = token or ""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((HOST, port))
        sock.listen(4)
        _server_sock = sock
    except OSError as e:
        print(f"⚠️  直播端口 {port} 启动失败（直播功能不可用）: {e}")
        return False
    threading.Thread(target=_accept_loop, daemon=True, name="stream-accept").start()
    print(f"直播流监听 {HOST}:{port}")
    return True
