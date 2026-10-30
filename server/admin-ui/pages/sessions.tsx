// 会话（含网页聊天）：按 agent 浏览所有会话，任意会话都能接着聊；「新对话」开一个新的网页会话；
// 回复边生成边显示（Markdown 渲染）；可以发图片（选择 / 粘贴 / 拖进来）和文件；压缩、导出、清空上下文、删除。
// 路由：#/sessions/<agent>|<会话 key>
import { useEffect, useRef, useState } from "preact/hooks";
import { api, download, enc, fmtTime, go, money } from "../api.ts";
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

interface LiveRun { purpose: string; channel: string; since: number; messages: any[]; partial: { thinking: string; text: string }; tools: string[] }
const PURPOSE: Record<string, string> = { heartbeat: "heartbeat", cron: "定时任务", task: "待办", a2a: "agent 通信", sub: "子任务" };

/** 逐行读 NDJSON */
async function readLines(r: Response, on: (o: any) => void) {
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.trim()) on(JSON.parse(line));
    }
  }
}

/**
 * 订阅会话的实时过程（服务端 Runtime.watchLive）：不管这一轮是网页发的、飞书 / 设备来的、还是 heartbeat / 待办，
 * 打开会话就能看到思考、工具调用和结果、正在生成的回复；中途切走再回来也接得上。断了 2 秒后重连。
 */
function useLive(base: string, onEnd: () => Promise<void>): LiveRun | null {
  const [run, setRun] = useState<LiveRun | null>(null);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    const ac = new AbortController();
    let cur: LiveRun | null = null;
    let raf = 0;
    const flush = () => { raf = 0; setRun(cur ? { ...cur, messages: [...cur.messages], partial: { ...cur.partial }, tools: [...cur.tools] } : null); };
    const later = () => { if (!raf) raf = requestAnimationFrame(flush); };
    // 这一轮落盘了：先把历史重新拉回来再收起实时那块，免得中间空一下
    const finish = (err?: string) => {
      const was = cur;
      cur = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (err) toast(err, "err");
      endRef.current().finally(() => { if (!cur || cur === was) flush(); });
    };
    const handle = (e: any) => {
      if (e.type === "start") { cur = e.run; later(); }
      else if (e.type === "idle") { if (cur) finish(); }
      else if (e.type === "end") finish(e.error);
      else if (!cur) return;
      else if (e.type === "delta") { cur.partial[e.kind as "text" | "thinking"] += e.delta; later(); }
      else if (e.type === "message") { cur.messages.push(e.message); cur.partial = { thinking: "", text: "" }; later(); }
      else if (e.type === "tool") {
        if (e.running) cur.tools.push(e.name);
        else { const i = cur.tools.indexOf(e.name); if (i >= 0) cur.tools.splice(i, 1); }
        later();
      }
    };
    (async () => {
      while (!ac.signal.aborted) {
        try {
          const r = await fetch(`/api/admin${base}/live`, { signal: ac.signal });
          if (r.ok && r.body) await readLines(r, handle);
        } catch { /* 断开了，下面重连 */ }
        if (ac.signal.aborted) break;
        await new Promise((ok) => setTimeout(ok, 2000));
      }
    })();
    return () => { ac.abort(); if (raf) cancelAnimationFrame(raf); };
  }, [base]);
  return run;
}

