// 记忆（§6.4）：MEMORY.md（精炼长期记忆）+ memory/YYYY-MM-DD.md（每日笔记），纯 markdown。
//
// 检索 = 关键词（SQLite FTS5，CJK 逐字切开）+ 向量（可选，用户配的嵌入接口，余弦在 JS 里算）。
// 两路分数各自归一化后加权合并；没配嵌入就只用关键词。
// 索引按文件 mtime/size 增量更新：每次检索前同步一次，管理 UI 手改文件也能马上搜到。
import fs from "node:fs";
import path from "node:path";
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
  + "一起 看看 好的 好吧 嗯嗯 哈哈 谢谢 记得 记住 说过 一直 喜欢 想要 需要 应该 不要 不会 可能").split(" "));

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
/** USER.md 自动记录里单条的上限：超过就不像「关于主人的一条稳定信息」了，改记 MEMORY.md */
export const USER_ITEM_MAX = 80;
export const USER_AUTO_MAX = 1500;

export interface MemoryHit { path: string; start: number; end: number; text: string; score: number; via: string; terms?: string[] }

export class MemoryIndex {
  constructor(private agent: AgentInfo, private db: DatabaseSync, private embedder: Embedder | null) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mem_files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER);
      CREATE TABLE IF NOT EXISTS mem_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, start_line INTEGER, end_line INTEGER, text TEXT, embedding BLOB);
      CREATE INDEX IF NOT EXISTS mem_chunks_path ON mem_chunks(path);
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(body, chunk_id UNINDEXED, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS mem_meta (key TEXT PRIMARY KEY, value TEXT);
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

  /** paths = 只在这些文件里找（自动回忆只看 MEMORY.md）；不给 = 全部 */
  async search(query: string, k = 6, paths?: string[]): Promise<MemoryHit[]> {
    await this.sync();
    const scores = new Map<number, { kw: number; vec: number }>();
    const q = ftsQuery(query);
    const inPaths = paths ? ` AND c.path IN (${paths.map(() => "?").join(",")})` : "";
    if (q) {
      const rows = this.db.prepare(`SELECT f.chunk_id, bm25(mem_fts) AS s FROM mem_fts f JOIN mem_chunks c ON c.id = f.chunk_id WHERE mem_fts MATCH ?${inPaths} ORDER BY s LIMIT 30`).all(q, ...(paths ?? [])) as any[];
      const best = rows.length ? -rows[0].s : 0;
      for (const r of rows) scores.set(r.chunk_id, { kw: best > 0 ? -r.s / best : 1, vec: 0 });
    }
    let usedVec = false;
    if (this.embedder) {
      try {
        const [qv] = await this.embedder.embed([query]);
        const rows = this.db.prepare(`SELECT c.id, c.embedding FROM mem_chunks c WHERE c.embedding IS NOT NULL${inPaths}`).all(...(paths ?? [])) as any[];
        const sims = rows.map((r) => ({ id: r.id, s: cosine(qv, new Float32Array(new Uint8Array(r.embedding).buffer)) }))
          .sort((a, b) => b.s - a.s).slice(0, 30);
        for (const { id, s } of sims) {
          if (s <= 0.2) continue;
          const cur = scores.get(id) ?? { kw: 0, vec: 0 };
          cur.vec = s;
          scores.set(id, cur);
        }
        usedVec = rows.length > 0;
      } catch (e: any) { console.log(`[memory] ⚠️  查询向量失败（只用关键词）: ${e.message}`); }
    }
    const get = this.db.prepare("SELECT * FROM mem_chunks WHERE id = ?");
    return [...scores.entries()]
      .map(([id, s]) => ({ id, score: usedVec ? 0.4 * s.kw + 0.6 * s.vec : s.kw, via: s.kw && s.vec ? "both" : s.kw ? "keyword" : "vector" }))
      .sort((a, b) => b.score - a.score).slice(0, k)
      .map(({ id, score, via }) => {
        const c = get.get(id) as any;
        return { path: c.path, start: c.start_line, end: c.end_line, text: c.text, score: Math.round(score * 1000) / 1000, via };
      });
  }

  /**
   * 自动回忆：拿主人这句话检索，挑真正相关的几条（附在这一轮消息上）。关键词分数是相对最高分归一化的，
   * 最好的那条永远是 1，所以另按「命中了几个不同的词」卡一道：两字词至少中 2 个（「今天」这种常见词单独命中不算），
   * 向量相似度够高的直接算。
   * 只看 MEMORY.md（LRN 2026-10-30）：每日笔记记的是「当时」的事（「今天有点累」「下午去超市」），检索出来混在消息里，
   * 模型分不清是哪天的，容易当成现在的情况；旧笔记要查让 agent 自己 memory_search（结果带文件名 = 日期）。
   */
  async recall(query: string, o: { k?: number; maxChars?: number; paths?: string[] } = {}): Promise<MemoryHit[]> {
    const paths = o.paths ?? ["MEMORY.md"];
    const q = query.replace(/^\[[^\]]*\]\s*/, "").trim();
    if (Array.from(q.replace(/[\s\p{P}]/gu, "")).length < 4) return [];
    // 先把常用词从这句话里抠掉再切词：不然「主人今天」会拼出「人今」这种跨词的两字，正好撞上「主人今天…」的记忆
    let qq = q.toLowerCase();
    for (const w of STOP_TERMS) qq = qq.split(w).join(" ");
    if (!ftsQuery(qq)) return [];
    const hits0 = await this.search(qq, 12, paths);
    // 有信息量的词：去掉常用词，再去掉在记忆里到处都是的（出现在超过 15% 的块里）
    const inPaths = `path IN (${paths.map(() => "?").join(",")})`;
    const total = Math.max(1, (this.db.prepare(`SELECT COUNT(*) AS n FROM mem_chunks WHERE ${inPaths}`).get(...paths) as any).n);
    const dfStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM mem_chunks WHERE ${inPaths} AND instr(lower(text), ?) > 0`);
    const df = new Map<string, number>();
    const terms = ftsQuery(qq).split(" OR ").map((t) => t.replace(/"/g, "").replace(/ /g, "")).filter((t) => t && !STOP_TERMS.has(t))
      .filter((t) => { const n = (dfStmt.get(...paths, t) as any).n; df.set(t, n); return n <= Math.max(3, total * 0.15); });
    const out: MemoryHit[] = [];
    let size = 0;
    for (const h of hits0) {
      const body = h.text.toLowerCase();
      const hit = terms.filter((t) => body.includes(t));
      const strongVec = h.via !== "keyword" && h.score >= 0.5;
      // 中两个有信息量的词；或者中了一个很少见的词（「团子在干嘛」里的「团子」）
      const ok = hit.length >= 2 || (hit.length === 1 && (df.get(hit[0]) ?? 99) <= 2);
      if (!strongVec && !ok) continue;
      h.terms = hit;
      const n = Array.from(h.text).length;
      if (out.length && size + n > (o.maxChars ?? 1200)) break;
      out.push(h); size += n;
      if (out.length >= (o.k ?? 5)) break;
    }
    return out;
  }

  /**
   * 追加一条记忆。target = daily（今天的笔记）| long（MEMORY.md）| user（USER.md 末尾的「自动记录」一节：关于主人本人的稳定信息，
   * 每轮常驻）。自动记录有上限 USER_AUTO_MAX，满了改记进 MEMORY.md 并提示去整理——不碰主人手写的部分。
   */
  write(target: string, text: string, now = new Date()): string {
    const ws = this.agent.workspace;
    const t = text.trim().replace(/\n+/g, " ");
    if (!t) throw new Error("内容为空");
    if (target === "user") {
      // 关于主人的一条稳定信息是一句短话；长的多半是事情经过 / 进展，改记长期记忆（USER.md 每轮常驻，要少而精）
      if (Array.from(t).length > USER_ITEM_MAX) return this.write("long", t, now);
      // 有共享人设就记进共享的 USER.md：谁记的全家 agent 都知道
      const p = sharedPath("USER.md") || path.join(ws, "USER.md");
      const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
      const at = cur.indexOf(USER_AUTO_HEAD);
      const auto = at >= 0 ? cur.slice(at + USER_AUTO_HEAD.length) : "";
      if (auto.includes(t) || personaText(ws, "USER.md").includes(t)) return "USER.md";
      if (Array.from(auto).length + Array.from(t).length > USER_AUTO_MAX) {
        console.log(`[memory] ⚠️  ${this.agent.id} USER.md 的「自动记录」满了（${USER_AUTO_MAX} 字），这条改记进 MEMORY.md——到管理界面整理一下 USER.md`);
        return this.write("long", t, now);
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
    fs.appendFileSync(p, `${head}- ${strftime("%H:%M", now)} ${t}\n`);
    return path.relative(ws, p).split(path.sep).join("/");
  }
}
