// 监工（借鉴 DeepSeek Super-agent 的 Watchdog，2026-11）：单轮上限（TurnGuard）只按次数和 token 硬拦，
// 兜圈子要烧到上限才停——待办单件可以跑一两个小时、额度是对话的 3 倍。这里每分钟看一眼正在跑的轮次，
// 跑了 WATCH_AFTER_MS 以上的，把最近几步（工具调用、结果开头、她说的话）交给便宜模型判断「在推进」还是「在兜圈子」，
// 连着 STRIKES 次判兜圈子才软停（同 TurnGuard：之后的工具调用都返回「别再调了，汇报做到哪了」），一次误判不会打断正常干活。
// 待办被监工叫停不再续额度（tasks.ts 认 WATCHDOG_TAG）。
import type { Runtime } from "./runtime.ts";
import type { ModelRegistry } from "./models.ts";
import { health } from "./health.ts";

/** 跑了多久开始看 */
export const WATCH_AFTER_MS = 8 * 60_000;
/** 同一轮隔多久再看一次 */
export const WATCH_EVERY_MS = 5 * 60_000;
/** 连着几次判兜圈子才叫停 */
export const STRIKES = 2;
/** 叫停原因的开头（待办据此不续额度） */
export const WATCHDOG_TAG = "监工判断在兜圈子";

const PROMPT = "你是监工，看一个 AI 助手正在执行的任务的最近几步，判断它是在推进还是在兜圈子。"
  + "兜圈子 = 反复做同样或差不多的尝试却没有新进展、来回改同一处、一直在查却不动手、偏离了任务。"
  + "正常的长任务（一步步往下做、每步结果不同）是推进。拿不准就算推进。"
  + "只回一行：「推进」或「兜圈子：一句话原因」。";

const clip = (s: string, n: number) => { const a = Array.from(s.replace(/\s+/g, " ").trim()); return a.length > n ? a.slice(0, n).join("") + "…" : a.join(""); };

/** 实时记录里最近几步，压成给监工看的文字 */
export function digestOf(messages: any[], max = 16): string {
  const lines: string[] = [];
  for (const m of messages.slice(-max)) {
    if (m.role === "user") lines.push(`[任务/消息] ${clip((m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" "), 300)}`);
    else if (m.role === "assistant") {
      for (const c of m.content ?? []) {
        if (c.type === "text" && c.text.trim()) lines.push(`[它说] ${clip(c.text, 200)}`);
        if (c.type === "toolCall") lines.push(`[调用] ${c.name} ${clip(JSON.stringify(c.arguments ?? {}), 200)}`);
      }
    } else if (m.role === "toolResult") {
      const t = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
      lines.push(`[结果${m.isError ? "·出错" : ""}] ${clip(t, 200)}`);
    }
  }
  return lines.join("\n");
}

export class Watchdog {
  private seen = new Map<string, { at: number; strikes: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  constructor(private rt: Runtime, private models: ModelRegistry, private enabled: () => boolean = () => true,
    private t: { afterMs: number; everyMs: number } = { afterMs: WATCH_AFTER_MS, everyMs: WATCH_EVERY_MS }) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** 看一遍；返回这次叫停了哪些（测试用） */
  async tick(now = Date.now()): Promise<string[]> {
    if (this.busy || !this.enabled()) return [];
    this.busy = true;
    const halted: string[] = [];
    try {
      const runs = this.rt.activeRuns();
      const alive = new Set<string>();
      for (const r of runs) {
        const id = `${r.key}@${Math.round(now / 1000 - r.secs)}`;
        alive.add(id);
        if (r.secs * 1000 < this.t.afterMs || r.waiting_for || r.cancelling) continue;
        const prev = this.seen.get(id);
        if (prev && now - prev.at < this.t.everyMs) continue;
        const live = this.rt.liveOf(r.key);
        const digest = live ? digestOf(live.messages) : "";
        if (!digest) continue;
        const st = { at: now, strikes: prev?.strikes ?? 0 };
        this.seen.set(id, st);
        const verdict = await this.judge(digest).catch((e) => { console.log(`[watchdog] ⚠️  判断失败（这次不算）: ${e.message}`); return null; });
        if (!verdict) continue;
        if (!verdict.drifting) { st.strikes = 0; continue; }
        st.strikes++;
        console.log(`[watchdog] 👀 ${r.key} 跑了 ${Math.round(r.secs / 60)} 分钟，像在兜圈子（${st.strikes}/${STRIKES}）：${verdict.why}`);
        if (st.strikes < STRIKES) continue;
        if (this.rt.haltRun(r.key, `${WATCHDOG_TAG}（${verdict.why}）`)) {
          halted.push(r.key);
          health.record({ kind: "watchdog", ok: true, agent: r.agent, session: r.session, purpose: r.purpose, ms: r.secs * 1000, detail: { why: verdict.why } });
        }
      }
      for (const k of [...this.seen.keys()]) if (!alive.has(k)) this.seen.delete(k);
    } finally { this.busy = false; }
    return halted;
  }

  private async judge(digest: string): Promise<{ drifting: boolean; why: string }> {
    const model = this.models.resolve(this.models.cheapRef());
    const res = await this.models.quick(model, {
      systemPrompt: PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: digest }], timestamp: Date.now() }],
    } as any, { maxTokens: 200, signal: AbortSignal.timeout(30_000) });
    const text = res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
    const m = text.match(/兜圈子[:：]?\s*(.*)/);
    return m ? { drifting: true, why: clip(m[1] || "没有新进展", 60) } : { drifting: false, why: "" };
  }
}
