// Agent 通信：按「会话」（一轮对话引出的一串调用）列出；点进去用动态调用图回放这一串里谁找了谁、说了什么、多久回的。
// 设置与「谁可以找谁」放在下面。路由：#/a2a、#/a2a/<会话 id>
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, enc, fmtTime, go } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Field, Input, Toggle, toast, useInterval, useLoad, usePage } from "../ui.tsx";
import { Avatar, avatarUrl } from "./common.tsx";

export function A2A({ arg }: { arg: string }) {
  const [agents] = useLoad(() => api<any[]>("/agents"));
  if (!agents) return null;
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const role = (id: string) => agents.find((a) => a.id === id)?.device_role as string | undefined;
  return arg ? <Conversation trace={arg} name={name} role={role} /> : <List agents={agents} name={name} />;
}

const secs = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} 分` : `${(ms / 1000).toFixed(1)} 秒`);
const clip = (s: string, n: number) => { const a = Array.from(String(s ?? "").replace(/\s+/g, " ").trim()); return a.length > n ? a.slice(0, n).join("") + "…" : a.join(""); };

// ── 会话列表 ──

function List({ agents, name }: { agents: any[]; name: (id: string) => string }) {
  const [list, reload, err] = useLoad(() => api<any[]>("/a2a/conversations?limit=1000"));
  useInterval(reload, 10_000);
  const [who, setWho] = useState("");
  const shown = (list ?? []).filter((c) => !who || c.agents.includes(who));
  const [rows, pager] = usePage(shown, 20);
  return (
    <>
      <Err msg={err} />
      <Card title={`会话${shown.length ? ` · ${shown.length}` : ""}`} actions={<select value={who} onChange={(e) => setWho((e.target as HTMLSelectElement).value)}>
        <option value="">全部 agent</option>{agents.map((a) => <option value={a.id}>{a.name}</option>)}</select>}>
        {rows.length ? <><table class="hover">
          <thead><tr><th>时间</th><th>谁发起</th><th>参与</th><th>调用</th><th>状态</th><th>用时</th><th>第一句</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr onClick={() => go("a2a", c.trace)}>
              <td>{fmtTime(c.ts)}</td>
              <td><span class="who"><Avatar agent={agents.find((a) => a.id === c.root.from_agent) ?? { name: c.root.from_agent }} />{name(c.root.from_agent)}</span></td>
              <td>{c.agents.map((id: string) => <span class="chip"><Avatar agent={agents.find((a) => a.id === id) ?? { name: id }} size={16} />{name(id)}</span>)}</td>
              <td>{c.calls}{c.hops > 1 ? <small class="muted"> · {c.hops} 跳</small> : null}</td>
              <td>{c.running ? <Badge s="running" text="进行中" /> : c.failed ? <Badge s="error" text={`${c.failed} 次失败`} /> : <Badge s="ok" text="完成" />}</td>
              <td>{c.last > c.ts ? secs((c.last - c.ts) * 1000) : "—"}</td>
              <td class="clip">{clip(c.root.message, 40)}</td>
            </tr>))}</tbody>
        </table>{pager}</> : <Empty>{list ? "还没有 agent 之间的通信" : "加载中…"}</Empty>}
      </Card>
      <Rules agents={agents} />
    </>
  );
}

function Rules({ agents }: { agents: any[] }) {
  const [d, reload, err] = useLoad(() => api("/a2a?limit=1"));
  if (!d) return <Err msg={err} />;
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
        <p class="muted">行 → 列：允许发送消息或派发子任务。</p>
      </Card>
    </>
  );
}

function Settings({ s, done }: { s: any; done: () => void }) {
  const [f, set] = useState({ enabled: s.enabled, max_hops: String(s.maxHops), per_pair_per_min: String(s.perPairPerMin) });
  return (
    <Card title="设置">
      <div class="form">
        <Field label="总开关" wide><Toggle checked={f.enabled} onChange={(v) => set({ ...f, enabled: v })} label="启用" /></Field>
        <Field label="最大跳数" hint="A→B→C 为 2 跳"><Input type="number" value={f.max_hops} onInput={(v) => set({ ...f, max_hops: v })} /></Field>
        <Field label="每对每分钟上限"><Input type="number" value={f.per_pair_per_min} onInput={(v) => set({ ...f, per_pair_per_min: v })} /></Field>
      </div>
      <Btn kind="primary" onClick={async () => {
        await api("/a2a/settings", { method: "PUT", body: { enabled: f.enabled, max_hops: Number(f.max_hops), per_pair_per_min: Number(f.per_pair_per_min) } });
        await api("/config", { method: "PUT", body: { a2a: { enabled: f.enabled, max_hops: Number(f.max_hops), per_pair_per_min: Number(f.per_pair_per_min) } } });
        toast("已保存"); done();
      }}>保存</Btn>
    </Card>
  );
}

// ── 一个会话：动态调用图 + 步骤 ──

interface Node { id: string; agent: string; session: string; label: string; sub: boolean; x: number; y: number }
/** 回放的一步：一次调用的发出（go）或回来（back） */
interface Step { call: any; dir: "go" | "back"; t: number; from: string; to: string }

/** 节点：每个 agent 一个；子任务的会话单独一个（「小澪 · 子任务」） */
const nodeOf = (agent: string, session: string) => (session.includes(":sub:") ? `${agent}|${session}` : agent);

function buildGraph(calls: any[], name: (id: string) => string, W: number, H: number) {
  const order: Node[] = [];
  const add = (agent: string, session: string) => {
    const id = nodeOf(agent, session);
    if (!order.some((n) => n.id === id)) {
      const sub = session.includes(":sub:");
      order.push({ id, agent, session, sub, label: sub ? `${name(agent)} · 子任务` : name(agent), x: 0, y: 0 });
    }
    return id;
  };
  const steps: Step[] = [];
  for (const c of calls) {
    const from = add(c.from_agent, c.from_session);
    const to = c.to_session ? add(c.to_agent, c.to_session) : add(c.to_agent, `${c.to_agent}:main`);
    steps.push({ call: c, dir: "go", t: c.ts, from, to });
    if (c.status !== "running") steps.push({ call: c, dir: "back", t: c.ts + (c.ms || 0) / 1000, from: to, to: from });
  }
  steps.sort((a, b) => a.t - b.t || a.call.id - b.call.id || (a.dir === "go" ? -1 : 1));
  // 发起方放最左，其余按出场顺序沿右侧的弧排开；只有两个节点就左右各一
  const cx = W / 2, cy = H / 2, rx = W / 2 - 110, ry = H / 2 - 60;
  order.forEach((n, i) => {
    if (i === 0) { n.x = cx - rx; n.y = cy; return; }
    const k = order.length - 1;
    const a = k === 1 ? 0 : -Math.PI * 0.62 + (Math.PI * 1.24 * (i - 1)) / (k - 1);
    n.x = cx + rx * Math.cos(a) * (k === 1 ? 1 : 0.95) + (k === 1 ? 0 : rx * 0.05);
    n.y = cy + ry * Math.sin(a);
  });
  return { nodes: order, steps };
}

/** 两点之间的弧线：往行进方向的左侧弯，来回两条自然分开 */
function curve(a: Node, b: Node) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const off = Math.min(60, len * 0.18);
  const c = { x: mx + (-dy / len) * off, y: my + (dx / len) * off };
  const R = 30;                                      // 节点半径：线从圆边出发、到圆边结束
  const p0 = { x: a.x + ((c.x - a.x) / Math.hypot(c.x - a.x, c.y - a.y)) * R, y: a.y + ((c.y - a.y) / Math.hypot(c.x - a.x, c.y - a.y)) * R };
  const p2 = { x: b.x + ((c.x - b.x) / Math.hypot(c.x - b.x, c.y - b.y)) * R, y: b.y + ((c.y - b.y) / Math.hypot(c.x - b.x, c.y - b.y)) * R };
  const at = (t: number) => ({ x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * c.x + t * t * p2.x, y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * c.y + t * t * p2.y });
  return { d: `M${p0.x},${p0.y} Q${c.x},${c.y} ${p2.x},${p2.y}`, at, mid: at(0.5) };
}

const KIND: Record<string, string> = { send: "发消息", spawn: "派子任务" };
const bad = (c: any) => c.status === "error" || c.status === "rejected";

/** 回放进度：0..n（整数 = 第几步刚完成）。playing 时按 speed 往前走；n 变大（实时来了新步骤）且已追到末尾就接着播 */
function usePlayback(n: number, autoplay = true) {
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(autoplay);
  const [speed, setSpeed] = useState(1);
  const raf = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last; last = now;
      setPos((p) => {
        const q = Math.min(n, p + (dt / 1300) * speed);
        if (q >= n) setPlaying(false);
        return q;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, n]);
  const prevN = useRef(n);
  useEffect(() => { if (n > prevN.current && pos >= prevN.current - 0.01) setPlaying(true); prevN.current = n; }, [n]);
  return { pos, setPos, playing, setPlaying, speed, setSpeed, n };
}
type Playback = ReturnType<typeof usePlayback>;

/** 拉一串调用；有还没回来的就每秒刷新（实时） */
export function useConversation(trace: string, keepPolling = false) {
  const [d, reload, err] = useLoad(() => api<any>(`/a2a/conversations/${enc(trace)}`), [trace]);
  const calls: any[] = d?.calls ?? [];
  const running = calls.some((c) => c.status === "running");
  useInterval(() => { if (running || keepPolling) reload(); }, 1000);
  return { d, calls, running, err };
}

const W = 860, H = 380;

/** 调用图 + 播放条 */
function A2AGraph({ g, pb, name, role, compact }: { g: ReturnType<typeof buildGraph> & { w: number; h: number }; pb: Playback; name: (id: string) => string; role: (id: string) => string | undefined; compact?: boolean }) {
  const [noAvatar, setNoAvatar] = useState<Record<string, boolean>>({});
  const { pos, n } = pb;
  const byId = new Map(g.nodes.map((x) => [x.id, x]));
  const cur = Math.min(n - 1, Math.floor(pos));
  const frac = pos - Math.floor(pos);
  const done = (i: number) => i < pos;           // 这一步已经开始（含正在走的）
  // 有调用进来还没回 = 在处理
  const busy = new Set<string>();
  g.steps.forEach((s, i) => {
    if (s.dir !== "go" || !done(i)) return;
    const backIdx = g.steps.findIndex((x) => x.call === s.call && x.dir === "back");
    if (backIdx < 0 || backIdx >= pos) busy.add(s.to);
  });
  const uid = compact ? "d" : "p";
  return (
    <>
      <svg viewBox={`0 0 ${g.w} ${g.h}`} class="graph">
        <defs>
          <marker id={`arr-${uid}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor" /></marker>
        </defs>
        {g.steps.map((s, i) => {
          if (!done(i)) return null;
          const a = byId.get(s.from)!, b = byId.get(s.to)!;
          const cv = curve(a, b);
          const active = i === cur && frac < 1 && pos < n;
          const cls = `edge ${s.dir} ${bad(s.call) && s.dir === "back" ? "bad" : ""} ${active ? "active" : ""} ${i === cur ? "current" : ""}`;
          return <g class={cls}>
            <path d={cv.d} marker-end={`url(#arr-${uid})`} />
            {active && (() => { const p = cv.at(frac); return <circle class="pulse" cx={p.x} cy={p.y} r="6" />; })()}
            {i === cur && <text x={cv.mid.x} y={cv.mid.y - 8} text-anchor="middle" class="elabel">
              {s.dir === "go" ? `${KIND[s.call.kind] ?? s.call.kind}：${clip(s.call.message, 18)}` : bad(s.call) ? `失败：${clip(s.call.reply, 18)}` : `${s.call.kind === "spawn" ? "结果" : "回复"}：${clip(s.call.reply, 18)}`}
            </text>}
          </g>;
        })}
        {g.nodes.map((x, i) => (
          <g class={`node ${busy.has(x.id) ? "busy" : ""} ${i === 0 ? "root" : ""} ${x.sub ? "sub" : ""}`} transform={`translate(${x.x},${x.y})`}
            onClick={() => go("sessions", `${x.agent}|${x.sub ? x.session : x.agent + ":main"}`)}>
            <title>打开 {x.label} 的会话</title>
            {busy.has(x.id) && <circle class="ring" r="30" />}
            <circle class="dot" r="30" />
            {role(x.agent) !== undefined && !noAvatar[x.agent]
              ? <>
                <clipPath id={`av-${uid}-${i}`}><circle r="27" /></clipPath>
                <image href={avatarUrl(role(x.agent)!)} x="-27" y="-27" width="54" height="54" preserveAspectRatio="xMidYMin slice" clip-path={`url(#av-${uid}-${i})`}
                  class={x.sub ? "subav" : ""} onError={() => setNoAvatar((m) => ({ ...m, [x.agent]: true }))} />
              </>
              : <text class="ini" text-anchor="middle" dy="6">{Array.from(name(x.agent))[0]}</text>}
            <text class="name" text-anchor="middle" y="50">{x.label}</text>
            {busy.has(x.id) && <text class="state" text-anchor="middle" y="66">处理中…</text>}
          </g>
        ))}
      </svg>
      <div class="player">
        <Btn small onClick={() => { if (pos >= n) pb.setPos(0); pb.setPlaying(!pb.playing); }}>{pb.playing ? "⏸ 暂停" : pos >= n ? "⟲ 重播" : "▶ 播放"}</Btn>
        <input type="range" min="0" max={n} step="0.01" value={pos} onInput={(e) => { pb.setPlaying(false); pb.setPos(Number((e.target as HTMLInputElement).value)); }} />
        <span class="muted">{Math.min(n, Math.ceil(pos))} / {n}</span>
        {!compact && <select value={pb.speed} onChange={(e) => pb.setSpeed(Number((e.target as HTMLSelectElement).value))}>
          {[0.5, 1, 2, 4].map((v) => <option value={v}>{v}×</option>)}
        </select>}
      </div>
    </>
  );
}

