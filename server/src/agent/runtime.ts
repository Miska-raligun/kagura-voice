// Agent 运行时（§5 runtime）：每轮 = 组装上下文（soul + 历史 + 摘要）→ pi Agent 跑一轮 → 工具执行 → 落盘。
//
// - 会话落 agent.sqlite，服务端重启不丢上下文
// - 每会话串行（同一会话的消息排队），全局并发上限可配（默认 4）；嵌套调用（a2a 等待对方回复）
//   不占全局名额，否则 4 个互相等待的 agent 就能把系统锁死
// - 历史超过阈值先做「记忆冲刷」再用便宜模型把较早的部分总结成摘要（§6.2）
import path from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message } from "@earendil-works/pi-ai";
import type { AgentRegistry, AgentInfo } from "./registry.ts";
import type { ModelRegistry } from "./models.ts";
import { AgentStore } from "./store.ts";
import { buildSystemPrompt, turnContext, type SessionKind } from "./soul.ts";
import { runScope, withScope, type RunScope } from "./scope.ts";

export interface RunRequest {
  agentId: string;
  sessionKey: string;
  kind: SessionKind;
  channel: string;
  text: string;
  images?: ImageContent[];
  deviceId?: string;
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
  /** 不在消息前附 [时间…]（a2a 转述等） */
  noTurnContext?: boolean;
  /** 覆盖 agent 的模型（heartbeat 用便宜模型） */
  model?: string;
  /** 脱离调用方运行（后台子任务）时显式带上跳数与调用链，防循环 */
  lineage?: { hop: number; chain: string[] };
  /** 落盘前最后一道判断：返回 false 就不落盘（heartbeat 回 HEARTBEAT_OK 时不让它撑大历史） */
  keepIf?: (text: string) => boolean;
}

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

