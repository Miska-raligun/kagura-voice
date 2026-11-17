#!/usr/bin/env python3
"""设备端回归：真的设备代码（device/src，硬件打桩）对着真的服务端（打包好的程序 + 假服务商）跑对话。

import_sim.py 用假响应验设备这头的逻辑，契约测试用假设备验服务端——两边各自都绿，协议对不上也看不出来
（响应头改了名、流式音频的格式变了、长轮询的状态码换了）。这里把两头接起来：改了服务端的设备协议，不用烧录就知道设备还认不认。

用法（先 cd server && node scripts/build.mjs）:
    KAGURA_SERVER_CMD="node server/dist/kagura.cjs" python3 tools/device_e2e.py
需要 pip install requests。打桩的只有硬件（屏幕、麦克风、扬声器、摄像头、MQTT），HTTP 是真的。
"""
import base64, json, os, shlex, socket, struct, subprocess, sys, tempfile, time

import requests as real_requests                      # 必须先于桩件 import：设备的 `import requests` 要换成下面的包装

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from device_stubs import stub, QSpeaker               # noqa: E402  装好 M5 / network / machine 等桩件


class _Resp:
    """把 requests 的响应包成设备固件里那个样子：headers.get、status_code、raw.readinto、json()、text、close()"""
    def __init__(self, r):
        self._r, self.status_code, self.headers, self.raw = r, r.status_code, r.headers, r.raw
    @property
    def text(self): return self._r.text
    def json(self): return self._r.json()
    def close(self): self._r.close()

calls = []
def _wrap(method):
    def go(url, data=None, headers=None, timeout=None, **kw):
        calls.append((method, url.split("//", 1)[-1].split("/", 1)[-1]))
        return _Resp(real_requests.request(method, url, data=data, headers=headers, timeout=timeout, stream=True))
    return go
stub("requests", get=_wrap("GET"), post=_wrap("POST"))

for name in ["cfg", "hw", "clock", "ui", "wifisetup", "snd", "cam", "feel", "diag", "ota", "netsvc", "stream", "chat", "app"]:
    __import__(name)
import cfg, hw, ui, snd, cam, netsvc, chat            # noqa: E402


# ── 被测服务端 ──────────────────────────────────────────────────────────────
def free_port(kind=socket.SOCK_STREAM):
    s = socket.socket(socket.AF_INET, kind); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

cmd = os.environ.get("KAGURA_SERVER_CMD")
if not cmd:
    sys.exit('先设 KAGURA_SERVER_CMD，如 KAGURA_SERVER_CMD="node server/dist/kagura.cjs"')
data = tempfile.mkdtemp(prefix="kagura-device-e2e-")
port = free_port()
env = dict(os.environ, KAGURA_FAKE_PROVIDERS="1", KAGURA_BRAIN="pi", KAGURA_PORT=str(port), KAGURA_MQTT_HOST="127.0.0.1",
           KAGURA_MQTT_PORT=str(free_port()), KAGURA_STREAM_PORT=str(free_port()), KAGURA_DISC_PORT=str(free_port(socket.SOCK_DGRAM)),
           KAGURA_DATA_DIR=data, KAGURA_NO_PROMPT="1", KAGURA_NO_TRAY="1")
args = shlex.split(cmd)
if os.path.exists(os.path.join(ROOT, args[-1])):
    args[-1] = os.path.join(ROOT, args[-1])
