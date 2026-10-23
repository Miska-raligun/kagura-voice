// 文本工具：对应 oc_utils.py 与 voice_server 里的几个小函数。

/** 去除常见 Markdown 标记，避免 TTS 读出符号。逐条对应 oc_utils.strip_markdown。 */
export function stripMarkdown(text: string): string {
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, "");
  t = t.replace(/`[^`]+`/g, "");
  t = t.replace(/#{1,6}\s+/g, "");
  t = t.replace(/\*\*(.+?)\*\*/g, "$1");
  t = t.replace(/\*(.+?)\*/g, "$1");
  t = t.replace(/~~(.+?)~~/g, "$1");
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  t = t.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^\s*\d+\.\s+/gm, "");
  t = t.replace(/^[\s=\-_*~─═—×#]{3,}$/gm, "");
  t = t.replace(/[=─═]{2,}/g, " ");
  t = t.replace(/\n{2,}/g, "\n");
  return t.trim();
}

/** 从混有 ANSI 日志的 stdout 中提取第一个完整的顶层 JSON 对象（对应 _extract_json）。 */
export function extractJson(raw: string): Record<string, any> {
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, "");
  let idx = clean.indexOf("{");
  while (idx !== -1) {
    const end = scanJson(clean, idx);
    if (end > 0) {
      try {
        const obj = JSON.parse(clean.slice(idx, end));
        if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
      } catch { /* 继续找下一个 { */ }
    }
    idx = clean.indexOf("{", idx + 1);
  }
  throw new Error(`未找到完整 JSON 对象: ${raw.slice(0, 200)}`);
}

/** 从 start（必须是 {）开始找到配对的 }，正确跳过字符串里的括号。返回结束下标（不含）或 -1。 */
function scanJson(s: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** 把 UTF-8 文本裁剪后 b64 编码，塞进 HTTP 响应头供设备屏显（按字符裁剪，同 Python text[:60]）。 */
export function b64Header(text: string, maxChars = 60): string {
  return Buffer.from(Array.from(text).slice(0, maxChars).join(""), "utf8").toString("base64");
}

/** Python 的 text[:n]（按 Unicode 码点，不切坏汉字） */
export const pyHead = (text: string, n: number) => Array.from(text).slice(0, n).join("");
/** Python 的 len(text)（码点数） */
export const pyLen = (text: string) => Array.from(text).length;

/** Python str.strip(chars) */
export function stripChars(s: string, chars: string): string {
  const set = new Set(Array.from(chars));
  const a = Array.from(s);
  let i = 0, j = a.length;
  while (i < j && set.has(a[i])) i++;
  while (j > i && set.has(a[j - 1])) j--;
  return a.slice(i, j).join("");
}

export const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(Math.ceil(bytes / 2)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, bytes);

/**
 * IM 回复转成适合用语音念的一段：去掉 markdown、代码块、表格、链接；太长就在句末截断，
 * 补一句「详细的发在消息里了」（念一大段表格/列表没人听得下去）。
 */
export function toSpoken(text: string, maxChars = 200, tail = "详细的我发在消息里了。"): string {
  let t = text.replace(/```[\s\S]*?```/g, "").replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "");
  t = stripMarkdown(t).replace(/([，。！？、；：,.!?;:])\s*\n+/g, "$1").replace(/\n+/g, "。").replace(/([。！？!?])。+/g, "$1").replace(/^。+|。+$/g, "").trim();
  const chars = Array.from(t);
  if (chars.length <= maxChars) return t;
  const head = chars.slice(0, maxChars).join("");
  const cut = Math.max(...["。", "！", "？", "!", "?", "；"].map((p) => head.lastIndexOf(p)));
  return (cut > maxChars * 0.4 ? head.slice(0, cut + 1) : head + "…") + tail;
}
