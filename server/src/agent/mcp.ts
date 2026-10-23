// MCP 服务器（用 pi 官方的 @earendil-works/pi-mcp 客户端）。
//
// 配置：<数据目录>/mcp.json，格式与 pi / Claude Desktop / Cursor 相同，现成的 mcpServers 条目直接拷过来：
//   { "mcpServers": {
//       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/docs"] },
//       "docs":       { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } } } }
// 本地进程用 command/args/env/cwd，远程用 url/headers（streamable HTTP）。env / headers 里可以写 ${环境变量}。
// 每个工具注册成 mcp__<服务器>__<工具>。exposure / toolExposure 只认 direct（默认）和 hidden——这里没有 pi 的 codemode，
// 从 pi 抄来的 codemode / deferred 一律当 direct。
// 和执行命令一样，MCP 工具默认只在可信会话（主人）里出现；某个服务器确实无害（查天气之类）可以加 "allowUntrusted": true。
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type Tool as McpTool } from "@earendil-works/pi-mcp";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunScope } from "./scope.ts";
import type { AgentInfo } from "./registry.ts";

export interface McpServerConfig {
  type?: string;
  command?: string; args?: string[]; env?: Record<string, string>; cwd?: string;
  url?: string; headers?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
  description?: string;
  exposure?: string;
  toolExposure?: Record<string, string>;
  /** Kagura 扩展：IM 陌生人的会话里也能用（默认只给主人） */
  allowUntrusted?: boolean;
}

export type ServerState = "disabled" | "connecting" | "connected" | "error";

interface Server {
  name: string;
  cfg: McpServerConfig;
  source: string;
  state: ServerState;
  error: string;
  client: McpClient | null;
  transport: StdioTransport | StreamableHttpTransport | null;
  tools: McpTool[];
  stderr: string;
  instructions: string;
  connecting: Promise<void> | null;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** mcp__<server>__<tool>，只留字母数字下划线，最长 64（模型服务商的限制） */
export function toolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);
}

/** ${VAR} 换成环境变量；整个值是 !命令 时取命令输出（与 pi 一致） */
export function expandValue(v: string, env: NodeJS.ProcessEnv = process.env): string {
  if (v.startsWith("!")) {
    try { return execSync(v.slice(1), { encoding: "utf8", timeout: 15000, windowsHide: true }).trim(); } catch { return ""; }
  }
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, k) => env[k] ?? "");
}

const expandHome = (v: string) => (v.startsWith("~/") ? path.join(process.env.HOME || process.env.USERPROFILE || "", v.slice(2)) : v);

