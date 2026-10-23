// M0 验证：pi-agent-core + faux 假模型，跑通「工具调用 → 工具结果 → 逐字输出」一整轮。
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";

const faux = fauxProvider({ models: [{ id: "fake-1", input: ["text", "image"] }], tokensPerSecond: 2000 });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

// 第一次调用：模型决定调用 speak 工具；第二次：拿到工具结果后说一句话
faux.setResponses([
  fauxAssistantMessage([fauxText("好的，"), fauxToolCall("speak", { text: "主人回来啦" })], { stopReason: "toolUse" }),
  (ctx) => {
    const last = ctx.messages.at(-1) as any;
    return fauxAssistantMessage(`已经播报了（工具返回：${JSON.stringify(last?.content?.[0]?.text ?? last?.content)}）。还有什么事吗？`);
  },
]);

const spoken: string[] = [];
const speak: AgentTool<any> = {
  name: "speak",
  label: "播报",
  description: "让设备用语音说一句话",
  parameters: Type.Object({ text: Type.String() }),
  async execute(_id, params: any) {
    spoken.push(params.text);
    return { content: [{ type: "text", text: "ok" }], details: {} };
  },
};

const agent = new Agent({
  initialState: { systemPrompt: "你是神乐。", model, tools: [speak] },
  streamFn: models.streamSimple.bind(models),
});

const deltas: string[] = [];
const kinds = new Set<string>();
agent.subscribe((e: any) => {
  kinds.add(e.type);
  if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") deltas.push(e.assistantMessageEvent.delta);
});

await agent.prompt("我回来了");
await agent.waitForIdle();

const text = deltas.join("");
console.log("事件类型:", [...kinds].join(", "));
console.log("逐字片段数:", deltas.length, " 拼起来:", text);
console.log("工具被调用:", spoken);
console.log("消息条数:", agent.state.messages.length, " 模型调用次数:", faux.state.callCount);
const last = agent.state.messages.at(-1) as any;
console.log("最后一条 usage:", JSON.stringify(last.usage));
if (spoken[0] !== "主人回来啦" || !text.includes("还有什么事吗") || deltas.length < 3) {
  console.error("❌ 验证失败"); process.exit(1);
}
console.log("✅ pi agent：工具调用 + 流式输出 跑通");
