"""Kagura Voice 设备端 —— 全局配置、回退开关与运行状态。

本模块不 import 任何其他 kagura 模块，是依赖图的最底层。
运行时可变量（SERVER_* / MQTT_BROKER / *_THRESHOLD）必须用 cfg.X 访问，
写 `from cfg import X` 拿到的是值拷贝，改了看不到且不报错。
"""


# ── 设备上的目录布局（与上游一致）──────────────────────────────
# /flash/main.py              三行引导，把 SRC_DIR 加进 sys.path
# /flash/kagura/src/*.py      本模块及其他代码
# /flash/kagura/resource/*    图片等只读资源（用户上传）
# /flash/kagura/data/*        运行时可写状态（wifi/音量/崩溃日志，自动创建）

BASE_DIR = "/flash/kagura"
SRC_DIR  = BASE_DIR + "/src"
RES_DIR  = BASE_DIR + "/resource"
DATA_DIR = BASE_DIR + "/data"


def res(name):
    """资源文件绝对路径。新增资源一律走这里，别硬编码 /flash。"""
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


# ── 屏显对话文本（服务端 X-User-Text / X-Reply-Text 头，b64 UTF-8） ──
SHOW_CHAT_TEXT = True


# ── 服务端地址 ────────────────────────────────────────────────

# UDP 发现失败时的 fallback 地址
SERVER_BASE = "http://192.168.31.66:5000"


SERVER_URL    = SERVER_BASE + "/chat"


VISION_URL    = SERVER_BASE + "/chat-vision"


UPLOAD_URL    = SERVER_BASE + "/upload-photo"


DEVICE_ID     = "cores3"


MQTT_BROKER   = "192.168.31.66"


# ── 网络超时 ──────────────────────────────────────────────────
# 服务端处理包含 LLM 推理，时间较长；设备无线程，超时可避免永久挂起
REQUEST_TIMEOUT_CHAT  = 60   # /chat、/chat-vision（含 LLM 推理 + TTS）。
                             # 30 秒不够：回答一长，OpenClaw 生成 20 秒 + 百度合成
                             # 好几秒就超了，服务端照常发出 WAV、设备早已 ETIMEDOUT
                             # 放弃（LRN 2026-10-18）。上限受两条约束：WDT 180s，
                             # 以及阻塞期间发不了 MQTT ping——broker 约 1.5×keepalive
                             # =90s 收不到包就断，所以发请求前先 netsvc.mqtt_ping()


REQUEST_TIMEOUT_SHORT = 10   # /time、/shake、/presence 等短请求


REQUEST_TIMEOUT_UPLOAD = 30  # /upload-photo（QVGA 帧 base64 约 205KB，15s 太紧）


# 直播推流：与服务端 stream_server.py 对接。留空 token = 不校验，
# 与 /upload-photo 等其它设备→服务端接口的口径一致。
STREAM_PORT   = 5002


STREAM_TOKEN  = ""


# ── 录音参数 ──────────────────────────────────────────────────

SAMPLE_RATE      = 16000


CHUNK_SEC        = 0.25   # 0.5→0.25：块越小，说话结束判定越快（需真机确认 VAD 稳定）


CHUNK_SIZE       = int(SAMPLE_RATE * 2 * CHUNK_SEC)


SILENCE_THRESHOLD = 500   # RMS 低于此值视为静音


SILENCE_CHUNKS   = 6      # 连续 N 个静音块后停止录音（6×0.25=1.5s）。
                          # 5（1.25s）时说长句子中间想一下就被切断（LRN 2026-10-18）


MAX_CHUNKS       = 120    # 开口后最多录多少块（含字头预录，120×0.25=30 秒）。
                          # 原为 40（10 秒），长一点的话说一半就被截断发走。
                          # 录音写进开机时预留的一整块缓冲（snd._rec_buf，约 960KB），
                          # 不再逐块 bytes() + join + 拼头复制三遍；分配失败会自动
                          # 降级到 20/10 秒，实际上限见诊断日志 vad 行的 max=。
                          # 百度短语音识别上限 60 秒，别超过 240


