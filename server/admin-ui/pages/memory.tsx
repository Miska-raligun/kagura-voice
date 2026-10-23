// 记忆：浏览/编辑 MEMORY.md 与每日笔记；检索测试；重建索引
import { useState } from "preact/hooks";
import { api, enc, go } from "../api.ts";
import { Btn, Card, Empty, Input, Split, toast, useLoad } from "../ui.tsx";
import { AgentPicker, useAgentId } from "./common.tsx";
import { FileEditor } from "./agents.tsx";

export function Memory({ arg }: { arg: string }) {
  const agent = useAgentId(arg);
  const file = arg.split("|")[1] || "MEMORY.md";
  const [files] = useLoad(() => (agent ? api<any[]>(`/agents/${enc(agent)}/files`) : Promise.resolve([])), [agent]);
  const mem = (files ?? []).filter((f) => f.path === "MEMORY.md" || f.path.startsWith("memory/"));
  return (
    <>
      <AgentPicker page="memory" value={agent} />
      <Split left={<>
        <ul class="list">{mem.map((f) => (
          <li class={f.path === file ? "on" : ""} onClick={() => go("memory", `${agent}|${f.path}`)}>
            <b>{f.path === "MEMORY.md" ? "长期记忆" : f.path.slice(7, -3)}</b><small>{f.size} 字节</small>
          </li>))}</ul>
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
        <li><div class="muted">{h.path}#L{h.start}-{h.end} · {h.via} · {h.score}</div><div>{h.text}</div></li>))}</ol> : <Empty>没有找到</Empty>)}
    </Card>
  );
}
