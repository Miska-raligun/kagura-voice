// 联网：web_search（搜索）+ web_fetch（读网页）。问到新闻、天气、价格这类实时信息时先查再答，不靠印象编。
//
// 搜索服务（设置 → 工具）：配了 Key 就用 Brave / Tavily / 博查 / 自建 SearXNG；
// 什么都不配也能用——直接抓必应（cn.bing.com）的搜索结果页，抓不到再试 DuckDuckGo。
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunScope } from "../scope.ts";
import type { AgentInfo } from "../registry.ts";
import type { ToolsConfig } from "../../config.ts";
import { ok, fail } from "./device.ts";
import { proxiedFetch } from "../../util/proxy.ts";

export interface SearchHit { title: string; url: string; snippet: string }
export type Fetcher = typeof fetch;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FETCH_TIMEOUT = 20_000;
const MAX_BYTES = 3 * 1024 * 1024;
export const FETCH_DEFAULT_CHARS = 12000;

/** fetch 的报错只有一句「fetch failed」，真正原因在 cause 里（DNS、证书、连接被拒……） */
export function errText(e: any): string {
  const c = e?.cause;
  const why = c ? (c.code ? `${c.code} ${c.message ?? ""}` : c.message) : "";
  const msg = e?.name === "TimeoutError" ? "超时" : e?.message ?? String(e);
  return why && !msg.includes(why) ? `${msg}（${why.trim()}）` : msg;
}

// ── HTML → 文本 ──────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", mdash: "—", ndash: "–", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", copy: "©", reg: "®", yen: "¥", times: "×" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** 网页正文：去掉脚本 / 样式 / 导航，块级元素换行，压掉多余空白 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  // 有 <article> / <main> 就只要它（少吃导航栏和页脚）
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main && main[2].length > 500) body = main[2];
  body = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n· ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|ul|ol|blockquote|pre|header|dd|dt)>/gi, "\n")
    .replace(/<(h[1-6])\b[^>]*>/gi, "\n## ")
    .replace(/<td\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  const text = decodeEntities(body)
    .replace(/[ \t 　]+/g, " ")
    .split("\n").map((l) => l.trim()).filter((l, i, a) => l || (a[i - 1] ?? "") !== "")
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text };
}

// ── 抓取 ──────────────────────────────────────────────────────

async function readCapped(r: Response): Promise<Buffer> {
  const reader = r.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    n += value.length;
    if (n >= MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(parts);
}

/** 按 Content-Type / meta 里的 charset 解码（国内不少网站还是 GBK） */
export function decodeBody(buf: Buffer, contentType: string): string {
  let cs = /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (!cs) cs = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString("latin1"))?.[1];
  try { return new TextDecoder((cs || "utf-8").toLowerCase()).decode(buf); } catch { return buf.toString("utf8"); }
}

