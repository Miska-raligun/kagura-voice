# 人设、记忆、近况、待办

> 踩坑记录（LRN），从 CLAUDE.md 按子系统拆出来的。改系统提示组装、人设文件、记忆读写与整理、近况、待办队列、工作目录之前先读这份；新踩的坑也记在这里（写清症状、原因、别改坏的点）。

- **人设文件按场景加载（`soul.ts` 的 `LOADOUT` / `sceneOf`，LRN 2026-10-27，症状「群聊陌生人的上下文里有主人的 USER / MEMORY / 笔记」「干活也背着整篇人设」）**：
  场景 = owner（主人对话）/ guest（不可信：群聊、陌生人，**不管 purpose 一律算它**）/ heartbeat / cron / task / sub / a2a，每个场景一组文件（含 HEARTBEAT.md、daily=今昨笔记），
  `config.json` 的 `prompt_files` 可改（管理界面 Agents → 人设文件 →「加载场景」）。**guest 永远拿不到 `PRIVATE_FILES`（USER / MEMORY / daily）**，配置也加不上；
  记忆工具（memory_search / get / write）也只给可信会话——陌生人既能套话、也能往记忆里塞东西。没加载的文件在 `<not_loaded>` 里点名（guest 不提），
  `memory_get` 能读所有人设文件。HEARTBEAT.md 现在走场景表，别再在 scheduler 里用 extraSystem 另塞一遍。加载的文件仍是整篇注入（每个上限 `BUDGETS`）。
  **三种加载方式 + 长期记忆改检索**（LRN 2026-10-30，症状「AGENTS / TOOLS / MEMORY 全量注入，上下文大头」）：每格是全文 `X.md` / 目录 `X.md:toc`（`tocOf`：只放各节标题和行号，用到时 memory_get 读那节；`TOC_FILES` 才能选）/ 不加载。
  默认 TOOLS 在主人对话 / 定时任务 / agent 间只放目录（待办、子任务要干活，给全文）。**MEMORY.md 只有 heartbeat 带全文**，其它场景由 `Runtime.recallFor` 每轮拿主人这句话检索（`MemoryIndex.recall`：
  先从这句话里抠掉常用词（`STOP_TERMS`）再切两字词、再去掉在记忆里到处都是的（出现在超过 15% 的块里）；中 2 个，或中 1 个很少见的（≤2 块），或向量 ≥0.5；最多 5 条 / 1200 字；**清单每一项单独成块**（`chunkMarkdown`，改切块要加 `CHUNKER_VERSION`，旧索引自动重建），**主检索只看 MEMORY.md + 主题页**——每日笔记记的是当时的事，混进来模型分不清哪天、会当成现在（LRN 2026-10-30）；每日笔记另走一路 `recallDaily`（见下面「每日笔记也用起来」），**每条必须标上日期**；最多等 `RECALL_WAIT_MS`），以 `RECALL_TAG` 开头附在**这一轮用户消息**里——不进系统提示（前缀缓存），
  落盘前 `stripRecall` 去掉。关于主人本人的稳定信息走常驻的 USER.md：压缩摘要的「【记住】主人：」和 `memory_write target=user` 追加到 USER.md 末尾 `USER_AUTO_HEAD` 那节，
  去重、上限 `USER_AUTO_MAX`，满了改记 MEMORY.md 并打日志，不碰手写部分。**USER.md 只放主人本人的稳定个人信息**（LRN 2026-10-30，症状「什么都往 USER.md 写」：MEMORY.md 不常驻后，模型觉得写进 USER 才「看得见」）：memory_write 默认 / 拿不准用 long、user 排最后且列明「不是 user」的；压缩摘要大多写「长期：」；单条超过 `USER_ITEM_MAX`（80 字）的改记 MEMORY.md。**改记别处时工具结果要说清原因**（超长 / 自动记录满了，LRN 2026-11-07，症状「她说 memory_write 说写 USER.md、结果落到 MEMORY.md，工具说一套做一套」：以前只回「已记到 MEMORY.md」）。**long 不收流水**（`looksLikeLog`，LRN 2026-11-01，症状「heartbeat / 定时任务把『22:14 heartbeat…』写进 MEMORY.md，之后每轮被自动回忆出来」）：上一条把默认改成 long 矫枉过正，现在 memory_write 拿不准用 daily、判据是「过几天再读到还成立吗」；`write("long")` 遇到时刻 / 日期 / 「今天、刚才」开头（「今天起」除外）的改记当天笔记并告诉她；开头的「- 」去掉（以前写出「- - …」），多行用「；」接。旧版整表保存过的默认（`OLD_DEFAULT`）当没改过、跟新默认走。
