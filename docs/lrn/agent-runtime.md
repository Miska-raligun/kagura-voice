# Agent 运行时：会话锁、上下文、压缩、a2a

> 踩坑记录（LRN），从 CLAUDE.md 按子系统拆出来的。改 runtime / 压缩 / 上下文预算 / 单轮上限 / 会话页实时过程 / agent 间通信 / 运行状况之前先读这份；新踩的坑也记在这里（写清症状、原因、别改坏的点）。

- **`agent/runtime.ts` 拆过一次（2026-11）**：原来 1460 行，独立的部分搬到了同目录——`context.ts`（token 估算、`pruneToolResults`、`repairHistory`、`OVERFLOW_RE`）、
  `turnguard.ts`（`TurnGuard`、`GUARD_STOP`）、`messages.ts`（`flattenUser`、`stripRecall`、`stripImages`、`RECALL_TAG`、`silentMsg`、`EMPTY_RE`）、
  `voicetap.ts`（`VoiceTap`、`voicePrompt`、`unvoice`）、`live.ts`（`LiveHub`、`liveMessage`）、`locks.ts`（`SessionLocks.serial`、`Semaphore`）、
  `compact.ts`（`Compactor`：`maybeCompact` / `afterReply` / `compactNow`、`parseCompactOutput`）、`recent.ts`（近况）、`spoken.ts`（朗读兜底）。
  下面条目里写「`runtime.ts` 的 X」「`Runtime.X`」的，X 可能已经在这些文件里（`runtime.ts` 用 `export *` 转出，从原处照样 import 得到）。
  `Runtime` 上的开关（`compactChunk`、`backgroundCompact`、`beforeCompact`、`remember`）没动，`Compactor` 从 `Runtime` 上读。
  留在 `runtime.ts` 的是 `Runtime` 类：`run` / `runInner`（排队、互等、超长与空回复重试）、`execute`（一轮本身，300 多行，没拆）、`toolsFor`、`recallFor`、`note`、`steer`。
