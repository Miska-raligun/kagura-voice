#!/usr/bin/env python3
"""把旧版（voice_server.py）的配置与运行时状态迁到新服务端（server/）的数据目录。

    python3 tools/migrate_to_server.py              # 迁到默认数据目录
    python3 tools/migrate_to_server.py --to DIR     # 指定数据目录（与 KAGURA_DATA_DIR 一致）

做两件事：
  1. config.py → <数据目录>/config.json（百度密钥、API_TOKEN、STREAM_TOKEN、ROLES）
  2. 复制 reminders.json / photo_schedules.json / roles_state.json / snapshots/（格式两版一致）
已存在的 config.json 不覆盖（除非 --force），状态文件同理。
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def default_data_dir() -> Path:
    home = Path.home()
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming") / "Kagura"
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Kagura"
    return Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share") / "kagura"


def load_old_config() -> dict:
    sys.path.insert(0, str(ROOT))
    import config  # noqa: E402  旧版 config.py

    g = lambda k, d="": getattr(config, k, d)  # noqa: E731
    out = {
        "baidu": {
            "asr_key": g("BAIDU_API_KEY"), "asr_secret": g("BAIDU_SECRET_KEY"),
            "tts_key": g("BAIDU_TTS_API_KEY"), "tts_secret": g("BAIDU_TTS_SECRET_KEY"),
        },
        "api_token": g("API_TOKEN"),
        "stream_token": g("STREAM_TOKEN"),
    }
    roles = g("ROLES", None)
    if roles:
        out["roles"] = roles
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", type=Path, default=None, help="新服务端数据目录")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的文件")
    a = ap.parse_args()
    dest: Path = a.to or Path(os.environ.get("KAGURA_DATA_DIR") or default_data_dir())
    dest.mkdir(parents=True, exist_ok=True)
    print(f"数据目录: {dest}")

    cfg_file = dest / "config.json"
    if cfg_file.exists() and not a.force:
        print(f"  跳过 config.json（已存在，加 --force 覆盖）")
    else:
        cfg_file.write_text(json.dumps(load_old_config(), ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  写入 config.json")

    for name in ("reminders.json", "photo_schedules.json", "roles_state.json"):
        src, dst = ROOT / name, dest / name
        if not src.exists():
            continue
        if dst.exists() and not a.force:
            print(f"  跳过 {name}（已存在）")
            continue
        shutil.copy2(src, dst)
        print(f"  复制 {name}")

    snaps = ROOT / "snapshots"
    if snaps.is_dir():
        (dest / "snapshots").mkdir(exist_ok=True)
        n = 0
        for f in snaps.glob("*.jpg"):
            t = dest / "snapshots" / f.name
            if not t.exists():
                shutil.copy2(f, t)
                n += 1
        print(f"  复制快照 {n} 张")
    print("完成。启动新服务端前先停掉旧的 voice_server.py 和 mosquitto（端口 1883 由新服务端内置 broker 占用）。")


if __name__ == "__main__":
    main()
