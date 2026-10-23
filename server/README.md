# Kagura 服务端（TypeScript 版）

`voice_server.py` 的替代品：一个单文件可执行，内置 MQTT broker、UDP 发现、直播 TCP，
设备端固件**不用改**。当前（M2）大脑仍是 OpenClaw CLI 适配器，M3 起换成内置 pi agent。
完整计划见 `docs/plan-kagura-agent.md`。

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

字段含义与旧 `config.py` 一一对应。`roles`、`openclaw` 可省略（默认 `~/.npm-global/bin/openclaw`、`~/.openclaw`；写的话要用绝对路径，不展开 `~`）。从旧版迁移：

```bash
python3 tools/migrate_to_server.py        # config.py → config.json，并复制提醒/定时拍照/角色状态/快照
```

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
| `src/brain/` | 大脑接口；`openclaw.ts` = OpenClaw CLI 适配器 |
| `src/fake.ts` | `KAGURA_FAKE_PROVIDERS=1` 时的假 ASR/LLM/TTS（契约测试用） |
