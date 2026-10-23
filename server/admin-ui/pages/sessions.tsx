// 会话：按 agent 浏览会话与完整对话（含工具调用）；重置、手动压缩、导出
import { api, download, enc, fmtTime, go } from "../api.ts";
import { Btn, Card, Empty, Err, Split, confirmDo, toast, useLoad } from "../ui.tsx";
import { AgentPicker, Message, useAgentId } from "./common.tsx";

export function Sessions({ arg }: { arg: string }) {
  const agent = useAgentId(arg);
  const key = arg.split("|")[1] ?? "";
  const [list, reload, err] = useLoad(() => (agent ? api<any[]>(`/agents/${enc(agent)}/sessions`) : Promise.resolve([])), [agent]);
  return (
    <>
      <AgentPicker page="sessions" value={agent} />
      <Split left={<>
        <Err msg={err} />
        {list?.length ? <ul class="list">{list.map((s) => (
          <li class={s.key === key ? "on" : ""} onClick={() => go("sessions", `${agent}|${s.key}`)}>
            <b>{s.key.slice(agent.length + 1)}</b><small>{s.channel} · {s.messages} 条 · {fmtTime(s.updated)}</small>
          </li>))}</ul> : <Empty>还没有会话</Empty>}
      </>}>
        {key ? <Transcript key={key} agent={agent} skey={key} onChange={reload} /> : <Empty>选一个会话</Empty>}
      </Split>
    </>
  );
}

function Transcript({ agent, skey, onChange }: { agent: string; skey: string; onChange: () => void }) {
  const [s, reload, err] = useLoad(() => api(`/agents/${enc(agent)}/sessions/${enc(skey)}?limit=500`), [agent, skey]);
  if (!s) return <Err msg={err} />;
  const base = `/agents/${enc(agent)}/sessions/${enc(skey)}`;
  return (
    <Card title={skey} actions={<>
      <Btn small onClick={async () => { const r = await api(`${base}/compact`, { body: {} }); toast(r.compacted ? "已压缩" : "太短了，不用压缩"); reload(); }}>压缩</Btn>
      <Btn small onClick={() => download(`${skey.replace(/:/g, "_")}.json`, JSON.stringify(s, null, 2))}>导出</Btn>
      <Btn small kind="danger" onClick={confirmDo("重置后她就不记得这段对话了（记录仍保留在库里）。确定？", async () => { await api(`${base}/reset`, { body: {} }); toast("已重置"); reload(); onChange(); })}>重置</Btn>
    </>}>
      {s.summary && <div class="summary"><b>较早对话的摘要</b><div>{s.summary}</div></div>}
      <div class="msgs">{s.messages.map((m: any) => <Message m={m} />)}</div>
    </Card>
  );
}