- **共享人设与系统守则（`agent/persona.ts`、`soul.toolGuide`，LRN 2026-10-30，症状「每个 agent 七个人设文件维护太累；加了新机制要一个个去补 AGENTS.md」）**：
  USER / AGENTS / TOOLS 全家一份，在 `<数据目录>/shared_persona/`（导出项 `shared`）；agent 自己的同名文件只写补充，`personaText` = 共享 + 自己多出来的行（和共享重复的行、只剩标题 / 括号说明的都去掉）。
  **读这三个文件一律走 `personaText`**（系统提示、`memory_get`、`registry.readFile`），别再直接读 `workspace/USER.md`；`memory_write target=user` 写进共享的 USER.md。新建 agent 不再建这三份。
  SOUL / IDENTITY / HEARTBEAT / MEMORY 仍每个 agent 一份。管理界面「人设文件」：共享 / 只对这个 agent 的补充两栏，「挪进共享」「恢复默认」「所有 agent 一起恢复」（都先备份到 `.persona-backup-<时间>/`，MEMORY.md 不给恢复）。
  **工具和系统机制「什么时候用哪个」由系统写**：`toolGuide(这一轮的工具名)` → `<how_to>`，只写手上有的工具；新加机制改这里，所有 agent 自动跟上，**别再往 AGENTS.md 模板里加工具守则**。
- **近况（`Runtime.recentActivity`，LRN 2026-10-26，症状「heartbeat / 主动聊天老问已经说过的事；换个 agent 又问一遍」）**：
  每个会话只看得见自己的历史——飞书私聊（没开 owner_main 时）、网页聊天、独立定时任务、别的 agent 各说各的，跨会话以前只能靠 agent 自己写记忆文件。
  现在每轮（只给可信会话、不给子任务 / 记忆冲刷）从库里摘最近 `RECENT_HOURS`（48）小时、**别处**跟主人的往来：本 agent 的其它会话 + 其他 agent 的，
  按时间排、每条截 160 字、总量 `BUDGETS.recent`（2000 字，`prompt_budgets.recent` 可调，0 = 关），作为 `<recent_activity>` 放进系统提示，明说「说过的别再问、别再重复」。
  只摘「主人参与的会话」：`sessions.owner`（可信的一轮跑过就标上）或主会话 / 设备 / 网页；**陌生人、群聊的对话不混进来，不可信会话也拿不到近况**——别放宽，
  否则就是把主人的事讲给路人听。heartbeat 们的「用户消息」（`[heartbeat]` / `[定时任务` 等）不算主人说的话。零额外模型调用。
- **待办必须写状态行才算完成**（`tasks.ts` 的 `verdictOf` / `MAX_ROUNDS`，LRN 2026-10-30，症状「报了已完成实际没做完」）：模型说一句「接下来我改 X」就结束本轮、
  输出到上限被截断（`RunResult.stopReason === "length"`）、工具报错了却说搞定了，以前一律记 done。现在最后必须单独一行「状态：完成 / 没做完：… / 需要主人：…」，
  没写或被截断就在同一会话里用 `CONTINUE_PROMPT` 催，最多 `MAX_ROUNDS` 轮、总时长不超过单件上限；只有「完成」是 done，其余 `partial`（汇报照实说「没做完：…」），
  `requeue` 对 partial 默认 `resume`（接着原会话，提示词「[继续待办…]」），否则 `host.reset` 清会话从头来。状态行不进汇报正文。
  **额度用完接着做**（`MAX_GUARD_CONTINUES`，LRN 2026-11-01，症状「待办做到一半单轮 token 触顶就停了、标成没做完」）：每次 `host.run` 是新的一轮、各有一份单轮上限；被叫停（`RunResult.guard`，或强制中止的 `GUARD_STOP` 报错）且没做完，就在同一会话里换一轮新额度接着做（`GUARD_CONTINUE_PROMPT`），最多续 2 轮，仍受单件总时长限制。日志 `🔋`。
