#!/usr/bin/env bash
# 打 Linux 包：.deb（systemd 用户服务）与 AppImage（双击即跑）。
#   用法：packaging/linux/build.sh <版本号>     需要先有 dist/kagura（单文件可执行）与 dist/icon.png
#   产物：dist/kagura_<版本>_amd64.deb、dist/Kagura-<版本>-x86_64.AppImage
set -euo pipefail
VER="${1:?版本号}"
cd "$(dirname "$0")/../.."
HERE=packaging/linux
OUT=dist
test -x "$OUT/kagura" && test -f "$OUT/icon.png"

# ── .deb ──
D="$(mktemp -d)/kagura_${VER}_amd64"
install -Dm755 "$OUT/kagura" "$D/opt/kagura/kagura"
mkdir -p "$D/usr/bin" && ln -s /opt/kagura/kagura "$D/usr/bin/kagura"
install -Dm644 "$HERE/kagura.service" "$D/usr/lib/systemd/user/kagura.service"
install -Dm644 "$HERE/kagura-admin.desktop" "$D/usr/share/applications/kagura-admin.desktop"
install -Dm644 "$OUT/icon.png" "$D/usr/share/icons/hicolor/256x256/apps/kagura.png"
mkdir -p "$D/DEBIAN"
cat > "$D/DEBIAN/control" <<CTRL
Package: kagura
Version: ${VER}
Section: sound
Priority: optional
Architecture: amd64
Maintainer: Kagura Voice <noreply@example.com>
Description: Kagura 语音服务端
 CoreS3 语音助手的服务端：设备接口、内置 MQTT、内置 agent 系统、IM 渠道与本机管理界面。
 单文件可执行，不依赖系统里的 Node / Python。
CTRL
cat > "$D/DEBIAN/postinst" <<'POST'
#!/bin/sh
set -e
cat <<MSG

Kagura 已安装。用你自己的账号（不要 sudo）启动并设为开机自启：
    systemctl --user enable --now kagura
    loginctl enable-linger "$USER"     # 可选：不登录桌面也保持运行
然后打开管理界面：http://127.0.0.1:5000/admin
设备连不上时检查防火墙放行 TCP 5000/1883/5002、UDP 5001（ufw: sudo ufw allow 5000:5002/tcp && sudo ufw allow 1883/tcp && sudo ufw allow 5001/udp）
从旧版迁移：kagura migrate <voice_server.py 所在目录>

MSG
POST
chmod 755 "$D/DEBIAN/postinst"
dpkg-deb --root-owner-group --build "$D" "$OUT/kagura_${VER}_amd64.deb"

# ── AppImage ──
A="$(mktemp -d)/Kagura.AppDir"
install -Dm755 "$OUT/kagura" "$A/usr/bin/kagura"
install -Dm644 "$OUT/icon.png" "$A/kagura.png"
cat > "$A/AppRun" <<'RUN'
#!/bin/sh
exec "$APPDIR/usr/bin/kagura" "$@"
RUN
chmod 755 "$A/AppRun"
# 在终端里运行：能看到日志，首次启动自动打开管理界面
cat > "$A/kagura.desktop" <<'DESK'
[Desktop Entry]
Type=Application
Name=Kagura
Comment=Kagura 语音服务端
Exec=kagura
Icon=kagura
Terminal=true
Categories=Utility;
DESK
TOOL="${APPIMAGETOOL:-$(mktemp -d)/appimagetool}"
if [ ! -x "$TOOL" ]; then
  curl -fsSL -o "$TOOL" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$TOOL"
fi
# CI 里没有 FUSE：解包运行
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "$TOOL" --no-appstream "$A" "$OUT/Kagura-${VER}-x86_64.AppImage"
ls -la "$OUT"/*.deb "$OUT"/*.AppImage
