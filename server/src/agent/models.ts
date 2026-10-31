// 模型注册：config.json 里用户自己配的服务商 → pi 的 Provider（§6.11，不预设任何模型）。
// pi 只在 agent/ 目录里被引用，外面隔一层（计划 §11：pi 迭代快，锁版本 + 隔离）。
import {
  createModels, createProvider, createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall,
  type Model, type MutableModels, type ProviderStreams, type TranscriptContext, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import type { ModelsConfig } from "../config.ts";
import { runScope } from "./scope.ts";

const APIS: Record<string, () => ProviderStreams> = {
  "openai-completions": openAICompletionsApi,
  "anthropic-messages": anthropicMessagesApi,
  "openai-responses": openAIResponsesApi,
  "google-generative-ai": googleGenerativeAIApi,
};

export const FAKE_MODEL = "fake/fake";

/** 假模型的脚本项（契约测试 /__fake/llm 与单测共用） */
export type FakeStep =
  | string
  | { error: string }
  | { text?: string; tool_calls?: { name: string; args?: Record<string, any> }[]; then?: FakeStep; /** 逐字输出速度（token/秒），测边生成边播用 */ tps?: number };

/** 假模型的控制面：脚本队列 + 调用日志。FakeProviders 实现它 */
export interface FakeLlm {
  nextStep(): FakeStep;
  logCall(entry: Record<string, any>): void;
}

const keyAuth = (name: string, key: string) =>
  ({ apiKey: { name, resolve: async () => ({ auth: { apiKey: key || "none" } }) } }) as any;

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8192;

/** 去掉混在正文里的思考（有的接口把思考写成 <think>…</think> 放进正文；输出被截断时只有开头没有结尾） */
export function stripThinkText(t: string): string {
  return t.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
}

export type ThinkingLevel = "" | "off" | "low" | "medium" | "high";

/**
 * 思考预留：加在「回复上限」之上的 token。这几家（MiniMax / DeepSeek / 智谱 / OpenAI 兼容）都把思考算进 max_tokens，
 * 改不了；我们把用户填的上限当成回复本身的额度，另按等级加一笔给思考，思考就挤不掉回复了。
 * 不填（服务商默认）时多数推理型模型照样会想，也留一些。
 */
export const THINK_RESERVE: Record<ThinkingLevel, number> = { "": 4096, off: 0, low: 2048, medium: 6144, high: 16384 };

/** 服务商怎么开关思考（按地址 / id 认） */
function family(baseUrl: string, provider = "", model = ""): "toggle" | "deepseek" | "qwen" | "openai" | "" {
  const u = `${baseUrl} ${provider} ${model}`.toLowerCase();
  if (/deepseek/.test(u)) return "deepseek";
  if (/minimax|bigmodel|zhipu|z\.ai|\bglm/.test(u)) return "toggle";
  if (/dashscope|aliyuncs|qwen/.test(u)) return "qwen";
  if (/api\.openai\.com/.test(u)) return "openai";
  return "";
}

/** 按思考等级要加进请求体的字段；认不出服务商、又不是「关」以外能安全表达的，就不发（有的接口见到不认识的字段会报错） */
export function thinkingParams(baseUrl: string, level: ThinkingLevel, provider = "", model = ""): Record<string, unknown> | undefined {
  if (!level) return undefined;
  const f = family(baseUrl, provider, model);
  if (level === "off") {
    if (f === "toggle" || f === "deepseek") return { thinking: { type: "disabled" } };
    if (f === "qwen") return { enable_thinking: false };
    if (f === "openai") return { reasoning_effort: "minimal" };
    return undefined;
  }
  if (f === "deepseek") return { thinking: { type: "enabled" }, reasoning_effort: level };
  if (f === "toggle") return { thinking: { type: "enabled" } };             // MiniMax / 智谱：只有开关，等级只影响预留
  if (f === "qwen") return { enable_thinking: true, thinking_budget: THINK_RESERVE[level] };
  return { reasoning_effort: level };                                       // OpenAI 及其它兼容接口的通用写法
}

/** 按服务商地址认出怎么关思考（内部小任务用）；认不出就不发 */
export function autoNoThinking(baseUrl: string, provider = "", model = ""): Record<string, unknown> | undefined {
  return thinkingParams(baseUrl, "off", provider, model);
}

export class ModelRegistry {
  models: MutableModels;
  private fake: FakeLlm | null = null;

  /** 各服务商手动指定的「关思考」字段（ProviderDef.no_thinking） */
  private noThinkCfg = new Map<string, Record<string, unknown> | false>();
  /** 发了关思考字段却被拒的服务商：本次运行不再发 */
  private noThinkRejected = new Set<string>();
  /** 各模型正常对话的思考等级（ModelDef.thinking） */
  private thinkCfg = new Map<string, ThinkingLevel>();

  constructor(private cfg: ModelsConfig) {
    this.models = createModels();
    for (const raw of cfg.providers) {
      if (raw.no_thinking !== undefined) this.noThinkCfg.set(String(raw.id ?? "").trim(), raw.no_thinking);
      // 手填的 id / 模型名常带首尾空格（从网页复制过来），去掉，不然「服务商/模型」对不上
      const p = { ...raw, id: String(raw.id ?? "").trim(), base_url: String(raw.base_url ?? "").trim(),
        models: (raw.models ?? []).map((m) => ({ ...m, id: String(m.id ?? "").trim() })).filter((m) => m.id) };
      if (!p.id) continue;
      const api = APIS[p.api];
      if (!api) { console.log(`[models] ⚠️  服务商 ${p.id}: 不支持的 api「${p.api}」（可用：${Object.keys(APIS).join(", ")}）`); continue; }
      for (const m of p.models) if (m.thinking) this.thinkCfg.set(`${p.id}/${m.id}`, m.thinking);
      const models = (p.models ?? []).map((m) => ({
        id: m.id, name: m.name ?? m.id, api: p.api, provider: p.id, baseUrl: p.base_url,
        reasoning: !!m.reasoning, input: m.input ?? ["text"],
        cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cache_read ?? 0, cacheWrite: m.cost?.cache_write ?? 0 },
        // 没填时的默认：上下文 12.8 万、单次输出 8192（含推理型模型的思考；4096 常被思考用完、正文为空）
        contextWindow: m.context_window ?? DEFAULT_CONTEXT_WINDOW, maxTokens: m.max_tokens ?? DEFAULT_MAX_TOKENS,
        ...(p.headers ? { headers: p.headers } : {}),
      })) as Model<any>[];
      this.models.setProvider(createProvider({
        id: p.id, name: p.name ?? p.id, baseUrl: p.base_url, auth: keyAuth(p.name ?? p.id, p.api_key ?? ""),
        models, api: api(),
      }));
    }
  }

  /** 契约测试 / 单测：注册一个按脚本回复的假模型 fake/fake */
  enableFake(ctl: FakeLlm) {
    this.fake = ctl;
    const model = {
      id: "fake", name: "fake", api: "fake", provider: "fake", baseUrl: "", reasoning: false,
      input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 4096,
    } as Model<any>;
    const stream = (m: Model<any>, ctx: TranscriptContext, opts?: SimpleStreamOptions) => this.fakeStream(m, ctx, opts);
    this.models.setProvider(createProvider({ id: "fake", name: "fake", auth: keyAuth("fake", "x"), models: [model], api: { stream, streamSimple: stream } as any }));
  }

  private fakeStream(m: Model<any>, ctx: TranscriptContext, opts?: SimpleStreamOptions) {
    const msgs = ctx.messages as any[];
    const lastUser = [...msgs].reverse().find((x) => x.role === "user");
    const content = lastUser?.content;
    // 只取最后一段文字：前面那段是运行时自动附的 [时间…]（soul.turnContext）
    const text = typeof content === "string" ? content : ((content ?? []).filter((c: any) => c.type === "text").at(-1)?.text ?? "");
    const image = Array.isArray(content) && content.some((c: any) => c.type === "image");
    const scope = runScope();
    // 只记「回应用户消息」的那一次调用；工具结果之后的续写不算新的 LLM 请求
    const afterTool = msgs.at(-1)?.role === "toolResult";
    if (!afterTool) {
      this.fake!.logCall({
        message: text, session: scope?.sessionKey ?? "", agent: scope?.agentId ?? "", image,
        full: typeof content === "string" ? content : (content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"),
        local_time: scope?.localTime ?? "", purpose: scope?.purpose ?? "chat",
        system: msgs.filter((x) => x.role === "system").map((x) => (typeof x.content === "string" ? x.content : "")).join("\n"),
      });
    }
    const step: FakeStep = afterTool ? (scope?.fakeAfterTool ?? "") : this.fake!.nextStep();
    const tps = typeof step === "object" && "tps" in step && step.tps ? step.tps : 1e6;
    const core = createFauxCore({ provider: "fake", api: "fake", models: [{ id: "fake" }], tokensPerSecond: tps });
    let reply;
    if (typeof step === "object" && "error" in step) reply = fauxAssistantMessage("", { stopReason: "error", errorMessage: step.error });
    else if (typeof step === "object") {
      const blocks: any[] = [];
      if (step.text) blocks.push(fauxText(step.text));
      for (const t of step.tool_calls ?? []) blocks.push(fauxToolCall(t.name, t.args ?? {}));
      // 工具结果回来之后的那一轮续写用 then；没给就沉默结束（文本已在第一轮里）
      if (scope) scope.fakeAfterTool = step.then ?? "";
      reply = fauxAssistantMessage(blocks.length ? blocks : "", { stopReason: step.tool_calls?.length ? "toolUse" : "stop" });
    } else reply = fauxAssistantMessage(step);
    core.setResponses([reply]);
    return core.streamSimple(m, ctx, opts);
  }

  /** 这个模型正常对话的思考等级 */
  thinkingOf(m: Model<any>): ThinkingLevel { return this.thinkCfg.get(`${m.provider}/${m.id}`) ?? ""; }

  /**
   * 正常对话（agent 每一轮）用的流式调用：按模型配置的思考等级加字段，回复上限之上加思考预留。
   * 调用方显式给了 maxTokens / samplingParams 的照旧以调用方为准。
   */
  chatStream = (model: Model<any>, ctx: any, opts?: SimpleStreamOptions) => {
    const level = this.thinkingOf(model);
    const extra = model.provider === "fake" ? undefined : thinkingParams(model.baseUrl ?? "", level, model.provider, model.id);
    return this.models.streamSimple(model, ctx, {
      ...opts,
      maxTokens: opts?.maxTokens ?? (model.maxTokens || DEFAULT_MAX_TOKENS) + THINK_RESERVE[level],
      ...(extra || opts?.samplingParams ? { samplingParams: { ...(extra ?? {}), ...(opts?.samplingParams ?? {}) } as any } : {}),
    });
  };

  /** 内部小任务要加的「关思考」字段 */
  noThinkingParams(m: Model<any>): Record<string, unknown> | undefined {
    if (this.noThinkRejected.has(m.provider)) return undefined;
    const c = this.noThinkCfg.get(m.provider);
    if (c === false) return undefined;
    return c ?? autoNoThinking(m.baseUrl ?? "", m.provider, m.id);
  }

  /**
   * 内部小任务（压缩摘要、长回复压成口语）调模型：关掉思考——这类活不需要想，推理型模型（MiniMax-M3、DeepSeek V4、GLM）
   * 默认会先想一大段，又慢又可能把输出额度用光、正文为空。服务商不认关思考的字段（报错里提到它）就去掉重试一次，之后不再发。
   * 返回的正文去掉了 <think>…</think>。
   */
  async quick(model: Model<any>, ctx: Parameters<MutableModels["completeSimple"]>[1], opts: { signal?: AbortSignal; maxTokens?: number; think?: boolean } = {}) {
    // think：按这个模型自己设的思考等级跑（朗读兜底：关了思考效果差的模型可以开着想）；没设 / 设成关的照旧关
    const level = opts.think ? this.thinkingOf(model) : "";
    if (level && level !== "off" && model.provider !== "fake") {
      const tp = thinkingParams(model.baseUrl ?? "", level, model.provider, model.id);
      const res = await this.models.completeSimple(model, ctx, { signal: opts.signal, maxTokens: (opts.maxTokens ?? (model.maxTokens || DEFAULT_MAX_TOKENS)) + THINK_RESERVE[level], ...(tp ? { samplingParams: tp as any } : {}) });
      return { ...res, content: res.content.map((c: any) => (c.type === "text" ? { ...c, text: stripThinkText(c.text) } : c)) };
    }
    const extra = this.noThinkingParams(model);
    const { think: _t, ...base } = opts;
    let res = await this.models.completeSimple(model, ctx, { ...base, ...(extra ? { samplingParams: extra as any } : {}) });
    if (extra && res.stopReason === "error" && !opts.signal?.aborted && /think|unrecogni[sz]ed|unknown|not support|extra|invalid param/i.test(res.errorMessage ?? "")) {
      this.noThinkRejected.add(model.provider);
      console.log(`[models] ${model.provider} 不认关思考的参数（${String(res.errorMessage).slice(0, 80)}），之后不再发`);
      res = await this.models.completeSimple(model, ctx, base);
    }
    return { ...res, content: res.content.map((c: any) => (c.type === "text" ? { ...c, text: stripThinkText(c.text) } : c)) };
  }

  /** "provider/model" → Model。找不到抛错，错误信息直接给用户看 */
  resolve(ref: string): Model<any> {
    const r = (ref || this.cfg.default || "").trim();
    if (!r) throw new Error("还没有配置模型：在 config.json 的 models.default 填 \"服务商/模型\"");
    const i = r.indexOf("/");
    const m = i > 0 ? this.models.getModel(r.slice(0, i), r.slice(i + 1)) : undefined;
    if (!m) {
      const have = this.list().map((x) => x.ref);
      throw new Error(`找不到模型 ${r}。${have.length ? `已配置的有：${have.join("、")}` : "还没有配置任何模型"}（写法是「服务商 id/模型名」；刚改的配置要先保存）`);
    }
    return m;
  }

  defaultRef() { return this.cfg.default; }
  cheapRef() { return this.cfg.cheap || this.cfg.default; }
  /** 事后压成口语用的模型（没单独设就是空，调用方再退到便宜模型） */
  voiceRef() { return this.cfg.voice || ""; }

  list() {
    return this.models.getModels().map((m) => ({ ref: `${m.provider}/${m.id}`, name: m.name, input: m.input, contextWindow: m.contextWindow }));
  }
}