MAX_WAIT_CHUNKS  = 40     # 开口前最多等多少块（10 秒），超时算 no_speech。
                          # 旧版"等待+说话"共用 10 秒，第 8 秒才开口的话只录得到 2 秒


PREROLL_CHUNKS   = 2      # 起说前保留的块数（0.5 秒）。旧版只从"超过门槛的那块"开始存，
                          # 字头那一下轻音被整块丢掉（"你好"只剩"好"），百度认不出来


VAD_END_RATIO    = 0.6    # 开口后的"静音"门槛 = SILENCE_THRESHOLD × 此比例（迟滞）：
                          # 句尾音量回落、句中换气时别急着收尾


MIN_VOICED_CHUNKS = 2     # 开口后至少要有几块（×0.25s）够响才算说话，否则当噪声丢弃


HANDS_FREE_TH_RATIO = 1.5  # 连续/唤醒模式的起说门槛 = SILENCE_THRESHOLD × 此倍数。
                           # 免手模式下"一有点声音就触发"（LRN 2026-10-19）


CONT_EMPTY_EXIT  = 3      # 连续模式下连续几次"识别为空"就自动退出


CONT_IDLE_EXIT_SECS = 120  # 连续模式下这么久没有一轮有效对话就自动退出


MIC_GAPLESS      = True   # 双缓冲无缝录音（回退开关）。旧版录完一块才排下一块，
                          # 中间等 50ms + 算 RMS，块与块之间丢 ~80ms，
                          # 相当于每秒挖掉三成音频——单次对话识别差的头号嫌疑。
                          # 真机录音异常（杂音/重复）改 False 回旧行为


VAD_MAX_THRESHOLD = 2000  # 校准出的说话门槛封顶：开机时旁边正好很吵，别把门槛抬到够不着


NOISE_FLOOR      = 0      # 开机校准测得的底噪（随心跳上报，调门槛用）


# ── 播放 ──────────────────────────────────────────────────────
# 回复/推送音频落盘再播。三个数都跟「长音频别把设备搞死」有关，
# 详见 snd.py 顶部的口径说明。
PLAY_PATH        = "/flash/response.wav"


PLAY_CHUNK       = 4096     # 下载/写盘的分块字节数：每块喂一次狗


PLAY_BIG_BYTES   = 300000   # 超过这个大小（约 9 秒）的播放留持久化面包屑


# 超长音频才切段播放：**日常回复一段到底，一条缝都没有**。
# 切段是为了把「一次 playWavFile = 一段不喂狗的时间」钉死在 10 秒量级，
# 免得 playWavFile 万一是阻塞实现、早报又长到顶穿 WDT 窗口。
# 三个数一起决定"能听见几次咔嚓"，改之前先读 snd.py 里分段那段的注释：
# 段越长 → 接缝越少（咔嚓越少），但"按屏幕停止播放"的响应也越钝
# （playWavFile 阻塞期间主循环不转，实测 iters≈每段 1 轮），
# 且喂狗与 MQTT 保活都只能在段间做。25 秒是这几条约束下的折中：
# WDT 180s 有 7 倍余量，MQTT ping 间隔最坏 50s < keepalive 60s。
PLAY_SEG_MAX     = 1920000  # 音频超过这个大小（约 60 秒）才切段；以下一段到底


PLAY_SEG_BYTES   = 800000   # 切段后每段的音频字节数（约 25 秒）


# 边下边播（snd.stream_play，回退开关）。回复不再「整段下载写 flash →
# playWavFile」，而是每收到 1 秒就用 Speaker.playWav(内存) 排进扬声器队列：
#   ① 首字延迟从「下载+写盘完」降到「收到 2 秒」——60 秒回复约 1.9MB，
#      写 flash 要十几秒，这就是「生成完了还要等很久才出声」；
#   ② 内存播放是非阻塞的，播放期间主循环照转，MQTT ping 照发。
#      playWavFile 在本固件上是阻塞实现（iters≈每段 1 轮），播一段就聋一段，
#      这是长回复后 MQTT 掉线重连的原因。
# 播不出声（固件不支持内存 playWav）会自动退回落盘播放，并在本次开机内不再尝试。
PLAY_STREAMING   = True


