// 网页聊天：直接和任一 agent 打字聊天（webchat 渠道），调人设很方便；也显示投递到网页聊天的定时任务
import { useEffect, useRef, useState } from "preact/hooks";
import { api, enc, fmtTime } from "../api.ts";
import { Btn, Card, Empty, TextArea, toastErr, useLoad } from "../ui.tsx";
import { AgentPicker, Message, useAgentId } from "./common.tsx";

export function Chat({ arg }: { arg: string }) {
  const agent = useAgentId(arg);
  const key = `${agent}:webchat:owner`;
  const [hist, reload] = useLoad(() => (agent ? api(`/agents/${enc(agent)}/sessions/${enc(key)}?limit=100`).catch(() => ({ messages: [] })) : Promise.resolve({ messages: [] })), [agent]);
  const [runs] = useLoad(() => api<any[]>("/runs?limit=100"));
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo(0, box.current.scrollHeight); }, [hist, pending]);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText(""); setPending(t);
    try { await api("/chat", { body: { agent, text: t } }); } catch (e) { toastErr(e); }
    setPending(null); reload();
  };
  const inbox = (runs ?? []).filter((r) => r.delivered === "webchat" && r.agent === agent).slice(0, 10);
  const msgs = (hist?.messages ?? []).filter((m: any) => !m.compacted);
  return (
    <>
      <AgentPicker page="chat" value={agent} />
      <Card class="chat">
        <div class="msgs" ref={box}>
          {!msgs.length && !pending && <Empty>和她说点什么吧。这里的对话是独立的 webchat 会话，不影响设备上的。</Empty>}
          {msgs.map((m: any) => <Message m={m} />)}
          {pending && <><div class="msg u"><div class="who">用户</div><div class="txt">{pending}</div></div><div class="msg a"><div class="txt muted">思考中…</div></div></>}
        </div>
        <div class="composer">
          <TextArea value={text} onInput={setText} rows={2} placeholder="Ctrl+Enter 发送；/reset 开始新对话" />
          <Btn kind="primary" onClick={send} disabled={!!pending || !text.trim()}>发送</Btn>
        </div>
      </Card>
      {inbox.length > 0 && <Card title="投递到网页聊天的定时任务">{inbox.map((r) => <div class="msg a"><div class="who">任务 {r.job} · {fmtTime(r.started)}</div><div class="txt">{r.output}</div></div>)}</Card>}
    </>
  );
}

// Ctrl+Enter 发送
addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.target as HTMLElement)?.closest?.(".composer")) {
    (document.querySelector(".composer .btn.primary") as HTMLButtonElement | null)?.click();
  }
});
