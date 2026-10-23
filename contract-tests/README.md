# 契约测试（黑盒协议测试）

只通过 HTTP / MQTT / UDP / TCP 和被测服务端打交道，不 import、不打桩任何内部函数。
**同一套用例先对 Python 版跑绿，再对 TypeScript 版（`server/`）跑绿**——这是迁移计划里
「现有功能原样支持」的验收标准（[计划 §9](../docs/plan-kagura-agent.md)）。

## 运行

```bash
pip install -r requirements.txt -r contract-tests/requirements.txt
cd contract-tests && pytest                      # 默认测 Python 版 voice_server.py
```

对 TypeScript 版（M2 起）：

```bash
KAGURA_SERVER_CMD="node ../server/dist/kagura.cjs" \
KAGURA_SERVER_PROVIDES=broker,discovery \
pytest
```

- `KAGURA_SERVER_CMD`：启动命令，工作目录是仓库根。
- `KAGURA_SERVER_PROVIDES`：被测服务端自带的组件。TS 版内置 MQTT broker 与 UDP 发现；
  Python 版两者都没有，由测试框架拉起 `_broker.py`（amqtt）和 `discovery_relay.py`。

## 被测服务端必须支持的环境变量

| 变量 | 含义 |
|---|---|
| `KAGURA_FAKE_PROVIDERS=1` | 启用假 ASR/LLM/TTS 与 `/__fake/*` 控制接口（见下） |
| `KAGURA_PORT` | HTTP 端口 |
| `KAGURA_MQTT_HOST` / `KAGURA_MQTT_PORT` | MQTT（内置 broker 时是监听端口） |
| `KAGURA_STREAM_PORT` | 直播 TCP 端口 |
| `KAGURA_DISC_PORT` | UDP 发现端口 |
| `KAGURA_DATA_DIR` | 所有运行时数据写这里（每个测试实例一个临时目录） |
| `KAGURA_TEST_CONFIG` | JSON：`{"api_token", "stream_token", "roles"}`。Python 版改读同目录的 `config.py`（框架会一起生成） |

## `/__fake/*` 测试协议

两版服务端在 `KAGURA_FAKE_PROVIDERS=1` 时都要实现（Python 版在 `fake_providers.py`）：

| 接口 | 作用 |
|---|---|
| `POST /__fake/reset` | 清空脚本、调用记录、**限流计数**（所有用例都从 127.0.0.1 发，按 IP 的兜底限流会互相干扰） |
| `POST /__fake/asr {"queue": [...]}` | 接下来 ASR 依次返回的文本；空串 = 没识别出来；用完后默认「你好」 |
| `POST /__fake/llm {"queue": [...]}` | 接下来 LLM 依次返回的回复；`{"error": "…"}` 表示这次调用失败；用完后默认「好的。」 |
| `GET /__fake/log` | `{"asr": 次数, "llm": [{"message","session","agent","image","local_time"}], "tts": [{"text","per"}]}` |

`llm[].message` 是交给模型的完整用户消息（含触觉背景、快捷指令上下文等注入），
`session` 只要求「同一会话相同、不同会话不同」，具体取值两版可以不同。

## 覆盖范围

| 文件 | 内容 |
|---|---|
| `test_chat.py` | `/chat` 协议、短路链（时间/音量/提醒真的到点推送/没听清）、`[PHOTO]`、触觉注入、免手模式、限流、录音留档 |
| `test_vision_push_capture.py` | `/chat-vision` 三种入参、`/push` 与下载即删、远程拍照全流程（测试扮演设备收 MQTT 命令并上传）、拍照后续对话 |
| `test_device_roles_token.py` | 心跳/崩溃上报/设备状态、在家状态、摇一摇与触摸、角色切换全链路与重启持久化、`API_TOKEN` 保护范围 |
| `test_monitor_stream.py` | 监控页状态、网页拍照、定时拍照端到端（拍照→识别→留档→播报）、识别播报、直播 TCP 协议（握手粘包、长轮询、坏帧、超大帧、0 长度结束、密钥）、直播中抓拍、UDP 发现 |

验证过测试能抓出问题：故意改坏服务端（响应头、角色音色、直播结束帧、下载即删、限流阈值等）
都会让用例失败。

## 内置 agent 模式（`KAGURA_BRAIN=pi`，只对 TS 版）

同一套用例在内置 agent 上再跑一遍，另外 `test_agent_system.py` 覆盖工具、会话落盘、调度器、agent 通信与管理接口
（其它模式下自动跳过）。`/__fake/llm` 的脚本项除了字符串，还可以是：

```json
{"text": "我看看", "tool_calls": [{"name": "take_photo", "args": {"question": "桌上有什么"}}], "then": "工具结果回来后的回复"}
```

日志 `llm[]` 多了 `purpose`（chat / cron / heartbeat / a2a / spawn / flush / compact）与 `system`（系统提示）两个字段。
