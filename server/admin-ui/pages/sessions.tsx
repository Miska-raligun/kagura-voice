// 会话（含网页聊天）：按 agent 浏览所有会话，任意会话都能接着聊；「新对话」开一个新的网页会话；
// 回复边生成边显示（Markdown 渲染）；可以发图片（选择 / 粘贴 / 拖进来）和文件；压缩、导出、清空上下文、删除。
// 路由：#/sessions/<agent>|<会话 key>
import { useEffect, useRef, useState } from "preact/hooks";
import { api, download, enc, fmtTime, go } from "../api.ts";
import { Btn, Card, Empty, Err, Split, TextArea, confirmDo, toast, toastErr, useLoad } from "../ui.tsx";
import { AgentPicker, Message, useAgentId } from "./common.tsx";
import { renderMarkdown } from "../md.ts";

const CHANNEL: Record<string, string> = { webchat: "网页", device: "设备", system: "定时任务", a2a: "agent 通信", feishu: "飞书", qq: "QQ", onebot: "OneBot" };

export function Sessions({ arg }: { arg: string }) {
  const agent = useAgentId(arg);
  const key = arg.split("|")[1] ?? "";
  const [list, reload, err] = useLoad(() => (agent ? api<any[]>(`/agents/${enc(agent)}/sessions`) : Promise.resolve([])), [agent]);
  const newChat = () => go("sessions", `${agent}|${agent}:webchat:${Date.now().toString(36)}`);
  return (
    <>
      <AgentPicker page="sessions" value={agent} />
      <Split left={<>
        <Btn kind="primary" onClick={newChat}>＋ 新对话</Btn>
        <Err msg={err} />
        {list?.length ? <ul class="list">{list.map((s) => (
          <li class={s.key === key ? "on" : ""} onClick={() => go("sessions", `${agent}|${s.key}`)}>
            <b>{s.title || s.key.slice(agent.length + 1)}</b>
            <small>{CHANNEL[s.channel] ?? s.channel} · {s.messages} 条 · {fmtTime(s.updated)}{s.busy ? " · 回复中" : ""}</small>
          </li>))}</ul> : <Empty>暂无会话</Empty>}
      </>}>
        {key ? <Conversation key={key} agent={agent} skey={key} onChange={reload} /> : <Inbox agent={agent} onNew={newChat} />}
      </Split>
    </>
  );
}

/** 没选会话时：说明 + 投递到网页聊天的定时任务结果 */
function Inbox({ agent, onNew }: { agent: string; onNew: () => void }) {
  const [runs] = useLoad(() => api<any[]>("/job-runs?limit=100"));
  const inbox = (runs ?? []).filter((r) => r.delivered === "webchat" && r.agent === agent).slice(0, 10);
  return (
    <>
      <Card title="会话">
        <p class="muted">设备、网页、IM、定时任务与 agent 间通信的全部会话。</p>
        <Btn kind="primary" onClick={onNew}>＋ 新对话</Btn>
      </Card>
      {inbox.length > 0 && <Card title="定时任务消息">{inbox.map((r) => (
        <div class="msg a"><div class="who">任务 {r.job} · {fmtTime(r.started)}</div><div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.output) }} /></div>))}</Card>}
    </>
  );
}

interface Live { user: any; text: string; tools: string[]; error?: string }

