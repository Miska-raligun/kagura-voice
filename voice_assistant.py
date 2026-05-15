#!/usr/bin/env python3
"""
OpenClaw 语音对话助手
- 麦克风录音 (ffmpeg + WSLg PulseAudio)
- 语音识别 (百度语音识别 API)
- 对话 (openclaw agent CLI，每次启动新 session，与主对话隔离)
- 语音合成 (edge-tts)
- 音频播放 (ffplay)

使用: python3 voice_assistant.py
退出: Ctrl+C
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import time
import uuid
import wave
from pathlib import Path
from typing import Optional

import numpy as np
import urllib.request
import urllib.parse

# ── 路径配置 ──────────────────────────────────────────────────────────────────

OPENCLAW_DIR = Path.home() / ".openclaw"
TTS_SCRIPT = str(OPENCLAW_DIR / "workspace/skills/edge-tts/scripts/tts-converter.js")
TTS_VOICE = "zh-CN-XiaoxiaoNeural"
OPENCLAW_BIN = str(Path.home() / ".npm-global/bin/openclaw")
AGENT_ID = "main"

# PulseAudio (WSLg)
PULSE_ENV = {**os.environ, "PULSE_SERVER": "unix:/mnt/wslg/PulseServer"}

# 临时文件
WAV_PATH = "/tmp/oc_voice_input.wav"
MP3_PATH = "/tmp/oc_voice_response.mp3"

# ── VAD 参数 ──────────────────────────────────────────────────────────────────

SAMPLE_RATE = 16000
CHUNK_DURATION = 0.1        # 每次读取 100ms
SILENCE_THRESHOLD = 0.008   # RMS 低于此值视为静音（调低，避免丢开头音节）
SILENCE_DURATION = 2.0      # 连续静音超过此秒数停止录音
MAX_RECORD_SECONDS = 60     # 最大录音时长
POST_PLAY_DELAY = 0.8       # 播放结束后等待时间（防止麦克风录到回放声）
PRE_BUFFER_SECONDS = 0.5    # 预缓冲时长：保留触发前的音频，防止丢开头

# ── 百度语音识别 ──────────────────────────────────────────────────────────────

from config import BAIDU_API_KEY, BAIDU_SECRET_KEY
from oc_utils import _extract_json, strip_markdown


# ── 提示音 ────────────────────────────────────────────────────────────────────

def beep(freq: int = 880, duration: float = 0.12, block: bool = False) -> None:
    """播放短提示音。block=True 时等待播完再返回（用于录音前）。"""
    args = [
        "ffplay", "-autoexit", "-nodisp", "-loglevel", "error",
        "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={duration}",
    ]
    if block:
        subprocess.run(args, env=PULSE_ENV,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        subprocess.Popen(args, env=PULSE_ENV,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ── 百度 Token ────────────────────────────────────────────────────────────────

def get_baidu_token() -> str:
    """获取百度 access token，有效期 30 天。"""
    url = (
        "https://aip.baidubce.com/oauth/2.0/token"
        f"?grant_type=client_credentials"
        f"&client_id={BAIDU_API_KEY}"
        f"&client_secret={BAIDU_SECRET_KEY}"
    )
    with urllib.request.urlopen(url, timeout=10) as resp:
        data = json.loads(resp.read())
    if "access_token" not in data:
        raise RuntimeError(f"获取百度 token 失败: {data}")
    return data["access_token"]


# ── 录音 ──────────────────────────────────────────────────────────────────────

def record_until_silence() -> Optional[str]:
    """
    从麦克风录音，检测到说话后开始收集，
    静音超过 SILENCE_DURATION 秒后停止。
    返回 WAV 文件路径，或用户未说话则返回 None。
    """
    chunk_size = int(SAMPLE_RATE * CHUNK_DURATION) * 2  # int16 = 2 bytes/sample
    silence_needed = int(SILENCE_DURATION / CHUNK_DURATION)
    max_chunks = int(MAX_RECORD_SECONDS / CHUNK_DURATION)

    # 开始提示音：在 ffmpeg 启动前播完，不会被录进去
    beep(freq=880, duration=0.10, block=True)
    print("🎤  等待说话...", end="", flush=True)

    proc = subprocess.Popen(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-fflags", "+genpts",
            "-f", "pulse", "-i", "default",
            "-ar", str(SAMPLE_RATE), "-ac", "1",
            "-f", "s16le", "pipe:1",
        ],
        stdout=subprocess.PIPE,
        env=PULSE_ENV,
    )

    pre_buffer_size = int(PRE_BUFFER_SECONDS / CHUNK_DURATION)
    pre_buffer = []   # 滑动窗口，保留触发前的音频块
    frames = []
    silence_frames = 0
    speech_started = False
    total_chunks = 0

    try:
        while total_chunks < max_chunks:
            data = proc.stdout.read(chunk_size)
            if not data:
                break

            total_chunks += 1
            audio = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
            rms = float(np.sqrt(np.mean(audio ** 2)))

            if rms > SILENCE_THRESHOLD:
                if not speech_started:
                    # 把预缓冲里的音频一起纳入，避免丢掉开头音节
                    frames.extend(pre_buffer)
                    pre_buffer.clear()
                    print("\r🔴  录音中...    ", end="", flush=True)
                    speech_started = True
                silence_frames = 0
                frames.append(data)
            elif speech_started:
                frames.append(data)
                silence_frames += 1
                if silence_frames >= silence_needed:
                    beep(freq=440, duration=0.15)
                    print("\r⏹️  录音结束     ", flush=True)
                    break
            else:
                # 还没检测到说话：维持滑动预缓冲
                pre_buffer.append(data)
                if len(pre_buffer) > pre_buffer_size:
                    pre_buffer.pop(0)
    finally:
        proc.terminate()
        proc.wait()

    if not speech_started or not frames:
        return None

    # 去掉末尾多余静音帧
    keep = max(1, len(frames) - silence_needed + 2)
    frames = frames[:keep]

    with wave.open(WAV_PATH, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(b"".join(frames))

    return WAV_PATH


# ── 语音识别 ──────────────────────────────────────────────────────────────────

def transcribe(token: str, audio_path: str) -> str:
    """调用百度语音识别 API，返回文字。"""
    print("💬  识别中...", end="", flush=True)

    with open(audio_path, "rb") as f:
        audio_data = f.read()

    payload = json.dumps({
        "format": "wav",
        "rate": SAMPLE_RATE,
        "channel": 1,
        "cuid": "voice_assistant",
        "token": token,
        "speech": base64.b64encode(audio_data).decode("utf-8"),
        "len": len(audio_data),
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://vop.baidu.com/server_api",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read())

    if result.get("err_no") != 0:
        print(f"\r⚠️  识别失败: {result.get('err_msg', result)}")
        return ""

    text = result["result"][0].strip()
    if len(text) < 1:
        print("\r⚠️  未识别到内容")
        return ""

    print(f"\r🗣️  {text}")
    return text


# ── 对话 ──────────────────────────────────────────────────────────────────────

def chat(user_text: str, session_id: str) -> str:
    """
    调用 openclaw agent CLI 发送消息，返回回复文字。
    session_id 由调用方在启动时生成，整个会话复用，与主对话隔离。
    """
    print("🤖  思考中...", end="", flush=True)

    result = subprocess.run(
        [
            OPENCLAW_BIN, "agent",
            "--agent", AGENT_ID,
            "--message", user_text,
            "--session-id", session_id,
            "--json",
            "--timeout", "120",
        ],
        capture_output=True,
        text=True,
        timeout=130,
    )

    if result.returncode != 0:
        raise RuntimeError(f"openclaw agent 失败: {result.stderr[:300]}")

    data = _extract_json(result.stdout)

    if data.get("status") != "ok":
        raise RuntimeError(f"Agent 返回错误状态: {data.get('status')}")

    reply_text = data["result"]["payloads"][0]["text"]
    preview = reply_text[:120].replace("\n", " ")
    print(f"\r💬  {preview}{'...' if len(reply_text) > 120 else ''}")
    return reply_text


# ── TTS ───────────────────────────────────────────────────────────────────────

def synthesize(text: str) -> Optional[str]:
    """调用 edge-tts 生成 MP3，返回文件路径。"""
    clean = strip_markdown(text)
    if not clean:
        return None

    print("🔊  合成语音...", end="", flush=True)
    result = subprocess.run(
        ["node", TTS_SCRIPT, clean, "--voice", TTS_VOICE, "--output", MP3_PATH],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        print(f"\n⚠️  TTS 失败: {result.stderr[:200]}")
        return None

    return MP3_PATH


# ── 播放 ──────────────────────────────────────────────────────────────────────

def play(mp3_path: str) -> None:
    """用 ffplay 播放 MP3，阻塞直到播放完毕，再稍作延迟防止回声入麦。"""
    print("\r🔊  播放中...  ", end="", flush=True)
    subprocess.run(
        ["ffplay", "-autoexit", "-nodisp", "-loglevel", "error", mp3_path],
        env=PULSE_ENV,
    )
    # 等待扬声器余音消散，避免麦克风录到回放声
    time.sleep(POST_PLAY_DELAY)
    print("\r              ", end="\r", flush=True)


# ── 主循环 ────────────────────────────────────────────────────────────────────

def main() -> None:
    print("=" * 50)
    print("  OpenClaw 语音对话助手")
    print("=" * 50)

    print("获取百度语音识别 token...", end="", flush=True)
    baidu_token = get_baidu_token()
    print(" OK")

    # 每次启动生成新 session ID，与主对话完全隔离
    session_id = str(uuid.uuid4())

    print(f"Agent   : {AGENT_ID}")
    print(f"Session : {session_id[:8]}... (新会话，独立于主对话)")
    print(f"TTS     : {TTS_VOICE}")
    print("按 Ctrl+C 退出\n")

    while True:
        try:
            # 1. 录音
            audio_path = record_until_silence()
            if not audio_path:
                continue

            # 2. 语音识别
            user_text = transcribe(baidu_token, audio_path)
            if not user_text:
                continue

            # 3. 对话
            reply = chat(user_text, session_id)

            # 4. TTS
            mp3_path = synthesize(reply)
            if not mp3_path:
                continue

            # 5. 播放
            play(mp3_path)

            print()  # 空行分隔每轮对话

        except KeyboardInterrupt:
            print("\n\n再见！")
            sys.exit(0)
        except subprocess.TimeoutExpired:
            print("\n⚠️  超时，重试")
        except Exception as e:
            print(f"\n⚠️  错误: {e}")


def main_text() -> None:
    """文字输入模式：输入文字 → openclaw 回复 → 语音播放。"""
    print("=" * 50)
    print("  OpenClaw 语音助手（文字模式）")
    print("=" * 50)
    print(f"Agent : {AGENT_ID}  |  TTS : {TTS_VOICE}")
    print("输入文字后回车发送，Ctrl+C 或输入空行退出\n")

    session_id = str(uuid.uuid4())

    while True:
        try:
            user_text = input("你 > ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\n再见！")
            sys.exit(0)

        if not user_text:
            print("再见！")
            sys.exit(0)

        try:
            reply = chat(user_text, session_id)
            mp3_path = synthesize(reply)
            if mp3_path:
                play(mp3_path)
            print()
        except subprocess.TimeoutExpired:
            print("⚠️  超时，重试")
        except Exception as e:
            print(f"⚠️  错误: {e}")


if __name__ == "__main__":
    if "--text" in sys.argv:
        main_text()
    else:
        main()
