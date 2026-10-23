// 管理接口 /api/admin/*（§7 的后端；页面在 M8）。**只允许本机访问**：来源不是 127.0.0.1 / ::1 一律 403。
// 设备接口照常监听局域网，/monitor 保持原样（局域网 + API_TOKEN）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { json, type Req, type Res, type Router } from "../http/router.ts";
import type { Ctx } from "../ctx.ts";
import type { AgentSystem } from "../agent/system.ts";
import { SOUL_FILES } from "../agent/registry.ts";
import { BUDGETS, applyBudgets } from "../agent/soul.ts";
import { Memories } from "../agent/tools/memory.ts";
import { importOpenClaw, findOpenClawDirs, describeImport } from "../agent/import-openclaw.ts";
import { scheduleFrom } from "../agent/tools/cron.ts";
import { Roles } from "../roles.ts";
import { parseToolsConfig } from "../config.ts";
import { GLOBAL_OWNER } from "../agent/skills.ts";
import { unzip } from "../util/zip.ts";
import { resolveInside } from "../agent/paths.ts";
import { applyProxy, activeProxy } from "../util/proxy.ts";
import { search } from "../agent/tools/web.ts";
import { runShell, shellFor, clipOutput } from "../agent/tools/exec.ts";
import { ModelRegistry } from "../agent/models.ts";
import { OpenAIEmbedder } from "../agent/memory.ts";

const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const isLocal = (req: Req) => LOCAL.has(req.remoteAddr);

type H = (req: Req) => Res | Promise<Res>;