- **会话锁不能被无限占着**（`agent/runtime.ts` + `locks.ts`，LRN 2026-10-24，症状「某个 agent 突然不理人、再发也没反应，换个 agent 正常」）：
  同一会话的轮次串行（`serial`），一轮卡住后面全排队。占锁的每一段都要有时限、能被取消：① 回复前的压缩（记忆冲刷 + 摘要模型调用）
  以前既没超时也不理取消，接口一卡就永远锁死——现在上限 2×`timeout_secs`、接上 `req.signal`，超时 / 取消就跳过压缩、照常回复，
  放弃之后回来的结果**不再改历史**；② 工具执行期间不按 idle 计时，但最多 `TOOL_MAX_MS`（15 分钟）；③ 流式写音频的 `write` 要同时听 `drain` 和 `close`，
  对方断开时 drain 永远不来，异步回复会一直回「还在想」。排队超过 20 秒会打一行 `⏳ … 在排队：上一轮还没结束（用途/渠道/阶段/工具）`——
  再遇到「不理人」先搜这行。新加任何在会话锁里 await 的东西都要问一句：它卡住了怎么办？
  **单轮上限（`TurnGuard`，LRN 2026-10-30，症状「等她回复，她一直 exec 兜圈子把 token 烧光」）**：无进展超时被每次工具调用刷新、总时长又有半小时，挡不住兜圈子。
  现在每轮有工具调用次数（`max_tool_calls`，默认 40）和 token（`max_turn_tokens`，默认 200 万，含缓存读写，0 = 不限）上限，待办 ×3；同一工具同样参数第 `REPEAT_LIMIT`（3）次直接拒绝。
  到上限先软停：之后的工具调用都返回「别再调工具，告诉主人做到哪了」，再 `GUARD_GRACE` 次还在调就强制中止。日志 `🔁`。工具经 `guard.wrap` 包一层（保留原型）。
  **会话页实时过程（`Runtime.watchLive`，`GET /api/admin/agents/<id>/sessions/<key>/live`，LRN 2026-10-30，症状「网页上只有发消息那个窗口看得到过程，切走再回来、飞书 / 设备触发的只剩『回复中』」）**：
  每轮（非嵌套）在 `execute` 里留一份 `LiveRun`（已完成的消息 + 正在生成的思考 / 正文 + 正在执行的工具），会话页长连接订阅：先快照（start / idle），再 delta / message / tool，结束 end（带错误原因，超长重试那次不报）。
  推给页面的消息过 `liveMessage`（去自动回忆、图片只留占位、工具结果截 8000 字）。页面过程一律从订阅来，发消息的 POST 只等结果；end 后先重新拉历史再收起实时块。
  **每轮 token 明细**：每条助手消息本来就带服务商报的 `usage`（输入未缓存 / 缓存读写 / 输出 / 思考 / 费用）；`execute` 落盘时在这一轮最后一条助手消息上加 `kctx`
  （系统提示 / 工具定义 / 历史的估算 token、窗口、调用次数），会话页 `TurnUsage` 汇总显示。**读历史给模型前要去掉 `kctx`**（`execute` 里 `history` 那行）。
  **系统处理详情**：`kctx` 里还有 `trace`（`buildSystemPrompt` 的 `PromptTrace`：场景、加载了哪些文件 / 全文还是目录 / 字数 / 是否截断、没加载的、今昨笔记、技能、摘要）、
  近况条数、自动回忆命中（`recallFor` 返回 hits / 用时 / 没附的原因）、截短的旧工具结果条数、单轮上限叫停原因。
  压缩不属于某一轮，记成会话事件（`AgentStore.addEvent`，`events` 表，每会话留 200 条）：`compact`（`trigger` = before / background / overflow / manual，压了多少、剩多少、记进了哪些记忆）、
  `compact_failed`；会话接口带 `events`。会话页每轮回复下面只放小图标（`TurnMeta`）：ⓘ 上下文 + token，🗜 这一轮之后发生的压缩（`placeEvents` 按时间挂到轮次上），悬停预览（不挡鼠标）、点击固定（`ui.Pop`）——**别再把详情平铺进对话流**。新加系统层对上下文的处理时也照这个记，别只打日志。
  **会话来源**：所有入口（设备、飞书 / QQ、网页、heartbeat、定时任务、待办、子任务）的会话都在 agent 库里，会话页一律能看、能实时跟。
  落盘时第一条用户消息带 `ksrc`（渠道 / 用途 / 设备），`Runtime.note` 记进来的带 `purpose: "note"`；和 `kctx` 一样**发给模型前去掉**。
  列表按 key 认来源（`sourceOf`：`:main` 主会话、`:heartbeat` / `:cron:` / `:task:` / `:sub:` 后台），每 5 秒刷新。
  ④ **跨会话互相等待**（2026-10-24 真机日志：worker 的 heartbeat 拿着 `worker:main` 去 `sessions_send` 等 main，同时 main 那边一轮拿着 `main:main` 等 worker；
  手机设备 `device_in_main` 也走 `worker:main`，于是手机消息永远排不上）：`scope.chain` 只看得见同一条调用链，两条各自起头的链互等它看不出来。
  `Runtime.run` 记 `waitsFor`（拿着锁的会话 → 它在等的会话），发起嵌套等待前顺着走一圈，成环就立刻失败（日志 `🔁 互相等待`）；
  嵌套等待（手里拿着自己的锁去等别人）还有上限 `lockWaitMs.a2a`（90 秒），等不到就放弃——但排着的位置要等前面真完了才让出去，别让后面的插队。
  **叫停要连带后台子任务**（`RunScope.cancel`，LRN 2026-10-31，症状「叫停了她，派出去的子 agent 还在后台一直想，直到服务商 429」）：每轮有一个只在被取消时触发的信号
  （管理界面终止、设备按住取消、上一级被取消；正常结束 / 超时不触发），`sessions_spawn` / `sessions_send` 派出的运行都挂上它（`signal: scope.cancel`），嵌套运行也听上一级的。
  随发起方停掉的子任务不再 `deliverResult`（又是一轮模型调用）。子任务预算：调用次数一半、token 四分之一、总时长 `SPAWN_MAX_SECS`；同一 agent 同时最多 `MAX_RUNNING_SUBS` 个，日志 `🧵`。
  **新加任何「后台替她跑一轮」的入口都要传 `signal: scope.cancel`**。
  管理界面总览的「正在运行」卡片（`Runtime.activeRuns` / `cancelRun`，`/api/admin/runs`）：每个会话正在跑的那一轮、阶段 / 工具、排队数、在等谁，能手动终止。
  终止走每轮自己的 `AbortController`（调用方的 `req.signal` 也接在它上面），和取消同一条路：中止模型和工具，最多 2 秒放开会话锁。
  **手动终止的那一轮要留痕**（LRN 2026-10-30）：`info.cancelled`（管理界面「停止 / 停止并发送」、总览终止）时把用户消息 + 已经说出口的字（`spoken`，按 text_delta 攒——中止后那条没说完的消息内容是空的）
  + 「（这一轮被主人打断了，没说完）」记进历史，工具调用 / 结果不留（没配对的 toolCall 服务商会拒）；设备按住取消（`req.signal`）不留。
  会话页她在回复时也能发：消息排在页面上（`queue`，能撤回），这一轮结束按顺序发；「停止并发送」= 插到队首 + `/api/admin/runs/cancel`。
  ⑤ **压缩是分块滚动摘要**（LRN 2026-10-24，症状「压缩失败：摘要为空」连着好几轮、会话越积越大）：一次塞几万 token 给推理型模型（MiniMax-M3 等），
  输出额度被思考用完、正文为空。现在按 `COMPACT_CHUNK_TOKENS`（1.6 万）切块，「上一版摘要 + 这一块」→ 新摘要，每次 `maxTokens` 至少 `COMPACT_MAX_OUTPUT`（8192）、
  各自 `timeout_secs`；某块失败 / 为空就记下这段里用户说过的话**照样压掉**——别改回「失败就下轮重试」，那样历史只会越来越大、越来越压不动。
  **摘要输出不认顺序**（`parseCompactOutput`，LRN 2026-10-31，症状「一次压缩把整段约束清零」）：模型偶尔先写【记住】、正文为空，以前按「【记住】之前才是摘要」切 → 判空 → 兜底只剩十几句用户原话。
  现在按【摘要】/【记住】标记切段、不认顺序；【记住】段里不像「长期：…」的行也算正文；只有记住的几条就拿它们当摘要；全空再要一次（提示「务必先写【摘要】」），还空才走兜底。**别再在提示词里加「先写【记住】」之类的句子**——会提高这种概率。
  **想完了没说话**（`silentMsg` / `NUDGE_TEXT`，LRN 2026-10-31，症状「她疯狂思考，看得到一大串思考，却没有任何回复」）：推理型模型常把输出额度全花在思考上（`stopReason` = length），
  或想着想着就结束了。以前调过工具的那一轮最后只想不说，空字符串原样交出去、主人什么都收不到。现在 `execute` 里最后一条助手消息只有思考就**在同一轮里催一句**、
  `scope.noThink = true`（`chatStream` 这次按「关」发思考字段），拿到回复；催的那句（`knudge`）和前面那条空回复都不进历史。日志 `💭`。催了还不说、且没调过工具的才走下面的空回复重试。
  **写到一半被截断**（`messages.ts` 的 `truncatedMsg` / `continueText` / `mergeContinued`，借鉴 deepseek-ai/chat-demo 的「继续生成」，2026-11）：最后一条助手消息 `stopReason` = length、有正文、没调工具，
  就在同一轮里提示「从断开处接着写」（`kcont`，不让想），最多 `CONTINUE_MAX`（2）次，接上的正文并回那条消息、提示不进历史；截断的那条**不发 `message_end`**，边生成边播的句子缓冲不在半句上切开。
  调工具时截断的不接（参数写了一半）。用提示而不用「末尾助手消息当前缀」：OpenAI 兼容接口各家不一。日志 `✂️`，health `continue`。
  **空回复**（`EMPTY_RE`）：模型正常结束却一个字没说、也没调工具（上下文快满时有的服务商这样收尾）→ `execute` 抛「空回复：…」、不落盘 → `run` 在历史超过阈值一半时先压（不像超长那样压到一轮），再试一次；两次都空才报错。调过工具的不重试（会把工具再执行一遍）。
  默认值（2026-10）：压缩阈值 6 万 / 保留 30 条（不超过主模型上下文的六成）；模型没填时上下文 12.8 万、单次输出 8192。
  agent.json 里原样存着旧默认（16000 / 16）的当成没改过、跟新默认走。
  ⑦ **上下文预算**（LRN 2026-10-30，症状「compact 不生效、上下文爆了不回复 / 回复很慢、heartbeat 很费 token」）：
  以前只拿「历史」跟 `max_tokens` 比——系统提示（人设 + 记忆 + 近况）、工具定义、输出预留都没算；压缩后按条数留 30 条，一轮干活的几条大工具结果
  本身就超阈值，压了等于没压；一轮里工具调来调去中途就撑爆。现在：`execute` 先算系统提示和工具定义，阈值 = min(agent 设置, (窗口 − 系统 − 工具 − 输出预留) × 85%)；
  压缩按 token 留最近的（`KEEP_RATIO` × 阈值、至少最近一轮）；`pruneToolResults` 在 `transformContext` 里每次调模型前截短工具结果
  （之前几轮的留 `OLD_TOOL_CHARS`，这一轮单条 `TOOL_RESULT_MAX_CHARS`，总量超预算从这一轮最早的截；库里存原文）；大小一律按 `msgTokens`（含思考）×「截短后」算；
  服务商报超长（`OVERFLOW_RE`）就 `limit: 0` 狠压一次再 `execute` 一次（出错的那轮没落盘，不会重复）；回复后到了阈值七成就 `compactAfterReply` 在会话队列里后台先压（测试里 `backgroundCompact = false`）。
  上下文过半会打一行 `📏 … 系统提示 X + 工具 Y + 历史 Z`。**记忆冲刷不再单独跑**：以前压缩前用整段上下文另跑一轮（一次几万 token），
  现在摘要模型顺手输出「【记住】长期：/今天：」，经 `runtime.remember` 写进 MEMORY.md / 当天笔记（`beforeCompact` 留着但默认不接）。
  **heartbeat 不再跑在 main 会话里**：每半小时把整段主对话重发一遍太费，现在是 `<agent>:heartbeat` 小会话、只留最近 `HEARTBEAT_KEEP` 条，
  **`keepLast` 只能在用户消息处切**（LRN 2026-10-30，症状「heartbeat 一直 400」）：按条数硬切会切在工具调用和结果之间，留下孤儿 toolResult。
  另外 `repairHistory` 在发给模型前去掉没配对的工具调用 / 结果（打 `🩹`），库里不动——**任何新的「截历史」逻辑都要在一轮开头切**。

  主对话最近说了什么靠近况带上。**主动说出去的话要记进接收方会话**（`Runtime.note`）：heartbeat / 定时任务 / 待办汇报投递成功后，
  把那句话以「[heartbeat]（你主动开口…）+ 助手消息」一对记进接收方的会话——设备走 `runtime.sessionKey(agent, "device", dev)`，
  IM 走 `ChannelManager.sessionFor(target)`（`channels_sessions.json` 记着每个聊天实际用的会话，主人私聊开了 owner_main 就是 main）。
  不记的话主人在飞书回 heartbeat 的话题，她只能从近况里猜。近况按「agent + 角色 + 文字」去重，同一句不会列两次。
  ⑥ **内部小任务关思考**（`ModelRegistry.quick`，症状「压缩经常超时 / 思考把输出额度占满」）：压缩摘要、长回复压成口语都走 `quick`，
  按服务商地址自动加关思考的字段（MiniMax / DeepSeek / 智谱 → `thinking: {type: "disabled"}`，通义 → `enable_thinking: false`），经 pi-ai 的
  `samplingParams` 原样并进请求体；服务商报错里提到这个字段就去掉重试、本次运行不再发；正文里的 `<think>…</think>` 剥掉。
  `ProviderDef.no_thinking` 可手动指定字段或 `false`（不发）。
  **正常对话的思考等级**是每个模型自己的设置（`ModelDef.thinking`：空 = 服务商默认 / off / low / medium / high，管理界面模型表「思考」列），
  agent 每轮走 `ModelRegistry.chatStream`（Agent 的 `streamFn`）按 `thinkingParams` 加字段：MiniMax / 智谱只有开关，DeepSeek 加 `reasoning_effort`，
  通义加 `thinking_budget`，认不出的服务商「关」就不发（别乱发不认识的字段）。**思考在这几家都算进 max_tokens，改不了**——所以 `max_tokens` 的含义是
  「回复本身的上限」，请求时另加 `THINK_RESERVE`（默认 +4k / 低 +2k / 中 +6k / 高 +16k / 关 0），思考就挤不掉回复。
