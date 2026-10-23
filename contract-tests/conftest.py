"""契约测试：只通过 HTTP / MQTT / UDP / TCP 和被测服务端打交道，不碰任何内部函数。

同一套用例先对 Python 版（voice_server.py）跑绿，再对 TypeScript 版（server/）跑绿——
这是「现有功能原样支持」的验收标准。用法见 README.md。

被测服务端通过环境变量切换：
  KAGURA_SERVER_CMD       启动命令（默认：python voice_server.py）。命令里可以用
                          {port} {mqtt_port} {stream_port} {disc_port} {data} 占位
  KAGURA_SERVER_PROVIDES  被测服务端自带的组件，逗号分隔：broker,discovery
                          （TS 版内置 MQTT broker 与 UDP 发现；Python 版两者都要外部拉起）
"""

import json
import os
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest
import requests

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
PROVIDES = {x.strip() for x in os.environ.get("KAGURA_SERVER_PROVIDES", "").split(",") if x.strip()}


def _free_port(kind=socket.SOCK_STREAM) -> int:
    s = socket.socket(socket.AF_INET, kind)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_http(url: str, proc: subprocess.Popen, log: Path, timeout: float = 20) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"被测服务端启动即退出（rc={proc.returncode}）：\n{log.read_text(errors='replace')[-3000:]}")
        try:
            if requests.get(url, timeout=1).status_code == 200:
                return
        except requests.RequestException:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"等不到 {url}：\n{log.read_text(errors='replace')[-3000:]}")


class Server:
    """一个被测服务端实例（含它依赖的 broker / 发现中继）。"""

    def __init__(self, api_token: str = "", roles: list | None = None, stream_token: str = ""):
        self.data = Path(tempfile.mkdtemp(prefix="kagura-contract-"))
        self.port = _free_port()
        self.mqtt_port = _free_port()
        self.stream_port = _free_port()
        self.disc_port = _free_port(socket.SOCK_DGRAM)
        self.api_token = api_token
        self.base = f"http://127.0.0.1:{self.port}"
        self._procs: list[subprocess.Popen] = []
        # Python 版从 config.py 读密钥；放进数据目录并加到 PYTHONPATH 最前
        cfg = [
            'BAIDU_API_KEY = "x"', 'BAIDU_SECRET_KEY = "x"',
            'BAIDU_TTS_API_KEY = "x"', 'BAIDU_TTS_SECRET_KEY = "x"',
            f'API_TOKEN = {api_token!r}', f'STREAM_TOKEN = {stream_token!r}',
        ]
        if roles is not None:
            cfg.append(f"ROLES = {roles!r}")
        (self.data / "config.py").write_text("\n".join(cfg) + "\n", encoding="utf-8")
        (self.data / "kagura-test-config.json").write_text(json.dumps(
            {"api_token": api_token, "stream_token": stream_token, "roles": roles}, ensure_ascii=False), encoding="utf-8")

    def _spawn(self, args, name: str, env: dict, cwd: Path) -> subprocess.Popen:
        log = self.data / f"{name}.log"
        p = subprocess.Popen(args, cwd=cwd, env=env, stdout=open(log, "wb"), stderr=subprocess.STDOUT)
        self._procs.append(p)
        return p

    def start(self) -> "Server":
        env = dict(os.environ)
        env.update({
            "KAGURA_FAKE_PROVIDERS": "1",
            "KAGURA_PORT": str(self.port),
            "KAGURA_MQTT_HOST": "127.0.0.1",
            "KAGURA_MQTT_PORT": str(self.mqtt_port),
            "KAGURA_STREAM_PORT": str(self.stream_port),
            "KAGURA_DISC_PORT": str(self.disc_port),
            "KAGURA_DATA_DIR": str(self.data),
            "KAGURA_OPENCLAW_DIR": str(self.data / "openclaw"),
            "KAGURA_TEST_CONFIG": str(self.data / "kagura-test-config.json"),
            "PYTHONPATH": str(self.data) + os.pathsep + env.get("PYTHONPATH", ""),
            "PYTHONUNBUFFERED": "1",
        })
        if "broker" not in PROVIDES:
            p = self._spawn([sys.executable, str(HERE / "_broker.py"), str(self.mqtt_port)], "broker", env, HERE)
            deadline = time.time() + 10
            while "BROKER-READY" not in (self.data / "broker.log").read_text(errors="replace"):
                if time.time() > deadline or p.poll() is not None:
                    raise RuntimeError("MQTT broker 起不来：" + (self.data / "broker.log").read_text(errors="replace"))
                time.sleep(0.1)
        if "discovery" not in PROVIDES:
            self._spawn([sys.executable, str(ROOT / "discovery_relay.py")], "discovery", env, ROOT)
        cmd = os.environ.get("KAGURA_SERVER_CMD") or f"{shlex.quote(sys.executable)} voice_server.py"
        cmd = cmd.format(port=self.port, mqtt_port=self.mqtt_port, stream_port=self.stream_port,
                         disc_port=self.disc_port, data=self.data)
        proc = self._spawn(shlex.split(cmd), "server", env, ROOT)
        _wait_http(self.base + "/health", proc, self.data / "server.log")
        # Python 版连 broker 是异步的，等它真的连上（/api/monitor/state 的 mqtt 字段）
        deadline = time.time() + 10
        while time.time() < deadline:
            st = self.get("/api/monitor/state").json()
            if st.get("mqtt"):
                break
            time.sleep(0.2)
        return self

    def stop(self) -> None:
        for p in reversed(self._procs):
            p.terminate()
        for p in self._procs:
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()

    def log(self) -> str:
        return (self.data / "server.log").read_text(errors="replace")

    # ── HTTP ──
    def _h(self, headers):
        h = dict(headers or {})
        if self.api_token and "X-Api-Token" not in h:
            h["X-Api-Token"] = self.api_token
        return h

    def get(self, path, headers=None, **kw):
        return requests.get(self.base + path, headers=self._h(headers), timeout=kw.pop("timeout", 15), **kw)

    def post(self, path, headers=None, **kw):
        return requests.post(self.base + path, headers=self._h(headers), timeout=kw.pop("timeout", 30), **kw)

    def request(self, method, path, headers=None, **kw):
        return requests.request(method, self.base + path, headers=self._h(headers), timeout=15, **kw)

    # ── /__fake 控制协议 ──
    def fake_reset(self):
        self.post("/__fake/reset").raise_for_status()

    def fake_asr(self, *texts):
        self.post("/__fake/asr", json={"queue": list(texts)}).raise_for_status()

    def fake_llm(self, *replies):
        self.post("/__fake/llm", json={"queue": list(replies)}).raise_for_status()

    def fake_log(self) -> dict:
        return self.get("/__fake/log").json()


