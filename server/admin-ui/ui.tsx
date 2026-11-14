// 通用小组件：卡片、按钮、表单行、表格、标签页、状态徽章、提示条、异步加载钩子
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

// ── 全局提示 ──
type Toast = { id: number; text: string; kind: "ok" | "err" };
let pushToast: (t: Omit<Toast, "id">) => void = () => {};
export const toast = (text: string, kind: "ok" | "err" = "ok") => pushToast({ text, kind });
export const toastErr = (e: any) => toast(String(e?.message ?? e), "err");

export function Toasts() {
  const [list, set] = useState<Toast[]>([]);
  pushToast = (t) => {
    const id = Date.now() + Math.random();
    set((l) => [...l, { ...t, id }]);
    setTimeout(() => set((l) => l.filter((x) => x.id !== id)), t.kind === "err" ? 6000 : 2500);
  };
  return <div class="toasts">{list.map((t) => <div key={t.id} class={`toast ${t.kind}`}>{t.text}</div>)}</div>;
}

/** 加载数据；返回 [数据, 重新加载, 错误] */
export function useLoad<T>(fn: () => Promise<T>, deps: any[] = []): [T | undefined, () => Promise<void>, string] {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState("");
  const load = useCallback(() => fn().then((d) => { setData(d); setErr(""); }).catch((e) => setErr(String(e.message ?? e))), deps);
  useEffect(() => { load(); }, [load]);
  return [data, load, err];
}

/** 定时刷新 */
export function useInterval(fn: () => void, ms: number) {
  useEffect(() => { const t = setInterval(fn, ms); return () => clearInterval(t); }, [fn, ms]);
}

export function Card(p: { title?: ComponentChildren; actions?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`card ${p.class ?? ""}`}>
      {(p.title || p.actions) && <header><h3>{p.title}</h3><div class="actions">{p.actions}</div></header>}
      {p.children}
    </section>
  );
}

export function Btn(p: { onClick?: () => any; children: ComponentChildren; kind?: "primary" | "danger" | "ghost"; disabled?: boolean; title?: string; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    if (!p.onClick) return;
    setBusy(true);
    try { await p.onClick(); } catch (e) { toastErr(e); } finally { setBusy(false); }
  };
  return <button class={`btn ${p.kind ?? ""} ${p.small ? "small" : ""}`} disabled={p.disabled || busy} title={p.title} onClick={click}>{busy ? "…" : p.children}</button>;
}

export function Field(p: { label: string; hint?: ComponentChildren; children: ComponentChildren; wide?: boolean }) {
  return <label class={`field ${p.wide ? "wide" : ""}`}><span class="lbl">{p.label}</span>{p.children}{p.hint && <small class="hint">{p.hint}</small>}</label>;
}

export function Input(p: { value: any; onInput: (v: string) => void; type?: string; placeholder?: string; disabled?: boolean }) {
  return <input type={p.type ?? "text"} value={p.value ?? ""} placeholder={p.placeholder} disabled={p.disabled} onInput={(e) => p.onInput((e.target as HTMLInputElement).value)} />;
}

export function TextArea(p: { value: string; onInput: (v: string) => void; rows?: number; placeholder?: string; mono?: boolean }) {
  return <textarea class={p.mono ? "mono" : ""} rows={p.rows ?? 8} value={p.value} placeholder={p.placeholder} onInput={(e) => p.onInput((e.target as HTMLTextAreaElement).value)} />;
}

export function Select<T extends string>(p: { value: T; onChange: (v: T) => void; options: (T | [T, string])[] }) {
  return (
    <select value={p.value} onChange={(e) => p.onChange((e.target as HTMLSelectElement).value as T)}>
      {p.options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return <option value={v}>{l}</option>; })}
    </select>
  );
}

export function Toggle(p: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <label class="toggle"><input type="checkbox" checked={p.checked} onChange={(e) => p.onChange((e.target as HTMLInputElement).checked)} /><span>{p.label}</span></label>;
}

export function Tabs<T extends string>(p: { value: T; onChange: (v: T) => void; tabs: [T, string][] }) {
  return <nav class="tabs">{p.tabs.map(([v, l]) => <a class={v === p.value ? "on" : ""} onClick={() => p.onChange(v)}>{l}</a>)}</nav>;
}

const BADGE: Record<string, string> = {
  online: "ok", ok: "ok", silent: "muted", connecting: "warn", deferred: "warn", skipped: "muted", running: "warn",
  error: "err", rejected: "err", stopped: "muted", missed: "warn",
};
const BADGE_TEXT: Record<string, string> = {
  online: "在线", ok: "成功", silent: "无事", connecting: "连接中", deferred: "延后", skipped: "跳过", running: "运行中",
  error: "失败", rejected: "拒绝", stopped: "未启动", missed: "错过",
};
export function Badge(p: { s: string; text?: string }) {
  return <span class={`badge ${BADGE[p.s] ?? "muted"}`}>{p.text ?? BADGE_TEXT[p.s] ?? (p.s || "—")}</span>;
}

export function Empty(p: { children: ComponentChildren }) { return <div class="empty">{p.children}</div>; }
export function Err(p: { msg: string }) { return p.msg ? <div class="errbox">{p.msg}</div> : null; }

/** 左边列表、右边详情的布局 */
export function Split(p: { left: ComponentChildren; children: ComponentChildren }) {
  return <div class="split"><aside>{p.left}</aside><div class="detail">{p.children}</div></div>;
}

