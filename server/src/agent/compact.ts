// 压缩：较早的对话分块滚动总结成摘要，顺手挑出要记住的事。从 runtime.ts 拆出来的；在会话锁里跑，所以每一段都有时限、能取消。
import type { Message } from "@earendil-works/pi-ai";
import type { AgentInfo } from "./registry.ts";
import type { AgentStore } from "./store.ts";
import type { Runtime, RunRequest } from "./runtime.ts";
import { stripThinkText } from "./models.ts";
import { runScope, withScope } from "./scope.ts";
import { health } from "./health.ts";
import { estimateTokens, msgTokens, pruneToolResults, KEEP_RATIO } from "./context.ts";
import { messageText } from "./messages.ts";

/** 压缩时每次交给摘要模型的对话量（估算 token）；太大推理型模型会把输出额度全花在思考上 */
export const COMPACT_CHUNK_TOKENS = 16_000;
/** 摘要那次调用的输出额度下限（含思考）：模型配置的 max_tokens 更大就用模型的 */
export const COMPACT_MAX_OUTPUT = 8192;

/**
 * 拆开摘要模型的输出：【摘要】正文 + 【记住】要记的事（每条 "主人|长期|今天\n内容"）。
 * 不认顺序：模型偶尔把【记住】写在最前，以前按「【记住】之前的才是摘要」切，正文就成了空，整段对话只剩兜底的十几句用户原话。
 */
export function parseCompactOutput(raw: string): { summary: string; remembered: string[] } {
  const remembered: string[] = [];
  const parts: string[] = [];
  const loose: string[] = [];      // 【记住】段里不像「长期：…」的行：模型先写【记住】再接着写的摘要正文多半在这

  // 按标记切段：标记前的（没写【摘要】时）也算摘要
  const re = /【(摘要|记住)】/g;
  let kind = "摘要", last = 0, m: RegExpExecArray | null;
  const take = (k: string, body: string) => {
    if (k === "摘要") { if (body.trim()) parts.push(body.trim()); return; }
    for (const ln of body.split("\n")) {
      const mm = /^\s*[-*·\d.、]*\s*(主人|长期|今天)\s*[:：]\s*(.+)$/.exec(ln);
      if (mm) { if (!/^无[。.]?$/.test(mm[2].trim())) remembered.push(`${mm[1]}\n${mm[2].trim()}`); }
      else if (ln.trim() && !/^\s*[-*·]?\s*无[。.]?\s*$/.test(ln)) loose.push(ln.trim());
    }
  };
  while ((m = re.exec(raw))) { take(kind, raw.slice(last, m.index)); kind = m[1]; last = m.index + m[0].length; }
  take(kind, raw.slice(last));
  return { summary: (parts.join("\n").trim() || loose.join("\n")).trim(), remembered };
}

/** 压缩要向运行时借的两样：会话锁（跟正常轮次排同一个队）和单次模型调用的时限 */
export interface CompactHost {
  serial<T>(key: string, fn: () => Promise<T>): Promise<T>;
  timeoutSecs(): number;
}

export class Compactor {
  /** 每个会话上一轮算出来的压缩阈值（回复后在后台压缩、手动压缩时用） */
  limits = new Map<string, number>();
  constructor(private rt: Runtime, private host: CompactHost) {}

