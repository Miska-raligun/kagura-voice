// Agent 运行时（§5 runtime）：每轮 = 组装上下文（soul + 历史 + 摘要）→ pi Agent 跑一轮 → 工具执行 → 落盘。
//
// - 会话落 agent.sqlite，服务端重启不丢上下文
// - 每会话串行（同一会话的消息排队），全局并发上限可配（默认 4）；嵌套调用（a2a 等待对方回复）
//   不占全局名额，否则 4 个互相等待的 agent 就能把系统锁死
// - 历史超过阈值先做「记忆冲刷」再用便宜模型把较早的部分总结成摘要（§6.2）
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message } from "@earendil-works/pi-ai";
import type { AgentRegistry, AgentInfo } from "./registry.ts";
import type { ModelRegistry } from "./models.ts";
import { AgentStore } from "./store.ts";
import { toSpoken } from "../util/text.ts";
import { buildSystemPrompt, turnContext, type SessionKind } from "./soul.ts";
import { runScope, withScope, type RunScope } from "./scope.ts";

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
  /** 外部取消（设备上点屏幕取消正在等的回复） */
  signal?: AbortSignal;
  /** 不在消息前附 [时间…]（a2a 转述等） */
  noTurnContext?: boolean;
  /** 覆盖 agent 的模型（heartbeat 用便宜模型） */
  model?: string;
  /** 脱离调用方运行（后台子任务）时显式带上跳数与调用链，防循环 */
  lineage?: { hop: number; chain: string[]; trusted?: boolean };
  /** 可信度（见 RunScope.trusted）。不传：嵌套调用沿用上层；IM 渠道默认不可信，其它渠道可信 */
  trusted?: boolean;
  /** 直接用调用方给的对象当本轮 meta（边生成边播要在运行中途读到 needPhoto/volume） */
  meta?: RunScope["meta"];
  /** 逐字输出等事件（边生成边播用） */
  onEvent?: (e: AgentStreamEvent) => void;
  /** 落盘前最后一道判断：返回 false 就不落盘（heartbeat 回 HEARTBEAT_OK 时不让它撑大历史） */
  keepIf?: (text: string) => boolean;
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
}

export type ToolProvider = (scope: RunScope, agent: AgentInfo) => AgentTool<any>[];

/** 粗估 token：中日韩字符按 1 个，其余按 4 字符 1 个。只用来判断要不要压缩，不用精确 */
export function estimateTokens(text: string): number {
  let cjk = 0, other = 0;
  for (const ch of text) (/[　-鿿豈-﫿＀-￯]/.test(ch) ? cjk++ : other++);
  return cjk + Math.ceil(other / 4);
}

export function messageText(m: any): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content ?? []).map((c: any) => {
    if (c.type === "text") return c.text;
    if (c.type === "toolCall") return `[调用 ${c.name} ${JSON.stringify(c.arguments)}]`;
    if (c.type === "image") return "[图片]";
    return "";
  }).join("");
}

/**
 * 落盘前把图片换成文字引用：base64 图片进库会让每轮上下文都背着几百 KB。
 * 图片本身存进 agent 工作目录 uploads/<日期>/img-<哈希>.<扩展名>（同一张只存一份），记录里留「[图片 路径]」——
 * 管理界面凭路径显示，agent 以后也能用 exec 处理它。存不下来就退回「[图片]」。
 */
export const IMAGE_REF_RE = /^\[图片 (uploads\/[^\]]+)\]$/;
function stripImages(m: Message, workspace?: string): Message {
  if ((m.role === "user" || m.role === "toolResult") && Array.isArray(m.content)) {
    return { ...m, content: m.content.map((c: any) => (c.type === "image" ? { type: "text", text: saveImageRef(c, workspace) } : c)) } as Message;
  }
  return m;
}

function saveImageRef(c: { data: string; mimeType: string }, workspace?: string): string {
  if (!workspace || !c.data) return "[图片]";
  try {
    const buf = Buffer.from(c.data, "base64");
    const ext = /png/.test(c.mimeType) ? "png" : /webp/.test(c.mimeType) ? "webp" : /gif/.test(c.mimeType) ? "gif" : "jpg";
    const rel = `uploads/${new Date().toLocaleDateString("sv-SE")}/img-${createHash("sha1").update(buf).digest("hex").slice(0, 12)}.${ext}`;
    const abs = path.join(workspace, ...rel.split("/"));
    if (!fs.existsSync(abs)) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, buf); }
    return `[图片 ${rel}]`;
  } catch { return "[图片]"; }
}