/** 步骤列表：和动画同步高亮，点一步跳过去 */
function Steps({ g, pb, limit }: { g: ReturnType<typeof buildGraph>; pb: Playback; limit?: number }) {
  const byId = new Map(g.nodes.map((x) => [x.id, x]));
  const cur = Math.min(pb.n - 1, Math.floor(pb.pos));
  const list = g.steps.map((s, i) => ({ s, i }));
  const shown = limit ? list.slice(Math.max(0, Math.min(list.length - limit, cur - 1)), Math.max(0, Math.min(list.length - limit, cur - 1)) + limit) : list;
  return (
    <ol class="steps">{shown.map(({ s, i }) => {
      const a = byId.get(s.from)!, b = byId.get(s.to)!;
      const text = s.dir === "go" ? s.call.message : s.call.reply;
      const what = s.dir === "go" ? KIND[s.call.kind] ?? s.call.kind : bad(s.call) ? (s.call.status === "rejected" ? "被拒绝" : "失败") : s.call.kind === "spawn" ? "交回结果" : "回复";
      return (
        <li data-n={i + 1} class={`${i === cur && pb.pos < pb.n ? "on" : ""} ${i < pb.pos ? "" : "later"} ${bad(s.call) && s.dir === "back" ? "bad" : ""}`} onClick={() => { pb.setPlaying(false); pb.setPos(i + 0.999); }}>
          <div class="head">
            <b>{a.label}</b> → <b>{b.label}</b> <span class="what">{what}</span>
            <small class="muted">{new Date(s.t * 1000).toLocaleTimeString("zh-CN", { hour12: false })}{s.dir === "back" && s.call.ms ? ` · 用时 ${secs(s.call.ms)}` : ""}{s.dir === "go" && s.call.hop > 1 ? ` · 第 ${s.call.hop} 跳` : ""}</small>
          </div>
          {text ? (limit ? <div class="muted small">{clip(text, 60)}</div> : <details><summary>{clip(text, 80)}</summary><div class="pre">{text}</div></details>)
            : <div class="muted small">（{s.call.status === "running" ? "还没回来" : "没有内容"}）</div>}
        </li>
      );
    })}</ol>
  );
}

