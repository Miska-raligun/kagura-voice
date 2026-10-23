## 本版新增（0.1.0-beta.2）

- **管理界面传角色图片**：「设备 → 图片与代码」，每个角色一套背景图，任意图片自动裁成 320×240，传上去设备马上换
- **在线更新设备代码**：点「更新设备代码」，设备屏幕上点「更新」，装完自动重启；新代码起不来会自动换回旧代码
  （自动回滚需要新版 `/flash/main.py`，从旧固件升级时用 USB 手动传一次，见固件包里的烧录说明）
- 从 WSL + OpenClaw 迁移的指南（仓库 `docs/migrate-from-wsl.md`）；新版也能装在 WSL 里（管理界面 `http://localhost:5080/admin`）

## 下载哪个

| 系统 | 文件 | 说明 |
|---|---|---|
| Windows 10/11（64 位） | `Kagura-Setup-*.exe` | 安装包：自动加防火墙规则，可选开机自启，装完打开管理界面 |
| Linux（Debian / Ubuntu） | `kagura_*_amd64.deb` | `sudo apt install ./kagura_*.deb`，然后 `systemctl --user enable --now kagura` |
| Linux（其它发行版） | `Kagura-*-x86_64.AppImage` | `chmod +x` 后双击或在终端运行 |
| CoreS3 设备固件 | `kagura-device-*.zip` | 按包里的「烧录说明.md」上传到设备 |

`SHA256SUMS` 是校验和。安装包暂未签名，Windows 可能提示「未知发布者」，点「更多信息 → 仍要运行」。

## 第一次用

1. 装好后打开 **http://127.0.0.1:5000/admin**（只限本机），在「设置 → 首次设置」填你自己的模型服务商、模型名和 API Key（不预设任何模型），再填百度语音 Key。
2. 设备开机后会在局域网自动找到服务端。
3. 从旧版迁移：`kagura migrate <voice_server.py 所在目录>`；从 OpenClaw 迁移：管理界面「定时任务 → 从 OpenClaw 导入」。
4. 旧的 mosquitto 要停掉：新服务端自带 MQTT（端口 1883）。

数据在 `%APPDATA%\Kagura`（Windows）或 `~/.local/share/kagura`（Linux），卸载不会删除。
