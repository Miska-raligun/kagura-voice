"""Kagura Voice 设备端 —— 全局配置、开关与运行状态。

本模块不 import 任何其他 kagura 模块，是依赖图的最底层。

╔══════════════════════════════════════════════════════════════════════╗
║  ⚠ 下面「运行时可变」区的变量会被改写，其他模块必须用 `cfg.X` 访问，   ║
║    绝对不要写 `from cfg import SERVER_BASE`——那样拿到的是导入瞬间的   ║
║    值拷贝，UDP 发现改了地址你也看不到，设备会一直连 fallback IP 且    ║
║    不报错。噪声校准阈值同理。tools/check_split.py 会自动检查这一点。  ║
╚══════════════════════════════════════════════════════════════════════╝
"""

# ── 设备上的目录布局 ──────────────────────────────────────────
# /flash/main.py              三行引导，把 SRC_DIR 加进 sys.path
# /flash/kagura/src/*.py      本模块及其他代码
# /flash/kagura/resource/*    图片等只读资源（用户上传）
# /flash/kagura/data/*        运行时可写状态（wifi/音量/临时音频，自动创建）

BASE_DIR = "/flash/kagura"
SRC_DIR  = BASE_DIR + "/src"
RES_DIR  = BASE_DIR + "/resource"
DATA_DIR = BASE_DIR + "/data"


def res(name):
    """资源文件绝对路径。"""
    return RES_DIR + "/" + name


def data(name):
    """可写状态文件绝对路径。"""
    return DATA_DIR + "/" + name


def ensure_dirs():
    """确保可写目录存在（资源目录由用户上传时创建）。"""
    import uos
    for d in (BASE_DIR, DATA_DIR):
        try:
            uos.mkdir(d)
        except OSError:
            pass          # 已存在


# ══════════════════════════════════════════════════════════════
#  运行时可变 —— 必须用 cfg.X 访问
# ══════════════════════════════════════════════════════════════

# 由 netsvc.discover_server() 改写（UDP 发现到服务端后替换为真实 IP）
SERVER_BASE = "http://192.168.31.66:5000"      # 发现失败时的 fallback
SERVER_URL  = SERVER_BASE + "/chat"
VISION_URL  = SERVER_BASE + "/chat-vision"
UPLOAD_URL  = SERVER_BASE + "/upload-photo"
MQTT_BROKER = "192.168.31.66"

# 由 audio.calibrate_noise() 改写（开机采样环境底噪后自动设定）
SILENCE_THRESHOLD = 500      # RMS 低于此值视为静音
WAKE_THRESHOLD    = 600      # 高于环境底噪，低于正常说话音量


# ══════════════════════════════════════════════════════════════
#  常量 —— 不会被改写，可以 from cfg import
# ══════════════════════════════════════════════════════════════

DEVICE_ID = "cores3"

# ── 网络超时 ──────────────────────────────────────────────────
# 服务端处理包含 LLM 推理，时间较长；超时可避免永久挂起
REQUEST_TIMEOUT_CHAT   = 30   # /chat、/chat-vision（含 LLM 推理）
REQUEST_TIMEOUT_SHORT  = 10   # /time、/shake、/presence 等短请求
REQUEST_TIMEOUT_UPLOAD = 15   # /upload-photo

# ── UDP 自动发现 ──────────────────────────────────────────────
DISC_PORT    = 5001
DISC_MSG     = b"KAGURA_DISCOVER"
DISC_TIMEOUT = 2
DISC_RETRIES = 3

# ── 录音参数 ──────────────────────────────────────────────────
SAMPLE_RATE    = 16000
CHUNK_SEC      = 0.25   # 块越小，说话结束判定越快
CHUNK_SIZE     = int(SAMPLE_RATE * 2 * CHUNK_SEC)
SILENCE_CHUNKS = 5      # 连续 N 个静音块后停止（5×0.25=1.25s）
MAX_CHUNKS     = 40     # 上限 MAX_CHUNKS × CHUNK_SEC = 10 秒

# ── 声控唤醒 ──────────────────────────────────────────────────
WAKE_CHUNK_SIZE = int(16000 * 2 * 0.1)   # 每次采样 100ms
WAKE_LOUD_NEED  = 3                      # 连续 N 次超阈值触发

# 唤醒模式下麦克风常开（避免每 100ms 建拆一次 I2S 驱动）。
# 真机上如与 Speaker 冲突（无声/杂音），改回 False 即恢复旧行为。
WAKE_MIC_PERSISTENT = True

# ── 交互 ──────────────────────────────────────────────────────
LONG_PRESS_MS = 800     # 长按阈值（ms）
SLEEP_TIMEOUT = 300     # 5 分钟无操作后息屏

