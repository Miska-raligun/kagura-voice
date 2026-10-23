// 「大脑」接口：把一条用户消息交给某个 agent，返回回复文本。
// M2 只有 OpenClaw 适配器（与 Python 版行为一致）；M3 起加入基于 pi 的内置 agent。
export interface ChatRequest {
  message: string;
  sessionId: string;
  agent: string;
  imagePath?: string | null;
  localTime?: string;
}
export interface Brain {
  chat(req: ChatRequest): Promise<string>;
}