function Conversation({ agent, skey, onChange }: { agent: string; skey: string; onChange: () => void }) {
  const base = `/agents/${enc(agent)}/sessions/${enc(skey)}`;
  const [s, reload] = useLoad(() => api(`${base}?limit=500`).catch((e) => (/没有这个会话/.test(e.message) ? { messages: [], fresh: true } : Promise.reject(e))), [agent, skey]);
  const [live, setLive] = useState<Live | null>(null);
  const [showOld, setShowOld] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo(0, box.current.scrollHeight); }, [s, live]);

  const send = async (text: string, images: Img[], files: Att[]) => {
    const user = { role: "user", content: [...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })), ...(text ? [{ type: "text", text }] : []),
      ...files.map((f) => ({ type: "text", text: `[附件 ${f.name}（${(f.size / 1024).toFixed(1)}KB）已保存到 …]` }))] };
    const st: Live = { user, text: "", tools: [] };
    setLive({ ...st });
    try {
      const r = await fetch("/api/admin/chat?stream=1", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent, session: skey, text, images: images.map(({ data, mimeType }) => ({ data, mimeType })), files: files.map(({ name, b64 }) => ({ name, b64 })) }),
      });
      if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          if (e.type === "text") st.text += e.delta;
          else if (e.type === "break") st.text += "\n\n";
          else if (e.type === "tool") st.tools.push(e.name);
          else if (e.type === "error") st.error = e.error;
          else if (e.type === "done" && !st.text) st.text = e.reply;
          setLive({ ...st, tools: [...st.tools] });
        }
      }
      if (st.error) toastErr(new Error(st.error));
    } catch (e) { toastErr(e); }
    setLive(null);
    reload(); onChange();
  };

  if (!s) return <div class="muted">加载中…</div>;
  const msgs = (s.messages ?? []).filter((m: any) => !m.compacted || showOld);
  const old = (s.messages ?? []).length - msgs.length;
  return (
    <Card class="chat" title={s.fresh ? "新对话" : `${CHANNEL[s.channel] ?? s.channel ?? ""} · ${s.title || skey.slice(agent.length + 1)}`} actions={!s.fresh && <>
      <Btn small onClick={async () => { const r = await api(`${base}/compact`, { body: {} }); toast(r.compacted ? "已压缩" : "太短了，不用压缩"); reload(); }}>压缩</Btn>
      <Btn small onClick={() => download(`${skey.replace(/:/g, "_")}.json`, JSON.stringify(s, null, 2))}>导出</Btn>
      <Btn small onClick={confirmDo("清空上下文？历史记录保留。", async () => { await api(`${base}/reset`, { body: {} }); toast("已清空上下文"); reload(); })}>清空上下文</Btn>
      <Btn small kind="danger" onClick={confirmDo("永久删除此会话的全部记录？", async () => {
        try { await api(base, { method: "DELETE" }); toast("已删除"); onChange(); go("sessions", agent); } catch (e) { toastErr(e); }
      })}>删除</Btn></>}>
      {s.summary && <details class="summary"><summary><b>较早对话的摘要</b></summary><div>{s.summary}</div></details>}
      <div class="msgs" ref={box}>
        {old > 0 && <a class="muted small" onClick={() => setShowOld(true)}>还有 {old} 条已清空 / 已压缩的记录</a>}
        {!msgs.length && !live && <Empty>支持粘贴或拖入图片与文件</Empty>}
        {msgs.map((m: any) => <Message m={m} agent={agent} />)}
        {live && <>
          <Message m={{ msg: live.user }} agent={agent} />
          <div class="msg a">
            <div class="who">助手 <small class="muted">{live.text ? "回复中…" : "思考中…"}</small></div>
            {live.tools.map((t) => <div class="tool">🔧 <code>{t}</code></div>)}
            {live.text && <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(live.text) }} />}
          </div>
        </>}
      </div>
      <Composer busy={!!live} onSend={send} />
    </Card>
  );
}

interface Img { data: string; mimeType: string; name: string }
interface Att { name: string; b64: string; size: number }

function b64(buf: ArrayBuffer) {
  let out = "";
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000) out += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(out);
}

/** 大图先压一下（长边 1600、JPEG），省 token 也省上传；尺寸和体积都不大的原样发 */
async function toImg(file: File): Promise<Img> {
  const bmp = await createImageBitmap(file);
  if (file.size < 700 * 1024 && Math.max(bmp.width, bmp.height) <= 1600 && /png|jpe?g|webp|gif/.test(file.type)) {
    return { data: b64(await file.arrayBuffer()), mimeType: file.type, name: file.name };
  }
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/jpeg", 0.85));
  return { data: b64(await blob.arrayBuffer()), mimeType: "image/jpeg", name: file.name };
}

function Composer({ busy, onSend }: { busy: boolean; onSend: (text: string, images: Img[], files: Att[]) => void }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<Img[]>([]);
  const [files, setFiles] = useState<Att[]>([]);
  const [drag, setDrag] = useState(false);
  const add = async (list: File[]) => {
    for (const f of list) {
      try {
        if (f.type.startsWith("image/")) { const im = await toImg(f); setImages((x) => [...x, im].slice(0, 6)); }
        else if (f.size > 20 * 1024 * 1024) toast(`${f.name} 太大（上限 20MB）`, "err");
        else { const a: Att = { name: f.name, b64: b64(await f.arrayBuffer()), size: f.size }; setFiles((x) => [...x, a]); }
      } catch (e) { toastErr(e); }
    }
  };
  const submit = () => {
    if (busy || (!text.trim() && !images.length && !files.length)) return;
    onSend(text.trim(), images, files);
    setText(""); setImages([]); setFiles([]);
  };
  return (
    <div class={`composer2 ${drag ? "drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); add([...(e.dataTransfer?.files ?? [])]); }}>
      {(images.length > 0 || files.length > 0) && <div class="attach">
        {images.map((im, i) => <span class="chip"><img src={`data:${im.mimeType};base64,${im.data}`} /><a onClick={() => setImages(images.filter((_, j) => j !== i))}>×</a></span>)}
        {files.map((f, i) => <span class="chip">📎 {f.name} <small class="muted">{(f.size / 1024).toFixed(1)}KB</small><a onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</a></span>)}
      </div>}
      <div class="composer">
        <Btn title="添加图片或文件" onClick={() => {
          const el = document.createElement("input");
          el.type = "file"; el.multiple = true;
          el.onchange = () => add([...(el.files ?? [])]);
          el.click();
        }}>📎</Btn>
        <div class="grow" onPaste={(e: ClipboardEvent) => {
          const fs = [...(e.clipboardData?.files ?? [])];
          if (fs.length) { e.preventDefault(); add(fs); }
        }} onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
        }}>
          <TextArea value={text} onInput={setText} rows={2} placeholder="Enter 发送 · Shift+Enter 换行 · /reset 清空上下文" />
        </div>
        <Btn kind="primary" onClick={submit} disabled={busy || (!text.trim() && !images.length && !files.length)}>{busy ? "回复中…" : "发送"}</Btn>
      </div>
    </div>
  );
}
