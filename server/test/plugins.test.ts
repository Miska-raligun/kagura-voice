import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir, makeRuntime } from "./helpers.ts";
import { McpManager, expandValue, exposureOf, toolName, validateServer } from "../src/agent/mcp.ts";
import { Extensions, extensionTools, GLOBAL, loadExtension } from "../src/agent/extensions.ts";
import { mcpImportSources } from "../src/routes/admin-plugins.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "mcp-echo.mjs");
const scopeOf = (trusted: boolean): any => ({ agentId: "main", sessionKey: "k", kind: "main", channel: "device", purpose: "chat", hop: 0, chain: [], meta: {}, trusted });
const text = (r: any) => r.content.map((c: any) => c.text).join("");

describe("MCP 配置小函数", () => {
  it("工具名 mcp__服务器__工具，非法字符换成 _", () => {
    expect(toolName("fs", "read_file")).toBe("mcp__fs__read_file");
    expect(toolName("my server", "a.b")).toMatch(/^mcp__my_server__a_b$/);
  });
  it("${VAR} 展开环境变量", () => {
    expect(expandValue("Bearer ${TK}", { TK: "abc" })).toBe("Bearer abc");
    expect(expandValue("x${NOPE}y", {})).toBe("xy");
  });
  it("toolExposure 隐藏指定工具；校验 command / url 至少一个", () => {
    expect(exposureOf({ command: "x", toolExposure: { secret: "hidden" } } as any, "secret")).toBe("hidden");
    expect(exposureOf({ command: "x" } as any, "echo")).toBe("direct");
    expect(validateServer("a", {})).toBeTruthy();
    expect(validateServer("a", { command: "node" })).toBe("");
  });
  it("导入来源包含 pi / Claude / Cursor", () => {
    expect(mcpImportSources({}, "/h").map((s) => s.id)).toEqual(["pi", "claude", "cursor"]);
    expect(mcpImportSources({}, "/h")[0].file).toBe(path.join("/h", ".pi", "agent", "mcp.json"));
  });
});

describe("MCP 管理（真起一个 stdio 服务器）", () => {
  let mgr: McpManager | null = null;
  afterEach(async () => { await mgr?.closeAll(); mgr = null; });

  it("连上、列出工具、调用；隐藏的工具不给模型；不可信会话默认看不到", async () => {
    const dir = tmpdir("mcp");
    mgr = new McpManager(path.join(dir, "mcp.json"), { cwd: dir });
    await mgr.writeConfigText(JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [FIXTURE], env: { ECHO_PREFIX: "${KAGURA_TEST_P}" }, toolExposure: { secret: "hidden" } } } }));
    process.env.KAGURA_TEST_P = "";
    const st = mgr.status();
    expect(st[0]).toMatchObject({ name: "echo", state: "connected", transport: "stdio" });
    expect(st[0].tools.map((t: any) => t.tool)).toEqual(["mcp__echo__echo", "mcp__echo__add", "mcp__echo__secret"]);
    const agent: any = { id: "main" };
    const tools = mgr.tools()(scopeOf(true), agent);
    expect(tools.map((t) => t.name)).toEqual(["mcp__echo__echo", "mcp__echo__add"]);
    const add = tools.find((t) => t.name === "mcp__echo__add")!;
    const r: any = await add.execute("1", { a: 2, b: 3 });
    expect(text(r)).toBe("5");
    expect(r.details).toEqual({ sum: 5 });
    expect(mgr.tools()(scopeOf(false), agent)).toEqual([]);
  });

  it("allowUntrusted 的服务器陌生人也能用；配置没变不重连，删掉就断开", async () => {
    const dir = tmpdir("mcp");
    mgr = new McpManager(path.join(dir, "mcp.json"), { cwd: dir });
    const cfg = { mcpServers: { e: { command: process.execPath, args: [FIXTURE], allowUntrusted: true } } };
    await mgr.writeConfigText(JSON.stringify(cfg));
    expect(mgr.tools()(scopeOf(false), {} as any).length).toBe(3);
    const before = (mgr as any).servers.get("e").client;
    await mgr.writeConfigText(JSON.stringify(cfg));
    expect((mgr as any).servers.get("e").client).toBe(before);
    await mgr.writeConfigText(JSON.stringify({ mcpServers: {} }));
    expect(mgr.status()).toEqual([]);
  });

  it("起不来的服务器标成出错并带上原因；格式错的配置单独列出", async () => {
    const dir = tmpdir("mcp");
    mgr = new McpManager(path.join(dir, "mcp.json"), { cwd: dir });
    await mgr.writeConfigText(JSON.stringify({ mcpServers: { bad: { command: process.execPath, args: ["-e", "console.error('nope'); process.exit(3)"], timeout: 5 }, empty: {} } }));
    const st = mgr.status();
    expect(st.find((s) => s.name === "bad")!.state).toBe("error");
    expect(st.find((s) => s.name === "empty")!.error).toBeTruthy();
    expect(() => JSON.parse("{")).toThrow();
    await expect(mgr.writeConfigText("{")).rejects.toThrow();
  });
});

