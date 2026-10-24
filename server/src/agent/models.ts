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

/** 按服务商地址认出怎么关思考；认不出就不发（有的接口见到不认识的字段会直接报错） */
export function autoNoThinking(baseUrl: string, provider = "", model = ""): Record<string, unknown> | undefined {
  const u = `${baseUrl} ${provider} ${model}`.toLowerCase();
  if (/minimax|deepseek|bigmodel|zhipu|z\.ai|\bglm/.test(u)) return { thinking: { type: "disabled" } };
  if (/dashscope|aliyuncs|qwen/.test(u)) return { enable_thinking: false };
  return undefined;
}

export class ModelRegistry {
  models: MutableModels;
  private fake: FakeLlm | null = null;

  /** 各服务商手动指定的「关思考」字段（ProviderDef.no_thinking） */
  private noThinkCfg = new Map<string, Record<string, unknown> | false>();
  /** 发了关思考字段却被拒的服务商：本次运行不再发 */
  private noThinkRejected = new Set<string>();

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
  async quick(model: Model<any>, ctx: Parameters<MutableModels["completeSimple"]>[1], opts: { signal?: AbortSignal; maxTokens?: number } = {}) {
    const extra = this.noThinkingParams(model);
    let res = await this.models.completeSimple(model, ctx, { ...opts, ...(extra ? { samplingParams: extra as any } : {}) });
    if (extra && res.stopReason === "error" && !opts.signal?.aborted && /think|unrecogni[sz]ed|unknown|not support|extra|invalid param/i.test(res.errorMessage ?? "")) {
      this.noThinkRejected.add(model.provider);
      console.log(`[models] ${model.provider} 不认关思考的参数（${String(res.errorMessage).slice(0, 80)}），之后不再发`);
      res = await this.models.completeSimple(model, ctx, opts);
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

  list() {
    return this.models.getModels().map((m) => ({ ref: `${m.provider}/${m.id}`, name: m.name, input: m.input, contextWindow: m.contextWindow }));
  }
}
