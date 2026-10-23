// 「大脑」接口：把一条用户消息交给某个 agent，返回回复文本。
// 实现：pi.ts（内置 agent 系统，M3 起默认）、openclaw.ts（调 OpenClaw CLI）、fake.ts（契约测试）。
export interface ChatRequest {
  message: string;
  /** 旧会话 key（OpenClaw 用）；内置 agent 按 deviceId + agent 自己算 */
  sessionId: string;
  agent: string;
  imagePath?: string | null;
  localTime?: string;
  /** 发起对话的设备；内置 agent 的设备工具（take_photo、speak）要用 */
  deviceId?: string;
  /**
   * 这轮的回复会不会被直接播报到 deviceId 上（/chat、/chat-vision、摇一摇等）。
   * 是的话 speak 工具对同一台设备就不该再播一遍。
   */
  spoken?: boolean;
  /** 出参：工具对 HTTP 响应的影响（take_photo → X-Need-Photo，set_volume → X-Volume） */
  meta?: { needPhoto?: boolean; volume?: string };
  /** 边生成边播：逐字输出与工具事件（只有内置 agent 会调） */
  onEvent?: (e: import("../agent/runtime.ts").AgentStreamEvent) => void;
}
export interface Brain {
  /** pi / openclaw / fake —— 路由据此选提示词（OpenClaw 用 cores3-speak skill，内置 agent 不用） */
  readonly kind: string;
  chat(req: ChatRequest): Promise<string>;
}