# 边生成边播（LRN 2026-10-23，新服务端的内置 agent 才支持）：请求带 X-Stream: 1，服务端
# 首句合成好就开始回音频，后面的句子边生成边追加，读到连接关闭为止；X-Reply-Text 只有首句
# （带 X-Reply-Partial: 1），播完再 GET /chat/last 取全文刷新屏幕。老服务端不认这个头，照旧整段返回。
# 只在内存流式播放可用时才请求（落盘播放要预知长度）。出问题改 False 即恢复整段返回。
STREAM_REPLY     = True


# 异步对话（LRN 2026-10-24，症状「对着设备交代长任务，60 秒一到就断」）：请求带 X-Async: 1，
# 走大脑的回复服务端立刻回 202 + 编号，设备用 GET /chat/reply/<id>?wait=ASYNC_POLL_WAIT 长轮询分段取。
# 每次最多阻塞 ASYNC_POLL_WAIT 秒，两次之间回来保活 MQTT、喂狗、看触摸（按住屏幕 = 取消），
# 所以任务多长都行（服务端单轮上限默认 30 分钟）。只和 STREAM_REPLY 一起用（分段音频同一套流式协议）。
# 老服务端不认这个头，照旧同步返回。出问题改 False 即恢复同步。
ASYNC_CHAT       = True


ASYNC_POLL_WAIT  = 6        # 秒。越短「按住取消」越灵，代价是多几次 HTTP 往返


ASYNC_MAX_SECS   = 1900     # 设备最多等多久（比服务端 30 分钟上限略长）


STREAM_BLOCK_BYTES = 32000  # 每块 1 秒（16k×16bit）。三块轮转共 96KB 堆


STREAM_PREBUF    = 2        # 攒够几块再开播：WiFi 抖一下也不至于断音。最大 3（只有三块缓冲）


STREAM_CH        = 0        # 固定用一个扬声器通道，才能按队列深度判断"有没有空位"


PLAY_FADE_BYTES  = 160      # 段首/段尾淡入淡出的字节数（80 采样 ≈ 5ms），0=关


# 唤醒模式下麦克风常开（避免每 100ms 建拆一次 I2S 驱动）。
# 真机上如与 Speaker 冲突（无声/杂音），改回 False 即恢复旧行为。
WAKE_MIC_PERSISTENT = True


# ── 远程诊断：事件环形日志 + 心跳上报 ─────────────────────────
# dbg() 记录网络/MQTT 关键事件到内存环形缓冲（40 条），随每分钟心跳
# POST /heartbeat 上传服务端落盘。设备"开着机但失联"期间发生了什么，
# 恢复后第一个心跳就能在服务端看到，无需 USB 串口。

_HB_INTERVAL   = 60    # 心跳间隔（秒）


_NET_CHECK_IVL = 15    # 网络自检间隔（秒）


_NET_FIX1_SECS = 600   # 与服务端失联 10 分钟 → WiFi 栈软重建


_NET_FIX2_SECS = 1500  # 失联 25 分钟 → 整机复位（uptime>1h 门槛=每小时最多一次）


# ── 设备运行状态（跨子系统共享的 flag 全部集中在这里） ──────────
#
# 模式互斥/转移只应通过 toggle_continuous() / toggle_wake_mode() /
# enter_sleep() / wake_up() 这些入口函数改动，不要在业务代码里直接翻 flag。

