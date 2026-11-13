// 系统提示瘦身：今昨笔记只带最近的、不带后台流水；工具按需加载（tools_load、没加载就调会自动补上、会话里记着、干活的场景全给）
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { makeRuntime, tmpdir } from "./helpers.ts";
import { recentNotes, dailyNotePath, buildSystemPrompt, BUDGETS } from "../src/agent/soul.ts";
import { Memories } from "../src/agent/tools/memory.ts";
import { AgentRegistry } from "../src/agent/registry.ts";
import { ModelRegistry } from "../src/agent/models.ts";
import { Runtime } from "../src/agent/runtime.ts";
import { LOAD_TOOL, LazyTools, AUTO_LAZY_TOKENS } from "../src/agent/toolgroups.ts";
import { McpManager } from "../src/agent/mcp.ts";

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

describe("今昨笔记", () => {
  it("只带最近的几条（从最新的往回数），聊天不带后台流水、heartbeat 照带；超了说明还有多少没带", () => {
    const { reg } = makeRuntime();
    const ws = reg.get("main")!.workspace;
    const now = new Date(), yest = new Date(now.getTime() - 86400_000);
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    fs.writeFileSync(dailyNotePath(ws, yest), `# ${day(yest)}\n\n` + Array.from({ length: 30 }, (_, i) => `- 09:${String(i).padStart(2, "0")} 昨天的第 ${i} 件事，写得稍微长一点凑字数凑字数凑字数`).join("\n") + "\n");
    fs.writeFileSync(dailyNotePath(ws, now), `# ${day(now)}\n\n- 08:00 [heartbeat] 检查了一遍，没事\n- 08:30 heartbeat：日历上没有新的安排\n- 09:00 主人说下午三点开会\n- 09:30 [定时任务] 早报发了\n- 10:00 主人让我周五提醒他交报告\n`);
    const r = recentNotes(ws, "owner", 300, now);
    expect(r.text).toContain("主人让我周五提醒他交报告");
    expect(r.text).toContain("主人说下午三点开会");
    expect(r.text).not.toMatch(/heartbeat|早报/);
    expect(r.text).toContain("昨天的第 29 件事");          // 留的是最新的
    expect(r.text).not.toContain("昨天的第 0 件事");
    expect(r.chars).toBeLessThan(420);
    expect(r.total).toBeGreaterThan(1000);
    expect(r.text).toMatch(/只带了最近的 \d+ 条，还有 \d+ 条更早的 \/ 后台记录没带/);
    expect(r.text.indexOf(`## ${day(yest)}`)).toBeLessThan(r.text.indexOf(`## ${day(now)}`));
    // heartbeat 场景要看自己刚做过什么
    expect(recentNotes(ws, "heartbeat", 300, now).text).toContain("[heartbeat] 检查了一遍");
    // 系统提示里用的就是它；默认上限 1500
    expect(BUDGETS.daily).toBe(1500);
    const sys = buildSystemPrompt({ agent: reg.get("main")!, scene: "owner", channel: "webchat" });
    expect(sys).toContain("<recent_notes>");
    expect(sys).not.toContain("检查了一遍，没事");
  });

  it("后台场景（heartbeat / 定时任务 / 待办）用 memory_write 记的笔记带标记；主人对话里记的不带", async () => {
    const { rt, reg } = makeRuntime();
    const mem = new Memories(rt, null);
    const ws = reg.get("main")!.workspace;
    const write = (purpose: string, text: string) => {
      const scope: any = { agentId: "main", sessionKey: "main:x", kind: "main", channel: "system", purpose, hop: 0, chain: [], meta: {}, trusted: true };
      return mem.tools()(scope, reg.get("main")!).find((t) => t.name === "memory_write")!.execute("t", { target: "daily", text });
    };
    await write("heartbeat", "看了一眼日历，没有新安排");
    await write("cron", "早报发了");
    await write("chat", "主人说周末去爬山");
    const lines = fs.readFileSync(dailyNotePath(ws), "utf8").split("\n").filter((l) => l.startsWith("- "));
    expect(lines.map((l) => l.replace(/^- \d\d:\d\d /, ""))).toEqual(["[heartbeat] 看了一眼日历，没有新安排", "[定时任务] 早报发了", "主人说周末去爬山"]);
    expect(recentNotes(ws, "owner", 1500).text).not.toMatch(/日历|早报/);
  });
});

