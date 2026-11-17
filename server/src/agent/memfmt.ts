// 记忆文件里的几种约定格式（出处注释、「常用」节、主题页）：memory.ts、soul.ts、tidy.ts 都要认，单独放一个不依赖别人的模块，免得互相 import 成环。

/**
 * 出处（2026-11，借鉴 Anthropic「The components of agent memory」：记错的条目以后会一直被信，离线整理要拿原文核对）：
 * MEMORY.md / 主题页的条目末尾带一个 HTML 注释 `<!-- 出处 m120-m135；主人说的 -->`——前半是 read_ref 认的编号（对话原文在库里），
 * 后半是怎么知道的（主人说的 / 查过 / 推测）。Markdown 预览里看不见；检索、自动回忆、使用统计都先去掉它再用；整理时原样保留、按它去读原文核对。
 * USER.md（每轮常驻）和每日笔记（本身就带日期）不加。
 */
export const PROV_RE = /\s*<!--\s*出处\s*([^；;>]*?)\s*(?:[；;]\s*([^>]*?))?\s*-->/g;
export const stripProv = (t: string) => t.replace(PROV_RE, "").trim();
/** 一条的出处：编号（可能有好几个，合并过的条目）和「怎么知道的」 */
export function provOf(t: string): { refs: string[]; how: string } {
  const refs: string[] = [];
  let how = "";
  for (const m of t.matchAll(PROV_RE)) {
    for (const r of m[1].split(/[、,，\s]+/)) if (/^(m\d+(-m?\d+)?|session:\S+|daily:\d{4}-\d{2}-\d{2})$/.test(r) && !refs.includes(r)) refs.push(r);
    if (m[2] && !how) how = m[2].trim();
  }
  return { refs, how };
}
/**
 * 附在消息里给她看的样子：注释换成简短的「（#m120）」（和压缩摘要的出处同一个写法，read_ref 认）；
 * 只是推测、主人没确认过的标出来——她据此决定要不要先问一句，别当成定论说
 */
export function provShort(t: string): string {
  const { refs, how } = provOf(t);
  const body = stripProv(t).replace(/\s*\n\s*/g, " ");
  // 从每日笔记里提炼的写「出自 2026-11-10 的笔记」（写全，read_ref 要用）：她要细节就 read_ref 读 daily:<日期>
  const ids = [...refs.filter((r) => r.startsWith("m")).map((r) => `#${r}`), ...refs.filter((r) => r.startsWith("daily:")).map((r) => `出自 ${r.slice(6)} 的笔记`)].join("、");
  const guess = /推测|猜/.test(how);
  return guess || ids ? `${body}（${[guess ? "推测，主人没确认过" : "", ids].filter(Boolean).join("；")}）` : body;
}
/** 别称「〔又：…〕」：整理补的，给检索用 */
export const stripAlias = (t: string) => t.replace(/\s*〔又[：:][^〕]*〕/g, "");

export const provTag = (ref: string, how = "") => (ref || how ? ` <!-- 出处 ${ref}${how ? `；${how.replace(/-->|[\n<>]/g, "").slice(0, 40)}` : ""} -->` : "");

/**
 * 常用（2026-11，同一篇文章：常被用到的提到每次都带着的那层，细节留在下层）：MEMORY.md 里 `## 常用` 这一节每轮放进系统提示，
 * 不再靠检索。由记忆整理按使用统计（附上了、也用上了的多）挪进来，上限 PINNED_MAX 字；关于主人本人的进 USER.md，不进这里。
 */
export const PINNED_HEAD = "## 常用";
export const PINNED_MAX = 600;
export function pinnedOf(memText: string): string {
  const lines = memText.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === PINNED_HEAD);
  if (at < 0) return "";
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) { if (/^#{1,6}\s/.test(l)) break; if (l.trim()) out.push(stripProv(l)); }
  return out.join("\n").trim();
}

/** 「常用」节里的条目原样（带出处），使用统计按它对 */
export function pinnedLines(memText: string): string[] {
  const lines = memText.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === PINNED_HEAD);
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) { if (/^#{1,6}\s/.test(l)) break; if (/^\s*[-*•]\s+/.test(l)) out.push(l.trim()); }
  return out;
}

/** 主题页（2026-11）：MEMORY.md 太长时，同一件事的许多条由整理挪到 topics/<主题>.md，MEMORY.md 里留一行索引。自动回忆也检索它们 */
export const TOPICS_DIR = "topics";
export const topicName = (s: string) => s.trim().replace(/\.md$/i, "").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 24);
export interface Prov { ref?: string; how?: string }
