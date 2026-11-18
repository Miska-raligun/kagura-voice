# 管理接口、托盘、更新、导出、退出

> 踩坑记录（LRN），从 CLAUDE.md 按子系统拆出来的。加管理接口、改托盘 / 日志 / 在线更新 / 导出导入 / 进程退出 / 管理界面列表之前先读这份；新踩的坑也记在这里（写清症状、原因、别改坏的点）。

- **日志与 Windows 托盘（`util/logfile.ts` / `tray.ts`）**：控制台照常输出，同时 tee 到 `<数据目录>/logs/kagura.log`，5MB 滚动、留 3 份。
  `--tray` 用 `Start-Process -WindowStyle Hidden` 起隐藏子进程（**别直接 spawn**：子进程会挂在父控制台上，父进程一退就被关掉；
  且 SEA 的 `process.argv` 有时会多带一次 exe 路径，必须过滤，否则会被当子命令报错）。
  子进程起服务端后用 PowerShell NotifyIcon 出托盘：打开管理页面 / 打开日志 / 重启 / 退出；退出走 `POST /api/admin/quit`。
  托盘脚本写成 `<数据目录>/logs/tray.ps1`（UTF-16 带 BOM），再用 `Start-Process -File` 起独立隐藏进程——
  **别用 spawn + -EncodedCommand**：实测子进程秒退 code=0、什么都不做；脚本里 `[ref]$created` 前必须先 `$created = $false`，否则 PowerShell 报「无法将 [ref] 应用于不存在的变量」。
  托盘用 `Global\\KaguraTrayMutex` 防重复；定时轮询 `/api/admin/meta`，服务端没了就自己消失。
  隐藏进程设 `KAGURA_NO_PROMPT=1`，preflight 和出错后的「按回车」都不再等待（否则没有窗口时会永久卡住）。
- **管理界面保存文件要带版本（`routes/admin.ts` 的 `fileVersion` / `staleSave`，2026-11，主人「共享文件是否存在多 agent 的读写并发问题」）**：
  人设 / 记忆文件的编辑框打开以后，她可能 `memory_write` 了、整理改过、别的 agent 改过共享那份；以前保存是整份覆盖，这些就丢了。
  `GET …/file` 返回 `version`（内容 sha1 前 16 位），`PUT` 带回 `base`，对不上就 409（`stale: true`），页面提示「打开之后被改过」、给「重新加载」；
  保存成功返回新的 `version`，页面接着用它（别存完再去 GET 一次——那中间又被改的话就被当成最新的了）。不带 `base` 的老页面照旧直接存。
- **管理接口与设备信任（`routes/admin.ts` 的 `isLocal`、`ctx.deviceTrusted`，LRN 2026-10-23 安全检查）**：
  ① 管理接口光看「来源是 127.0.0.1」不够——你电脑上任何网页都能让浏览器往 127.0.0.1 发请求（跨站请求伪造），
  DNS 重绑定还能绕过同源。`isLocal` 同时要求 Host 是本机地址、跨站的 Origin / `Sec-Fetch-Site: cross-site` 一律拒绝
  （顶层导航 GET 例外）。**新加管理接口一律走 guard，别自己判断来源**——漏了就是网页一键装扩展包、执行命令。
  ② 设备上行接口（/chat 等）固件不带口令，同一 WiFi 谁都能冒充设备；而设备对话是可信的（能 exec）。所以
  `deviceTrusted`：第一台心跳的设备自动受信，之后的新设备要在管理界面批准，且请求 IP 必须是它心跳的 IP；
  带 Origin / Sec-Fetch-* 的（浏览器发的）一律不受信。新加「设备触发 agent」的入口要把 `trusted: ctx.deviceTrusted(req, dev)` 传进去。
  WSL + portproxy 下所有局域网请求看起来都来自同一个 Windows 地址，IP 绑定在那里形同虚设（已在 README 说明）。