const fakeTool = (name: string, log: string[]) => ({ name, label: name, description: `${name} 的说明`, parameters: Type.Object({}), execute: async () => { log.push(name); return { content: [{ type: "text", text: `${name} 做完了` }], details: {} }; } }) as any;
const chat = { agentId: "main", sessionKey: "main:main", kind: "main" as const, channel: "webchat" };

describe("工具按需加载", () => {
  function setup() {
    const env = makeRuntime();
    const log: string[] = [];
    env.rt.lazyTools = true;
    env.rt.addTools(() => ["exec", "cron_add", "cron_list", "cron_update", "extension_write", "sessions_send", "sessions_spawn"].map((n) => fakeTool(n, log)));
    const results = () => env.rt.store("main").history("main:main").map((h) => h.msg as any).filter((m) => m.role === "toolResult").map((m) => [m.toolName ?? "", !!m.isError, m.content[0].text]);
    return { ...env, log, results };
  }

  it("用得少的几组先收着，系统提示里留目录；tools_load 之后同一轮就能直接调，这个会话下一轮也还在", async () => {
    const { rt, fake, log, results } = setup();
    fake.queue.push({ tool_calls: [{ name: LOAD_TOOL, args: { groups: ["cron"] } }], then: { tool_calls: [{ name: "cron_list" }], then: "你有两个定时任务" } });
    const r = await rt.run({ ...chat, text: "我有哪些定时任务" });
    expect(r.text).toBe("你有两个定时任务");
    expect(log).toEqual(["cron_list"]);
    const k = (rt.store("main").history("main:main").at(-1)!.msg as any).kctx;
    expect(k.deferred).toEqual(["agents", "ext"]);            // cron 这一轮加载了，剩下两组还收着
    expect(results()[0][2]).toMatch(/加载好了.*\n?cron：cron_list（cron_list）、cron_update/s);
    // 下一轮：cron 组直接能用，不用再加载
    fake.queue.push({ tool_calls: [{ name: "cron_update" }], then: "改好了" });
    expect((await rt.run({ ...chat, text: "把第一个改到九点" })).text).toBe("改好了");
    expect(log).toEqual(["cron_list", "cron_update"]);
  });

  it("目录写清楚每组有什么；常用的（cron_add、sessions_send、exec）一直在外面；没有这个组会说有哪些", async () => {
    const { rt, fake, log, results } = setup();
    fake.queue.push({ tool_calls: [{ name: "cron_add" }, { name: "sessions_send" }, { name: "exec" }, { name: LOAD_TOOL, args: { groups: ["nope"] } }], then: "好" });
    await rt.run({ ...chat, text: "提醒我三点开会" });
    expect(log).toEqual(["cron_add", "sessions_send", "exec"]);
    expect(results().at(-1)).toEqual([LOAD_TOOL, true, expect.stringContaining("没有这个工具组：nope。还没加载的有：cron、agents、ext")]);
  });

  it("没加载就直接调收着的工具（照着以前的对话调）：先报没找到，系统替她加载好、让她重调一次；那句提示不进历史", async () => {
    const { rt, fake, log, results } = setup();
    fake.queue.push({ tool_calls: [{ name: "extension_write" }], then: "不该用到" }, { tool_calls: [{ name: "extension_write" }], then: "扩展写好了" });
    const r = await rt.run({ ...chat, text: "给自己写个查天气的扩展" });
    expect(r.text).toBe("扩展写好了");
    expect(log).toEqual(["extension_write"]);
    expect(results().map((x) => x[1])).toEqual([true, false]);
    expect(results()[0][2]).toContain("not found");
    const hist = JSON.stringify(rt.store("main").history("main:main"));
    expect(hist).not.toContain("刚才还没加载");
  });

  it("干活的场景（待办、子任务）全给，不用加载；关掉开关也全给", async () => {
    const { rt, fake, log } = setup();
    fake.queue.push({ tool_calls: [{ name: "cron_update" }], then: "做完了\n状态：完成" });
    await rt.run({ agentId: "main", sessionKey: "main:task:1", kind: "isolated", channel: "system", purpose: "task", text: "改定时任务" });
    rt.lazyTools = false;
    fake.queue.push({ tool_calls: [{ name: "sessions_spawn" }], then: "派出去了" });
    await rt.run({ ...chat, text: "派个子任务" });
    expect(log).toEqual(["cron_update", "sessions_spawn"]);
  });
});