class St:
    busy          = False   # 正在录音/请求/播放（MQTT push 会看它跳过重复播放）
    # 直播推流中。也置 busy，但 push 去重要放行：去重是为了挡住 OpenClaw
    # 用 cores3-speak 回复时的重复推送，直播期间收到的推送是真要播的
    # （比如你在网页抓拍后让它说一句），丢掉就变成"日志里回复了但没声音"。
    streaming     = False
    # 异步对话等回复中。也在 busy 里，但这期间收到的推送是主动消息（任务可能要等很久），
    # 不能当成重复推送丢掉：入队，对话结束后照常播
    awaiting      = False
    continuous    = False   # 连续对话模式
    wake          = False   # 声控唤醒模式（与 continuous 互斥）
    sleeping      = False   # 息屏休眠中
    last_activity = 0       # 最近一次交互时间戳（休眠计时）
    role          = ""      # 当前角色 id（""=默认）。服务端说了算：每次 /chat 回 X-Role，
                            # 只能经 ui.set_role() 改（要作废重绘缓存）
    # 下面两个是"死人开关"用的，见 hw._deadman_check：
    stage         = "boot"  # 当前在哪个长循环里（主循环每轮复位成 "loop"）
    last_ok_ms    = 0       # 上次成功联系上服务端的 ticks_ms（hw 在 import 时初始化）


WAKE_THRESHOLD   = 600      # 高于环境底噪，低于正常说话音量


WAKE_CHUNK_SIZE  = int(16000 * 2 * 0.1)  # 每次采样 100ms


WAKE_LOUD_NEED   = 3        # 连续 N 次超阈值触发（N×100ms）


# ── 硬件看门狗 ────────────────────────────────────────────────
# 未捕获异常/死循环时自动复位，always-on 设备不再假死。硬冻结（I2S/WiFi
# 驱动死锁等 Python 异常抓不到的情况）也会因停止喂狗被强制复位，并在
# 开机上报的 reset_cause 里留下"看门狗复位"的死因证据。
# 注意：ESP32 的 WDT 一旦创建无法关闭；设为 False 则完全不启用。
# 接 REPL 调试前必须改 False——主循环停止喂狗会导致每 2 分钟复位一次。
WATCHDOG_ENABLED = True


# 必须大于「最长合法阻塞」。这条以前只算了 HTTP 的 30s，漏了播放：
# 早报类推送可达 2.4MB / 74 秒，且 Speaker.playWavFile 期间主循环是否还在
# 转由固件决定（阻塞实现下整段播放一次狗都喂不上，见 snd.play_file 的 iters）。
# 2026-08-11 08:10 的 2.38MB 早报就是这么吃了一次看门狗复位。
# 百度 TTS 单次上限约 100 秒音频，180s 能兜住「下载+写盘+整段播放」。
WATCHDOG_TIMEOUT_MS = 180000


# ── 死人开关：喂狗点上的最后一道自愈 ──────────────────────────
# LRN 2026-08-26：设备僵死 4 小时 51 分，看门狗武装着 180 秒却一次没响——
# 卡住的那个循环一边转一边喂狗。现有三道自愈**一道都够不着**：
# netfix1/netfix2 要主循环跑到 net_watch_tick，看门狗被喂饱了。
# 所以把判据挪进 _wdt_feed()——那是唯一一个在每个这种循环里都还在转的地方。
# 判据仍是那条铁律：只认"服务端还认不认得我"。
# 阈值要大于 _NET_FIX2_SECS，让主循环还活着时优先走正常的分级自愈。
DEADMAN_SECS          = 1800      # 失联这么久就自己复位（0=关闭这道兜底）


DEADMAN_MIN_UPTIME_MS = 3600000   # 开机 1 小时内不触发（同 netfix2：服务端没开机时别陷入重启循环）


LONG_PRESS_MS = 800         # 长按阈值（ms）


                            # 人还在不在，而不是靠倒计时——见 feel_reflex_tick

# ── 触觉 ─────────────────────────────────────────────────────
#
# 三层结构，别混在一起：
#   反射层：设备端立刻改表情，不过网。触觉的"手感"全靠这层——走一趟
#           OpenClaw 是 3~10 秒，那不叫触觉，叫事后转述。
#   体感层：把触摸聚合成"最近被摸了多久 / 多久没人碰"，随下次 /chat 用
#           X-Touch 头捎给服务端注入 prompt。零额外请求，零额外延迟。
#   惊动层：只有显著事件才打 /touch 让 agent 主动开口，带冷却。
#
# 与现有按钮语义的分工（定死了，改之前想清楚）：点按仍是录音、长按不动仍是
# 切唤醒模式，**只有手指发生位移才判定为抚摸**并吞掉这一次 short/long。
# 好处是肌肉记忆完全不用改；代价是"手贴着不动"这个手势让给了长按。
TOUCH_FEEL_ENABLED   = True   # 回退开关：关掉则触摸行为与加触觉之前完全一致


