// 单轮上限（TurnGuard）：工具调用次数、token、同参数重复调用三道闸。从 runtime.ts 拆出来的。
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { health } from "./health.ts";

export const DEFAULT_MAX_TOOL_CALLS = 40;
/** 单轮 token 上限的默认值（含缓存读写，每次调模型都重发整段上下文，所以涨得快）；配置填 0 = 不限 */
export const DEFAULT_MAX_TURN_TOKENS = 2_000_000;
/** 叫停之后还容她几次模型调用（用来写汇报）；还在调工具就强制中止 */
const GUARD_GRACE = 2;
/** 同一工具同样参数在一轮里第几次就拒绝 */
const REPEAT_LIMIT = 3;

/**
 * 单轮上限（LRN 2026-10-30）：模型兜圈子时（同一条命令反复跑、换着花样试却一直不回复），以前只有超时管它——
 * 「无进展超时」被每次工具调用刷新，总时长上限又有半小时，这期间每次调模型都把整段上下文重发一遍，token 烧得飞快。
 * 三道闸：工具调用次数、本轮 token（含缓存读写）、同参数重复调用。到了先「软停」：之后的工具调用一律返回
 * 「别再调工具，直接告诉主人做到哪了」，让她自己收尾回复；再给 GUARD_GRACE 次还在调工具就强制中止。
 */
export class TurnGuard {
  calls = 0;
  tokens = 0;
  reason = "";
  private seen = new Map<string, number>();
  private afterStop = 0;
  constructor(private maxCalls: number, private maxTokens: number, private label: string) {}

  halt(why: string) {
    if (this.reason) return;
    this.reason = why;
    console.log(`[agent] 🔁 ${this.label} ${why}，叫她停手汇报`);
    const [agent, session] = this.label.split(" ");
    health.record({ kind: "guard", ok: false, agent, session, detail: { why } });
  }

  wrap<T extends AgentTool<any>>(t: T): T {
    return Object.assign(Object.create(Object.getPrototypeOf(t)), t, {
      execute: async (id: string, params: any, ...rest: any[]) => {
        this.calls++;
        if (this.calls > this.maxCalls) this.halt(`本轮工具调用超过 ${this.maxCalls} 次`);
        if (this.reason) return { content: [{ type: "text", text: `[系统] ${this.reason}，已叫停。不要再调用任何工具，直接用文字告诉主人：做到哪了、卡在哪、接下来打算怎么办。` }], details: { guard: true }, isError: true } as any;
        const key = `${t.name}:${JSON.stringify(params ?? {})}`;
        const n = (this.seen.get(key) ?? 0) + 1;
        this.seen.set(key, n);
        if (n >= REPEAT_LIMIT) {
          return { content: [{ type: "text", text: `[系统] 这一轮你已经用完全相同的参数调过 ${t.name} ${n - 1} 次了，结果不会变。换个思路，或者直接回复主人现在的情况。` }], details: { guard: true }, isError: true } as any;
        }
        return (t.execute as any).call(t, id, params, ...rest);
      },
    });
  }

  /** 每次模型回复后调用；返回 true = 该强制中止了 */
  afterModel(u: any, hasCalls: boolean): boolean {
    if (u) this.tokens += (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    if (this.reason) return hasCalls && ++this.afterStop > GUARD_GRACE;
    if (this.tokens > this.maxTokens) this.halt(`本轮已用 ${Math.round(this.tokens / 1000)}k token，超过上限 ${Math.round(this.maxTokens / 1000)}k`);
    return false;
  }
}

/** 单轮上限叫停后她还不停、被强制中止时的报错开头（待办据此判断「额度用完了」而不是真出错） */
export const GUARD_STOP = "agent 停下了：";