- **待办 / 延迟执行（`agent/tasks.ts` `TaskQueue`、工具 `tools/tasks.ts`、管理界面「待办」，LRN 2026-10-27）**：白天遇到改代码这类大而不急的活，
  agent 用 `task_add` 记下（只在可信会话里有；执行待办的那一轮、子任务里没有），夜间静默时段（默认 01:00-06:00）一件件做，订阅制额度白天留给对话。
  存 system.sqlite 的 `tasks` / `task_settings`。别改坏的点：① **一次只做一件**（`running`），做完 `setImmediate` 接着看下一件——按真实时钟判断时段，测试里要自己逐个 `tick(t)`；
  ② `run_at` 空 = 等静默时段，有值 = 到点就做（不看时段），管理界面「立即执行」= 把 `run_at` 设成现在；③ 执行用全新上下文 `<agent>:task:<id>`、
  `purpose: "task"`、`maxSecs` = 单件上限（`RunRequest.maxSecs` 覆盖全局 max_secs），提示词里明说「主人不在旁边、不可撤回的事别做、最后写汇报」；
  ④ **做完不马上说**：`canReport` = 不在静默时段且过了 `report_at`（默认 08:00），同一来源合成一条，送没送出去都标 `reported`（别每分钟重试）；
  来源是网页 / 管理界面的按 agent 的 heartbeat 投递目标送；⑤ 重启时 `running` 的回到排队，被打断两次算失败。`[待办` 开头的用户消息不算主人说的话（`NOT_OWNER`）。
  `/api/admin/runs` 是「正在运行」，定时任务的运行记录在 `/api/admin/job-runs`（rc.18 起两者同路径、后者一直被盖住，会话页「定时任务消息」是空的）。
- **agent 工作目录可自定义**（`agent.json` 的 `workspace_dir`，`registry.resolveWorkspace`，LRN 2026-10-26）：绝对路径或 `~/…`，空 = `agents/<id>/workspace`。
  人设、记忆、技能、扩展、exec 默认目录都跟着走，`agent.json` / `agent.sqlite` 始终在数据目录。一律用 `AgentInfo.workspace`，**别再自己拼 `agents/<id>/workspace`**。
  改目录：新目录空的就整个复制过去、有东西（如 OpenClaw 工作区）就原样用只补缺的人设，旧目录不删；不能包住数据目录、不能和别的 agent 重叠；
  改完要 `memories.forget`（索引按旧目录建的）。目录用不了（移动盘没插）就退回默认目录并带 `workspace_error`，别让整个 agent 加载失败。
  导出包里一律按默认布局记，读写经 `backup.realPath` 换成本机真实目录；导入时 `workspace_dir` 是本机的事：本机有就保留、没有就删掉用默认。
