// Agent 运行时（§5 runtime）：每轮 = 组装上下文（soul + 历史 + 摘要）→ pi Agent 跑一轮 → 工具执行 → 落盘。
//
// - 会话落 agent.sqlite，服务端重启不丢上下文
// - 每会话串行（同一会话的消息排队），全局并发上限可配（默认 4）；嵌套调用（a2a 等待对方回复）
//   不占全局名额，否则 4 个互相等待的 agent 就能把系统锁死
// - 历史超过阈值先做「记忆冲刷」再用便宜模型把较早的部分总结成摘要（§6.2）
//
// 这里只留 Runtime 类（排队、互等、一轮本身）。独立的部分在同目录：context（上下文预算）、turnguard（单轮上限）、
// messages（消息整形）、voicetap（朗读版）、live（会话页实时过程）、locks（会话锁）、compact（压缩）、recent（近况）、spoken（朗读兜底）
import path from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message } from "@earendil-works/pi-ai";
import type { AgentRegistry, AgentInfo } from "./registry.ts";
import type { ModelRegistry } from "./models.ts";
import { AgentStore } from "./store.ts";
import { buildSystemPrompt, loadMode, sceneOf, turnContext, type PromptTrace, type SessionKind } from "./soul.ts";
import { toolAllowed, guestLocked } from "./toolpolicy.ts";
import { runScope, withScope, type RunScope } from "./scope.ts";
import { health, errorClass } from "./health.ts";
import { LazyTools, LOADED_TTL_MS } from "./toolgroups.ts";
import { estimateTokens, toolTokens, msgTokens, pruneToolResults, repairHistory, DEFAULT_CONTEXT_WINDOW, OVERFLOW_RE } from "./context.ts";
import { TurnGuard, DEFAULT_MAX_TOOL_CALLS, DEFAULT_MAX_TURN_TOKENS, GUARD_STOP } from "./turnguard.ts";
import { plainOf, stripRecall, stripImages, flattenUser, silentMsg, RECALL_TAG, RECALL_WAIT_MS, TURN_NOTE_TAG, NUDGE_TEXT, EMPTY_RE } from "./messages.ts";
import { VoiceTap, voicePrompt, unvoice, stripVoice } from "./voicetap.ts";
import { LiveHub, liveMessage, type LiveRun, type LiveEvent } from "./live.ts";
import { Semaphore, SessionLocks } from "./locks.ts";
import { Compactor, COMPACT_CHUNK_TOKENS } from "./compact.ts";
import { recentActivity } from "./recent.ts";
import { spokenText } from "./spoken.ts";

// 这个文件原来把下面这些都装在一起，拆开以后从原处照样能 import 到
export * from "./context.ts";
export * from "./turnguard.ts";
export * from "./messages.ts";
export * from "./voicetap.ts";
export * from "./live.ts";
export * from "./compact.ts";
export { RECENT_HOURS } from "./recent.ts";

/** IM 渠道：消息可能来自陌生人，默认不可信（主人私聊由渠道层显式标 trusted） */
export const IM_CHANNELS = new Set(["feishu", "qq", "onebot"]);

export interface RunRequest {
  agentId: string;
  sessionKey: string;
  kind: SessionKind;
  channel: string;
  text: string;
  images?: ImageContent[];
  deviceId?: string;
  /** 消息来源（见 RunScope.origin） */
  origin?: string;
  /** 回复会被直接播报到这台设备（见 RunScope.spokenTo） */
  spokenTo?: string;
  localTime?: string;
  purpose?: string;
  /** false = 不落盘（记忆冲刷、试跑） */
  persist?: boolean;
  extraSystem?: string[];
  /** 回复会被播报到设备（定时任务投递到设备时） */
  voiceDelivery?: boolean;
  /** 在 agent 白名单之上再收窄一层 */
  toolAllow?: (name: string) => boolean;
  timeoutSecs?: number;
  /** 这一轮的总时长上限（秒），覆盖全局 max_secs（待办可以跑得比对话久） */
  maxSecs?: number;
  /** 外部取消（设备上点屏幕取消正在等的回复） */
  signal?: AbortSignal;
  /** 不在消息前附 [时间…]（a2a 转述等） */
  noTurnContext?: boolean;
  /** 覆盖 agent 的模型（heartbeat 用便宜模型） */
  model?: string;
  /** 脱离调用方运行（后台子任务）时显式带上跳数与调用链，防循环 */
  lineage?: { hop: number; chain: string[]; trusted?: boolean };
  /** a2a 会话 id 与引起这一轮的那次调用（见 RunScope.trace / a2aCall） */
  trace?: string;
  a2aCall?: number;
  /** 可信度（见 RunScope.trusted）。不传：嵌套调用沿用上层；IM 渠道默认不可信，其它渠道可信 */
  trusted?: boolean;
  /** 直接用调用方给的对象当本轮 meta（边生成边播要在运行中途读到 needPhoto/volume） */
  meta?: RunScope["meta"];
  /** 逐字输出等事件（边生成边播用） */
  onEvent?: (e: AgentStreamEvent) => void;
  /** 落盘前最后一道判断：返回 false 就不落盘（heartbeat 回 HEARTBEAT_OK 时不让它撑大历史） */
  keepIf?: (text: string) => boolean;
  /**
   * 这条回复写完会顺带在家里的设备上念（主人 IM 私聊 / 网页聊天，且按策略会播）：让她在最终回复最前面先写 <voice>朗读版</voice>，
   * 一写完就回调（不等后面的正文），正文里拆掉。没写就由调用方事后走 spoken() 兜底
   */
  onVoice?: (text: string) => void;
}

/** 给边生成边播的事件：文本增量；一条助手消息结束（带不带工具调用）；一次工具执行结束 */
export type AgentStreamEvent =
  | { type: "text"; delta: string }
  | { type: "message_end"; toolCalls: number; toolNames: string[] }
  | { type: "tool_end"; name: string }
  | { type: "tool_start"; name: string; args: unknown };

export interface RunResult {
  text: string;
  meta: RunScope["meta"];
  toolCalls: string[];
  usage: { input: number; output: number; cost: number };
  /** 最后一条回复为什么停：stop / toolUse / length（输出到了上限被截断）… */
  stopReason?: string;
  /** 她顺带写的朗读版（已经交给 onVoice 了） */
  voice?: string;
  /** 这一轮被单轮上限叫停的原因（没叫停就没有） */
  guard?: string;
}

export type ToolProvider = (scope: RunScope, agent: AgentInfo) => AgentTool<any>[];

interface RunInfo {
  purpose: string; channel: string; since: number; tool: string; stage: string; abort: () => void; cancelled: boolean;
  /** 往这一轮里插一句话（下一次调模型前带上）。这一轮已经收尾、插不进去就是 null */
  steer?: ((text: string) => void) | null;
  /** 这一轮的单轮上限（监工判定在兜圈子时经它软停） */
  guard?: TurnGuard;
}

/** 一个工具最多执行多久（工具自己不理超时、卡在网络上时的兜底；exec 自己的上限是 10 分钟） */
export const TOOL_MAX_MS = 15 * 60_000;

