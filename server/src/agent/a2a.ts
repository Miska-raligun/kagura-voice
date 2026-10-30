// 多 agent 通信（§6.6）：sessions_list / sessions_history / sessions_send / sessions_spawn。
//
// 权限：agent.json 的 a2a.allow（可以找谁）+ 全局 a2a.enabled。
// 防失控：
//   - 跳数：每跨一次 agent +1，超过 max_hops 拒绝
//   - 同一对 agent 每分钟调用数上限
//   - 死锁：对方的 main 会话已经在调用链上（A 等 B、B 又要等 A）→ 拒绝并提示直接回复
//   - 子 agent 不能再 spawn，也不能 send（同 OpenClaw 的 team 预设）
// 所有调用记进 system.sqlite 的 a2a_log，管理界面可追踪。
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Runtime } from "./runtime.ts";
import { messageText } from "./runtime.ts";
import type { AgentRegistry, AgentInfo } from "./registry.ts";
import { outsideScope, type RunScope } from "./scope.ts";
import { SILENT_RE } from "./scheduler.ts";
import { ok, fail } from "./tools/device.ts";

export interface A2AConfig { enabled: boolean; maxHops: number; perPairPerMin: number }

/** 子任务结果回到发起方之后，发起方的回复怎么送到主人那里（设备会话 → 推送语音） */
export type Announce = (scope: RunScope, text: string) => Promise<void>;

const SEND_TIMEOUT = 90;
const SPAWN_TIMEOUT = 300;
/**
 * agent 间传话的会话（LRN 2026-10-30）：每次传话接收方都起一个全新会话 `<接收方>:a2a:<发起方>:<随机>`，不进自己的 main。
 * 进 main 的毛病：主人和她的聊天里混进别的 agent 的话；每次都背着整段主对话（贵）；占着 main 的会话锁，主人这时候找她要排队、两边容易互等。
 * 主人那边说过什么靠近况带上；要接着上次的话题，发起方在消息里把前情说清楚。
 */
export const a2aKey = (to: string, from: string) => `${to}:a2a:${from}:${crypto.randomUUID().slice(0, 8)}`;

export class A2A {
  db: DatabaseSync;
  private calls = new Map<string, number[]>();
  announce: Announce = async () => {};

