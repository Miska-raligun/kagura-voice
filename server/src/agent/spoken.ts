// 把已经以文字发出去的回复转成适合朗读的一段（没写朗读版时的兜底）。从 runtime.ts 拆出来的。
import type { Runtime } from "./runtime.ts";
import { withScope } from "./scope.ts";
import { health } from "./health.ts";
import { toSpoken } from "../util/text.ts";

/**
 * 已经以文字发出去的回复（IM、网页、投到 IM 的任务）要顺带念时，转成适合朗读的一段。
 * 去掉格式后不超过 agent 的语音字数（voice_max_chars，留两成余量）就直接念；更长的交给便宜模型压成口语，
 * 失败或超时退回截断。
 */
export async function spokenText(rt: Runtime, agentId: string, text: string): Promise<string> {
  const agent = rt.agents.get(agentId);
  const max = agent?.voice_max_chars || 80;
  const plain = toSpoken(text, 100_000);
  if (!plain || Array.from(plain).length <= max * 1.2 || !agent) {
    if (plain) console.log(`[agent] 🔈 ${agentId} 回复不长（${Array.from(plain).length} 字），直接念`);
    if (plain && agent) health.record({ kind: "voice", ok: true, agent: agentId, detail: { via: "short" } });
    return plain;
  }
  const t0 = Date.now();
  let modelRef = "";
  // 不开思考 20 秒；按模型设置开着思考的给 60 秒（文字早就发出去了，等的只是这段语音）
  let limit = 20_000;
  try {
    const model = rt.models.resolve(rt.models.voiceRef() || agent.cheap_model || rt.models.cheapRef() || agent.model);
    modelRef = `${model.provider}/${model.id}`;
    const lv = rt.models.thinkingOf(model);
    const think = !!lv && lv !== "off";
    if (think) limit = 60_000;
    console.log(`[agent] 🔈 ${agentId} 回复 ${Array.from(plain).length} 字、没写朗读版，用 ${modelRef}${think ? `（思考：${lv}）` : ""}压成口语…`);
    const res = await Promise.race([
      withScope({ agentId, sessionKey: `${agentId}:voice`, kind: "isolated", channel: "system", purpose: "voice", hop: 0, chain: [], meta: {}, trusted: false },
        () => rt.models.quick(model, {
          systemPrompt: `你是${agent.name}。下面是你刚用文字发给主人的回复，现在要在家里的设备上用语音念出来。`
            + `把它改写成适合朗读的口语，不超过 ${max} 字：保留结论和关键数字，省略细节、列表、代码和网址；`
            + "不要用 markdown、表情符号；内容放不下时最后说一句「详细的我发在消息里了」。只输出要念的话本身。",
          messages: [{ role: "user", content: text.slice(0, 6000), timestamp: Date.now() }],
        }, { signal: AbortSignal.timeout(limit), think })),           // 到时真的中止请求，别在后台接着想
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("超时")), limit)),
    ]);
    if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage || "模型调用失败");
    const out = toSpoken(res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""), max * 2);
    const u = res.usage;
    if (u) rt.store(agentId).recordUsage(`${agentId}:voice`, "voice", { model: `${res.provider}/${res.model}`, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total ?? 0 });
    if (out) {
      console.log(`[agent] 🔈 ${agentId} 压成口语 ${Array.from(out).length} 字（${modelRef}，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      health.record({ kind: "voice", ok: true, agent: agentId, ms: Date.now() - t0, detail: { via: "summary", model: modelRef } });
      return out;
    }
    throw new Error(`模型没写出正文（${res.stopReason}）`);
  } catch (e: any) {
    const ms = Date.now() - t0;
    // 到时请求被中止，服务商那边报的是「This operation was aborted」，这里写明白是超时
    const why = ms >= limit - 500 ? `超时（${limit / 1000} 秒没写完${/abort/i.test(String(e.message)) ? "，请求已中止" : ""}）` : e.message;
    console.log(`[agent] ⚠️  ${agentId} 语音摘要失败，改为截断（${modelRef || "?"}，${(ms / 1000).toFixed(1)}s）: ${why}`);
    health.record({ kind: "voice", ok: false, agent: agentId, ms, detail: { via: "cut", model: modelRef, why: String(why).slice(0, 200) } });
  }
  return toSpoken(text, max);
}
