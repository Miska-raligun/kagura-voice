// 运行状况：总览上的卡片（今天 / 最近 7 天），「日志」页（最近的异常 + 日志文件筛选）
import { useEffect, useRef, useState } from "preact/hooks";
import { api, enc, fmtTime } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Input, Tabs, Toggle, useInterval, useLoad, usePage } from "../ui.tsx";

/** 兜底动作 / 异常的中文名（顺序 = 首页显示顺序） */
export const KIND_LABEL: Record<string, string> = {
  nudge: "想完没说话，催了一句",
  nudge_fail: "催了也没说话",
  empty_retry: "空回复，压一压重试",
  overflow: "上下文超长，重压后重试",
  guard: "单轮上限叫停",
  compact: "压缩有段没总结成",
  compact_failed: "压缩失败",
  "voice:cut": "朗读兜底失败、截断着念",
  push_failed: "推送语音合成失败",
  sub_cancelled: "子任务随叫停一起停",
  unclean_exit: "上次没有正常退出",
};
const VOICE_LABEL: Record<string, string> = { first: "她写了朗读版", short: "短回复直接念", summary: "事后压成口语", cut: "失败、截断着念" };
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const secs = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);

/** 总览上的「运行状况」：今天的数字 + 最近 7 天每天一行 */
export function HealthCard() {
  const [d, reload] = useLoad(() => api<any>("/health?days=7&limit=5"));
  useInterval(reload, 30_000);
  if (!d) return null;
  const today = d.days[0] ?? { turns: 0, ok: 0, errors: {}, events: {} };
  const errs = Object.entries(today.errors ?? {}) as [string, number][];
  const evs = Object.entries(KIND_LABEL).map(([k, l]) => [l, today.events?.[k] ?? 0] as [string, number]).filter(([, n]) => n);
  return (
    <Card title="运行状况" actions={<a href="#/logs">异常记录与日志 →</a>}>
      <div class="row">
        <span>今天 <b>{today.turns}</b> 轮，成功 <b>{pct(today.ok, today.turns)}</b></span>
        <span class="muted">平均 {secs(today.avg_ms)} · 慢的一成超过 {secs(today.p90_ms)}</span>
      </div>
      {errs.length ? <p>失败：{errs.map(([k, n]) => <Badge s="error" text={`${k} ${n}`} />)}</p> : null}
      {evs.length ? <p class="muted">兜底：{evs.map(([k, n]) => <span class="chip">{k} {n}</span>)}</p> : <p class="muted">今天没有触发兜底</p>}
      {d.days.length > 1 && (
        <table><thead><tr><th>日期</th><th>轮数</th><th>成功</th><th>失败</th><th>兜底</th></tr></thead>
          <tbody>{d.days.map((x: any) => {
            const fail = Object.values(x.errors ?? {}).reduce((a: number, b: any) => a + b, 0) as number;
            const fix = Object.entries(x.events ?? {}).filter(([k]) => !k.startsWith("voice:") || k === "voice:cut").reduce((a, [, b]) => a + (b as number), 0);
            return <tr><td class="mono">{x.day.slice(5)}</td><td class="mono">{x.turns}</td><td class="mono">{pct(x.ok, x.turns)}</td>
              <td class="mono">{fail ? <span class="over">{fail}</span> : 0}</td><td class="mono">{fix}</td></tr>;
          })}</tbody></table>
      )}
    </Card>
  );
}

function detailText(e: any): string {
  const d = e.detail ?? {};
  if (e.kind === "turn") return `${d.error ?? ""}：${d.message ?? ""}`;
  if (e.kind === "voice") return `${VOICE_LABEL[d.via] ?? d.via}${d.model ? `（${d.model}）` : ""}${d.why ? `：${d.why}` : ""}`;
  if (e.kind === "guard") return d.why ?? "";
  if (e.kind === "compact") return `${d.failed}/${d.chunks} 段没总结成（${d.trigger}）`;
  if (e.kind === "compact_failed") return `${d.trigger}：${d.error ?? ""}`;
  if (e.kind === "unclean_exit") return `pid ${d.pid}，日志最后写入 ${d.lastLog}`;
  if (e.kind === "push_failed") return `${d.device}：${d.text}`;
  return d.message ?? d.model ?? "";
}

function Events() {
  const [kind, setKind] = useState("");
  const [d, reload, err] = useLoad(() => api<any>(`/health?days=7&limit=500${kind ? `&kind=${enc(kind)}` : ""}`), [kind]);
  useInterval(reload, 10_000);
  const list = d?.recent ?? [];
  const [page, pager] = usePage(list, 30);
  const label = (e: any) => e.kind === "turn" ? "这一轮失败" : e.kind === "nudge" && !e.ok ? KIND_LABEL.nudge_fail : e.kind === "voice" ? KIND_LABEL["voice:cut"] : KIND_LABEL[e.kind] ?? e.kind;
  return (
    <>
      <Err msg={err} />
      <div class="chips">{[["", "全部"], ["turn", "失败的轮次"], ["nudge", "催说话"], ["empty_retry", "空回复"], ["overflow", "超长"], ["guard", "单轮叫停"], ["compact", "压缩"], ["voice", "朗读"], ["unclean_exit", "异常退出"]]
        .map(([k, l]) => <a class={k === kind ? "on" : ""} onClick={() => setKind(k)}>{l}</a>)}</div>
      {list.length ? <>
        <table><thead><tr><th>时间</th><th>Agent / 会话</th><th>发生了什么</th><th>详情</th></tr></thead>
          <tbody>{page.map((e: any) => (
            <tr><td class="mono nowrap">{fmtTime(e.ts)}</td>
              <td>{e.agent ? (e.session ? <a href={`#/sessions/${enc(`${e.agent}|${e.session}`)}`}>{e.agent}</a> : e.agent) : "—"} <small class="muted">{e.session ?? ""}</small></td>
              <td><Badge s={e.ok ? "deferred" : "error"} text={label(e)} /></td>
              <td class="muted">{detailText(e)}</td></tr>))}</tbody></table>
        {pager}
      </> : <Empty>最近 7 天没有记录</Empty>}
    </>
  );
}

function LogLines() {
  const [q, setQ] = useState("");
  const [issues, setIssues] = useState(true);
  const [follow, setFollow] = useState(true);
  const [d, reload, err] = useLoad(() => api<any>(`/logs?lines=800&level=${issues ? "issues" : ""}&q=${enc(q)}`), [q, issues]);
  useInterval(() => { if (follow) reload(); }, 5_000);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [d, follow]);
  return (
    <>
      <div class="row">
        <Input value={q} onInput={setQ} placeholder="搜索（agent 名、会话、关键词…）" />
        <Toggle checked={issues} onChange={setIssues} label="只看问题" />
        <Toggle checked={follow} onChange={setFollow} label="自动刷新" />
        <Btn small kind="ghost" onClick={reload}>刷新</Btn>
      </div>
      <Err msg={err} />
      {d && <p class="muted">{d.file}（{d.total} 行符合，显示最近 {d.lines.length} 行）</p>}
      <pre class="logbox" ref={box}>{(d?.lines ?? []).map((l: string) => <div class={/⚠️|❌|ERROR|\[crash\]|失败/.test(l) ? "over" : ""}>{l}</div>)}</pre>
    </>
  );
}

export function Logs() {
  const [tab, setTab] = useState<"events" | "log">("events");
  return (
    <Card>
      <Tabs value={tab} onChange={setTab} tabs={[["events", "异常记录"], ["log", "日志"]]} />
      {tab === "events" ? <Events /> : <LogLines />}
    </Card>
  );
}
