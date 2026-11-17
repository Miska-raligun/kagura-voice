// 朗读版（<voice>…</voice>）：提示词、流式里扣下这一段、落盘 / 实时页里拆掉。从 runtime.ts 拆出来的。

/**
 * 朗读版（LRN 2026-10-31，症状「飞书 / 网页的长回复要等全写完、再找便宜模型压成口语，20 秒压不完就截断着念」）：
 * 会被顺带念的回复，让她在最终回复最前面先写 <voice>口语版</voice>。流式里一写完就交出去播（不等后面的正文、不再调模型），
 * 正文、落盘、实时页里都拆掉这段。
 */
export const VOICE_RE = /<voice>([\s\S]*?)<\/voice>\s*/g;
export function stripVoice(t: string): string {
  return t.replace(VOICE_RE, "").replace(/^\s*<voice>\s*/, "");
}
export function voicePrompt(max: number): string {
  return `<voice_first>\n这条回复写完会在家里的设备上念给主人听。回复会超过约 ${max} 字时，在最终回复的最开头先写一段 <voice>念给主人听的口语版</voice>，再接着写正文：`
    + `口语版不超过 ${max} 字，保留结论和关键数字，不要 markdown、列表、表情、网址、代码；内容放不下就在最后说一句「详细的我发在消息里了」。`
    + "短回复不用写，系统会直接念正文；先说一句再去调工具的那种过渡句也不用写。<voice> 这段主人在文字里看不到。\n</voice_first>";
}
/**
 * 流式过滤：一条助手消息开头是 <voice> 就把这段扣下来（不给实时页 / 调用方看），一闭合就回调；其余照常放行。
 * 开头还看不出是不是 <voice> 时先攒着；到消息结尾还没闭合就当普通正文放出去。
 */
export class VoiceTap {
  private buf = "";
  private mode: "undecided" | "pass" | "inside" = "undecided";
  fired = "";
  constructor(private onVoice: (t: string) => void) {}
  /** 喂一段增量，返回应该放行给下游的文字 */
  feed(d: string): string {
    if (this.mode === "pass") return d;
    this.buf += d;
    if (this.mode === "undecided") {
      const t = this.buf.replace(/^\s+/, "");
      if (t.startsWith("<voice>")) this.mode = "inside";
      else if ("<voice>".startsWith(t)) return "";
      else { this.mode = "pass"; const out = this.buf; this.buf = ""; return out; }
    }
    if (this.mode === "inside") {
      const end = this.buf.indexOf("</voice>");
      if (end < 0) return "";
      const voice = this.buf.slice(this.buf.indexOf("<voice>") + 7, end).trim();
      const rest = this.buf.slice(end + 8).replace(/^\s+/, "");
      this.buf = "";
      this.mode = "pass";
      if (voice && !this.fired) { this.fired = voice; try { this.onVoice(voice); } catch { /* 回调出错不影响这一轮 */ } }
      return rest;
    }
    return d;
  }
  /** 一条消息结束：没闭合的 / 还没判断出来的原样放出去，下一条消息重新判断 */
  end(): string {
    const out = this.mode === "pass" ? "" : this.buf.replace(/^\s*<voice>\s*/, "");
    this.buf = "";
    this.mode = "undecided";
    return out;
  }
}

/** 落盘 / 给实时页的助手消息去掉 <voice> 段（只剩朗读版的就留朗读版当正文） */
export function unvoice(m: any, fired?: string): any {
  if (m?.role !== "assistant" || !Array.isArray(m.content) || !m.content.some((c: any) => c.type === "text" && String(c.text).includes("<voice>"))) return m;
  const content = m.content.map((c: any) => (c.type === "text" ? { ...c, text: stripVoice(String(c.text)) } : c));
  const empty = !content.some((c: any) => (c.type === "text" && c.text.trim()) || c.type === "toolCall");
  return { ...m, content: empty && fired ? [{ type: "text", text: fired }] : content };
}
