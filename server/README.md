# Kagura 服务端（TypeScript 版）

`voice_server.py` 的替代品：一个单文件可执行，内置 MQTT broker、UDP 发现、直播 TCP，
设备端固件**不用改**（新固件多一个「边生成边播」）。大脑二选一：**内置 agent 系统**（基于 pi）或 OpenClaw CLI 适配器。
这份文档面向配置与开发；使用者先看仓库根目录的 [README](../README.md)。完整计划见 `docs/plan-kagura-agent.md`。

## 安装（推荐）

GitHub Releases 下载对应安装包（打 `v*` tag 时由 `.github/workflows/release.yml` 自动构建，
构建时会在 CI 上真的装一遍、对装好的程序跑完整契约测试再卸载）：

| 系统 | 文件 | 装完 |
|---|---|---|
| Windows 10/11 | `Kagura-Setup-x.y.z.exe` | 自动加防火墙规则（程序级、所有网络类型）、可选开机自启；装完启动并打开管理界面 |
| Debian/Ubuntu | `kagura_x.y.z_amd64.deb` | `systemctl --user enable --now kagura`（数据 `~/.local/share/kagura`） |
| 其它 Linux | `Kagura-x.y.z-x86_64.AppImage` | 终端里运行即可 |
| 设备固件 | `kagura-device-x.y.z.zip` | 按包内「烧录说明.md」上传 |

命令行：`kagura --version`、`kagura migrate <旧版目录>`（迁移 Python 版配置/提醒/定时拍照/快照/TTS 缓存）、
`kagura import-openclaw [目录]`、`kagura --no-browser`。首次在终端或桌面启动、还没配模型时会自动打开管理界面的设置向导。
端口被占用会直接告诉你是谁（1883 → 多半是 mosquitto）。

本地打包：`node scripts/make-icon.mjs && bash packaging/linux/build.sh 0.1.0`（Windows 用 Inno Setup 编译
`packaging/windows/kagura.iss`）；固件包 `python3 tools/pack_device.py 0.1.0 server/dist`。

## 端口

| 端口 | 用途 | 覆盖 |
|---|---|---|
| 5000/tcp | HTTP（设备接口 + `/monitor` 网页） | `port` / `KAGURA_PORT` |
| 1883/tcp | **内置** MQTT broker | `mqtt_port` / `KAGURA_MQTT_PORT` |
| 5001/udp | 服务端自动发现 | `disc_port` / `KAGURA_DISC_PORT` |
| 5002/tcp | 摄像头直播流 | `stream_port` / `KAGURA_STREAM_PORT` |

> ⚠️ 1883 由内置 broker 占用：**启动前先停掉 mosquitto 和旧的 `voice_server.py`**，
> 否则启动报 `EADDRINUSE`。WSL 用户的 `openclaw-startup.ps1` 端口转发不用改（端口没变）。

## 配置

数据目录（`KAGURA_DATA_DIR` 可覆盖）：

- Windows：`%APPDATA%\Kagura`
- Linux：`~/.local/share/kagura`

其中 `config.json`：

```json
{
  "baidu": { "asr_key": "", "asr_secret": "", "tts_key": "", "tts_secret": "" },
  "api_token": "",
  "stream_token": "",
  "roles": [
    { "id": "",    "name": "神乐", "agent": "main", "per": 111, "aliases": ["kagura"] },
    { "id": "mio", "name": "小澪", "agent": "mio",  "per": 4,   "aliases": ["小玲"] }
  ],
  "openclaw": { "bin": "/home/you/.npm-global/bin/openclaw", "dir": "/home/you/.openclaw", "default_agent": "main" }
}
```

字段含义与旧 `config.py` 一一对应。`roles`、`openclaw` 可省略（默认 `~/.npm-global/bin/openclaw`、`~/.openclaw`；写的话要用绝对路径，不展开 `~`）。
日常用管理界面「设置」页改就行，不用手写。从旧版迁移：

```bash
kagura migrate <旧仓库目录>     # config.py → config.json，并复制提醒/定时拍照/角色状态/快照/TTS 缓存
```

## 大脑：内置 agent（推荐）或 OpenClaw

`config.json` 里写 `"brain": "pi"` 或 `"openclaw"`；不写时：配了 `models.providers` 就用内置 agent，否则 OpenClaw。

### 模型（全部手动配置，不预设）

