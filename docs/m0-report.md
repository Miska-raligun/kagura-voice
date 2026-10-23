# M0 技术验证报告

> 日期：2026-10-23 · 分支 `feat/kagura-agent-server` · 计划见 [plan-kagura-agent.md](plan-kagura-agent.md)
> 结论：**技术路线全部可行，可以进入 M1。** 验证脚本在 `server/spikes/`，CI 见 `.github/workflows/server.yml`。

## 结论一览

| 验证项 | 结果 | 证据 |
|---|---|---|
| pi 当前包名与版本 | ✅ `@earendil-works/pi-ai` / `pi-agent-core` **1.4.0**，MIT，要求 Node ≥22.19 | `server/package.json` |
| pi agent：工具调用 + 逐字输出 | ✅ 一轮里先说半句 → 调工具 → 拿结果 → 接着说，`text_delta` 正常 | `spikes/pi-agent.ts` |
| 接任意 OpenAI 兼容接口 | ✅ `createProvider` + `openAICompletionsApi`，对本地假 SSE 服务器跑通：API Key 鉴权、工具定义、流式、usage 与费用自动计算 | `spikes/pi-openai-compat.ts` |
| 工具 `terminate` 提前结束本轮 | ✅ 只调一次模型（计划 §6.9 拍照兼容方案可行） | 同上 |
| 不联网测试 | ✅ pi-ai 自带 `faux` 假模型，可脚本化回复——`KAGURA_FAKE_PROVIDERS` 直接用它 | `spikes/pi-agent.ts` |
| `node:sqlite` + FTS5 | ✅ 内置可用，**但 trigram 分词搜不到两字中文词**，改用「CJK 逐字切开 + unicode61 + 短语查询」，单字/两字/中英混合都能搜 | `spikes/fts-cjk.ts` |
| 向量存储 | ✅ Float32 存 BLOB 往返无损，余弦在 JS 里算 | `spikes/infra.ts` |
| 内置 MQTT broker（aedes） | ✅ 用最小 MQTT 3.1.1 客户端（模拟设备）订阅 `kagura/push/*`，服务端发布后收到 | 同上 |
| RGB565→JPEG 纯 JS | ✅ 320×240 约 33ms；字节序与现有 `voice_server`（`frombuffer` + `byteswap` = 大端）一致 | 同上 |
| esbuild 打单个 CJS | ✅ 核心依赖约 0.9MB；加飞书 SDK 约 5.9MB | `scripts/build.mjs` |
| Node SEA 单文件可执行 | ✅ **Windows / Linux / macOS × Node 22 / 24 共 6 个组合全部通过**（CI run #1） | `scripts/sea.mjs` |
| 单文件体积 | Windows 95MB（zip 后 36MB）；Linux 约 120MB。几乎全是 Node 本体 | CI 日志 |
| 飞书 SDK | ✅ `@larksuiteoapi/node-sdk` 1.76.0（MIT）能打进单文件，`WSClient` / `EventDispatcher` 可构造。长连接不需要公网 | `spikes/feishu-bundle.ts` |
| QQ 接入路线 | **定为官方机器人 + WebSocket**（不需要公网）。2024 年官方 SDK 曾说要下线 WebSocket，未落实；社区记录 2026-08 起可以在后台切回 WebSocket；官方文档写明两种方式可切换。OneBot 保留为可选项 | 见下方来源 |

## 对计划的修正

1. **打包用 Node 24 LTS**：Node 22 下 `node:sqlite` 会打印实验特性警告，Node 24 已转正。开发和测试两个版本都跑，发布产物用 24。
2. **记忆检索不用 trigram**：中文两字词是最常见的检索词，trigram 至少要 3 个字。入库与查询都先做 CJK 逐字切分（计划 §6.4 已同步）。
3. **RGB565 换算要用整数除法**（`Math.floor`），才能与 Python 的 `//` 逐像素一致；移植时加对拍测试。
4. **pi-ai 只按需引入服务商**：它的依赖带了 AWS、Google、Anthropic 等全部 SDK。只 import 用到的 `api/openai-completions.lazy` 等，打包体积就很小。
5. **QQ 路线定为官方机器人 WebSocket**；没有官方 Node SDK 可用于新版私聊/群聊接口，M7 自己实现一个精简客户端（鉴权 → gateway → identify/intents → 心跳 → 收 `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` → REST 回复）。

## 还没验证、需要作者配合的

- 真实模型（DeepSeek / 通义千问等）的调用：没有 Key，用的是本地假服务器。M3 由作者填 Key 实测。
- 飞书、QQ 的真实收发：需要作者的应用凭据，M7 联调。
- 单文件可执行在**作者自己的 Windows 电脑**上运行（杀毒软件、SmartScreen 的表现）：CI 产物可以直接下载试，见 Actions 里的 `kagura-smoke-windows-latest`（保留 3 天）。

## 来源

- [pi-mono 仓库](https://github.com/badlogic/pi-mono)
- [飞书长连接接收事件](https://open.larkoffice.com/document/server-side-sdk/java-sdk-guide/handle-events.md)
- [QQ 机器人：事件订阅与通知](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)
- [Koishi 论坛：2026.8 已支持切换回 WebSocket](https://forum.koishi.xyz/t/topic/10049)
- [BotGo（官方 Go SDK）README 中的 2024 年下线说明](https://github.com/tencent-connect/botgo)
