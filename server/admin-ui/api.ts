// 管理接口调用。出错时把服务端的 error 字段抛出来，页面直接显示
export async function api<T = any>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  const r = await fetch("/api/admin" + path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "content-type": "application/json" } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const ct = r.headers.get("content-type") ?? "";
  const data: any = ct.includes("json") ? await r.json() : await r.blob();
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
  return data as T;
}

export const enc = encodeURIComponent;

export function fmtTime(sec: number | null | undefined) {
  if (!sec) return "—";
  return new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
export function ago(sec: number) {
  if (sec < 60) return `${Math.round(sec)} 秒前`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.round(sec / 3600)} 小时前`;
  return `${Math.round(sec / 86400)} 天前`;
}
export const money = (n: number | null | undefined) => (n ? `¥${n.toFixed(n < 1 ? 4 : 2)}` : "¥0");
export const chars = (s: string) => Array.from(s).length;

export function download(name: string, content: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 跳到 #/<page>/<arg> */
export const go = (page: string, arg = "") => { location.hash = `#/${page}${arg ? "/" + encodeURIComponent(arg) : ""}`; };