# ── 硬件看门狗 ────────────────────────────────────────────────
# 未捕获异常/死循环时自动复位。ESP32 的 WDT 一旦创建无法关闭。
WATCHDOG_ENABLED    = True
WATCHDOG_TIMEOUT_MS = 120000   # 必须大于最长合法阻塞（HTTP 30s + 余量）

# ── BLE 在家感知 ──────────────────────────────────────────────
BLE_PHONE_NAME     = ""       # 手机蓝牙名称（部分匹配），为空则禁用
BLE_SCAN_INTERVAL  = 30       # 扫描间隔（秒）
BLE_SCAN_DURATION  = 3000     # 每次扫描时长（毫秒）
BLE_RSSI_THRESHOLD = -70      # RSSI 阈值
BLE_HOME_COUNT     = 2        # 连续检测到 N 次 → 在家
BLE_AWAY_TIMEOUT   = 300      # 未检测到 N 秒 → 出门

# ── IMU 摇晃彩蛋 ──────────────────────────────────────────────
IMU_SHAKE_G        = 2.5      # 加速度阈值（g）
IMU_SHAKE_COUNT    = 3        # 500ms 内需达到的次数
IMU_SHAKE_COOLDOWN = 2.0      # 冷却时间（秒）

# ── WiFi ──────────────────────────────────────────────────────
WIFI_CONNECT_TIMEOUT = 15     # 秒

# ── 显示开关（真机出问题先关这些）────────────────────────────
SHOW_CHAT_TEXT   = True    # 待机界面显示最近一轮对话（需中文字体）
VISUAL_ENABLED   = True    # 环形音频可视化，关掉退回纯静态
USE_STATE_IMAGES = False   # True=每状态一张背景图；False=统一背景+矢量环

# ── 环形可视化几何 ────────────────────────────────────────────
VIS_FRAME_MS = 50      # 动画帧间隔（20fps）
RING_N  = 24
RING_CX = 160
RING_CY = 90
RING_R  = 56
RING_W  = 9            # 每段方块边长

CHROME_BG = 0x101010   # 顶栏底色（实心条带才能做局部重绘）
BAND_BG   = 0x0d0d0d   # 文字条带底色
PLATE_BG  = 0x0a0a0a   # 环心表情面板底色

# ── 屏幕状态 UI：(kaomoji, 状态文字, 主题颜色) ────────────────
STATE_UI = {
    "idle":           ("(^w^)",   "Touch to talk",    0x888888),
    "recording":      ("(O_O)",   "Recording...",      0xff4444),  # Bug 4 Fix: 合并 listening/recording
    "processing":     ("(@_@)",   "Thinking...",       0xffcc00),
    "playing":        ("(>v<)",   "Talking...",        0x44ff44),
    "error":          ("(;_;)",   "Error!",            0xff6600),
    "no_speech":      ("(-_-)",   "No speech",         0x888888),
    "broadcast":      ("(^o^)",   "Talking...",        0x00ccff),
    "camera":         ("(0o0)",   "Camera...",         0xaa00ff),
    "continuous_on":  ("(^o^)",   "Continuous ON",     0x00ffff),
    "continuous_off": ("(^w^)",   "Continuous OFF",    0x888888),
    "wake_on":        ("(-_-)",   "Wake mode ON",      0x00ff88),
    "wake_off":       ("(^w^)",   "Wake mode OFF",     0x888888),
    "discovering":    ("(o_o)",   "Searching...",      0xffaa00),
    "shake":          ("(*/ω＼*)", "!",                 0xff88cc),
    "wifi_setup":     ("(o_o)",   "WiFi Setup",        0x00aaff),
    "wifi_connect":   ("(._.)",   "Connecting...",     0xffaa00),
    "wifi_ok":        ("(^_^)",   "WiFi OK",           0x44ff44),
    "wifi_fail":      ("(x_x)",   "WiFi Failed",       0xff4444),
}


# 状态 → 背景图名（仅 USE_STATE_IMAGES=True 时生效）
IMG_MAP = {
    "recording":  "img_recording",
    "processing": "img_processing",
    "playing":    "img_playing",
    "broadcast":  "img_playing",   # broadcast 复用 playing 图片
}


# ══════════════════════════════════════════════════════════════
#  设备运行状态 —— 跨子系统共享的 flag 全部集中在这里
# ══════════════════════════════════════════════════════════════
#
# 模式互斥/转移只应通过 chat.toggle_continuous() / chat.toggle_wake_mode() /
# ui.enter_sleep() / ui.wake_up() 这些入口函数改动，
# 不要在业务代码里直接翻 flag。

class St:
    busy          = False   # 正在录音/请求/播放（MQTT push 会看它跳过重复播放）
    continuous    = False   # 连续对话模式
    wake          = False   # 声控唤醒模式（与 continuous 互斥）
    sleeping      = False   # 息屏休眠中
    last_activity = 0       # 最近一次交互时间戳（休眠计时）