FEEL_NOTIFY_ENABLED  = True   # 回退开关：只关"主动开口"，保留反射层和体感层


STROKE_MIN_DIST      = 24     # 判定抚摸的最小位移（px，约 4mm；点按抖动通常 <10px）


STROKE_MIN_MS        = 250    # 抚摸至少持续这么久才判定（挡住手滑误触）


FEEL_STROKE_NOTIFY   = 3.0    # 单轮抚摸累计超过这么久才值得让她开口（秒）


# 手离开屏幕后表情还保持多久。**别调太短**：摸是个反复的动作，一次抚摸中间
# 必然有短暂离手，收得太快就会 petted→idle→petted 来回切，每切一次都是一张
# 整屏 JPEG 重解码（约 100ms），看起来就是画面在闪。这个值要盖过离手的间隙。
FEEL_REFLEX_LINGER   = 2.5


_FEEL_LINGER_MS      = int(FEEL_REFLEX_LINGER * 1000)


FEEL_NOTIFY_COOLDOWN = 90     # 主动惊动的冷却（秒）。没有这个会非常聒噪


FEEL_QUIET_SECS      = 1800   # 超过这么久没被碰过，算"被冷落"（秒）


FEEL_WAKE_ON_PICKUP  = True   # 休眠中被拿起来自动醒


# 打开后每次反射层真正重画屏幕都打一行。屏幕闪不闪的问题只能靠这个定位——
# 正常抚摸一整段应该只有两行：进 petted、回 idle。刷屏就是判据还有漏。
FEEL_DEBUG           = False


class Feel:
    """体感累积量。语义同 St：只通过下面几个 feel_* 函数改，别在业务里直接翻。

    stroke_secs 等是"待上报窗口"——feel_header() 取走即清零，窗口边界就是
    上一次对话。所以注入给 LLM 的永远是"上次说完话之后发生的事"。
    """
    last_touch  = 0     # 最近一次被碰的时间戳（0 = 开机以来还没被碰过）
    stroke_secs = 0.0   # 窗口内被抚摸的累计秒数
    strokes     = 0     # 窗口内抚摸次数
    cradles     = 0     # 窗口内被"捧着"（多指同时按）次数
    taps        = 0     # 窗口内机身被轻拍次数（IMU）
    pickups     = 0     # 窗口内被拿起来次数（IMU）
    carry_secs  = 0.0   # 窗口内被抱着走的累计秒数（IMU）
    last_notify = 0     # 上次打 /touch 的时间（冷却用，不进窗口）


# ── 自动休眠 ────────────────────────────────────────────────
SLEEP_TIMEOUT  = 300         # 5 分钟无操作后息屏


# ── BLE 在家感知 ─────────────────────────────────────────────
BLE_PHONE_NAME    = ""       # 用户手机蓝牙名称（部分匹配），为空则禁用


BLE_SCAN_INTERVAL = 30       # 扫描间隔（秒）


BLE_SCAN_DURATION = 3000     # 每次扫描时长（毫秒）


BLE_RSSI_THRESHOLD = -70     # RSSI 阈值（> 此值视为在附近）


BLE_HOME_COUNT    = 2        # 连续检测到 N 次 → 判定在家


BLE_AWAY_TIMEOUT  = 300      # 未检测到 N 秒 → 判定出门


# ── IMU 摇晃彩蛋 ─────────────────────────────────────────────
IMU_SHAKE_G       = 2.5      # 加速度阈值（g）


IMU_SHAKE_COUNT   = 3        # 500ms 内需要达到的次数


IMU_SHAKE_COOLDOWN = 2.0     # 冷却时间（秒）


# ── IMU 本体感觉（被拿起/被轻拍/被抱着走）─────────────────────
# 阈值全是拍脑袋的起点值，**必须真机调**：桌面材质、放置姿态、机身重量
# 都会影响。调的时候把 _imu_feel_detect 里的 print 打开看实测幅值。
IMU_TAP_G          = 1.55    # 轻拍机身的加速度尖峰（要低于摇晃阈值）


