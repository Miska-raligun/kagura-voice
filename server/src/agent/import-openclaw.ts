// 从 OpenClaw 导入（§8）：人设/记忆 markdown 原样拷贝，定时任务转换成本系统的任务定义。
// 导入的任务默认暂停，作者在管理界面逐条确认再启用。
//
// OpenClaw 的任务存储（~/.openclaw/cron/jobs.json）各版本字段名有出入，这里宽松解析：
//   schedule: {kind:"cron", expr, tz} | {kind:"every", everyMs} | {kind:"at", atMs | at(ISO)}
//   payload:  {kind:"agentTurn", message} | {kind:"systemEvent", text}
//   sessionTarget: "main" | "isolated"；agentId
import fs from "node:fs";
import path from "node:path";
import type { AgentRegistry } from "./registry.ts";
import { SOUL_FILES } from "./registry.ts";
import type { Scheduler, Schedule } from "./scheduler.ts";

export interface ImportReport {
  files: { agent: string; copied: string[]; from: string }[];
  jobs: { imported: { id: string; name: string; agent: string }[]; skipped: { name: string; reason: string }[] };
}

/** 按 OpenClaw 的几种布局找某个 agent 的 workspace */
function workspaceCandidates(dir: string, agentId: string, isDefault: boolean) {
  const c = [path.join(dir, `workspace-${agentId}`), path.join(dir, "agents", agentId, "workspace")];
  if (isDefault || agentId === "main") c.unshift(path.join(dir, "workspace"));
  return c;
}

function readJobs(dir: string): any[] {
  for (const f of [path.join(dir, "cron", "jobs.json"), path.join(dir, "cron.json"), path.join(dir, "automations", "jobs.json")]) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, "utf8"));
      const list = Array.isArray(raw) ? raw : raw.jobs ?? raw.items ?? [];
      if (Array.isArray(list)) return list;
    } catch { /* 下一个 */ }
  }
  return [];
}

export function convertSchedule(s: any): Schedule {
  if (!s) throw new Error("没有 schedule");
  const kind = s.kind ?? s.type;
  if (kind === "cron") return { kind: "cron", expr: String(s.expr ?? s.cron ?? s.expression), ...(s.tz ? { tz: s.tz } : {}) };
  if (kind === "every" || kind === "interval") {
    const ms = Number(s.everyMs ?? s.intervalMs ?? (s.everySeconds ?? s.seconds) * 1000);
    if (!Number.isFinite(ms) || ms <= 0) throw new Error("every 缺少间隔");
    return { kind: "every", every_secs: Math.round(ms / 1000), ...(s.anchorMs ? { anchor: s.anchorMs / 1000 } : {}) };
  }
  if (kind === "at" || kind === "once") {
    const ms = typeof s.atMs === "number" ? s.atMs : Date.parse(s.at ?? s.time);
    if (!Number.isFinite(ms)) throw new Error("at 缺少时间");
    return { kind: "at", at: ms / 1000 };
  }
  throw new Error(`不认识的 schedule: ${JSON.stringify(s)}`);
}

export function importOpenClaw(dir: string, agents: AgentRegistry, sched: Scheduler | null, opts: { overwrite?: boolean } = {}): ImportReport {
  if (!fs.existsSync(dir)) throw new Error(`找不到 OpenClaw 目录 ${dir}`);
  const report: ImportReport = { files: [], jobs: { imported: [], skipped: [] } };
  const def = agents.default();
  for (const a of agents.list()) {
    const from = workspaceCandidates(dir, a.id, a.id === def.id).find((p) => fs.existsSync(p));
    if (!from) continue;
    const copied: string[] = [];
    for (const f of SOUL_FILES) {
      const src = path.join(from, f);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(a.workspace, f));
      copied.push(f);
    }
    const mem = path.join(from, "memory");
    if (fs.existsSync(mem)) {
      for (const f of fs.readdirSync(mem)) {
        if (!f.endsWith(".md")) continue;
        const dst = path.join(a.workspace, "memory", f);
        if (fs.existsSync(dst) && !opts.overwrite) continue;
        fs.copyFileSync(path.join(mem, f), dst);
        copied.push(`memory/${f}`);
      }
    }
    report.files.push({ agent: a.id, copied, from });
  }
  if (sched) {
    for (const j of readJobs(dir)) {
      const name = String(j.name ?? j.id ?? "未命名");
      try {
        const agent = agents.get(j.agentId ?? j.agent ?? "") ? (j.agentId ?? j.agent) : def.id;
        const p = j.payload ?? {};
        const kind = p.kind === "systemEvent" ? "systemEvent" : "agentTurn";
        const message = String(p.message ?? p.text ?? j.message ?? "").trim();
        if (!message) throw new Error("没有提示词");
        const id = `oc-${String(j.id ?? name).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || Math.random().toString(36).slice(2, 8)}`;
        if (sched.get(id)) { report.jobs.skipped.push({ name, reason: "已导入过" }); continue; }
        sched.add({
          id, agent, name, enabled: false, schedule: convertSchedule(j.schedule), kind,
          session: j.sessionTarget === "main" || kind === "systemEvent" ? "main" : "isolated",
          // OpenClaw 的任务多半在提示词里让 agent 自己用 cores3-speak 播报——本系统对应 speak 工具，不再额外投递
          message, delivery: "none", source: "openclaw",
        });
        report.jobs.imported.push({ id, name, agent });
      } catch (e: any) {
        report.jobs.skipped.push({ name, reason: e.message });
      }
    }
  }
  return report;
}
