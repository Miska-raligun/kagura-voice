// 管理接口 /api/admin/*（§7 的后端；页面在 M8）。**只允许本机访问**：来源不是 127.0.0.1 / ::1 一律 403。
// 设备接口照常监听局域网，/monitor 保持原样（局域网 + API_TOKEN）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { json, type Req, type Res, type Router } from "../http/router.ts";
import type { Ctx } from "../ctx.ts";
import type { AgentSystem } from "../agent/system.ts";
import { SOUL_FILES } from "../agent/registry.ts";
import { Memories } from "../agent/tools/memory.ts";
import { importOpenClaw } from "../agent/import-openclaw.ts";
import { scheduleFrom } from "../agent/tools/cron.ts";
import { Roles } from "../roles.ts";

const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const isLocal = (req: Req) => LOCAL.has(req.remoteAddr);

type H = (req: Req) => Res | Promise<Res>;

export function registerAdmin(r: Router, ctx: Ctx, sys: AgentSystem) {
  const { registry, runtime, memories, a2a, skills, models } = sys;
  const sched = () => sys.scheduler!;
  const guard = (h: H): H => async (req) => {
    if (!isLocal(req)) return json({ error: "管理接口只允许本机访问" }, 403);
    try { return await h(req); }
    catch (e: any) { return json({ error: String(e.message || e) }, e.status ?? 400); }
  };
  const get = (p: string, h: H) => r.add("GET", p, guard(h));
  const post = (p: string, h: H) => r.add("POST", p, guard(h));
  const put = (p: string, h: H) => r.add("PUT", p, guard(h));
  const patch = (p: string, h: H) => r.add("PATCH", p, guard(h));
  const del = (p: string, h: H) => r.add("DELETE", p, guard(h));
  const agentOr404 = (id: string) => {
    const a = registry.get(id);
    if (!a) throw Object.assign(new Error(`没有 agent ${id}`), { status: 404 });
    return a;
  };
  const view = (id: string) => { const { dir, workspace, ...rest } = agentOr404(id); return { ...rest, workspace }; };
  /** agent 增删改之后：角色表、heartbeat 任务跟着变 */
  const changed = () => {
    ctx.roles = new Roles(registry.roleDefs(), ctx.dirs.rolesFile);
    sched().syncHeartbeats();
  };

  // ── 总览 ──
  get("/api/admin/overview", () => {
    const today = new Date().toISOString().slice(0, 10);
    const t = Date.now() / 1000;
    return json({
      agents: registry.list().map((a) => {
        const day = runtime.store(a.id).usageByDay(1).find((d: any) => d.day === today) as any;
        return { id: a.id, name: a.name, model: a.model || models.defaultRef(), today: day ?? { calls: 0, cost: 0 } };
      }),
      devices: [...ctx.hb.devices.entries()].map(([id, rec]) => ({ id, last_seen_secs_ago: Math.trunc(t - rec.ts), agent: ctx.roles.get(id).agent })),
      failing_jobs: sched().list().filter((j) => j.last_status === "error"),
      heartbeats: sched().list().filter((j) => j.kind === "heartbeat").map((j) => ({ agent: j.agent, enabled: j.enabled, last_status: j.last_status, last_run: j.last_run })),
      models: models.list(),
    });
  });
  get("/api/admin/models", () => json({ default: models.defaultRef(), cheap: models.cheapRef(), models: models.list() }));

  // ── Agents ──
  get("/api/admin/agents", () => json(registry.list().map((a) => view(a.id))));
  post("/api/admin/agents", (req) => {
    const d = req.json() ?? {};
    const { id, copy_from, ...cfg } = d;
    const a = registry.create(String(id ?? ""), cfg);
    if (copy_from) {
      const src = agentOr404(copy_from);
      for (const f of SOUL_FILES) if (f !== "MEMORY.md" && fs.existsSync(path.join(src.workspace, f))) fs.copyFileSync(path.join(src.workspace, f), path.join(a.workspace, f));
    }
    changed();
    return json(view(a.id), 201);
  });
  get("/api/admin/agents/<id>", (req) => json(view(req.params.id)));
  patch("/api/admin/agents/<id>", (req) => {
    agentOr404(req.params.id);
    const { id: _ignore, ...p } = req.json() ?? {};
    registry.update(req.params.id, p);
    changed();
    return json(view(req.params.id));
  });
  del("/api/admin/agents/<id>", (req) => {
    agentOr404(req.params.id);
    runtime.closeStore(req.params.id);
    memories.forget(req.params.id);
    registry.remove(req.params.id);
    changed();
    return json({ status: "ok" });
  });

  // 人设 / 记忆文件：?path=SOUL.md 或 ?path=memory/2026-10-23.md
  const filePath = (id: string, rel: string) => {
    const a = agentOr404(id);
    if ((SOUL_FILES as readonly string[]).includes(rel)) return path.join(a.workspace, rel);
    return Memories.memoryPath(a, rel);
  };
  get("/api/admin/agents/<id>/files", (req) => {
    const a = agentOr404(req.params.id);
    const list: { path: string; size: number }[] = [...SOUL_FILES].map((f) => ({ path: f as string, size: fs.existsSync(path.join(a.workspace, f)) ? fs.statSync(path.join(a.workspace, f)).size : 0 }));
    for (const f of fs.readdirSync(path.join(a.workspace, "memory")).sort().reverse()) if (f.endsWith(".md")) list.push({ path: `memory/${f}`, size: fs.statSync(path.join(a.workspace, "memory", f)).size });
    return json(list);
  });
  get("/api/admin/agents/<id>/file", (req) => {
    const p = filePath(req.params.id, req.query.get("path") ?? "");
    return json({ path: req.query.get("path"), content: fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "" });
  });
  put("/api/admin/agents/<id>/file", (req) => {
    const rel = req.query.get("path") ?? "";
    const p = filePath(req.params.id, rel);
    const content = (req.json() ?? {}).content;
    if (typeof content !== "string") return json({ error: "content 必须是字符串" }, 400);
    fs.writeFileSync(p, content);
    return json({ status: "ok", path: rel, chars: Array.from(content).length });
  });

  // ── 会话 ──
  get("/api/admin/agents/<id>/sessions", (req) => { agentOr404(req.params.id); return json(runtime.store(req.params.id).listSessions(200)); });
  get("/api/admin/agents/<id>/sessions/<key>", (req) => {
    agentOr404(req.params.id);
    const st = runtime.store(req.params.id);
    const s = st.getSession(req.params.key);
    if (!s) return json({ error: "没有这个会话" }, 404);
    return json({ ...s, messages: st.transcript(req.params.key, Number(req.query.get("limit") ?? 200)) });
  });
  post("/api/admin/agents/<id>/sessions/<key>/reset", (req) => { agentOr404(req.params.id); runtime.store(req.params.id).reset(req.params.key); return json({ status: "ok" }); });
  post("/api/admin/agents/<id>/sessions/<key>/compact", async (req) => {
    agentOr404(req.params.id);
    return json({ compacted: await runtime.compact(req.params.id, req.params.key) });
  });

  // ── 记忆 ──
  post("/api/admin/agents/<id>/memory/search", async (req) => {
    agentOr404(req.params.id);
    const d = req.json() ?? {};
    return json(await memories.of(req.params.id).search(String(d.query ?? ""), Number(d.k ?? 8)));
  });
  post("/api/admin/agents/<id>/memory/reindex", async (req) => { agentOr404(req.params.id); return json(await memories.of(req.params.id).rebuild()); });

  // ── 用量 / 技能 ──
  get("/api/admin/agents/<id>/usage", (req) => { agentOr404(req.params.id); return json(runtime.store(req.params.id).usageByDay(Number(req.query.get("days") ?? 30))); });
  get("/api/admin/agents/<id>/skills", (req) => json(skills.list(agentOr404(req.params.id)).map(({ name, description, scope }) => ({ name, description, scope }))));

  // ── 定时任务 ──
  const jobBody = (d: any) => {
    const out: any = { ...d };
    // 向导可以直接传 kind+value（同 cron_add 工具），也可以传完整 schedule
    if (!d.schedule && d.schedule_kind) out.schedule = scheduleFrom(d.schedule_kind, String(d.schedule_value ?? ""), d.tz);
    delete out.schedule_kind; delete out.schedule_value;
    return out;
  };
  get("/api/admin/jobs", (req) => json(sched().list(req.query.get("agent") ?? undefined)));
  post("/api/admin/jobs", (req) => json(sched().add({ source: "admin", ...jobBody(req.json() ?? {}) }), 201));
  patch("/api/admin/jobs/<id>", (req) => {
    const j = sched().update(req.params.id, jobBody(req.json() ?? {}));
    return j ? json(j) : json({ error: "没有这个任务" }, 404);
  });
  del("/api/admin/jobs/<id>", (req) => (sched().remove(req.params.id) ? json({ status: "ok" }) : json({ error: "没有这个任务" }, 404)));
  post("/api/admin/jobs/<id>/run", async (req) => json(await sched().runNow(req.params.id)));
  get("/api/admin/jobs/<id>/runs", (req) => json(sched().runs(req.params.id, Number(req.query.get("limit") ?? 50))));
  get("/api/admin/runs", (req) => json(sched().runs(undefined, Number(req.query.get("limit") ?? 50))));

  // ── 从 OpenClaw 导入（人设、记忆、定时任务；任务默认暂停）──
  post("/api/admin/import/openclaw", (req) => {
    const d = req.json() ?? {};
    const dir = String(d.dir || ctx.cfg.openclaw.dir || path.join(os.homedir(), ".openclaw"));
    const rep = importOpenClaw(dir, registry, sched(), { overwrite: !!d.overwrite });
    for (const a of registry.list()) memories.forget(a.id);
    return json(rep);
  });

  // ── Agent 通信 ──
  get("/api/admin/a2a", (req) => json({
    settings: a2a.cfg,
    matrix: registry.list().map((a) => ({ from: a.id, allow: a.a2a.allow })),
    log: a2a.log(Number(req.query.get("limit") ?? 100)),
  }));
  /** 开关矩阵里的一格：from 能不能找 to */
  put("/api/admin/a2a/allow", (req) => {
    const d = req.json() ?? {};
    const from = agentOr404(String(d.from)), to = agentOr404(String(d.to));
    if (from.id === to.id) return json({ error: "不能设置自己" }, 400);
    const set = new Set(from.a2a.allow.filter((x) => x !== "*"));
    if (d.allow) set.add(to.id); else set.delete(to.id);
    registry.update(from.id, { a2a: { allow: [...set] } });
    return json({ from: from.id, allow: [...set] });
  });
  put("/api/admin/a2a/settings", (req) => {
    const d = req.json() ?? {};
    if ("enabled" in d) a2a.cfg.enabled = !!d.enabled;
    if ("max_hops" in d) a2a.cfg.maxHops = Math.max(1, Number(d.max_hops));
    if ("per_pair_per_min" in d) a2a.cfg.perPairPerMin = Math.max(1, Number(d.per_pair_per_min));
    return json(a2a.cfg);
  });

  // ── 设备绑定（= 角色切换，改设备当前 agent）──
  get("/api/admin/devices", () => json([...new Set([...ctx.hb.devices.keys()])].map((id) => ({ id, agent: ctx.roles.get(id).agent, role: ctx.roles.get(id).id }))));
  put("/api/admin/devices/<id>", (req) => {
    const a = agentOr404(String((req.json() ?? {}).agent));
    const role = ctx.roles.set(req.params.id, a.device_role);
    if (!role) return json({ error: "这个 agent 没有对应的设备角色" }, 400);
    if (ctx.mqtt.ok) ctx.mqtt.publish(`kagura/cmd/${req.params.id}`, { action: "role", role: role.id });
    return json({ id: req.params.id, agent: a.id, role: role.id });
  });

  // ── 网页聊天（webchat 渠道）──
  post("/api/admin/chat", async (req) => {
    const d = req.json() ?? {};
    const a = agentOr404(String(d.agent ?? registry.default().id));
    const text = String(d.text ?? "").trim();
    if (!text) return json({ error: "text 不能为空" }, 400);
    const key = runtime.sessionKey(a.id, "webchat", "owner");
    const res = await runtime.run({ agentId: a.id, sessionKey: key, kind: "chat", channel: "webchat", text });
    return json({ reply: res.text, tools: res.toolCalls, usage: res.usage, session: key });
  });
}
