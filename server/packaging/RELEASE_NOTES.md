## 本版新增（0.1.0-beta.9）

- **管理界面「技能」页**：新建、编辑 SKILL.md 和脚本文件、上传文件、上传 .zip 技能包（ClawHub 下载的那种）、删除（进回收站）；
  技能可以给所有 agent 用，也可以只给某一个
- 从 OpenClaw 导入时，它装的技能也一起搬过来

## 0.1.0-beta.8

- **执行命令**：agent 能在这台电脑上跑命令和脚本了（Windows 默认 PowerShell，也可以交给 WSL 里的 bash），技能里的脚本也能直接跑。
  只有主人能触发（设备、网页聊天、定时任务、标了主人的 IM 私聊），IM 里的陌生人和群聊拿不到；借别的 agent 转手、建定时任务也绕不过去
- **联网搜索 + 读网页**：问新闻、天气、价格先查再答。什么都不配就能用（抓必应网页），也可以接博查 / Tavily / Brave / 自建 SearXNG
- **网络代理**：上网要走代理的，在「设置 → 工具」填上，联网和调模型都走它
- 「设置 → 工具」页：开关、选搜索服务、选用什么跑命令，带「试一下」按钮

## 0.1.0-beta.7

- **从 OpenClaw 导入定时任务修好了**：新版 OpenClaw 把任务存在 `~/.openclaw/state/openclaw.sqlite`，以前只读 `cron/jobs.json`，
  所以一条都没导进来。现在新版数据库、旧版 `jobs.json`（含 `cron.store` 指定的位置）、`openclaw.json` 里的 `cron.jobs` 都读，
  导入结果会写明任务从哪读到的；一条都没找到时列出查过的位置

## 0.1.0-beta.6

- **人设文件注入上限调大**：每个文件默认 2 万字（与 OpenClaw 一致，原来 SOUL 4000、其它 2000），最近笔记 8000 字；
  「Agents → 人设文件」里点「改上限」可以单独调，也可以在 config.json 写 `prompt_budgets`

## 0.1.0-beta.5

- 管理界面「图片与代码」：固件太旧、还不认在线更新的设备直接标出来并说明怎么办，不再显示「已通知」却没反应；
  代码已是最新、设备离线也会分别告诉你
- 设备收到「更新设备代码」后先在屏幕上显示「正在下载」，下载完再问你要不要装
- 更正烧录说明：从旧固件升级要用 USB 把 `main.py` 和 `src/` 下全部 `.py` 传一遍（以前写成只传 `main.py`）

## 0.1.0-beta.4

- **从 OpenClaw 导入修好了**：读 `openclaw.json` 找出全部 agent，Kagura 里没有的自动新建（以前只导进已有的 agent，
  第二个 agent 被静默跳过）；Windows 上不写路径会自动去 WSL 里找 `~/.openclaw`（以前只找 `C:\Users\你\.openclaw`，
  找不到也不报错）；导入结果逐个 agent 列出来，一个都没找到时告诉你查过哪些位置

## 0.1.0-beta.3

- **端口被占用不再「闪一下就关」**：启动时先检查端口，列出是谁占着（旧的 WSL 端口转发、mosquitto、旧服务端……），
  在窗口里问你怎么处理，选一下就帮你腾出来；已经有一个 Kagura 在后台运行时，直接打开管理界面
- 启动失败时窗口停住等你按回车，看得到原因

## 0.1.0-beta.2

- **管理界面传角色图片**：「设备 → 图片与代码」，每个角色一套背景图，任意图片自动裁成 320×240，传上去设备马上换
- **在线更新设备代码**：点「更新设备代码」，设备屏幕上点「更新」，装完自动重启；新代码起不来会自动换回旧代码
  （从旧固件升级时，要先用 USB 把固件包里的 `main.py` 和 `src/` 下全部 `.py` 传一遍，之后才能在线更新）
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