- **记忆整理（`server/src/agent/tidy.ts`，LRN 2026-11-10，症状「USER.md 自动记录满了、MEMORY.md 过时 / 重复 / 流水越积越多，旧信息被当成现在的事实」）**：
  每 `memory_tidy.every_days`（默认 7，0 = 不自动）天、在待办的静默时段、她没在跑的时候，用这个 agent 自己的主模型（`quick(…, {think})`）读 USER.md 自动记录 + MEMORY.md，输出 JSON（user / memory_md / removed / summary）。
  别改坏的点：① USER.md `USER_AUTO_HEAD` 之前的手写部分一字不动；② 写之前备份（`.persona-backup-<时间>/`），删掉的追加进 `MEMORY.archive.md`（不注入、不检索）；
  ③ 整理后条目总字数不到原来 `MIN_KEEP`（40%）、输出不是 JSON、被截断（`length`）一律不写；USER 里超过 `USER_ITEM_MAX` 或总量超 `USER_AUTO_MAX` 的放回 MEMORY；MEMORY.md 超 `TIDY_MAX_CHARS` 不整理。
  **守则文件一起整理**（`DOC_FILES` = AGENTS / TOOLS / HEARTBEAT；SOUL / IDENTITY 是主人写的设定，不动）：一份文件一次调用，输出 `<file>` / `<removed>` / `<summary>`（长 Markdown 塞 JSON 容易坏）。
  有共享人设时共享那份和 agent 自己的补充各整理各的，补充拿共享那份 + 系统自动给的用法（`host.guide` = `toolGuide`）当参考、重复的去掉。
  内容不到 `DOC_MIN_CHARS`（150，模板那几行）不看；**自动整理时上次整理后没变过的不看**（`docHash`，按路径记 sha1，所以共享那份一晚只整理一次），手动 / 她自己叫的都看；
  整理后不到原来 `DOC_MIN_KEEP`（50%，按真正多出来的部分算）不写；删掉的进同目录 `PERSONA.archive.md`。结果在 `TidyResult.docs`，`memStatus` 是记忆那部分，`status` 是整趟的。
  自动整理的结果按 heartbeat 投递目标告诉主人（同待办汇报），没做成的第二天再试；状态 `memory_tidy.json`（`{agents, docs}`）。入口：她的 `memory_tidy` 工具（`scope` = all / memory / docs，可信、非子任务）、
  管理界面人设文件页 MEMORY / USER 的「整理记忆」、AGENTS / TOOLS / HEARTBEAT 的「整理守则」（`POST /api/admin/agents/<id>/memory-tidy {scope}`）。日志 `🧹`，health `memory_tidy`。
- **自动回忆的检索（`memory.ts` 的 `recallTerms` / `recall` / `search`、`recall-eval.ts`，2026-11）**：六处改动，改之前先在「记忆」页的评测里跑一遍记下分数。
  ① **按词切 + 两字组合**（`recallTerms`，Node 自带 `Intl.Segmenter("zh")`）：分出来的词照收，再补相邻两字——只拦「上一个多字词的尾 + 下一个多字词的头」（「主人｜今天」→「人今」）和带虚词（`FUNC_CHARS`）的。
  光靠分词不够：它会切错（「哪天生日」→「天生｜日」，「生日」就丢了），两字组合能补回来；拼出来的假词在记忆里搜不到，被出现频率那道筛掉。三个字以上的词算两个命中（以前两字滑切时「乌龙茶」本来就是两个）。没有分词器的运行环境退回两字滑切。
  FTS 索引本身没动（仍是逐字切 + 两字短语查询），只是「算不算相关」的判断改了。
  ② **借前文**：这句话自己有信息量的词不到 2 个（「那它几岁了」）时，把上一句主人的话 + 她的回答（`runtime.ts` 里从 history 取）一起检索；够了就不借，免得前文的话题混进来。
  ③ **别称**：记忆整理（`tidy.ts` 的 PROMPT 第 6 条）给 MEMORY.md 的条目补「〔又：…〕」——主人以后多半换个说法问（记的是「妈妈」，问的是「老妈」）。它就写在条目里，检索、阅读都看得到；别把它当噪声删掉。
  ④ **名次合并（RRF）**：以前 0.4×关键词 + 0.6×向量，两边分数没有可比性。现在两路各排名次后合并；向量是否「够相关」看 `vecZ`（比这次查询在全部记忆上的平均余弦高几个标准差，≥ 2.5 且余弦 ≥ 0.3），
  不同嵌入模型余弦普遍偏高 / 偏低时也稳；记忆少于 8 块时 `vecZ` 没意义，退回绝对值 0.5。
  ⑤ **使用反馈**（`mem_recall` 表，按条目内容的哈希记）：每次附上记 `recalled`；回复里出现了这条记忆里、主人这句话没提到的词记 `used`（`noteUsed`，判得粗）。
  附了 `STALE_RECALLS`（6）次一次都没用上的，之后要多中一个词（或向量也强）才附——只降权，不删。改了条目的字就是新的一条，计数从零开始。
  ⑥ **评测**（`recall_eval.json`，在 agent 目录、进导出的「记忆」项；`GET/PUT /api/admin/agents/<id>/recall-eval`、`POST …/run`）：用例 = 一句话（+ 前文）→ 应该附上的记忆原文片段（空 = 不该附）；
  跑出「该附的附上了多少 / 不该附的有多少没乱附」。候选（`mineCandidates`）从最近的会话里挖：主人说了一句，她这一轮自己调了 memory_search / memory_get——多半是自动回忆漏了。
