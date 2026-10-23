// M0 验证：createProvider + OpenAI 兼容接口（本地假服务器模拟 SSE 流式），并验证工具 terminate 提前结束本轮。
import http from "node:http";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, Type, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

let calls = 0;
let seenAuth = "";
let seenBody: any = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls++;
    seenAuth = String(req.headers.authorization);
    seenBody = JSON.parse(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o: any) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "fake" };
    // 先说半句，再调用 take_photo
    for (const t of ["我", "看", "看"]) send({ ...base, choices: [{ index: 0, delta: { content: t } }] });
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "take_photo", arguments: "{\"question\":\"桌上有什么\"}" } }] } }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 } });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;

const m: Model<"openai-completions"> = {
  id: "fake-chat", name: "fake", api: "openai-completions", provider: "custom",
  baseUrl: `http://127.0.0.1:${port}/v1`, reasoning: false, input: ["text", "image"],
  cost: { input: 0.8, output: 2, cacheRead: 0.16, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
} as any;
const provider = createProvider({
  id: "custom", name: "Custom",
  baseUrl: m.baseUrl,
  auth: { apiKey: { name: "Custom", resolve: async () => ({ auth: { apiKey: "sk-test-123" } }) } } as any,
  models: [m],
  api: openAICompletionsApi(),
});
const models = createModels();
models.setProvider(provider);

let photoQ = "";
const takePhoto: AgentTool<any> = {
  name: "take_photo", label: "拍照", description: "拍照并看图",
  parameters: Type.Object({ question: Type.String() }),
  async execute(_id, p: { question: string }) {
    photoQ = p.question;
    return { content: [{ type: "text", text: "已请求设备拍照" }], details: {}, terminate: true };
  },
};
const agent = new Agent({ initialState: { systemPrompt: "你是神乐。", model: models.getModel("custom", "fake-chat")!, tools: [takePhoto] }, streamFn: models.streamSimple.bind(models) });
let text = "";
agent.subscribe((e: any) => { if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") text += e.assistantMessageEvent.delta; });
await agent.prompt("看看桌上有什么");
await agent.waitForIdle();
server.close();

const last = agent.state.messages.filter((x: any) => x.role === "assistant").at(-1) as any;
console.log("HTTP 调用次数:", calls, " Authorization:", seenAuth, " 请求带 tools:", !!seenBody?.tools?.length, " stream:", seenBody?.stream);
console.log("流式文本:", text, " 拍照问题:", photoQ);
console.log("usage:", JSON.stringify(last.usage));
if (calls !== 1 || photoQ !== "桌上有什么" || text !== "我看看" || seenAuth !== "Bearer sk-test-123") { console.error("❌ 失败"); process.exit(1); }
console.log("✅ OpenAI 兼容接口 + SSE 流式 + 工具 terminate（只调一次模型）跑通");
