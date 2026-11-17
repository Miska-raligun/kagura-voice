// 记忆整理的「按编号改」（2026-11，主人「记忆文件 2.9 万字，点整理记忆会失败吗」）：
// 以前让模型把整份 MEMORY.md 重写一遍再输出——3 万字的记忆输出也要 3 万 token，超过输出上限就被截断、超过时限就被掐掉，越需要整理的越整理不成。
// 现在每条记忆带编号交给模型，它只输出「第几条做什么」（删、改、并、补别称、挪进常用 / 主题页 / USER.md、标推测），没提到的条目原样保留。
// 输出只和改动多少有关，跟文件多大无关；没被提到的条目一个字都不会丢——比整份重写安全得多。
// 这个文件只管「编号 → 操作 → 新文件内容」，纯函数，不碰磁盘、不调模型（tidy.ts 负责那些）。
import { stripProv, stripAlias, provOf, provTag, PINNED_HEAD, topicName } from "./memfmt.ts";

export const LIST_RE = /^\s*[-*•]\s+/;

/** 一条记忆：在哪个文件（MEMORY.md 或 topics/<名>.md）第几行，全局编号 n */
export interface MemItem { n: number; file: string; line: number; text: string }
/** 一个文件按行拆开，条目行记着编号 */
export interface MemFile { file: string; lines: string[]; items: MemItem[] }

export function parseFiles(files: { file: string; text: string }[]): { files: MemFile[]; items: MemItem[] } {
  const out: MemFile[] = [];
  const all: MemItem[] = [];
  for (const f of files) {
    const lines = f.text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
    const items: MemItem[] = [];
    lines.forEach((l, i) => {
      if (!LIST_RE.test(l)) return;
      const it = { n: all.length + 1, file: f.file, line: i, text: l.replace(LIST_RE, "").trim() };
      items.push(it); all.push(it);
    });
    out.push({ file: f.file, lines, items });
  }
  return { files: out, items: all };
}