const EXT = `import { Type } from "@earendil-works/pi-ai";
import { greet } from "./lib/greet";
import os from "node:os";
export default function (pi) {
  pi.registerTool({
    name: "hello_tool", label: "打招呼", description: "say hi",
    parameters: Type.Object({ who: Type.String() }),
    async execute(id, params: { who: string }, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: greet(params.who) + "@" + ctx.agentId + (typeof os.hostname() === "string" ? "" : "?") }], details: { ok: true } };
    },
  });
  pi.registerTool({ name: "open_tool", description: "open", parameters: Type.Object({}), allowUntrusted: true, execute: async () => "公开" });
  pi.registerCommand("x", {});
  pi.on("session_start", () => {});
}`;

describe("扩展（pi 格式）", () => {
  it("TS 扩展：相对 import、node 内置模块、ctx；不支持的 API 记下来但不报错", async () => {
    const dir = tmpdir("ext");
    fs.mkdirSync(path.join(dir, "lib"));
    fs.writeFileSync(path.join(dir, "lib", "greet.ts"), "export const greet = (w: string): string => `你好，${w}`;\n");
    fs.writeFileSync(path.join(dir, "hello.ts"), EXT);
    const e = await loadExtension(path.join(dir, "hello.ts"), GLOBAL, "hello");
    expect(e.error).toBe("");
    expect(e.tools.map((t) => t.name)).toEqual(["hello_tool", "open_tool"]);
    expect(e.unsupported).toEqual(expect.arrayContaining(["registerCommand", "on"]));
  });

  it("语法错 / 没有 default 导出 / 工具名非法 → error 里说清楚", async () => {
    const dir = tmpdir("ext");
    const load = async (code: string) => { fs.writeFileSync(path.join(dir, "x.ts"), code); return (await loadExtension(path.join(dir, "x.ts"), GLOBAL, "x")).error; };
    expect(await load("export default function (pi) { let = ; }")).toBeTruthy();
    expect(await load("export const a = 1;")).toMatch(/export default/);
    expect(await load(`export default (pi) => pi.registerTool({ name: "坏 名字", description: "", parameters: {}, execute: async () => "" })`)).toBeTruthy();
  });

  it("运行时：全局 + 自己的扩展；不可信会话只给 allowUntrusted；extension_* 只在可信会话里有", async () => {
    const { rt, reg, fake } = makeRuntime();
    const gdir = tmpdir("gext");
    const exts = new Extensions(gdir, reg);
    rt.addTools(extensionTools(exts));
    rt.addTools(exts.tools());
    // agent 自己写一个工具
    fake.queue.push({ tool_calls: [{ name: "extension_write", args: { name: "hello", code: EXT.replace('import { greet } from "./lib/greet";', "const greet = (w) => `你好，${w}`;") } }], then: "写好了" });
    const r1 = await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "device", text: "给自己写个打招呼工具", trusted: true });
    expect(r1.toolCalls).toEqual(["extension_write"]);
    const owned = exts.list().find((e) => e.name === "hello")!;
    expect(owned.owner).toBe("main");
    expect(owned.error).toBe("");
    expect(fs.existsSync(path.join(reg.get("main")!.workspace, "extensions", "hello.ts"))).toBe(true);
    // 下一轮直接调用
    fake.queue.push({ tool_calls: [{ name: "hello_tool", args: { who: "主人" } }], then: "好了" });
    await rt.run({ agentId: "main", sessionKey: "main:main", kind: "main", channel: "device", text: "打个招呼", trusted: true });
    const tr = rt.store("main").history("main:main").map((h) => h.msg).filter((m: any) => m.role === "toolResult").pop() as any;
    expect(tr.isError).toBeFalsy();
    expect(tr.content[0].text).toBe("你好，主人@main");
    // 别的 agent 看不到 main 自己的扩展；不可信会话只有 open_tool、没有 extension_*
    const names = (scope: any, id: string) => (rt as any).toolsFor(scope, reg.get(id)!, { text: "" }).map((t: any) => t.name);
    expect(names(scopeOf(true), "mio")).not.toContain("hello_tool");
    const untrusted = names({ ...scopeOf(false), channel: "feishu" }, "main");
    expect(untrusted).toContain("open_tool");
    expect(untrusted).not.toContain("hello_tool");
    expect(untrusted).not.toContain("extension_write");
    // 删除挪进回收站
    await exts.remove("main", "hello");
    expect(exts.list().length).toBe(0);
    expect(fs.readdirSync(path.join(reg.get("main")!.workspace, "extensions", ".trash")).length).toBe(1);
  });

  it("扩展里 registerMcpServer 的服务器交给 MCP 管理", async () => {
    const { reg } = makeRuntime();
    const gdir = tmpdir("gext");
    fs.writeFileSync(path.join(gdir, "withmcp.js"), `export default (pi) => pi.registerMcpServer("from_ext", { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FIXTURE)}] });`);
    const exts = new Extensions(gdir, reg);
    let got: any[] = [];
    exts.onMcpServers = (l) => { got = l; };
    await exts.reloadAll();
    expect(got).toMatchObject([{ name: "from_ext", source: "扩展 withmcp" }]);
  });
});