/** 这个工具给不给模型看：toolExposure 精确名 > 通配（第一个命中）> 服务器 exposure；只有 hidden 是不给 */
export function exposureOf(cfg: McpServerConfig, tool: string): "direct" | "hidden" {
  const te = cfg.toolExposure ?? {};
  let e: string | undefined = te[tool];
  if (e === undefined) {
    for (const [pat, val] of Object.entries(te)) {
      if (!pat.includes("*")) continue;
      const re = new RegExp("^" + pat.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      if (re.test(tool)) { e = val; break; }
    }
  }
  return (e ?? cfg.exposure ?? "direct") === "hidden" ? "hidden" : "direct";
}

/** 校验一个条目，返回问题（空 = 没问题） */
export function validateServer(name: string, cfg: any): string {
  if (!NAME_RE.test(name)) return "名字只能用字母、数字、_ 和 -";
  if (!cfg || typeof cfg !== "object") return "配置不是对象";
  if (cfg.type === "sse") return "不支持旧的 SSE 传输；这类服务器一般也提供 streamable HTTP（地址常是 /mcp 而不是 /sse）";
  if (cfg.type && !["stdio", "http", "streamable-http"].includes(cfg.type)) return `不认识的 type：${cfg.type}`;
  if (!cfg.command && !cfg.url) return "要有 command（本地进程）或 url（远程服务器）";
  if (cfg.command && typeof cfg.command !== "string") return "command 必须是一个可执行文件名（参数放 args）";
  if (cfg.args && !Array.isArray(cfg.args)) return "args 必须是数组";
  return "";
}

export class McpManager {
  private servers = new Map<string, Server>();
  /** 扩展里 registerMcpServer 加的 */
  private extra = new Map<string, { cfg: McpServerConfig; source: string }>();
  configErrors: { name: string; error: string }[] = [];

  constructor(readonly file: string, private opts: { fetch?: typeof fetch; cwd: string; clientName?: string; version?: string }) {}

  readConfigText(): string {
    try { return fs.readFileSync(this.file, "utf8"); } catch { return '{\n  "mcpServers": {}\n}\n'; }
  }

  /** 保存 mcp.json（先校验是 JSON），然后重新加载 */
  async writeConfigText(text: string) {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || (j.mcpServers && typeof j.mcpServers !== "object")) throw new Error("格式是 { \"mcpServers\": { 名字: {…} } }");
    fs.writeFileSync(this.file, text.endsWith("\n") ? text : text + "\n");
    await this.reload();
  }

  private readConfig(): Record<string, McpServerConfig> {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return j?.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : {};
    } catch (e: any) {
      if (fs.existsSync(this.file)) this.configErrors.push({ name: "mcp.json", error: `解析失败：${e.message}` });
      return {};
    }
  }

  setExtensionServers(list: { name: string; cfg: McpServerConfig; source: string }[]) {
    this.extra = new Map(list.map((x) => [x.name, { cfg: x.cfg, source: x.source }]));
  }

  /** 按配置（重新）连：配置没变的保持连接，变了的重连，删掉的断开 */
  async reload() {
    this.configErrors = [];
    const want = new Map<string, { cfg: McpServerConfig; source: string }>();
    for (const [n, c] of this.extra) want.set(n, c);
    for (const [n, c] of Object.entries(this.readConfig())) want.set(n, { cfg: c, source: "mcp.json" });   // 配置文件覆盖扩展里的同名项
    for (const [n, s] of this.servers) {
      const w = want.get(n);
      if (!w || JSON.stringify(w.cfg) !== JSON.stringify(s.cfg)) { await this.disconnect(s); this.servers.delete(n); }
    }
    const jobs: Promise<void>[] = [];
    for (const [name, { cfg, source }] of want) {
      if (this.servers.has(name)) continue;
      const err = validateServer(name, cfg);
      if (err) { this.configErrors.push({ name, error: err }); continue; }
      const s: Server = { name, cfg, source, state: cfg.enabled === false ? "disabled" : "connecting", error: "", client: null, transport: null, tools: [], stderr: "", instructions: "", connecting: null };
      this.servers.set(name, s);
      if (s.state !== "disabled") jobs.push(this.connect(s));
    }
    await Promise.all(jobs);
  }

  private connect(s: Server): Promise<void> {
    if (s.connecting) return s.connecting;
    s.connecting = (async () => {
      s.state = "connecting"; s.error = ""; s.stderr = "";
      const timeoutMs = Math.max(5, Number(s.cfg.timeout) || 60) * 1000;
      try {
        const client = new McpClient({ name: this.opts.clientName ?? "kagura", version: this.opts.version ?? "0", requestTimeoutMs: timeoutMs });
        let transport: StdioTransport | StreamableHttpTransport;
        if (s.cfg.command) {
          const env: Record<string, string> = {};
          for (const [k, v] of Object.entries(s.cfg.env ?? {})) env[k] = expandValue(String(v));
          transport = new StdioTransport({
            command: expandHome(s.cfg.command), args: (s.cfg.args ?? []).map((a) => expandHome(String(a))),
            cwd: s.cfg.cwd ? path.resolve(this.opts.cwd, expandHome(s.cfg.cwd)) : this.opts.cwd,
            env, inheritEnv: true, stderr: "pipe",
            onStderr: (c) => { s.stderr = (s.stderr + c).slice(-4000); },
          });
        } else {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(s.cfg.headers ?? {})) headers[k] = expandValue(String(v));
          transport = new StreamableHttpTransport({ url: s.cfg.url!, headers, ...(this.opts.fetch ? { fetch: this.opts.fetch as any } : {}) });
        }
        s.transport = transport;
        await client.connect(transport);
        s.client = client;
        s.instructions = client.instructions ?? "";
        s.tools = await client.listTools({ timeoutMs });
        client.onNotification("notifications/tools/list_changed", () => { client.listTools().then((t) => { s.tools = t; }).catch(() => {}); });
        client.onClose(() => { if (s.client === client) { s.client = null; if (s.state === "connected") { s.state = "error"; s.error = "连接断开了（下次调用时重连）"; } } });
        s.state = "connected";
        console.log(`[mcp] ✅ ${s.name} 已连接，${s.tools.length} 个工具`);
      } catch (e: any) {
        s.state = "error";
        s.error = String(e?.message ?? e) + (s.stderr ? `\n${s.stderr.trim().split("\n").slice(-5).join("\n")}` : "");
        console.log(`[mcp] ⚠️  ${s.name} 连接失败：${s.error.split("\n")[0]}`);
        await this.disconnect(s, false);
      } finally { s.connecting = null; }
    })();
    return s.connecting;
  }

  private async disconnect(s: Server, resetState = true) {
    const c = s.client, t = s.transport;
    s.client = null; s.transport = null;
    try { if (c) await c.close(); else if (t) await t.close(); } catch { /* 已经断了 */ }
    if (resetState && s.state === "connected") s.state = "disabled";
  }

  async reconnect(name: string) {
    const s = this.servers.get(name);
    if (!s) throw new Error(`没有 MCP 服务器 ${name}`);
    await this.disconnect(s);
    if (s.cfg.enabled === false) { s.state = "disabled"; return; }
    await this.connect(s);
  }

  async closeAll() { for (const s of this.servers.values()) await this.disconnect(s); }

  status() {
    return [...this.servers.values()].map((s) => ({
      name: s.name, source: s.source, state: s.state, error: s.error, stderr: s.stderr.slice(-1500),
      transport: s.cfg.command ? "stdio" : "http", target: s.cfg.command ? [s.cfg.command, ...(s.cfg.args ?? [])].join(" ") : s.cfg.url,
      description: s.cfg.description || s.instructions.split("\n")[0] || "",
      allowUntrusted: !!s.cfg.allowUntrusted,
      tools: s.tools.map((t) => ({ name: t.name, tool: toolName(s.name, t.name), description: t.description ?? "", exposure: exposureOf(s.cfg, t.name) })),
    })).concat(this.configErrors.map((e) => ({ name: e.name, source: "mcp.json", state: "error" as ServerState, error: e.error, stderr: "", transport: "", target: "", description: "", allowUntrusted: false, tools: [] })));
  }

  /** 给运行时的工具提供者 */
  tools() {
    return (scope: RunScope, _agent: AgentInfo): AgentTool<any>[] => {
      const out: AgentTool<any>[] = [];
      for (const s of this.servers.values()) {
        if (s.state !== "connected" && s.state !== "error") continue;
        if (!scope.trusted && !s.cfg.allowUntrusted) continue;
        for (const t of s.tools) {
          if (exposureOf(s.cfg, t.name) === "hidden") continue;
          const schema: any = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : {};
          out.push({
            name: toolName(s.name, t.name),
            label: t.title ?? t.name,
            description: `[MCP ${s.name}] ${t.description ?? t.name}`.slice(0, 1500),
            parameters: Type.Unsafe({ ...schema, type: "object", properties: schema.properties ?? {} }),
            execute: async (_id: string, params: any, signal?: AbortSignal) => {
              if (!s.client) { await this.connect(s); if (!s.client) throw new Error(`MCP 服务器 ${s.name} 连不上：${s.error.split("\n")[0]}`); }
              const r = await s.client.callTool(t.name, (params ?? {}) as Record<string, unknown>, { signal, timeoutMs: Math.max(5, Number(s.cfg.timeout) || 60) * 1000 });
              let content: any[] = toLlmContent(r) as any[];
              // 文字结果太长（>20KB）就掐掉中间，跟 pi 一样
              content = content.map((c) => (c.type === "text" && c.text.length > 20000 ? { ...c, text: `${c.text.slice(0, 8000)}\n…（中间省略 ${c.text.length - 16000} 字）…\n${c.text.slice(-8000)}` } : c));
              return { content: content.length ? content : [{ type: "text", text: "（没有内容）" }], details: r.structuredContent ?? undefined, isError: r.isError === true };
            },
          } as AgentTool<any>);
        }
      }
      return out;
    };
  }
}