  constructor(file: string, private rt: Runtime, private agents: AgentRegistry, public cfg: A2AConfig) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS a2a_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, kind TEXT NOT NULL,
        from_agent TEXT NOT NULL, from_session TEXT NOT NULL, to_agent TEXT NOT NULL, to_session TEXT NOT NULL,
        message TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, hop INTEGER NOT NULL, ms INTEGER NOT NULL DEFAULT 0);
    `);
    // trace：同一串调用（一轮对话引出的）；parent：引起发起方这一轮的那次调用。老记录没有，各自算一串
    for (const col of ["trace TEXT", "parent INTEGER"]) { try { this.db.exec(`ALTER TABLE a2a_log ADD COLUMN ${col}`); } catch { /* 已有 */ } }
    this.db.exec("CREATE INDEX IF NOT EXISTS a2a_log_trace ON a2a_log(trace)");
  }

  log(limit = 100) { return this.db.prepare("SELECT * FROM a2a_log ORDER BY id DESC LIMIT ?").all(limit); }

  /** 按会话（一串调用）汇总，新的在前 */
  conversations(limit = 200) {
    return (this.db.prepare(`SELECT COALESCE(trace, 'id' || id) AS trace, MIN(ts) AS ts, MAX(ts + ms / 1000.0) AS last, COUNT(*) AS calls,
        SUM(status = 'running') AS running, SUM(status IN ('error', 'rejected')) AS failed, MAX(hop) AS hops,
        GROUP_CONCAT(DISTINCT from_agent) AS froms, GROUP_CONCAT(DISTINCT to_agent) AS tos, MIN(id) AS first
      FROM a2a_log GROUP BY COALESCE(trace, 'id' || id) ORDER BY MAX(id) DESC LIMIT ?`).all(limit) as any[]).map((r) => {
      const first = this.db.prepare("SELECT from_agent, from_session, message, kind FROM a2a_log WHERE id = ?").get(r.first) as any;
      return { ...r, root: first, agents: [...new Set([first.from_agent, ...String(r.froms).split(","), ...String(r.tos).split(",")])] };
    });
  }

  /** 一串调用的全部记录，按发生顺序 */
  conversation(trace: string) {
    return trace.startsWith("id") && /^id\d+$/.test(trace)
      ? this.db.prepare("SELECT * FROM a2a_log WHERE id = ?").all(Number(trace.slice(2)))
      : this.db.prepare("SELECT * FROM a2a_log WHERE trace = ? ORDER BY id").all(trace);
  }

  private record(e: { kind: string; from: RunScope; to: string; toSession: string; message: string; status: string; reply?: string; ms?: number }) {
    const r = this.db.prepare(`INSERT INTO a2a_log(ts, kind, from_agent, from_session, to_agent, to_session, message, reply, status, hop, ms, trace, parent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Date.now() / 1000, e.kind, e.from.agentId, e.from.sessionKey, e.to, e.toSession,
      e.message.slice(0, 4000), (e.reply ?? "").slice(0, 4000), e.status, e.from.hop + (e.to !== e.from.agentId ? 1 : 0), e.ms ?? 0,
      e.from.trace ?? null, e.from.a2aCall ?? null);
    return Number(r.lastInsertRowid);
  }
  private finish(id: number, status: string, reply: string, ms: number) {
    this.db.prepare("UPDATE a2a_log SET status = ?, reply = ?, ms = ? WHERE id = ?").run(status, reply.slice(0, 4000), ms, id);
  }

  /** 发起前的统一检查。返回错误文本，null = 放行 */
  check(scope: RunScope, to: string, opts: { allowSelf?: boolean } = {}): string | null {
    if (!this.cfg.enabled) return "agent 间通信已关闭";
    if (!this.agents.get(to)) return `没有 agent ${to}`;
    if (to === scope.agentId) { if (!opts.allowSelf) return "不能给自己发消息"; }
    else if (!this.agents.canContact(scope.agentId, to)) return `你没有联系 ${to} 的权限（主人可在管理界面打开）`;
    const hop = scope.hop + (to !== scope.agentId ? 1 : 0);
    if (hop > this.cfg.maxHops) return `转了太多手（${hop} 跳 > ${this.cfg.maxHops}），停下来直接回答`;
    if (to !== scope.agentId) {
      const pair = `${scope.agentId}>${to}`;
      const t = Date.now();
      const recent = (this.calls.get(pair) ?? []).filter((x) => t - x < 60_000);
      if (recent.length >= this.cfg.perPairPerMin) return `找 ${to} 太频繁了（每分钟最多 ${this.cfg.perPairPerMin} 次），稍后再试`;
      recent.push(t);
      this.calls.set(pair, recent);
    }
    return null;
  }

  tools() {
    return (scope: RunScope, agent: AgentInfo): AgentTool<any>[] => {
      if (!this.cfg.enabled) return [];
      const peers = () => this.agents.list().filter((p) => this.agents.canContact(agent.id, p.id));
      const visible = (id: string) => id === agent.id || this.agents.canContact(agent.id, id);
      const tools: AgentTool<any>[] = [
        {
          name: "sessions_list", label: "会话列表",
          description: "列出你可以联系的其他 agent，以及你和它们最近的会话。",
          parameters: Type.Object({}),
          execute: async () => {
            const out = [agent, ...peers()].map((a) => ({
              agent: a.id, name: a.name, self: a.id === agent.id,
              sessions: this.rt.store(a.id).listSessions(10).map((s) => ({ key: s.key, kind: s.kind, channel: s.channel, messages: s.messages, updated: new Date(s.updated * 1000).toLocaleString("zh-CN", { hour12: false }) })),
            }));
            return ok(JSON.stringify(out));
          },
        },
        {
          name: "sessions_history", label: "会话记录",
          description: "读取你自己或你有权限联系的 agent 的某个会话最近 n 条消息（默认对方的 main 会话）。",
          parameters: Type.Object({ agent: Type.String(), session: Type.Optional(Type.String()), n: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })) }),
          execute: async (_id, p: any) => {
            if (!visible(p.agent)) return fail(`没有权限查看 ${p.agent} 的会话`);
            const key = p.session || `${p.agent}:main`;
            if (!key.startsWith(`${p.agent}:`)) return fail("会话不属于这个 agent");
            const rows = this.rt.store(p.agent).transcript(key, p.n ?? 10);
            return ok(rows.map((r) => `${r.role}: ${messageText(r.msg).slice(0, 500)}`).join("\n") || "（空）");
          },
        },
      ];
      if (scope.kind === "sub") return tools;     // 子 agent 只能看，不能再派活、不能传话
      tools.push(
        {
          name: "sessions_send", label: "给其他 agent 发消息",
          description: "给另一个 agent 发消息（它每次都在一个新对话里收，不打扰它和主人的对话，也不记得你们之前的传话——需要前情就写进 message）。wait=true（默认）时等它回复并把回复交给你。",
          parameters: Type.Object({ agent: Type.String(), message: Type.String(), wait: Type.Optional(Type.Boolean()) }),
          execute: async (_id, p: any) => {
            const err = this.check(scope, p.agent);
            if (err) { this.record({ kind: "send", from: scope, to: p.agent, toSession: "", message: p.message, status: "rejected", reply: err }); return fail(err); }
            const toKey = a2aKey(p.agent, agent.id);
            if (scope.chain.some((c) => c.startsWith(`${p.agent}|`))) return fail(`${p.agent} 正在等你的回复（是它在问你），直接在回复里回答它即可`);
            const logId = this.record({ kind: "send", from: scope, to: p.agent, toSession: toKey, message: p.message, status: "running" });
            const text = `[来自 ${agent.name}（agent ${agent.id}）的消息] ${p.message}`;
            const t0 = Date.now();
            const link = { trace: scope.trace, a2aCall: logId };
            const go = () => this.rt.run({ agentId: p.agent, sessionKey: toKey, kind: "isolated", channel: "a2a", text, purpose: "a2a", timeoutSecs: SEND_TIMEOUT, ...link });
            if (p.wait === false) {
              const lineage = { hop: scope.hop + 1, chain: scope.chain, trusted: scope.trusted };
              outsideScope(() => {
                this.rt.run({ agentId: p.agent, sessionKey: toKey, kind: "isolated", channel: "a2a", text, purpose: "a2a", lineage, ...link })
                  .then((r) => this.finish(logId, "ok", r.text, Date.now() - t0))
                  .catch((e) => this.finish(logId, "error", String(e.message), Date.now() - t0));
              });
              return ok(`已发给 ${p.agent}，不等回复`);
            }
            try {
              const r = await go();
              this.finish(logId, "ok", r.text, Date.now() - t0);
              return ok(`${p.agent} 回复：${r.text}`);
            } catch (e: any) {
              this.finish(logId, "error", String(e.message), Date.now() - t0);
              return fail(`${p.agent} 没能回复：${e.message}`);
            }
          },
        },
        {
          name: "sessions_spawn", label: "派出子任务",
          description: "起一个子 agent 在后台独立完成一项任务（全新上下文，不带你的记忆）。agent 省略 = 派给你自己的分身。"
            + "wait=false（默认）时立即返回，完成后结果会自动交回给你；wait=true 时等它做完。",
          parameters: Type.Object({ task: Type.String(), agent: Type.Optional(Type.String()), wait: Type.Optional(Type.Boolean()) }),
          execute: async (_id, p: any) => {
            const to = p.agent || agent.id;
            const err = this.check(scope, to, { allowSelf: true });
            if (err) { this.record({ kind: "spawn", from: scope, to, toSession: "", message: p.task, status: "rejected", reply: err }); return fail(err); }
            const subKey = `${to}:sub:${crypto.randomUUID().slice(0, 8)}`;
            const logId = this.record({ kind: "spawn", from: scope, to, toSession: subKey, message: p.task, status: "running" });
            const req = {
              agentId: to, sessionKey: subKey, kind: "sub" as const, channel: "a2a", purpose: "spawn", timeoutSecs: SPAWN_TIMEOUT,
              text: `[子任务，来自 ${agent.name}] ${p.task}\n\n完成后直接给出结果（会原样交回给发起方），不要寒暄。`,
              toolAllow: (n: string) => n !== "sessions_spawn" && n !== "sessions_send",
              trace: scope.trace, a2aCall: logId,
            };
            const t0 = Date.now();
            if (p.wait) {
              try {
                const r = await this.rt.run(req);
                this.finish(logId, "ok", r.text, Date.now() - t0);
                return ok(`子任务完成：${r.text}`);
              } catch (e: any) { this.finish(logId, "error", String(e.message), Date.now() - t0); return fail(`子任务失败：${e.message}`); }
            }
            const caller = { ...scope, meta: {} };
            const lineage = { hop: scope.hop + (to !== agent.id ? 1 : 0), chain: scope.chain, trusted: scope.trusted };
            outsideScope(() => {
              (async () => {
                let result: string;
                try { result = (await this.rt.run({ ...req, lineage })).text; this.finish(logId, "ok", result, Date.now() - t0); }
                catch (e: any) { result = `（失败：${e.message}）`; this.finish(logId, "error", String(e.message), Date.now() - t0); }
                await this.deliverResult(caller, p.task, to, result, logId);
              })().catch((e) => console.log(`[a2a] ⚠️  子任务结果交回失败: ${e.message}`));
            });
            return ok(`已派出子任务（${subKey}），完成后结果会交回给你。现在可以先告诉主人你已经安排了。`);
          },
        },
      );
      return tools;
    };
  }

  /** 后台子任务完成：把结果作为系统事件投回发起方会话，让它决定怎么告诉主人 */
  private async deliverResult(caller: RunScope, task: string, who: string, result: string, call: number) {
    const r = await this.rt.run({
      agentId: caller.agentId, sessionKey: caller.sessionKey, kind: caller.kind as any, channel: caller.channel,
      deviceId: caller.deviceId, spokenTo: caller.channel === "device" ? caller.deviceId : undefined, purpose: "a2a", origin: caller.origin,
      lineage: { hop: caller.hop, chain: [], trusted: caller.trusted },
      trace: caller.trace, a2aCall: call,       // 发起方收到结果这一轮还算这串调用里的一步
      text: `[系统事件] 你之前派出的子任务「${task.slice(0, 100)}」已由 ${who} 完成。结果：\n${result}\n\n需要告诉主人就直接说要说的话（会转达给主人）；不需要就只回 NO_REPLY。`,
      keepIf: (t) => !SILENT_RE.test(t),
    });
    if (r.text && !SILENT_RE.test(r.text)) await this.announce(caller, r.text);
  }
}