export function registerAdmin(r: Router, ctx: Ctx, sys: AgentSystem) {
  const { registry, runtime, memories, a2a, skills } = sys;
  const models = { list: () => sys.models.list(), defaultRef: () => sys.models.defaultRef(), cheapRef: () => sys.models.cheapRef() };
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
    // OpenClaw 模式下设备角色仍来自 config.roles，不跟着 agent 列表变
    if (ctx.brain.kind === "pi") ctx.roles = new Roles(registry.roleDefs(), ctx.dirs.rolesFile);
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
      setup_needed: !models.defaultRef(),
      channels: sys.channels.status(),
    });
  });
  get("/api/admin/meta", () => json({
    budgets: BUDGETS, soul_files: SOUL_FILES,
    tools: runtime.allToolNames(registry.default()),
    fake: ctx.cfg.fakeProviders,
  }));
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
  // ── 技能管理：全局 + 每个 agent 自己的；owner = ~global 或 agent id，name = 技能文件夹名 ──
  get("/api/admin/skills", () => json({
    skills: skills.all(registry).map(({ name, description, scope, folder, owner, dir }) => ({ name, description, scope, folder, owner, dir })),
    owners: [{ id: GLOBAL_OWNER, name: "全局（所有 agent）" }, ...registry.list().map((a) => ({ id: a.id, name: `只给 ${a.name}（${a.id}）` }))],
    global_dir: skills.root(GLOBAL_OWNER, registry),
  }));
  post("/api/admin/skills", (req) => {
    const d = req.json() ?? {};
    const dir = skills.create(skills.root(String(d.owner || GLOBAL_OWNER), registry), String(d.name ?? ""), String(d.description ?? ""), String(d.body ?? ""));
    return json({ dir });
  });
  post("/api/admin/skills/upload", (req) => {
    const d = req.json() ?? {};
    const entries = unzip(Buffer.from(String(d.b64 ?? ""), "base64"));
    const name = skills.installZip(skills.root(String(d.owner || GLOBAL_OWNER), registry), entries, String(d.filename ?? "skill.zip"), !!d.overwrite);
    return json({ name });
  });
  const skillDir = (req: Req) => skills.dirOf(skills.root(req.params.owner, registry), req.params.name);
  get("/api/admin/skills/<owner>/<name>", (req) => {
    const dir = skillDir(req);
    return json({ dir, files: skills.files(dir) });
  });
  del("/api/admin/skills/<owner>/<name>", (req) => { skills.remove(skills.root(req.params.owner, registry), req.params.name); return json({ status: "ok" }); });
  get("/api/admin/skills/<owner>/<name>/file", (req) => {
    const f = resolveInside(skillDir(req), String(req.query.get("path") ?? ""));
    if (!fs.existsSync(f)) return json({ error: "没有这个文件" }, 404);
    const b = fs.readFileSync(f);
    if (b.length > 256 * 1024 || b.subarray(0, 8000).includes(0)) return json({ error: "不是文本文件或太大，不能在这里编辑" }, 400);
    return json({ content: b.toString("utf8") });
  });
  put("/api/admin/skills/<owner>/<name>/file", (req) => {
    const d = req.json() ?? {};
    const data = typeof d.b64 === "string" ? Buffer.from(d.b64, "base64") : Buffer.from(String(d.content ?? ""), "utf8");
    skills.writeFile(skillDir(req), String(req.query.get("path") ?? ""), data);
    return json({ status: "ok", size: data.length });
  });
  del("/api/admin/skills/<owner>/<name>/file", (req) => { skills.deleteFile(skillDir(req), String(req.query.get("path") ?? "")); return json({ status: "ok" }); });

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
    // 主人在管理界面里改过 = 审过了：不再按「陌生人建的任务」限制
    const j = sched().update(req.params.id, { ...jobBody(req.json() ?? {}), untrusted: false });
    return j ? json(j) : json({ error: "没有这个任务" }, 404);
  });
  del("/api/admin/jobs/<id>", (req) => (sched().remove(req.params.id) ? json({ status: "ok" }) : json({ error: "没有这个任务" }, 404)));
  post("/api/admin/jobs/<id>/run", async (req) => json(await sched().runNow(req.params.id)));
  get("/api/admin/jobs/<id>/runs", (req) => json(sched().runs(req.params.id, Number(req.query.get("limit") ?? 50))));
  get("/api/admin/runs", (req) => json(sched().runs(undefined, Number(req.query.get("limit") ?? 50))));

  // ── 从 OpenClaw 导入（人设、记忆、定时任务；任务默认暂停）──
  post("/api/admin/import/openclaw", (req) => {
    const d = req.json() ?? {};
    const dir = String(d.dir || findOpenClawDirs(ctx.cfg.openclaw.dir, os.homedir())[0] || "");
    if (!dir) return json({ error: "没找到 OpenClaw 目录（本机 ~/.openclaw 和 WSL 里都找过了），请填写路径，例如 \\\\wsl.localhost\\Ubuntu\\home\\你\\.openclaw" }, 404);
    const rep = importOpenClaw(dir, registry, sched(), { overwrite: !!d.overwrite, skillsDir: skills.root(GLOBAL_OWNER, registry) });
    for (const a of registry.list()) memories.forget(a.id);
    changed();      // 新建了 agent 的话：角色表、heartbeat 跟着变
    return json({ ...rep, lines: describeImport(rep) });
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
  get("/api/admin/devices", () => {
    const t = Date.now() / 1000;
    return json([...ctx.hb.devices.entries()].map(([id, rec]) => ({
      id, agent: ctx.roles.get(id).agent, role: ctx.roles.get(id).id, online: t - rec.ts < 200, secs_ago: Math.trunc(t - rec.ts),
      bat: rec.data.bat ?? null, rssi: rec.data.rssi ?? null, heap: rec.data.heap ?? null, wdt: rec.data.wdt ?? null,
    })));
  });
  put("/api/admin/devices/<id>", (req) => {
    const a = agentOr404(String((req.json() ?? {}).agent));
    const role = ctx.roles.set(req.params.id, a.device_role);
    if (!role) return json({ error: "这个 agent 没有对应的设备角色" }, 400);
    if (ctx.mqtt.ok) ctx.mqtt.publish(`kagura/cmd/${req.params.id}`, { action: "role", role: role.id });
    return json({ id: req.params.id, agent: a.id, role: role.id });
  });

  // ── 设置（config.json）──
  const cfgFile = path.join(ctx.cfg.dataDir, "config.json");
  const SECRET = /(secret|token|key|password)$/i;
  const readCfg = (): any => { try { return JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch { return {}; } };
  /** 递归打码：键名像密钥的字符串值换成 *** */
  const mask = (v: any, k = ""): any => Array.isArray(v) ? v.map((x) => mask(x)) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, mask(vv, kk)])) : typeof v === "string" && v && SECRET.test(k) ? "***" : v;
  /** 递归合并：新值是 *** 就保留旧值（数组按下标对齐，服务商列表按 id 对齐） */
  const unmask = (nv: any, ov: any, k = ""): any => {
    if (nv === "***" && SECRET.test(k)) return ov;
    if (Array.isArray(nv)) return nv.map((x, i) => unmask(x, Array.isArray(ov) ? (ov.find((o: any) => o?.id && o.id === x?.id) ?? ov[i]) : undefined));
    if (nv && typeof nv === "object") return Object.fromEntries(Object.entries(nv).map(([kk, vv]) => [kk, unmask(vv, ov?.[kk], kk)]));
    return nv;
  };
  get("/api/admin/config", () => json({ config: mask(readCfg()), data_dir: ctx.cfg.dataDir, brain: ctx.cfg.brain, fake: ctx.cfg.fakeProviders }));
  put("/api/admin/config", (req) => {
    const patch = req.json();
    if (!patch || typeof patch !== "object") return json({ error: "需要 JSON 对象" }, 400);
    const old = readCfg();
    const next = { ...old, ...unmask(patch, old) };
    const tmp = cfgFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, cfgFile);
    // 能热更新的当场生效：模型、嵌入、agent 通信；端口、百度、token、大脑类型要重启
    const hot: string[] = [];
    if (!ctx.cfg.fakeProviders && next.models) {
      const m = { providers: next.models.providers ?? [], default: String(next.models.default ?? ""), cheap: String(next.models.cheap ?? "") };
      ctx.cfg.models = m;
      sys.models = new ModelRegistry(m);
      runtime.models = sys.models;
      hot.push("models");
    }
    if (!ctx.cfg.fakeProviders && "embedding" in patch) {
      const e = next.embedding;
      memories.setEmbedder(e?.base_url && e?.model ? new OpenAIEmbedder({ baseUrl: e.base_url, apiKey: e.api_key ?? "", model: e.model }) : null);
      hot.push("embedding");
    }
    if (next.a2a) {
      if ("enabled" in next.a2a) a2a.cfg.enabled = !!next.a2a.enabled;
      if (next.a2a.max_hops) a2a.cfg.maxHops = Number(next.a2a.max_hops);
      if (next.a2a.per_pair_per_min) a2a.cfg.perPairPerMin = Number(next.a2a.per_pair_per_min);
      hot.push("a2a");
    }
    if ("tools" in patch) {
      // 就地改：工具每次调用都读这个对象，不用重启
      const t = parseToolsConfig(next.tools);
      Object.assign(ctx.cfg.tools.exec, t.exec);
      Object.assign(ctx.cfg.tools.web, t.web);
      applyProxy(t.web.proxy);
      hot.push("tools");
    }
    if ("prompt_budgets" in patch) { applyBudgets(next.prompt_budgets); hot.push("prompt_budgets"); }
    const restart = ["port", "mqtt_port", "stream_port", "disc_port", "baidu", "api_token", "stream_token", "brain", "runtime", "openclaw"].filter((k) => k in patch);
    return json({ status: "ok", applied: hot, restart_needed: restart });
  });
  /** 试一下联网搜索（按当前设置） */
  post("/api/admin/tools/test-search", async (req) => {
    const q = String((req.json() ?? {}).query || "今天的新闻");
    const t0 = Date.now();
    const r = await search(q, 5, ctx.cfg.tools.web);
    return json({ ok: r.hits.length > 0, provider: r.provider, hits: r.hits, errors: r.errors, ms: Date.now() - t0, proxy: activeProxy() });
  });
  /** 试一下执行命令（按当前设置的 shell；默认在数据目录里跑） */
  post("/api/admin/tools/test-exec", async (req) => {
    const cmd = String((req.json() ?? {}).command || "echo hello from Kagura");
    const r = await runShell(shellFor(cmd, ctx.cfg.tools.exec.shell, { wslDistro: ctx.cfg.tools.exec.wslDistro, cwd: ctx.cfg.dataDir }),
      { cwd: ctx.cfg.dataDir, timeoutSecs: 20 });
    return json({ ok: r.code === 0 && !r.timedOut, code: r.code, output: clipOutput(r.output, 4000), error: r.error ?? "", timed_out: r.timedOut, ms: r.ms });
  });
  /** 试一下模型通不通：发一句「你好」 */
  post("/api/admin/models/test", async (req) => {
    const ref = String((req.json() ?? {}).ref ?? "");
    const t0 = Date.now();
    try {
      const m = sys.models.resolve(ref);
      const r = await sys.models.models.completeSimple(m, { systemPrompt: "用一句话回答。", messages: [{ role: "user", content: "你好，报一下你是什么模型", timestamp: Date.now() }] });
      if (r.stopReason === "error" || r.stopReason === "aborted") return json({ ok: false, error: r.errorMessage, ms: Date.now() - t0 });
      return json({ ok: true, reply: r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""), ms: Date.now() - t0, usage: r.usage });
    } catch (e: any) { return json({ ok: false, error: e.message, ms: Date.now() - t0 }); }
  });
  /** 音色试听 */
  post("/api/admin/tts", async (req) => {
    const d = req.json() ?? {};
    const wav = await ctx.voice.synthesize(String(d.text || "你好，我是你的桌面小助手。"), Number(d.per ?? 111));
    if (!wav) return json({ error: "语音合成失败（检查百度 Key）" }, 500);
    return { status: 200, headers: { "Content-Type": "audio/wav" }, body: fs.readFileSync(wav) };
  });

  // ── 用量（全部 agent）──
  get("/api/admin/usage", (req) => {
    const days = Number(req.query.get("days") ?? 30);
    return json(registry.list().map((a) => ({ agent: a.id, name: a.name, days: runtime.store(a.id).usageByDay(days) })));
  });

  // ── 设备日志 / 崩溃报告 / 录音 ──
  get("/api/admin/devices/<id>/logs", (req) => {
    const f = ctx.hb.logFile(req.params.id.replace(/[^A-Za-z0-9_-]/g, ""));
    const lines = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean) : [];
    const hb = ctx.hb.devices.get(req.params.id);
    return json({ lines: lines.slice(-Number(req.query.get("n") ?? 200)), heartbeat: hb ? { ...hb.data, secs_ago: Math.trunc(Date.now() / 1000 - hb.ts) } : null });
  });
  get("/api/admin/crash-reports", () => json(fs.readdirSync(ctx.dirs.crashReports).filter((f) => f.endsWith(".log")).sort().reverse().slice(0, 50)
    .map((f) => ({ name: f, size: fs.statSync(path.join(ctx.dirs.crashReports, f)).size }))));
  get("/api/admin/crash-reports/<name>", (req) => {
    if (!/^[A-Za-z0-9_-]+\.log$/.test(req.params.name)) return json({ error: "bad name" }, 400);
    const f = path.join(ctx.dirs.crashReports, req.params.name);
    return fs.existsSync(f) ? json({ content: fs.readFileSync(f, "utf8") }) : json({ error: "not found" }, 404);
  });
  get("/api/admin/devices/<id>/audio", (req) => {
    const f = path.join(ctx.dirs.debugAudio, `${req.params.id.replace(/[^A-Za-z0-9_-]/g, "")}_last.wav`);
    return fs.existsSync(f) ? { status: 200, headers: { "Content-Type": "audio/wav", "Cache-Control": "no-cache" }, body: fs.readFileSync(f) } : json({ error: "还没有录音" }, 404);
  });

  // ── IM 渠道 ──
  const ch = sys.channels;
  get("/api/admin/channels", () => {
    const st = new Map(ch.status().map((x) => [x.id, x]));
    return json({
      accounts: ch.store.accounts().map((a) => ({ ...ch.store.masked(a), status: st.get(a.id) })),
      bindings: ch.store.bindings(), allowed: ch.store.allowed(), pairings: ch.store.pairings(),
    });
  });
  post("/api/admin/channels", async (req) => {
    const a = ch.store.upsertAccount(req.json() ?? {});
    if (a.agent && !registry.get(a.agent)) return json({ error: `没有 agent ${a.agent}` }, 400);
    await ch.start(a.id);
    return json(ch.store.masked(a), 201);
  });
  del("/api/admin/channels/<id>", async (req) => {
    await ch.stop(req.params.id);
    return ch.store.removeAccount(req.params.id) ? json({ status: "ok" }) : json({ error: "没有这个账号" }, 404);
  });
  post("/api/admin/channels/<id>/test", async (req) => json(await ch.test(req.params.id)));
  post("/api/admin/channels/<id>/approve", async (req) => {
    const d = req.json() ?? {};
    const p = ch.store.approve(req.params.id, String(d.code ?? d.user ?? ""));
    if (!p) return json({ error: "没有这个配对申请（可能已过期）" }, 404);
    if (d.owner) ch.store.allow(req.params.id, p.user, p.name, true);
    await ch.adapters.get(req.params.id)?.send(p.chatId, "主人已经批准啦，现在可以和我聊天了。").catch(() => {});
    return json({ status: "ok", user: p.user });
  });
  post("/api/admin/channels/<id>/reject", (req) => { ch.store.rejectPairing(req.params.id, String((req.json() ?? {}).user ?? "")); return json({ status: "ok" }); });
  put("/api/admin/channels/<id>/allowed", (req) => {
    const d = req.json() ?? {};
    if (!d.user) return json({ error: "user 必填" }, 400);
    ch.store.allow(req.params.id, String(d.user), d.name, !!d.owner);
    return json({ status: "ok" });
  });
  del("/api/admin/channels/<id>/allowed/<user>", (req) => { ch.store.disallow(req.params.id, req.params.user); return json({ status: "ok" }); });
  put("/api/admin/channels/bindings", (req) => {
    const d = req.json() ?? {};
    if (d.agent) agentOr404(String(d.agent));
    ch.store.bind({ account: String(d.account ?? ""), chatId: String(d.chatId ?? ""), agent: String(d.agent ?? ""), label: d.label });
    return json({ status: "ok", bindings: ch.store.bindings() });
  });

  // ── 网页聊天（webchat 渠道）──
  post("/api/admin/chat", async (req) => {
    const d = req.json() ?? {};
    const a = agentOr404(String(d.agent ?? registry.default().id));
    const text = String(d.text ?? "").trim();
    if (!text) return json({ error: "text 不能为空" }, 400);
    const key = runtime.sessionKey(a.id, "webchat", "owner");
    if (/^\/(reset|new)\s*$/i.test(text)) { runtime.store(a.id).reset(key); return json({ reply: "好，我们重新开始吧。", tools: [], session: key }); }
    const res = await runtime.run({ agentId: a.id, sessionKey: key, kind: "chat", channel: "webchat", text });
    return json({ reply: res.text, tools: res.toolCalls, usage: res.usage, session: key });
  });
}