- **Windows 托盘版（`kagura-tray.exe`）**：和 `kagura.exe` 是同一个文件，只把 PE 头的子系统改成「图形界面」
  （`scripts/gui-exe.mjs`），启动根本不建控制台窗口。别再回到「先开窗口、PowerShell 拉起隐藏进程」的做法——
  Windows 11 默认用 Windows Terminal 托管控制台，隐藏参数经常被无视（beta.17/18 就栽在这）。托盘版里 console 看不见
  （Node 自动丢弃输出，日志靠 `logs/kagura.log`），不能停下来问人（`KAGURA_NO_PROMPT`），出错要 `messageBox` 弹框；
  它派生的子进程都要 `windowsHide: true`，否则每跑一次命令就闪一个黑窗口。CI（server.yml / release.yml）有托盘版冒烟。
- **导出 / 导入（`backup.ts`）与在线更新（`util/selfupdate.ts`）**：导入**绝不能在运行中直接覆盖数据库**——
  写到 `.import-pending/`，重启后 `main()` 第一件事 `applyPending()`（在 loadConfig 之后、任何 DatabaseSync 之前）。
  导出数据库用 `VACUUM INTO` 拍快照（WAL 里的也在），不用停服务。新加数据目录里的东西时记得在 `catalog`/`filesOf`/`itemOf`
  三处登记，不然导出时就悄悄漏掉；带密钥的文件要在 `stripFile` 里清空、在 `applyPending` 里「空着就保留本机的」。
  在线更新：Windows 由一个独立的隐藏 PowerShell 跑安装包再拉起托盘版（本进程先退出，安装包会强制结束它）；
  装失败也要把原来的拉起来，不然用户点一下更新服务就没了。下载（LRN 2026-10-24，症状「卡在 1KB 然后 fetch failed」）：安装包实际在
  release-assets.githubusercontent.com，国内常连不上——按「直连 → 加速镜像（`UPDATE_MIRRORS`，`update_mirrors` 可覆盖）」依次试，
  断点续传、30 秒没数据换源、后面还有源时速度低于 200KB/s（且照这速度还要 30 秒以上）也换源接着续传（直连 GitHub 常见的是一直几 KB/s 地慢慢给，不是断）；**镜像下的文件只认 GitHub 接口给的 `digest` 校验**，没有 digest 的老发布不走镜像。
  **下载不能走 undici**（`util/nodefetch.ts`，LRN 2026-10-24）：对方 `Connection: close` + 写盘背压暂停时，undici 在 socket end 里 `assert(!this.paused)`
  抛未捕获异常，托盘版进程无声消失（CI 冒烟在 Windows 上抓到，undici 7/8 都在）。用 Node 自带 http/https，代理走 CONNECT 隧道。
  **Windows 安装期间服务端不先退出**：等用户点了 UAC「是」、安装包的 `PrepareToInstall` 才结束它，装完 `run-update.ps1` 再拉起；
  点「否」/ 装失败服务照常运行，进度看 `updates/update.log`（脚本用 Start-Process 起，别 spawn）。release.yml 有 Windows 在线更新冒烟。
  `main()` 装了 `installCrashLogging`：未捕获异常同步写进 kagura.log 再退出——托盘版没控制台，以前这类崩溃一个字都不留。
  **进程死因留痕**（LRN 2026-10-31，症状「运行中无声退出，日志里一个字都没有」）：日志改成同步写（以前写入流在强行结束时会丢掉最后几行），运行中也按大小滚动；
  每次退出都写 `[exit] code=…（原因）`（`gracefulExit(code, reason)` 带原因）——**日志末尾没有这行 = 被外部强行结束 / 原生崩溃 / 内存耗尽**；
  `logs/running.pid` 开机时还在就记一行「上次没有正常退出」；V8 致命错误写 `logs/report.*.json`；每 30 分钟一行 `[mem]`；SIGHUP（关控制台窗口）/ SIGBREAK 也走正常退出。大请求体只对本机来源放宽（`Router.bigBodyPaths`）。