- **Agent 通信按会话看（`a2a_log.trace` / `parent`，管理界面 `#/a2a/<trace>`，LRN 2026-10-30）**：一轮对话引出的所有 a2a 调用共用一个 `RunScope.trace`
  （顶层一轮新生成，嵌套 / `lineage` 后台派出 / 子任务结果交回那一轮都经 `RunRequest.trace` 带下去），`a2aCall` = 引起这一轮的那次调用，它再发起的调用记成 `parent`。
  **新加任何「替别的会话跑一轮」的 a2a 入口都要传 `trace` 和 `a2aCall`**，否则那一步会被拆成单独一串。老记录没有 trace，各算一串（`'id' || id`）。
  **接收方一次交互一个会话、不进自己的 main**（`a2aKey` = `<接收方>:a2a:<发起方>:<trace>`，LRN 2026-10-30）：进 main 会让主人的对话里混进别的 agent 的话、每次背整段主对话、还占着 main 的锁（主人找她要排队、两边容易互等）。
  同一个 trace（主人一句话 / 一次 heartbeat 引出的整串）里来回几次都在同一个会话里接着说，下一次发起是新 trace、新会话；以前的前情由发起方写进 message，主人那边的事靠近况。`sessions_history` 默认仍看对方 main。
  头像（`common.Avatar` / `avatarUrl`）= agent 的 `device_role` 那套角色图的待机图，走 `/app/img?…&strict=1`（只认这个角色自己的目录，不退回默认角色，免得别的 agent 顶着默认角色的脸），没图显示首字。
  **会话页实时弹出**（`a2a.A2ADock`）：`LiveRun.trace` 带着这一轮的会话 id（`execute` 开头先算 `traceId`，start 事件里就有），实时过程里一出现 `sessions_send` / `sessions_spawn`
  就在输入框上方滑出这串调用的动画（**放在卡片里、别用 fixed 盖住输入框**）。对话框（`.card.chat`）整体固定高、消息区 `flex:1` 吃剩下的——**别再给消息区写 max-height**，那样内容少 / 弹面板时框会忽大忽小，每秒刷新；这一轮结束后留着，主人关了同一串就不再弹。历史轮次在 ⓘ 里有「看这一轮的 Agent 通信」（`kctx.a2a`）。
  详情页是回放：每次调用拆成「发出 / 回来」两步，按时间排，SVG 节点（每个 agent 一个，子任务会话单独一个）+ 沿弧线走的光点，下方步骤列表同步高亮，进行中的 3 秒刷新一次接着播。