log = open(os.path.join(data, "server.log"), "wb")
proc = subprocess.Popen(args, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
BASE = "http://127.0.0.1:%d" % port

def fail(msg):
    print("\n❌ " + msg)
    print("—— 服务端日志末尾 ——")
    print(open(os.path.join(data, "server.log"), encoding="utf-8", errors="replace").read()[-3000:])
    proc.terminate()
    sys.exit(1)

def check(cond, msg):
    if not cond:
        fail(msg)

deadline = time.time() + 30
while True:
    try:
        if real_requests.get(BASE + "/health", timeout=1).status_code == 200:
            break
    except real_requests.RequestException:
        pass
    if proc.poll() is not None or time.time() > deadline:
        fail("服务端没起来")
    time.sleep(0.2)

fake = lambda path, body=None: real_requests.post(BASE + "/__fake/" + path, json=body or {}, timeout=10).raise_for_status()
fake_log = lambda: real_requests.get(BASE + "/__fake/log", timeout=10).json()
b64 = lambda s: base64.b64encode(s.encode()).decode()

# ── 把设备接到这个服务端上，硬件换成桩 ──────────────────────────────────────
cfg.DEVICE_ID = "e2e-dev"
cfg.SERVER_BASE = BASE
cfg.SERVER_URL = BASE + "/chat"
cfg.VISION_URL = BASE + "/chat-vision"
cfg.SHOW_CHAT_TEXT = True
cfg.ASYNC_POLL_WAIT = 2

class FastSpeaker(QSpeaker):
    """两槽队列扬声器，播得比真的快 40 倍（只验收到的音频完整、顺序对，不用真等它念完）"""
    def _dur(self, snap): return QSpeaker._dur(self, snap) / 40.0

class NoTouch:
    @staticmethod
    def getCount(): return 0

snd.M5.Touch = NoTouch
hw.M5.Touch = NoTouch
hw.drain_touch = lambda *a, **k: True
states = []
ui.draw_state = lambda st, *a, **k: states.append(st)
netsvc.mqtt_check = lambda: None
netsvc.mqtt_ping = lambda: None
_real_sleep = time.sleep                                # time 模块是共用的那一个：先留住真的，再换掉
time.sleep = lambda s: None if s >= 1 else _real_sleep(s)       # 设备里「显示 1 秒待机图」这类停顿跳过

def wav(seconds=0.6):
    n = int(16000 * seconds)
    body = b"".join(struct.pack("<h", 1500 if (i // 20) % 2 else -1500) for i in range(n))
    return hw.make_wav_header(len(body)) + body

recs = []                                               # 每一轮「录到的音」；空了就返回 b""（没人说话）
snd._record_audio = lambda max_wait=0: recs.pop(0) if recs else b""
shots = []
cam.capture_photo = lambda: shots.append(1) or base64.b64encode(bytes([0xF8, 0x00]) * (320 * 240)).decode()
volume = []
hw._volume_adjust = lambda d: volume.append(d)

def turn(asr, llm=None):
    """设备说一句话、听完回复。返回扬声器播出的 PCM 字节数"""
    fake("reset")
    fake("asr", {"queue": [asr]})
    if llm is not None:
        fake("llm", {"queue": llm if isinstance(llm, list) else [llm]})
    snd.Speaker = FastSpeaker()
    snd._stream_bad = False
    snd.last_play = {}
    ui._last_user_text = ui._last_reply_text = ""
    del states[:], calls[:], shots[:], volume[:]
    recs[:] = [wav()]
    chat.record_and_send()
    check(not cfg.St.busy, "对话结束后 St.busy 没还原")
    return len(snd.Speaker.out)

print("=== 设备固件 × 真服务端 ===")

# ① 快捷指令短路：同步整段返回
n = turn("现在几点")
check(n > 0, "快捷指令：没播出声音")
check("点" in ui._last_reply_text and ui._last_user_text == "现在几点", "快捷指令：屏显文字不对 %r / %r" % (ui._last_user_text, ui._last_reply_text))
check(("POST", "chat") in calls and not any(u.startswith("chat/reply/") for _, u in calls), "快捷指令不该走长轮询：%r" % calls)
check(snd.last_play.get("mode") == "stream" and not snd.last_play.get("err"), "没走边下边播：%r" % snd.last_play)
print("  快捷指令短路                = 同步返回 ✓ 边下边播 ✓ 屏显 ✓  (%d 字节)" % n)

# ② 走大脑：202 + 长轮询，边生成边播，播完取全文
story = "从前有座山，山里有座庙。庙里有个老和尚在给小和尚讲故事。讲的是什么呢？讲的就是这个故事。"
n = turn("讲个故事", story)
polls = [u for m, u in calls if u.startswith("chat/reply/")]
check(polls, "走大脑的回复应该是异步的（202 + GET /chat/reply/<id>）：%r" % calls)
check(n > 16000, "长回复播出的音频太短：%d 字节" % n)
check(snd.Speaker.overwritten == 0, "在播的缓冲被覆盖了")
check(ui._last_reply_text == story, "播完屏幕上应该是完整回复，现在是 %r" % ui._last_reply_text)
check("processing" in states and "playing" in states and states[-1] == "idle", "状态顺序不对：%r" % states)
hdrs = fake_log()["llm"][0]
check("讲个故事" in hdrs["message"], "模型没收到这句话")
print("  异步回复                    = 202 → 长轮询 %d 次 ✓ 流式音频 %d 字节 ✓ 全文刷新 ✓" % (len(polls), n))

# ③ 工具改响应头：set_volume → X-Volume
n = turn("大声一点", {"text": "好的，调大了。", "tool_calls": [{"name": "set_volume", "args": {"direction": "up"}}], "then": ""})
check(volume == ["up"], "X-Volume 没到设备：%r（工具参数名变了？）" % volume)
print("  X-Volume                    = 设备调了音量 ✓")

# ④ 拍照：take_photo → X-Need-Photo → 设备拍照 → /chat-vision → 第二段回复
n = turn("看看这是什么", [{"text": "我看看。", "tool_calls": [{"name": "take_photo", "args": {"question": "这是什么"}}], "then": ""}, "桌上有个红色的杯子。"])
check(shots == [1], "X-Need-Photo 没到设备，没拍照")
check(("POST", "chat-vision") in calls, "拍完没发 /chat-vision：%r" % calls)
check("杯子" in ui._last_reply_text, "看图的回复没显示：%r" % ui._last_reply_text)
check(any(c.get("image") for c in fake_log()["llm"]), "模型没收到图片")
print("  X-Need-Photo                = 拍照 ✓ /chat-vision ✓ 看图回复 ✓")

# ⑤ 没听清：识别为空，回固定的话
n = turn("")
check(n > 0 and ui._last_reply_text, "没听清时应该有一句回复")
print("  没听清                      = 回了「%s」✓" % ui._last_reply_text)

proc.terminate()
print("\n✅ 设备代码和服务端对得上")
