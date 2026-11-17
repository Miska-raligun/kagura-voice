// 记忆：浏览/编辑 MEMORY.md 与每日笔记；检索测试；重建索引
import { useState } from "preact/hooks";
import { api, enc, go } from "../api.ts";
import { Btn, Card, Empty, Input, SideList, Split, toast, toastErr, useLoad } from "../ui.tsx";
import { AgentPicker, useAgentId } from "./common.tsx";
import { FileEditor } from "./agents.tsx";

/** 长期记忆置顶；每日笔记按月分组，新的在前，只展开最近一个月 */
function memGroups(mem: any[]) {
  const notes = mem.filter((f) => f.path !== "MEMORY.md").sort((a, b) => (a.path < b.path ? 1 : -1));
  const months = new Map<string, any[]>();
  for (const f of notes) {
    const m = /^memory\/(\d{4}-\d{2})/.exec(f.path)?.[1] ?? "其它";
    months.set(m, [...(months.get(m) ?? []), f]);
  }
  return [
    { id: "long", items: mem.filter((f) => f.path === "MEMORY.md") },
    ...[...months].map(([m, items], i) => ({ id: m, title: m === "其它" ? "其它笔记" : `${m} 的笔记`, items, collapsed: i > 0 })),
  ];
}

export function Memory({ arg }: { arg: string }) {
  const agent = useAgentId(arg);
  const file = arg.split("|")[1] || "MEMORY.md";
  const [files] = useLoad(() => (agent ? api<any[]>(`/agents/${enc(agent)}/files`) : Promise.resolve([])), [agent]);
  const mem = (files ?? []).filter((f) => f.path === "MEMORY.md" || f.path.startsWith("memory/"));
  return (
    <>
      <AgentPicker page="memory" value={agent} />
      <Split left={<>
        <SideList groups={memGroups(mem)} placeholder="搜索日期，如 2026-10" initial={15}
          match={(f: any, q) => f.path.toLowerCase().includes(q)}
          render={(f: any) => (
            <li class={`${f.path === file ? "on" : ""} ${f.path === "MEMORY.md" ? "" : "inline"}`} onClick={() => go("memory", `${agent}|${f.path}`)}>
              <b>{f.path === "MEMORY.md" ? "长期记忆" : f.path.slice(7, -3)}</b><small>{f.size} 字节</small>
            </li>)} />
        <NewNote agent={agent} />
      </>}>
        <Search agent={agent} />
        {agent && <RecallEval key={agent} agent={agent} />}
        {agent && <Card title={file}><FileEditor key={agent + file} id={agent} path={file} /></Card>}
      </Split>
    </>
  );
}

function NewNote({ agent }: { agent: string }) {
  const today = new Date().toLocaleDateString("sv-SE");
  return <Btn small onClick={() => go("memory", `${agent}|memory/${today}.md`)}>今天的笔记</Btn>;
}