/** 一个工具最多执行多久（工具自己不理超时、卡在网络上时的兜底；exec 自己的上限是 10 分钟） */
export const TOOL_MAX_MS = 15 * 60_000;

class Semaphore {
  private queue: (() => void)[] = [];
  constructor(private n: number) {}
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise<void>((r) => this.queue.push(r));
  }
  release() {
    const next = this.queue.shift();
    if (next) next(); else this.n++;
  }
}

export class Runtime {
  private stores = new Map<string, AgentStore>();
  private locks = new Map<string, Promise<unknown>>();
  /** 每个会话正在跑的那一轮：卡住时日志里说清楚是谁占着 */
  private running = new Map<string, { purpose: string; channel: string; since: number; tool: string; stage: string }>();
  private sem: Semaphore;
  private providers: ToolProvider[] = [];
  /** 扩展 / 扩展包 / MCP 的工具：排在所有内置工具后面，重名时内置的赢（不管谁先注册） */
  private pluginProviders: ToolProvider[] = [];
  /** 压缩前的记忆冲刷（memory 模块注入） */
  beforeCompact: ((agent: AgentInfo, sessionKey: string) => Promise<void>) | null = null;
  /** 系统提示里的技能目录（skills 模块注入） */
  skillCatalog: (agent: AgentInfo) => { name: string; description: string }[] = () => [];
  /** 当前在家状态（presence 路由更新） */
  presence: () => string = () => "";

  constructor(public agents: AgentRegistry, public models: ModelRegistry, private opts: { maxConcurrency: number; timeoutSecs: number; maxSecs?: number }) {
    this.sem = new Semaphore(Math.max(1, opts.maxConcurrency));
  }

  /** 管理界面改了超时：就地生效（下一轮起） */
  setLimits(l: { timeoutSecs?: number; maxSecs?: number }) {
    if (l.timeoutSecs && l.timeoutSecs > 0) this.opts.timeoutSecs = l.timeoutSecs;
    if (l.maxSecs && l.maxSecs > 0) this.opts.maxSecs = l.maxSecs;
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

  /** 同一会话串行。前面那轮迟迟不完就打一行日志，说清楚是谁占着（以前这种情况一声不吭，看起来就是「这个 agent 不理人了」） */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    if (this.locks.has(key)) {
      const t = setTimeout(() => {
        const r = this.running.get(key);
        const who = r ? `${r.purpose}/${r.channel}，已跑 ${Math.round((Date.now() - r.since) / 1000)} 秒，${r.stage}${r.tool ? `：${r.tool}` : ""}` : "未知";
        console.log(`[agent] ⏳  ${key} 在排队：上一轮还没结束（${who}）`);
      }, 20_000);
      t.unref?.();
      prev.finally(() => clearTimeout(t));
    }
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }

  /** 会话是否正有一轮在跑（调度器的 idleOnly 用） */
  busy(agentId: string, sessionKey: string) { return this.locks.has(`${agentId}|${sessionKey}`); }

  async run(req: RunRequest): Promise<RunResult> {
    const nested = !!runScope();      // 在另一轮运行里发起的（a2a 等待对方回复）
    return this.serial(`${req.agentId}|${req.sessionKey}`, async () => {
      if (!nested) await this.sem.acquire();
      try { return await this.execute(req); }
      finally { if (!nested) this.sem.release(); }
    });
  }