  /**
   * 回复之前顺带做的压缩：有时限、能取消。它在会话锁里跑——以前摘要那次模型调用既没超时也不理取消，
   * 接口一卡住，这个 agent 的这个会话就永远排不上队（症状「某个 agent 不理人了，换个 agent 正常」）。
   * 超时 / 失败就跳过，这轮照常回复，下轮再试。
   */
  async maybeCompact(agent: AgentInfo, store: AgentStore, key: string, signal?: AbortSignal, o: { limit: number; keepTokens?: number; trigger?: string } = { limit: agent.compaction.max_tokens }) {
    const hist = store.history(key);
    const summary = store.getSession(key)?.summary ?? "";
    // 按「进上下文时的样子」算：旧工具结果反正会被截短，别拿原文的大小去触发压缩
    const size = estimateTokens(summary) + pruneToolResults(hist.map((h) => h.msg)).reduce((n, m) => n + msgTokens(m), 0);
    if (size <= o.limit) return;
    // 摘要按块各一次（见 compactNow），每次最多 timeoutSecs
    const ms = this.host.timeoutSecs() * 1000 * Math.min(8, 1 + Math.ceil(size / this.rt.compactChunk));
    const ac = new AbortController();
    let why = "";
    const onAbort = () => { why ||= "已取消"; ac.abort(); };
    if (signal?.aborted) return;
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { why ||= `超过 ${ms / 1000} 秒`; ac.abort(); }, ms);
    const aborted = new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error(why)), { once: true }));
    const work = this.compactNow(agent, store, key, ac.signal, o.keepTokens ?? Math.floor(o.limit * KEEP_RATIO), o.trigger ?? "before", { size, limit: o.limit });
    work.catch(() => {});                                     // 放弃等待之后它再报错也别变成未处理的 rejection
    try { await Promise.race([work, aborted]); }
    catch (e: any) {
      console.log(`[agent] ⚠️  ${agent.id} 压缩${why === "已取消" ? "被取消" : "失败"}（下轮再试）: ${e.message}`);
      try { store.addEvent(key, "compact_failed", { trigger: o.trigger ?? "before", error: e.message, size, limit: o.limit }); } catch { /* 记不下就算了 */ }
      health.record({ kind: "compact_failed", ok: false, agent: agent.id, session: key, detail: { trigger: o.trigger ?? "before", error: String(e.message).slice(0, 200) } });
    }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
  }

  /**
   * 回复之后：历史已经接近阈值（七成）就在后台先压，下一轮来的时候不用先等压缩。
   * 排在这个会话的队里（serial），跟下一轮不会同时改历史；不占全局并发名额（只调便宜模型）
   */
  afterReply(req: RunRequest) {
    if (!this.rt.backgroundCompact || req.persist === false || req.kind === "sub" || runScope()) return;
    const agent = this.rt.agents.get(req.agentId);
    const key = `${req.agentId}|${req.sessionKey}`;
    const limit = this.limits.get(key);
    if (!agent || !limit) return;
    const store = this.rt.store(agent.id);
    const size = estimateTokens(store.getSession(req.sessionKey)?.summary ?? "") + pruneToolResults(store.history(req.sessionKey).map((h) => h.msg)).reduce((n, m) => n + msgTokens(m), 0);
    if (size <= limit * 0.7) return;
    void this.host.serial(key, () => this.maybeCompact(agent, store, req.sessionKey, undefined, { limit: Math.floor(limit * 0.7), keepTokens: Math.floor(limit * KEEP_RATIO), trigger: "background" }))
      .catch((e) => console.log(`[agent] ⚠️  ${agent.id} 后台压缩失败: ${e.message}`));
  }

  /** 手动或自动压缩 */
  async compact(agentId: string, key: string) {
    const agent = this.rt.agents.get(agentId);
    if (!agent) throw new Error(`没有 agent ${agentId}`);
    const limit = this.limits.get(`${agentId}|${key}`) ?? agent.compaction.max_tokens;
    return this.host.serial(`${agentId}|${key}`, () => this.compactNow(agent, this.rt.store(agentId), key, undefined, Math.floor(limit * KEEP_RATIO), "manual"));
  }

  /**
   * 压缩：留下最近的消息（按 token，最多 keepTokens、最多 keep_messages 条，至少留最近一轮），其余总结成摘要。
   * 从一条用户消息处切开，不把工具调用和它的结果拆开
   */
  private async compactNow(agent: AgentInfo, store: AgentStore, key: string, signal?: AbortSignal, keepTokens = Math.floor(agent.compaction.max_tokens * KEEP_RATIO),
    trigger = "manual", why?: { size: number; limit: number }): Promise<boolean> {
    const t0 = Date.now();
    const hist = store.history(key);
    const eff = pruneToolResults(hist.map((h) => h.msg));
    const userIdx = hist.map((h, i) => (h.msg.role === "user" ? i : -1)).filter((i) => i >= 0);
    if (!userIdx.length) return false;
    const lastUser = userIdx.at(-1)!;
    // 从后往前攒，超了 keepTokens 或 keep_messages 就停；切点挪到其后第一条用户消息（宁可少留），但至少留最近一轮
    let used = 0, start = hist.length;
    for (let i = hist.length - 1; i >= 0; i--) {
      used += msgTokens(eff[i]);
      if (used > keepTokens || hist.length - i > agent.compaction.keep_messages) break;
      start = i;
    }
    const cut = Math.min(userIdx.find((i) => i >= start) ?? lastUser, lastUser);
    if (cut <= 0) return false;
    const old = hist.slice(0, cut);
    if (this.rt.beforeCompact) {
      try { await this.rt.beforeCompact(agent, key); }
      catch (e: any) { console.log(`[agent] ⚠️  ${agent.id} 记忆冲刷失败: ${e.message}`); }
      if (signal?.aborted) throw new Error("已取消");
    }
    // 分块滚动摘要：把要压的对话切成每块 COMPACT_CHUNK_TOKENS 左右，「上一版摘要 + 这一块」→ 新摘要。
    // 以前一次塞几万 token 进去：推理型模型（MiniMax-M3 等）把输出额度花在思考上，正文为空 → 「摘要为空」，
    // 而且每轮重试、历史越积越大（2026-10-24 真机：冲刷那次输入 6.9 万 token，连着两轮空摘要）
    // 每条前面标上消息编号（#m<id>）：让摘要在要点后面注明出处，以后她要细节就用 read_ref 读原文（链式召回）
    const lines = old.map((h) => {
      const who = h.msg.role === "user" ? "用户" : h.msg.role === "assistant" ? agent.name : "工具结果";
      return `[#m${h.id}] ${who}：${messageText(h.msg).slice(0, h.msg.role === "toolResult" ? 600 : 1500)}`;
    });
    const chunks: string[][] = [[]];
    let size = 0;
    for (const ln of lines) {
      const n = estimateTokens(ln);
      if (size + n > this.rt.compactChunk && chunks.at(-1)!.length) { chunks.push([]); size = 0; }
      chunks.at(-1)!.push(ln); size += n;
    }
    const model = this.rt.models.resolve(agent.cheap_model || this.rt.models.cheapRef() || agent.model);
    const perCall = this.host.timeoutSecs() * 1000;
    let summary = store.getSession(key)?.summary ?? "";
    let failed = 0;
    // 顺手挑出要记住的事：给摘要模型看一眼已有的长期记忆（结尾一段），免得重复记
    const tail = (f: string, n: number) => Array.from(this.rt.agents.readFile(agent.id, f).trim()).slice(-n).join("");
    const memTail = this.rt.remember ? [tail("USER.md", 1500), tail("MEMORY.md", 1500)].filter(Boolean).join("\n…\n") : "";
    const remembered: string[] = [];
    for (const [i, chunk] of chunks.entries()) {
      if (signal?.aborted) throw new Error("已取消");
      let text = "";
      try {
        // 只写了【记住】没写摘要（模型偶尔把【记住】放最前）：记住的那几条拿来当摘要；一条都没有就再要一次，还不行才走兜底
        for (let attempt = 0; ; attempt++) {
        const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(perCall)]) : AbortSignal.timeout(perCall);
        const res = await withScope({ agentId: agent.id, sessionKey: key, kind: "isolated", channel: "system", purpose: "compact", hop: 0, chain: [], meta: {}, trusted: false },
          () => this.rt.models.quick(model, {
            systemPrompt: "你负责把一段对话压缩成摘要，供之后继续对话时参考。保留：人物、约定、待办、偏好、未解决的问题、重要事实与数字。"
              + "省略寒暄与重复。用第三人称、中文、条目式，不超过 800 字。直接输出，不要思考过程。"
              + "对话每条前面的 [#m数字] 是原话编号：重要的要点（约定、数字、结论、没解决的问题）末尾用「（#m数字）」注明出自哪条，一条要点标一个就够；此前摘要里已有的编号原样保留。"
              + (this.rt.remember ? "\n先写「【摘要】」和摘要正文；摘要之后另起一行写「【记住】」，下面每行一条这段对话里新出现、以后还用得着的事："
                + "以后还成立的（事实、约定、偏好、计划、项目的结论、重要日子）以「长期：」开头；当天发生的事、做了什么、进行到哪一步以「今天：」开头；"
                + "只有主人本人的稳定个人信息（称呼、家人、生日、长期作息、口味与忌口、习惯和喜好）才以「主人：」开头，这类很少，拿不准就写成「长期：」。"
                + "已有记忆里有的别重复，没有就写「无」。" : ""),
            messages: [{ role: "user", content: (memTail && i === 0 ? `已有的记忆（节选，别重复）：\n${memTail}\n\n` : "") + (summary ? `此前的摘要：\n${summary}\n\n` : "") + `需要并进摘要的对话${chunks.length > 1 ? `（第 ${i + 1}/${chunks.length} 段）` : ""}：\n${chunk.join("\n")}`
              + (attempt ? "\n\n（上一次只写了【记住】、没写摘要正文。这次务必先写【摘要】和正文。）" : ""), timestamp: Date.now() }],
          }, { signal: sig, maxTokens: Math.max(model.maxTokens || 0, COMPACT_MAX_OUTPUT) }));
        if (signal?.aborted) throw new Error("已取消");          // 放弃等待之后才回来：别再改历史（下一轮可能已经在用了）
        const u = res.usage;
        if (u) store.recordUsage(key, "compact", { model: `${res.provider}/${res.model}`, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total ?? 0 });
        if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage || "摘要模型调用失败");
        const parsed = parseCompactOutput(stripThinkText(res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")));
        text = parsed.summary;
        if (!text && parsed.remembered.length) {
          console.log(`[agent] ⚠️  ${agent.id} 摘要第 ${i + 1}/${chunks.length} 段只有【记住】没有正文，拿记住的 ${parsed.remembered.length} 条当摘要`);
          text = parsed.remembered.map((r) => `- ${r.split("\n")[1]}`).join("\n");
        }
        if (text || attempt >= 1) { remembered.push(...parsed.remembered); break; }
        console.log(`[agent] ⚠️  ${agent.id} 摘要第 ${i + 1}/${chunks.length} 段为空（${res.stopReason}），再要一次`);
        }
        if (!text) throw new Error("摘要为空（两次都没写出正文）");
      } catch (e: any) {
        if (signal?.aborted) throw new Error("已取消");
        failed++;
        console.log(`[agent] ⚠️  ${agent.id} 摘要第 ${i + 1}/${chunks.length} 段失败，这段改记要点: ${e.message}`);
        // 兜底：不再每轮重试、让历史越积越大——留下这段里用户说过的话（各截一点），照样压掉
        const said = chunk.map((l) => l.match(/^\[(#m\d+)\] 用户：([\s\S]*)$/)).filter((x): x is RegExpMatchArray => !!x)
          .map((x) => "- " + Array.from(x[2].replace(/^\[[^\]]*\]\s*/, "")).slice(0, 60).join("") + `（${x[1]}）`).slice(-12);
        text = [summary, `（有一段较早的对话没能总结，用户当时说过：）`, ...said].filter(Boolean).join("\n");
      }
      summary = text;
    }
    if (failed === chunks.length && !summary.trim()) throw new Error("摘要为空");
    store.compact(key, old.at(-1)!.id, summary);
    const wrote: { target: string; text: string }[] = [];
    for (const r of remembered.slice(0, 20)) {
      const [t, text] = r.split("\n");
      const target = t === "主人" ? "user" : t === "长期" ? "long" : "daily";
      wrote.push({ target, text });
      // 后台会话（heartbeat / 定时任务 / 待办）压缩时记下的「今天：」带上标记，聊天时不进系统提示
      const tag = key.endsWith(":heartbeat") ? "heartbeat" : key.includes(":cron:") ? "定时任务" : key.includes(":task:") ? "待办" : "";
      try { this.rt.remember?.(agent, target, text, tag); } catch (e: any) { console.log(`[agent] ⚠️  ${agent.id} 记忆写入失败: ${e.message}`); }
    }
    console.log(`[agent] 🗜️  ${agent.id} ${key} 压缩 ${old.length} 条（${chunks.length} 段${failed ? `，${failed} 段没总结成` : ""}）→ 摘要 ${Array.from(summary).length} 字${remembered.length ? `，记下 ${remembered.length} 条` : ""}`);
    // 摘要里带了几处出处编号（#m123）：没带的话她以后只能靠关键词搜原文（运行状况里看得到比例）
    const refs = new Set(summary.match(/#m\d+/g) ?? []).size;
    if (!refs) console.log(`[agent] ℹ️  ${agent.id} ${key} 这次的摘要没带出处编号（摘要模型没照做）`);
    health.record({ kind: "compact", ok: !failed, agent: agent.id, session: key, ms: Date.now() - t0, detail: { trigger, chunks: chunks.length, failed, messages: old.length, refs } });
    // 会话页「系统事件」：什么时候、为什么压的，压了多少、剩多少，顺手记进了哪些记忆
    try {
      const sum = (a: Message[]) => a.reduce((n, m) => n + msgTokens(m), 0);
      store.addEvent(key, "compact", {
        trigger, size: why?.size, limit: why?.limit, ms: Date.now() - t0, model: `${model.provider}/${model.id}`,
        messages: old.length, oldTokens: sum(eff.slice(0, cut)), kept: hist.length - cut, keptTokens: sum(eff.slice(cut)),
        chunks: chunks.length, failed, summary: Array.from(summary).length, refs, remembered: wrote,
      });
    } catch { /* 记不下就算了 */ }
    return true;
  }
}
