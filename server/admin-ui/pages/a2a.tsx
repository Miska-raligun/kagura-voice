// Agent 通信：开关与上限、谁可以找谁的矩阵、调用记录
import { useState } from "preact/hooks";
import { api, fmtTime } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Field, Input, Toggle, toast, useInterval, useLoad } from "../ui.tsx";

export function A2A() {
  const [d, reload, err] = useLoad(() => api("/a2a"));
  const [agents] = useLoad(() => api<any[]>("/agents"));
  useInterval(reload, 10_000);
  if (!d || !agents) return <Err msg={err} />;
  const allow = new Map<string, string[]>(d.matrix.map((m: any) => [m.from, m.allow]));
  const toggle = async (from: string, to: string, v: boolean) => { await api("/a2a/allow", { method: "PUT", body: { from, to, allow: v } }); reload(); };
  return (
    <>
      <Settings s={d.settings} done={reload} />
      <Card title="谁可以找谁（行 → 列）">
        <table class="matrix"><thead><tr><th></th>{agents.map((a) => <th>{a.name}</th>)}</tr></thead>
          <tbody>{agents.map((f) => (
            <tr><th>{f.name}</th>{agents.map((t) => (
              <td>{f.id === t.id ? "—" : <input type="checkbox" checked={(allow.get(f.id) ?? []).includes("*") || (allow.get(f.id) ?? []).includes(t.id)}
                disabled={(allow.get(f.id) ?? []).includes("*")} onChange={(e) => toggle(f.id, t.id, (e.target as HTMLInputElement).checked)} />}</td>))}</tr>))}</tbody></table>
        <p class="muted">打勾 = 行里的 agent 可以给列里的 agent 发消息（sessions_send）或派子任务（sessions_spawn）。</p>
      </Card>
      <Card title="调用记录">
        {d.log.length ? <table><thead><tr><th>时间</th><th>类型</th><th>谁 → 谁</th><th>内容</th><th>回复</th><th>结果</th><th>耗时</th></tr></thead>
          <tbody>{d.log.map((l: any) => (
            <tr><td>{fmtTime(l.ts)}</td><td>{l.kind === "send" ? "发消息" : "子任务"}</td><td>{l.from_agent} → {l.to_agent} <small class="muted">{l.hop} 跳</small></td>
              <td class="clip">{l.message}</td><td class="clip">{l.reply}</td><td><Badge s={l.status} /></td><td>{l.ms ? `${(l.ms / 1000).toFixed(1)}s` : "—"}</td></tr>))}</tbody></table>
          : <Empty>还没有 agent 之间的调用</Empty>}
      </Card>
    </>
  );
}

function Settings({ s, done }: { s: any; done: () => void }) {
  const [f, set] = useState({ enabled: s.enabled, max_hops: String(s.maxHops), per_pair_per_min: String(s.perPairPerMin) });
  return (
    <Card title="设置">
      <div class="form">
        <Field label="总开关" wide><Toggle checked={f.enabled} onChange={(v) => set({ ...f, enabled: v })} label="允许 agent 之间通信" /></Field>
        <Field label="最多转几手" hint="A→B→C 算 2 跳，超过就拒绝，防止互相踢皮球"><Input type="number" value={f.max_hops} onInput={(v) => set({ ...f, max_hops: v })} /></Field>
        <Field label="同一对 agent 每分钟最多" hint="防止两个 agent 聊起来停不下（很费钱）"><Input type="number" value={f.per_pair_per_min} onInput={(v) => set({ ...f, per_pair_per_min: v })} /></Field>
      </div>
      <Btn kind="primary" onClick={async () => {
        await api("/a2a/settings", { method: "PUT", body: { enabled: f.enabled, max_hops: Number(f.max_hops), per_pair_per_min: Number(f.per_pair_per_min) } });
        await api("/config", { method: "PUT", body: { a2a: { enabled: f.enabled, max_hops: Number(f.max_hops), per_pair_per_min: Number(f.per_pair_per_min) } } });
        toast("已保存"); done();
      }}>保存</Btn>
    </Card>
  );
}