/** 交给模型看的样子：条目行前面标上 [编号]，标题照留（看得出分组），出处注释去掉（编号够用了，省字） */
export function numbered(f: MemFile, only?: Set<number>): string {
  const byLine = new Map(f.items.map((it) => [it.line, it]));
  const out: string[] = [];
  for (const [i, l] of f.lines.entries()) {
    const it = byLine.get(i);
    if (it) { if (!only || only.has(it.n)) out.push(`[${it.n}] ${stripProv(it.text)}${/推测/.test(provOf(it.text).how) ? "（已标推测）" : ""}`); }
    else if (/^#{1,6}\s/.test(l) || (!only && l.trim())) out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export type Op =
  | { op: "delete"; n: number; why?: string }
  | { op: "merge"; n: number; into: number; text?: string; why?: string }
  | { op: "edit"; n: number; text: string; why?: string }
  | { op: "correct"; n: number; text: string; why?: string }
  | { op: "guess"; n: number }
  | { op: "alias"; n: number; words: string }
  | { op: "to_user"; n: number; text?: string }
  | { op: "pin"; n: number } | { op: "unpin"; n: number }
  | { op: "topic"; n: number; name: string };

const OPS = new Set(["delete", "merge", "edit", "correct", "guess", "alias", "to_user", "pin", "unpin", "topic"]);
/** 认得的操作留下，认不得的、编号对不上的丢掉（别因为模型写错一条整趟作废） */
export function cleanOps(raw: unknown, valid: Set<number>): Op[] {
  if (!Array.isArray(raw)) return [];
  const out: Op[] = [];
  for (const o of raw as any[]) {
    if (!o || !OPS.has(o.op)) continue;
    const n = Number(o.n);
    if (!valid.has(n)) continue;
    const s = (k: string) => String(o[k] ?? "").trim();
    if (o.op === "merge") { const into = Number(o.into); if (valid.has(into) && into !== n) out.push({ op: "merge", n, into, text: s("text") || undefined, why: s("why") }); }
    else if (o.op === "edit" || o.op === "correct") { if (s("text")) out.push({ op: o.op, n, text: s("text"), why: s("why") }); }
    else if (o.op === "alias") { if (s("words")) out.push({ op: "alias", n, words: s("words") }); }
    else if (o.op === "topic") { const name = topicName(s("name")); if (name) out.push({ op: "topic", n, name }); }
    else if (o.op === "to_user") out.push({ op: "to_user", n, text: s("text") || undefined });
    else if (o.op === "delete") out.push({ op: "delete", n, why: s("why") });
    else out.push({ op: o.op, n } as Op);
  }
  return out;
}

const aliasOf = (t: string) => (t.match(/〔又[：:]([^〕]*)〕/)?.[1] ?? "").split(/[、,，\s]+/).filter(Boolean);
const clean = (t: string) => stripAlias(stripProv(t)).replace(LIST_RE, "").trim();

export interface Applied {
  files: Map<string, string>;           // 文件 → 新内容（只含改过的）
  toUser: string[];
  removed: { text: string; why: string }[];
  corrected: { text: string; why: string }[];
  topics: string[];                     // 新建 / 改过的主题页
  changed: number;                      // 动了几条
}

/** 把操作落到文件上。topicIndex：新主题页在 MEMORY.md 里那行索引的概括 */
export function applyOps(parsed: { files: MemFile[]; items: MemItem[] }, ops: Op[], topicIndex: Record<string, string> = {}): Applied {
  type St = { it: MemItem; body: string; aliases: string[]; refs: string[]; how: string; gone: boolean; move: "" | "pin" | "unpin" | `topic:${string}`; dirty: boolean };
  const st = new Map<number, St>();
  for (const it of parsed.items) {
    const p = provOf(it.text);
    st.set(it.n, { it, body: clean(it.text), aliases: aliasOf(stripProv(it.text)), refs: p.refs, how: p.how, gone: false, move: "", dirty: false });
  }
  const res: Applied = { files: new Map(), toUser: [], removed: [], corrected: [], topics: [], changed: 0 };
  for (const o of ops) {
    const s = st.get(o.n)!;
    if (s.gone) continue;
    s.dirty = true;
    switch (o.op) {
      case "delete": s.gone = true; res.removed.push({ text: s.body, why: o.why || "" }); break;
      case "merge": {
        const t = st.get(o.into)!;
        if (t.gone) { s.dirty = false; break; }
        s.gone = true; t.dirty = true;
        for (const r of s.refs) if (!t.refs.includes(r)) t.refs.push(r);
        for (const a of s.aliases) if (!t.aliases.includes(a)) t.aliases.push(a);
        if (o.text) { t.body = clean(o.text); for (const a of aliasOf(o.text)) if (!t.aliases.includes(a)) t.aliases.push(a); }
        res.removed.push({ text: s.body, why: o.why || `重复，并进第 ${o.into} 条` });
        break;
      }
      case "edit": case "correct": {
        const before = s.body;
        s.body = clean(o.text);
        for (const a of aliasOf(o.text)) if (!s.aliases.includes(a)) s.aliases.push(a);
        if (o.op === "correct" && s.body !== before) res.corrected.push({ text: s.body, why: o.why || "" });
        break;
      }
      case "guess": if (!/推测/.test(s.how)) s.how = s.how ? `${s.how}，推测` : "推测"; break;
      case "alias": for (const w of o.words.split(/[、,，\s]+/).filter(Boolean)) if (!s.aliases.includes(w) && !s.body.includes(w)) s.aliases.push(w); break;
      case "to_user": s.gone = true; res.toUser.push(clean(o.text || s.body)); break;
      case "pin": s.move = "pin"; break;
      case "unpin": s.move = "unpin"; break;
      case "topic": s.move = `topic:${o.name}`; break;
    }
  }
  const lineOf = (s: St) => `- ${s.body}${s.aliases.length ? `〔又：${s.aliases.slice(0, 6).join("、")}〕` : ""}${provTag(s.refs.join("、"), s.how)}`;
  // 每个文件：条目原地换成新的一行 / 删掉 / 挪走
  const pinned: string[] = [], unpinned: string[] = [];
  const toTopic = new Map<string, string[]>();
  const newLines = new Map<string, (string | null)[]>();
  for (const f of parsed.files) {
    const lines: (string | null)[] = [...f.lines];
    for (const it of f.items) {
      const s = st.get(it.n)!;
      if (!s.dirty) continue;
      res.changed++;
      if (s.gone) { lines[it.line] = null; continue; }
      const ln = lineOf(s);
      const inPinned = f.file === "MEMORY.md" && pinnedLineSet(f.lines).has(it.line);
      if (s.move === "pin" && !inPinned) { pinned.push(ln); lines[it.line] = null; }
      else if (s.move === "unpin" && inPinned) { unpinned.push(ln); lines[it.line] = null; }
      else if (s.move.startsWith("topic:")) {
        const name = s.move.slice(6);
        if (f.file === `topics/${name}.md`) lines[it.line] = ln;
        else { toTopic.set(name, [...(toTopic.get(name) ?? []), ln]); lines[it.line] = null; }
      } else lines[it.line] = ln;
    }
    newLines.set(f.file, lines);
  }
  // MEMORY.md：挪进常用的放到「## 常用」下（没有就在标题后面建一个），挪出来的接到最后，新主题页加一行索引
  const mem = newLines.get("MEMORY.md") ?? ["# 长期记忆"];
  if (!newLines.has("MEMORY.md")) newLines.set("MEMORY.md", mem);
  // 挪出常用的、新主题页的索引：重排之后接在「常用」节外面（直接接到文件末尾的话，常用是最后一节时又会落回常用）
  const extra: string[] = [...unpinned];
  const existingTopics = new Set(parsed.files.filter((f) => f.file.startsWith("topics/")).map((f) => f.file.slice(7, -3)));
  for (const [name, lines] of toTopic) {
    const file = `topics/${name}.md`;
    const cur = newLines.get(file) ?? [`# ${name}`, ""];
    cur.push(...lines);
    newLines.set(file, cur);
    if (!existingTopics.has(name) && !mem.some((l) => l !== null && l.includes(`topics/${name}.md`))) {
      extra.push(`- ${name}：${(topicIndex[name] || `${lines.length} 条`).trim()} → topics/${name}.md`);
    }
  }
  // 最后重排 MEMORY.md：标题 →「## 常用」（原来常用里还留着的 + 新挪进来的）→ 其余。
  // 「常用」到下一个标题为止，后面紧跟的不是标题就补一个「## 其它」——不然后面的条目全被算进常用、每轮常驻
  if (pinned.length || mem.some((l) => l !== null && l.trim() === PINNED_HEAD)) {
    const live = mem.filter((l): l is string => l !== null);
    const at = live.findIndex((l) => l.trim() === PINNED_HEAD);
    let head: string[], keep: string[] = [], rest: string[];
    if (at >= 0) {
      let end = at + 1;
      while (end < live.length && !/^#{1,6}\s/.test(live[end])) end++;
      head = live.slice(0, at);
      keep = live.slice(at + 1, end).filter((l) => l.trim());
      rest = live.slice(end);
      // 原来常用那节后面没有标题、直接接着别的条目（老文件、或者她自己手写的）：分不清哪些算常用，原样留在常用里
    } else {
      const title = live.findIndex((l) => /^#\s/.test(l));
      head = live.slice(0, title + 1);
      rest = live.slice(title + 1);
    }
    const restBody = [...rest, ...extra].filter((l) => l.trim());
    const after = [...rest, ...extra];
    while (after.length && !after[0].trim()) after.shift();
    const tail = restBody.length && !/^#{1,6}\s/.test(restBody[0]) ? ["## 其它", "", ...after] : after;
    mem.splice(0, mem.length, ...head, "", PINNED_HEAD, "", ...keep, ...pinned, "", ...tail);
  } else mem.push(...extra);
  for (const [file, lines] of newLines) {
    const orig = parsed.files.find((f) => f.file === file);
    const text = lines.filter((l): l is string => l !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    if (!orig || text !== orig.lines.join("\n").trim() + "\n") {
      res.files.set(file, text);
      if (file.startsWith("topics/")) res.topics.push(file.slice(7, -3));
    }
  }
  return res;
}

/** MEMORY.md 里属于「## 常用」那节的行号 */
function pinnedLineSet(lines: string[]): Set<number> {
  const at = lines.findIndex((l) => l.trim() === PINNED_HEAD);
  const out = new Set<number>();
  if (at < 0) return out;
  for (let i = at + 1; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i++) out.add(i);
  return out;
}

/**
 * 分段：条目总字数超过 maxChars 就按文件 / 标题切成几段，一段一次模型调用。
 * 同一节尽量不拆开（重复的多半挨着）；一节本身就超长的再按条切
 */
export function batches(parsed: { files: MemFile[] }, maxChars: number): Set<number>[] {
  const groups: MemItem[][] = [];
  for (const f of parsed.files) {
    let cur: MemItem[] = [];
    const byLine = new Map(f.items.map((it) => [it.line, it]));
    f.lines.forEach((l, i) => {
      if (/^#{1,6}\s/.test(l) && cur.length) { groups.push(cur); cur = []; }
      const it = byLine.get(i);
      if (it) cur.push(it);
    });
    if (cur.length) groups.push(cur);
  }
  const size = (a: MemItem[]) => a.reduce((n, it) => n + Array.from(stripProv(it.text)).length + 8, 0);
  const out: Set<number>[] = [];
  let cur: MemItem[] = [];
  const push = () => { if (cur.length) out.push(new Set(cur.map((x) => x.n))); cur = []; };
  for (const g of groups) {
    if (size(g) > maxChars) {
      push();
      for (const it of g) { if (cur.length && size([...cur, it]) > maxChars) push(); cur.push(it); }
      push();
      continue;
    }
    if (cur.length && size([...cur, ...g]) > maxChars) push();
    cur.push(...g);
  }
  push();
  return out;
}