```json
{
  "brain": "pi",
  "models": {
    "providers": [
      { "id": "deepseek", "api": "openai-completions", "base_url": "https://api.deepseek.com/v1", "api_key": "sk-…",
        "models": [{ "id": "deepseek-chat", "context_window": 64000, "max_tokens": 8192,
                     "cost": { "input": 2, "output": 8 } }] },
      { "id": "qwen", "api": "openai-completions", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key": "sk-…",
        "models": [{ "id": "qwen-vl-max", "input": ["text", "image"] }] }
    ],
    "default": "qwen/qwen-vl-max",
    "cheap": "deepseek/deepseek-chat"
  },
  "embedding": { "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key": "sk-…", "model": "text-embedding-v3" },
  "runtime": { "max_concurrency": 4, "timeout_secs": 120 },
  "a2a": { "enabled": true, "max_hops": 3, "per_pair_per_min": 10 }
}
```

- `api`：`openai-completions`（DeepSeek / 通义 / Kimi / 智谱 / Ollama 等 OpenAI 兼容接口）、`anthropic-messages`、
  `openai-responses`、`google-generative-ai`。`cost` 单位是「每百万 token 的价格」，用于用量统计。
- 设备拍照看图要求模型 `input` 含 `image`；纯文本模型收到图片会如实告诉用户看不了。
- `cheap` 用于压缩、记忆冲刷、heartbeat；`embedding` 可选，不配就只用关键词检索记忆。

### Agent 目录

首次启动按 `roles` 建 agent（每个角色一个，id = 角色的 `agent` 名），之后以磁盘为准：

```
<数据目录>/agents/<id>/agent.json     名字、别名、音色 per、device_role（设备图片目录）、model、tools/skills 白名单、
                                     a2a.allow、heartbeat、compaction、device_in_main
<数据目录>/agents/<id>/workspace/     SOUL.md IDENTITY.md USER.md AGENTS.md TOOLS.md HEARTBEAT.md MEMORY.md memory/ skills/
<数据目录>/agents/<id>/agent.sqlite   会话、消息、用量、记忆索引
<数据目录>/system.sqlite              定时任务、运行记录、agent 通信记录
<数据目录>/skills/<name>/SKILL.md     全局技能（本期只读说明，不执行脚本）
```

从 OpenClaw 搬人设、记忆与定时任务（任务导入后默认暂停）：
`curl -X POST localhost:5000/api/admin/import/openclaw -d '{"dir":"/home/you/.openclaw"}'`

### 内置工具

`speak` `take_photo` `set_volume` `get_presence` `photo_schedule_*` · `memory_search` `memory_get` `memory_write` ·
`cron_list` `cron_add` `cron_update` `cron_remove` `cron_run` · `sessions_list` `sessions_history` `sessions_send` `sessions_spawn` · `skill_read`

### 管理界面

在运行服务端的这台电脑上打开 **http://127.0.0.1:5000/admin**（只允许本机访问，局域网其它机器 403）。
总览、Agents（人设文件带字数预算、音色试听、工具/技能白名单、heartbeat、通信权限）、会话、记忆（编辑与检索测试）、
定时任务（向导、立即运行、运行历史、从 OpenClaw 导入）、Agent 通信矩阵、渠道（飞书/QQ 账号、配对审批、绑定）、
设备（绑定、日志、崩溃报告、录音试听、监控页）、网页聊天、用量、设置（模型服务商、嵌入、百度、端口、首次设置向导）。
不碰配置文件也能完成全部日常管理。前端在 `admin-ui/`（Preact，esbuild 编译后内联进单文件可执行）。

### IM 渠道（飞书 / QQ）

在管理界面「渠道」页添加账号，配置存 `<数据目录>/channels.json`：

| 渠道 | 需要 | 说明 |
|---|---|---|
| 飞书 / Lark | App ID、App Secret | 企业自建应用，事件订阅选「长连接」并加 `im.message.receive_v1`；不需要公网 |
| QQ 官方机器人 | AppID、AppSecret | 回调方式选 WebSocket，开通单聊与群 @；不需要公网 |
| OneBot v11（可选） | 正向 WebSocket 地址、token | NapCat / LLOneBot 等，**非官方协议有封号风险**，默认关闭 |

私聊默认**配对制**（陌生人收到配对码，在「渠道」页批准）；群里默认只回应 @ 机器人；每账号每日回复上限。
同一个 agent 的记忆跨渠道共享；定时任务的投递目标可以写 `feishu:<账号id>:<聊天id>`。聊天里发 `/reset` 开新对话。

### 管理接口（只允许本机访问）