describe("MCP 服务器按需加载", () => {
  const FIXTURE = path.join(import.meta.dirname, "fixtures", "mcp-echo.mjs");
  const mcpTool = (server: string, name: string, log: string[], o: { lazy?: boolean; hint?: string; pad?: number } = {}) => ({
    ...fakeTool(`mcp__${server}__${name}`, log), description: `[MCP ${server}] ${name} ${"说明".repeat(o.pad ?? 5)}`,
    lazyGroup: { id: `mcp_${server}`, label: `MCP 服务器 ${server}`, hint: o.hint ?? "", lazy: o.lazy },
  });
  const lazyOf = (tools: any[], loaded = new Set<string>()) => new LazyTools(tools, loaded, (t) => t, () => {});

  it("一个服务器一组：工具定义多的默认收着，小的照常摆着；lazy: true / false 说了算", () => {
    const log: string[] = [];
    const big = Array.from({ length: 20 }, (_, i) => mcpTool("browser", `browser_op${i}`, log, { pad: 60, hint: "操作浏览器：打开网页、点击、填表、截图" }));
    const small = ["get", "set"].map((n) => mcpTool("weather", n, log));
    const forced = ["a"].map((n) => mcpTool("tiny", n, log, { lazy: true }));
    const pinned = Array.from({ length: 20 }, (_, i) => mcpTool("always", `op${i}`, log, { pad: 60, lazy: false }));
    const lz = lazyOf([fakeTool("exec", log), fakeTool("cron_list", log), ...big, ...small, ...forced, ...pinned]);
    expect([...lz.hidden().keys()]).toEqual(["cron", "mcp_browser", "mcp_tiny"]);           // 内置的组在前
    const names = lz.visible().map((t) => t.name);
    expect(names).toContain("mcp__weather__get");
    expect(names).toContain("mcp__always__op0");
    expect(names).not.toContain("mcp__browser__browser_op0");
    expect(names.at(-1)).toBe(LOAD_TOOL);
    expect(lz.groupOf("mcp__browser__browser_op3")).toBe("mcp_browser");
    expect(lz.groupOf("mcp__weather__get")).toBe("");
    // 目录：一行说明 + 一共几个 + 前几个名字（去掉共同前缀），不把二十个定义都摆出来
    const cat = lz.catalog();
    expect(cat).toContain("- mcp_browser（MCP 服务器 browser）：操作浏览器：打开网页、点击、填表、截图——共 20 个工具（名字以 mcp__browser__ 开头）：browser_op0、browser_op1");
    expect(cat).toContain("browser_op11 等");
    expect(cat).not.toContain("browser_op12");
    expect(cat).toContain("- mcp_tiny（MCP 服务器 tiny）：共 1 个工具（名字以 mcp__tiny__ 开头）：a");
    expect(cat.length).toBeLessThan(900);
    expect(AUTO_LAZY_TOKENS).toBe(800);
  });

  it("tools_load 认组名，也认只写服务器名 / 写了里面某个工具名", async () => {
    const log: string[] = [];
    const mk = () => lazyOf([...["a", "b"].map((n) => mcpTool("browser", n, log, { lazy: true })), ...["x"].map((n) => mcpTool("notes", n, log, { lazy: true }))]);
    const load = async (lz: LazyTools, groups: string[]) => (await lz.visible().at(-1)!.execute("1", { groups } as any) as any);
    let lz = mk();
    expect((await load(lz, ["browser"])).details.loaded).toEqual(["mcp_browser"]);
    expect(lz.visible().map((t) => t.name)).toEqual(["mcp__browser__a", "mcp__browser__b", LOAD_TOOL]);
    expect((await load(lz, ["mcp__notes__x"])).details.loaded).toEqual(["mcp_notes"]);
    expect(lz.visible().map((t) => t.name)).not.toContain(LOAD_TOOL);            // 都加载了，tools_load 也不用摆了
    lz = mk();
    expect((await load(lz, ["nope"])).content[0].text).toContain("还没加载的有：mcp_browser、mcp_notes");
  });

  it("真起一个 MCP 服务器：收着时模型看不到它的工具，tools_load 之后同一轮就能调；没加载就直接调也会自动补上", async () => {
    const env = makeRuntime();
    env.rt.lazyTools = true;
    const dir = tmpdir("mcp-lazy");
    const mgr = new McpManager(path.join(dir, "mcp.json"), { cwd: dir });
    try {
      await mgr.writeConfigText(JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [FIXTURE], lazy: true, description: "回声和加法" }, plain: { command: process.execPath, args: [FIXTURE] } } }));
      // 管理界面：每个服务器的工具定义占多少、是不是按需加载（小服务器默认一直带着）
      const st = Object.fromEntries(mgr.status().map((s: any) => [s.name, s]));
      expect(st.echo.lazy).toBe(true);
      expect(st.plain.lazy).toBe(false);
      expect(st.plain.tokens).toBeGreaterThan(20);
      expect(st.plain.tokens).toBeLessThan(AUTO_LAZY_TOKENS);
      env.rt.addTools(mgr.tools(), { plugin: true });
      const results = () => env.rt.store("main").history("main:main").map((h) => h.msg as any).filter((m) => m.role === "toolResult").map((m) => [m.toolName ?? "", !!m.isError, m.content[0].text]);
      env.fake.queue.push({ tool_calls: [{ name: LOAD_TOOL, args: { groups: ["mcp_echo"] } }], then: { tool_calls: [{ name: "mcp__echo__add", args: { a: 2, b: 3 } }, { name: "mcp__plain__echo", args: { text: "嗨" } }], then: "是 5" } });
      expect((await env.rt.run({ ...chat, text: "二加三" })).text).toBe("是 5");
      expect(results().map((r) => [r[0], r[1]])).toEqual([[LOAD_TOOL, false], ["mcp__echo__add", false], ["mcp__plain__echo", false]]);
      expect(results()[1][2]).toBe("5");
      // 另一个会话里没加载过：照着以前的对话直接调 → 先报没找到，系统替她加载、让她重调
      const other = { ...chat, sessionKey: "main:webchat:2", kind: "isolated" as const };
      env.fake.queue.push({ tool_calls: [{ name: "mcp__echo__echo", args: { text: "在吗" } }], then: "不该用到" }, { tool_calls: [{ name: "mcp__echo__echo", args: { text: "在吗" } }], then: "在" });
      expect((await env.rt.run({ ...other, text: "喊一声" })).text).toBe("在");
      const k = (env.rt.store("main").history(other.sessionKey).at(-1)!.msg as any).kctx;
      expect(k.deferred).toEqual([]);
      // 待办这类干活的场景不收
      env.fake.queue.push({ tool_calls: [{ name: "mcp__echo__add", args: { a: 1, b: 1 } }], then: "做完了\n状态：完成" });
      const r = await env.rt.run({ agentId: "main", sessionKey: "main:task:9", kind: "isolated", channel: "system", purpose: "task", text: "算一下" });
      expect(r.text).toContain("做完了");
      expect((env.rt.store("main").history("main:task:9").find((h) => (h.msg as any).role === "toolResult")!.msg as any).isError).toBeFalsy();
    } finally { await mgr.closeAll(); }
  });
});

