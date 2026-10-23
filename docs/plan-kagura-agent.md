# Kagura 自研 Agent 系统与安装包 —— 开发计划

> 状态：v3（2026-10-23）。**M0、M1、M2（代码）已完成**：M0 结论见 [m0-report.md](m0-report.md)；M1 的契约测试在
> [contract-tests/](../contract-tests/README.md)（84 例）；M2 的 TS 服务端在 [server/](../server/README.md)，
> 契约测试在 Python 版、TS 版、三平台单文件可执行上全绿。M2 验收剩「作者真机试用一周无回退」，之后 M3。
> 目标读者：项目作者 + 之后接手开发的人（包括 Claude）。
> v2 变更：按作者要求，本期范围定为**系统层核心**——定时任务、heartbeat、多 agent 隔离与
> agent 间通信、memory、soul（人设文件体系）、管理 UI；通用 skill 后续再迁。新服务端放本仓库。
> v3 变更：加入 **IM 渠道**（首批飞书、QQ，§6.12）；本期**只发 Windows + Linux**（没有 Apple
> 开发者账号，macOS 代码保持可编译、以后再发）；模型/嵌入接口全部由用户手动配置、不预设；
> 管理 UI 只允许本机访问；OpenClaw 定时任务导入、agent 间通信权限都做进管理 UI。

## 1. 目标与边界

**目标**