export class Runtime {
  private stores = new Map<string, AgentStore>();
  /** 会话锁：同一会话串行。排队太久时日志里说清楚是谁占着（以前一声不吭，看起来就是「这个 agent 不理人了」） */
  private sessions = new SessionLocks((key) => {
    const r = this.running.get(key);
    return r ? `${r.purpose}/${r.channel}，已跑 ${Math.round((Date.now() - r.since) / 1000)} 秒，${r.stage}${r.tool ? `：${r.tool}` : ""}` : "未知";
  });
  /** 压缩（compact.ts）：借这里的会话锁，跟正常轮次排同一个队 */
  private compactor = new Compactor(this, { serial: (key, fn) => this.sessions.serial(key, fn), timeoutSecs: () => this.opts.timeoutSecs });
  /** 正在跑（且手里拿着会话锁）的一轮在等哪个会话：「拿着 key 的那一轮 → 在等的会话」，查互相等待用 */
  private waitsFor = new Map<string, string>();
  /** 在别的会话里发起、要等这个会话的锁（a2a 等对方回复）最多等多久。拿着自己的锁干等别人，等久了谁都动不了 */
  lockWaitMs = { a2a: 90_000 };
  /** 压缩时每块交给摘要模型的对话量（单测可调小） */
  compactChunk = COMPACT_CHUNK_TOKENS;
  /** 每个会话正在跑的那一轮：卡住时日志里说清楚是谁占着 */
  private running = new Map<string, RunInfo>();
  private liveHub = new LiveHub();

  /**
   * 订阅一个会话的实时过程（LRN 2026-10-30，症状「网页上只有发消息的那个窗口看得到过程，切走再回来、或者飞书 / 设备触发的，只剩『回复中』」）。
   * 以前过程只沿着发消息那个请求的流推，而且只推正文和工具名。现在每轮都留一份实时记录（已完成的消息 + 正在生成的思考 / 正文 + 正在执行的工具），
   * 谁打开会话页谁订阅：先给快照，之后推增量，这一轮结束推 end（落盘的历史这时才有这一轮）。返回取消订阅。
   */
  watchLive(agentId: string, sessionKey: string, fn: (e: LiveEvent) => void): () => void { return this.liveHub.watch(`${agentId}|${sessionKey}`, fn); }


  /** 管理界面「正在运行」：每个会话正在跑的那一轮、后面排着几轮、它在等谁 */
  activeRuns() {
    const t = Date.now();
    return [...this.running.entries()].map(([key, r]) => {
      const [agent, session] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
      const w = this.waitsFor.get(key);
      return { key, agent, session, purpose: r.purpose, channel: r.channel, stage: r.stage, tool: r.tool, secs: Math.round((t - r.since) / 1000),
        queued: this.sessions.queued.get(key) ?? 0, waiting_for: w ? w.slice(w.indexOf("|") + 1) : "", cancelling: r.cancelled };
    }).sort((a, b) => b.secs - a.secs);
  }
  /** 终止某个会话正在跑的那一轮（同取消：中止模型和工具，最多再等 2 秒就放开会话锁） */
  cancelRun(key: string) {
    const r = this.running.get(key);
    if (!r) return false;
    r.cancelled = true;
    r.abort();
    console.log(`[agent] 🛑  ${key} 被手动终止（${r.purpose}/${r.channel}，${r.stage}${r.tool ? `：${r.tool}` : ""}）`);
    return true;
  }
  private sem: Semaphore;
  private providers: ToolProvider[] = [];
  /** 扩展 / 扩展包 / MCP 的工具：排在所有内置工具后面，重名时内置的赢（不管谁先注册） */
  private pluginProviders: ToolProvider[] = [];
  /** 压缩前的记忆冲刷（memory 模块注入） */
  beforeCompact: ((agent: AgentInfo, sessionKey: string) => Promise<void>) | null = null;
  /** 压缩时顺手挑出来的要记住的事（长期 → MEMORY.md，今天 → 当天笔记）。以前压缩前要用整段上下文另跑一轮「记忆冲刷」，很费 */
  remember: ((agent: AgentInfo, target: "long" | "daily" | "user", text: string, tag?: string) => void) | null = null;
  /** 自动回忆（memory 模块注入）：按这句话检索长期记忆，返回要附上的几条（「路径：内容」）。skip = 已整篇在提示里的文件 */
  recall: ((agent: AgentInfo, text: string, context?: string) => Promise<{ line: string; why: string; raw?: string }[]>) | null = null;
  /** 回复出来以后告诉记忆模块：这一轮附上的那几条（raw）用上了没有，由它自己判断、记进使用统计 */
  recallUsed: ((agent: AgentInfo, raw: string[], query: string, reply: string) => void) | null = null;
  /** 回复后在后台预先压缩（测试里关掉，免得和假模型的回复队列抢） */
  backgroundCompact = true;
  /** 工具按需加载（toolgroups.ts）：用得少的几组工具先不摆出来。false = 像以前一样全给 */
  lazyTools = true;
  /** 每个会话已经加载过的工具组（闲置 LOADED_TTL_MS 后收回） */
  private loadedGroups = new Map<string, { groups: Set<string>; at: number }>();
  private loadedFor(key: string): Set<string> {
    const e = this.loadedGroups.get(key);
    if (!e || Date.now() - e.at > LOADED_TTL_MS) { this.loadedGroups.delete(key); return new Set(); }
    e.at = Date.now();
    return new Set(e.groups);
  }
  /** 系统提示里的技能目录（skills 模块注入） */
  skillCatalog: (agent: AgentInfo) => { name: string; description: string }[] = () => [];
  /** 当前在家状态（presence 路由更新） */
  presence: () => string = () => "";

  constructor(public agents: AgentRegistry, public models: ModelRegistry, private opts: { maxConcurrency: number; timeoutSecs: number; maxSecs?: number; maxToolCalls?: number; maxTurnTokens?: number }) {
    this.sem = new Semaphore(Math.max(1, opts.maxConcurrency));
  }

  /** 管理界面改了超时：就地生效（下一轮起） */
  setLimits(l: { timeoutSecs?: number; maxSecs?: number; maxToolCalls?: number; maxTurnTokens?: number }) {
    if (l.timeoutSecs && l.timeoutSecs > 0) this.opts.timeoutSecs = l.timeoutSecs;
    if (l.maxSecs && l.maxSecs > 0) this.opts.maxSecs = l.maxSecs;
    if (l.maxToolCalls && l.maxToolCalls > 0) this.opts.maxToolCalls = l.maxToolCalls;
    if (l.maxTurnTokens !== undefined && l.maxTurnTokens >= 0) this.opts.maxTurnTokens = l.maxTurnTokens;
  }

  addTools(p: ToolProvider, opts: { plugin?: boolean } = {}) { (opts.plugin ? this.pluginProviders : this.providers).push(p); }
  private allProviders() { return [...this.providers, ...this.pluginProviders]; }
  /** 内置工具的名字（扩展里重名的会被挡掉，管理界面要标出来） */
  builtinToolNames(agent: AgentInfo): Set<string> {
    const scope: RunScope = { agentId: agent.id, sessionKey: `${agent.id}:main`, kind: "main", channel: "webchat", purpose: "list", hop: 0, chain: [], meta: {}, trusted: true };
    return new Set(this.providers.flatMap((p) => p(scope, agent)).map((t) => t.name));
  }