describe("发给服务商的工具列表", () => {
  it("第一次请求只有常用的 + tools_load；调了 tools_load 之后，同一轮的下一次请求里那组工具就在了", async () => {
    const bodies: any[] = [];
    const srv = http.createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (o: any) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`);
        if (bodies.length === 1) {
          chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: LOAD_TOOL, arguments: '{"groups":["cron"]}' } }] }, finish_reason: null }] });
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        } else {
          chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "好了" }, finish_reason: null }] });
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        }
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const root = tmpdir();
      fs.mkdirSync(path.join(root, "agents"));
      const reg = new AgentRegistry(path.join(root, "agents"));
      reg.load([{ id: "", name: "神乐", agent: "main", per: 111 }]);
      const models = new ModelRegistry({ providers: [{ id: "mm", api: "openai-completions", base_url: `http://127.0.0.1:${(srv.address() as any).port}/v1`, api_key: "k", models: [{ id: "m" }] }], default: "mm/m", cheap: "" } as any);
      const rt = new Runtime(reg, models, { maxConcurrency: 2, timeoutSecs: 10 });
      rt.backgroundCompact = false;
      rt.addTools(() => ["exec", "cron_add", "cron_list", "cron_update", "extension_write"].map((n) => fakeTool(n, [])));
      const r = await rt.run({ ...chat, text: "看看定时任务" });
      expect(r.text).toBe("好了");
      const names = (b: any) => (b.tools ?? []).map((t: any) => t.function?.name ?? t.name).sort();
      expect(names(bodies[0])).toEqual(["cron_add", "exec", LOAD_TOOL].sort());
      expect(names(bodies[1])).toEqual(["cron_add", "cron_list", "cron_update", "exec", LOAD_TOOL].sort());
      const sys = JSON.stringify(bodies[0].messages[0]);
      expect(sys).toContain("<more_tools>");
      expect(sys).toContain("cron（定时任务管理）");
      rt.close();
    } finally { srv.close(); }
  });

  it("Anthropic 格式的接口也一样：加载后下一次请求的 tools 里有那组工具，消息里只有 user / assistant（没有中途插进去的系统消息）", async () => {
    const bodies: any[] = [];
    const srv = http.createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ev = (t: string, o: any) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...o })}\n\n`);
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "c", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
        if (bodies.length === 1) {
          ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: LOAD_TOOL, input: {} } });
          ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"groups":["cron"]}' } });
          ev("content_block_stop", { index: 0 });
          ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } });
        } else {
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "好了" } });
          ev("content_block_stop", { index: 0 });
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
        }
        ev("message_stop", {});
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const root = tmpdir();
      fs.mkdirSync(path.join(root, "agents"));
      const reg = new AgentRegistry(path.join(root, "agents"));
      reg.load([{ id: "", name: "神乐", agent: "main", per: 111 }]);
      const models = new ModelRegistry({ providers: [{ id: "an", api: "anthropic-messages", base_url: `http://127.0.0.1:${(srv.address() as any).port}`, api_key: "k", models: [{ id: "c" }] }], default: "an/c", cheap: "" } as any);
      const rt = new Runtime(reg, models, { maxConcurrency: 2, timeoutSecs: 10 });
      rt.backgroundCompact = false;
      rt.addTools(() => ["exec", "cron_add", "cron_list", "cron_update", "extension_write"].map((n) => fakeTool(n, [])));
      expect((await rt.run({ ...chat, text: "看看定时任务" })).text).toBe("好了");
      const names = (b: any) => (b.tools ?? []).map((t: any) => t.name).sort();
      expect(names(bodies[0])).toEqual(["cron_add", "exec", LOAD_TOOL].sort());
      expect(names(bodies[1])).toEqual(["cron_add", "cron_list", "cron_update", "exec", LOAD_TOOL].sort());
      expect(bodies[1].messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(JSON.stringify(bodies[0].system)).toContain("<more_tools>");
      rt.close();
    } finally { srv.close(); }
  });
});
