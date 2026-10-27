// agent 自己管定时任务（§6.5）：cron_list / cron_add / cron_update / cron_remove / cron_run。
// 「每天早上八点给我讲新闻」→ agent 自己建一条 isolated、投递到设备的任务。只能管自己的任务。
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunScope } from "../scope.ts";
import type { AgentInfo } from "../registry.ts";
import type { Scheduler, Job, Schedule } from "../scheduler.ts";
import { parseDuration } from "../cron.ts";
import { ok, fail } from "./device.ts";

/** 一次性时间：+20m / 2026-10-24 08:00 / 2026-10-24T08:00 / 08:00（今天，过了就明天） */
export function parseAt(v: string, now = new Date()): number {
  const s = String(v).trim();
  if (s.startsWith("+")) return now.getTime() / 1000 + parseDuration(s.slice(1));
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date(now);
    d.setHours(+hm[1], +hm[2], 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime() / 1000;
  }
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime() / 1000;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t / 1000;
  throw new Error(`看不懂的时间: ${v}（例：+20m、08:00、2026-10-24 08:00）`);
}

export function scheduleFrom(kind: string, value: string, tz?: string): Schedule {
  if (kind === "at") return { kind: "at", at: parseAt(value) };
  if (kind === "every") return { kind: "every", every_secs: parseDuration(value) };
  if (kind === "cron") return { kind: "cron", expr: value, ...(tz ? { tz } : {}) };
  throw new Error("kind 只能是 at / every / cron");
}

const brief = (j: Job) => ({
  id: j.id, name: j.name, enabled: j.enabled, schedule: j.schedule, session: j.session, delivery: j.delivery,
  message: j.message, next_run: j.next_run ? new Date(j.next_run * 1000).toLocaleString("zh-CN", { hour12: false }) : null,
  last_status: j.last_status,
});

export function cronTools(sched: Scheduler) {
  return (scope: RunScope, agent: AgentInfo): AgentTool<any>[] => {
    const mine = (id: string) => { const j = sched.get(id); return j && j.agent === agent.id ? j : null; };
    const defaultDelivery = () => (scope.channel === "device" && scope.deviceId ? `device:${scope.deviceId}` : scope.deviceId ? `device:${scope.deviceId}` : agent.heartbeat.delivery || "none");
    return [
      {
        name: "cron_list", label: "定时任务列表", description: "列出你的定时任务。",
        parameters: Type.Object({}),
        async execute() { return ok(JSON.stringify(sched.list(agent.id).map(brief))); },
      },
      {
        name: "cron_add", label: "新建定时任务",
        description: "新建定时任务：到点要说的话、提醒、播报，以及周期性的事（每天讲新闻、每周发周报）。"
          + "改代码、整理资料、写长文档这类「干活」、不在乎具体几点的，用 task_add 记成待办（夜里排队做、早上汇报），别用一次性定时任务凑。"
          + "kind=at（一次性，value 如 +20m、08:00、2026-10-24 08:00）/ every（间隔，value 如 30m、2h）/ cron（5 段表达式，如 0 8 * * *）。"
          + "message 是到点时交给你执行的指令（写清楚要做什么）。session=isolated（默认，每次全新上下文）或 main。"
          + "delivery 默认投递到当前设备（device:<id>），none 表示不投递。",
        parameters: Type.Object({
          name: Type.String(), kind: Type.Union([Type.Literal("at"), Type.Literal("every"), Type.Literal("cron")]), value: Type.String(),
          message: Type.String(), session: Type.Optional(Type.Union([Type.Literal("isolated"), Type.Literal("main")])),
          delivery: Type.Optional(Type.String()), active_hours: Type.Optional(Type.String()), tz: Type.Optional(Type.String()),
        }),
        async execute(_id, p: any) {
          try {
            const j = sched.add({
              agent: agent.id, name: p.name, schedule: scheduleFrom(p.kind, p.value, p.tz), message: p.message,
              session: p.session ?? "isolated", delivery: p.delivery || defaultDelivery(), active_hours: p.active_hours ?? "", source: "agent",
              ...(scope.trusted ? {} : { untrusted: true }),
            });
            return ok(`已创建：${JSON.stringify(brief(j))}`);
          } catch (e: any) { return fail(e.message); }
        },
      },
      {
        name: "cron_update", label: "修改定时任务",
        description: "修改你的定时任务：name / message / enabled / delivery / active_hours，或同时给 kind+value 改时间。",
        parameters: Type.Object({
          id: Type.String(), name: Type.Optional(Type.String()), message: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()),
          delivery: Type.Optional(Type.String()), active_hours: Type.Optional(Type.String()),
          kind: Type.Optional(Type.Union([Type.Literal("at"), Type.Literal("every"), Type.Literal("cron")])), value: Type.Optional(Type.String()),
        }),
        async execute(_id, p: any) {
          if (!mine(p.id)) return fail("没有这个任务（或不是你的）");
          try {
            const { id, kind, value, ...rest } = p;
            const j = sched.update(id, { ...rest, ...(kind && value ? { schedule: scheduleFrom(kind, value) } : {}), ...(scope.trusted ? {} : { untrusted: true }) });
            return ok(`已修改：${JSON.stringify(brief(j!))}`);
          } catch (e: any) { return fail(e.message); }
        },
      },
      {
        name: "cron_remove", label: "删除定时任务", description: "删除你的一个定时任务。",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_id, p: any) {
          const j = mine(p.id);
          if (!j) return fail("没有这个任务（或不是你的）");
          if (j.kind === "heartbeat") return fail("heartbeat 不能删，只能由主人在管理界面关掉");
          sched.remove(j.id);
          return ok("已删除");
        },
      },
      {
        name: "cron_run", label: "立即运行定时任务", description: "马上运行一次你的某个定时任务（不影响原排期）。",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_id, p: any) {
          const j = mine(p.id);
          if (!j) return fail("没有这个任务（或不是你的）");
          if (j.session === "main") return fail("main 会话的任务不能在对话中立即运行（会和当前对话抢同一个会话）");
          const r = await sched.runNow(j.id);
          return r.status === "error" ? fail(`运行失败：${r.error}`) : ok(`运行完成（${r.status}）：${r.output}`);
        },
      },
    ];
  };
}