  /** 真正跑一轮。调用方负责串行（run 或压缩流程里的冲刷） */
  private async execute(req: RunRequest): Promise<RunResult> {
    const agent = this.agents.get(req.agentId);
    if (!agent) throw new Error(`没有 agent ${req.agentId}`);
    const store = this.store(agent.id);
    const persist = req.persist !== false;
    const lockKey = `${agent.id}|${req.sessionKey}`;
    const nestedRun = this.running.has(lockKey);          // 冲刷等内部运行：别覆盖外面那一轮的登记
    const info = { purpose: req.purpose ?? "chat", channel: req.channel, since: Date.now(), tool: "", stage: "准备" };
    if (!nestedRun) this.running.set(lockKey, info);
    try {
    if (persist) {
      store.touchSession(req.sessionKey, req.kind, req.channel);
      info.stage = "压缩历史";
      await this.maybeCompact(agent, store, req.sessionKey, req.signal);
      if (req.signal?.aborted) throw new Error("已取消");
    }
    info.stage = "生成回复";
    const parent = runScope();
    const scope: RunScope = {
      agentId: agent.id, sessionKey: req.sessionKey, kind: req.kind, channel: req.channel,
      deviceId: req.deviceId, spokenTo: req.spokenTo, origin: req.origin ?? (req.channel === "device" && req.deviceId ? `device:${req.deviceId}` : parent?.origin), localTime: req.localTime, purpose: req.purpose ?? "chat",
      hop: parent ? parent.hop + (parent.agentId !== agent.id ? 1 : 0) : (req.lineage?.hop ?? 0),
      chain: [...(parent?.chain ?? req.lineage?.chain ?? []), `${agent.id}|${req.sessionKey}`],
      meta: req.meta ?? {},
      trusted: req.trusted ?? parent?.trusted ?? req.lineage?.trusted ?? !IM_CHANNELS.has(req.channel),
    };
    const model = this.models.resolve(req.model || agent.model);
    const history = store.history(req.sessionKey).map((h) => h.msg);
    const session = store.getSession(req.sessionKey);
    const tools = this.toolsFor(scope, agent, req);
    const peers = this.agents.list().filter((p) => this.agents.canContact(agent.id, p.id)).map((p) => ({ id: p.id, name: p.name }));
    const systemPrompt = buildSystemPrompt({
      agent, kind: req.kind, channel: req.channel, summary: session?.summary,
      extra: req.extraSystem, skills: this.skillCatalog(agent), voiceDelivery: req.voiceDelivery,
      peers: tools.some((t) => t.name.startsWith("sessions_")) ? peers : [],
    });

    const content: any[] = [];
    if (!req.noTurnContext) content.push({ type: "text", text: turnContext(req.localTime, this.presence()) });
    if (req.images?.length) {
      if (model.input.includes("image")) content.push(...req.images);
      else content.push({ type: "text", text: "[用户发来了图片，但当前模型不支持看图，请如实告诉用户]" });
    }
    content.push({ type: "text", text: req.text });

    const pi = new Agent({
      initialState: { systemPrompt, model, tools, messages: history as any },
      streamFn: this.models.models.streamSimple.bind(this.models.models),
      sessionId: `${agent.id}:${req.sessionKey}`,
      toolExecution: "sequential",
    });
    const start = pi.state.messages.length;
    const toolCalls: string[] = [];
    // 超时按「多久没有进展」算，不按一轮总时长：模型在出字、工具在执行都算在干活，长任务不会被半路掐掉。
    // 工具执行期间不计时（命令有自己的超时）；另有总时长上限兜底，防卡死、防死循环
    const idleMs = (req.timeoutSecs ?? this.opts.timeoutSecs) * 1000;
    const maxMs = Math.max(idleMs, (this.opts.maxSecs ?? 1800) * 1000);
    let timedOut: "" | "idle" | "max" | "cancel" = "";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let toolsRunning = 0;
    // 超时后先 abort；有的工具不理会中止信号（卡在网络、扩展写得不好），给 2 秒宽限就不再等它
    let giveUp: () => void = () => {};
    const gaveUp = new Promise<void>((r) => (giveUp = r));
    const stop = (why: "idle" | "max" | "cancel") => {
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
    pi.subscribe((e: any) => {
      if (e.type === "tool_execution_start") { toolCalls.push(e.toolName); toolsRunning++; info.tool = e.toolName; info.stage = "执行工具"; }
      else if (e.type === "tool_execution_end") { toolsRunning = Math.max(0, toolsRunning - 1); if (!toolsRunning) { info.tool = ""; info.stage = "生成回复"; } }
      kick();
      if (!req.onEvent) return;
      try {
        if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") req.onEvent({ type: "text", delta: e.assistantMessageEvent.delta });
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
    if (req.signal?.aborted) onCancel(); else req.signal?.addEventListener("abort", onCancel, { once: true });
    try {
      const work = withScope(scope, async () => {
        await pi.prompt({ role: "user", content, timestamp: Date.now() } as any);
        await pi.waitForIdle();
      });
      work.catch(() => {});                          // 放弃等待之后它再报错也别变成未处理的 rejection
      await Promise.race([work, gaveUp]);
    } finally { clearTimeout(hardTimer); if (idleTimer) clearTimeout(idleTimer); idleTimer = null; req.signal?.removeEventListener("abort", onCancel); }

    const fresh = pi.state.messages.slice(start).filter((m: any) => ["user", "assistant", "toolResult"].includes(m.role)) as Message[];
    const assistants = fresh.filter((m) => m.role === "assistant") as AssistantMessage[];
    const last = assistants.at(-1);
    const why = timedOut as "" | "idle" | "max" | "cancel";      // 在回调里赋值，TS 看不出来
    if (why === "cancel") throw new Error("已取消");
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
    const textOf = (a: AssistantMessage) => a.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
    const text = textOf(last) || assistants.map(textOf).filter(Boolean).join("\n");
    if (persist && (!req.keepIf || req.keepIf(text))) store.append(req.sessionKey, fresh.map((m) => stripImages(m, agent.workspace)));
    return { text, meta: scope.meta, toolCalls, usage };
    } finally { if (!nestedRun) this.running.delete(lockKey); }
  }

  /** 某个 agent 在普通会话里能看到的全部内置工具（管理界面白名单用，不过滤白名单本身） */
  allToolNames(agent: AgentInfo): { name: string; label: string; description: string }[] {
    const scope: RunScope = { agentId: agent.id, sessionKey: `${agent.id}:main`, kind: "main", channel: "webchat", purpose: "list", hop: 0, chain: [], meta: {}, trusted: true };
    const seen = new Set<string>();
    return this.allProviders().flatMap((p) => p(scope, agent)).filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)))
      .map((t) => ({ name: t.name, label: t.label, description: t.description }));
  }

  private toolsFor(scope: RunScope, agent: AgentInfo, req: RunRequest): AgentTool<any>[] {
    // 同名工具只留第一个：内置的先注册，扩展 / MCP 起了重名也盖不掉内置工具
    const seen = new Set<string>();
    const all = this.allProviders().flatMap((p) => p(scope, agent)).filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
    const allow = agent.tools.includes("*") ? null : new Set(agent.tools);
    return all.filter((t) => (!allow || allow.has(t.name)) && (!req.toolAllow || req.toolAllow(t.name)));
  }

  // ── 压缩 ──

  /** 估算当前上下文大小，超过阈值就压缩 */
  /**
   * 回复之前顺带做的压缩：有时限、能取消。它在会话锁里跑——以前摘要那次模型调用既没超时也不理取消，
   * 接口一卡住，这个 agent 的这个会话就永远排不上队（症状「某个 agent 不理人了，换个 agent 正常」）。
   * 超时 / 失败就跳过，这轮照常回复，下轮再试。
   */
  private async maybeCompact(agent: AgentInfo, store: AgentStore, key: string, signal?: AbortSignal) {
    const hist = store.history(key);
    const summary = store.getSession(key)?.summary ?? "";
    const size = estimateTokens(summary) + hist.reduce((n, h) => n + estimateTokens(messageText(h.msg)), 0);
    if (size <= agent.compaction.max_tokens) return;
    const ms = this.opts.timeoutSecs * 1000 * 2;            // 冲刷 + 摘要两次模型调用
    const ac = new AbortController();
    let why = "";
    const onAbort = () => { why ||= "已取消"; ac.abort(); };
    if (signal?.aborted) return;
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { why ||= `超过 ${ms / 1000} 秒`; ac.abort(); }, ms);
    const aborted = new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error(why)), { once: true }));
    const work = this.compactNow(agent, store, key, ac.signal);
    work.catch(() => {});                                     // 放弃等待之后它再报错也别变成未处理的 rejection
    try { await Promise.race([work, aborted]); }
    catch (e: any) { console.log(`[agent] ⚠️  ${agent.id} 压缩${why === "已取消" ? "被取消" : "失败"}（下轮再试）: ${e.message}`); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
  }

  /** 手动或自动压缩。保留最近 keep_messages 条（从一条用户消息开始，不把工具调用和结果拆开） */
  async compact(agentId: string, key: string) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`没有 agent ${agentId}`);
    return this.serial(`${agentId}|${key}`, () => this.compactNow(agent, this.store(agentId), key));
  }

  private async compactNow(agent: AgentInfo, store: AgentStore, key: string, signal?: AbortSignal): Promise<boolean> {
    const hist = store.history(key);
    let cut = Math.max(0, hist.length - agent.compaction.keep_messages);
    while (cut > 0 && hist[cut].msg.role !== "user") cut--;
    if (cut <= 0) return false;
    const old = hist.slice(0, cut);
    if (this.beforeCompact) {
      try { await this.beforeCompact(agent, key); }
      catch (e: any) { console.log(`[agent] ⚠️  ${agent.id} 记忆冲刷失败: ${e.message}`); }
      if (signal?.aborted) throw new Error("已取消");
    }
    const prev = store.getSession(key)?.summary ?? "";
    const transcript = old.map((h) => {
      const who = h.msg.role === "user" ? "用户" : h.msg.role === "assistant" ? agent.name : "工具结果";
      return `${who}：${messageText(h.msg).slice(0, 800)}`;
    }).join("\n");
    const model = this.models.resolve(agent.cheap_model || this.models.cheapRef() || agent.model);
    if (signal?.aborted) throw new Error("已取消");
    const res = await withScope({ agentId: agent.id, sessionKey: key, kind: "isolated", channel: "system", purpose: "compact", hop: 0, chain: [], meta: {}, trusted: false },
      () => this.models.models.completeSimple(model, {
        systemPrompt: "你负责把一段对话压缩成摘要，供之后继续对话时参考。保留：人物、约定、待办、偏好、未解决的问题、重要事实与数字。"
          + "省略寒暄与重复。用第三人称、中文、条目式，不超过 600 字。",
        messages: [{ role: "user", content: (prev ? `此前的摘要：\n${prev}\n\n` : "") + `需要压缩的对话：\n${transcript}`, timestamp: Date.now() }],
      }, { signal }));
    if (signal?.aborted) throw new Error("已取消");              // 放弃等待之后才回来：别再改历史（下一轮可能已经在用了）
    if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage || "摘要模型调用失败");
    const summary = res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
    if (!summary) throw new Error("摘要为空");
    const u = res.usage;
    if (u) store.recordUsage(key, "compact", { model: `${res.provider}/${res.model}`, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total ?? 0 });
    store.compact(key, old.at(-1)!.id, summary);
    console.log(`[agent] 🗜️  ${agent.id} ${key} 压缩 ${old.length} 条 → 摘要 ${Array.from(summary).length} 字`);
    return true;
  }

  /**
   * 已经以文字发出去的回复（IM、网页、投到 IM 的任务）要顺带念时，转成适合朗读的一段。
   * 去掉格式后不超过 agent 的语音字数（voice_max_chars，留两成余量）就直接念；更长的交给便宜模型压成口语，
   * 失败或超时退回截断。
   */
  async spoken(agentId: string, text: string): Promise<string> {
    const agent = this.agents.get(agentId);
    const max = agent?.voice_max_chars || 80;
    const plain = toSpoken(text, 100_000);
    if (!plain || Array.from(plain).length <= max * 1.2 || !agent) return plain;
    try {
      const model = this.models.resolve(agent.cheap_model || this.models.cheapRef() || agent.model);
      const res = await Promise.race([
        withScope({ agentId, sessionKey: `${agentId}:voice`, kind: "isolated", channel: "system", purpose: "voice", hop: 0, chain: [], meta: {}, trusted: false },
          () => this.models.models.completeSimple(model, {
            systemPrompt: `你是${agent.name}。下面是你刚用文字发给主人的回复，现在要在家里的设备上用语音念出来。`
              + `把它改写成适合朗读的口语，不超过 ${max} 字：保留结论和关键数字，省略细节、列表、代码和网址；`
              + "不要用 markdown、表情符号；内容放不下时最后说一句「详细的我发在消息里了」。只输出要念的话本身。",
            messages: [{ role: "user", content: text.slice(0, 6000), timestamp: Date.now() }],
          })),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("超时")), 20_000)),
      ]);
      if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage || "模型调用失败");
      const out = toSpoken(res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""), max * 2);
      const u = res.usage;
      if (u) this.store(agentId).recordUsage(`${agentId}:voice`, "voice", { model: `${res.provider}/${res.model}`, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total ?? 0 });
      if (out) return out;
    } catch (e: any) {
      console.log(`[agent] ⚠️  ${agentId} 语音摘要失败，改为截断: ${e.message}`);
    }
    return toSpoken(text, max);
  }

  /** 冲刷等内部运行：不加锁（调用方已在会话锁里） */
  runUnlocked(req: RunRequest) { return this.execute(req); }
}