function Conversation({ trace, name, role }: { trace: string; name: (id: string) => string; role: (id: string) => string | undefined }) {
  const { d, calls, running, err } = useConversation(trace);
  const g = useMemo(() => ({ ...buildGraph(calls, name, W, H), w: W, h: H }), [JSON.stringify(calls.map((c) => [c.id, c.status, c.ms]))]);
  const pb = usePlayback(g.steps.length);
  if (!d) return <Err msg={err} />;
  if (!calls.length) return <Card title="Agent 通信"><Empty>没有这个会话</Empty><Btn onClick={() => go("a2a")}>← 返回</Btn></Card>;
  const first = calls[0], lastT = Math.max(...g.steps.map((s) => s.t));
  const failed = calls.filter(bad).length;
  return (
    <>
      <div class="titlebar"><h3>Agent 通信 <small class="muted">{fmtTime(first.ts)} · {calls.length} 次调用 · {secs((lastT - first.ts) * 1000)}{failed ? ` · ${failed} 次失败` : ""}{running ? " · 进行中" : ""}</small></h3>
        <div class="actions"><Btn kind="ghost" onClick={() => go("a2a")}>← 返回</Btn></div></div>
      <Card class="a2agraph"><A2AGraph g={g} pb={pb} name={name} role={role} /></Card>
      <Card title="经过"><Steps g={g} pb={pb} /></Card>
    </>
  );
}