# 轻拍要等这么久才确认，**必须大于摇晃的 500ms 判定窗**：否则"第三下来得慢"
# 的摇晃会先被确认成轻拍开一次口，紧接着彩蛋又触发一次。代价是轻拍的反射
# 表情慢半拍——没有硬件 tap 中断的话，这个歧义只能用时间换。
IMU_TAP_CONFIRM_MS = 600


IMU_TAP_SPIKE_WIN  = 700     # 尖峰计数的保留窗（要大于 CONFIRM，否则数不满 3 下）


IMU_MOTION_BAND    = 0.12    # |合加速度 - 1g| 超过这么多算"在动"


IMU_PICKUP_STILL   = 20      # 静止这么久之后才动，才算"被拿起来"（秒）


IMU_PICKUP_MOVE_MS = 300     # 持续运动这么久才确认拿起（挡桌面震动/关门震）


IMU_CARRY_GAP      = 3.0     # 运动中断这么久算"放下了"（秒）


# ── 屏幕状态 UI ───────────────────────────────────────────────
# (kaomoji, 状态文字, 主题颜色)

STATE_UI = {
    "idle":           ("(^w^)",   "Touch to talk",    0x888888),
    "recording":      ("(O_O)",   "Recording...",      0xff4444),  # Bug 4 Fix: 合并 listening/recording
    "processing":     ("(@_@)",   "Thinking...",       0xffcc00),
    "playing":        ("(>v<)",   "Talking...",        0x44ff44),
    "error":          ("(;_;)",   "Error!",            0xff6600),
    "no_speech":      ("(-_-)",   "No speech",         0x888888),
    "broadcast":      ("(^o^)",   "Talking...",        0x00ccff),
    "camera":         ("(0o0)",   "Camera...",         0xaa00ff),
    # 直播：状态文字故意留空（不在屏幕上写"直播中"），画面换成 img_streaming.jpg
    "streaming":      ("(o_o)",   "",                  0xff0055),
    "continuous_on":  ("(^o^)",   "Continuous ON",     0x00ffff),
    "continuous_off": ("(^w^)",   "Continuous OFF",    0x888888),
    "wake_on":        ("(-_-)",   "Wake mode ON",      0x00ff88),
    "wake_off":       ("(^w^)",   "Wake mode OFF",     0x888888),
    "discovering":    ("(o_o)",   "Searching...",      0xffaa00),
    "shake":          ("(*/ω＼*)", "!",                 0xff88cc),
    # 触觉反射层。状态文字保持 ASCII——DejaVu18 里没有 ♡ 这类字符，画出来是方块。
    # 背景图走 _IMG_MAP，目前三态都复用 img_processing。**换图不额外花钱**：
    # draw_state 本来每次换状态就要整屏重解码一张 JPEG，换的是哪张不影响成本；
    # 真正贵的是图不存在时那次白试 + 回退，所以有 _img_missing 兜底。
    "petted":         ("(*^w^*)", "Being petted",      0xff88cc),
    "poked":          ("(o_O)",   "Poked!",            0xffaa88),
    "held":           ("(^o^)/",  "Picked up",         0xffcc44),
    "wifi_setup":     ("(o_o)",   "WiFi Setup",        0x00aaff),
    "wifi_connect":   ("(._.)",   "Connecting...",     0xffaa00),
    "wifi_ok":        ("(^_^)",   "WiFi OK",           0x44ff44),
    "wifi_fail":      ("(x_x)",   "WiFi Failed",       0xff4444),
}


# ── 动态可视化：环形音频指示器 ─────────────────────────────────
#
# 24 段圆环，每帧在同一批矩形上原地重绘 —— 不需要擦除，也不关心背后
# 是纯色还是照片。只依赖 fillRect（代码里已验证可用），不需要
# fillCircle / canvas / pushImage 这些不确定的 API。
#   idle              → 彗星追逐（呼吸感）
#   recording         → 麦克风电平实时填充
#   playing/broadcast → 语音包络填充
#   其他（含 processing，HTTP 阻塞期主循环不转）→ 静态一帧
#
# 逐帧只重绘亮度变化的段（差分渲染），典型每帧仅几个 fillRect。

