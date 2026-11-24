// 单轮上限（TurnGuard）：工具调用次数、token、同参数重复调用三道闸。从 runtime.ts 拆出来的。
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { health } from "./health.ts";

export const DEFAULT_MAX_TOOL_CALLS = 80;
/** 以前的默认（40）：配置里原样存着的当成没改过、跟新默认走（管理界面保存「运行时」时会把默认值写进去） */
export const OLD_DEFAULT_MAX_TOOL_CALLS = 40;
/**
 * 单轮 token 上限的默认值，配置填 0 = 不限。算的是**这一轮新增的**：每次调模型时上下文比上一次多出来的（工具结果、她写的）+ 输出，
 * 不算每次重发的那整段上下文（2026-11-24，主人「飞书里复杂任务一直做不完，每次让它继续，它读了进度就停了」：
 * 以前按服务商报的输入 + 缓存读写 + 输出累加，主会话上下文 8~10 万的时候，每调一次模型就算 8~10 万，二十来次就到 200 万——
 * 读几个进度文件额度就用完了，被叫停汇报；下一轮「继续」又从头读进度，又用完。上下文越大越干不了活，跟她做了多少事无关）
 */
export const DEFAULT_MAX_TURN_TOKENS = 2_000_000;
/** 用到上限的这么多，提醒她先把进度记下来（下一轮「继续」从记下的地方接着，不用从头读一遍） */
const WARN_AT = 0.8;
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
  /** 这一轮新增的 token（上下文增长 + 输出），上限按它算 */
  tokens = 0;
  /** 服务商报的全部（含每次重发的上下文、缓存读写）：只用来打日志 */
  billed = 0;
  reason = "";
  private lastCtx = 0;
  private warned = false;
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
        if (this.reason) return { content: [{ type: "text", text: `[系统] ${this.reason}，已叫停。不要再调用任何工具，直接用文字告诉主人：开头说一句「这一轮到了单轮上限（${this.reason}）」，然后说做到哪了、还剩什么、下一步从哪接着做——主人回「继续」时你照着这个接着做，不用从头再读一遍。剩下的还很多的话，问主人要不要记成待办在后台做完。` }], details: { guard: true }, isError: true } as any;
        const key = `${t.name}:${JSON.stringify(params ?? {})}`;
        const n = (this.seen.get(key) ?? 0) + 1;
        this.seen.set(key, n);
        if (n >= REPEAT_LIMIT) {
          return { content: [{ type: "text", text: `[系统] 这一轮你已经用完全相同的参数调过 ${t.name} ${n - 1} 次了，结果不会变。换个思路，或者直接回复主人现在的情况。` }], details: { guard: true }, isError: true } as any;
        }
        const res = await (t.execute as any).call(t, id, params, ...rest);
        // 快到上限：在这次工具结果后面提醒一句（一轮一次），让她先把进度记下来
        if (!this.warned && (this.calls >= this.maxCalls * WARN_AT || this.tokens >= this.maxTokens * WARN_AT)) {
          this.warned = true;
          const left = Math.max(0, this.maxCalls - this.calls);
          const note = `[系统] 这一轮的额度快用完了（工具调用还剩 ${left} 次）。事情还没做完的话，先把做到哪、下一步要做什么记下来（写进进度文件或任务清单），再接着做；到了上限会叫停，主人说「继续」时从记下的地方接着，不用从头读一遍。`;
          if (res && Array.isArray(res.content)) return { ...res, content: [...res.content, { type: "text", text: note }] };
        }
        return res;
      },
    });
  }

  /** 每次模型回复后调用；返回 true = 该强制中止了 */
  afterModel(u: any, hasCalls: boolean): boolean {
    if (u) {
      const ctx = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      // 这次的上下文比上次多出来的（第一次算整段：一轮的起点）；截短旧工具结果后变小了不算负的
      this.tokens += Math.max(0, ctx - this.lastCtx) + (u.output ?? 0);
      this.lastCtx = ctx;
      this.billed += ctx + (u.output ?? 0);
    }
    if (this.reason) return hasCalls && ++this.afterStop > GUARD_GRACE;
    if (this.tokens > this.maxTokens) this.halt(`本轮新增内容已有 ${Math.round(this.tokens / 1000)}k token，超过上限 ${Math.round(this.maxTokens / 1000)}k`);
    return false;
  }
}

/** 单轮上限叫停后她还不停、被强制中止时的报错开头（待办据此判断「额度用完了」而不是真出错） */
export const GUARD_STOP = "agent 停下了：";
