# 工具、权限、扩展与 MCP

> 踩坑记录（LRN），从 CLAUDE.md 按子系统拆出来的。加内置工具、改工具权限、文件 / 执行 / 发文件工具、扩展、MCP 管理器之前先读这份；新踩的坑也记在这里（写清症状、原因、别改坏的点）。

- **工具权限按场景（`agent/toolpolicy.ts`，`Runtime.toolsFor` 里 `toolAllowed(sceneOf(scope), …)`，LRN 2026-10-30 安全检查）**：
  以前是「默认都给、危险的各自 `if (!scope.trusted)` 拦」，漏拦一个就是一个洞——查出群聊陌生人能 `take_photo`（照片发回群里）、`get_presence`、
  `sessions_history` 读主人聊天、`photo_schedule_add` / `cron_add`、`web_fetch` 读本机管理接口。现在 **guest 默认什么都不给，只放 `POLICY.guest` 白名单**
  （默认 web_search / web_fetch / skill_read / set_volume），`guestLocked` 里的（家里设备、隐私、执行代码、替主人花额度）配置也加不上；
  扩展 / MCP 的工具提供者在不可信时本来就只给 `allowUntrusted` 的，这里照放、可单独关。其它场景默认全给，`deny` 按场景关。
  `config.json` 的 `tool_policy`，管理界面 Agents → 工具与技能 →「按场景」。各工具里原来的可信判断保留（双保险）。**新加内置工具不用做什么就不会给陌生人**；
  要给就进白名单，碰隐私的加进 `guestLocked`。扩展必须用 `addTools(p, { plugin: true })` 注册，否则会被当内置工具、陌生人那边被白名单挡掉。
  **`web_fetch` 不去本机 / 局域网**（`isPrivateIp` / `assertPublic`）：域名先解析、重定向自己一跳跳跟且每跳都查——从本机发的请求算 `isLocal`，不拦就能借它读管理接口。
- **执行命令 / 联网（新服务端内置 agent，`server/src/agent/tools/exec.ts`、`web.ts`）**：`exec` 只在
  `RunScope.trusted` 的会话里出现。可信度的来源：IM 渠道默认不可信，只有渠道白名单里 owner 的私聊显式可信；
  其它渠道可信；嵌套调用（a2a）沿用上层，后台派出的经 `lineage.trusted` 带过去；**不可信会话里 cron_add / cron_update
  的任务标 `untrusted`，跑起来也不可信**（管理界面改过才清掉）——新加任何「替别人跑一轮」的入口都要把可信度带上，
  漏一处就是让陌生人借道执行命令。联网走 `util/proxy.ts`：配了代理就换全局 dispatcher（含调模型），本机地址直连。
- **发文件给主人（`send_file`，`agent/tools/send.ts`，2026-11，症状「网页会话里她发不了图片 / 文件，飞书只能带 take_photo 拍的那张」）**：
  只在回复会直接送到人眼前的可信会话里有（`channel` ∈ webchat / feishu / onebot，非子任务）——设备语音、待办、定时任务、heartbeat 里发了没人收，不给；`LOCKED_NAMES` 锁着（能读这台电脑的任意文件，给陌生人就是往外拿文件）。
  执行时把文件**复制**到工作目录 `sent/<日期>/`（重名加序号）、记进 `scope.meta.files`、工具结果里带一行 `[文件 sent/…]`（`SENT_RE`）。别改坏的点：
  ① 网页会话**靠工具结果里那一行**显示附件（`common.Message` 对 `toolName === "send_file"` 的结果不折叠，画成「📎 发来的文件」：图片内嵌、PDF 可打开、其它下载），不另存元数据、也不用在发给模型前剥掉；
  `GET /api/admin/agents/<id>/uploads?path=` 认 `uploads/` 和 `sent/`（`resolveInside` 防穿越，`?download=1` 强制下载）；② IM：`ChannelManager` 把 `r.meta.files` 经 `SendOpts.files` 交给渠道，
  飞书图片（≤10MB）发图片消息、其它 `im.file.create`（`feishuFileType`，视频 / 语音也当普通文件发，免得要时长和封面）+ `file` 消息；一个失败不影响别的，`send` 返回没发出去的，管理器补一句「…没发出去」；
  OneBot 只发图片（工具里就挡掉了别的），QQ 官方机器人没有这个工具（图片要公网地址）；③ 单个 `SEND_MAX_BYTES`（30MB，飞书文件上限）、一轮 `SEND_MAX_FILES`（10）。**手机 / 平板（`/app`）的对话里也有**（2026-11）：`sendTools({ isPhone })`——渠道是 `device` 但设备是配对的手机时给（硬件设备只有喇叭，不给）；`PiBrain.onFiles` 把 `r.meta.files` 经 `kagura/cmd/<手机>` 的 `{"action":"files"}` 送到页面（SSE），
  页面凭配对令牌 `GET /client/file?agent=&path=sent/…` 取（解析后必须还在 `sent/` 里，`sent/../MEMORY.md` 这种 404）。页面没开着就收不到（不补发）。