# 环形动画默认关闭：待机时一直转的圈观感上像"卡在加载中"。
# 想要音频反馈（录音跟音量跳、播放跟包络跳）把它改回 True——环会画在
# 背景图上，draw_state 整屏重画后由 visual_tick 补回。
VISUAL_ENABLED   = False


# True=每状态各自的背景图（img_recording/img_playing…），与 draw_state
# 的整屏渲染配套；False=所有状态统一用 img_bg。
USE_STATE_IMAGES = True


VIS_FRAME_MS     = 50      # 动画帧间隔（20fps）


RING_N  = 24


RING_CX = 160


RING_CY = 90


RING_R  = 56


RING_W  = 9                # 每段方块边长


# ── 离屏画布合成 ──────────────────────────────────────────────
#
# 原先 draw_state 是一层层往**屏幕**上画（背景 → 彩条 → 顶栏 → 状态文字），
# 全过程约 58ms 而且用户全程看得见，观感就是"背景先刷上去、文字再一个个冒
# 出来"。开这个开关后改成全部画进离屏画布、最后一次 push 上屏：屏幕在推屏
# 那一刻整屏同时更新，中间过程不可见。
#
# 真机实测（2026-08，CoreS3）：
#   直接上屏 58ms ┊ 画进 PSRAM 画布 54ms ┊ 整屏 push 35ms
# 也就是总耗时 58 → 89ms，**反而慢 50%**，换的是"瞬间完成"而不是"看着它画"。
# 觉得不值就把开关改 False，行为立刻回到逐层直画。
#
# 两个真机结论，改之前必读：
#   ① PSRAM 带宽不是瓶颈（54 vs 58ms）——JPEG 解码是 CPU 密集，写哪块内存无所谓
#   ② **整屏画布必须 psram=True**：内部 SRAM 凑不出 150KB 连续空间，
#      分配会"成功"但没有缓冲区，之后所有绘制静默变成 no-op（实测表现为
#      drawJpg 耗时 0ms、屏幕纹丝不动），排查起来极其费解
USE_CANVAS = True


# ── WAV 工具 ──────────────────────────────────────────────────

# ── 离屏画布探测（一次性诊断，测完把 CANVAS_PROBE 改回 False）────
#
# 要判断的是：能不能把"整屏重绘"改成"离屏合成 + 一次推屏"。
# 现在 draw_state 是一层层往屏幕上画（背景 → 彩条 → 顶栏 → 状态文字），
# 全过程约 100ms 且**用户看得见**，所以换图像是"背景先上、文字再冒出来"。
# 画布方案是全画进离屏缓冲再一次推屏，总耗时不变，但屏幕上是瞬间完成的。
#
# 更重要的是它能解开当初被否掉的分层重绘：CLAUDE.md 记着"分层增量重绘要垫
# 实心底才能擦字，结果照片被黑边夹住"。有画布就不用垫底——擦除变成"从背景
# 重新合成"，时钟/电量就能局部更新，不必整屏重解 JPEG。
#
# 四个数字决定方案生死：
#   ① 画布暴露了哪些方法——没有 drawString/setFont 就画不了文字，方案作废
#   ② 画进 PSRAM 画布 vs 直接画屏谁快——PSRAM 走 QSPI，逐像素写可能更慢
#   ③ 整屏 push 多少毫秒——一帧到位的固定开销
#   ④ 顶栏小画布 文字+push 多少毫秒——这是"时钟每秒刷新"的实际成本
# 结果同时进串口和 dbg 环形缓冲，随心跳上报（voice_server.log 里的 📟 行）。
#
# 2026-08 已测完，结论写在 USE_CANVAS 那段注释里。代码保留：以后换固件版本
# 或改画布尺寸想重测，改回 True 烧一次就行。
CANVAS_PROBE = False


_WIFI_CONNECT_TIMEOUT = 15   # seconds