function Conversation({ agent, skey, onChange }: { agent: string; skey: string; onChange: () => void }) {
  const base = `/agents/${enc(agent)}/sessions/${enc(skey)}`;
  const [s, reload] = useLoad(() => api(`${base}?limit=500`).catch((e) => (/没有这个会话/.test(e.message) ? { messages: [], fresh: true } : Promise.reject(e))), [agent, skey]);
  const run = useLive(base, async () => { await reload(); setPending(null); onChange(); });
  // 刚发出去、这一轮还没开始（排队 / 整理上下文）时先把自己说的话摆上
  const [pending, setPending] = useState<any>(null);
  const [sending, setSending] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo(0, box.current.scrollHeight); }, [s, run, pending]);

  const send = async (text: string, images: Img[], files: Att[]) => {
    setPending({ role: "user", content: [...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })), ...(text ? [{ type: "text", text }] : []),
      ...files.map((f) => ({ type: "text", text: `[附件 ${f.name}（${(f.size / 1024).toFixed(1)}KB）]` }))] });
    setSending(true);
    try {
      const r = await fetch("/api/admin/chat?stream=1", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent, session: skey, text, images: images.map(({ data, mimeType }) => ({ data, mimeType })), files: files.map(({ name, b64 }) => ({ name, b64 })) }),
      });
      if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      // 过程由 useLive 显示，这里只等结果（出错由实时那边提示）
      await readLines(r, () => {});
    } catch (e) { toastErr(e); }
    setSending(false); setPending(null);
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
        {!msgs.length && !run && !pending && <Empty>支持粘贴或拖入图片与文件</Empty>}
        {msgs.map((m: any, i: number) => <>
          <Message m={m} agent={agent} />
          {m.msg?.role === "assistant" && turnEnds(msgs, i) && <TurnUsage msgs={msgs} end={i} />}
        </>)}
        {pending && !run?.messages.length && <>
          <Message m={{ msg: pending }} agent={agent} />
          <div class="msg a"><div class="who">助手 <small class="muted">{run ? "整理上下文…" : "排队中…"}</small></div></div>
        </>}
        {run && (run.messages.length > 0 || !pending) && <>
          {run.channel !== "webchat" || PURPOSE[run.purpose] ? <div class="muted small">— {PURPOSE[run.purpose] ?? CHANNEL[run.channel] ?? run.channel} 发起的一轮，进行中 —</div> : null}
          {run.messages.map((m) => <Message m={{ msg: m }} agent={agent} />)}
          <div class="msg a">
            <div class="who">助手 <small class="muted">{run.tools.length ? "执行工具…" : run.partial.text ? "回复中…" : !run.messages.length ? "整理上下文…" : "思考中…"}</small></div>
            {run.partial.thinking && <details class="think" open><summary>思考</summary>{run.partial.thinking}</details>}
            {run.tools.map((t) => <div class="tool">🔧 <code>{t}</code> <span class="muted">执行中…</span></div>)}
            {run.partial.text && <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(run.partial.text) }} />}
          </div>
        </>}
      </div>
      <Composer busy={sending || !!run} onSend={send} />
    </Card>
  );
}

/** 这条助手消息之后到下一条用户消息之间没有别的助手消息 = 这一轮的最后一条 */
function turnEnds(msgs: any[], i: number) {
  for (let j = i + 1; j < msgs.length; j++) {
    const r = msgs[j].msg?.role;
    if (r === "user") return true;
    if (r === "assistant") return false;
  }
  return true;
}

const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

/**
 * 一轮的 token 明细：这一轮每次调模型的用量加总（服务商报的：输入未缓存 / 缓存读 / 缓存写 / 输出，含思考），
 * 以及这一轮开始时上下文的构成（系统提示 / 工具定义 / 历史，按字数估算）。点开看每次调用。
 */
function TurnUsage({ msgs, end }: { msgs: any[]; end: number }) {
  let start = end;
  while (start > 0 && msgs[start - 1].msg?.role !== "user") start--;
  const calls = msgs.slice(start, end + 1).filter((m) => m.msg?.role === "assistant" && m.msg.usage);
  if (!calls.length) return null;
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
  for (const c of calls) {
    const u = c.msg.usage;
    sum.input += u.input ?? 0; sum.output += u.output ?? 0; sum.cacheRead += u.cacheRead ?? 0; sum.cacheWrite += u.cacheWrite ?? 0;
    sum.reasoning += u.reasoning ?? 0; sum.cost += u.cost?.total ?? 0;
  }
  const ctx = msgs[end].msg.kctx;
  const total = sum.input + sum.output + sum.cacheRead + sum.cacheWrite;
  return (
    <details class="usage">
      <summary>
        🔢 {k(total)} token · 输入 {k(sum.input)} · 缓存读 {k(sum.cacheRead)}{sum.cacheWrite ? ` · 缓存写 ${k(sum.cacheWrite)}` : ""} · 输出 {k(sum.output)}
        {sum.reasoning ? `（思考 ${k(sum.reasoning)}）` : ""}{calls.length > 1 ? ` · ${calls.length} 次调用` : ""}{sum.cost ? ` · ${money(sum.cost)}` : ""}
      </summary>
      {ctx && <div>上下文 ≈ 系统提示 {k(ctx.sys)} + 工具定义 {k(ctx.tools)} + 历史 {k(ctx.hist)} = {k(ctx.sys + ctx.tools + ctx.hist)}（窗口 {k(ctx.win)}）</div>}
      {calls.length > 1 && <table class="small">
        <thead><tr><th>#</th><th>输入</th><th>缓存读</th><th>缓存写</th><th>输出</th><th>费用</th></tr></thead>
        <tbody>{calls.map((c, i) => { const u = c.msg.usage; return (
          <tr><td>{i + 1}</td><td>{k(u.input ?? 0)}</td><td>{k(u.cacheRead ?? 0)}</td><td>{k(u.cacheWrite ?? 0)}</td><td>{k(u.output ?? 0)}{u.reasoning ? `（思考 ${k(u.reasoning)}）` : ""}</td><td>{money(u.cost?.total)}</td></tr>); })}</tbody>
      </table>}
    </details>
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
