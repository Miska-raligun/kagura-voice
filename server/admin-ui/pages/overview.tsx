import { api, ago, fmtTime, go, money } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Stat, toast, useInterval, useLoad } from "../ui.tsx";
import { HealthCard } from "./health.tsx";

const PURPOSE: Record<string, string> = { chat: "对话", heartbeat: "heartbeat", cron: "定时任务", a2a: "agent 间", spawn: "子任务", flush: "记忆整理" };
const CHANNEL: Record<string, string> = { device: "设备 / 手机", webchat: "网页", a2a: "agent 间", system: "系统", feishu: "飞书", qq: "QQ" };

/** 正在运行的轮次：看是谁占着会话，卡住了可以手动终止 */
function Runs(p: { runs: any[]; reload: () => void }) {
  if (!p.runs.length) return <Empty>没有正在运行的任务</Empty>;
  const kill = async (r: any) => {
    if (!confirm(`终止 ${r.agent} 的这一轮（${PURPOSE[r.purpose] ?? r.purpose}，已运行 ${ago(r.secs).replace("前", "")}）？\n正在执行的工具会被中止，后面排队的消息会接着处理。`)) return;
    await api("/runs/cancel", { body: { key: r.key } });
    toast("已终止");
    setTimeout(p.reload, 2500);
  };
  return (
    <table><thead><tr><th>Agent / 会话</th><th>在做什么</th><th>已运行</th><th>排队</th><th></th></tr></thead>
      <tbody>{p.runs.map((r) => (
        <tr>
          <td><a href={`#/agents/${r.agent}`}>{r.agent}</a> <small class="muted">{r.session}</small></td>
          <td>{PURPOSE[r.purpose] ?? r.purpose} · <span class="muted">{CHANNEL[r.channel] ?? r.channel}</span><br />
            <small class="muted">{r.stage}{r.tool ? `：${r.tool}` : ""}{r.waiting_for ? ` · 在等 ${r.waiting_for}` : ""}</small></td>
          <td>{r.secs >= 120 ? <Badge s="error" text={ago(r.secs).replace("前", "")} /> : <span class="mono">{r.secs} 秒</span>}</td>
          <td class="mono">{r.queued ? <Badge s="running" text={`${r.queued} 条`} /> : "—"}</td>
          <td>{r.cancelling ? <small class="muted">正在终止…</small> : <Btn small kind="danger" onClick={() => kill(r)}>终止</Btn>}</td>
        </tr>))}</tbody></table>
  );
}

export function Overview() {
  const [d, reload, err] = useLoad(() => api("/overview"));
  useInterval(reload, 5_000);
  if (!d) return <Err msg={err} />;
  const calls = d.agents.reduce((n: number, a: any) => n + (a.today.calls ?? 0), 0);
  const cost = d.agents.reduce((n: number, a: any) => n + (a.today.cost ?? 0), 0);
  const online = d.devices.filter((x: any) => x.online).length;
  const chOk = d.channels.filter((c: any) => c.state === "online").length;
  return (
    <>
      {d.update?.newer && (
        <Card title={`新版本 ${d.update.latest}`} class="warn">
          <p class="muted">当前 {d.update.current}，数据和设置在更新后保留。</p>
          {d.update.notes ? <details><summary class="muted">更新内容</summary><pre>{d.update.notes}</pre></details> : null}
          <div class="row"><button class="btn primary" onClick={() => go("settings", "update")}>更新</button><a href={d.update.url} target="_blank">发布页 ↗</a></div>
        </Card>
      )}
      {d.setup_needed && (
        <Card title="未配置模型" class="warn">
          <p class="muted">内置 agent 需要一个 OpenAI 兼容的模型服务商。</p>
          <button class="btn primary" onClick={() => go("settings", "wizard")}>开始设置</button>
        </Card>
      )}
      <div class="stats">
        <Stat label="Agents" value={d.agents.length} />
        <Stat label="今日对话" value={calls} />
        <Stat label="今日费用" value={money(cost)} />
        <Stat label="设备在线" value={`${online}/${d.devices.length}`} />
        <Stat label="渠道在线" value={`${chOk}/${d.channels.length}`} />
      </div>
      <div class="grid">
        <HealthCard />
        <Card title={`正在运行${d.runs?.length ? `（${d.runs.length}）` : ""}`}>
          <Runs runs={d.runs ?? []} reload={reload} />
        </Card>
        <Card title="Agents">
          <table><thead><tr><th>Agent</th><th>模型</th><th>今日对话</th><th>今日费用</th></tr></thead>
            <tbody>{d.agents.map((a: any) => (
              <tr><td><a href={`#/agents/${a.id}`}>{a.name}</a> <small class="muted">{a.id}</small></td><td><code>{a.model || "未配置"}</code></td>
                <td class="mono">{a.today.calls ?? 0}</td><td class="mono">{money(a.today.cost)}</td></tr>))}</tbody></table>
        </Card>
        <Card title="设备">
          {d.devices.length ? <table><tbody>{d.devices.map((x: any) => (
            <tr><td>{x.kind === "phone" ? <>📱 {x.name} <small class="muted">{x.id}</small></> : x.id}</td>
              <td><Badge s={x.online ? "online" : "stopped"} text={x.online ? "在线" : x.kind === "phone" ? "页面没开" : "离线"} /></td>
              <td class="muted">{x.secs_ago == null ? "" : ago(x.secs_ago)}</td><td>{x.agent}</td></tr>))}</tbody></table> : <Empty>暂无设备</Empty>}
        </Card>
        <Card title="渠道">
          {d.channels.length ? <table><tbody>{d.channels.map((c: any) => (
            <tr><td>{c.name}</td><td class="muted">{c.kind}</td><td><Badge s={c.state} /></td><td class="muted">{c.detail}</td></tr>))}</tbody></table>
            : <Empty>未接入 IM · <a href="#/channels">添加</a></Empty>}
        </Card>
        <Card title="Heartbeat">
          <table><tbody>{d.heartbeats.map((h: any) => (
            <tr><td>{h.agent}</td><td>{h.enabled ? <Badge s={h.last_status || "ok"} text={h.last_status ? undefined : "已开启"} /> : <Badge s="stopped" text="关闭" />}</td>
              <td class="muted">{fmtTime(h.last_run)}</td></tr>))}</tbody></table>
        </Card>
        <Card title="失败的任务">
          {d.failing_jobs.length ? <table><tbody>{d.failing_jobs.map((j: any) => (
            <tr><td><a href={`#/jobs/${j.id}`}>{j.name}</a></td><td>{j.agent}</td><td class="muted">连续失败 {j.fail_count} 次</td></tr>))}</tbody></table>
            : <Empty>无</Empty>}
        </Card>
      </div>
    </>
  );
}
