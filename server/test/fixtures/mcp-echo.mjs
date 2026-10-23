// 测试用的最小 MCP 服务器（stdio，一行一个 JSON-RPC 消息）。工具：echo、add、secret
import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const TOOLS = [
  { name: "echo", description: "原样返回 text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "add", description: "a+b", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
  { name: "secret", description: "不该给模型看的", inputSchema: { type: "object", properties: {} } },
];
process.stderr.write(`mcp-echo started ${process.env.ECHO_PREFIX ?? ""}\n`);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;                       // 通知
  const ok = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": return ok({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" }, instructions: "测试服务器" });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments: a = {} } = m.params;
      if (name === "echo") return ok({ content: [{ type: "text", text: `${process.env.ECHO_PREFIX ?? ""}${a.text}` }] });
      if (name === "add") return ok({ content: [{ type: "text", text: String(a.a + a.b) }], structuredContent: { sum: a.a + a.b } });
      return ok({ content: [{ type: "text", text: "boom" }], isError: true });
    }
    default: return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } });
  }
});