- **借鉴 DeepSeek Super-agent 的几处（2026-11）**：
  ① **插话**（`Runtime.steer`）：往某会话正在跑的一轮里插一句（pi 的 steer 队列，下一次调模型前带上）；收尾时队列里还压着就 `continue` 接着跑，`info.steer = null` 之后插不进（返回 false）。
  ② **给子任务补充**（`sessions_steer`）：主会话把追加的要求直接插进还在跑的后台子任务（`A2A.subs` 记着谁派的），不用等它做完重派。
  ③ **后台命令**（`exec` 的 `background=true`、`exec_jobs`、`BgJobs`）：长命令立刻返回编号，不占着会话锁；跑完结果经 `A2A.wake`（子任务结果也走它）当新消息投回发起的会话、她决定要不要说；
  发起那一轮被叫停（`scope.cancel`）一起停，停掉的不再交回；子任务 / 待办里没有后台模式（结果没人接）。只在内存里，重启就没了。
  ④ **每轮系统备注**（`Runtime.turnNotes` / `TURN_NOTE_TAG`）：正在后台跑的子任务、后台命令附在这一轮用户消息里（同自动回忆：不进系统提示、落盘前去掉、只给可信会话）。
  ⑤ **监工**（`agent/watchdog.ts`，`runtime.watchdog: false` 关）：每分钟看跑了 8 分钟以上的轮次，最近几步交给便宜模型判「推进 / 兜圈子」，**连着两次**兜圈子才经 `haltRun` 软停（同 TurnGuard）；
  原因以 `WATCHDOG_TAG` 开头，待办见到它不再续额度。日志 `👀`，health `watchdog`。
  ⑥ **IM 连发合并**（`ChannelManager.pending`）：会话正忙时同一聊天的新消息先攒着，第一条 `whenIdle` 等她空下来，合成一轮、回复挂在最后一条上；日志 `📚`，health `im_merged`。
  ⑦ **近况编号**：有 `read_ref` 时近况每条带会话编号、末尾列编号对应的 `session:<会话>`，要前后文就去读，不往近况里多塞。
  ⑧ **链式召回**（`tools/recall.ts` 的 `read_ref`，只给可信会话）：放不下的不硬塞、留编号，她按编号读原文。压缩只打标记、原文一直在库里，所以都读得到。
  编号来源：截短的工具结果写 `ref=tool:<调用编号>`（`pruneToolResults(…, readable)`；这一轮的原文在 `scope.toolOriginals`，之前的按 `toolCallId` 查库）；
  压缩时每条对话标 `[#m<id>]`、让摘要在要点后注「（#m123）」，兜底的要点也带编号（读的时候连带前后两条，`m100-m130` 读一段）；
  `Runtime.note(…, ref)` 把 `task:` / `job:` 记进接收方会话，子任务结果带 `a2a:` 和 `session:`；`Runtime.refs` 登记前缀解析函数（system.ts），新加记进会话的系统事件就登记一个。
  编号只进会话、**别写进发给主人的话**。另有 `query` 在当前会话全部记录（含已压缩的）里搜关键词。
  **看它有没有在起作用**（LRN 2026-11-10，以前只能一个个会话翻）：每次 `read_ref` 打一行 `[recall] 📎` 并记 health `recall`（ok = 找到了，`detail.type` = tool / msg / range / session / query / task…）；
  压缩的 health / 会话事件带 `refs`（摘要里注了几处 `#m`，0 = 摘要模型没照做，打一行 `ℹ️`）。`health.summary` 每天一份 `recall`（reads / miss / types / compacts / cited），
  总览「运行状况」卡片显示「翻原文：今天 N 次…，压缩 X 次里 Y 次摘要带了出处」；找到了的不进异常列表。顺利的压缩不再计进「压缩有段没总结成」。
