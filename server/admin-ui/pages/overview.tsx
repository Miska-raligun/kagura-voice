import { api, ago, fmtTime, go, money } from "../api.ts";
import { Badge, Card, Empty, Err, useInterval, useLoad } from "../ui.tsx";

export function Overview() {
  const [d, reload, err] = useLoad(() => api("/overview"));
  useInterval(reload, 10_000);
  if (!d) return <Err msg={err} />;
  return (
    <div class="grid">
      {d.setup_needed && (
        <Card title="还没配置模型" class="warn">
          <p>内置 agent 需要你自己填一个模型服务商（DeepSeek、通义、Kimi、本地 Ollama 等 OpenAI 兼容接口都行）。</p>
          <button class="btn primary" onClick={() => go("settings", "wizard")}>开始设置</button>
        </Card>
      )}
      <Card title="Agents">
        <table><thead><tr><th>agent</th><th>模型</th><th>今日对话</th><th>今日费用</th></tr></thead>
          <tbody>{d.agents.map((a: any) => (
            <tr><td><a href={`#/agents/${a.id}`}>{a.name}</a> <small class="muted">{a.id}</small></td><td><code>{a.model || "未配置"}</code></td>
              <td>{a.today.calls ?? 0}</td><td>{money(a.today.cost)}</td></tr>))}</tbody></table>
      </Card>
      <Card title="设备">
        {d.devices.length ? <table><tbody>{d.devices.map((x: any) => (
          <tr><td>{x.id}</td><td><Badge s={x.last_seen_secs_ago < 200 ? "online" : "stopped"} text={x.last_seen_secs_ago < 200 ? "在线" : "离线"} /></td>
            <td class="muted">{ago(x.last_seen_secs_ago)}</td><td>→ {x.agent}</td></tr>))}</tbody></table> : <Empty>还没收到设备心跳</Empty>}
      </Card>
      <Card title="渠道">
        {d.channels.length ? <table><tbody>{d.channels.map((c: any) => (
          <tr><td>{c.name}</td><td class="muted">{c.kind}</td><td><Badge s={c.state} /></td><td class="muted">{c.detail}</td></tr>))}</tbody></table>
          : <Empty>没有接入 IM（<a href="#/channels">去添加</a>）</Empty>}
      </Card>
      <Card title="Heartbeat">
        <table><tbody>{d.heartbeats.map((h: any) => (
          <tr><td>{h.agent}</td><td>{h.enabled ? <Badge s={h.last_status || "ok"} text={h.last_status ? undefined : "已开启"} /> : <Badge s="stopped" text="关闭" />}</td>
            <td class="muted">{fmtTime(h.last_run)}</td></tr>))}</tbody></table>
      </Card>
      <Card title="最近失败的任务">
        {d.failing_jobs.length ? <table><tbody>{d.failing_jobs.map((j: any) => (
          <tr><td><a href={`#/jobs/${j.id}`}>{j.name}</a></td><td>{j.agent}</td><td class="muted">连续失败 {j.fail_count} 次</td></tr>))}</tbody></table>
          : <Empty>没有失败的任务 ✓</Empty>}
      </Card>
    </div>
  );
}
