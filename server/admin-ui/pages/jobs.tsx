// 定时任务：列表 + 新建向导（at/every/cron、会话、投递、活跃时段）；立即运行；运行历史；从 OpenClaw 导入
import { useState } from "preact/hooks";
import { api, enc, fmtTime, go, money } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Field, Input, Select, TextArea, Toggle, confirmDo, toast, toastErr, useInterval, useLoad } from "../ui.tsx";

export function scheduleText(s: any) {
  if (!s) return "—";
  if (s.kind === "at") return `一次：${fmtTime(s.at)}`;
  if (s.kind === "every") return s.every_secs % 3600 === 0 ? `每 ${s.every_secs / 3600} 小时` : `每 ${Math.round(s.every_secs / 60)} 分钟`;
  return `cron ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
}

export function Jobs({ arg }: { arg: string }) {
  const [jobs, reload, err] = useLoad(() => api<any[]>("/jobs"));
  useInterval(reload, 15_000);
  if (arg === "new") return <JobForm done={() => { reload(); go("jobs"); }} />;
  if (arg) {
    const j = jobs?.find((x) => x.id === arg);
    return j ? <JobDetail j={j} reload={reload} /> : <Err msg={err || (jobs ? "没有这个任务" : "")} />;
  }
  return (
    <>
      <div class="row"><Btn kind="primary" onClick={() => go("jobs", "new")}>＋ 新建任务</Btn><ImportOpenClaw done={reload} /></div>
      <Err msg={err} />
      <Card>
        {jobs?.length ? <table class="hover">
          <thead><tr><th>名称</th><th>agent</th><th>时间</th><th>投递</th><th>下次</th><th>上次</th><th>启用</th></tr></thead>
          <tbody>{jobs.map((j) => (
            <tr onClick={() => go("jobs", j.id)}>
              <td>{j.name}{j.kind === "heartbeat" && <small class="tag">heartbeat</small>}{j.source === "openclaw" && <small class="tag">OpenClaw 导入</small>}</td>
              <td>{j.agent}</td><td>{scheduleText(j.schedule)}</td><td><code>{j.delivery}</code></td>
              <td>{j.enabled ? fmtTime(j.retry_at ?? j.next_run) : "—"}</td>
              <td>{j.last_status ? <Badge s={j.last_status} /> : "—"}{j.fail_count > 0 && <small class="over"> ×{j.fail_count}</small>}</td>
              <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={j.enabled} onChange={async (e) => {
                await api(`/jobs/${enc(j.id)}`, { method: "PATCH", body: { enabled: (e.target as HTMLInputElement).checked } }); reload();
              }} /></td>
            </tr>))}</tbody></table> : <Empty>还没有定时任务。可以让 agent 自己建（「每天八点给我讲新闻」），或者点「新建任务」。</Empty>}
      </Card>
    </>
  );
}

function ImportOpenClaw({ done }: { done: () => void }) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState("");
  const [rep, setRep] = useState<any>(null);
  if (!open) return <Btn onClick={() => setOpen(true)}>从 OpenClaw 导入</Btn>;
  return (
    <Card title="从 OpenClaw 导入" actions={<Btn kind="ghost" onClick={() => setOpen(false)}>关闭</Btn>} class="wide">
      <p class="muted">拷贝人设、记忆文件，并把定时任务转换过来（导入后默认暂停，逐条确认再启用）。已存在的每日笔记不覆盖。</p>
      <div class="row"><Input value={dir} onInput={setDir} placeholder="OpenClaw 目录，留空 = 自动找（本机和 WSL 里的 ~/.openclaw）" />
        <Btn kind="primary" onClick={async () => { try { const r = await api("/import/openclaw", { body: { dir: dir || undefined } }); setRep(r); done(); } catch (e) { toastErr(e); } }}>导入</Btn></div>
      {rep && <pre class="log">{rep.lines.join("\n")}</pre>}
    </Card>
  );
}

/** 投递目标：设备 + 已接入的 IM 聊天（绑定过或者手填） */
function DeliveryPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [devs] = useLoad(() => api<any[]>("/devices"));
  const opts: [string, string][] = [["none", "不投递（只记录）"], ["webchat", "网页聊天"], ...(devs ?? []).map((d) => [`device:${d.id}`, `设备 ${d.id}`] as [string, string])];
  const custom = !opts.some((o) => o[0] === value);
  return (
    <div class="row">
      <Select value={custom ? "__custom" : value} onChange={(v) => onChange(v === "__custom" ? "device:cores3" : v)} options={[...opts, ["__custom", "其它（手填）"]]} />
      {custom && <Input value={value} onInput={onChange} placeholder="device:<id> / feishu:<账号>:<聊天id>" />}
    </div>
  );
}

function toLocalInput(sec: number) {
  const d = new Date(sec * 1000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function JobForm({ j, done }: { j?: any; done: () => void }) {
  const [agents] = useLoad(() => api<any[]>("/agents"));
  const s = j?.schedule ?? { kind: "cron", expr: "0 8 * * *" };
  const [f, set] = useState({
    agent: j?.agent ?? "", name: j?.name ?? "", kind: j?.kind ?? "agentTurn", session: j?.session ?? "isolated",
    message: j?.message ?? "", delivery: j?.delivery ?? "none", active_hours: j?.active_hours ?? "", idle_only: j?.idle_only ?? false,
    max_retries: j?.max_retries ?? 2, model: j?.model ?? "",
    skind: s.kind, at: s.kind === "at" ? toLocalInput(s.at) : toLocalInput(Date.now() / 1000 + 3600),
    every: s.kind === "every" ? String(Math.round(s.every_secs / 60)) : "60", expr: s.kind === "cron" ? s.expr : "0 8 * * *", tz: s.tz ?? "",
  });
  const hb = j?.kind === "heartbeat";
  const schedule = () => f.skind === "at" ? { kind: "at", at: new Date(f.at).getTime() / 1000 }
    : f.skind === "every" ? { kind: "every", every_secs: Number(f.every) * 60 } : { kind: "cron", expr: f.expr, ...(f.tz ? { tz: f.tz } : {}) };
  const submit = async () => {
    const body: any = { name: f.name, schedule: schedule(), message: f.message, delivery: f.delivery, active_hours: f.active_hours, idle_only: f.idle_only, max_retries: Number(f.max_retries), model: f.model };
    if (!hb) Object.assign(body, { kind: f.kind, session: f.session });
    if (j) await api(`/jobs/${enc(j.id)}`, { method: "PATCH", body });
    else await api("/jobs", { body: { ...body, agent: f.agent || agents?.[0]?.id } });
    toast("已保存");
    done();
  };
  return (
    <Card title={j ? `编辑：${j.name}` : "新建定时任务"} actions={<Btn kind="ghost" onClick={done}>取消</Btn>}>
      {hb && <p class="muted">这是 heartbeat 任务，开关、间隔、投递在 agent 的 Heartbeat 页里改更方便。</p>}
      <div class="form">
        {!j && <Field label="agent"><Select value={f.agent || agents?.[0]?.id || ""} onChange={(v) => set({ ...f, agent: v })} options={(agents ?? []).map((a) => [a.id, a.name] as [string, string])} /></Field>}
        <Field label="名称"><Input value={f.name} onInput={(v) => set({ ...f, name: v })} /></Field>
        <Field label="时间">
          <Select value={f.skind} onChange={(v) => set({ ...f, skind: v })} options={[["at", "一次性"], ["every", "固定间隔"], ["cron", "cron 表达式"]]} />
        </Field>
        {f.skind === "at" && <Field label="什么时候"><input type="datetime-local" value={f.at} onInput={(e) => set({ ...f, at: (e.target as HTMLInputElement).value })} /></Field>}
        {f.skind === "every" && <Field label="每隔（分钟）"><Input type="number" value={f.every} onInput={(v) => set({ ...f, every: v })} /></Field>}
        {f.skind === "cron" && <Field label="cron（分 时 日 月 周）" hint="0 8 * * * = 每天 8 点；30 7 * * 1-5 = 工作日 7:30"><Input value={f.expr} onInput={(v) => set({ ...f, expr: v })} /></Field>}
        {f.skind === "cron" && <Field label="时区" hint="留空 = 服务器时区"><Input value={f.tz} onInput={(v) => set({ ...f, tz: v })} placeholder="Asia/Shanghai" /></Field>}
        {!hb && <Field label="类型"><Select value={f.kind} onChange={(v) => set({ ...f, kind: v })} options={[["agentTurn", "让 agent 干活（agentTurn）"], ["systemEvent", "注入一条系统事件（可以不回）"]]} /></Field>}
        {!hb && <Field label="会话" hint="isolated：每次全新上下文，适合早报；main：带着日常聊天的上下文"><Select value={f.session} onChange={(v) => set({ ...f, session: v })} options={[["isolated", "isolated（独立）"], ["main", "main（主会话）"]]} /></Field>}
        <Field label="投递到"><DeliveryPicker value={f.delivery} onChange={(v) => set({ ...f, delivery: v })} /></Field>
        <Field label="活跃时段" hint="时段外跳过，如 08:00-23:00（可跨午夜）"><Input value={f.active_hours} onInput={(v) => set({ ...f, active_hours: v })} /></Field>
        <Field label="失败重试次数"><Input type="number" value={f.max_retries} onInput={(v) => set({ ...f, max_retries: v })} /></Field>
        <Field label="模型" hint="留空 = agent 的模型（heartbeat 默认便宜模型）"><Input value={f.model} onInput={(v) => set({ ...f, model: v })} placeholder="provider/model" /></Field>
        <Field label="其他" wide><Toggle checked={f.idle_only} onChange={(v) => set({ ...f, idle_only: v })} label="设备正在对话时延后执行" /></Field>
        <Field label={hb ? "提示词（留空用默认的 heartbeat 提示）" : "到点交给 agent 的指令"} wide><TextArea value={f.message} onInput={(v) => set({ ...f, message: v })} rows={5} placeholder="例：讲讲今天的天气和三条科技新闻，一分钟以内" /></Field>
      </div>
      <Btn kind="primary" onClick={submit} disabled={!hb && !f.message.trim()}>保存</Btn>
    </Card>
  );
}

function JobDetail({ j, reload }: { j: any; reload: () => void }) {
  const [edit, setEdit] = useState(false);
  const [runs, reloadRuns] = useLoad(() => api<any[]>(`/jobs/${enc(j.id)}/runs`), [j.id]);
  if (edit) return <JobForm j={j} done={() => { setEdit(false); reload(); }} />;
  return (
    <>
      <div class="titlebar"><h3>{j.name} <small class="muted">{j.id}</small></h3>
        <div class="actions">
          <Btn onClick={() => go("jobs")} kind="ghost">← 返回</Btn>
          <Btn onClick={() => setEdit(true)}>编辑</Btn>
          <Btn kind="primary" onClick={async () => { const r = await api(`/jobs/${enc(j.id)}/run`, { body: {} }); toast(`运行完成：${r.status}`); reloadRuns(); reload(); }}>立即运行</Btn>
          {j.kind !== "heartbeat" && <Btn kind="danger" onClick={confirmDo("删除这个任务？", async () => { await api(`/jobs/${enc(j.id)}`, { method: "DELETE" }); reload(); go("jobs"); })}>删除</Btn>}
        </div></div>
      <Card>
        <dl class="kv">
          <dt>agent</dt><dd>{j.agent}</dd><dt>时间</dt><dd>{scheduleText(j.schedule)}</dd>
          <dt>类型 / 会话</dt><dd>{j.kind} / {j.session}</dd><dt>投递</dt><dd><code>{j.delivery}</code></dd>
          <dt>活跃时段</dt><dd>{j.active_hours || "全天"}</dd><dt>状态</dt><dd>{j.enabled ? "启用" : "暂停"} · 下次 {fmtTime(j.retry_at ?? j.next_run)}</dd>
          <dt>指令</dt><dd class="pre">{j.message || "（默认 heartbeat 提示）"}</dd>
        </dl>
      </Card>
      <Card title="运行历史">
        {runs?.length ? <table><thead><tr><th>时间</th><th>结果</th><th>输出</th><th>token</th><th>费用</th><th>投递</th></tr></thead>
          <tbody>{runs.map((r) => (
            <tr><td>{fmtTime(r.started)}</td><td><Badge s={r.status} /></td>
              <td class="pre clip">{r.error || r.output}</td><td>{r.tokens_in}/{r.tokens_out}</td><td>{money(r.cost)}</td><td><code>{r.delivered || "—"}</code></td></tr>))}</tbody></table>
          : <Empty>还没运行过</Empty>}
      </Card>
    </>
  );
}
