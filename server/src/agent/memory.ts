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
  lines.forEach((ln, i) => {
    const n = i + 1;
    if (/^#{1,6}\s/.test(ln) || !ln.trim()) { flush(n - 1); start = n; }
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

export interface MemoryHit { path: string; start: number; end: number; text: string; score: number; via: string }

export class MemoryIndex {
  constructor(private agent: AgentInfo, private db: DatabaseSync, private embedder: Embedder | null) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mem_files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER);
      CREATE TABLE IF NOT EXISTS mem_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, start_line INTEGER, end_line INTEGER, text TEXT, embedding BLOB);
      CREATE INDEX IF NOT EXISTS mem_chunks_path ON mem_chunks(path);
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(body, chunk_id UNINDEXED, tokenize='unicode61');
    `);
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

  async search(query: string, k = 6): Promise<MemoryHit[]> {
    await this.sync();
    const scores = new Map<number, { kw: number; vec: number }>();
    const q = ftsQuery(query);
    if (q) {
      const rows = this.db.prepare("SELECT chunk_id, bm25(mem_fts) AS s FROM mem_fts WHERE mem_fts MATCH ? ORDER BY s LIMIT 30").all(q) as any[];
      const best = rows.length ? -rows[0].s : 0;
      for (const r of rows) scores.set(r.chunk_id, { kw: best > 0 ? -r.s / best : 1, vec: 0 });
    }
    let usedVec = false;
    if (this.embedder) {
      try {
        const [qv] = await this.embedder.embed([query]);
        const rows = this.db.prepare("SELECT id, embedding FROM mem_chunks WHERE embedding IS NOT NULL").all() as any[];
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

  /** 追加一条记忆。target = daily（今天的笔记）| long（MEMORY.md） */
  write(target: string, text: string, now = new Date()): string {
    const ws = this.agent.workspace;
    const t = text.trim().replace(/\n+/g, " ");
    if (!t) throw new Error("内容为空");
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
