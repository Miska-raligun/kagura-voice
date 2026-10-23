import { api, ago, fmtTime, go, money } from "../api.ts";
import { Badge, Card, Empty, Err, Stat, useInterval, useLoad } from "../ui.tsx";

export function Overview() {
  const [d, reload, err] = useLoad(() => api("/overview"));
  useInterval(reload, 10_000);
  if (!d) return <Err msg={err} />;
  const calls = d.agents.reduce((n: number, a: any) => n + (a.today.calls ?? 0), 0);
  const cost = d.agents.reduce((n: number, a: any) => n + (a.today.cost ?? 0), 0);
  const online = d.devices.filter((x: any) => x.last_seen_secs_ago < 200).length;
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
        <Card title="Agents">
          <table><thead><tr><th>Agent</th><th>模型</th><th>今日对话</th><th>今日费用</th></tr></thead>
            <tbody>{d.agents.map((a: any) => (
              <tr><td><a href={`#/agents/${a.id}`}>{a.name}</a> <small class="muted">{a.id}</small></td><td><code>{a.model || "未配置"}</code></td>
                <td class="mono">{a.today.calls ?? 0}</td><td class="mono">{money(a.today.cost)}</td></tr>))}</tbody></table>
        </Card>
        <Card title="设备">
          {d.devices.length ? <table><tbody>{d.devices.map((x: any) => (
            <tr><td>{x.id}</td><td><Badge s={x.last_seen_secs_ago < 200 ? "online" : "stopped"} text={x.last_seen_secs_ago < 200 ? "在线" : "离线"} /></td>
              <td class="muted">{ago(x.last_seen_secs_ago)}</td><td>{x.agent}</td></tr>))}</tbody></table> : <Empty>暂无设备</Empty>}
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
