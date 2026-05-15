"""百度 access token 缓存：线程安全，单实例适配 ASR 或 TTS 任一凭据。"""

from __future__ import annotations

import json
import threading
import time
import urllib.request


class BaiduTokenCache:
    """缓存百度 OAuth access token，过期前自动刷新。线程安全（双重检查锁）。"""

    def __init__(self, api_key: str, secret_key: str, name: str = "baidu") -> None:
        self.api_key = api_key
        self.secret_key = secret_key
        self.name = name
        self._token: str | None = None
        self._expire: float = 0.0
        self._lock = threading.Lock()

    def get(self) -> str:
        if self._token and time.time() < self._expire:
            return self._token
        with self._lock:
            if self._token and time.time() < self._expire:
                return self._token
            self._token, self._expire = self._fetch()
            return self._token

    def _fetch(self) -> tuple[str, float]:
        url = (
            "https://aip.baidubce.com/oauth/2.0/token"
            f"?grant_type=client_credentials"
            f"&client_id={self.api_key}"
            f"&client_secret={self.secret_key}"
        )
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
        if "access_token" not in data:
            raise RuntimeError(f"百度 {self.name} token 获取失败: {data.get('error', data)}")
        expires_in = int(data.get("expires_in", 2592000))   # 默认 30 天
        return data["access_token"], time.time() + expires_in - 60