1. 基于 [pi](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-ai` + `pi-agent-core`，MIT）
   自研一套为本项目定制的 agent 系统，替换 OpenClaw。pi 只提供「调模型 + 跑一轮 agent 循环」，
   **会话持久化、记忆、定时任务、heartbeat、多 agent、agent 间通信都不是 pi 原生的**，
   全部在本项目的系统层实现（§6）。
2. **现有设备功能原样支持**：固件协议不变（老固件不升级也能用），监控页功能不变，
   服务端 31 个 HTTP 接口、MQTT、UDP 发现、直播 TCP 全部保留（§4）。
3. 接入**移动端 IM**（飞书、QQ 首批），手机上直接和 agent 聊，定时任务也能投递过去（§6.12）。
4. 提供一个类似 OpenClaw 控制台、但贴合本系统的**管理 UI**（§7）。
5. **Windows / Linux 安装包即开即用**；GitHub Actions 打 tag 自动发布 Release（§9）。
   代码保持三端可编译，macOS 等有开发者账号后再发。

**本期不做**

- 通用 skill 的迁移（浏览器操作、各类第三方集成等）。但**本期会把 skill 的加载机制做好**
  （§6.8），之后迁移只是把 skill 文件夹拷进来。
- 首批之外的 IM（企业微信、钉钉、Telegram、个人微信等）：渠道层是插件式接口，后续逐个加。
- macOS 安装包的发布（见上）。
- 云端多租户托管。单机版，但架构不堵死（进程内运行、无子进程、无全局并发 2 的限制）。

## 2. 名词对照（OpenClaw → 本系统）

为了迁移顺手、也为了作者不用重新学一套概念，**名词和文件布局尽量沿用 OpenClaw**：

| OpenClaw | 本系统 | 说明 |
|---|---|---|
| agent（workspace + agentDir + session store） | **agent**，同样三件套 | 现在的「角色」升级为 agent：人设、模型、音色、设备图片都挂在 agent 上 |
| `SOUL.md` `IDENTITY.md` `USER.md` `AGENTS.md` `TOOLS.md` | 同名文件，同样语义 | 直接从 OpenClaw workspace 拷过来就能用 |
| `MEMORY.md` + `memory/YYYY-MM-DD.md` + `memory_search` | 同 | §6.4 |
| heartbeat（`HEARTBEAT.md` 清单，周期唤醒，无事回 `HEARTBEAT_OK`） | 调度器里的一种任务：`heartbeat` | 与 cron 共用一个调度器，§6.5 |
| cron / automations（at / every / cron 表达式，main / isolated 会话） | 调度器里的 `at` / `every` / `cron` 任务 | §6.5 |
| `sessions_list` / `sessions_send` / `sessions_spawn` + `agentToAgent.allow` | 同名工具 + 同类白名单 | §6.6 |
| channels（飞书、QQ Bot 等） | **渠道**，首批飞书、QQ | §6.12 |
| bindings（渠道账号 → agent） | **绑定**：设备 → agent、IM 账号/会话 → agent | 角色切换 = 改设备绑定，§6.7 |
| pairing / allowlist（陌生人私聊要配对） | 同 | §6.12 |
| skills（`SKILL.md` 文件夹） | 同格式 | 本期只做加载机制，§6.8 |
| Gateway 控制台 | **管理 UI** `/admin` | §7 |

## 3. 需要拍板的技术决定

| # | 问题 | 推荐 | 备选与代价 |
|---|---|---|---|
| D1 | 服务端语言 | **整体迁到 TypeScript（Node ≥22.19）**，一个运行时 | 保留 Python + Node 旁挂：安装包两套运行时，三端打包与进程守护都翻倍 |
| D2 | 单文件可执行 | **Node SEA**；依赖只选纯 JS / Node 内置（不用原生模块） | `bun --compile` 更省事，但 pi 声明 Node ≥22.19，兼容性 M0 实测 |
| D3 | 存储 | **Node 内置 `node:sqlite`**（会话、记忆索引、任务运行记录）+ 人设/记忆仍是 markdown 文件 | `better-sqlite3` 是原生模块，单文件打包麻烦；`node:sqlite` 的 FTS5 是否可用 M0 实测 |
| D4 | 安装包 | Windows **Inno Setup .exe**；Linux **AppImage + .deb**（macOS .dmg 以后） | Electron/Tauri 壳：体积大一层，管理 UI 用浏览器打开就够 |
| D5 | 签名与平台 | **已定**：本期只发 Windows（先不签）+ Linux；macOS 暂不发布 | 有 Apple 开发者账号后补签名 + 公证 |
| D6 | 管理 UI 技术 | **Preact + Vite**，构建成静态文件打进可执行 | 纯手写 HTML（像现在的 monitor.html）：页面多了难维护 |
| D7 | 语音 | 保留百度，抽成接口 | 之后换流式服务商不动上层 |
| D8 | OpenClaw 适配器 | **保留**为一种可选 agent 后端（调 CLI），作者自用可继续接 OpenClaw | 不保留：作者的设备也得一起迁 |
| D9 | Python 版去留 | 新版达到 §10 验收后冻结到 `legacy/`，一个版本后删除 | — |

> 作者已确认 D1–D9 按推荐执行（2026-10-23）。

## 4. 现有设备功能对照（验收清单）

### 4.1 接口（响应头协议逐字节兼容）

| 现在 | 新系统 |
|---|---|
| `POST /chat`：ASR → 短路链（没听清/免手退出/角色/提醒/音量/快捷指令）→ LLM → TTS | 同；短路链原样移植；LLM 换成 agent 运行时。响应头 `X-Need-Photo` `X-Volume` `X-User-Text` `X-Reply-Text` `X-Role` `X-Asr-Empty` `X-Cont-Exit` 全保留 |
| `POST /chat-vision` 三种入参 | 同；图片作为多模态输入，不再写 OpenClaw 工作目录 |
| `/push`、`/push-audio/<f>` | 同 |
| `/capture-request`、`/upload-photo`、`/capture-result/<id>`、`/photo/<id>` | 同（`image_path` 字段保留）；`take_photo` 工具内部复用 |
| `/shake`、`/touch`、`/presence` | 同；改为向设备绑定的 agent 投递事件（§6.9） |
| `/heartbeat`（设备心跳）、`/device-status`、`/crash-report` | 同。**注意与 agent 的 heartbeat 是两回事**，代码里命名区分（`device_heartbeat` / `agent_heartbeat`） |
| `/time`、`/health`、`/test-tone` | 同 |
| `/role` GET/POST、`/role/cycle` | 同；内部改为读写设备绑定 |
| `/debug-audio/<dev>`、`/snapshot/<name>` | 同 |
| `/monitor` 与 `/api/monitor/*` | 同；`monitor.html` 照搬，管理 UI 里再嵌一份 |
| MQTT `kagura/push/*`、`kagura/cmd/*` | 同；broker 内置（aedes） |
| UDP 5001 发现 | 内置应答；`discovery_relay.*` 删除 |
| TCP 5002 直播 | 同；RGB565→JPEG 改纯 JS |
| `API_TOKEN`、`STREAM_TOKEN`、限流 | 同 |

### 4.2 服务端后台逻辑

提醒调度、每日定时拍照（`MISS_WINDOW`、当天去重、`_SCHEDULE_SPEAK_HINT` 语义）、设备心跳失联
巡检、拍照结果清理、TTS 内容寻址缓存（cache key 规则不变）、`debug_audio`、分阶段耗时日志、
`_hb_seen`——全部移植，单测一起移植。

> 设备提醒与定时拍照将来可以并入 §6.5 的统一调度器，但**本期保持原样**，避免两件事一起改。

## 5. 总体架构

```
kagura-server（单个可执行文件）
├─ device 层   HTTP :5000 设备路由 · MQTT :1883（aedes）· UDP :5001 · TCP :5002 直播
├─ voice 层    ASR / TTS 接口（百度实现）· TTS 缓存
├─ channel 层  device（语音进出）· webchat（管理 UI 里聊天）· feishu · qq · 插件式接口
├─ router      渠道消息 → 绑定的 agent → 会话（§6.7）
├─ runtime     agent 注册表 · 会话池 · 每会话串行队列 · 全局并发上限 · 超时/中止
│   └─ 每轮：组装上下文（soul 文件 + 记忆 + 历史）→ pi Agent → 工具执行 → 落盘 → 回渠道
├─ memory      MEMORY.md / 每日笔记 / 混合检索（FTS + 向量）/ 压缩前自动写记忆
├─ scheduler   at / every / cron / heartbeat 任务 · 运行记录 · 重试 · 活跃时段
├─ a2a         sessions_list / send / spawn · 白名单 · 防死循环
├─ skills      SKILL.md 加载 · 每 agent 白名单（本期只加载说明，不执行脚本）
├─ admin       /admin 管理 UI + /api/admin/*（§7）
└─ store       数据目录（%APPDATA%/Kagura · ~/Library/Application Support/Kagura · ~/.local/share/kagura）
               agents/<id>/workspace/*.md · agents/<id>/agent.sqlite · scheduler.sqlite · config.json
```

## 6. 系统层核心设计

### 6.1 Agent 与隔离

每个 agent 一个目录：

```
agents/<agentId>/
  agent.json          模型、音色 per、设备图片集、工具白名单、技能白名单、a2a 权限
  workspace/          SOUL.md IDENTITY.md USER.md AGENTS.md TOOLS.md HEARTBEAT.md MEMORY.md
                      memory/YYYY-MM-DD.md   skills/   files/（agent 自己的读写区）
  agent.sqlite        会话、消息、记忆索引、用量
```

隔离保证（写进测试）：

- 会话、记忆、用量**按 agent 分库**，不存在跨 agent 的查询接口。
- 文件类工具（读写笔记）的路径**限制在本 agent 的 workspace 内**（路径规范化后校验前缀，
  拒绝 `..` 和符号链接逃逸）——这一点比 OpenClaw 默认更严，因为产品版没有沙箱。
- 工具白名单按 agent 配置；跨 agent 只能走 §6.6 的工具，并受白名单约束。
- API Key 默认全局共享，可按 agent 覆盖。

### 6.2 会话与上下文

- 会话 key：`<agentId>:<channel>:<peer>`，例如 `kagura:device:cores3`、`mio:webchat:owner`。
  每个 agent 有一个 **main 会话**（heartbeat 与 `session=main` 的定时任务进这里）。
- 消息全部落 `agent.sqlite`，**服务端重启不丢上下文**（现在的会话只在内存）。
- 每会话串行（同一会话的消息排队），全局并发上限可配（默认 4，替代现在的 2）。
- 每轮上下文 = 系统提示（§6.3 组装）+ 最近对话。超过阈值触发**压缩**：先跑一轮静默的
  「记忆冲刷」让 agent 把要紧的事写进记忆（§6.4），再用便宜模型把较早的历史总结成一段摘要。
  阈值、保留轮数、压缩用的模型都可配——**这是成本的主要旋钮**。
- 用 pi 的 `transformContext` 钩子实现裁剪/压缩，`sessionId` 传给 pi 用于服务商侧缓存。

### 6.3 Soul（人设文件体系）

系统提示由 workspace 文件按固定顺序拼出来，每个文件有字数预算，超了截断注入（磁盘上不动）：

| 文件 | 内容 | 注入时机 |
|---|---|---|
| `SOUL.md` | 性格、语气、价值观 | 所有会话 |
| `IDENTITY.md` | 名字、自我介绍、外形（对应设备图片） | 所有会话 |
| `USER.md` | 主人的稳定偏好 | main 与设备/网页会话 |
| `AGENTS.md` | 操作守则：何时用哪个工具、语音回复要短、不要输出 markdown | 所有会话（含子 agent） |
| `TOOLS.md` | 工具使用备注 | 所有会话 |
| `MEMORY.md` | 长期记忆 | main 与设备/网页会话（**不给子 agent**，同 OpenClaw） |
| `HEARTBEAT.md` | heartbeat 检查清单 | 只在 heartbeat 运行时 |

另外每轮自动附加：当前时间、在家状态、设备状态、渠道提示（语音渠道：回复口语化、少于 N 字）。
现在 `chat()` 里拼的 `[当前时间]`、触觉背景（`X-Touch`）、`last_quick` 背景都迁到这一层。

### 6.4 Memory

- 存储：`MEMORY.md`（精炼长期记忆）+ `memory/YYYY-MM-DD.md`（每日详细笔记），纯 markdown，
  可以在管理 UI 里直接改。
- 工具：`memory_search(query)`、`memory_get(path, lines?)`、`memory_write(target, text)`
  （target = 今日笔记 / MEMORY.md）。
- 检索：混合检索——SQLite FTS 关键词（CJK 逐字切分 + 短语查询；trigram 搜不到两字词，M0 实测）+ 向量相似度（向量用配置的嵌入接口，存进 `agent.sqlite`，
  余弦在 JS 里算；单机几千条笔记够用）。没配嵌入接口就退化为纯关键词。
- 新会话或 `/reset` 时自动带上今天和昨天的笔记。
- 压缩前自动「记忆冲刷」（§6.2）。
- 文件变更（含管理 UI 手改）触发增量重建索引。

### 6.5 调度器（定时任务 + heartbeat）

一个调度器管所有定时触发，任务定义存 `scheduler.sqlite`，**进程重启后按定义恢复**：

| 字段 | 取值 |
|---|---|
| `schedule` | `at`（一次性，绝对时间）/ `every`（间隔）/ `cron`（5 段表达式 + 时区） |
| `kind` | `agentTurn`（给 agent 发一条提示词让它干活）/ `systemEvent`（往会话里注入一条系统事件，不一定回复）/ `heartbeat` |
| `session` | `main`（共享主会话上下文）/ `isolated`（每次全新上下文，适合早报这类不需要聊天历史的任务）|
| `delivery` | `device:<id>`（合成语音推到设备）/ `webchat` / `none`（只记录）|
| `activeHours` | 例如 08:00–23:00，时段外跳过（夜里不让她突然开口） |
| `idleOnly` | 设备正在对话时延后执行 |
| 重试 | 失败按指数退避重试 N 次；连续失败在管理 UI 标红 |
| 运行记录 | 每次运行的开始/结束时间、结果文本、token 用量、是否投递 |

**heartbeat** = `kind: heartbeat` 的 `every` 任务（默认 30 分钟，可按 agent 关闭）：在 main 会话里
带上 `HEARTBEAT.md` 清单跑一轮；agent 回 `HEARTBEAT_OK`（或 `NO_REPLY`）就不投递、不打扰，
否则按 delivery 播报。

agent 自己也能管任务：`cron_list` / `cron_add` / `cron_update` / `cron_remove` / `cron_run` 工具
（「每天早上八点给我讲新闻」→ agent 自己建一条 isolated 任务）。

与「设备提醒」的关系：现在的提醒（`reminders.py`）走短路链、不经过 LLM，本期保持；
agent 侧的提醒用调度器的 `at` 任务。两者在管理 UI 里分开展示。

### 6.6 多 agent 与 agent 间通信

| 工具 | 作用 |
|---|---|
| `sessions_list` | 列出自己有权看到的 agent 及其会话 |
| `sessions_send(agent, message, wait?)` | 给另一个 agent 的 main 会话发消息；`wait=true` 时等对方回复（有超时） |
| `sessions_spawn(agent?, task)` | 起一个**子 agent** 后台跑任务（独立的 isolated 会话，只注入 AGENTS.md/SOUL.md，不给 MEMORY.md），完成后把结果作为系统事件投回发起方会话 |
| `sessions_history(session, n)` | 读取有权限的会话最近 n 条 |

权限：`agent.json` 里 `a2a.allow: ["mio"]`（可以找谁）；全局开关 `a2a.enabled`。
防失控：每条 a2a 消息带调用链（`hop` 计数），超过 3 跳拒绝；同一对 agent 每分钟调用数上限；
子 agent 不能再 spawn（同 OpenClaw 的 team 预设）。所有 a2a 调用在管理 UI 里可追踪。

典型用法：「让小澪来帮我查一下」→ kagura `sessions_spawn(mio, …)` → 结果回来 kagura 转述；
或直接 `/role` 切换设备绑定让小澪本人来说。

### 6.7 设备绑定与角色切换

- 「角色」= agent。现在的 `roles.py` 的数据迁成 agent 的 `agent.json`（名字、别名、音色 per、
  设备图片目录 id）。
- 设备绑定：`device_id → agentId`，持久化；`/role`、`/role/cycle`、语音切换、网页下拉
  全部改为改绑定。设备端看到的 `X-Role` 仍是图片目录 id，固件不用改。
- 推送音色、`/shake` `/touch` 的事件都按**当前绑定**的 agent 走（§6.9）。

### 6.8 Skills（本期只做加载机制）

- 格式沿用 `SKILL.md` 文件夹（与 OpenClaw/pi 一致）：front-matter 里的 name/description 进系统提示
  的技能目录，agent 需要时用 `skill_read` 读全文。
- 每 agent 白名单。
- **本期不执行 skill 里的脚本**（产品版没有沙箱，执行任意脚本风险太大）。脚本执行、沙箱与
  授权留到「skill 迁移」那一期。
- 设备相关的 `cores3-speak` / `cores3-camera` 不再是 skill，改成内置工具 `speak` / `take_photo`。

### 6.9 内置工具与设备事件

| 工具 | 作用 | 替代 |
|---|---|---|
| `speak(text, device?)` | 主动播报到设备 | cores3-speak |
| `take_photo(question)` | 对话中拍照看图（兼容做法见下） | `[PHOTO]` 前缀 |
| `set_volume(dir)` | 调音量 | `X-Volume` |
| `get_presence` | 在不在家 | workspace 状态文件 |
| `photo_schedule_*` | 每日定时拍照增删改 | 只能在网页配 |
| `memory_*`、`cron_*`、`sessions_*`、`skill_read` | 见上文 | — |
| `web_search` / `weather`（可选，需配 Key） | 早报内容来源 | OpenClaw 侧能力 |

`take_photo` 兼容做法：设备是单线程的，/chat 进行中收不了 MQTT 拍照命令。工具被调用时本轮
立即结束（工具返回 `terminate`），用已生成的应答句 + `X-Need-Photo: 1` 返回；设备照现在的流程
拍照发 `/chat-vision`，服务端把照片连同原问题作为下一条消息交给 agent。设备端零改动。

设备事件：shake / touch / presence 变化 → 作为 `systemEvent` 投进绑定 agent 的 main 会话，
agent 决定是否 `speak`。现有提示词（摇一摇、触摸描述、`_SPEAK_HINT`）原样迁移；冷却与显著性
筛选仍在设备端（`FEEL_NOTIFY_COOLDOWN` 不放宽）。

### 6.10 边生成边播

- pi 的 `text_delta` 按句切分 → 每句合成 → 写进 HTTP 响应（不带 `Content-Length`，读到连接关闭）。
  设备 `stream_play` 本来就读到 EOF、每块自补 WAV 头，**音频部分不用改**。
- 响应头必须先发：等首句合成好、或模型已调用影响响应头的工具时再发。`X-Reply-Text` 只放首句，
  完整文本由设备播完后 `GET /chat/last` 取回（**固件小改**）。
- 请求头带 `X-Stream: 1` 的新固件才走流式；老固件仍整段返回 + `Content-Length`。

### 6.11 模型与用量

agent 配 `provider` + `model`（pi-ai 内置 DeepSeek、通义千问、任意 OpenAI 兼容接口）；压缩、
记忆冲刷、heartbeat 可单独配便宜模型。每次调用的 token 与费用记进 `agent.sqlite`，管理 UI 展示。

### 6.12 IM 渠道（飞书、QQ）

**接口**：每个渠道一个适配器，实现 `connect / onMessage / send(text|image|audio) / status`。
消息进来统一成 `{channel, account, chatType: dm|group, peer, sender, text, images[], audio?, mentionedMe}`，
交给 router 按绑定找到 agent 和会话；agent 的回复再由同一个适配器发回去。

**首批实现**

| 渠道 | 接入方式 | 是否需要公网 | 备注 |
|---|---|---|---|
| 飞书 / Lark | 官方 `@larksuiteoapi/node-sdk` 的**长连接**（WebSocket）接收 `im.message.receive_v1` | 不需要，只要能出站上网 | 桌面版的最佳情况 |
| QQ（官方机器人） | QQ 开放平台机器人 API：私聊（C2C）、群里 @ 机器人 | **待 M0 核实**：有资料说 WebSocket 接入已停止维护、只剩 Webhook（Webhook 需要公网地址，桌面版用不了） | 被动回复有 5 分钟有效期；主动推送有频次限制 |
| QQ（OneBot v11，可选） | 连本机 NapCat 等 OneBot 实现的 WebSocket | 不需要 | **非官方协议，有封号风险**，只作为可选项、默认关闭，管理 UI 里写明风险 |

**安全（照 OpenClaw 的 pairing 思路）**

- 私聊默认**配对制**：陌生人第一次发消息，机器人回一个配对码，作者在管理 UI 里批准后才放行；
  也可以改成白名单或完全开放。
- 群聊默认**只响应 @ 机器人**的消息；可按群配置。
- 每个渠道账号、每个群/私聊都可以单独绑定到某个 agent。

**会话与记忆**

- 会话 key：`<agentId>:feishu:<chatId>` 这样按渠道和聊天分开；同一个 agent 的 `MEMORY.md` 跨渠道共享，
  所以在设备上说过的事，在飞书上她也记得。
- 可选「主人私聊并入 main 会话」：作者本人的私聊直接进 main 会话，和 heartbeat 共享上下文。

**格式与媒体**

- 渠道提示注入系统提示（§6.3）：IM 可以用 markdown、可以长一点；设备语音要口语化、短。
- 图片消息 → 多模态输入；语音消息 → 走 ASR（可选）；agent 的 `take_photo` 在 IM 里触发时，照片
  直接发回聊天。
- 定时任务 / heartbeat 的投递目标增加 `feishu:<chatId>`、`qq:<openid>`（§6.5 的 `delivery`）。

**跨渠道**

- `speak` 工具可以从 IM 里让设备开口（「跟家里说一声我晚点回」）。
- 渠道断线自动重连，状态在管理 UI 总览里显示。

## 7. 管理 UI（`/admin`）

浏览器打开，**本期只允许本机访问**（服务端检查请求来源是 127.0.0.1/::1，其他一律 403）。
设备接口照常监听局域网；现有 `/monitor` 保持原样（局域网 + `API_TOKEN`）。页面：

| 页面 | 能做什么 |
|---|---|
| 总览 | 设备在线状态、各 agent 今日对话数/费用、最近失败的任务、heartbeat 最近一次结果 |
| Agents | 新建/复制/删除 agent；编辑 SOUL/IDENTITY/USER/AGENTS/TOOLS/HEARTBEAT（带预览和字数预算提示）；选模型、音色（可试听）、设备图片目录、工具/技能白名单、a2a 权限 |
| 会话 | 按 agent 浏览会话与完整对话（含工具调用）；重置、手动压缩、导出 |
| 记忆 | 浏览/编辑 MEMORY.md 与每日笔记；检索测试（输入一句话看会搜出什么）；重建索引 |
| 定时任务 | 列表 + 新建向导（at/every/cron、会话、投递到设备/IM/不投递、活跃时段）；立即运行；运行历史与输出；heartbeat 开关与间隔；**从 OpenClaw 导入任务** |
| Agent 通信 | a2a 调用记录（谁找谁、内容、耗时）；**哪些 agent 之间允许互相通信**的开关矩阵、跳数与频率上限 |
| 渠道 | 添加飞书/QQ 账号（填凭据、测试连接）；在线状态；**配对申请审批**；私聊/群 → agent 的绑定；群聊响应规则 |
| 设备 | 设备绑定（哪个设备绑哪个 agent）；现有监控页（拍照/直播/定时拍照/快照）嵌入；设备日志与崩溃报告；`debug-audio` 试听 |
| 网页聊天 | 直接和任一 agent 文字聊天（webchat 渠道），调试人设很方便 |
| 用量 | 按 agent/天的 token 与费用曲线；本月预估 |
| 设置 | 模型服务商与 Key、嵌入接口（可选）、百度 Key、端口、数据目录、`API_TOKEN`、开机自启、从 OpenClaw 导入。**不预设任何模型**，首次启动向导里由用户自己选和填 |

后端是 `/api/admin/*` JSON 接口，管理 UI 和将来的 IM 渠道/脚本都用它。

## 8. 从 OpenClaw 迁移

管理 UI「设置 → 从 OpenClaw 导入」，也有命令行版：

1. 读 `~/.openclaw/workspace` 与 `~/.openclaw/agents/<id>`：人设与记忆的 markdown 文件**原样拷贝**
   （文件布局一致，§2）。
2. 定时任务：读 OpenClaw 的任务列表（命令行导出或存储文件，**具体格式 M0 核实**），转换成
   §6.5 的任务定义，导入后默认暂停，作者逐条确认再启用。
3. 本项目的 `config.py`、`roles_state.json`、`reminders.json`、`photo_schedules.json`、`snapshots/`
   一并导入。
4. 聊天历史不导入（OpenClaw 会话格式不同，且记忆已在 markdown 里）。

## 9. 测试、打包与发布

**测试**

1. 单元测试：现有 pytest 里的纯逻辑部分（快捷指令、提醒解析、角色匹配、定时拍照、直播解析、
   限流）移植到 vitest，用例数据原样搬。
2. **黑盒协议测试**：路由测试改成只走 HTTP/MQTT/UDP/TCP，**先对 Python 版跑绿，再对新版跑绿**
   ——「原样支持」的硬证据。服务端提供 `KAGURA_FAKE_PROVIDERS=1`（假 ASR/TTS/LLM，按脚本返回），
   测试不花钱不联网。
3. 系统层测试：假模型脚本化驱动，覆盖调度器（时区、错过补跑、活跃时段、重试、重启恢复）、
   a2a（白名单、跳数上限、子 agent 不能再 spawn）、隔离（路径逃逸、跨 agent 查询）、
   记忆（冲刷、检索、索引重建）、压缩。
4. 设备模拟器：扮演 CoreS3 走完 UDP 发现 → 心跳 → /chat → push → 直播；CI 在 Windows/Linux 安装包上各跑一遍。
5. 渠道：适配器层用假的飞书/QQ 服务端做测试（收消息、配对、群 @、断线重连、投递）；真账号联调由作者完成。
6. 固件侧继续 `check_split.py` + `import_sim.py`；真机由作者验证。
7. agent 质量：一组对话样例对比 OpenClaw 与新系统的回复和 token，作者打分。

**打包与发布**

- `ci.yml`（PR）：单测 + 黑盒 + 系统层测试 + 三端构建（macOS 只编译不打包）。`release.yml`（`v*` tag）：构建 Windows/Linux 安装包、发 Release。
- 矩阵：`windows-latest`、`ubuntu-22.04`（发布）；`macos-14` 只在 CI 里编译和跑测试，不出安装包。
- 产物：`Kagura-Setup-x.y.z.exe`、`Kagura-x.y.z-x86_64.AppImage`、`kagura_x.y.z_amd64.deb`、
  固件包 `kagura-device-x.y.z.zip`（`device/` + 烧录说明）。
- 安装时：Windows 加防火墙入站规则（5000/1883/5001/5002）与开机自启；Linux systemd `--user`。
  首次启动自动打开 `/admin` 的初始化向导。
- 证书与 Key 全走 GitHub Secrets，不进仓库。

## 10. 里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| **M0 技术验证** | pi 当前包名/API；Node SEA（或 bun）在 Windows/Linux 打出可执行（macOS 只编译）；`node:sqlite` + FTS；aedes；纯 JS JPEG；百度接口；OpenClaw 任务导出格式；**飞书长连接收发一条消息；QQ 官方机器人能否不用公网接入** | CI 产物能启动并回答一句话；QQ 接入路线定下来 |
| **M1 黑盒协议测试** | 现有路由测试改黑盒，Python 版全绿 | 覆盖 §4.1 每个接口 |
| **M2 服务端骨架移植** | §4 全部移植到 TS，agent 先接 OpenClaw 适配器 | 黑盒在新版全绿；作者真机试用一周无回退 |
| **M3 agent 运行时** | §6.1–6.3、6.7、6.9、6.11：agent 目录、会话落盘、soul 组装、压缩、内置工具、设备绑定 | 设备对话改走 pi；对话样例评审通过 |
| **M4 memory** | §6.4 | 检索与冲刷测试通过；管理 UI 可编辑 |
| **M5 调度器 + heartbeat** | §6.5 | 早报等任务从 OpenClaw 迁过来稳定跑一周 |
| **M6 多 agent 通信** | §6.6、§6.8 加载机制 | a2a 测试通过；两个 agent 协作样例 |
| **M7 IM 渠道** | §6.12：渠道接口、飞书、QQ（按 M0 结论选路线）、配对、绑定、IM 投递 | 手机飞书/QQ 上能和两个 agent 分别聊；定时任务能投到 IM |
| **M8 管理 UI** | §7（M3 起各页面随功能逐步上线，这里补齐与打磨） | 不碰配置文件也能完成全部日常管理 |
| **M9 边生成边播** | §6.10 服务端 + 固件小改 | 长回复首句 < 5 秒出声；老固件正常 |
| **M10 打包发布 + 迁移** | §8、§9 | 干净的 Windows/Linux 虚拟机装完即用；从 OpenClaw + Python 版迁移无丢失 |
| **M11 收尾** | 文档、`legacy/` 冻结、CLAUDE.md 更新 | — |

原则：M2 之前不动 agent；M9 之前不动固件；每一步都能单独回滚。

## 11. 风险

| 风险 | 应对 |
|---|---|
| pi 迭代快（包名刚改为 `@earendil-works`） | 锁版本；pi 只在 `runtime/` 里引用，外面隔一层自有接口 |
| 单文件打包与 pi / `node:sqlite` 不兼容 | M0 验证；不行退回「安装包带 Node 运行时 + 脚本」 |
| 系统层范围大，质量不如 OpenClaw | 名词与行为对齐 OpenClaw（§2），逐项写测试；保留 OpenClaw 适配器兜底 |
| OpenClaw 的任务存储格式变化（它新版刚把 heartbeat 并进 automations） | 导入器按版本适配；导入后默认暂停、人工确认 |
| 文件工具无沙箱 | 路径限制在 workspace；本期不执行 skill 脚本 |
| heartbeat/定时任务费用失控 | 活跃时段、便宜模型、`HEARTBEAT_OK` 不投递、用量页预警 |
| 未签名程序被误报 | Release 说明写清；有收入后买证书 |
| QQ 官方机器人只剩 Webhook（桌面版没有公网地址） | M0 先核实；不行就只提供飞书 + 可选 OneBot（明确风险），或提供"自备公网转发"的高级选项 |
| IM 平台规则变化（频次限制、被动回复时效、审核） | 适配器隔离；发送失败重试并在管理 UI 提示 |
| 陌生人通过 IM 消耗额度/套话 | 默认配对制 + 群里只响应 @；每个渠道可设每日调用上限 |

## 12. 作者已确认（2026-10-23）

- 技术选型 D1–D9 按推荐执行。
- OpenClaw 的定时任务迁移做进管理 UI（导入向导），不单独整理清单。
- 现有两个 agent，可以互相通信；通信权限在管理 UI 里配置。
- 没有 Apple 开发者账号：本期只发 Windows + Linux。
- 模型、嵌入接口全部由用户手动配置，不预设默认值。
- 管理 UI 本期只开放本机访问。
- IM 渠道要支持，首批飞书、QQ。

**M0 已定**：QQ 走官方机器人 WebSocket（不需要公网）；OneBot 保留为可选项。