- **借鉴 Anthropic「The components of agent memory」（2026-11，`memfmt.ts`、`tidy.ts`、`tools/memory.ts`、`tools/recall.ts`）**：文章把记忆分成对话原文 → 当场记的笔记 → 离线整理出的主题页 → 每轮常驻的一小块，
  离线整理（「做梦」）拿原文核对笔记。对应到我们：
  ① **出处**：MEMORY.md / 主题页的条目末尾 `<!-- 出处 m120；主人说的 -->`（`provTag` / `provOf` / `stripProv`）。`memory_write` 带这个会话最后一条的编号（这一轮还没落盘，`read_ref` 读它会连带后两条）和 `how`；
  压缩挑出的带那段对话的范围 `m12-m80`。USER.md、每日笔记不带。自动回忆附在消息里时换成简短的「（#m120）」，只是推测的写「（推测，主人没确认过；#m120）」（`provShort`）。**任何拿条目文字去比、去检索的地方先 `stripProv`**（FTS、向量、自动回忆、使用统计、系统提示都是），不然编号会被当成词。
  ② **整理时对照原文核对**：有出处的条目（先常用的、再新的，一次最多 `VERIFY_MAX`）经 `host.sources` 取原文节选（只挑沾边的几句，900 字内）交给模型，记错的照原文改（`corrected`）、只是推测的标「推测」；
  核对过的出处 `VERIFY_DAYS`（30）天内不再核对（`memory_tidy.json` 的 `verified`）。
  ③ **只讲目的**：`memory_write` 和守则里只说记忆是干什么用的（偏好、约定、试过的做法、查证过的结论、没做完的事；随时查得到的不记）。文章的数据：给强模型加「只记失败」这类固定规则，提升掉了 0.15~0.23。
  写到哪、流水改记当天笔记、字数这些兜底留在 `memory.write` 里——**别再往说明里加「怎么记」的规则**。
  ④ **常用**：MEMORY.md 开头 `## 常用` 那节每轮进系统提示（`pinnedOf`，上限 `PINNED_MAX` 字 / 8 条，`capPinned` 把多的挪回下面），自动回忆不再重复附它。由整理按使用统计（`usageByText`：附上了、也用上了）挪进挪出；关于主人本人的进 USER.md 不进这里。
  它不经检索，所以每轮在提示里带着它时也记一次「附上」、回复里用上了记「用上」（`recallUsed` 的 `pinned`），不然攒不到统计、整理判断不了它还用不用得着。哪个场景配成整篇加载 MEMORY.md（`prompt_files`，默认只有 heartbeat，可改），就在那个场景去掉出处注释（`soul.ts`）；
  「常用」节在没整篇加载的场景（不加载 / 只放目录）都带着。**别按场景名写死**，一律看 `loadMode(scene, "MEMORY.md")`。
  ⑤ **主题页** `topics/<主题>.md`：MEMORY.md 加主题页超过 `TOPIC_SPLIT_CHARS` 时，同一件事 5 条以上由整理挪过去、MEMORY.md 留一行索引。自动回忆、memory_search、memory_get、导出都认。
  文章提醒主题页会越长越大（比原文还大 1.77 倍）：整理后总字数超过原来 `MAX_GROW`（1.3 倍）+ 200 字就不写。
  **比字数时不算出处注释和别称**（`stripAlias`）：老版本升上来的记忆第一次整理会给每条补「〔又：…〕」，条目短的一下多三四成，算进去就每周都被判成「变多了」、永远整理不成。
  ⑥ **整理期间的并发**：整理要一两分钟，这期间 `memory_write` 可能追加、主人可能在管理界面改。写回前重读：原条目都在、只多了新的 → 接到结果后面；原条目被删 / 改、手写部分或主题页变了 → 不写，下次再整理。
  ⑦ **跨会话搜原文**：`read_ref` 的 `all_sessions=true`（`store.searchOwner`）在主人参与的会话里搜（同近况的口径：`owner = 1`、主会话、设备、网页），**群聊 / 陌生人的对话不给翻**。
