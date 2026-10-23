# 从「WSL + OpenClaw」旧方案迁移

旧方案：WSL 里跑 `voice_server.py` + mosquitto + OpenClaw，Windows 上用 `openclaw-startup.ps1`
做端口转发（5000/1883/5002）、跑 UDP 发现中继（5001），再加 Chrome 调试端口给 OpenClaw 的浏览器技能。

新服务端有三种用法，按你还要不要 OpenClaw 选：

| 方案 | 大脑 | 服务端装在 | 还要 WSL / 端口转发吗 | 适合 |
|---|---|---|---|---|
| **A（推荐）** | 内置 agent | Windows（安装包） | 都不要 | 愿意换成内置 agent |
| **B** | OpenClaw | WSL（deb 包） | 都还要（沿用 `openclaw-startup.ps1`） | 想保留 OpenClaw，改动最小 |
| **C** | OpenClaw | Windows（安装包） | 要 WSL（OpenClaw 在里面），不要端口转发 | 想保留 OpenClaw，又不想再折腾端口转发 |

无论哪种，**设备端都不用改**：设备靠 UDP 广播找服务端，服务端换了位置会自动找到。
新固件（Release 里的 `kagura-device-*.zip`）多一个「边生成边播」，可以以后再刷。

---

## 方案 A：Windows 安装版 + 内置 agent

### 1. 停掉旧的一整套

```powershell
# Windows 管理员 PowerShell：删端口转发、关发现中继、删旧防火墙规则
powershell -ExecutionPolicy Bypass -File C:\code\kagura-voice\openclaw-startup.ps1 -Stop
```

```bash
# WSL 里：停旧服务端和 mosquitto，并取消开机自启
pkill -f voice_server.py
sudo systemctl disable --now mosquitto     # 没开 systemd 的话：sudo service mosquitto stop
```

如果你把 `openclaw-startup.ps1` 放进了开机启动（启动文件夹或任务计划程序），也一并删掉。
**这一步必须做**：旧的端口转发占着 Windows 的 5000/1883/5002，不删的话新服务端起不来。
忘了也没关系：新版启动时会检查端口，告诉你是被谁占着，并问你要不要帮你删掉旧的端口转发、停掉 mosquitto
（会弹出管理员确认）。

### 2. 安装

运行 `Kagura-Setup-x.y.z.exe`，勾上「允许局域网里的设备连接」。装完会打开管理界面。

### 3. 搬旧数据

WSL 保持运行，在 Windows 命令行里（把 `Ubuntu`、`你` 换成你的发行版名和用户名；Windows 10 用 `\\wsl$\Ubuntu\...`）：

```powershell
& "C:\Program Files\Kagura\kagura.exe" migrate "\\wsl.localhost\Ubuntu\home\你\kagura-voice"
& "C:\Program Files\Kagura\kagura.exe" import-openclaw "\\wsl.localhost\Ubuntu\home\你\.openclaw"
```

- `migrate`：百度 Key、API_TOKEN、角色表、提醒、定时拍照、快照、语音缓存（缓存规则两版一致，搬过来省钱）。
- `import-openclaw`：不写路径会自动找（本机和各个 WSL 发行版里的 `~/.openclaw`）。读 OpenClaw 的 `openclaw.json`
  找出全部 agent，Kagura 里还没有的会新建（新建的要重启服务端才加载）。每个 agent 的 SOUL / IDENTITY / USER / AGENTS / TOOLS / HEARTBEAT / MEMORY 与每日笔记，
  以及 OpenClaw 的定时任务（**导入后默认暂停**）。也可以在管理界面「定时任务 → 从 OpenClaw 导入」里做。

改完要重启一下服务端（开始菜单「Kagura 服务端」，或注销重登让开机自启拉起来）。

### 4. 配模型

管理界面「设置 → 首次设置」：填一个模型服务商的接口地址、模型名、API Key，保存并测试。
设备要拍照看图的话，选一个能看图的模型并勾上「能看图」。

### 5. 收拾人设和任务（重要）

OpenClaw 时代的人设和任务里常写着「用 cores3-speak 播报」「用 cores3-camera 拍照」。新系统里它们是内置工具
`speak` / `take_photo`，**而且设备对话的回复本来就会播出来**，不需要再叫它播。建议：

- 「Agents → 人设文件」里搜 `cores3-`，改成「需要主动播报时用 speak 工具」或直接删掉；
- 「定时任务」里逐条打开导入的任务：指令里去掉「用 cores3-speak 播报」，把「投递到」改成你的设备
  （`device:cores3`），确认无误再启用；
- 写着依赖 OpenClaw 其它技能的任务（网页搜索、浏览器、天气……）**先别启用**，见下面「差异」。

### 6. 验证

- [ ] 「总览」里看到设备在线（设备心跳）
- [ ] 点设备屏幕说一句话，有回复
- [ ] 说「看看我手里拿的什么」能拍照识别
- [ ] 「定时任务」里对一条任务点「立即运行」，设备能播报
- [ ] 「设备」页「听最近一条录音」能听到

