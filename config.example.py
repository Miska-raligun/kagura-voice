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