/**
 * 侧边长列表：顶上搜索框；分组可折叠（标题带数量）；每组先显示 initial 个，底下「再显示」。
 * 记忆、技能、扩展、会话这些多了以后就是一长串，靠它找得到东西。render 返回一个 <li>
 */
export function SideList<T>(p: {
  groups: { id: string; title?: string; items: T[]; collapsed?: boolean }[];
  match: (it: T, q: string) => boolean;
  render: (it: T) => ComponentChildren;
  placeholder?: string;
  initial?: number;
  empty?: ComponentChildren;
}) {
  const [q, setQ] = useState("");
  const [more, setMore] = useState<Record<string, number>>({});
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const init = p.initial ?? 30;
  const needle = q.trim().toLowerCase();
  const total = p.groups.reduce((n, g) => n + g.items.length, 0);
  const groups = p.groups.map((g) => ({ ...g, items: needle ? g.items.filter((it) => p.match(it, needle)) : g.items })).filter((g) => g.items.length);
  return (
    <>
      {total > 8 && <input class="sidesearch" type="search" value={q} placeholder={p.placeholder ?? "搜索…"} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />}
      {groups.map((g) => {
        const closed = !needle && (shut[g.id] ?? !!g.collapsed);
        const n = needle ? 100 : (more[g.id] ?? init);
        const body = !closed && <ul class="list">
          {g.items.slice(0, n).map(p.render)}
          {g.items.length > n && <li class="more" onClick={() => setMore({ ...more, [g.id]: n + init * 2 })}>再显示 {Math.min(g.items.length - n, init * 2)} 个（共 {g.items.length}）</li>}
        </ul>;
        return g.title ? <div class="sidegroup">
          <h4 class="muted" onClick={() => setShut({ ...shut, [g.id]: !closed })}>{closed ? "▸" : "▾"} {g.title} <small>{g.items.length}</small></h4>
          {body}
        </div> : body;
      })}
      {!groups.length && (needle ? <div class="muted small" style="padding:8px">没有匹配的</div> : p.empty)}
    </>
  );
}

/** 表格分页：返回这一页的数据和翻页条（只有一页时不显示） */
export function usePage<T>(list: T[], size = 20): [T[], ComponentChildren] {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(list.length / size));
  const cur = Math.min(page, pages - 1);
  const bar = pages > 1 && <div class="pager">
    <Btn small kind="ghost" disabled={cur === 0} onClick={() => setPage(cur - 1)}>‹ 上一页</Btn>
    <span class="muted">{cur + 1} / {pages}（共 {list.length} 条）</span>
    <Btn small kind="ghost" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>下一页 ›</Btn>
  </div>;
  return [list.slice(cur * size, (cur + 1) * size), bar];
}

/** 小图标：鼠标放上去看详情，点一下固定住（再点 / 点别处收起）。tip 是一行摘要（原生提示） */
export function Pop(p: { icon: ComponentChildren; tip?: string; class?: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  // 在屏幕下半部分就往上弹，免得被滚动区域底边截掉
  const place = () => { const r = ref.current?.getBoundingClientRect(); if (r) setUp(r.top > window.innerHeight * 0.55); };
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <span class={`pop ${open ? "open" : ""} ${up ? "up" : ""} ${p.class ?? ""}`} ref={ref} onMouseEnter={place}>
      <button type="button" class="popbtn" aria-label={p.tip} onClick={() => { place(); setOpen(!open); }}>{p.icon}</button>
      <div class="poppanel">{p.tip && <div class="poptip">{p.tip}</div>}{p.children}</div>
    </span>
  );
}

export function confirmDo(msg: string, fn: () => any) { return () => (window.confirm(msg) ? fn() : undefined); }

// ── 图标（lucide 风格的线条图标，内联，不依赖外部资源）──
const ICONS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  bot: "M12 8V4H8M4 12a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM2 14h2M20 14h2M9 13v2M15 13v2",
  brain: "M9.5 2A2.5 2.5 0 0 0 7 4.5v.3A3 3 0 0 0 4.6 9 3 3 0 0 0 5 14.6 3 3 0 0 0 8 19.5 2.5 2.5 0 0 0 12 20V4.5A2.5 2.5 0 0 0 9.5 2zM14.5 2A2.5 2.5 0 0 1 17 4.5v.3A3 3 0 0 1 19.4 9a3 3 0 0 1-.4 5.6 3 3 0 0 1-3 4.9A2.5 2.5 0 0 1 12 20",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
  puzzle: "M19.4 13.6a2 2 0 1 0 0-3.2V7a1 1 0 0 0-1-1h-3.4a2 2 0 1 0-3.2 0H8.4a1 1 0 0 0-1 1v3.4a2 2 0 1 0 0 3.2V17a1 1 0 0 0 1 1h3.4a2 2 0 1 1 3.2 0h3.4a1 1 0 0 0 1-1z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  cpu: "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  monitor: "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 21h8M12 17v4",
  menu: "M4 6h16M4 12h16M4 18h16",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
} as const;
export type IconName = keyof typeof ICONS;
export function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>;
}

/** 总览页顶部的数字卡片 */
export function Stat(p: { label: string; value: ComponentChildren; sub?: ComponentChildren }) {
  return <div class="stat"><span>{p.label}</span><b>{p.value}</b>{p.sub && <small>{p.sub}</small>}</div>;
}