function Search({ agent }: { agent: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<any[] | null>(null);
  const run = async () => setHits(await api(`/agents/${enc(agent)}/memory/search`, { body: { query: q } }));
  return (
    <Card title="检索测试" actions={<Btn small onClick={async () => { const r = await api(`/agents/${enc(agent)}/memory/reindex`, { body: {} }); toast(`已重建（${r.changed} 个文件）`); }}>重建索引</Btn>}>
      <div class="row"><Input value={q} onInput={setQ} placeholder="输入一句话，看 memory_search 会搜出什么" /><Btn kind="primary" onClick={run} disabled={!q}>搜索</Btn></div>
      {hits && (hits.length ? <ol class="hits">{hits.map((h) => (
        <li><div class="muted">{h.path}#L{h.start}-{h.end} · {h.via} · {h.score}</div><div>{h.text}</div></li>))}</ol> : <Empty>无结果</Empty>)}
    </Card>
  );
}

/**
 * 自动回忆的评测：主人的一句话 → 应该附上哪条记忆（填记忆里的一小段原文；空 = 不该附任何记忆）。
 * 改检索之前先跑一遍记下分数。候选是从会话里挖的「她自己去翻记忆」的那几轮——多半是自动回忆漏了
 */
function RecallEval({ agent }: { agent: string }) {
  const [d, reload] = useLoad(() => api<any>(`/agents/${enc(agent)}/recall-eval`), [agent]);
  const [cases, setCases] = useState<any[] | null>(null);
  const [res, setRes] = useState<any>(null);
  const list: any[] = cases ?? d?.cases ?? [];
  const edit = (i: number, k: string, v: string) => setCases(list.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const save = async () => { try { await api(`/agents/${enc(agent)}/recall-eval`, { method: "PUT", body: { cases: list } }); toast("已保存"); setCases(null); reload(); } catch (e) { toastErr(e); } };
  const run = async () => { try { setRes(await api(`/agents/${enc(agent)}/recall-eval/run`, { body: { cases: list } })); } catch (e) { toastErr(e); } };
  const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
  const byQ = new Map<string, any>((res?.results ?? []).map((r: any) => [r.q + "\u0000" + (r.context ?? ""), r]));
  const st = d?.stats;
  return (
    <Card title="自动回忆评测" actions={<>
      <Btn small onClick={() => setCases([...list, { q: "", expect: "" }])}>＋ 用例</Btn>
      {cases && <Btn small onClick={save}>保存</Btn>}
      <Btn small kind="primary" onClick={run} disabled={!list.length}>跑一遍</Btn>
    </>}>
      {res && <p><b>{res.summary.passed}/{res.summary.total}</b> 通过　该附的附上了 {pct(res.summary.recall)}　不该附的没乱附 {pct(res.summary.quiet)}</p>}
      {list.length ? <div class="evals">
        <div class="ev head"><span>主人说</span><span>前文（可选）</span><span>应该附上（记忆原文的一段，空 = 不该附）</span><span /></div>
        {list.map((c, i) => {
          const r = byQ.get(c.q + "\u0000" + (c.context ?? ""));
          return <div class="ev">
            <Input value={c.q} onInput={(v) => edit(i, "q", v)} />
            <Input value={c.context ?? ""} onInput={(v) => edit(i, "context", v)} />
            <Input value={c.expect} onInput={(v) => edit(i, "expect", v)} />
            <Btn small kind="ghost" onClick={() => setCases(list.filter((_, j) => j !== i))}>✕</Btn>
            {r && <small class={r.ok ? "ok" : "bad"}>{r.ok ? "✓" : "✗"} {r.hits.length ? `附了：${r.hits.join(" / ")}` : "没附"}</small>}
          </div>;
        })}
      </div> : <Empty>还没有用例：从下面的候选里加，或者点「＋ 用例」</Empty>}
      {!!d?.candidates?.length && <details><summary class="muted">候选：她自己去翻了记忆的 {d.candidates.length} 轮（多半是自动回忆漏了）</summary>
        <ol class="hits">{d.candidates.map((c: any) => (
          <li><div>{c.q} <Btn small kind="ghost" onClick={() => setCases([...list, { q: c.q, context: c.context, expect: "" }])}>加为用例</Btn></div>
            <div class="muted">她搜了：{c.searched.join("、")}{c.attached.length ? `；当时附了：${c.attached.join(" / ")}` : "；当时没附"}</div></li>))}</ol>
      </details>}
      {st && <details><summary class="muted">使用情况：{st.items} 条记忆被附上过，共 {st.recalled} 次，用上 {st.used} 次{st.stale.length ? `；${st.stale.length} 条老附却没用上（已降权）` : ""}</summary>
        {st.stale.length ? <ol class="hits">{st.stale.map((x: any) => <li>{x.text} <span class="muted">附了 {x.recalled} 次</span></li>)}</ol> : null}
      </details>}
    </Card>
  );
}