  store(agentId: string): AgentStore {
    let s = this.stores.get(agentId);
    if (!s) {
      const a = this.agents.get(agentId);
      if (!a) throw new Error(`没有 agent ${agentId}`);
      s = new AgentStore(path.join(a.dir, "agent.sqlite"));
      this.stores.set(agentId, s);
    }
    return s;
  }

  closeStore(agentId: string) { this.stores.get(agentId)?.close(); this.stores.delete(agentId); }
  close() { for (const id of [...this.stores.keys()]) this.closeStore(id); }

  /** 会话 key：<agent>:<channel>:<peer>；设备会话默认并入 main（单人家用） */
  sessionKey(agentId: string, channel: string, peer: string) {
    const a = this.agents.get(agentId);
    if (channel === "device" && a?.device_in_main) return `${agentId}:main`;
    return `${agentId}:${channel}:${peer}`;
  }

  /**
   * 把一句主动说的话（heartbeat、定时任务、待办汇报）记进接收方那个会话：主人在飞书 / 设备上接话时，上一句就在历史里，
   * 不用靠近况去猜（LRN 2026-10-30：heartbeat 搬出主会话以后，主人回它的话题对不上）。
   * 记成一对「[来源] 用户消息 + 助手消息」（有的服务商不接受连着两条助手消息）；排在这个会话的队里，不打断正在跑的那轮
   */
  note(agentId: string, sessionKey: string, tag: string, text: string, ref = ""): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent || !text.trim()) return Promise.resolve();
    const store = this.store(agentId);
    const t = Date.now();
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    return this.sessions.serial(`${agentId}|${sessionKey}`, async () => {
      store.touchSession(sessionKey, sessionKey.endsWith(":main") ? "main" : "chat", sessionKey.split(":")[1] ?? "system");
      store.append(sessionKey, [
        { role: "user", content: [{ type: "text", text: `[${tag}]（你主动开口，下面是你发出去的话${ref ? `；来龙去脉见 ${ref}` : ""}）` }], timestamp: t, ksrc: { channel: "system", purpose: "note", tag, ...(ref ? { ref } : {}) } } as any,
        { role: "assistant", content: [{ type: "text", text: text.trim() }], api: "openai-completions", provider: "kagura", model: "note", usage: zero, stopReason: "stop", timestamp: t } as any,
      ]);
    }).catch((e) => console.log(`[agent] ⚠️  记进会话 ${sessionKey} 失败: ${e.message}`));
  }

  /** 会话是否正有一轮在跑（调度器的 idleOnly 用） */
  busy(agentId: string, sessionKey: string) { return this.sessions.busy(`${agentId}|${sessionKey}`); }

  /** 等这个会话前面排着的都跑完（渠道合并连发消息用：等她空下来，把这期间收到的几条一起交给她） */
  async whenIdle(agentId: string, sessionKey: string): Promise<void> {
    await this.sessions.whenIdle(`${agentId}|${sessionKey}`);
  }

  /**
   * 往某个会话正在跑的那一轮里插一句话（借鉴 DeepSeek Super-agent「后续消息直达干活的那个会话」，2026-11）：
   * 她下一次调模型前就能看到，不用等这一轮做完再排队。主会话给后台子任务补充要求就走这里。
   * 返回 false = 那个会话现在没在跑（或者已经在收尾），没插进去
   */
  steer(agentId: string, sessionKey: string, text: string): boolean {
    const r = this.running.get(`${agentId}|${sessionKey}`);
    if (!r?.steer || r.cancelled) return false;
    r.steer(text);
    return true;
  }

  /** 监工判定某一轮在兜圈子：软停（之后的工具调用都返回「别再调了，汇报做到哪了」） */
  haltRun(key: string, why: string): boolean {
    const r = this.running.get(key);
    if (!r?.guard || r.guard.reason) return false;
    r.guard.halt(why);
    return true;
  }

  /** 某一轮的实时记录（监工看最近几步在干什么） */
  liveOf(key: string): LiveRun | undefined { return this.liveHub.runs.get(key); }

  /**
   * 每轮附在用户消息后面的系统备注（正在后台跑的子任务、后台命令……）。和自动回忆一样附在消息里、不进系统提示，
   * 不破坏前缀缓存；落盘前去掉（以 TURN_NOTE_TAG 开头的文本块）
   */
  turnNotes: ((scope: RunScope) => string)[] = [];

  /**
   * 编号 → 原文（链式召回，借鉴 DeepSeek Super-agent 的 Chain of Recall，2026-11）：会话里记下的东西带编号（task:… / job:… / a2a:…），
   * read_ref 按前缀交给这里登记的解析函数。消息（m…）、工具结果（tool:…）、会话（session:…）由 read_ref 自己读库。
   * 解析函数返回 null = 没有 / 没权限
   */
  refs = new Map<string, (agent: AgentInfo, id: string, scope: RunScope) => string | null>();

  /** 跑一轮（排队、互等检测、超长 / 空回复兜底），结果记进运行状况 */
  async run(req: RunRequest): Promise<RunResult> {
    const t0 = Date.now();
    const base = { agent: req.agentId, session: req.sessionKey, purpose: req.purpose ?? "chat" };
    try {
      const r = await this.runInner(req);
      health.record({ kind: "turn", ok: true, ...base, ms: Date.now() - t0 });
      return r;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const cls = errorClass(msg);
      if (cls !== "被取消") console.log(`[agent] ❌ ${req.agentId} ${req.sessionKey} 这一轮失败（${cls}，${((Date.now() - t0) / 1000).toFixed(1)}s）：${msg.slice(0, 200)}`);
      health.record({ kind: "turn", ok: false, ...base, ms: Date.now() - t0, detail: { error: cls, message: msg.slice(0, 300) } });
      throw e;
    }
  }

  private async runInner(req: RunRequest): Promise<RunResult> {
    const parent = runScope();
    const nested = !!parent;          // 在另一轮运行里发起的（a2a 等待对方回复）：发起方手里还拿着自己的会话锁
    const key = `${req.agentId}|${req.sessionKey}`;
    const from = parent ? `${parent.agentId}|${parent.sessionKey}` : "";
    if (from && from !== key) {
      // 互相等待：两条各自在跑的调用链（比如两个 agent 的 heartbeat 同时 sessions_send 对方）——调用链里看不出来，
      // 要顺着「谁拿着锁在等谁」走一圈。成环就立刻失败，否则两边都永远等下去，后面这两个会话的消息全排不上
      const mine = new Set([...parent!.chain, from]);
      const path: string[] = [];
      for (let k: string | undefined = key; k && !path.includes(k); k = this.waitsFor.get(k)) {
        path.push(k);
        if (mine.has(k)) {
          console.log(`[agent] 🔁  互相等待：${from} → ${path.join(" → ")}，拒绝这次等待`);
          throw new Error(`${req.agentId} 那边正在等你这边（互相等待会一起卡死），这次没发过去——先直接回答，或者用 wait=false 发`);
        }
      }
      this.waitsFor.set(from, key);
    }
    try {
      const res = await this.sessions.serial(key, async () => {
        if (!nested) await this.sem.acquire();
        try {
          try { return await this.execute(req); }
          catch (e: any) {
            // 服务商说上下文超长：狠狠压一次（只留最近一轮）再试一次。这一轮出错时什么都没落盘，重试不会重复
            const msg = String(e?.message ?? "");
            const empty = EMPTY_RE.test(msg);
            if (req.persist === false || !(empty || OVERFLOW_RE.test(msg))) throw e;
            const agent = this.agents.get(req.agentId);
            if (!agent) throw e;
            if (empty) {
              // 空回复多半是上下文快满了：历史超过阈值一半就先压（不像超长那样压到只剩一轮），然后再试一次
              console.log(`[agent] 🫥 ${key} ${msg}，压一压再试一次`);
              health.record({ kind: "empty_retry", ok: true, agent: req.agentId, session: req.sessionKey, purpose: req.purpose, detail: { message: msg.slice(0, 200) } });
              await this.compactor.maybeCompact(agent, this.store(agent.id), req.sessionKey, req.signal, { limit: Math.floor(agent.compaction.max_tokens / 2), trigger: "empty" });
              try { return await this.execute(req); }
              catch (e2: any) { throw EMPTY_RE.test(String(e2?.message ?? "")) ? new Error("模型连着两次返回了空回复，换个说法再试，或者在管理界面压缩一下这个会话") : e2; }
            }
            console.log(`[agent] 📏 ${key} 上下文超长（${msg.slice(0, 120)}），压缩后重试`);
            health.record({ kind: "overflow", ok: true, agent: req.agentId, session: req.sessionKey, purpose: req.purpose, detail: { message: msg.slice(0, 200) } });
            await this.compactor.maybeCompact(agent, this.store(agent.id), req.sessionKey, req.signal, { limit: 0, keepTokens: 0, trigger: "overflow" });
            return await this.execute(req);
          }
        }
        finally { if (!nested) this.sem.release(); }
      }, nested ? this.lockWaitMs.a2a : 0, nested ? `${req.agentId} 正忙（它在处理别的事），等了 ${Math.round(this.lockWaitMs.a2a / 1000)} 秒还没空，稍后再试或者用 wait=false 发` : "");
      this.compactor.afterReply(req);
      return res;
    } finally {
      if (from && this.waitsFor.get(from) === key) this.waitsFor.delete(from);
    }
  }

  /** 真正跑一轮。调用方负责串行（run 或压缩流程里的冲刷） */
  private async execute(req: RunRequest): Promise<RunResult> {
    const agent = this.agents.get(req.agentId);
    if (!agent) throw new Error(`没有 agent ${req.agentId}`);
    const store = this.store(agent.id);
    const persist = req.persist !== false;
    const lockKey = `${agent.id}|${req.sessionKey}`;
    const nestedRun = this.running.has(lockKey);          // 冲刷等内部运行：别覆盖外面那一轮的登记
    // 自己的中止信号：调用方取消（req.signal）和管理界面「终止」都走它
    const ac = new AbortController();
    const signal = ac.signal;
    // 「被取消」单独一个信号（正常结束、超时不触发）：这一轮派出去的后台子任务挂在它上面，主人叫停时一起停
    const cancelAc = new AbortController();
    const cancelAll = () => { ac.abort(); cancelAc.abort(); };
    const onOuter = () => cancelAll();
    if (req.signal?.aborted) cancelAll(); else req.signal?.addEventListener("abort", onOuter, { once: true });
    // 上一级（嵌套调用里的发起方）被取消，这一轮也停
    const parentCancel = runScope()?.cancel;
    const onParent = () => cancelAll();
    if (parentCancel?.aborted) cancelAll(); else parentCancel?.addEventListener("abort", onParent, { once: true });
    const info: RunInfo = { purpose: req.purpose ?? "chat", channel: req.channel, since: Date.now(), tool: "", stage: "准备", abort: cancelAll, cancelled: false };
    if (!nestedRun) this.running.set(lockKey, info);
    // a2a 会话 id（见 RunScope.trace）：先算出来，实时记录里也带上——会话页据此弹出这一轮的 Agent 通信实时动画
    const traceId = req.trace ?? runScope()?.trace ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const liveRun: LiveRun | null = nestedRun ? null : { purpose: info.purpose, channel: req.channel, since: info.since, messages: [], partial: { thinking: "", text: "" }, tools: [], trace: traceId };
    if (liveRun) { this.liveHub.runs.set(lockKey, liveRun); this.liveHub.emit(lockKey, { type: "start", run: liveRun }); }
    let liveError = "";
    try {
    if (persist) store.touchSession(req.sessionKey, req.kind, req.channel);
    const parent = runScope();
    const scope: RunScope = {
      agentId: agent.id, sessionKey: req.sessionKey, kind: req.kind, channel: req.channel,
      deviceId: req.deviceId, spokenTo: req.spokenTo, origin: req.origin ?? (req.channel === "device" && req.deviceId ? `device:${req.deviceId}` : parent?.origin), localTime: req.localTime, purpose: req.purpose ?? "chat",
      hop: parent ? parent.hop + (parent.agentId !== agent.id ? 1 : 0) : (req.lineage?.hop ?? 0),
      chain: [...(parent?.chain ?? req.lineage?.chain ?? []), `${agent.id}|${req.sessionKey}`],
      meta: req.meta ?? {},
      trusted: req.trusted ?? parent?.trusted ?? req.lineage?.trusted ?? !IM_CHANNELS.has(req.channel),
      trace: traceId,
      a2aCall: req.a2aCall,
      cancel: cancelAc.signal,
    };
    const model = this.models.resolve(req.model || agent.model);
    // 单轮上限（LRN 2026-10-30，症状「等她回复，她一直在 exec 兜圈子，把 token 烧光了」）：见 TurnGuard
    // 子任务（sessions_spawn 派出去的）只给一半调用次数、四分之一 token：它们在后台跑、主人看不见，还可能同时派好几个
    const factor = scope.purpose === "task" ? 3 : req.kind === "sub" ? 0.5 : 1;
    const guard = new TurnGuard(
      Math.max(5, Math.round((this.opts.maxToolCalls || DEFAULT_MAX_TOOL_CALLS) * factor)),
      this.opts.maxTurnTokens === 0 ? Infinity : (this.opts.maxTurnTokens || DEFAULT_MAX_TURN_TOKENS) * (req.kind === "sub" ? 0.25 : factor),
      `${agent.id} ${req.sessionKey}`,
    );
    info.guard = guard;
    const allTools = this.toolsFor(scope, agent, req).map((t) => guard.wrap(t));
    // 工具按需加载：聊天等场景里用得少的几组先收着（系统提示里留目录），她调 tools_load 才摆出来。干活的场景（待办、子任务）全给
    const lazy = this.lazyTools && scope.purpose !== "task" && scope.purpose !== "flush" && req.kind !== "sub"
      ? new LazyTools(allTools, this.loadedFor(lockKey), (t) => guard.wrap(t), (ids) => {
        const e = this.loadedGroups.get(lockKey) ?? { groups: new Set<string>(), at: 0 };
        for (const id of ids) e.groups.add(id);
        e.at = Date.now();
        this.loadedGroups.set(lockKey, e);
        if (this.loadedGroups.size > 500) this.loadedGroups.delete(this.loadedGroups.keys().next().value!);
        console.log(`[agent] 🧰 ${agent.id} ${req.sessionKey} 加载工具组 ${ids.join("、")}`);
      }, toolTokens) : null;
    const tools = lazy ? lazy.visible() : allTools;
    const peers = this.agents.list().filter((p) => this.agents.canContact(agent.id, p.id)).map((p) => ({ id: p.id, name: p.name }));
    if (persist && scope.trusted) store.markOwner(req.sessionKey);
    // 近况：这个会话看不到的、最近在别处跟主人说过的话。只给可信的会话（主人本人），陌生人 / 群聊不给
    const recent = scope.trusted && req.kind !== "sub" && req.purpose !== "flush" ? this.recentActivity(agent, req.sessionKey, tools.some((t) => t.name === "read_ref")) : "";
    const promptOf = (summary?: string, trace?: PromptTrace) => buildSystemPrompt({
      agent, scene: sceneOf(scope), channel: req.channel, summary, trace,
      extra: [...(req.extraSystem ?? []), lazy?.catalog() ?? "", recent, req.onVoice ? voicePrompt(agent.voice_max_chars || 80) : ""], skills: this.skillCatalog(agent), voiceDelivery: req.voiceDelivery,
      peers: tools.some((t) => t.name.startsWith("sessions_")) ? peers : [], tools: tools.map((t) => t.name),
    });
    // 上下文预算：窗口减去系统提示、工具定义、输出预留，剩下的才是历史（含摘要）能用的
    const ctxWin = model.contextWindow || DEFAULT_CONTEXT_WINDOW;
    const fixedSys = estimateTokens(promptOf(""));
    const fixedTools = estimateTokens(JSON.stringify(tools.map((t) => [t.name, t.description, t.parameters])));
    const reserve = (model.maxTokens || 8192) + 4096;
    const histBudget = Math.max(2000, ctxWin - fixedSys - fixedTools - reserve);
    const limit = Math.min(agent.compaction.max_tokens, Math.floor(histBudget * 0.85));
    this.compactor.limits.set(lockKey, limit);
    if (persist) {
      info.stage = "压缩历史";
      await this.compactor.maybeCompact(agent, store, req.sessionKey, signal, { limit });
      if (signal.aborted) throw new Error(info.cancelled ? "已在管理界面终止" : "已取消");
    }
    info.stage = "生成回复";
    // kctx 是存在助手消息上的「这一轮上下文构成」统计，只给管理界面看，别发给模型
    const history = repairHistory(store.history(req.sessionKey).map((h) => { const { kctx: _k, ksrc: _s, ...m } = h.msg as any; return m as Message; }),
      `${agent.id} ${req.sessionKey}`);
    const session = store.getSession(req.sessionKey);
    const trace: PromptTrace = { scene: sceneOf(scope), files: [], notLoaded: [], daily: 0, skills: 0, peers: 0, summary: 0 };
    const systemPrompt = promptOf(session?.summary, trace);
    const readable = tools.some((t) => t.name === "read_ref");
    const prunedHist = pruneToolResults(history, Infinity, readable);
    const histSize = estimateTokens(session?.summary ?? "") + prunedHist.reduce((n, m) => n + msgTokens(m), 0);
    const pruned = prunedHist.filter((m, i) => m !== history[i]).length;
    if (fixedSys + fixedTools + histSize > ctxWin * 0.5) {
      console.log(`[agent] 📏 ${agent.id} ${req.sessionKey} 上下文≈ 系统提示 ${fixedSys} + 工具 ${fixedTools} + 历史 ${histSize} token（窗口 ${ctxWin}，压缩阈值 ${limit}）`);
    }

    const content: any[] = [];
    if (!req.noTurnContext) content.push({ type: "text", text: turnContext(req.localTime, this.presence()) });
    if (req.images?.length) {
      if (model.input.includes("image")) content.push(...req.images);
      else content.push({ type: "text", text: "[用户发来了图片，但当前模型不支持看图，请如实告诉用户]" });
    }
    // 追问（「那个呢」）本身没有内容词：把上一句主人的话和她的回答交给检索当前文
    const lastOf = (role: string) => { for (let i = history.length - 1; i >= 0; i--) if (history[i].role === role) return plainOf(history[i]); return ""; };
    const recalled = await this.recallFor(agent, scope, req, `${lastOf("user").slice(-150)} ${lastOf("assistant").slice(0, 150)}`.trim());
    if (recalled.text) content.push({ type: "text", text: recalled.text });
    const notes = this.turnNotes.map((f) => { try { return f(scope); } catch { return ""; } }).filter(Boolean);
    if (notes.length) content.push({ type: "text", text: `${TURN_NOTE_TAG}\n${notes.join("\n")}` });
    content.push({ type: "text", text: req.text });

    const pi = new Agent({
      initialState: { systemPrompt, model, tools, messages: history as any },
      streamFn: this.models.chatStream,              // 按模型配置的思考等级加字段、给思考预留
      sessionId: `${agent.id}:${req.sessionKey}`,
      toolExecution: "sequential",
      // 每次调模型前截短工具结果，一轮里调很多次工具也撑不爆上下文（库里存的还是原文）
      // 多段的用户消息合成一段再发（见 flattenUser）
      convertToLlm: (msgs) => flattenUser((msgs as any[]).filter((m) => ["system", "user", "assistant", "toolResult"].includes(m.role))) as any,
      transformContext: async (msgs) => { try { return pruneToolResults(msgs as any[], histBudget, readable) as any; } catch { return msgs; } },
    });
    // 工具组刚加载（或者她没加载就直接调了收着的工具）：下一次调模型前换上新的工具集，库会把多出来的工具告诉模型
    if (lazy) pi.prepareNextTurnWithContext = (turn) => {
      const missed = (turn.message.content ?? []).filter((c: any) => c.type === "toolCall" && lazy.groupOf(c.name) && !lazy.loaded.has(lazy.groupOf(c.name))).map((c: any) => String(c.name));
      const auto = missed.length ? lazy.load([...new Set(missed.map((n: string) => lazy.groupOf(n)))]) : [];
      if (!lazy.dirty) return undefined;
      lazy.dirty = false;
      const next = lazy.visible();
      pi.state.tools = next;                      // 同一轮里后面再 prompt（催她说话）也用新的工具集
      return {
        context: { messages: turn.context.messages, tools: next },
        // 没加载就直接调（多半是照着以前的对话调的）：替她加载好，让她重调一次。这句不进历史
        messages: auto.length ? [{ role: "user", content: [{ type: "text", text: `[系统] ${missed.join("、")} 刚才还没加载所以没找到，现在加载好了，重新调用一次。` }], timestamp: Date.now(), knote: true } as any] : undefined,
      };
    };
    const start = pi.state.messages.length;
    // 插话（Runtime.steer）：排进 pi 的插话队列，下一次调模型前带上。收尾之后就不收了（见下面 waitForIdle 之后）
    if (!nestedRun) info.steer = (t: string) => pi.steer({ role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() } as any);
    const toolCalls: string[] = [];
    // 超时按「多久没有进展」算，不按一轮总时长：模型在出字、工具在执行都算在干活，长任务不会被半路掐掉。
    // 工具执行期间不计时（命令有自己的超时）；另有总时长上限兜底，防卡死、防死循环
    const idleMs = (req.timeoutSecs ?? this.opts.timeoutSecs) * 1000;
    const maxMs = Math.max(idleMs, (req.maxSecs ?? this.opts.maxSecs ?? 1800) * 1000);
    let timedOut: "" | "idle" | "max" | "cancel" | "budget" = "";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let toolsRunning = 0;
    // 超时后先 abort；有的工具不理会中止信号（卡在网络、扩展写得不好），给 2 秒宽限就不再等它
    let giveUp: () => void = () => {};
    const gaveUp = new Promise<void>((r) => (giveUp = r));
    const stop = (why: "idle" | "max" | "cancel" | "budget") => {
      if (timedOut) return;
      timedOut = why;
      pi.abort();
      setTimeout(giveUp, 2000).unref?.();
    };
    // 工具执行期间不按 idleMs 算（命令可以跑好几分钟），但也不能无限等：工具自己不理超时的话，最多等 toolMs
    const toolMs = Math.max(idleMs, TOOL_MAX_MS);
    let toolStuck = "";
    const kick = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = timedOut ? null
        : toolsRunning > 0 ? setTimeout(() => { toolStuck = info.tool; stop("idle"); }, toolMs)
        : setTimeout(() => stop("idle"), idleMs);
    };
    // 这一轮已经说出口的字（被打断时记进历史用；中止时那条没说完的消息内容会被清空，只能自己攒）
    let spoken = "";
    let nudged = false;
    // 朗读版：开头的 <voice>…</voice> 扣下来一写完就交出去，实时页 / 调用方 / 已说出口的字里都不带它
    const tap = req.onVoice ? new VoiceTap((v) => {
      scope.meta.voice = v;
      console.log(`[agent] 🗣️  ${agent.id} 朗读版写好了（开始这一轮后 ${((Date.now() - info.since) / 1000).toFixed(1)}s，${Array.from(v).length} 字），先拿去念`);
      health.record({ kind: "voice", ok: true, agent: agent.id, session: req.sessionKey, ms: Date.now() - info.since, detail: { via: "first" } });
      req.onVoice!(v);
    }) : null;
    pi.subscribe((e: any) => {
      const rawDelta = e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta" ? String(e.assistantMessageEvent.delta ?? "") : null;
      const textDelta = rawDelta === null ? null : tap ? tap.feed(rawDelta) : rawDelta;
      const tail = tap && e.type === "message_end" && e.message?.role === "assistant" ? tap.end() : "";
      if (textDelta) spoken += textDelta;
      if (tail) spoken += tail;
      if (e.type === "message_end" && e.message?.role === "assistant" && spoken && !spoken.endsWith("\n")) spoken += "\n";
      if (liveRun) {
        try {
          if (tail) { liveRun.partial.text += tail; this.liveHub.emit(lockKey, { type: "delta", kind: "text", delta: tail }); }
          if (e.type === "message_update") {
            const ev = e.assistantMessageEvent;
            const kind = ev?.type === "text_delta" ? "text" : ev?.type === "thinking_delta" ? "thinking" : "";
            const delta = kind === "text" ? textDelta : ev?.delta;
            if (kind && delta) { liveRun.partial[kind] += delta; this.liveHub.emit(lockKey, { type: "delta", kind, delta }); }
          } else if (e.type === "message_end" && ["user", "assistant", "toolResult"].includes(e.message?.role)) {
            const m = liveMessage(e.message);
            liveRun.messages.push(m);
            liveRun.partial = { thinking: "", text: "" };
            this.liveHub.emit(lockKey, { type: "message", message: m });
          } else if (e.type === "tool_execution_start") {
            liveRun.tools.push(e.toolName);
            this.liveHub.emit(lockKey, { type: "tool", name: e.toolName, running: true });
          } else if (e.type === "tool_execution_end") {
            const i = liveRun.tools.indexOf(e.toolName);
            if (i >= 0) liveRun.tools.splice(i, 1);
            this.liveHub.emit(lockKey, { type: "tool", name: e.toolName, running: false });
          }
        } catch { /* 实时记录出错不影响这一轮 */ }
      }
      // 这一轮的工具结果原文留在内存里：截短后 read_ref 读 tool:<编号> 从这里拿（这一轮结束才落盘）
      if (e.type === "message_end" && e.message?.role === "toolResult" && e.message.toolCallId) {
        (scope.toolOriginals ??= new Map()).set(String(e.message.toolCallId), (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"));
      }
      if (e.type === "message_end" && e.message?.role === "assistant") {
        const hasCalls = (e.message.content ?? []).some((c: any) => c.type === "toolCall");
        if (guard.afterModel(e.message.usage, hasCalls)) stop("budget");
      }
      if (e.type === "tool_execution_start") { toolCalls.push(e.toolName); toolsRunning++; info.tool = e.toolName; info.stage = "执行工具"; }
      else if (e.type === "tool_execution_end") { toolsRunning = Math.max(0, toolsRunning - 1); if (!toolsRunning) { info.tool = ""; info.stage = "生成回复"; } }
      kick();
      if (!req.onEvent) return;
      try {
        if (tail) req.onEvent({ type: "text", delta: tail });
        if (textDelta) req.onEvent({ type: "text", delta: textDelta });
        else if (e.type === "message_end" && e.message?.role === "assistant") {
          const calls = (e.message.content ?? []).filter((c: any) => c.type === "toolCall");
          req.onEvent({ type: "message_end", toolCalls: calls.length, toolNames: calls.map((c: any) => String(c.name)) });
        }
        else if (e.type === "tool_execution_end") req.onEvent({ type: "tool_end", name: e.toolName });
        else if (e.type === "tool_execution_start") req.onEvent({ type: "tool_start", name: e.toolName, args: e.args });
      } catch (err: any) { console.log(`[agent] ⚠️  onEvent 出错: ${err.message}`); }
    });

    kick();
    const hardTimer = setTimeout(() => stop("max"), maxMs);
    const onCancel = () => stop("cancel");
    if (signal.aborted) onCancel(); else signal.addEventListener("abort", onCancel, { once: true });
    try {
      const work = withScope(scope, async () => {
        await pi.prompt({ role: "user", content, timestamp: Date.now() } as any);
        await pi.waitForIdle();
        // 刚好在她说完最后一句时插进来的话：pi 已经停了、队列里还压着，接着跑一次把它处理掉
        const okEnd = () => { const m = pi.state.messages.at(-1) as any; return m?.role === "assistant" && !["error", "aborted"].includes(m.stopReason); };
        while (!timedOut && pi.hasQueuedMessages() && okEnd()) { await pi.continue(); await pi.waitForIdle(); }
        info.steer = null;
        // 想完了却一个字没说（推理型模型常见：思考把输出额度用光，或者想着想着就结束了）：催一句、这次不让想，直接说
        const lastMsg = pi.state.messages.at(-1) as any;
        if (!timedOut && lastMsg?.role === "assistant" && !["error", "aborted"].includes(lastMsg.stopReason) && silentMsg(lastMsg)) {
          const think = (lastMsg.content ?? []).filter((c: any) => c.type === "thinking").reduce((n: number, c: any) => n + Array.from(String(c.thinking ?? "")).length, 0);
          console.log(`[agent] 💭 ${agent.id} ${req.sessionKey} 想了 ${think} 字却没说话（${lastMsg.stopReason}，输出 ${lastMsg.usage?.output ?? "?"} token），不让想、催她直接说`);
          nudged = true;
          scope.noThink = true;
          await pi.prompt({ role: "user", content: [{ type: "text", text: NUDGE_TEXT }], timestamp: Date.now(), knudge: true } as any);
          await pi.waitForIdle();
        }
      });
      work.catch(() => {});                          // 放弃等待之后它再报错也别变成未处理的 rejection
      await Promise.race([work, gaveUp]);
    } finally { clearTimeout(hardTimer); if (idleTimer) clearTimeout(idleTimer); idleTimer = null; signal.removeEventListener("abort", onCancel); }

    let fresh = pi.state.messages.slice(start).filter((m: any) => ["user", "assistant", "toolResult"].includes(m.role) && !m.knote) as Message[];
    // 催她说话的那句和前面那条只有思考的空回复不进历史（连着两条助手消息、或者一句「[系统] 你刚才没说话」留在历史里都怪）
    if (nudged) {
      const i = fresh.findIndex((m: any) => m.knudge);
      if (i >= 0) fresh = fresh.filter((m: any, k) => k !== i && !(k === i - 1 && m.role === "assistant" && silentMsg(m)));
      const after = fresh.filter((m) => m.role === "assistant").at(-1);
      console.log(`[agent] 💭 ${agent.id} 催过之后${after && !silentMsg(after) ? "说话了" : "还是没说话"}`);
      health.record({ kind: "nudge", ok: !!after && !silentMsg(after), agent: agent.id, session: req.sessionKey, purpose: scope.purpose, detail: { model: `${model.provider}/${model.id}` } });
    }
    const assistants = fresh.filter((m) => m.role === "assistant") as AssistantMessage[];
    const last = assistants.at(-1);
    const why = timedOut as "" | "idle" | "max" | "cancel" | "budget";      // 在回调里赋值，TS 看不出来
    if (why === "budget") throw new Error(`${GUARD_STOP}${guard.reason}，叫她停手汇报也没停（多半在兜圈子）`);
    if (why === "cancel") {
      // 主人手动终止（管理界面「停止」/「停止并发送」）：问题和已经说出口的那部分照样记进历史，注明被打断——
      // 不然紧接着发的新消息她不知道刚才在聊什么。工具调用和结果不留（没配对的 toolCall 下一轮服务商会拒）
      if (info.cancelled && persist) {
        try {
          const user = fresh.find((m) => m.role === "user");
          const said = spoken.trim();
          if (user) {
            const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
            store.append(req.sessionKey, [
              stripImages(stripRecall(user), agent.workspace),
              { role: "assistant", content: [{ type: "text", text: `${said ? said + "\n" : ""}（这一轮被主人打断了，没说完）` }], api: "openai-completions", provider: "kagura", model: "interrupted", usage: zero, stopReason: "stop", timestamp: Date.now() } as any,
            ]);
          }
        } catch (e: any) { console.log(`[agent] ⚠️  记下被打断的那一轮失败: ${e.message}`); }
      }
      throw new Error(info.cancelled ? "已在管理界面终止" : "已取消");
    }
    if (why === "idle") throw new Error(toolStuck ? `agent 超时（工具 ${toolStuck} 执行超过 ${Math.round(toolMs / 60000)} 分钟没有结束）` : `agent 超时（${idleMs / 1000} 秒没有任何进展）`);
    if (why === "max") throw new Error(`agent 超时（这一轮超过总时长上限 ${Math.round(maxMs / 60000)} 分钟）`);
    if (!last) throw new Error(pi.state.errorMessage || "模型没有返回内容");
    if (last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last.errorMessage || `模型调用失败（${last.stopReason}）`);

    const usage = { input: 0, output: 0, cost: 0 };
    for (const a of assistants) {
      const u = a.usage;
      if (!u) continue;
      usage.input += u.input; usage.output += u.output; usage.cost += u.cost?.total ?? 0;
      store.recordUsage(req.sessionKey, scope.purpose, {
        model: `${a.provider}/${a.model}`, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total ?? 0,
      });
    }
    const textOf = (a: AssistantMessage) => stripVoice(a.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")).trim();
    // 只写了 <voice> 没写正文：朗读版本身就当回复
    const text = textOf(last) || assistants.map(textOf).filter(Boolean).join("\n") || (tap?.fired ?? "");
    if (recalled.raw.length && text) { try { this.recallUsed?.(agent, recalled.raw, req.text, text); } catch { /* 统计记不下不影响回复 */ } }
    // 一个字没说也没调工具：不落盘（库里不留空的助手消息），交给 run 压一压重试。调过工具的不重试——会把工具再执行一遍
    if (!text && !toolCalls.length) throw new Error(`空回复：模型没说话就结束了（${last.stopReason}，输出 ${last.usage?.output ?? "?"} token）`);
    if (persist && (!req.keepIf || req.keepIf(text))) {
      const out = fresh.map((m) => unvoice(stripImages(stripRecall(m), agent.workspace), tap?.fired));
      // 这一轮的上下文构成（估算）记在最后一条助手消息上：会话页每轮下面显示 token 明细用
      const li = out.map((m) => m.role).lastIndexOf("assistant");
      // 这条消息从哪来（同一个会话里可能混着设备、飞书、网页的消息，比如主会话）：会话页标在「用户」旁边
      const ui = out.findIndex((m) => m.role === "user");
      if (ui >= 0) out[ui] = { ...out[ui], ksrc: { channel: req.channel, purpose: scope.purpose, ...(req.deviceId ? { device: req.deviceId } : {}) } } as any;
      if (li >= 0) out[li] = { ...out[li], kctx: {
        sys: fixedSys, tools: fixedTools, hist: histSize, win: ctxWin, calls: assistants.length, limit, toolCount: lazy ? lazy.visible().length : tools.length,
        // 还收着没摆出来的工具组（按需加载）
        deferred: lazy ? [...lazy.hidden().keys()] : undefined, a2a: toolCalls.some((n) => n === "sessions_send" || n === "sessions_spawn") ? scope.trace : undefined,
        // 系统层对上下文做了什么：加载了哪些文件、近况、摘要、自动回忆、截短了几条旧工具结果、单轮上限有没有叫停
        trace, recent: { chars: Array.from(recent).length, items: recent.split("\n").filter((l) => /^\s*-\s/.test(l)).length },
        recall: { hits: recalled.hits, ms: recalled.ms, why: recalled.why }, pruned, guard: guard.reason || undefined,
      } } as any;
      store.append(req.sessionKey, out);
    }
    return { text, meta: scope.meta, toolCalls, usage, stopReason: String(last.stopReason ?? ""), voice: tap?.fired || undefined, guard: guard.reason || undefined };
    } catch (e: any) { liveError = OVERFLOW_RE.test(String(e?.message ?? "")) || EMPTY_RE.test(String(e?.message ?? "")) ? "" : String(e?.message ?? e); throw e; }
    finally {
      if (!nestedRun) this.running.delete(lockKey);
      req.signal?.removeEventListener("abort", onOuter);
      parentCancel?.removeEventListener("abort", onParent);
      if (liveRun && this.liveHub.runs.get(lockKey) === liveRun) { this.liveHub.runs.delete(lockKey); this.liveHub.emit(lockKey, { type: "end", ...(liveError ? { error: liveError } : {}) }); }
    }
  }

  /**
   * 自动回忆（LRN 2026-10-30）：长期记忆不再整篇放进系统提示，改成每轮拿主人这句话检索，相关的几条附在这一轮消息上。
   * 附在消息里而不是系统提示里：系统提示不变，服务商的前缀缓存才命中；落盘前去掉（stripRecall），历史里不留、也不重复占地方。
   * 只给可信、场景里没整篇加载 MEMORY.md 的轮次；检索本地几毫秒，配了嵌入接口时多一次嵌入请求，最多等 RECALL_WAIT_MS。
   */
  private async recallFor(agent: AgentInfo, scope: RunScope, req: RunRequest, context = ""): Promise<{ text: string; hits: string[]; raw: string[]; ms: number; why: string }> {
    const none = (why: string) => ({ text: "", hits: [] as string[], raw: [] as string[], ms: 0, why });
    if (!this.recall || !scope.trusted || req.noTurnContext || !req.text?.trim()) return none(!scope.trusted ? "群聊 / 陌生人不检索" : "");
    const scene = sceneOf(scope);
    if (scene === "guest") return none("群聊 / 陌生人不检索");
    if (loadMode(scene, "MEMORY.md") === "full") return none("这个场景整篇加载了 MEMORY.md");
    const t0 = Date.now();
    let late = false;
    try {
      const hits = await Promise.race([
        this.recall(agent, req.text, context),
        new Promise<{ line: string; why: string; raw?: string }[]>((r) => setTimeout(() => { late = true; r([]); }, RECALL_WAIT_MS).unref?.()),
      ]);
      const ms = Date.now() - t0;
      // 发给模型的只有记忆本身；会话页 ⓘ 里多显示一句是哪些词让它被挑中的
      return { text: hits.length ? `${RECALL_TAG}\n${hits.map((h) => `- ${h.line}`).join("\n")}` : "", hits: hits.map((h) => h.why ? `${h.line}（命中：${h.why}）` : h.line), raw: hits.map((h) => h.raw ?? "").filter(Boolean), ms, why: late ? `超过 ${RECALL_WAIT_MS / 1000} 秒没检索完，这轮不附` : hits.length ? "" : "没有相关的" };
    } catch (e: any) {
      console.log(`[agent] ⚠️  ${agent.id} 自动回忆失败（这轮不附）: ${e.message}`);
      return { ...none(`检索失败：${e.message}`), ms: Date.now() - t0 };
    }
  }

  /** 近况（recent.ts）：最近别处跟主人的往来，放进系统提示 */
  recentActivity(agent: AgentInfo, currentKey: string, lookup = false): string { return recentActivity(this.agents, (id) => this.store(id), agent, currentKey, lookup); }

  /** 某个 agent 在普通会话里能看到的全部内置工具（管理界面白名单用，不过滤白名单本身） */
  allToolNames(agent: AgentInfo): { name: string; label: string; description: string; plugin: boolean; guest_source: boolean; guest_locked: boolean; tokens: number }[] {
    const scope: RunScope = { agentId: agent.id, sessionKey: `${agent.id}:main`, kind: "main", channel: "webchat", purpose: "list", hop: 0, chain: [], meta: {}, trusted: true };
    const seen = new Set<string>();
    const plugin = new Set(this.pluginProviders.flatMap((p) => p(scope, agent)).map((t) => t.name));
    // 扩展 / MCP 里哪些是标了「陌生人也能用」的：拿不可信的上下文问一遍提供者
    const guestSource = new Set(this.pluginProviders.flatMap((p) => p({ ...scope, trusted: false }, agent)).map((t) => t.name));
    return this.allProviders().flatMap((p) => p(scope, agent)).filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)))
      .map((t) => ({ name: t.name, label: t.label, description: t.description, plugin: plugin.has(t.name), guest_source: guestSource.has(t.name), guest_locked: !plugin.has(t.name) && guestLocked(t.name),
        // 这个工具的定义每次调模型占多少（名字 + 说明 + 参数，估算）
        tokens: toolTokens(t) }));
  }

  private toolsFor(scope: RunScope, agent: AgentInfo, req: RunRequest): AgentTool<any>[] {
    // 同名工具只留第一个：内置的先注册，扩展 / MCP 起了重名也盖不掉内置工具
    const seen = new Set<string>();
    const tag = (plugin: boolean) => (p: ToolProvider) => p(scope, agent).map((t) => ({ t, plugin }));
    const all = [...this.providers.flatMap(tag(false)), ...this.pluginProviders.flatMap(tag(true))]
      .filter(({ t }) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
    const allow = agent.tools.includes("*") ? null : new Set(agent.tools);
    // 按场景的工具权限（toolpolicy.ts）：群聊 / 陌生人只给白名单
    const scene = sceneOf(scope);
    // 这条消息已经带着照片（设备取景拍照 / 「看看这是什么」拍完发来的 / 手机发的图）：这一轮不给 take_photo。
    // 不然模型看到「这是什么」就又去调拍照，设备对话里拍照工具只会说「下一条再拍」然后结束这一轮，
    // 可设备刚拍完、不会再拍——对话就断在「我看看」上（2026-10-25 真机）
    const hasImage = !!req.images?.length;
    return all.filter(({ t, plugin }) => toolAllowed(scene, t.name, plugin)).map(({ t }) => t)
      .filter((t) => (!allow || allow.has(t.name)) && (!req.toolAllow || req.toolAllow(t.name)) && !(hasImage && t.name === "take_photo"));
  }

  /** 手动压缩一个会话（管理界面、/compact 命令） */
  compact(agentId: string, key: string) { return this.compactor.compact(agentId, key); }

  /** 已经以文字发出去的回复要顺带念时，转成适合朗读的一段（spoken.ts） */
  spoken(agentId: string, text: string): Promise<string> { return spokenText(this, agentId, text); }

  /** 冲刷等内部运行：不加锁（调用方已在会话锁里） */
  runUnlocked(req: RunRequest) { return this.execute(req); }
}