- **整理记忆是「按编号改」，不是整份重写（`tidy-ops.ts`，2026-11，主人「记忆文件 2.9 万字，点整理记忆会失败吗；而且看不到进度」）**：以前让模型把整份 MEMORY.md 连同主题页重写一遍输出——
  3 万字的记忆输出也要 3 万 token，超过输出上限（1.6 万）被截断、超过时限（4 分钟）被掐掉，越该整理的越整理不成。现在条目带 `[编号]` 交给模型，它只输出操作
  （`delete` / `merge into` / `edit` / `correct` / `guess` / `alias` / `to_user` / `pin` / `unpin` / `topic`），**没提到的条目原样保留**，输出只和改动多少有关。
  条目超过 `TIDY_BATCH_CHARS`（1.2 万字）按节分段，一段一次调用（`batches`，同一节尽量不拆），USER.md 自动记录只在第一段整理；`TIDY_MAX_CHARS` 放到 20 万字只防失控。
  别改坏的点：① 认不得的操作、对不上的编号丢掉（`cleanOps`），别让一条写错整趟作废；② 改写 / 合并时保留原条目的出处（合并时两边的编号都留）；
  ③ **「## 常用」到下一个标题为止**：新建这一节、或者挪出来的条目 / 新主题页索引往文件末尾接时，后面没有标题就会被算进常用、每轮常驻——`applyOps` 最后统一重排，常用后面紧跟的不是标题就补「## 其它」；
  ④ 进度（`MemoryTidy.progress`，返回副本）：读取 → 对照原文核对 i/n → 等模型整理第 i/m 段 → 写入；管理界面「整理记忆」走 `background: true` 立刻返回、每 2 秒轮询 `GET /api/admin/memory-tidy` 的 `running`，结果在 `last[agent].text`。

