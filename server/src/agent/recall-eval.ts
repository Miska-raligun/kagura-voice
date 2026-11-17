// 自动回忆的评测（2026-11）：改检索的阈值、切词、切块之前先有个数——不然只能靠「感觉好像准了一点」。
//
// 用例 = 主人的一句话（可带前文）+ 这句话应该让哪条记忆被附上（写记忆里的一小段原文；留空 = 这句话不该附任何记忆）。
// 存在 agent 目录的 recall_eval.json，管理界面「记忆」页里加、改、跑。
// 候选从真实会话里挖：某一轮她自己去调了 memory_search / memory_get，说明自动回忆没把她要的东西附上——这就是现成的「漏了」的信号。
import fs from "node:fs";
import path from "node:path";
import type { AgentStore } from "./store.ts";
import type { MemoryIndex } from "./memory.ts";
import { plainOf } from "./messages.ts";

export interface RecallCase { q: string; context?: string; expect: string; note?: string }
export interface RecallCaseResult extends RecallCase { ok: boolean; hits: string[]; rank: number }
export interface RecallCandidate { session: string; ts: number; q: string; context: string; searched: string[]; attached: string[] }

const fileOf = (agentDir: string) => path.join(agentDir, "recall_eval.json");
export const MAX_CASES = 200;

export function loadCases(agentDir: string): RecallCase[] {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(agentDir), "utf8"));
    return Array.isArray(j) ? j.filter((c) => c && typeof c.q === "string" && typeof c.expect === "string") : [];
  } catch { return []; }
}

export function saveCases(agentDir: string, cases: unknown): RecallCase[] {
  if (!Array.isArray(cases)) throw new Error("cases 要是数组");
  const clean = cases.slice(0, MAX_CASES).map((c: any) => ({
    q: String(c?.q ?? "").trim().slice(0, 500), expect: String(c?.expect ?? "").trim().slice(0, 200),
    ...(String(c?.context ?? "").trim() ? { context: String(c.context).trim().slice(0, 500) } : {}),
    ...(String(c?.note ?? "").trim() ? { note: String(c.note).trim().slice(0, 200) } : {}),
  })).filter((c) => c.q);
  fs.writeFileSync(fileOf(agentDir), JSON.stringify(clean, null, 1));
  return clean;
}

/** 跑一遍：expect 非空 = 附上的记忆里要有一条包含它（rank = 第几条）；expect 为空 = 一条都不该附 */
export async function runCases(idx: MemoryIndex, cases: RecallCase[]) {
  const results: RecallCaseResult[] = [];
  for (const c of cases) {
    const hits = (await idx.recall(c.q, { context: c.context })).map((h) => h.text);
    const rank = c.expect ? hits.findIndex((t) => t.includes(c.expect)) + 1 : 0;
    results.push({ ...c, hits, rank, ok: c.expect ? rank > 0 : hits.length === 0 });
  }
  const pos = results.filter((r) => r.expect), neg = results.filter((r) => !r.expect);
  return {
    results,
    summary: {
      total: results.length, passed: results.filter((r) => r.ok).length,
      // 该附的附上了多少；不该附的有多少没乱附
      recall: pos.length ? pos.filter((r) => r.ok).length / pos.length : null,
      quiet: neg.length ? neg.filter((r) => r.ok).length / neg.length : null,
    },
  };
}

/**
 * 从最近的会话里挖候选：主人说了一句话，这一轮里她自己调了记忆工具去找（query / path），
 * 就把「这句话 + 她搜的词 + 当时自动附上了什么」列出来，主人看一眼、填上应该命中的那条记忆，就是一条用例。
 */
export function mineCandidates(store: AgentStore, limit = 30): RecallCandidate[] {
  const out: RecallCandidate[] = [];
  for (const s of store.listSessions(40)) {
    const rows = store.transcript(s.key, 300);
    let user: { text: string; ts: number } | null = null, prev = "", searched: string[] = [];
    const flush = (attached: string[]) => {
      if (user && searched.length) out.push({ session: s.key, ts: user.ts, q: user.text, context: prev, searched: [...new Set(searched)].slice(0, 5), attached });
      searched = [];
    };
    let attached: string[] = [];
    for (const r of rows) {
      const m: any = r.msg;
      if (r.role === "user") {
        flush(attached);
        attached = [];
        const text = plainOf(m).trim();
        // 系统替主人发起的（heartbeat、定时任务、通知…）不算主人说的话
        if (!text || /^\s*\[/.test(text)) { user = null; continue; }
        prev = user?.text ?? "";
        user = { text: text.slice(0, 300), ts: r.ts };
      } else if (r.role === "assistant") {
        for (const c of m.content ?? []) {
          if (c.type !== "toolCall") continue;
          if (c.name === "memory_search" && c.arguments?.query) searched.push(String(c.arguments.query).slice(0, 80));
          else if (c.name === "memory_get" && /MEMORY\.md|memory\//.test(String(c.arguments?.path ?? ""))) searched.push(`读 ${String(c.arguments.path).slice(0, 60)}`);
        }
        const hits = m.kctx?.recall?.hits;
        if (Array.isArray(hits)) attached = hits.map((h: unknown) => String(h).slice(0, 120));
      }
    }
    flush(attached);
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}