# ── 摄像头 ────────────────────────────────────────────────────
#
# 帧格式是 raw RGB565（服务端 _decode_image_b64 按字节数反查分辨率再转 JPEG）。
# 固件差异用运行时探测抹平：抓帧优先 camera.capture()（返回 bytes，本机验证过），
# 回退 camera.snapshot()（新固件，返回 image.Image）；预览同理，见 _cam_show()。

# 回退开关：True=按 QVGA(320×240) 初始化，取景铺满屏且识别更清楚；
# 真机若初始化失败/画面异常，改 False 即回到固件默认分辨率（旧行为）。
CAMERA_QVGA = True


# drawRawBuf 的字节序开关。摄像头 RGB565 是高字节在前，M5GFX 的 raw buffer
# 默认也按这个顺序读，所以不需要交换——swap 是留给小端来源（PC 生成的数组）的。
# 真机验证过：True 会花屏（轮廓在、彩虹色、逐帧闪），False 才正常。
PREVIEW_SWAP = False


# drawRawBuf 的 len 参数按"像素个数"还是"字节数"算。底层是 LovyanGFX 的
# pushPixels(data, len, swap)，len 按像素计——传字节数（=2 倍）会让显示窗口
# 铺完一屏后绕回原点，再用越界读到的数据（多半是摄像头的另一块 framebuffer）
# 盖一遍，症状就是错块 + 竖条纹 + 逐帧乱跳。
# 真机若改成 True 后只画了上半屏，说明这版固件按字节算，改回 False。
PREVIEW_LEN_IN_PIXELS = True


# ── 直播推流 ──────────────────────────────────────────────────
#
# 网页要看实时画面。走 /upload-photo 那条路每帧都要新建 HTTP 连接 + base64
# （体积 +33%），实测一张 5~8 秒，根本不成流。这里改成一条常驻 TCP 连到
# 服务端 5002，每帧只发 4 字节大端长度 + RGB565 裸字节。
#
# 还要把分辨率降到 QQVGA(160×120)：单帧 38KB，是 QVGA 的四分之一。
# 两项加起来才够 2~4 fps——这仍是"连拍流"，不是设备本地预览那种流畅画面。
#
# 切分辨率需要 deinit + 重新 init，固件不一定有 deinit；没有就按当前分辨率
# 照传，只是慢一些，不至于整个功能不可用。

STREAM_ENABLED  = True   # 回退开关：False 则忽略所有直播命令


STREAM_MAX_SECS = 300    # 单次直播硬上限，服务端失联也不会让摄像头一直开着


STREAM_QQVGA    = True   # 直播降到 160×120；False=保持当前分辨率（更清晰更慢）


STREAM_SETTLE_FRAMES = 5 # 切完分辨率先丢几帧等曝光收敛，开头才不会忽明忽暗


# ── 取景模式（手动拍照） ──────────────────────────────────────
#
# 与语音触发拍照的唯一区别是"拍什么由眼睛决定"：实时预览 → 快门 → 确认，
# 确认后走的仍是 /chat-vision，同一套识别链路（服务端无 wav 时用默认提问）。

CAMERA_MODE_ENABLED = True      # 回退开关：False 则顶栏 CAM 键失效，短按一律录音


CAM_IDLE_TIMEOUT    = 90        # 取景/确认界面无操作自动退出（秒）


CAM_GC_EVERY        = 20        # 每 N 帧 gc 一次，压住抓帧的堆碎片


CAM_BAR_Y  = 200                # 底部按钮条上沿


# 预览只画到按钮条上沿，底栏就不用每帧补画（否则底部 40px 会轻微频闪）。
# 代价：取景框看到的是画面上面 200 行，发出去的仍是完整 240 行。
# 若裁剪后画面异常，改 False 即回到整帧铺满 + 每帧补画底栏的行为。
CAM_PREVIEW_CLIP = True


# ── UDP 自动发现服务端 ────────────────────────────────────────────────────────

_DISC_PORT    = 5001


_DISC_MSG     = b"KAGURA_DISCOVER"


_DISC_TIMEOUT = 2


_DISC_RETRIES = 3
