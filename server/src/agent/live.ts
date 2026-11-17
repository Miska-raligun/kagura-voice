// 会话页的实时过程：每轮留一份实时记录，谁打开会话页谁订阅。从 runtime.ts 拆出来的。
import { stripRecall } from "./messages.ts";
import { unvoice } from "./voicetap.ts";

/** 会话页实时看到的一轮：已完成的消息 + 正在生成的思考 / 正文 + 正在执行的工具 */
export interface LiveRun { purpose: string; channel: string; since: number; messages: any[]; partial: { thinking: string; text: string }; tools: string[]; trace?: string }
export type LiveEvent =
  | { type: "idle" } | { type: "start"; run: LiveRun } | { type: "end"; error?: string }
  | { type: "delta"; kind: "text" | "thinking"; delta: string } | { type: "message"; message: any } | { type: "tool"; name: string; running: boolean };
const LIVE_TEXT_MAX = 8000;
/** 推给页面的消息：去掉自动回忆、图片只留占位、超长工具结果截短 */
export function liveMessage(m: any): any {
  m = unvoice(m);
  const x = stripRecall(m) as any;
  if (!Array.isArray(x.content)) return x;
  return {
    ...x,
    content: x.content.map((c: any) => c.type === "image" ? { type: "image", mimeType: c.mimeType }
      : c.type === "text" && x.role === "toolResult" && c.text.length > LIVE_TEXT_MAX ? { ...c, text: c.text.slice(0, LIVE_TEXT_MAX) + `\n…（共 ${c.text.length} 字）` } : c),
  };
}

export class LiveHub {
  /** 正在跑的每一轮的实时记录（key = agent|会话） */
  runs = new Map<string, LiveRun>();
  private subs = new Map<string, Set<(e: LiveEvent) => void>>();

  /** 订阅：先给快照（start / idle），之后推增量。返回取消订阅 */
  watch(key: string, fn: (e: LiveEvent) => void): () => void {
    let set = this.subs.get(key);
    if (!set) this.subs.set(key, (set = new Set()));
    set.add(fn);
    const cur = this.runs.get(key);
    fn(cur ? { type: "start", run: cur } : { type: "idle" });
    return () => { set!.delete(fn); if (!set!.size) this.subs.delete(key); };
  }
  emit(key: string, e: LiveEvent) {
    for (const fn of this.subs.get(key) ?? []) { try { fn(e); } catch { /* 页面断开了 */ } }
  }
}