- **文件工具（`server/src/agent/tools/files.ts`，LRN 2026-11-10，症状「她改文件全靠 exec 拼 cat / sed / grep，容易改错也难自查」）**：
  `read_file`（带行号、offset / limit 分段）/ `edit_file`（精确替换、必须唯一或 `replace_all`，返回改完前后几行）/ `write_file` / `search_files`（正则，跳过 node_modules、.git、二进制、>5MB）/ `list_files`（通配，新改的在前）。
  **改已有文件前必须在这个会话里 read_file 读过、且读完没被改过**（按 mtime + 大小记在内存里，重启就清空；她自己 edit / write 后会更新）。
  权限同 exec：只给可信会话、`tools.exec.enabled` 关了这些也关，`LOCKED_NAMES` 里锁着永远不给群聊。全用异步 fs（别卡住给设备流式播音频的事件循环）。
  **图片也走 `read_file`**（`IMAGE_TYPES`，LRN 2026-11-15，症状「让她看自己刚拍的照片，她去开 playwright 浏览器」）：工具结果里的图只在那一轮里，落盘后只剩路径，以前之后再看就没路可走；现在 png / jpg / webp / gif 直接以图片内容返回，模型没勾「图片」就报错说清楚（`fileTools(cfg, canSee)`）。
  守则（`toolGuide`）让她看 / 改文件用这些、别用 exec 拼命令，改完看回显确认。agent 自己设了工具白名单（不是 `*`）的要手动加上。
- **扩展 / MCP（`server/src/agent/extensions.ts`、`mcp.ts`）**：扩展是 pi 格式（`export default (pi) => pi.registerTool(...)`），
  运行时 sucrase 转译 + `vm.compileFunction`，`@earendil-works/pi-ai`/`typebox` 走内置 shim（打包后没有 node_modules）。
  扩展工具、MCP 工具、`extension_*` 自写工具**都按 `exec` 同一条可信度规则**——它们本质上就是任意代码执行；
  只有工具自己标 `allowUntrusted` / 服务器配置 `allowUntrusted` 才放给不可信会话。`toolsFor` 按名字去重、内置优先，
  别让扩展覆盖 `exec` 之类的内置工具——扩展 / MCP 的提供者用 `addTools(p, { plugin: true })` 注册，
  永远排在内置之后（设备工具是后注册的，不分开排的话扩展里的 `speak` 会盖掉内置的）。新工具从下一轮对话起生效。
  **pi 扩展包**（`packages.ts`）：单文件可执行里没有 npm，自带最小安装器（semver + sha512 + 冲突嵌套，不跑安装脚本）；
  依赖也走扩展加载器（`resolveBare` 自己解析 exports，`import.meta` 换成注入的对象），这样纯 ESM 包也能转译加载。
  宿主包（pi-ai / pi-coding-agent / pi-tui / typebox）一律换内置 shim，pi-tui 与 pi-coding-agent 里没实现的导出拿到不报错、调用才报。
- **MCP 服务器主动通知（`mcp.ts` 的 `onMessage` / `notify`，2026-11）**：MCP 工具只能她去问，「打印机打完了」这种事没法告诉主人。服务器配置 `"notify": true`（或 `{ agent, delivery }`）后，
  它发来的日志通知（`notifications/message`，级别 notice 及以上、`data` 是一句话）**原话送给主人，不过模型**：`mcp.onNotify` → `sys.notifyOwner` 走待办汇报那条路
  （`report(…, tag)`：配置的投递目标 → 那个 agent 的 heartbeat 目标 → 出口），说出去的话 `Runtime.note` 记进接收方会话（tag `通知：<服务器>`，`[通知：` 进了 `NOT_OWNER`）。
  别改坏的点：① 只认开了 `notify` 的服务器——别的服务器的日志（常有 error 级）不能变成打扰；② 每个服务器 10 分钟最多 `NOTIFY_MAX`（6）条、单条 500 字；
  ③ 开了 notify 的服务器要一直连着：连不上 / 断了 `retryLater`（10 秒起翻倍到 5 分钟），`disconnect` 里清定时器；别的服务器照旧「下次调用时重连」；
  ④ 管理界面服务器表的「测试通知」= `POST /api/admin/mcp/<名>/test-notify`，走的是同一条路。**以后想让某个外部东西主动说话，优先做成 MCP 服务器 + notify，别往核心里加模块。**
