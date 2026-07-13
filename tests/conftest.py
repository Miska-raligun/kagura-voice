"""测试公共设施：在导入 voice_server 前注入 config / paho 桩，隔离外部依赖。"""

import sys
import types

import pytest


def _install_stubs():
    # config 桩：故意不设 API_TOKEN，顺便验证旧版 config.py 的兼容路径
    cfg = types.ModuleType("config")
    cfg.BAIDU_API_KEY = "test_asr_key"
    cfg.BAIDU_SECRET_KEY = "test_asr_secret"
    cfg.BAIDU_TTS_API_KEY = "test_tts_key"
    cfg.BAIDU_TTS_SECRET_KEY = "test_tts_secret"
    sys.modules.setdefault("config", cfg)

    # paho 桩：环境里装不上也不该在单测里连真 broker
    if "paho.mqtt.client" not in sys.modules:
        paho = types.ModuleType("paho")
        mqtt_mod = types.ModuleType("paho.mqtt")
        client_mod = types.ModuleType("paho.mqtt.client")

        class FakeMqttClient:
            def __init__(self, *args, **kwargs):
                self.published = []

            def connect(self, *args, **kwargs):
                pass

            def loop_start(self):
                pass

            def publish(self, topic, payload, qos=0):
                self.published.append((topic, payload, qos))

        client_mod.Client = FakeMqttClient
        paho.mqtt = mqtt_mod
        mqtt_mod.client = client_mod
        sys.modules["paho"] = paho
        sys.modules["paho.mqtt"] = mqtt_mod
        sys.modules["paho.mqtt.client"] = client_mod


_install_stubs()

import voice_server  # noqa: E402


@pytest.fixture()
def vs():
    """每个测试独立的 ServerState，避免限流/会话状态串测。"""
    voice_server.state = voice_server.ServerState()
    voice_server.app.config["TESTING"] = True
    return voice_server


@pytest.fixture()
def client(vs):
    return vs.app.test_client()


@pytest.fixture()
def fake_wav(tmp_path, monkeypatch, vs):
    """把 synthesize 替换为写一个假 WAV 文件，返回其路径。"""
    wav = tmp_path / "out.wav"
    wav.write_bytes(b"RIFF....WAVEfake-audio")
    monkeypatch.setattr(vs, "synthesize", lambda text: str(wav))
    return wav