class Device:
    """模拟一台 CoreS3：订阅自己的 push/cmd topic，能按服务端命令上传照片。"""

    def __init__(self, server: Server, device_id: str):
        import paho.mqtt.client as mqtt
        self.server = server
        self.id = device_id
        self.push: list[dict] = []
        self.cmds: list[dict] = []
        self._cv = threading.Condition()
        self._c = mqtt.Client(client_id=f"sim-{device_id}-{time.time_ns()}")
        self._c.on_message = self._on_msg
        subscribed = threading.Event()
        self._c.on_subscribe = lambda *a: subscribed.set()
        self._c.connect("127.0.0.1", server.mqtt_port)
        self._c.subscribe([(f"kagura/push/{device_id}", 1), (f"kagura/cmd/{device_id}", 1)])
        self._c.loop_start()
        assert subscribed.wait(5), "模拟设备订阅 MQTT 超时"

    def _on_msg(self, client, userdata, msg):
        data = json.loads(msg.payload)
        with self._cv:
            (self.push if "/push/" in msg.topic else self.cmds).append(data)
            self._cv.notify_all()

    def wait(self, kind: str, pred=lambda m: True, timeout: float = 10) -> dict:
        box = self.push if kind == "push" else self.cmds
        deadline = time.time() + timeout
        with self._cv:
            while True:
                for m in box:
                    if pred(m):
                        box.remove(m)
                        return m
                left = deadline - time.time()
                if left <= 0:
                    raise AssertionError(f"{timeout}s 内没收到 {kind}（已收到：{box}）")
                self._cv.wait(left)

    def close(self):
        self._c.loop_stop()
        self._c.disconnect()


# ── fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def server():
    s = Server().start()
    yield s
    s.stop()


@pytest.fixture()
def srv(server):
    """每个用例开头清空假服务商的脚本和记录。"""
    server.fake_reset()
    return server


@pytest.fixture()
def device(srv, request):
    d = Device(srv, "dev" + str(abs(hash(request.node.name)) % 10**6))
    yield d
    d.close()


@pytest.fixture(scope="module")
def token_server():
    s = Server(api_token="s3cret", stream_token="st0k").start()
    yield s
    s.stop()


ROLES_2 = [
    {"id": "", "name": "神乐", "agent": "main", "per": 111, "aliases": ["kagura"]},
    {"id": "mio", "name": "小澪", "agent": "mio", "per": 4, "aliases": ["小玲"]},
]


@pytest.fixture(scope="module")
def roles_server():
    s = Server(roles=ROLES_2).start()
    yield s
    s.stop()


# ── 测试数据 ────────────────────────────────────────────────────────────────

def wav(seconds: float = 0.5, amp: int = 1000) -> bytes:
    """16k 单声道 16bit 的 WAV（方波），给 /chat 上传用。"""
    import struct
    n = int(16000 * seconds)
    body = b"".join(struct.pack("<h", amp if (i // 20) % 2 else -amp) for i in range(n))
    return struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + len(body), b'WAVE', b'fmt ', 16, 1, 1,
                       16000, 32000, 2, 16, b'data', len(body)) + body


def rgb565(w: int = 320, h: int = 240) -> bytes:
    return bytes([0xF8, 0x00]) * (w * h)      # 大端纯红


def b64(data: bytes) -> str:
    import base64
    return base64.b64encode(data).decode()


def b64text(h: str) -> str:
    import base64
    return base64.b64decode(h).decode("utf-8")
