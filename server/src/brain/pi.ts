// 内置 agent 系统的大脑适配：设备路由的 ChatRequest → Runtime.run。
// 会话 key 由 agent + 设备算（默认并入该 agent 的 main 会话），旧的 sessionId 不再使用。
import fs from "node:fs";
import type { Brain, ChatRequest } from "./types.ts";
import type { Runtime } from "../agent/runtime.ts";

export class PiBrain implements Brain {
  readonly kind = "pi";
  constructor(private rt: Runtime) {}
  /** 这一轮她用 send_file 发了文件（只有手机 / 平板的对话里有这个工具）：交给外面送到页面上 */
  onFiles: ((deviceId: string, agentId: string, files: { rel: string; name: string; size: number; image: boolean }[]) => void) | null = null;

  async chat(req: ChatRequest): Promise<string> {
    const dev = req.deviceId || "default";
    const agentId = this.rt.agents.get(req.agent) ? req.agent : this.rt.agents.default().id;
    const key = this.rt.sessionKey(agentId, "device", dev);
    const images = req.imagePath && fs.existsSync(req.imagePath)
      ? [{ type: "image" as const, data: fs.readFileSync(req.imagePath).toString("base64"), mimeType: "image/jpeg" }]
      : undefined;
    const r = await this.rt.run({
      agentId, sessionKey: key, kind: key.endsWith(":main") ? "main" : "chat", channel: "device",
      deviceId: dev, spokenTo: req.spoken ? dev : undefined, text: req.message, images, localTime: req.localTime,
      onEvent: req.onEvent, meta: req.meta, signal: req.signal, ...(req.trusted === false ? { trusted: false } : {}),
    });
    if (r.meta.files?.length) {
      try { this.onFiles?.(dev, agentId, r.meta.files.map(({ rel, name, size, image }) => ({ rel, name, size, image }))); }
      catch (e: any) { console.log(`[${dev}] ⚠️  文件没送到页面: ${e.message}`); }
    }
    if (req.meta) {
      if (r.meta.needPhoto) req.meta.needPhoto = true;
      if (r.meta.volume) req.meta.volume = r.meta.volume;
    }
    // take_photo 让本轮立即结束；模型一句都没说的话补一句，设备总得先出个声
    if (r.meta.needPhoto && !r.text) return "好的，我看看。";
    return r.text;
  }
}
