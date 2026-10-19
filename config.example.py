BAIDU_API_KEY = "your_baidu_api_key"
BAIDU_SECRET_KEY = "your_baidu_secret_key"

# TTS 用（需要开通语音合成权限）
BAIDU_TTS_API_KEY = "your_baidu_tts_api_key"
BAIDU_TTS_SECRET_KEY = "your_baidu_tts_secret_key"

# 可选：共享密钥。留空 = 局域网内完全开放（默认，与旧版行为一致）。
# 设置后，/push、/capture-request 与监控网页的数据接口需携带 X-Api-Token 头。
API_TOKEN = ""

# 可选：直播流（TCP :5002）的握手密钥。留空 = 不校验，与其它设备上行接口一致。
# 要启用必须同时改 cores3_client.py 顶部的 STREAM_TOKEN，两边一致才连得上。
STREAM_TOKEN = ""
# 可选：角色表（OpenClaw 多 agent）。不写 = 只有一个默认角色，行为与旧版一致。
# - 第一个是默认角色（沿用原来的会话）；其余角色各自一条会话，上下文互不串
# - id：只能字母/数字/_-，同时是设备上图片目录名：/flash/kagura/resource/<id>/img_xxx.jpg
#   （缺哪张图就沿用默认那张，所以新角色可以只放一两张）
# - agent：openclaw 里的 agent 名；per：百度 TTS 音色号；aliases：语音里可能被认成的叫法
# 语音切换：「切换到 XX」「换成 XX」「叫 XX 出来」「我想和 XX 说话」；「有哪些角色」列出来
# ROLES = [
#     {"id": "",     "name": "神乐", "agent": "main", "per": 111, "aliases": ["kagura"]},
#     {"id": "mio",  "name": "小澪", "agent": "mio",  "per": 4,   "aliases": ["小玲", "小零"]},
# ]
