# Kagura 自研 Agent 与三端安装包 —— 开发计划

> 状态：草案，待确认「§2 需要拍板的决定」后动工。
> 目标读者：项目作者 + 之后接手开发的人（包括 Claude）。

## 1. 目标与边界

**目标**

1. 用 [pi](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-ai` + `pi-agent-core`，MIT）
   做一套为本项目定制的轻量 agent，替换 OpenClaw。
2. **现有功能原样支持**：设备固件的协议不变（老固件不升级也能用），网页监控页功能不变，
   服务端现有 31 个 HTTP 接口、MQTT、UDP 发现、直播 TCP 全部保留。见 §4 对照表。
3. Windows / macOS / Linux 三端**安装包即开即用**：不需要 WSL、不需要单独装 Node/Python/
   mosquitto，装完打开浏览器填 API Key 就能用。
4. GitHub Actions 打 tag 自动构建三端安装包并发布 Release。

**不做（本期）**

- 云端多租户托管（形态 B）。本期是单机版，但架构上不堵死：agent 进程内运行、无子进程、
  无全局并发 2 的限制。
- 浏览器自动化、家居控制等 OpenClaw 侧的通用能力（见 §2 D6）。
- 设备固件大改。只有 §6.3「边生成边播」需要一处小改，且老固件保持兼容。

## 2. 需要拍板的决定

| # | 问题 | 推荐 | 备选与代价 |
|---|---|---|---|
| D1 | 服务端语言 | **整体迁到 TypeScript（Node）**，一个运行时 | 保留 Python，pi 作为 Node 子进程旁挂：安装包里要塞两套运行时，三端打包和进程守护都翻倍复杂 |
| D2 | 单文件可执行怎么打 | **Node 22 SEA（官方单可执行）**，依赖全部选纯 JS 的 | `bun build --compile` 更省事，但 pi 声明 Node ≥22.19，bun 兼容性要实测；M0 两个都试 |
| D3 | 安装包形态 | Windows **Inno Setup .exe**；macOS **.dmg**（含 .app）；Linux **AppImage + .deb** | 用 Electron/Tauri 做桌面壳：体积大、多一层，网页配置页足够，不需要 |
| D4 | 代码签名 | Windows 先不签（首次运行有 SmartScreen 提示）；**macOS 必须签名+公证**，否则 Gatekeeper 拦截 | macOS 需要 Apple 开发者账号（年费），证书放 GitHub Secrets |
| D5 | 语音识别/合成 | 先保留百度，抽成接口 | 之后可换支持流式的服务商，接口不动 |
| D6 | OpenClaw 侧的能力 | 本期只做设备相关的；**需要作者列出 OpenClaw 里给设备用的 skill / 定时任务 / 记忆文件**（见 §4.3） | 不列清楚就无法保证"原样支持" |
| D7 | 是否保留 OpenClaw 后端 | **保留一个可选适配器**（调 CLI，同现在），作者自用可继续接 OpenClaw，产品版默认 pi | 不保留：作者自己的设备也得迁 |
| D8 | 现有 Python 版去留 | 新版达到 §8 验收后，Python 版冻结在 `legacy/`，一个版本后删除 | — |

## 3. 总体架构

```
                       ┌──────────────── kagura-server（单个可执行文件）────────────────┐
CoreS3 ──HTTP :5000──▶ │ http 层（Fastify）  路由与现在逐一对应，响应头协议不变          │
       ◀─MQTT :1883──  │ 内置 MQTT broker（aedes，纯 JS）——不再需要 mosquitto          │
       ──UDP  :5001──▶ │ 发现应答（dgram）——不再需要 discovery_relay                    │
       ──TCP  :5002──▶ │ 直播接收（net）                                               │
浏览器 ──HTTP :5000──▶ │ /monitor 监控页（原文件照搬） + /setup 首次配置页              │
                       │                                                              │
                       │ brain：pi-agent-core Agent（每设备×角色一个会话）              │
                       │   ├ 人设：roles/<id>/persona.md                                │
                       │   ├ 记忆：会话 JSONL + 滚动摘要 + 长期笔记                     │
                       │   ├ 工具：speak / take_photo / reminder / photo_schedule /     │
                       │   │       volume / time / presence / web_search(可选)          │
                       │   └ 事件：shake / touch / presence / 定时任务 → agent.prompt    │
                       │ voice：ASR / TTS 接口（百度实现）+ TTS 缓存                    │
                       │ store：数据目录（按系统：%APPDATA% / ~/Library/Application      │
                       │        Support / ~/.local/share）下的 json / jsonl / 图片       │
                       └──────────────────────────────────────────────────────────────┘
```

## 4. 功能对照表（验收清单）

### 4.1 设备与网页接口（必须逐字节兼容响应头协议）

| 现在 | 新系统 | 备注 |
|---|---|---|
| `POST /chat`：ASR → 短路链（没听清/免手退出/角色/提醒/音量/快捷指令）→ LLM → TTS | 同；短路链原样移植；LLM 换 brain | 响应头 `X-Need-Photo` `X-Volume` `X-User-Text` `X-Reply-Text` `X-Role` `X-Asr-Empty` `X-Cont-Exit` 全保留 |
| `POST /chat-vision` 三种入参 | 同；图片直接作为多模态输入给模型 | 不再写 OpenClaw 工作目录 |
| `POST /push`、`GET /push-audio/<f>` | 同 | |
| `POST /capture-request`、`/upload-photo`、`GET /capture-result/<id>`、`/photo/<id>` | 同；`take_photo` 工具内部复用 | `image_path` 字段保留 |
| `/shake`、`/touch`、`/presence` | 同；改为向 agent 投递事件，agent 用 `speak` 工具开口 | 不再依赖 cores3-speak skill 和 workspace 状态文件 |
| `/heartbeat`、`/device-status`、`/crash-report` | 同；日志落数据目录 | |
| `/time`、`/health`、`/test-tone` | 同 | |
| `/role` GET/POST、`/role/cycle` | 同 | |
| `/debug-audio/<dev>`、`/snapshot/<name>` | 同 | |
| `/monitor` 与 `/api/monitor/*`（state、stream、frame、describe、capture、schedules 增删改跑） | 同；`monitor.html` 原文件照搬 | |
| MQTT `kagura/push/*`、`kagura/cmd/*`（capture / stream_start / stream_stop / role） | 同；broker 内置 | |
| UDP 5001 `KAGURA_DISCOVER` → `KAGURA_HERE` | 内置应答 | WSL 下才需要的中继脚本删除 |
| TCP 5002 直播（4 字节长度 + RGB565，握手合包坑） | 同；RGB565→JPEG 用纯 JS 编码 | 现在依赖 numpy + pillow |
| `API_TOKEN`、`STREAM_TOKEN`、限流 | 同 | |

### 4.2 服务端后台逻辑

提醒调度（`reminders.json`）、每日定时拍照（含 `MISS_WINDOW`、当天去重、`_SCHEDULE_SPEAK_HINT`
语义）、心跳失联巡检、拍照结果清理、TTS 内容寻址缓存（cache key 规则不变）、
`debug_audio` 留存、分阶段耗时日志、`_hb_seen`。全部移植，单测一起移植。

### 4.3 OpenClaw 侧的能力（需作者补全清单）

从代码里能看到的：

- 角色人设与对话记忆（session）
- `cores3-speak`：agent 主动说话 → `/push`
- `cores3-camera`：agent 主动拍照 → `/capture-request` + `/capture-result`
- 回复 `[PHOTO]` 前缀触发拍照
- 读取 `user_presence.txt` / `mio-home-status.json` 判断在不在家
- **定时主动播报（早报等）**：代码里有"早报推送 2.4MB"的记录，推测是 OpenClaw 的定时任务
- 可能还有：联网搜索/天气（早报内容来源）、浏览器操作（启动脚本开了 Chrome 调试端口）

**动工前请作者确认**：给设备用的 skill 列表、定时任务列表及其提示词、需要迁移的记忆内容。
产品版至少要提供：定时任务（cron + 提示词）、联网搜索/天气两个工具。

## 5. 模块拆分（新仓库目录，暂定 `server/`）

```
server/
  src/
    main.ts            启动：读配置 → 起 http / mqtt / udp / tcp → 托盘（可选）
    config.ts          配置文件（数据目录下 config.json），首次启动生成
    http/              每组路由一个文件，与 voice_server.py 的分段对应
    voice/asr.ts       ASR 接口 + baidu 实现
    voice/tts.ts       TTS 接口 + baidu 实现 + 缓存
    shortcut/          quick_commands / roles 匹配（直接移植正则与测试）
    brain/agent.ts     pi Agent 封装：会话池、并发、超时
    brain/memory.ts    transformContext：最近 N 轮 + 滚动摘要；长期笔记
    brain/tools/*.ts   speak、take_photo、reminder、photo_schedule、volume、time、
                       presence、web_search（可选）
    brain/events.ts    shake / touch / presence / cron → agent
    brain/openclaw.ts  可选：OpenClaw CLI 适配器（D7）
    jobs/              reminders、photo_schedules、心跳巡检、清理
    stream/            直播 TCP 接收 + JPEG 编码
    mqtt/              aedes broker + 发布助手
    discovery.ts       UDP 应答
  web/                 monitor.html（照搬）+ setup.html（新）
  test/                单测（vitest）
contract-tests/        黑盒协议测试（pytest，见 §7）
packaging/             各平台安装脚本与图标
.github/workflows/     ci.yml、release.yml
```

## 6. Agent 设计

### 6.1 会话与记忆

- 会话 key 沿用现在的规则：默认角色 = `device_id`，其他 = `device_id~role_id`。
- 每个会话一个 JSONL 文件落盘（**服务端重启不丢上下文**，现在的会话只在内存里）。
- `transformContext` 回调：保留最近 N 轮原文 + 一段滚动摘要（超过阈值时用便宜模型压缩更早的
  内容）。N 和阈值写进配置，**这是成本的主要旋钮**。
- 长期记忆：`remember` / `recall` 两个工具，存成每角色一个 markdown 笔记文件，注入系统提示。

### 6.2 工具（替代 OpenClaw skill 和 `[PHOTO]` 前缀）

| 工具 | 作用 | 对应现在 |
|---|---|---|
| `speak(text)` | 主动播报（推送到设备） | cores3-speak |
| `take_photo(question)` | 对话中拍照并看图 | `[PHOTO]` → `X-Need-Photo` → `/chat-vision` |
| `set_reminder` / `list_reminders` | 提醒 | 短路链里的提醒（保留短路，同时给 agent 用） |
| `photo_schedule_*` | 定时拍照增删改 | 网页才能配，现在 agent 也能配 |
| `set_volume` | 调音量 | `X-Volume` |
| `get_presence` | 在不在家 | workspace 状态文件 |
| `web_search` / `weather`（可选） | 早报等内容来源 | OpenClaw 侧能力 |

**`take_photo` 的兼容做法**：设备是单线程的，/chat 请求进行中收不了 MQTT 拍照命令。所以工具
被调用时，本轮立即结束：用已生成的那句应答（如「我看看」）作为回复，带 `X-Need-Photo: 1`
返回（工具返回 `terminate`，本轮不再调模型）；设备照现在的流程拍照并发 `/chat-vision`，
服务端把照片连同原问题作为同一会话的下一条消息交给 agent。设备端零改动。

### 6.3 边生成边播

- pi 的 `text_delta` 按句号/问号/感叹号切句 → 每句合成 → 写进 HTTP 响应。
- 响应不带 `Content-Length`（读到连接关闭为止）。设备的 `stream_play` 本来就是读到 EOF、
  每块自己补 WAV 头，**音频部分不用改**。
- 难点是**响应头必须在正文之前发**，而 `X-Reply-Text`、`X-Need-Photo` 等要等生成后才知道。
  做法：
  1. 等到第一句话合成好、或模型已经调用了影响响应头的工具（拍照/音量/退出）时才发响应头；
  2. `X-Reply-Text` 只放第一句，完整文本由设备播完后 `GET /chat/last` 取回（**固件小改**）；
  3. 请求头带 `X-Stream: 1` 的新固件才走流式，老固件仍按整段返回 + `Content-Length`。

### 6.4 主动事件

shake / touch / presence / 定时任务 → 构造一条事件消息投给对应会话的 agent，agent 自己决定
是否 `speak`。现有提示词（摇一摇、触摸描述、`_SPEAK_HINT`）原样迁移。冷却和显著性筛选仍在
设备端（`FEEL_NOTIFY_COOLDOWN` 不放宽）。

### 6.5 模型配置

角色表扩展为：`agent` 字段换成 `provider` + `model` + `persona` 文件路径（兼容旧的 `ROLES`
写法，迁移工具自动转换）。pi-ai 内置 DeepSeek、通义千问和任意 OpenAI 兼容接口。每次调用的
token 用量和费用写日志，网页监控页加一个「本月用量」卡片。

## 7. 测试策略

1. **单元测试**：现有 227 个 pytest 里，纯逻辑部分（快捷指令、提醒解析、角色匹配、定时拍照、
   直播解析、限流等）逐个移植到 vitest，用例数据原样搬。
2. **黑盒协议测试（关键）**：把 `test_routes.py` 等路由测试改写成只走 HTTP/MQTT/UDP/TCP 的
   黑盒测试，同一套用例**先对现有 Python 服务端跑通，再对新服务端跑通**。服务端提供
   `KAGURA_FAKE_PROVIDERS=1` 模式（假 ASR/TTS/LLM，按脚本返回），测试不花钱、不联网。
   这是"原样支持"的硬证据。
3. **设备模拟器**：一个脚本扮演 CoreS3，走完 UDP 发现 → 心跳 → /chat → MQTT push → 直播
   全流程。CI 里在三端打出来的安装包上各跑一遍（冒烟测试）。
4. 固件侧继续用 `check_split.py` + `import_sim.py`；真机验证仍由作者完成。
5. agent 质量：准备一组对话样例（日常聊天、拍照、提醒、角色切换、主动事件），对比
   OpenClaw 与新 agent 的回复和每轮 token，作者人工打分。

## 8. 里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| **M0 技术验证** | pi + Node SEA / bun 在三端各打出一个可执行；aedes、纯 JS JPEG、百度接口跑通；确认 pi 当前包名与 API | 三端 CI 产物能启动并回答一句话；定下 D1/D2 |
| **M1 黑盒协议测试** | 把现有路由测试改成黑盒，先在 Python 版上全绿 | 黑盒测试覆盖 §4.1 每个接口 |
| **M2 服务端移植** | §4.1、§4.2 全部移植到 TS，LLM 先接 OpenClaw 适配器 | 黑盒测试在新服务端全绿；作者真机试用一周无回退 |
| **M3 pi agent** | §6.1–6.2、6.4–6.5；§4.3 清单里的能力 | 对话样例评审通过；token 用量有日志 |
| **M4 边生成边播** | §6.3 服务端 + 固件小改 | 长回复首句出声 < 5 秒；老固件仍正常 |
| **M5 打包发布** | 三端安装包、首次配置页、开机自启、防火墙规则、数据迁移工具、release.yml | 干净虚拟机上装完即用；从 Python 版迁移数据无丢失 |
| **M6 收尾** | 文档、`legacy/` 冻结、CLAUDE.md 更新 | — |

M2 完成前不动 agent，M3 完成前不动固件：每一步都能单独回滚。

## 9. 打包与发布细节

- **触发**：推送 `v*` tag → `release.yml`；平时 PR 走 `ci.yml`（单测 + 黑盒测试 + 三端构建）。
- **矩阵**：`windows-latest`、`macos-14`（arm64）、`macos-13`（x64）、`ubuntu-22.04`。
- **产物**：`Kagura-Setup-x.y.z.exe`、`Kagura-x.y.z-arm64.dmg` / `-x64.dmg`、
  `Kagura-x.y.z-x86_64.AppImage`、`kagura_x.y.z_amd64.deb`，外加固件包 `kagura-device-x.y.z.zip`
  （`device/` 目录 + 烧录说明）。
- **安装时做的事**：Windows 加防火墙入站规则（5000/1883/5001/5002）、开机自启（启动文件夹或
  计划任务）；macOS 写 LaunchAgent；Linux 写 systemd `--user` 单元。
- **首次启动**：自动打开 `http://localhost:5000/setup`，填模型 API Key、百度 Key、选角色；
  配置存数据目录，升级不覆盖。
- **端口被占**：启动时检测并在配置页提示；设备靠 UDP 发现找服务端，换 IP 不用改固件。
- **签名**：见 D4，相关证书全部走 GitHub Secrets，不进仓库。

## 10. 风险

| 风险 | 应对 |
|---|---|
| pi 迭代快（包名刚从 `@mariozechner` 改成 `@earendil-works`） | 锁定版本；只在 `brain/` 里引用 pi，外面隔一层自己的接口 |
| 单文件打包与 pi 不兼容 | M0 先验证，不行就退回"安装包里带 Node 运行时 + 脚本" |
| 新 agent 的效果不如 OpenClaw | M3 用对话样例对比；保留 OpenClaw 适配器兜底 |
| OpenClaw 侧能力没列全 | §4.3 动工前确认 |
| 未签名程序被杀毒软件误报 | 先在 Release 说明里写清楚；有收入后再买 Windows 证书 |
| 移植引入回归 | 黑盒协议测试先在旧版跑绿，再在新版跑绿 |

## 11. 动工前需要作者回答

1. §2 的 D1–D8 是否同意推荐项？
2. §4.3：OpenClaw 里给设备用的 skill、定时任务（含提示词）、记忆文件分别有哪些？
3. 有没有 Apple 开发者账号（决定 macOS 包能否顺利安装）？
4. 默认用哪家模型（DeepSeek / 通义千问 / 其他）？
5. 新服务端放在本仓库 `server/` 子目录，还是新开仓库？（推荐本仓库，固件和协议测试在一起）
