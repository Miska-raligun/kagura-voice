// 记忆：浏览/编辑 MEMORY.md 与每日笔记；检索测试；重建索引
import { useState } from "preact/hooks";
import { api, enc, go } from "../api.ts";
import { Btn, Card, Empty, Input, SideList, Split, toast, useLoad } from "../ui.tsx";
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
