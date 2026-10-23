// 通用小组件：卡片、按钮、表单行、表格、标签页、状态徽章、提示条、异步加载钩子
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

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
export function useLoad<T>(fn: () => Promise<T>, deps: any[] = []): [T | undefined, () => void, string] {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState("");
  const load = useCallback(() => { fn().then((d) => { setData(d); setErr(""); }).catch((e) => setErr(String(e.message ?? e))); }, deps);
  useEffect(load, [load]);
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

export function confirmDo(msg: string, fn: () => any) { return () => (window.confirm(msg) ? fn() : undefined); }
