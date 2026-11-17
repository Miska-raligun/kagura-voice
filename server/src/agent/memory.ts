// 记忆（§6.4）：MEMORY.md（精炼长期记忆）+ memory/YYYY-MM-DD.md（每日笔记），纯 markdown。
//
// 检索 = 关键词（SQLite FTS5，CJK 逐字切开）+ 向量（可选，用户配的嵌入接口，余弦在 JS 里算）。
// 两路各自排名后按名次合并（RRF）；没配嵌入就只用关键词。
// 索引按文件 mtime/size 增量更新：每次检索前同步一次，管理 UI 手改文件也能马上搜到。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentInfo } from "./registry.ts";
import { dailyNotePath } from "./soul.ts";
import { strftime } from "../util/time.ts";
import { isShared, personaText, sharedPath } from "./persona.ts";

export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** OpenAI 兼容的 /embeddings 接口（通义、智谱、硅基流动、Ollama 等都兼容） */
export class OpenAIEmbedder implements Embedder {
  constructor(private cfg: { baseUrl: string; apiKey: string; model: string }) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      const r = await fetch(this.cfg.baseUrl.replace(/\/$/, "") + "/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.cfg.model, input: batch }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`嵌入接口 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j: any = await r.json();
      const data = [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== batch.length) throw new Error("嵌入接口返回条数不对");
      for (const d of data) out.push(Float32Array.from(d.embedding));
    }
    return out;
  }
}

const CJK = /[㐀-鿿豈-﫿]/;
/** FTS 存储用：中日韩字符逐字切开（trigram 搜不到两字词，M0 实测） */
export const segment = (s: string) => s.replace(/([㐀-鿿豈-﫿])/g, " $1 ").replace(/\s+/g, " ").trim();

/** 查询：中文切成相邻两字的短语、英文/数字按词，OR 起来交给 bm25 排序（自然语言提问也能命中） */
export function ftsQuery(q: string): string {
  const terms = new Set<string>();
  for (const run of q.match(/[㐀-鿿豈-﫿]+/g) ?? []) {
    const chars = Array.from(run);
    if (chars.length === 1) terms.add(chars[0]);
    for (let i = 0; i + 1 < chars.length; i++) terms.add(`${chars[i]} ${chars[i + 1]}`);
  }
  for (const w of q.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []) terms.add(w);
  return [...terms].slice(0, 32).map((t) => `"${t}"`).join(" OR ");
}

/** 按段落切块（空行或标题分隔），过长的段再按字数切。记行号，memory_get 能精确取回 */
const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,3}[.、)])\s+/;
/** 切块算法版本：改了要加一，已建的索引会自动重建 */
const CHUNKER_VERSION = "2";

/**
 * 自动回忆里不算数的两字词：几乎每条记忆、每句话里都有，命中它们说明不了相关（「主人今天…」随便一句都能凑够两个）。
 * 另外按出现频率再筛一道（见 recall），这里只放最常见的
 */
const STOP_TERMS = new Set(("主人 我们 你们 他们 她们 今天 明天 昨天 现在 时候 一下 一个 一些 这个 那个 这样 那样 什么 怎么 为什么 "
  + "可以 就是 还是 没有 不是 知道 觉得 有点 一点 如果 因为 所以 但是 然后 已经 还有 自己 大家 东西 事情 的话 帮我 给我 告诉 "
  + "一起 看看 好的 好吧 嗯嗯 哈哈 谢谢 记得 记住 说过 一直 喜欢 想要 需要 应该 不要 不会 可能 来着 一下子 是不是 有没有 什么样").split(" "));

/** 单个出现时不带信息的字：按词切完剩下的单字里，遇到它们就断开（不然「吃药了吗」会拼出「药了」「了吗」） */
const FUNC_CHARS = new Set(Array.from("的了吗呢吧啊呀哦嗯哈你我他她它是在有和就都也还要去来着哪这那很不没被把给跟对到个几"));
let segmenter: Intl.Segmenter | null | undefined;
const wordSegmenter = () => {
  if (segmenter === undefined) { try { segmenter = new Intl.Segmenter("zh", { granularity: "word" }); } catch { segmenter = null; } }
  return segmenter;
};