- **mcp.json 直接改也生效**（`McpManager.watch`，LRN 2026-11-15，症状「她改了访问码，说要重启 Kagura 才能重新读配置」）：每 2 秒读一次文件、和上次加载的内容（`loadedText`）比，变了（且是合法 JSON）就 `reload`——**比内容不比修改时间**（`fs.watchFile` 的基准是异步取的，刚 watch 就改的那一下会漏，CI 上抓到过）；「重连」也先按文件重新加载。改到一半的坏 JSON 不动现在的连接（不然 `readConfig` 返回空 = 全断开）。
- **自带的 MCP 服务器（`"command": "kagura"`，`cli.ts` 的 `mcp` 子命令）**：单文件可执行里没有 npx，自带的服务器由这个程序自己再起一份（`selfArgv`：SEA 是 exe 本身，node 跑脚本是 node + 脚本），
  对 McpManager 来说就是普通的 stdio 服务器，核心不 import 它（`cli.ts` 里动态 import）。**标准输出只能走协议**：子命令里别 `console.log`，日志写标准错误（管理界面看得到）。
  没在 Windows 托盘版（图形界面子系统的 exe 带管道当子进程）上验证过。
- **自带 MCP 组件单独更新（`server/src/components.ts`、`scripts/build-mcp.mjs`、`.github/workflows/mcp-components.yml`，LRN 2026-11-15，主人「发版流程太久了，而且没必要」）**：
  打印机 / Blender / build123d 三个自带服务器各打成一个 CJS（导出 `run(version)`），main 上这几个目录一改，CI 跑它们的单元测试、覆盖到固定 Release `mcp-components`（prerelease、不设 latest、tag 不是版本号——`pickLatest` 只认 semver，不会当成新版本）。
  管理界面「扩展 / MCP → 自带组件」检查 / 更新 / 用回自带的（`/api/admin/mcp/components…`），装到 `<数据目录>/mcp_components/<名>.cjs + .json`，换了就 `mcp.serversUsing` 重连，Kagura 不重启。
  `kagura mcp <名>` 起来先 `runUpdatedComponent`：McpManager 用 `KAGURA_COMPONENTS_DIR` 告诉它目录（别的 MCP 客户端直接跑没有这个变量 = 只用自带的）。别改坏的点：
  ① **新旧只按源码时间比**（`sourceStamp` = 最后一次提交时间，主程序构建时把自带组件的 sha256 + 时间写进 `__MCP_BUILTIN__`）：以后正式版带了更新的代码，自带的就比下载的新、自动用回自带的；和自带的 sha256 一样的也不用；
  ② **组件字节要可复现**（`buildComponent`：去注释——注释里有源文件路径；不放时间 / 版本），自带的是哪一版才认得出；③ 下载只认 GitHub 接口给的 `digest`，manifest 里的 sha256 和 digest 对不上的组件不认，镜像给的对不上丢掉；
  装上的文件每次启动再核一遍 sha256，被改过 / 没写完的不用；④ 加载用 `createRequire(文件)`——Node SEA 里的 `require` 只认内置模块（实测 SEA 下能加载）；加载出错退回自带的、写标准错误。
  组件代码只能 import 自己目录和这三个目录里的东西（要单独打包）；改了核心和组件之间的约定（env、参数）要完整发版。`mcp_components/` 不进导出（能重新下）。
- **MCP 服务器叫醒 agent（`"wake": true`，`mcp.ts` 的 `WAKE_LOGGER` / `onWake`，`system.ts` 的 `wakeAgent`，2026-11）**：`notify` 是原话送给主人、不过模型；有的事要她自己看了再决定说不说（打印期间看一眼摄像头）。
  服务器发 `notifications/message`、`logger: "kagura.wake"`、`data` 是给她的指示 → 配了 `wake` 才理（**没配就整个丢掉，也不能当 notify 念出来**——那是给 agent 的话，不是给主人的）→ 跑一轮：
  会话 `<agent>:mcp:<服务器>`（只留最近 `HEARTBEAT_KEEP` 条）、`purpose: "cron"`（后台场景：**没有 `ownerOnly` 的工具**，别改成会落到 owner 场景的 purpose）、可信；回 `NO_REPLY` 不发也不进历史，有话说走 `notifyOwner`（按这个服务器 notify 的投递目标）。
  每次是一轮模型调用：同一服务器两次之间至少 `WAKE_MIN_MS`（2 分钟），上一次没看完不叠着跑；开了 wake 的服务器和 notify 一样要一直连着（`retryLater`）。管理界面「叫她看一眼」= `POST /api/admin/mcp/<名>/test-wake`。日志 `👀`，health `mcp_wake`，用量场景「MCP 叫醒」。