- **长文件整理要能断点续做、自动接着做（2026-11-18，主人：「记忆整理没做成：This operation was aborted；共享的 AGENTS.md 没整理成：模型输出被截断了；HEARTBEAT.md 没整理成：This operation was aborted」——
  系统跑了一年，人设文件都几万字，大部分场景不全量加载，所以整理必须稳）**。三个原因：
  ① 一次调用按**总时长**掐（记忆 5 分钟、守则 4 分钟），推理型模型开着思考读一万多字，想得久就被掐（`This operation was aborted`），其实它一直在出 token；
  ② 守则文件还是**整份重写**再输出，几万字的 AGENTS.md 输出必然超限、被截断；③ 一段失败整趟作废，下次从头来，越大的越永远做不完。现在：
  - **一次调用按「多久没有任何输出」掐**（`ModelRegistry.quick` 的 `idleMs` → 流式拿结果、每来一个事件重新计时；`TIDY_IDLE_MS` 5 分钟——别比以前的总时限短，有的服务商思考时不往回发东西），总时长另有 `TIDY_CALL_MS`（20 分钟）兜底。
  - **守则文件也按编号改**（`tidy-ops.ts` 的 `parseDocUnits` / `applyDocOps`）：拆成块——清单一项连同缩进的续行 / 子项、编号清单的一项、一段话、一张表、一段代码各算一块，标题和空行原样留着；
    模型输出 `{ops:[delete / merge into / edit], summary}`；`edit` 丢了清单符号的补回原来的；一节里的块全删了连标题去掉（本来就空的节不动）。
    超过 `DOC_BATCH_CHARS`（8 千字）按标题分段；文件不超过 `DOC_CONTEXT_CHARS`（3 万字）时每段都附整份带编号的文件当参考（找别的节里重复的，`merge` 的 `into` 可以指向整份里任何一块），更长的只给目录。上限同记忆 `TIDY_MAX_CHARS`。
  - **一段没整理成（超时、截断、格式不对、服务商出错）→ 切半、关思考重试**（`MemoryTidy.solve`：思考是超时和截断的大头；切到 `MIN_SPLIT_CHARS` 以下还不行就关思考原样再试一次），health `tidy_retry`。
  - **断点续做**：每段做完就存进度到 `memory_tidy.json` 的 `jobs`（`mem|<agent>` / `doc|<文件路径>` → 看过的条目 / 块、拿到的操作、USER 那段做没做、核对过的出处）。
    **按内容指纹（`ukey`）存，不按编号**——停下期间她又记了新的、主人改过几条，编号会变、指纹不变；没看过的（新记的、被改过的）下次接着看，看过的不再问模型。
    **全看完了才一次落到文件上**，删太多 / 变太多的保底照旧按整份算（保底不过就作废这趟进度、下次重来）；写之前发现被改过就不写、进度留着（下次只看改过的那几条）。
    放 `JOB_TTL_DAYS`（14）天还没做完的作废。
  - **自动接着做**：`tick` 每 5 分钟看一次，有没做完的就隔 `RESUME_GAP_MS`（20 分钟）接着做（trigger = resume；自动发起的只在静默时段，手动 / 她叫的随时），不吵主人；
    连着 `RESUME_MAX`（6）次没做成就停下、告诉主人一次；主人再点（管理界面按钮显示「接着整理」）计数清零接着做。做完的结果照常告诉主人，标「接着上次没做完的」。
  - 她的 `memory_tidy` 工具最多等 `TOOL_WAIT_MS`（90 秒），等不到转后台、做完 `notify` 主人——整理现在可能很久，别一直占着会话锁。

## 每日笔记也用起来（2026-11）

症状：一件事只记在每日笔记里（她当时用 daily 记、或者 heartbeat 顺手记的），过了两天就再也想不起来——笔记只在当天和第二天进提示，自动回忆又只看 MEMORY.md，只剩她自己想到去 memory_search 这一条路。

- **自动回忆**：`MemoryIndex.recallDaily` 另看 2~`DAILY_RECALL_DAYS`（14）天前的笔记，最多 `DAILY_RECALL_K`（2）条、400 字，和主检索的结果拼在一起，
  每条前面标「（11 月 10 日的笔记）」（`system.ts` 的 `runtime.recall`）。**别把日期标签去掉**——2026-10-30 那次不让笔记进自动回忆就是因为不带日期、模型当成现在的事。
  今天 / 昨天的不看（已经整份在提示里）；`skipBg` 跳过带后台标记的流水（`BG_NOTE_RE`，heartbeat / 定时任务 / 待办写的）。
- **不从每日笔记往长期记忆里提炼**（rc.53 做过、rc.54 去掉，主人：「有很多历史记忆已经没用了；agent 本来就会判断什么该写进长期记忆，再从笔记提炼只会让长期记忆膨胀、污染长期记忆」）。
  笔记里的事靠上面这一路按需想起、带着日期，不搬进 MEMORY.md。别再加回去；真要做，也只能是主人手动触发、逐条确认。
- `read_ref daily:2026-11-10` 读那天的整份笔记（`system.ts` 的 `runtime.refs`）。
