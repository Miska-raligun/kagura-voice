// 管理接口：扩展（pi 格式的自写工具）与 MCP 服务器。只许本机。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { json, type Req, type Res, type Router } from "../http/router.ts";
import type { AgentSystem } from "../agent/system.ts";
import { GLOBAL, TEMPLATE } from "../agent/extensions.ts";
import { isLocal } from "./admin.ts";

/** 别的客户端的 MCP 配置放在哪（导入用） */
export function mcpImportSources(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): { id: string; label: string; file: string }[] {
  const appdata = env.APPDATA || path.join(home, "AppData", "Roaming");
  return [
    { id: "pi", label: "pi（~/.pi/agent/mcp.json）", file: path.join(home, ".pi", "agent", "mcp.json") },
    { id: "claude", label: "Claude Desktop", file: process.platform === "win32" ? path.join(appdata, "Claude", "claude_desktop_config.json")
      : process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : path.join(home, ".config", "Claude", "claude_desktop_config.json") },
    { id: "cursor", label: "Cursor（~/.cursor/mcp.json）", file: path.join(home, ".cursor", "mcp.json") },
  ];
}

export function registerAdminPlugins(r: Router, sys: AgentSystem) {
  const { extensions, mcp, registry } = sys;
  const guard = (h: (req: Req) => Res | Promise<Res>) => async (req: Req): Promise<Res> => {
    if (!isLocal(req)) return json({ error: "管理接口只允许本机访问" }, 403);
    try { return await h(req); } catch (e: any) { return json({ error: String(e.message || e) }, e.status ?? 400); }
  };
  const view = (e: any) => ({
    owner: e.owner, name: e.name, file: e.file, error: e.error, unsupported: e.unsupported, loadedAt: e.loadedAt,
    tools: e.tools.map((t: any) => ({ name: t.name, label: t.label ?? t.name, description: String(t.description ?? "").slice(0, 300), allowUntrusted: !!t.allowUntrusted })),
    mcpServers: e.mcpServers.map((m: any) => m.name),
  });

  // ── 扩展 ──
  r.add("GET", "/api/admin/extensions", guard(() => json({
    extensions: extensions.list().map(view),
    owners: [{ id: GLOBAL, name: "全局（所有 agent）" }, ...registry.list().map((a) => ({ id: a.id, name: `只给 ${a.name}（${a.id}）` }))],
    global_dir: extensions.globalDir, template: TEMPLATE,
  })));
  r.add("POST", "/api/admin/extensions/reload", guard(async () => json({ extensions: (await extensions.reloadAll()).map(view) })));
  r.add("GET", "/api/admin/extensions/<owner>/<name>", guard((req) => json(extensions.read(req.params.owner, req.params.name))));
  r.add("PUT", "/api/admin/extensions/<owner>/<name>", guard(async (req) => {
    const code = (req.json() ?? {}).code;
    if (typeof code !== "string") return json({ error: "code 必须是字符串" }, 400);
    return json(view(await extensions.write(req.params.owner, req.params.name, code)));
  }));
  r.add("DELETE", "/api/admin/extensions/<owner>/<name>", guard(async (req) => { await extensions.remove(req.params.owner, req.params.name); return json({ status: "ok" }); }));

  // ── MCP ──
  r.add("GET", "/api/admin/mcp", guard(() => json({
    file: mcp.file, config: mcp.readConfigText(), servers: mcp.status(),
    import_sources: mcpImportSources().map((s) => ({ ...s, exists: fs.existsSync(s.file) })),
  })));
  r.add("PUT", "/api/admin/mcp", guard(async (req) => {
    const text = (req.json() ?? {}).config;
    if (typeof text !== "string") return json({ error: "config 必须是字符串" }, 400);
    try { JSON.parse(text); } catch (e: any) { return json({ error: `不是合法的 JSON：${e.message}` }, 400); }
    await mcp.writeConfigText(text);
    return json({ servers: mcp.status() });
  }));
  r.add("POST", "/api/admin/mcp/<name>/reconnect", guard(async (req) => { await mcp.reconnect(req.params.name); return json({ servers: mcp.status() }); }));
  /** 从 pi / Claude Desktop / Cursor 的配置里把 mcpServers 合并过来（同名的不覆盖） */
  r.add("POST", "/api/admin/mcp/import", guard(async (req) => {
    const src = mcpImportSources().find((s) => s.id === String((req.json() ?? {}).from));
    if (!src) return json({ error: "不认识的来源" }, 400);
    if (!fs.existsSync(src.file)) return json({ error: `没找到 ${src.file}` }, 404);
    const theirs = JSON.parse(fs.readFileSync(src.file, "utf8"))?.mcpServers ?? {};
    const ours = JSON.parse(mcp.readConfigText() || "{}");
    ours.mcpServers ??= {};
    const added: string[] = [], skipped: string[] = [];
    for (const [k, v] of Object.entries(theirs)) {
      if (k in ours.mcpServers) skipped.push(k); else { ours.mcpServers[k] = v; added.push(k); }
    }
    await mcp.writeConfigText(JSON.stringify(ours, null, 2));
    return json({ added, skipped, servers: mcp.status() });
  }));
}