- **优雅退出（`util/shutdown.ts`，LRN 2026-10-24，症状「在线更新之后神乐的飞书十几分钟收不到消息，状态却显示在线」）**：
  以前退出 / 重启 / 更新都是直接结束进程，飞书长连接没断开，飞书把事件继续投给死连接，直到租约过期。现在 `gracefulExit` 先跑 `onShutdown`
  （关 IM 渠道，最多等 3 秒）再退；`/api/admin/quit`、`restartSelf`、SIGINT/SIGTERM 都走它。Windows 安装包的 `PrepareToInstall` 先
  `POST /api/admin/quit`（端口由更新脚本 `/KAGURAPORT=` 传入，手动安装按 5000 试）、等 3 秒，再 taskkill 兜底。**新加要退出进程的地方别直接 `process.exit`。**
  **IM 消息去重**（`channels/seen.ts`，症状「升级完她把之前那几条又回了一遍」）：飞书事件「至少投递一次」，投给死连接 / 没确认的会重投，QQ 重连也补发。
  `ChannelManager` 收到就按「账号 + message_id」查 `channels_seen.json`（留 3 天、最多 3000 条，重启后也记得），见过就跳过（日志 `↩️ 重复投递`）。
  晚到超过 5 分钟的（`InboundMessage.sentAt`，飞书 `create_time`）在消息前注明「这条消息是 N 分钟前发的」，别让 agent 当成刚说的。
- **管理界面的长列表**：侧边列表一律用 `ui.SideList`（搜索框、分组折叠、先显示一部分再「再显示」），表格用 `ui.usePage` 分页（每页 20）。
  新加会越积越多的列表 / 记录时直接用这两个，别平铺。
- **新版本提醒（`util/update.ts`）**：启动 30 秒后、之后每 12 小时查一次 GitHub Releases，只提示不安装；
  预览版连预览版一起比，正式版只看正式版。`update_check: false` 关掉。
- **上手清单（设置 →「快速开始」，`GET /api/admin/setup`，`settings.tsx` 的 `Checklist`，2026-11）**：以前「快速开始」只配模型，配完语音没 Key、设备没连上都得自己发现。
  现在五步：模型、语音、硬件设备（必需）+ 角色图片、手机（可选），每步显示做没做完、去哪做，语音能当场试听；页面每 5 秒刷新（设备第一次心跳、手机扫完码自己打勾）。必需的没做完时总览有「还差 N 步」卡片、「快速开始」标签一直在。
  新加「不配就用不了」的东西时加一步；可选的标 `optional`（不计入「还差几步」）。
- **用量页的缓存命中（`AgentStore.usageByScene` / `usageScene`，2026-11）**：按场景（主会话 / 设备 / IM / heartbeat / 定时任务 / 待办 / 子任务 / agent 间 / 压缩 / 朗读兜底 / MCP 叫醒）汇总，命中率 = 缓存读 /（没命中的输入 + 缓存读 + 缓存写）。
  用来找「哪个场景的系统提示每轮在变」；服务商根本不报缓存的显示「没报」而不是 0%。新加一类会话 key 时在 `usageScene` 里认一下，不然归到「其它」。
- **不假定主人有哪种设备（2026-11，主人「CoreS3 并不是必选项，初始 agent 也不一定想叫神乐」）**：首次启动的默认 agent 叫 `DEFAULT_AGENT_NAME`（「小助手」，占位），
  「快速开始」第一步给她起名字；改名时 SOUL.md / IDENTITY.md 还是原模板（一字没改）的跟着换成新名字，改过的不碰（`registry.update`）。
  人设模板、语音场景提示（`CHANNEL_HINTS.device`）、只拍照的提问不再提 CoreS3。上手清单里必需的只有模型（网页聊天随时能用）；语音在接了硬件设备或手机后才算必需；
  硬件设备、手机、飞书 / QQ 并列都是可选。heartbeat 新建默认投递 `auto`（出口挑：在线的设备 → 开着的手机 → 手机通知），以前写死 `device:cores3`，没有这台设备的人收不到；
  已有 agent 存着的旧值不动。手机页「看家」只在有硬件设备时显示。设备协议里缺 `X-Device-Id` 时的兜底 id 仍是 `cores3`（老固件兼容），别动。
  **新加给用户看的文案统称「硬件设备」**，只在说明具体型号时写 CoreS3。
