// 用量：按 agent / 天的 token 与费用；本月预估
import { useState } from "preact/hooks";
import { api, money } from "../api.ts";
import { Card, Empty, Err, Select, useLoad } from "../ui.tsx";

const COLORS = ["#7c6cf0", "#e0789b", "#3fb8a5", "#e3a33b", "#5b9be8", "#a0a0a0"];

export function Usage() {
  const [days, setDays] = useState("30");
  const [d, , err] = useLoad(() => api<any[]>(`/usage?days=${days}`), [days]);
  if (!d) return <Err msg={err} />;
  const allDays = [...new Set(d.flatMap((a) => a.days.map((x: any) => x.day)))].sort() as string[];
  const cost = (a: any, day: string) => a.days.find((x: any) => x.day === day)?.cost ?? 0;
  const max = Math.max(1e-9, ...allDays.map((day) => d.reduce((s, a) => s + cost(a, day), 0)));
  const month = new Date().toISOString().slice(0, 7);
  const monthCost = d.reduce((s, a) => s + a.days.filter((x: any) => x.day.startsWith(month)).reduce((t: number, x: any) => t + (x.cost ?? 0), 0), 0);
  const dayOfMonth = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const W = 640, H = 160, bw = allDays.length ? W / allDays.length : W;
  return (
    <>
      <div class="row"><Select value={days} onChange={setDays} options={[["7", "最近 7 天"], ["30", "最近 30 天"], ["90", "最近 90 天"]]} /></div>
      <div class="grid">
        <Card title="本月"><div class="big">{money(monthCost)}</div><div class="muted">预计整月 {money(monthCost / dayOfMonth * daysInMonth)}</div></Card>
        <Card title="说明"><p class="muted">按设置中的模型单价（每百万 token）计算。</p></Card>
      </div>
      <Card title="每天费用">
        {allDays.length ? <>
          <svg viewBox={`0 0 ${W} ${H + 20}`} class="chart">
            {allDays.map((day, i) => {
              let y = H;
              return <g>{d.map((a, k) => { const h = (cost(a, day) / max) * H; y -= h; return <rect x={i * bw + 1} y={y} width={Math.max(1, bw - 2)} height={h} fill={COLORS[k % COLORS.length]}><title>{a.name} {day} {money(cost(a, day))}</title></rect>; })}
                {(allDays.length <= 15 || i % 5 === 0) && <text x={i * bw + bw / 2} y={H + 14} text-anchor="middle">{day.slice(5)}</text>}</g>;
            })}
          </svg>
          <div class="legend">{d.map((a, k) => <span><i style={{ background: COLORS[k % COLORS.length] }} />{a.name}</span>)}</div>
        </> : <Empty>无调用</Empty>}
      </Card>
      <Card title="按 agent 汇总">
        <table><thead><tr><th>agent</th><th>调用</th><th>输入 token</th><th>输出 token</th><th>缓存命中</th><th>费用</th></tr></thead>
          <tbody>{d.map((a) => {
            const s = a.days.reduce((t: any, x: any) => ({ calls: t.calls + x.calls, input: t.input + (x.input ?? 0), output: t.output + (x.output ?? 0), cache: t.cache + (x.cache_read ?? 0), cost: t.cost + (x.cost ?? 0) }), { calls: 0, input: 0, output: 0, cache: 0, cost: 0 });
            return <tr><td>{a.name}</td><td>{s.calls}</td><td>{s.input.toLocaleString()}</td><td>{s.output.toLocaleString()}</td><td>{s.cache.toLocaleString()}</td><td>{money(s.cost)}</td></tr>;
          })}</tbody></table>
      </Card>
    </>
  );
}