/**
 * 会话页底部弹出的实时 Agent 通信：这一轮她找了别的 agent / 派了子任务，就从下面滑出来，每秒刷新、新步骤接着播。
 * live = 发起的那一轮还在跑（跑完了也留着，等主人关）
 */
export function A2ADock({ trace, live, onClose, onSmall }: { trace: string; live: boolean; onClose: () => void; onSmall?: (v: boolean) => void }) {
  const [agents] = useLoad(() => api<any[]>("/agents"));
  const { calls, running } = useConversation(trace, live);
  const name = (id: string) => agents?.find((a) => a.id === id)?.name ?? id;
  const role = (id: string) => agents?.find((a) => a.id === id)?.device_role as string | undefined;
  // 会话页里地方小：画布也小一点，节点和字看起来就大
  const g = useMemo(() => ({ ...buildGraph(calls, name, 600, 300), w: 600, h: 300 }), [JSON.stringify(calls.map((c) => [c.id, c.status, c.ms])), !!agents]);
  const pb = usePlayback(g.steps.length);
  const [small, setSmall] = useState(false);
  if (!calls.length) return null;
  return (
    <div class={`a2adock ${small ? "small" : ""}`}>
      <div class="dockbar">
        <b>Agent 通信</b>
        <small class="muted">{calls.length} 次调用{running || live ? " · 进行中" : " · 已结束"}</small>
        <span class="grow" />
        <Btn small kind="ghost" onClick={() => go("a2a", trace)}>打开详情</Btn>
        <Btn small kind="ghost" onClick={() => { setSmall(!small); onSmall?.(!small); }}>{small ? "展开" : "收起"}</Btn>
        <Btn small kind="ghost" onClick={onClose}>✕</Btn>
      </div>
      {!small && <div class="dockbody">
        <div class="dockgraph"><A2AGraph g={g} pb={pb} name={name} role={role} compact /></div>
        <div class="docksteps"><Steps g={g} pb={pb} limit={6} /></div>
      </div>}
    </div>
  );
}