- **用户消息发出去前合成一段**（`runtime.flattenUser`，Agent 的 `convertToLlm`，LRN 2026-11-07，症状「她说正文消息是空的，然后从记忆里找到了我发的话」）：
  一轮的用户消息是几段拼的（`[时间…]`、自动回忆、系统备注、主人的话），按多段格式发出去，有的兼容 OpenAI 的服务商只认第一段（只看到时间）、有的首尾直接粘起来（主人的话贴在记忆最后一条后面）。
  现在发之前合成一段、空行隔开，有回忆 / 备注时在主人的话前面加 `MSG_DIVIDER`；库里照旧分段（`stripRecall` 靠分段去掉回忆 / 备注）。**新加附在用户消息里的系统块也放在主人的话前面**。
  `test/wire.test.ts` 用本地假服务商看真实请求体；假模型（`models.ts` 的 fakeStream）按分隔句 / 时间行认出主人的话。
- **系统提示瘦身（LRN 2026-11-13，症状「系统提示上万 token」）**：
  ① **今昨笔记只带最近的**（`soul.recentNotes`）：从最新一条往回数到 `BUDGETS.daily`（默认 8000 → 1500 字）为止——以前两天全文、超了从末尾截（`clip` 留开头），越新的越看不到。
  聊天等场景不带后台流水：`memory_write` 在 heartbeat / 定时任务 / 待办里写每日笔记时带标记（`BG_NOTE_TAGS`，`- 09:30 [heartbeat] …`；后台会话压缩记下的「今天：」也带），老笔记按「时刻后紧跟 heartbeat」认；heartbeat 场景照带（它要看自己刚做过什么）。
  没带的在末尾说明还有几条、用 memory_get 读。ⓘ 里显示带了多少 / 两天共多少（`trace.dailyTotal`）。
  ② **近况上限** 4000 → 2000 字（`prompt_budgets` 里显式设过的照旧）。
  ③ **工具按需加载**（`agent/toolgroups.ts`，`runtime.lazy_tools: false` 关；假服务商模式默认关——契约测试的脚本直接调管理类工具）：45 个工具的定义约 5300 token，
  用得少的分五组收着（`TOOL_GROUPS`：cron 管理 / 定时拍照 / 其他 agent 与子任务 / 扩展 / 待办与记忆管理），系统提示里只留 `<more_tools>` 目录，她调 `tools_load` 才摆出来，实测工具定义 5263 → 3397、目录 +200。
  **常用的不收**：cron_add（建提醒）、sessions_send、task_add、exec、文件工具、记忆、read_ref、联网、take_photo / set_volume——设备语音对话多一次往返比多几百 token 贵。待办 / 子任务（干活的场景）全给。
  加载在同一轮生效：`pi.prepareNextTurnWithContext` 换 `context.tools`（同时写回 `pi.state.tools`），库自己把新增的工具告诉模型（OpenAI / Anthropic 格式都验过，`test/slim.test.ts` 看真实请求体）；
  加载过的组记在 `Runtime.loadedGroups`（按会话，闲置 6 小时收回，只在内存）。**没加载就直接调**（照着历史里以前的调用）会先得到 not found，系统替她加载好并插一句让她重调（`knote`，不进历史）。
  新加内置工具时想一下它属于哪一类：聊天里随口会用到的留在外面，管理类的进某个组；被系统按名字认的（响应头、a2a 实时面板）别收。`allToolNames` 带每个工具的 `tokens`。
  **MCP 服务器也按需加载**（2026-11，接浏览器这类二十多个工具的服务器时）：一个服务器一组 `mcp_<名字>`，组信息由工具自己带着（`lazyGroup`：id / label / hint / lazy，`mcp.ts` 的 `tools()` 加；`guard.wrap` 复制自有属性所以带得过去）。
  默认按大小定：这组定义加起来超过 `AUTO_LAZY_TOKENS`（800）才收，三五个小工具的照常摆着；服务器配置 `"lazy": true / false` 指定，pi 配置的 `exposure: "deferred"` 等同 true。
  目录里自带组只写一行（`description` / 服务器 instructions 首行 + 共几个 + 前 12 个名字去前缀），**别把定义摊进目录**。组的归属一轮一算，**问 `LazyTools.groupOf`（实例方法），别用模块里那个只认内置组的 `groupOf`**；
  `tools_load` 认组名、也认只写服务器名 / 里面某个工具名。别的来源（扩展）想整组收着，给工具加同样的 `lazyGroup` 就行。管理界面 MCP 表显示每个服务器的 `tokens` / `lazy`。
- **运行状况（`agent/health.ts`，管理界面总览「运行状况」卡片 +「日志」页，LRN 2026-10-31，症状「出了问题只能翻一个大日志文件，也说不清最常出的是哪种」）**：
  每一轮（`Runtime.run` 外层）记成功 / 失败（`errorClass` 归类：限流 429、服务商出错、网络、超时、空回复、上下文超长、单轮上限、Key / 额度、被取消、其它）和用时，
  兜底动作各记一条（`empty_retry` / `nudge` / `overflow` / `guard` / `compact` / `compact_failed` / `voice` / `push_failed` / `sub_cancelled` / `unclean_exit`），存 system.sqlite 的 `health_events`，留 30 天。
  `/api/admin/health`（按天汇总 + 最近异常）、`/api/admin/logs`（读 kagura.log 末尾，关键词 / 只看问题）。失败的轮次日志里打 `❌`。**新加兜底 / 降级逻辑时顺手 `health.record` 一条**，不然首页看不出来它在起作用。