### 用起来和以前的差异

| 方面 | 旧方案 | 新（方案 A） |
|---|---|---|
| 启动 | 先开 WSL、跑 `openclaw-startup.ps1`、再起 `voice_server.py` | 开机自启，或开始菜单点一下 |
| 端口转发 / 发现中继 / mosquitto | 要 | 不要（都在一个程序里） |
| 改人设、看对话、管定时任务 | 改文件 / OpenClaw 控制台 | 管理界面 `http://127.0.0.1:5000/admin`（只限这台电脑） |
| 对话历史 | OpenClaw 的会话 | **不迁移**（重要的事已在 MEMORY.md 和每日笔记里，会一起导入） |
| OpenClaw 的技能 | 浏览器、网页搜索等都能用 | **还没有**：本期只迁了系统层（记忆、定时任务、heartbeat、多 agent），技能能读说明但不执行脚本。**依赖联网查资料的任务（比如「讲今天的新闻」）现在会编造**，先留在 OpenClaw 上（方案 B / C） |
| Chrome 调试端口（9222） | OpenClaw 浏览器技能要 | 不需要 |
| 数据位置 | WSL 里的仓库目录、`~/.openclaw` | `%APPDATA%\Kagura` |
| 电脑睡眠 | 服务停 | 一样会停：长期在线的话，电源计划里关掉自动睡眠 |

---

## 方案 B：新服务端也装在 WSL 里（继续用 OpenClaw）

最接近现在的用法：只是把 `voice_server.py` + mosquitto 换成一个 `kagura` 程序。

1. WSL 里停掉 `voice_server.py` 和 mosquitto（同方案 A 第 1 步的 WSL 部分；**`openclaw-startup.ps1` 别停**，端口转发和发现中继照样需要）。
2. 安装（用 deb；AppImage 在 WSL 里通常缺 FUSE）：
   ```bash
   sudo apt install ./kagura_x.y.z_amd64.deb
   kagura migrate ~/kagura-voice          # 迁配置与数据；没配模型时大脑默认就是 OpenClaw
   ```
3. 运行：开了 systemd 的 WSL 用 `systemctl --user enable --now kagura`；没开的话在 tmux / 终端里直接 `kagura`。
4. 管理界面：**在 Windows 浏览器打开 `http://localhost:5080/admin`**。
   WSL 里服务端会多开一个只给本机用的 5080 端口——经端口转发进来的请求在 WSL 里看全都来自 Windows 主机，
   分不清是你在本机打开还是局域网里别人打开，所以主端口 5000 上的管理界面会拒绝；5080 走 WSL 自带的
   localhost 转发，不经过端口转发，才认得出是本机。**不要把 5080 加进端口转发。**

## 方案 C：Windows 安装版 + 调用 WSL 里的 OpenClaw

服务端在 Windows 上原生跑（不再需要端口转发、发现中继、mosquitto），只有「想事情」这一步经 `wsl.exe` 交给 WSL 里的 OpenClaw。

1. 同方案 A 的第 1~3 步（停旧的、安装、`migrate`；`import-openclaw` 可以不做）。
2. 编辑 `%APPDATA%\Kagura\config.json`，加上（路径都是 **WSL 里的 Linux 路径**）：
   ```json
   {
     "brain": "openclaw",
     "openclaw": {
       "wsl_distro": "Ubuntu",
       "bin": "/home/你/.npm-global/bin/openclaw",
       "dir": "/home/你/.openclaw",
       "default_agent": "main"
     }
   }
   ```
3. 重启服务端。启动日志里应有「OpenClaw：经 wsl.exe 调用 Ubuntu 里的 …」。
   拍照识别时，照片会写到 `\\wsl.localhost\Ubuntu\home\你\.openclaw\workspace\tmp\`，再把 Linux 路径告诉 OpenClaw。

> 方案 C 的 `wsl.exe` 桥接是按文档写的，**还没在真机上跑过**；遇到问题把服务端日志发出来。
> 第一次调用会顺带拉起 WSL，稍慢几秒属正常。

## 常见问题

- **新服务端起不来，说端口被占用**：启动窗口里会列出是谁占着，并给出选项（删除旧端口转发 / 停掉 mosquitto /
  结束占用的程序），选一个回车就行。常见的是旧的端口转发（也可以手动 `openclaw-startup.ps1 -Stop`），
  或者 mosquitto、旧的 `voice_server.py` 还开着。
- **双击后提示「Kagura 已经在运行了」**：开机自启的那个已经在后台跑着，回车直接打开管理界面即可。
- **设备找不到服务端**：确认防火墙规则（安装包会加一条叫 Kagura 的规则）；电脑和设备在同一个 WiFi；
  方案 B 还要确认发现中继窗口开着。
- **管理界面打不开 / 403**：只能在运行服务端的那台电脑上开；方案 B 用 `http://localhost:5080/admin`。
- **想回到旧版**：卸载新版（数据不会删），重新运行 `openclaw-startup.ps1` 和 `voice_server.py` 即可，旧数据没动过。