/** 落盘前把图片换成占位文字：base64 图片进库会让每轮上下文都背着几百 KB */
function stripImages(m: Message): Message {
  if ((m.role === "user" || m.role === "toolResult") && Array.isArray(m.content)) {
    return { ...m, content: m.content.map((c: any) => (c.type === "image" ? { type: "text", text: "[图片]" } : c)) } as Message;
  }
  return m;
}

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
  private sem: Semaphore;
  private providers: ToolProvider[] = [];
  /** 压缩前的记忆冲刷（memory 模块注入） */
  beforeCompact: ((agent: AgentInfo, sessionKey: string) => Promise<void>) | null = null;
  /** 系统提示里的技能目录（skills 模块注入） */
  skillCatalog: (agent: AgentInfo) => { name: string; description: string }[] = () => [];
  /** 当前在家状态（presence 路由更新） */
  presence: () => string = () => "";

  constructor(public agents: AgentRegistry, public models: ModelRegistry, private opts: { maxConcurrency: number; timeoutSecs: number }) {
    this.sem = new Semaphore(Math.max(1, opts.maxConcurrency));
  }

  addTools(p: ToolProvider) { this.providers.push(p); }

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

  /** 同一会话串行 */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
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
    if (persist) {
      store.touchSession(req.sessionKey, req.kind, req.channel);
      await this.maybeCompact(agent, store, req.sessionKey);
    }
    const parent = runScope();
    const scope: RunScope = {
      agentId: agent.id, sessionKey: req.sessionKey, kind: req.kind, channel: req.channel,
      deviceId: req.deviceId, spokenTo: req.spokenTo, localTime: req.localTime, purpose: req.purpose ?? "chat",
      hop: parent ? parent.hop + (parent.agentId !== agent.id ? 1 : 0) : (req.lineage?.hop ?? 0),
      chain: [...(parent?.chain ?? req.lineage?.chain ?? []), `${agent.id}|${req.sessionKey}`],
      meta: {},
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
    pi.subscribe((e: any) => { if (e.type === "tool_execution_start") toolCalls.push(e.toolName); });

    const timeout = (req.timeoutSecs ?? this.opts.timeoutSecs) * 1000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; pi.abort(); }, timeout);
    try {
      await withScope(scope, async () => {
        await pi.prompt({ role: "user", content, timestamp: Date.now() } as any);
        await pi.waitForIdle();
      });
    } finally { clearTimeout(timer); }

    const fresh = pi.state.messages.slice(start).filter((m: any) => ["user", "assistant", "toolResult"].includes(m.role)) as Message[];
    const assistants = fresh.filter((m) => m.role === "assistant") as AssistantMessage[];
    const last = assistants.at(-1);
    if (timedOut) throw new Error(`agent 超时（${timeout / 1000}s）`);
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
    if (persist && (!req.keepIf || req.keepIf(text))) store.append(req.sessionKey, fresh.map(stripImages));
    return { text, meta: scope.meta, toolCalls, usage };
  }

  private toolsFor(scope: RunScope, agent: AgentInfo, req: RunRequest): AgentTool<any>[] {
    const all = this.providers.flatMap((p) => p(scope, agent));
    const allow = agent.tools.includes("*") ? null : new Set(agent.tools);
    return all.filter((t) => (!allow || allow.has(t.name)) && (!req.toolAllow || req.toolAllow(t.name)));
  }

  // ── 压缩 ──

  /** 估算当前上下文大小，超过阈值就压缩 */
  private async maybeCompact(agent: AgentInfo, store: AgentStore, key: string) {
    const hist = store.history(key);
    const summary = store.getSession(key)?.summary ?? "";
    const size = estimateTokens(summary) + hist.reduce((n, h) => n + estimateTokens(messageText(h.msg)), 0);
    if (size <= agent.compaction.max_tokens) return;
    await this.compactNow(agent, store, key).catch((e) => console.log(`[agent] ⚠️  ${agent.id} 压缩失败（下轮再试）: ${e.message}`));
  }

  /** 手动或自动压缩。保留最近 keep_messages 条（从一条用户消息开始，不把工具调用和结果拆开） */
  async compact(agentId: string, key: string) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`没有 agent ${agentId}`);
    return this.serial(`${agentId}|${key}`, () => this.compactNow(agent, this.store(agentId), key));
  }

  private async compactNow(agent: AgentInfo, store: AgentStore, key: string): Promise<boolean> {
    const hist = store.history(key);
    let cut = Math.max(0, hist.length - agent.compaction.keep_messages);
    while (cut > 0 && hist[cut].msg.role !== "user") cut--;
    if (cut <= 0) return false;
    const old = hist.slice(0, cut);
    if (this.beforeCompact) {
      try { await this.beforeCompact(agent, key); }
      catch (e: any) { console.log(`[agent] ⚠️  ${agent.id} 记忆冲刷失败: ${e.message}`); }
    }
    const prev = store.getSession(key)?.summary ?? "";
    const transcript = old.map((h) => {
      const who = h.msg.role === "user" ? "用户" : h.msg.role === "assistant" ? agent.name : "工具结果";
      return `${who}：${messageText(h.msg).slice(0, 800)}`;
    }).join("\n");
    const model = this.models.resolve(agent.cheap_model || this.models.cheapRef() || agent.model);
    const res = await withScope({ agentId: agent.id, sessionKey: key, kind: "isolated", channel: "system", purpose: "compact", hop: 0, chain: [], meta: {} },
      () => this.models.models.completeSimple(model, {
        systemPrompt: "你负责把一段对话压缩成摘要，供之后继续对话时参考。保留：人物、约定、待办、偏好、未解决的问题、重要事实与数字。"
          + "省略寒暄与重复。用第三人称、中文、条目式，不超过 600 字。",
        messages: [{ role: "user", content: (prev ? `此前的摘要：\n${prev}\n\n` : "") + `需要压缩的对话：\n${transcript}`, timestamp: Date.now() }],
      }));
    if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage || "摘要模型调用失败");
    const summary = res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
    if (!summary) throw new Error("摘要为空");
    const u = res.usage;
    if (u) store.recordUsage(key, "compact", { model: `${res.provider}/${res.model}`, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total ?? 0 });
    store.compact(key, old.at(-1)!.id, summary);
    console.log(`[agent] 🗜️  ${agent.id} ${key} 压缩 ${old.length} 条 → 摘要 ${Array.from(summary).length} 字`);
    return true;
  }

  /** 冲刷等内部运行：不加锁（调用方已在会话锁里） */
  runUnlocked(req: RunRequest) { return this.execute(req); }
}
