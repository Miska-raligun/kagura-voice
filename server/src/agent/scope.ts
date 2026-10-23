// 一次 agent 运行的上下文，用 AsyncLocalStorage 带着走：工具、假模型、嵌套调用（a2a）都能拿到
// 「现在是谁在哪个会话里、第几跳」，不用层层传参。
import { AsyncLocalStorage } from "node:async_hooks";

export interface RunScope {
  agentId: string;
  sessionKey: string;
  /** main / chat / isolated / sub */
  kind: string;
  /** device / webchat / system / a2a / feishu … */
  channel: string;
  deviceId?: string;
  /** 本轮回复会被直接播报到哪台设备（/chat 里就是说话的那台）：take_photo 走 X-Need-Photo */
  spokenTo?: string;
  localTime?: string;
  purpose: string;
  /** a2a 跳数与调用链（会话 key），防循环与死锁 */
  hop: number;
  chain: string[];
  /** 本轮工具对 HTTP 响应的影响（take_photo → X-Need-Photo，set_volume → X-Volume） */
  meta: { announced?: boolean; needPhoto?: boolean; volume?: string; photos?: string[] };
  /** 这轮消息从哪来、结果该送回哪：device:<id> / feishu:<账号>:<聊天> …（后台子任务完成后按它转达） */
  origin?: string;
  /**
   * 这轮能不能做高风险的事（执行命令）：主人在设备 / 网页 / 私聊里说的、定时任务和 heartbeat 算可信；
   * IM 里陌生人（配对用户、群聊）的消息不算。经 a2a 转手、或由它建的定时任务，都沿用发起方的可信度。
   */
  trusted: boolean;
  /** 假模型：工具结果回来后的续写脚本 */
  fakeAfterTool?: any;
}

const als = new AsyncLocalStorage<RunScope>();
export const runScope = () => als.getStore();
export const withScope = <T>(s: RunScope, fn: () => Promise<T>) => als.run(s, fn);
/** 脱离当前运行跑（后台派出的任务）：不再算嵌套调用，要占全局并发名额 */
export const outsideScope = <T>(fn: () => T) => als.exit(fn);
