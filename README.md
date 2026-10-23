# Kagura Voice

一个住在桌面小设备里的中文语音伙伴：M5Stack CoreS3 负责听、说、看、被摸，
电脑上的服务端负责思考、记事、按时提醒，还能在飞书 / QQ 上陪你聊天。

- **装上就能用**：Windows / Linux 安装包，一个程序包含全部服务（不用装 Python、Node、mosquitto、OpenClaw）
- **自带 agent 系统**：人设文件、长期记忆、定时任务、heartbeat 主动关心、多个角色互相协作
- **模型自己选**：DeepSeek、通义、Kimi、智谱、Claude、GPT、Gemini、本机 Ollama……都由你自己填，不预设
- **本机管理界面**：浏览器打开就能改人设、看对话、管定时任务、接 IM，不用碰配置文件

## 下载安装

到 [Releases](https://github.com/Miska-raligun/kagura-voice/releases) 下载：

| 系统 | 文件 | 怎么装 |
|---|---|---|
| Windows 10/11 | `Kagura-Setup-x.y.z.exe` | 双击安装。会自动放行防火墙、可选开机自启，装完打开设置向导 |
| Debian / Ubuntu | `kagura_x.y.z_amd64.deb` | `sudo apt install ./kagura_*.deb`，再 `systemctl --user enable --now kagura` |
| 其它 Linux | `Kagura-x.y.z-x86_64.AppImage` | `chmod +x` 后运行 |
| CoreS3 固件 | `kagura-device-x.y.z.zip` | 按包里的「烧录说明.md」上传到设备 |

> 安装包暂未签名，Windows 可能提示「未知发布者」：点「更多信息 → 仍要运行」。
> macOS 版暂不发布（代码可以编译，等有开发者账号再签名发布）。

## 第一次用

1. **打开管理界面**：装好后会自动打开；也可以手动访问 <http://127.0.0.1:5000/admin>（只限这台电脑）。
2. **接一个模型**：「设置 → 首次设置」里填接口地址、模型名、API Key，点「保存并测试」。
3. **填语音 Key**：「设置 → 语音与设备」填[百度智能云](https://console.bce.baidu.com)的语音识别、语音合成 Key。
4. **刷设备**：按固件包的烧录说明上传，设备开机、屏幕上连 WiFi，会在局域网里自动找到服务端。
5. **跟她说话**：点一下屏幕说话。想改她的性格，去「Agents → 人设文件」改 `SOUL.md`。

**旧版用户（WSL + OpenClaw）**：看 [docs/migrate-from-wsl.md](docs/migrate-from-wsl.md)——换 Windows 安装版、
继续在 WSL 里跑、或者 Windows 版调用 WSL 里的 OpenClaw，三种做法的步骤和差异都在里面。
最要紧的一条：先运行 `openclaw-startup.ps1 -Stop` 删掉旧的端口转发，否则新服务端占不到端口。

## 能做什么

**设备上**（详见 [docs/device.md](docs/device.md)）

- 点一下说话；连续对话、声控唤醒两种免手模式，说「不聊了」就退出
- 长回复**边生成边播**：第一句合成好就出声
- 拍照问「这是什么」；取景模式手动拍；远程拍照、网页直播、每日定时拍照并播报
- 「三分钟后提醒我关火」「小声一点」「现在几点」本地秒回，不花模型的钱
- 摸摸她、拿起来、摇一摇都会有反应；蓝牙感知你在不在家
- 多个角色（不同性格、声音和形象）一键切换

**大脑**（内置 agent 系统，也可以继续接 OpenClaw）

| 能力 | 说明 |
|---|---|
| 人设 | 每个 agent 一套 `SOUL.md` / `IDENTITY.md` / `USER.md` / `AGENTS.md` 等，和 OpenClaw 同名同义，直接拷过来就能用 |
| 记忆 | `MEMORY.md` 加每日笔记；关键词 + 向量混合检索；对话太长时先把要紧的事记下来再压缩 |
| 定时任务 | 一次性 / 间隔 / cron，投递到设备或 IM；活跃时段、失败重试；她自己也能建（「每天八点给我讲新闻」） |
| Heartbeat | 定期按清单检查有没有该告诉你的事，没事就不打扰 |
| 多 agent | 角色之间可以互相发消息、派子任务，有权限矩阵和防失控限制 |
| 技能 | 兼容 `SKILL.md` 文件夹格式（本期只读说明，不执行脚本） |
| IM | 飞书、QQ 官方机器人（都不需要公网），陌生人配对制，群里只回 @；记忆跨渠道共享 |

## 管理界面

<http://127.0.0.1:5000/admin>：总览 · Agents · 会话 · 记忆 · 定时任务 · Agent 通信 · 渠道 · 设备 · 网页聊天 · 用量 · 设置。
设备监控页（拍照、直播）在 `http://<电脑IP>:5000/monitor`，局域网可访问（可设访问密钥）。

## 数据与隐私

所有数据都在你自己的电脑上：Windows `%APPDATA%\Kagura`，Linux `~/.local/share/kagura`。
人设、记忆是普通 markdown 文件，对话与任务在 SQLite 里。备份就拷这个目录；卸载不会删除它。
对外只连你自己配置的模型服务商、百度语音和 IM 平台。

## 端口

| 端口 | 用途 |
|---|---|
| 5000/tcp | 设备接口、监控页、管理界面（管理界面只限本机） |
| 1883/tcp | 内置 MQTT（主动播报、远程拍照） |
| 5001/udp | 设备自动发现服务端 |
| 5002/tcp | 摄像头直播 |

Windows 安装包会自动放行；Linux 如果开了防火墙需要手动放行这四个端口。

## 仓库结构

| 路径 | 内容 |
|---|---|
| [`server/`](server/README.md) | 服务端（TypeScript，打成单文件可执行）：设备接口、agent 系统、IM 渠道、管理界面 |
| [`device/`](docs/device.md) | CoreS3 固件（MicroPython） |
| `contract-tests/` | 黑盒契约测试：只走 HTTP/MQTT/UDP/TCP，新旧服务端共用一套 |
| `docs/` | [开发计划](docs/plan-kagura-agent.md)、[设备使用指南](docs/device.md)、[旧版服务端说明](docs/legacy-python.md) |
| `voice_server.py` 等 | 旧版 Python 服务端（已被 `server/` 取代，保留到迁移完成） |
| `CLAUDE.md` | 架构与踩坑记录（开发必读） |

## 开发

```bash
cd server && npm ci
npx tsc --noEmit -p . && npx tsc --noEmit -p admin-ui && npx vitest run   # 类型检查 + 单测
node scripts/build.mjs && node dist/kagura.cjs                              # 构建并运行
cd ../contract-tests && KAGURA_SERVER_CMD="node server/dist/kagura.cjs" KAGURA_SERVER_PROVIDES=broker,discovery python -m pytest -q
python3 tools/check_split.py && python3 tools/import_sim.py                # 固件静态检查
```

发布：打 `v*` tag，或者改 `server/packaging/release-version.txt` 里的版本号并推送（工作流会在该提交上建 tag）。
GitHub Actions 会构建安装包、在 Windows / Linux 上真装一遍并跑完整契约测试，通过后才发 Release。
带 `-` 的版本（如 `0.1.0-beta.1`）发成预发布。
