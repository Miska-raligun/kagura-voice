// agent 管待办（见 ../tasks.ts）：task_add / task_list / task_update / task_cancel。
// 只在可信会话里有（待办会在夜里不受看管地跑、能执行命令，陌生人不能往里塞活）；执行待办的那一轮也没有（别自己给自己续活）。
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunScope } from "../scope.ts";
import type { AgentInfo } from "../registry.ts";
import { nextWindowStart, type Task, type TaskQueue } from "../tasks.ts";
import { parseAt } from "./cron.ts";
import { ok, fail } from "./device.ts";

const fmt = (s: number) => new Date(s * 1000).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** when：省略 / tonight = 下一个静默时段；now = 马上（后台做）；其它同 cron 的一次性时间（+2h、23:30、2026-10-28 09:00） */
export function parseWhen(when: string | undefined): number | null {
  const w = String(when ?? "").trim().toLowerCase();
  if (!w || w === "tonight" || w === "今晚" || w === "夜里" || w === "晚上") return null;
  if (w === "now" || w === "现在" || w === "马上") return Date.now() / 1000;
  return parseAt(when!);
}

export function taskTools(q: TaskQueue) {
  return (scope: RunScope, agent: AgentInfo): AgentTool<any>[] => {
    if (!scope.trusted || scope.purpose === "task" || scope.kind === "sub") return [];
    const s = q.settings();
    const when = (t: Task) => t.status !== "queued" ? t.status
      : t.run_at !== null ? fmt(t.run_at) : `静默时段（${s.auto ? fmt(nextWindowStart(s.window)) + " 起" : "已关自动执行，等主人手动开"}）`;
    const brief = (t: Task) => ({ id: t.id, title: t.title, status: t.status, when: when(t), result: t.status === "done" ? t.result.slice(0, 300) : t.error || undefined });
    const mine = (id: string) => { const t = q.get(id); return t && t.agent === agent.id ? t : null; };
    const origin = scope.origin || (scope.channel === "webchat" ? "webchat" : scope.deviceId ? `device:${scope.deviceId}` : "");
    return [
      {
        name: "task_add", label: "记待办",
        description: `把又大又不急的活记成待办，安排到夜间静默时段（${s.window}）再做，白天的额度留给聊天：改代码修 bug、整理资料、批量处理文件、写长文档这类。`
          + "主人说「现在就做」、或者几分钟就能做完的小事，直接做，别记待办。"
          + "到点要说的话、提醒、周期性的事用 cron_add，不用待办。"
          + "detail 要写清楚目标、相关文件路径 / 链接、做到什么程度算完——到时候是另一个你在全新上下文里做，看不到现在的聊天。"
          + "when 省略 = 今晚静默时段；也可以 now（马上在后台做）、+2h、23:30、2026-10-28 09:00。做完的结果会在早上汇报给主人。",
        parameters: Type.Object({ title: Type.String(), detail: Type.String(), when: Type.Optional(Type.String()) }),
        async execute(_id, p: any) {
          try {
            const t = q.add({ agent: agent.id, title: p.title, detail: p.detail, run_at: parseWhen(p.when), origin, trusted: true, source: "agent" });
            return ok(`已记下：${JSON.stringify(brief(t))}。告诉主人记下了、大概什么时候做。`);
          } catch (e: any) { return fail(e.message); }
        },
      },
      {
        name: "task_list", label: "待办列表", description: "看你的待办：还在排队的、正在做的、最近做完的。",
        parameters: Type.Object({}),
        async execute() { return ok(JSON.stringify(q.list(agent.id).slice(0, 30).map(brief))); },
      },
      {
        name: "task_update", label: "改待办", description: "改一件还在排队的待办：title / detail / when（同 task_add）。",
        parameters: Type.Object({ id: Type.String(), title: Type.Optional(Type.String()), detail: Type.Optional(Type.String()), when: Type.Optional(Type.String()) }),
        async execute(_id, p: any) {
          if (!mine(p.id)) return fail("没有这件待办（或不是你的）");
          try {
            const t = q.update(p.id, { title: p.title, detail: p.detail, ...(p.when !== undefined ? { run_at: parseWhen(p.when) } : {}) });
            return ok(`已修改：${JSON.stringify(brief(t))}`);
          } catch (e: any) { return fail(e.message); }
        },
      },
      {
        name: "task_cancel", label: "撤销待办", description: "撤销一件待办（正在做的会中止）。",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_id, p: any) {
          if (!mine(p.id)) return fail("没有这件待办（或不是你的）");
          try { q.cancel(p.id); return ok("已撤销"); } catch (e: any) { return fail(e.message); }
        },
      },
    ];
  };
}