export async function fetchPage(url: string, f: Fetcher = proxiedFetch): Promise<{ url: string; title: string; text: string; type: string }> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`不是有效的网址：${url}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只支持 http / https 网址");
  const r = await f(u, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6" }, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = r.headers.get("content-type") ?? "";
  const buf = await readCapped(r);
  const raw = decodeBody(buf, type);
  if (/html|xml/i.test(type) || /^\s*</.test(raw)) {
    const { title, text } = htmlToText(raw);
    return { url: r.url || u.href, title, text, type };
  }
  if (/json|text|javascript|csv/i.test(type) || !type) return { url: r.url || u.href, title: "", text: raw, type };
  throw new Error(`不是网页或文本（${type}）`);
}

// ── 搜索 ──────────────────────────────────────────────────────

/** 必应结果页：<li class="b_algo"> 里 <h2><a href>标题</a></h2> + <p> 摘要 */
export function parseBing(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const block of html.split(/<li[^>]+class="[^"]*\bb_algo\b[^"]*"/i).slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block) ?? /<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    out.push({ title: stripTags(a[2]), url: decodeEntities(a[1]), snippet: p ? stripTags(p[1]) : "" });
  }
  return out;
}

/** DuckDuckGo 的 html 版：result__a + result__snippet；链接是 /l/?uddg=<真实地址> */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const links = [...html.matchAll(re)];
  links.forEach((m, i) => {
    // 摘要在这条链接和下一条链接之间
    const seg = html.slice(m.index! + m[0].length, links[i + 1]?.index ?? html.length);
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(seg);
    let url = decodeEntities(m[1]);
    const ud = /[?&]uddg=([^&]+)/.exec(url);
    if (ud) url = decodeURIComponent(ud[1]);
    else if (url.startsWith("//")) url = "https:" + url;
    out.push({ title: stripTags(m[2]), url, snippet: sn ? stripTags(sn[1]) : "" });
  });
  return out;
}

async function getJson(f: Fetcher, url: string, init: RequestInit = {}) {
  const r = await f(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}：${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function getHtml(f: Fetcher, url: string) {
  const r = await f(url, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

type Provider = (q: string, n: number, cfg: ToolsConfig["web"], f: Fetcher) => Promise<SearchHit[]>;
export const PROVIDERS: Record<string, Provider> = {
  async brave(q, n, cfg, f) {
    const d = await getJson(f, `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`,
      { headers: { Accept: "application/json", "X-Subscription-Token": cfg.searchApiKey } });
    return (d.web?.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: stripTags(x.description ?? "") }));
  },
  async tavily(q, n, cfg, f) {
    const d = await getJson(f, "https://api.tavily.com/search", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.searchApiKey}` },
      body: JSON.stringify({ query: q, max_results: n }) });
    return (d.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content ?? "" }));
  },
  async bocha(q, n, cfg, f) {
    const d = await getJson(f, "https://api.bochaai.com/v1/web-search", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.searchApiKey}` },
      body: JSON.stringify({ query: q, count: n, summary: true }) });
    return (d.data?.webPages?.value ?? []).map((x: any) => ({ title: x.name, url: x.url, snippet: x.summary || x.snippet || "" }));
  },
  async searxng(q, n, cfg, f) {
    if (!cfg.searchBaseUrl) throw new Error("没配 SearXNG 地址");
    const d = await getJson(f, `${cfg.searchBaseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(q)}&format=json`);
    return (d.results ?? []).slice(0, n).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content ?? "" }));
  },
  async bing(q, n, _cfg, f) {
    return parseBing(await getHtml(f, `https://cn.bing.com/search?q=${encodeURIComponent(q)}&count=${n}`)).slice(0, n);
  },
  async duckduckgo(q, n, _cfg, f) {
    return parseDuckDuckGo(await getHtml(f, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`)).slice(0, n);
  },
};

/** 按配置依次试：指定的服务（auto 时有 Key 就按 Key 的服务）→ 必应 → DuckDuckGo */
export async function search(q: string, n: number, cfg: ToolsConfig["web"], f: Fetcher = proxiedFetch): Promise<{ hits: SearchHit[]; provider: string; errors: string[] }> {
  const chain: string[] = [];
  const p = cfg.searchProvider;
  if (p && p !== "auto") chain.push(p);
  else if (cfg.searchBaseUrl) chain.push("searxng");
  for (const fb of ["bing", "duckduckgo"]) if (!chain.includes(fb)) chain.push(fb);
  const errors: string[] = [];
  for (const name of chain) {
    const prov = PROVIDERS[name];
    if (!prov) { errors.push(`${name}：不认识的搜索服务`); continue; }
    if (["brave", "tavily", "bocha"].includes(name) && !cfg.searchApiKey) { errors.push(`${name}：没配 API Key`); continue; }
    try {
      const hits = (await prov(q, n, cfg, f)).filter((h) => h.url && h.title);
      if (hits.length) return { hits, provider: name, errors };
      errors.push(`${name}：没有结果`);
    } catch (e: any) { errors.push(`${name}：${errText(e)}`); }
  }
  return { hits: [], provider: "", errors };
}

export function webTools(cfg: ToolsConfig, f: Fetcher = proxiedFetch) {
  return (_scope: RunScope, _agent: AgentInfo): AgentTool<any>[] => {
    if (!cfg.web.enabled) return [];
    return [
      {
        name: "web_search", label: "联网搜索",
        description: "上网搜索。问到新闻、天气、价格、赛事、某个人或公司的近况等实时或你拿不准的信息时，先搜再答，别凭印象编。"
          + "返回标题、网址和摘要；需要细节再用 web_fetch 打开网页。",
        parameters: Type.Object({
          query: Type.String({ description: "搜索词，简洁具体（可以带日期、地点）" }),
          count: Type.Optional(Type.Number({ description: "要几条结果，默认 5，最多 10" })),
        }),
        async execute(_id, p: any) {
          const q = String(p.query ?? "").trim();
          if (!q) return fail("搜索词是空的");
          const n = Math.min(10, Math.max(1, Number(p.count) || 5));
          const r = await search(q, n, cfg.web, f);
          console.log(`[web] 🔎 ${q} → ${r.provider || "失败"} ${r.hits.length} 条${r.errors.length ? `（${r.errors.join("；")}）` : ""}`);
          if (!r.hits.length) return fail(`搜索失败：${r.errors.join("；")}。如果这台电脑上网要走代理，在 设置 → 工具 里填上代理地址。`);
          const today = new Date().toISOString().slice(0, 10);
          return ok(`搜索「${q}」（${r.provider}，${today}）：\n` + r.hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet.slice(0, 300)}`).join("\n")
            + "\n（摘要不一定准确，重要的事打开网页确认；回答时说明信息来源）");
        },
      },
      {
        name: "web_fetch", label: "读取网页",
        description: "打开一个网址，取回网页正文（纯文本）。用来看搜索结果的详细内容，或主人发来的链接。",
        parameters: Type.Object({
          url: Type.String(),
          max_chars: Type.Optional(Type.Number({ description: `最多返回多少字，默认 ${FETCH_DEFAULT_CHARS}` })),
        }),
        async execute(_id, p: any) {
          const max = Math.min(50000, Math.max(500, Number(p.max_chars) || FETCH_DEFAULT_CHARS));
          try {
            const page = await fetchPage(String(p.url ?? ""), f);
            console.log(`[web] 📄 ${page.url} → ${page.text.length} 字`);
            const body = page.text.length > max ? `${page.text.slice(0, max)}\n…（后面还有 ${page.text.length - max} 字，可以加大 max_chars 再读）` : page.text;
            return ok(`${page.title ? `标题：${page.title}\n` : ""}网址：${page.url}\n\n${body || "（网页没有可读的正文，可能需要登录或是动态加载的）"}`);
          } catch (e: any) { return fail(`打不开 ${p.url}：${errText(e)}`); }
        },
      },
    ];
  };
}
