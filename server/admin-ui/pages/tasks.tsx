// 待办：白天记下、夜间静默时段执行的活。改开始时间 / 内容、立即执行、撤销、重新排队；静默时段与汇报时间设置
import { useState } from "preact/hooks";
import { api, enc, fmtTime, go, money } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Field, Input, Select, TextArea, Toggle, confirmDo, toast, toastErr, useInterval, useLoad } from "../ui.tsx";

const STATUS: Record<string, [string, string]> = {
  queued: ["muted", "排队中"], running: ["running", "进行中"], done: ["ok", "完成"], partial: ["deferred", "没做完"], failed: ["error", "失败"], cancelled: ["skipped", "已撤销"],
};
const St = ({ s }: { s: string }) => <Badge s={STATUS[s]?.[0] ?? s} text={STATUS[s]?.[1] ?? s} />;

function toLocalInput(sec: number) {
  const d = new Date(sec * 1000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const whenText = (t: any, d: any) => t.status !== "queued" ? fmtTime(t.started ?? t.updated)
  : t.run_at !== null ? fmtTime(t.run_at) : d.settings.auto ? `静默时段（${d.in_window ? "进行中" : fmtTime(d.next_window)}）` : "等手动执行";

export function Tasks({ arg }: { arg: string }) {
  const [d, reload, err] = useLoad(() => api<any>("/tasks"));
  useInterval(reload, 10_000);
  if (!d) return <Err msg={err} />;
  if (arg === "new") return <TaskForm done={() => { reload(); go("tasks"); }} />;
  if (arg) {
    const t = d.tasks.find((x: any) => x.id === arg);
    return t ? <TaskDetail t={t} d={d} reload={reload} /> : <Err msg="没有这件待办" />;
  }
  const open = d.tasks.filter((t: any) => t.status === "queued" || t.status === "running");
  const past = d.tasks.filter((t: any) => t.status !== "queued" && t.status !== "running").slice(0, 50);
  return (
    <>
      <div class="row"><Btn kind="primary" onClick={() => go("tasks", "new")}>＋ 新建待办</Btn></div>
      <Err msg={err} />
      <SettingsCard d={d} reload={reload} />
      <Card title={`排队中 ${open.length ? `· ${open.length}` : ""}`}>
        {open.length ? <TaskTable list={open} d={d} reload={reload} /> : <Empty>没有排队的待办</Empty>}
      </Card>
      {past.length > 0 && <Card title="已结束"><TaskTable list={past} d={d} reload={reload} /></Card>}
    </>
  );
}

function SettingsCard({ d, reload }: { d: any; reload: () => void }) {
  const [f, set] = useState({ ...d.settings });
  const dirty = JSON.stringify(f) !== JSON.stringify(d.settings);
  return (
    <Card title="执行时段" actions={dirty && <Btn small kind="primary" onClick={async () => {
      try { await api("/tasks-settings", { method: "PUT", body: { ...f, max_minutes: Number(f.max_minutes) } }); toast("已保存"); reload(); } catch (e) { toastErr(e); }
    }}>保存</Btn>}>
      <div class="form">
        <Field label="静默时段"><Input value={f.window} onInput={(v) => set({ ...f, window: v })} placeholder="01:00-06:00" /></Field>
        <Field label="汇报时间" hint="留空 = 做完就报"><Input value={f.report_at} onInput={(v) => set({ ...f, report_at: v })} placeholder="08:00" /></Field>
        <Field label="单件最长（分钟）"><Input type="number" value={f.max_minutes} onInput={(v) => set({ ...f, max_minutes: v })} /></Field>
        <Field label="自动执行"><Toggle checked={f.auto} onChange={(v) => set({ ...f, auto: v })} label="静默时段自动做" /></Field>
      </div>
    </Card>
  );
}

function TaskTable({ list, d, reload }: { list: any[]; d: any; reload: () => void }) {
  const act = (path: string, msg: string, body: any = {}) => async () => {
    try { await api(path, { body }); toast(msg); reload(); } catch (err) { toastErr(err); }
  };
  return (
    <table class="hover">
      <thead><tr><th>待办</th><th>agent</th><th>开始</th><th>状态</th><th /></tr></thead>
      <tbody>{list.map((t) => (
        <tr onClick={() => go("tasks", t.id)}>
          <td>{t.title}{t.source === "admin" && <small class="tag">手动</small>}</td>
          <td>{t.agent}</td>
          <td>{whenText(t, d)}</td>
          <td><St s={t.status} />{(t.status === "done" || t.status === "partial") && !t.reported && <small class="muted"> 待汇报</small>}</td>
          <td class="actions" onClick={(e) => e.stopPropagation()}>
            {t.status === "queued" && <Btn small onClick={act(`/tasks/${enc(t.id)}/run`, d.busy ? "排在正在做的那件后面" : "开始执行")}>立即执行</Btn>}
            {(t.status === "queued" || t.status === "running") && <Btn small kind="ghost" onClick={act(`/tasks/${enc(t.id)}/cancel`, "已撤销")}>撤销</Btn>}
            {t.status === "partial" && <Btn small onClick={act(`/tasks/${enc(t.id)}/requeue`, "接着上次的进度，排到静默时段", { resume: true })}>继续做</Btn>}
            {(t.status === "failed" || t.status === "cancelled") && <Btn small kind="ghost" onClick={act(`/tasks/${enc(t.id)}/requeue`, "已重新排队")}>重新排队</Btn>}
          </td>
        </tr>))}</tbody>
    </table>
  );
}

function TaskForm({ t, done }: { t?: any; done: () => void }) {
  const [agents] = useLoad(() => api<any[]>("/agents"));
  const [f, set] = useState({
    agent: t?.agent ?? "", title: t?.title ?? "", detail: t?.detail ?? "",
    mode: t?.run_at ? "at" : "night", at: toLocalInput(t?.run_at ?? Date.now() / 1000 + 3600),
  });
  const submit = async () => {
    const body = { title: f.title, detail: f.detail, run_at: f.mode === "night" ? null : new Date(f.at).getTime() / 1000 };
    try {
      if (t) await api(`/tasks/${enc(t.id)}`, { method: "PATCH", body });
      else await api("/tasks", { body: { ...body, agent: f.agent || agents?.[0]?.id } });
      toast("已保存");
      done();
    } catch (e) { toastErr(e); }
  };
  return (
    <Card title={t ? `编辑：${t.title}` : "新建待办"} actions={<Btn kind="ghost" onClick={done}>取消</Btn>}>
      <div class="form">
        {!t && <Field label="agent"><Select value={f.agent || agents?.[0]?.id || ""} onChange={(v) => set({ ...f, agent: v })} options={(agents ?? []).map((a) => [a.id, a.name] as [string, string])} /></Field>}
        <Field label="标题"><Input value={f.title} onInput={(v) => set({ ...f, title: v })} /></Field>
        <Field label="开始"><Select value={f.mode} onChange={(v) => set({ ...f, mode: v })} options={[["night", "静默时段"], ["at", "指定时间"]]} /></Field>
        {f.mode === "at" && <Field label="时间"><input type="datetime-local" value={f.at} onInput={(e) => set({ ...f, at: (e.target as HTMLInputElement).value })} /></Field>}
        <Field label="要做什么" wide><TextArea value={f.detail} onInput={(v) => set({ ...f, detail: v })} rows={8} placeholder="目标、相关文件 / 链接、做到什么程度算完" /></Field>
      </div>
      <Btn kind="primary" onClick={submit} disabled={!f.title.trim() || !f.detail.trim()}>保存</Btn>
    </Card>
  );
}

function TaskDetail({ t, d, reload }: { t: any; d: any; reload: () => void }) {
  const [edit, setEdit] = useState(false);
  if (edit) return <TaskForm t={t} done={() => { setEdit(false); reload(); }} />;
  const act = (path: string, msg: string, body: any = {}) => async () => { try { await api(path, { body }); toast(msg); reload(); } catch (e) { toastErr(e); } };
  return (
    <>
      <div class="titlebar"><h3>{t.title} <small class="muted">{t.id}</small></h3>
        <div class="actions">
          <Btn kind="ghost" onClick={() => go("tasks")}>← 返回</Btn>
          {t.status === "queued" && <Btn onClick={() => setEdit(true)}>编辑</Btn>}
          {t.status === "queued" && <Btn kind="primary" onClick={act(`/tasks/${enc(t.id)}/run`, "开始执行")}>立即执行</Btn>}
          {(t.status === "queued" || t.status === "running") && <Btn kind="danger" onClick={act(`/tasks/${enc(t.id)}/cancel`, "已撤销")}>撤销</Btn>}
          {t.status === "partial" && <Btn kind="primary" onClick={act(`/tasks/${enc(t.id)}/requeue`, "接着上次的进度，排到静默时段", { resume: true })}>继续做</Btn>}
          {(t.status === "partial" || t.status === "failed" || t.status === "cancelled") && <Btn onClick={act(`/tasks/${enc(t.id)}/requeue`, "已重新排队，从头开始", { resume: false })}>{t.status === "partial" ? "重新开始" : "重新排队"}</Btn>}
          {t.started && <Btn kind="ghost" onClick={() => go("sessions", `${t.agent}|${t.agent}:task:${t.id}`)}>执行过程</Btn>}
          {t.status !== "running" && <Btn kind="ghost" onClick={confirmDo("删除这件待办？", async () => { await api(`/tasks/${enc(t.id)}`, { method: "DELETE" }); reload(); go("tasks"); })}>删除</Btn>}
        </div></div>
      <Card>
        <dl class="kv">
          <dt>状态</dt><dd><St s={t.status} /></dd>
          <dt>agent</dt><dd>{t.agent}</dd>
          <dt>开始</dt><dd>{whenText(t, d)}{t.finished && ` → ${fmtTime(t.finished)}`}</dd>
          <dt>汇报到</dt><dd><code>{t.origin || "—"}</code>{t.reported && t.delivered && <small class="muted"> 已送达 {t.delivered}</small>}</dd>
          {t.tokens_in > 0 && <><dt>用量</dt><dd>{t.tokens_in}/{t.tokens_out} token · {money(t.cost)}</dd></>}
          <dt>要做什么</dt><dd class="pre">{t.detail}</dd>
          {t.result && <><dt>结果</dt><dd class="pre">{t.result}</dd></>}
          {t.error && <><dt>{t.status === "failed" ? "失败原因" : t.status === "partial" ? "为什么没做完" : "备注"}</dt><dd class="pre over">{t.error}</dd></>}
        </dl>
      </Card>
    </>
  );
}
