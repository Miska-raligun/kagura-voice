# 人设、记忆、近况、待办

> 踩坑记录（LRN），从 CLAUDE.md 按子系统拆出来的。改系统提示组装、人设文件、记忆读写与整理、近况、待办队列、工作目录之前先读这份；新踩的坑也记在这里（写清症状、原因、别改坏的点）。

- **人设文件按场景加载（`soul.ts` 的 `LOADOUT` / `sceneOf`，LRN 2026-10-27，症状「群聊陌生人的上下文里有主人的 USER / MEMORY / 笔记」「干活也背着整篇人设」）**：
  场景 = owner（主人对话）/ guest（不可信：群聊、陌生人，**不管 purpose 一律算它**）/ heartbeat / cron / task / sub / a2a，每个场景一组文件（含 HEARTBEAT.md、daily=今昨笔记），
  `config.json` 的 `prompt_files` 可改（管理界面 Agents → 人设文件 →「加载场景」）。**guest 永远拿不到 `PRIVATE_FILES`（USER / MEMORY / daily）**，配置也加不上；
  记忆工具（memory_search / get / write）也只给可信会话——陌生人既能套话、也能往记忆里塞东西。没加载的文件在 `<not_loaded>` 里点名（guest 不提），
  `memory_get` 能读所有人设文件。HEARTBEAT.md 现在走场景表，别再在 scheduler 里用 extraSystem 另塞一遍。加载的文件仍是整篇注入（每个上限 `BUDGETS`）。
  **三种加载方式 + 长期记忆改检索**（LRN 2026-10-30，症状「AGENTS / TOOLS / MEMORY 全量注入，上下文大头」）：每格是全文 `X.md` / 目录 `X.md:toc`（`tocOf`：只放各节标题和行号，用到时 memory_get 读那节；`TOC_FILES` 才能选）/ 不加载。
  默认 TOOLS 在主人对话 / 定时任务 / agent 间只放目录（待办、子任务要干活，给全文）。**MEMORY.md 只有 heartbeat 带全文**，其它场景由 `Runtime.recallFor` 每轮拿主人这句话检索（`MemoryIndex.recall`：
  先从这句话里抠掉常用词（`STOP_TERMS`）再切两字词、再去掉在记忆里到处都是的（出现在超过 15% 的块里）；中 2 个，或中 1 个很少见的（≤2 块），或向量 ≥0.5；最多 5 条 / 1200 字；**清单每一项单独成块**（`chunkMarkdown`，改切块要加 `CHUNKER_VERSION`，旧索引自动重建），**只检索 MEMORY.md**——每日笔记记的是当时的事，混进来模型分不清哪天、会当成现在（LRN 2026-10-30），旧笔记由 agent 自己 memory_search；最多等 `RECALL_WAIT_MS`），以 `RECALL_TAG` 开头附在**这一轮用户消息**里——不进系统提示（前缀缓存），
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
  ① **按词切**（`recallTerms`，Node 自带 `Intl.Segmenter("zh")`）：两字滑切会切出「人今」这种跨词假词。词典里没有的名字（团子、神乐）被切成单字，连着的单字取相邻两字（三个字的整个也取），
  `FUNC_CHARS`（的了吗…）处断开；拼出来的假词在记忆里搜不到，被出现频率那道筛掉。三个字以上的词算两个命中（以前两字滑切时「乌龙茶」本来就是两个）。没有分词器的运行环境退回两字滑切。
  FTS 索引本身没动（仍是逐字切 + 两字短语查询），只是「算不算相关」的判断改了。
  ② **借前文**：这句话自己有信息量的词不到 2 个（「那它几岁了」）时，把上一句主人的话 + 她的回答（`runtime.ts` 里从 history 取）一起检索；够了就不借，免得前文的话题混进来。
  ③ **别称**：记忆整理（`tidy.ts` 的 PROMPT 第 6 条）给 MEMORY.md 的条目补「〔又：…〕」——主人以后多半换个说法问（记的是「妈妈」，问的是「老妈」）。它就写在条目里，检索、阅读都看得到；别把它当噪声删掉。
  ④ **名次合并（RRF）**：以前 0.4×关键词 + 0.6×向量，两边分数没有可比性。现在两路各排名次后合并；向量是否「够相关」看 `vecZ`（比这次查询在全部记忆上的平均余弦高几个标准差，≥ 2.5 且余弦 ≥ 0.3），
  不同嵌入模型余弦普遍偏高 / 偏低时也稳；记忆少于 8 块时 `vecZ` 没意义，退回绝对值 0.5。
  ⑤ **使用反馈**（`mem_recall` 表，按条目内容的哈希记）：每次附上记 `recalled`；回复里出现了这条记忆里、主人这句话没提到的词记 `used`（`noteUsed`，判得粗）。
  附了 `STALE_RECALLS`（6）次一次都没用上的，之后要多中一个词（或向量也强）才附——只降权，不删。改了条目的字就是新的一条，计数从零开始。
  ⑥ **评测**（`recall_eval.json`，在 agent 目录、进导出的「记忆」项；`GET/PUT /api/admin/agents/<id>/recall-eval`、`POST …/run`）：用例 = 一句话（+ 前文）→ 应该附上的记忆原文片段（空 = 不该附）；
  跑出「该附的附上了多少 / 不该附的有多少没乱附」。候选（`mineCandidates`）从最近的会话里挖：主人说了一句，她这一轮自己调了 memory_search / memory_get——多半是自动回忆漏了。