/**
 * 自动回忆用的「有信息量的词」（2026-11）：以前是相邻两字滑着切，「主人今天」会切出「人今」这种跨词的假词，正好撞上别的记忆。
 * 现在按词切（Node 自带的 Intl.Segmenter）；词典里没有的名字（「团子」「神乐」）会被切成单字——连着的单字拼回去再取相邻两字；
 * 词后面跟着的单字连上也算一个词（「打印」+「机」）。常用词（STOP_TERMS）不算。运行环境没有分词器就退回两字滑切。
 */
export function recallTerms(q: string): string[] {
  const out = new Set<string>();
  const text = q.toLowerCase();
  const seg = wordSegmenter();
  if (!seg) {
    for (const t of ftsQuery(text).split(" OR ").map((t) => t.replace(/"/g, "").replace(/ /g, ""))) if (t) out.add(t);
  } else {
    let run: string[] = [], prevWord = "";
    // 连着的单字：相邻两字都取（「爱喝无糖」→ 爱喝、喝无、无糖），三个字的整个也取（多半是个名字）。
    // 拼出来的假词（「喝无」）在记忆里搜不到，会被出现频率那道筛掉，不碍事
    const flushRun = () => {
      for (let i = 0; i + 1 < run.length; i++) out.add(run[i] + run[i + 1]);
      if (run.length === 3) out.add(run.join(""));
      run = [];
    };
    for (const s of seg.segment(text)) {
      const w = s.segment;
      const chars = Array.from(w);
      const cjk = CJK.test(w);
      if (!s.isWordLike) { flushRun(); prevWord = ""; continue; }
      if (cjk && chars.length === 1) {
        if (FUNC_CHARS.has(w)) { flushRun(); prevWord = ""; continue; }
        if (prevWord && !run.length) out.add(prevWord + w);
        run.push(w);
        continue;
      }
      flushRun();
      if (cjk ? chars.length >= 2 : /^[a-z0-9_]{2,}$/.test(w)) out.add(w);
      prevWord = cjk ? w : "";
    }
    flushRun();
  }
  return [...out].filter((t) => !STOP_TERMS.has(t)).slice(0, 32);
}

/** 两路排名合并（RRF）的常数：越大越看重「两路都靠前」而不是某一路的第一名 */
const RRF_K = 20;
/** 一条记忆被自动附上这么多次、却一次都没帮上忙（回复里没用到），之后要更强的匹配才附 */
export const STALE_RECALLS = 6;

export function chunkMarkdown(text: string, max = 400): { start: number; end: number; text: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { start: number; end: number; text: string }[] = [];
  let buf: string[] = [], start = 1;
  const flush = (endLine: number) => {
    const t = buf.join("\n").trim();
    if (t) {
      const chars = Array.from(t);
      for (let i = 0; i < chars.length; i += max) out.push({ start, end: endLine, text: chars.slice(i, i + max).join("") });
    }
    buf = [];
  };
  // 清单的每一项单独成块（LRN 2026-10-30）：以前连着写的「- …」整串算一块，一条沾边整串都被自动回忆附上，看起来像随手抓了一把
  lines.forEach((ln, i) => {
    const n = i + 1;
    if (/^#{1,6}\s/.test(ln) || !ln.trim() || LIST_ITEM.test(ln)) { flush(n - 1); start = n; }
    if (ln.trim()) { if (!buf.length) start = n; buf.push(ln); }
  });
  flush(lines.length);
  return out;
}

const cosine = (a: Float32Array, b: Float32Array) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** USER.md 里系统自动追加的那一节（标题之后都算） */
export const USER_AUTO_HEAD = "## 自动记录（她从对话里记下的，可以挪到上面、改、删）";
/**
 * 一条要记的事像不像「当天的流水」：开头是时刻 / 日期（「22:14 heartbeat…」「10-31 …」），或「今天 / 刚才 / 今晚…」起头。
 * 这种写进 MEMORY.md 会被当成长期事实、每轮自动回忆出来，过几天就成了误导
 */
export function looksLikeLog(t: string): boolean {
  const s = t.trim().replace(/^\[/, "");
  if (/^(\d{4}[-/年])?(0?[1-9]|1[0-2])[-/月](0?[1-9]|[12]\d|3[01])(日|\s|$)/.test(s)) return true;       // 10-31 / 2026-10-31 / 10月31日
  if (/^\d{1,2}[:：]\d{2}(?!\d)/.test(s)) return true;                                                // 22:14 …
  if (/^(heartbeat|定时任务|待办)\b|^(heartbeat|定时任务|待办)\]/i.test(s)) return true;
  // 「今天…」「刚才…」是当天的事；「今天起 / 从今天开始」说的是以后，不算
  return /^(今天|今日|今早|今晚|刚才|刚刚|方才)/.test(s) && !/^(今天|今日|今晚)(起|开始)/.test(s);
}

/** USER.md 自动记录里单条的上限：超过就不像「关于主人的一条稳定信息」了，改记 MEMORY.md */
export const USER_ITEM_MAX = 80;
export const USER_AUTO_MAX = 1500;

export interface MemoryHit { path: string; start: number; end: number; text: string; score: number; via: string; terms?: string[]; /** 向量相似度（原始余弦）和它比这次查询的平均水平高几个标准差 */ vec?: number; vecZ?: number }
/** 一条记忆在使用统计里的键：按内容算，改了字就是新的一条 */
const recallKey = (text: string) => createHash("sha1").update(text.trim()).digest("hex").slice(0, 16);

export class MemoryIndex {
  constructor(private agent: AgentInfo, private db: DatabaseSync, private embedder: Embedder | null) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mem_files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER);
      CREATE TABLE IF NOT EXISTS mem_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, start_line INTEGER, end_line INTEGER, text TEXT, embedding BLOB);
      CREATE INDEX IF NOT EXISTS mem_chunks_path ON mem_chunks(path);
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(body, chunk_id UNINDEXED, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS mem_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS mem_recall (key TEXT PRIMARY KEY, recalled INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, last REAL);
    `);
    // 切块算法变了：旧索引整个清掉，下次检索按新算法重建
    const v = (db.prepare("SELECT value FROM mem_meta WHERE key = 'chunker'").get() as any)?.value;
    if (v !== CHUNKER_VERSION) {
      db.exec("DELETE FROM mem_fts; DELETE FROM mem_chunks; DELETE FROM mem_files;");
      db.prepare("INSERT OR REPLACE INTO mem_meta(key, value) VALUES ('chunker', ?)").run(CHUNKER_VERSION);
    }
  }

  /** workspace 里参与检索的文件（相对路径） */
  files(): string[] {
    const ws = this.agent.workspace;
    const out = fs.existsSync(path.join(ws, "MEMORY.md")) ? ["MEMORY.md"] : [];
    const dir = path.join(ws, "memory");
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).sort()) if (f.endsWith(".md")) out.push(`memory/${f}`);
    }
    return out;
  }

  /** 增量同步：变了的文件重切块重建索引，删掉的文件清掉；没算过向量的块补算 */
  async sync(): Promise<{ changed: number }> {
    const ws = this.agent.workspace;
    const known = new Map((this.db.prepare("SELECT * FROM mem_files").all() as any[]).map((r) => [r.path, r]));
    const present = this.files();
    let changed = 0;
    for (const rel of present) {
      const st = fs.statSync(path.join(ws, rel));
      const k = known.get(rel);
      if (k && k.mtime === st.mtimeMs && k.size === st.size) continue;
      this.dropFile(rel);
      const ins = this.db.prepare("INSERT INTO mem_chunks(path, start_line, end_line, text) VALUES (?, ?, ?, ?)");
      const fts = this.db.prepare("INSERT INTO mem_fts(body, chunk_id) VALUES (?, ?)");
      for (const c of chunkMarkdown(fs.readFileSync(path.join(ws, rel), "utf8"))) {
        const r = ins.run(rel, c.start, c.end, c.text);
        fts.run(segment(c.text.toLowerCase()), Number(r.lastInsertRowid));
      }
      this.db.prepare("INSERT OR REPLACE INTO mem_files(path, mtime, size) VALUES (?, ?, ?)").run(rel, st.mtimeMs, st.size);
      changed++;
    }
    for (const rel of known.keys()) if (!present.includes(rel)) { this.dropFile(rel); changed++; }
    if (this.embedder) {
      const todo = this.db.prepare("SELECT id, text FROM mem_chunks WHERE embedding IS NULL LIMIT 256").all() as any[];
      if (todo.length) {
        try {
          const vecs = await this.embedder.embed(todo.map((t) => t.text));
          const up = this.db.prepare("UPDATE mem_chunks SET embedding = ? WHERE id = ?");
          todo.forEach((t, i) => up.run(Buffer.from(vecs[i].buffer), t.id));
        } catch (e: any) { console.log(`[memory] ⚠️  ${this.agent.id} 向量计算失败（先只用关键词）: ${e.message}`); }
      }
    }
    return { changed };
  }

  private dropFile(rel: string) {
    const ids = (this.db.prepare("SELECT id FROM mem_chunks WHERE path = ?").all(rel) as any[]).map((r) => r.id);
    const del = this.db.prepare("DELETE FROM mem_fts WHERE chunk_id = ?");
    for (const id of ids) del.run(id);
    this.db.prepare("DELETE FROM mem_chunks WHERE path = ?").run(rel);
    this.db.prepare("DELETE FROM mem_files WHERE path = ?").run(rel);
  }

  /** 全部重建（管理 UI 的「重建索引」） */
  async rebuild() {
    this.db.exec("DELETE FROM mem_fts; DELETE FROM mem_chunks; DELETE FROM mem_files;");
    return this.sync();
  }

  /**
   * paths = 只在这些文件里找（自动回忆只看 MEMORY.md）；不给 = 全部。
   * 两路各自排名，按名次合并（RRF，2026-11）：以前是分数加权（0.4 关键词 + 0.6 向量），可关键词分是相对第一名归一化的、向量分随嵌入模型高低不一，
   * 加在一起没有可比性。每条带 vec（原始余弦）和 vecZ（比这次查询在全部记忆上的平均相似度高几个标准差）——不同嵌入模型的余弦范围差很多，
   * 「够不够相关」看相对值比看绝对值稳
   */
  async search(query: string, k = 6, paths?: string[]): Promise<MemoryHit[]> {
    await this.sync();
    const scores = new Map<number, { kw: number; kwRank: number; vec: number; vecRank: number; vecZ: number }>();
    const blank = () => ({ kw: 0, kwRank: 0, vec: 0, vecRank: 0, vecZ: 0 });
    const q = ftsQuery(query);
    const inPaths = paths ? ` AND c.path IN (${paths.map(() => "?").join(",")})` : "";
    if (q) {
      const rows = this.db.prepare(`SELECT f.chunk_id, bm25(mem_fts) AS s FROM mem_fts f JOIN mem_chunks c ON c.id = f.chunk_id WHERE mem_fts MATCH ?${inPaths} ORDER BY s LIMIT 30`).all(q, ...(paths ?? [])) as any[];
      const best = rows.length ? -rows[0].s : 0;
      rows.forEach((r, i) => scores.set(r.chunk_id, { ...blank(), kw: best > 0 ? -r.s / best : 1, kwRank: i + 1 }));
    }
    let usedVec = false;
    if (this.embedder) {
      try {
        const [qv] = await this.embedder.embed([query]);
        const rows = this.db.prepare(`SELECT c.id, c.embedding FROM mem_chunks c WHERE c.embedding IS NOT NULL${inPaths}`).all(...(paths ?? [])) as any[];
        const all = rows.map((r) => ({ id: r.id, s: cosine(qv, new Float32Array(new Uint8Array(r.embedding).buffer)) })).sort((a, b) => b.s - a.s);
        const mean = all.reduce((n, x) => n + x.s, 0) / Math.max(1, all.length);
        const sd = Math.sqrt(all.reduce((n, x) => n + (x.s - mean) ** 2, 0) / Math.max(1, all.length));
        all.slice(0, 30).forEach(({ id, s }, i) => {
          if (s <= 0.2) return;
          const cur = scores.get(id) ?? blank();
          cur.vec = s; cur.vecRank = i + 1;
          // 记忆太少时标准差没意义，留 0，由调用方退回看绝对值
          cur.vecZ = all.length >= 8 && sd > 1e-6 ? (s - mean) / sd : 0;
          scores.set(id, cur);
        });
        usedVec = rows.length > 0;
      } catch (e: any) { console.log(`[memory] ⚠️  查询向量失败（只用关键词）: ${e.message}`); }
    }
    const get = this.db.prepare("SELECT * FROM mem_chunks WHERE id = ?");
    const rrf = (rank: number) => (rank ? 1 / (RRF_K + rank) : 0);
    const top = 1 / (RRF_K + 1);
    return [...scores.entries()]
      // 没用向量时照旧按关键词分；用了就按名次合并，归一到「两路都是第一名 = 1」
      .map(([id, s]) => ({ id, s, score: usedVec ? (rrf(s.kwRank) + rrf(s.vecRank)) / (2 * top) : s.kw, via: s.kwRank && s.vecRank ? "both" : s.kwRank ? "keyword" : "vector" }))
      .sort((a, b) => b.score - a.score).slice(0, k)
      .map(({ id, s, score, via }) => {
        const c = get.get(id) as any;
        return { path: c.path, start: c.start_line, end: c.end_line, text: c.text, score: Math.round(score * 1000) / 1000, via,
          ...(s.vecRank ? { vec: Math.round(s.vec * 1000) / 1000, vecZ: Math.round(s.vecZ * 100) / 100 } : {}) };
      });
  }

  /**
   * 自动回忆：拿主人这句话检索，挑真正相关的几条（附在这一轮消息上）。
   * 关键词这一路按「命中了几个有信息量的词」卡：至少中 2 个，或中 1 个很少见的（「团子在干嘛」里的「团子」）；
   * 向量这一路要明显高出这次查询的平均水平（vecZ，记忆太少时退回绝对值 0.5）。
   * context = 前一两句对话（2026-11）：「那个呢」「然后呢」这种追问本身没有内容词，以前必然什么都找不到；
   * 这句话自己有信息量的词不到 2 个时，把前文的词也算上。
   * 只看 MEMORY.md（LRN 2026-10-30）：每日笔记记的是「当时」的事（「今天有点累」「下午去超市」），检索出来混在消息里，
   * 模型分不清是哪天的，容易当成现在的情况；旧笔记要查让 agent 自己 memory_search（结果带文件名 = 日期）。
   */
  async recall(query: string, o: { k?: number; maxChars?: number; paths?: string[]; context?: string } = {}): Promise<MemoryHit[]> {
    const paths = o.paths ?? ["MEMORY.md"];
    const strip = (t: string) => t.replace(/^\[[^\]]*\]\s*/, "").trim();
    const q = strip(query);
    const own = recallTerms(q);
    // 这句话自己撑不起一次检索：借前文
    const ctx = own.length < 2 && o.context ? strip(o.context).slice(-300) : "";
    if (!ctx && Array.from(q.replace(/[\s\p{P}]/gu, "")).length < 4) return [];
    const full = ctx ? `${ctx} ${q}` : q;
    if (!ftsQuery(full)) return [];
    const hits0 = await this.search(full, 12, paths);
    // 有信息量的词：再去掉在记忆里到处都是的（出现在超过 15% 的块里）
    const inPaths = `path IN (${paths.map(() => "?").join(",")})`;
    const total = Math.max(1, (this.db.prepare(`SELECT COUNT(*) AS n FROM mem_chunks WHERE ${inPaths}`).get(...paths) as any).n);
    const dfStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM mem_chunks WHERE ${inPaths} AND instr(lower(text), ?) > 0`);
    const df = new Map<string, number>();
    const terms = [...new Set([...own, ...(ctx ? recallTerms(ctx) : [])])]
      .filter((t) => { const n = (dfStmt.get(...paths, t) as any).n; df.set(t, n); return n > 0 && n <= Math.max(3, total * 0.15); });
    const stat = this.db.prepare("SELECT recalled, used FROM mem_recall WHERE key = ?");
    const out: MemoryHit[] = [];
    let size = 0;
    for (const h of hits0) {
      const body = h.text.toLowerCase();
      // 「打印」「打印机」这种一个包着另一个的只算一个
      const hit = terms.filter((t) => body.includes(t)).filter((t, _i, a) => !a.some((u) => u !== t && u.includes(t)));
      const strongVec = h.vec !== undefined && (h.vecZ ? h.vecZ >= 2.5 && h.vec >= 0.3 : h.vec >= 0.5);
      // 中两个有信息量的词（三个字以上的词顶两个：以前两字滑切时「乌龙茶」本来就算两个）；或者中了一个很少见的词
      const weight = hit.reduce((n, t) => n + (Array.from(t).length >= 3 ? 2 : 1), 0);
      let ok = weight >= 2 || (hit.length === 1 && (df.get(hit[0]) ?? 99) <= 2);
      // 老被附上却从没帮上忙的（见 noteRecalled / noteUsed）：要更强的匹配才附，免得每轮白占地方
      const st = stat.get(recallKey(h.text)) as any;
      if (st && st.recalled >= STALE_RECALLS && !st.used) ok = weight >= 3 || (ok && strongVec);
      else if (strongVec) ok = true;
      if (!ok) continue;
      h.terms = hit;
      const n = Array.from(h.text).length;
      if (out.length && size + n > (o.maxChars ?? 1200)) break;
      out.push(h); size += n;
      if (out.length >= (o.k ?? 5)) break;
    }
    return out;
  }

  /** 这几条记忆被自动附上了一次 */
  noteRecalled(texts: string[]) {
    const up = this.db.prepare("INSERT INTO mem_recall(key, recalled, used, last) VALUES (?, 1, 0, ?) ON CONFLICT(key) DO UPDATE SET recalled = recalled + 1, last = excluded.last");
    for (const t of texts) up.run(recallKey(t), Date.now() / 1000);
  }

  /**
   * 回复出来以后看附上的记忆用上了没有：回复里出现了这条记忆里、主人这句话没提到的词就算用上了（「泡无糖乌龙茶」里的「无糖」）。
   * 判得粗，只拿来给「老被附上却从没用上」的降权，不拿来删东西。返回用上的条数
   */
  noteUsed(texts: string[], query: string, reply: string): number {
    const asked = new Set(recallTerms(query));
    const said = reply.toLowerCase();
    const up = this.db.prepare("UPDATE mem_recall SET used = used + 1 WHERE key = ?");
    let n = 0;
    for (const t of texts) {
      const own = recallTerms(t).filter((w) => !asked.has(w) && said.includes(w));
      if (own.length) { up.run(recallKey(t)); n++; }
    }
    return n;
  }

  /** 自动回忆的使用情况（评测页显示）：附上过几条、多少条用上过、哪些老附却没用 */
  recallStats() {
    const rows = this.db.prepare("SELECT key, recalled, used, last FROM mem_recall ORDER BY recalled DESC").all() as any[];
    const text = new Map((this.db.prepare("SELECT text FROM mem_chunks WHERE path = 'MEMORY.md'").all() as any[]).map((r) => [recallKey(r.text), r.text as string]));
    const live = rows.filter((r) => text.has(r.key));
    return {
      items: live.length, recalled: live.reduce((n, r) => n + r.recalled, 0), used: live.reduce((n, r) => n + r.used, 0),
      stale: live.filter((r) => r.recalled >= STALE_RECALLS && !r.used).map((r) => ({ text: text.get(r.key)!, recalled: r.recalled })),
      top: live.slice(0, 10).map((r) => ({ text: text.get(r.key)!, recalled: r.recalled, used: r.used })),
    };
  }

  /**
   * 追加一条记忆。target = daily（今天的笔记）| long（MEMORY.md）| user（USER.md 末尾的「自动记录」一节：关于主人本人的稳定信息，
   * 每轮常驻）。自动记录有上限 USER_AUTO_MAX，满了改记进 MEMORY.md 并提示去整理——不碰主人手写的部分。
   */
  write(target: string, text: string, now = new Date(), tag = ""): string {
    const ws = this.agent.workspace;
    // 多行压成一行（清单一项一块）用「；」接，别挤成一串；开头自带的「- 」去掉（不然写出来是「- - …」）
    const t = text.trim().split(/\n+/).map((l) => l.trim().replace(/^([-*•]\s+)+/, "")).filter(Boolean).join("；");
    if (!t) throw new Error("内容为空");
    // 长期记忆只放以后还成立的事：带时刻 / 日期开头、「今天…」「刚才…」这种当天的流水，改记进今天的笔记（LRN 2026-11-01）
    if (target === "long" && looksLikeLog(t)) {
      const where = this.write("daily", t, now, tag);
      console.log(`[memory] ↪️  ${this.agent.id} 这条像当天的流水，没记进 MEMORY.md、改记 ${where}：${t.slice(0, 60)}`);
      return `${where}（这条像当天发生的事，记进了今天的笔记；长期记忆只放以后还成立的事实、约定、偏好、结论）`;
    }
    if (target === "user") {
      // 关于主人的一条稳定信息是一句短话；长的多半是事情经过 / 进展，改记长期记忆（USER.md 每轮常驻，要少而精）
      // 改记别处时把原因说清楚（LRN 2026-11-07，症状「她说 memory_write 说要写 USER.md、结果落到了 MEMORY.md，工具说一套做一套」：以前只回「已记到 MEMORY.md」）
      if (Array.from(t).length > USER_ITEM_MAX) return `${this.write("long", t, now, tag)}（没记进 USER.md：超过 ${USER_ITEM_MAX} 字，不像一句关于主人的稳定信息，记进了长期记忆）`;
      // 有共享人设就记进共享的 USER.md：谁记的全家 agent 都知道
      const p = sharedPath("USER.md") || path.join(ws, "USER.md");
      const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
      const at = cur.indexOf(USER_AUTO_HEAD);
      const auto = at >= 0 ? cur.slice(at + USER_AUTO_HEAD.length) : "";
      if (auto.includes(t) || personaText(ws, "USER.md").includes(t)) return "USER.md";
      if (Array.from(auto).length + Array.from(t).length > USER_AUTO_MAX) {
        console.log(`[memory] ⚠️  ${this.agent.id} USER.md 的「自动记录」满了（${USER_AUTO_MAX} 字），这条改记进 MEMORY.md——到管理界面整理一下 USER.md`);
        return `${this.write("long", t, now, tag)}（没记进 USER.md：USER.md 的「自动记录」已满 ${USER_AUTO_MAX} 字，先记进了长期记忆；告诉主人到管理界面整理一下 USER.md，别自己去改文件）`;
      }
      const base = at >= 0 ? cur.replace(/\n*$/, "\n") : cur.replace(/\n*$/, cur.trim() ? "\n\n" : "") + USER_AUTO_HEAD + "\n";
      fs.writeFileSync(p, base + `- ${t}\n`);
      return "USER.md";
    }
    if (target === "long") {
      const p = path.join(ws, "MEMORY.md");
      const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "# 长期记忆\n";
      fs.writeFileSync(p, cur.replace(/\n*$/, "\n") + `- ${t}\n`);
      return "MEMORY.md";
    }
    const p = dailyNotePath(ws, now);
    const head = fs.existsSync(p) ? "" : `# ${strftime("%Y-%m-%d", now)}\n\n`;
    // tag：后台场景（heartbeat / 定时任务 / 待办）写的带个标记，聊天时不把这些流水带进系统提示（soul.recentNotes）
    fs.appendFileSync(p, `${head}- ${strftime("%H:%M", now)} ${tag && !t.startsWith(`[${tag}]`) ? `[${tag}] ` : ""}${t}\n`);
    return path.relative(ws, p).split(path.sep).join("/");
  }
}