| 接口 | 作用 |
|---|---|
| `GET /api/admin/overview` | 总览：agent 今日用量、设备、失败任务、heartbeat |
| `GET/POST /api/admin/agents`、`GET/PATCH/DELETE /api/admin/agents/<id>` | agent 增删改（删除进 `agents/.trash/`） |
| `GET/PUT /api/admin/agents/<id>/file?path=SOUL.md` | 读写人设与记忆文件 |
| `GET /api/admin/agents/<id>/sessions[/<key>]`、`POST …/<key>/reset`、`…/compact` | 会话浏览、重置、压缩 |
| `POST /api/admin/agents/<id>/memory/search`、`…/memory/reindex` | 记忆检索测试、重建索引 |
| `GET/POST /api/admin/jobs`、`PATCH/DELETE /api/admin/jobs/<id>`、`POST …/run`、`GET …/runs` | 定时任务 |
| `GET /api/admin/a2a`、`PUT /api/admin/a2a/allow`、`PUT /api/admin/a2a/settings` | agent 通信记录与权限矩阵 |
| `GET /api/admin/devices`、`PUT /api/admin/devices/<id>` | 设备绑定哪个 agent |
| `POST /api/admin/chat` | 网页聊天（`{"agent":"mio","text":"…"}`） |

heartbeat 开关：`PATCH /api/admin/agents/main` `{"heartbeat":{"enabled":true,"every_minutes":30,"delivery":"device:cores3","active_hours":"08:00-23:00"}}`

## 运行

```bash
cd server && npm ci
node scripts/build.mjs src/main.ts dist/kagura.cjs   # 打包成单个 JS
node dist/kagura.cjs                                  # 直接跑（Node ≥ 22.19）
node scripts/sea.mjs dist/kagura.cjs dist/kagura      # 再打成单文件可执行（不需要装 Node）
./dist/kagura
```

CI 每次推送都会在 Windows/Linux/macOS 上打出可执行并跑契约测试，产物在 Actions 的
`kagura-<os>` artifact 里，可以直接下载试用。

## 测试

```bash
npx tsc --noEmit -p .      # 类型检查
npx vitest run             # 单测
# 契约测试（与 Python 版同一套黑盒用例）
cd ../contract-tests && KAGURA_SERVER_CMD=server/dist/kagura KAGURA_SERVER_PROVIDES=broker,discovery python -m pytest -q
# 同一套再对内置 agent 跑一遍（另加 test_agent_system.py 的内置 agent 专用用例）
KAGURA_BRAIN=pi KAGURA_SERVER_CMD=server/dist/kagura KAGURA_SERVER_PROVIDES=broker,discovery python -m pytest -q
```

## 代码结构

| 路径 | 说明 |
|---|---|
| `src/main.ts` | 入口：读配置、起各服务、后台任务 |
| `src/config.ts` | 配置与数据目录 |
| `src/ctx.ts` | 共享上下文与跨路由的业务（推送、拍照、定时识别） |
| `src/routes/` | `chat`（/chat、/chat-vision、/role/cycle）、`device`、`monitor` |
| `src/http/router.ts` | 极简路由器（Flask 风格 `<param>`） |
| `src/mqtt.ts` / `discovery.ts` / `stream.ts` | 内置 broker、UDP 发现、直播 TCP |
| `src/shortcut/` | 快捷指令、提醒解析、触觉背景 |
| `src/jobs/` | 提醒、每日定时拍照 |
| `src/voice/` | 百度 ASR/TTS（缓存 key 与 Python 版逐字节一致，旧 `tts_cache/` 可直接复用） |
| `src/brain/` | 大脑接口；`pi.ts` = 内置 agent，`openclaw.ts` = OpenClaw CLI 适配器 |
| `src/agent/` | 内置 agent 系统：`registry`（agent 目录）、`runtime`（每轮运行/串行/压缩）、`soul`（系统提示组装）、`models`、`memory`、`scheduler` + `cron`、`a2a`、`skills`、`tools/*` |
| `src/routes/admin.ts` / `admin-ui.ts` | 管理接口 `/api/admin/*` 与 `/admin` 页面（只许本机） |
| `src/channels/` | IM 渠道：`manager`（配对/绑定/路由/投递）、`store`、`feishu`、`qq`、`onebot` |
| `admin-ui/` | 管理界面前端（Preact + TSX，`npx tsc -p admin-ui` 类型检查） |
| `src/fake.ts` | `KAGURA_FAKE_PROVIDERS=1` 时的假 ASR/LLM/TTS（契约测试用） |
