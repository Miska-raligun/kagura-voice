#!/usr/bin/env python3
"""打设备固件包：dist/kagura-device-<版本>.zip（目录结构 = 设备 flash 结构 + 烧录说明）。

    python3 tools/pack_device.py 1.2.3 server/dist
"""
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    ver = sys.argv[1]
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "dist")
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"kagura-device-{ver}.zip"
    dev = ROOT / "device"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(dev / "main.py", "flash/main.py")
        for f in sorted((dev / "src").glob("*.py")):
            z.write(f, f"flash/kagura/src/{f.name}")
        for f in sorted((dev / "resource").glob("*")):
            if f.is_file():
                z.write(f, f"flash/kagura/resource/{f.name}")
        z.write(ROOT / "server" / "packaging" / "device" / "烧录说明.md", "烧录说明.md")
        z.writestr("VERSION", ver + "\n")
    print(out, out.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
