// 会话（含网页聊天）：按 agent 浏览所有会话，任意会话都能接着聊；「新对话」开一个新的网页会话；
// 回复边生成边显示（Markdown 渲染）；可以发图片（选择 / 粘贴 / 拖进来）和文件；压缩、导出、清空上下文、删除。
// 路由：#/sessions/<agent>|<会话 key>
import { useEffect, useRef, useState } from "preact/hooks";
import { api, download, enc, fmtTime, go, money } from "../api.ts";
import { Btn, Card, Empty, Err, Pop, SideList, Split, TextArea, confirmDo, toast, toastErr, useInterval, useLoad } from "../ui.tsx";
import { AgentPicker, Message, useAgentId } from "./common.tsx";
import { renderMarkdown } from "../md.ts";
import { A2ADock } from "./a2a.tsx";

const CHANNEL: Record<string, string> = { webchat: "网页", device: "设备", system: "定时任务", a2a: "agent 通信", feishu: "飞书", qq: "QQ", onebot: "OneBot" };

/**
 * 会话从哪来。按 key 认后台的几种（heartbeat / 定时任务 / 待办 / 子任务），其余看渠道；
 * <agent>:main 是主会话（设备、主人私聊开了 owner_main 都进这里）
 */
function sourceOf(agent: string, s: { key: string; channel: string }): { group: string; label: string } {
  const rest = s.key.slice(agent.length + 1);
  if (rest === "main") return { group: "main", label: "主会话" };
  if (rest === "heartbeat") return { group: "bg", label: "heartbeat" };
  if (rest.startsWith("cron:")) return { group: "bg", label: "定时任务" };
  if (rest.startsWith("task:")) return { group: "bg", label: "待办" };
  if (rest.startsWith("sub:")) return { group: "bg", label: "子任务" };
  if (s.channel === "a2a") return { group: "bg", label: "agent 通信" };
  if (["feishu", "qq", "onebot"].includes(s.channel)) return { group: "im", label: CHANNEL[s.channel] ?? s.channel };
  if (s.channel === "device") return { group: "device", label: "设备" };
  if (s.channel === "webchat") return { group: "web", label: "网页" };
  return { group: "bg", label: CHANNEL[s.channel] ?? s.channel };
}
const GROUPS: [string, string][] = [["", "全部"], ["main", "主会话"], ["web", "网页"], ["device", "设备"], ["im", "IM"], ["bg", "后台"]];

export function Sessions({ arg }: { arg: string }) {
  const agent = useAgentId(arg);
  const key = arg.split("|")[1] ?? "";
  const [list, reload, err] = useLoad(() => (agent ? api<any[]>(`/agents/${enc(agent)}/sessions`) : Promise.resolve([])), [agent]);
  // 飞书、设备、heartbeat 随时会新开会话 / 开始回复：列表每 5 秒刷新一次
  useInterval(reload, 5000);
  const [group, setGroup] = useState("");
  const shown = (list ?? []).filter((s) => !group || sourceOf(agent, s).group === group);
  const newChat = () => go("sessions", `${agent}|${agent}:webchat:${Date.now().toString(36)}`);
  return (
    <>
      <AgentPicker page="sessions" value={agent} />
      <Split left={<>
        <Btn kind="primary" onClick={newChat}>＋ 新对话</Btn>
        <Err msg={err} />
        <div class="chips">{GROUPS.map(([g, l]) => {
          const n = g ? (list ?? []).filter((s) => sourceOf(agent, s).group === g).length : (list ?? []).length;
          return n || !g ? <a class={g === group ? "on" : ""} onClick={() => setGroup(g)}>{l}{g ? ` ${n}` : ""}</a> : null;
        })}</div>
        <SideList groups={[{ id: "all", items: shown }]} placeholder="搜索会话标题"
          match={(x: any, q) => `${x.title} ${x.key} ${sourceOf(agent, x).label}`.toLowerCase().includes(q)}
          empty={<Empty>暂无会话</Empty>}
          render={(x: any) => (
            <li class={x.key === key ? "on" : ""} onClick={() => go("sessions", `${agent}|${x.key}`)}>
              <b>{x.title || x.key.slice(agent.length + 1)}</b>
              <small>{sourceOf(agent, x).label} · {x.messages} 条 · {fmtTime(x.updated)}{x.busy ? " · 回复中" : ""}</small>
            </li>)} />
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

interface LiveRun { purpose: string; channel: string; since: number; messages: any[]; partial: { thinking: string; text: string }; tools: string[]; trace?: string }
const A2A_TOOLS = new Set(["sessions_send", "sessions_spawn"]);
/** 这一轮有没有找别的 agent / 派子任务（正在调，或者已经调过） */
const usesA2A = (r: LiveRun) => r.tools.some((t) => A2A_TOOLS.has(t))
  || r.messages.some((m) => m.role === "assistant" && (m.content ?? []).some((c: any) => c.type === "toolCall" && A2A_TOOLS.has(c.name)));
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
  // 这一轮她找了别的 agent：底部弹出实时的 Agent 通信动画（这一轮结束后留着，等主人关；同一串调用的后续轮次接着用这个）
  const [dock, setDock] = useState<{ trace: string; live: boolean } | null>(null);
  const [dockClosed, setDockClosed] = useState("");
  const [dockSmall, setDockSmall] = useState(false);
  useEffect(() => {
    if (run?.trace && usesA2A(run) && dockClosed !== run.trace) setDock({ trace: run.trace, live: true });
    else if (!run) setDock((d) => (d && d.live ? { ...d, live: false } : d));
  }, [run]);
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
  // 系统事件（压缩等）按时间穿插：已压缩的消息隐藏时，早于第一条可见消息的事件也不显示
  const events: any[] = (s.events ?? []).filter((e: any) => showOld || !msgs.length || e.ts >= msgs[0].ts || !old);
  const evs = placeEvents(events, msgs);
  return (
    <Card class={`chat ${dock ? "withdock" : ""} ${dock && dockSmall ? "docksmall" : ""}`} title={s.fresh ? "新对话" : `${sourceOf(agent, { key: skey, channel: s.channel ?? "" }).label} · ${s.title || skey.slice(agent.length + 1)}`} actions={!s.fresh && <>
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
        {evs.lead.length > 0 && <div class="turnmeta"><CompactPop events={evs.lead} /></div>}
        {msgs.map((m: any, i: number) => <>
          <Message m={m} agent={agent} />
          {m.msg?.role === "assistant" && turnEnds(msgs, i) && <TurnMeta msgs={msgs} end={i} events={evs.at.get(i) ?? []} />}
        </>)}
        {evs.tail.length > 0 && <div class="turnmeta"><CompactPop events={evs.tail} /></div>}
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
      {dock && <A2ADock key={dock.trace} trace={dock.trace} live={dock.live} onClose={() => { setDockClosed(dock.trace); setDock(null); setDockSmall(false); }} onSmall={setDockSmall} />}
      <Composer busy={sending || !!run} onSend={send} />
    </Card>
  );
}

/**
 * 压缩等系统事件挂到哪一轮：发生在某一轮结束之后（下一轮开始之前）就挂在那一轮的图标上；
 * 比第一轮还早的放最上面，最后一轮没结束（出错 / 没回复）之后的放最下面
 */
function placeEvents(events: any[], msgs: any[]) {
  const ends = msgs.map((m, i) => (m.msg?.role === "assistant" && turnEnds(msgs, i) ? i : -1)).filter((i) => i >= 0);
  const at = new Map<number, any[]>();
  const lead: any[] = [], tail: any[] = [];
  for (const e of events) {
    let owner = -1;
    for (const i of ends) if (msgs[i].ts <= e.ts) owner = i;
    if (owner < 0) { lead.push(e); continue; }
    const nextUser = msgs.findIndex((m, j) => j > owner && m.msg?.role === "user");
    const lastEnd = ends.at(-1)!;
    if (owner === lastEnd && nextUser >= 0 && msgs[nextUser].ts <= e.ts) { tail.push(e); continue; }
    at.set(owner, [...(at.get(owner) ?? []), e]);
  }
  return { at, lead, tail };
}

const SCENE: Record<string, string> = { owner: "主人对话", guest: "群聊 / 陌生人", heartbeat: "heartbeat", cron: "定时任务", task: "待办", sub: "子任务", a2a: "agent 间对话" };
const TRIGGER: Record<string, string> = { before: "回复前（历史超过阈值）", background: "回复后在后台预先压缩", overflow: "服务商报上下文超长", manual: "手动" };
const TARGET: Record<string, string> = { user: "USER.md", long: "MEMORY.md", daily: "今天的笔记" };
const fileLabel = (f: string) => (f === "daily" ? "每日笔记" : f.replace(".md", ""));

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

/** 每轮回复下面的小图标：ⓘ 这一轮的上下文和 token，🗜 这一轮之后发生的压缩。鼠标放上去看，点一下固定 */
function TurnMeta({ msgs, end, events }: { msgs: any[]; end: number; events: any[] }) {
  const info = turnInfo(msgs, end);
  if (!info && !events.length) return null;
  return (
    <div class="turnmeta">
      {info && <Pop icon={info.guard ? "⚠" : "ⓘ"} class={info.guard ? "bad" : ""} tip={info.tip}>{info.body}</Pop>}
      {events.length > 0 && <CompactPop events={events} />}
    </div>
  );
}

/**
 * 一轮的详情：系统层放进上下文的东西（场景、人设文件、近况、摘要、自动回忆、截短的旧工具结果、单轮上限）
 * 和 token（服务商报的输入 / 缓存读写 / 输出 / 思考 / 费用，以及按字数估算的上下文构成）
 */
function turnInfo(msgs: any[], end: number) {
  let start = end;
  while (start > 0 && msgs[start - 1].msg?.role !== "user") start--;
  const calls = msgs.slice(start, end + 1).filter((m) => m.msg?.role === "assistant" && m.msg.usage);
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
  for (const c of calls) {
    const u = c.msg.usage;
    sum.input += u.input ?? 0; sum.output += u.output ?? 0; sum.cacheRead += u.cacheRead ?? 0; sum.cacheWrite += u.cacheWrite ?? 0;
    sum.reasoning += u.reasoning ?? 0; sum.cost += u.cost?.total ?? 0;
  }
  const total = sum.input + sum.output + sum.cacheRead + sum.cacheWrite;
  const c = msgs[end].msg?.kctx;
  const t = c?.trace;
  if (!total && !t) return null;              // 主动开口记进来的那种：没调模型、也没组装上下文
  const tip = [total ? `${k(total)} token` : "", sum.cost ? money(sum.cost) : "", calls.length > 1 ? `${calls.length} 次调用` : "",
    t ? `${t.files.length} 个人设文件` : "", c?.recall?.hits?.length ? `回忆 ${c.recall.hits.length} 条` : "",
    t?.summary ? "带较早对话摘要" : "", c?.guard ? `⚠️ ${c.guard}，已叫停` : ""].filter(Boolean).join(" · ");
  const body = <>
    {t && <>
      <h5>上下文（{SCENE[t.scene] ?? t.scene}）</h5>
      <div>人设：{t.files.map((f: any) => `${fileLabel(f.name)}（${f.mode === "toc" ? "目录" : `${f.chars} 字${f.clipped ? "，超上限已截断" : ""}`}）`).join("、") || "无"}</div>
      {t.notLoaded?.length > 0 && <div>没加载：{t.notLoaded.map(fileLabel).join("、")}（需要时她自己读）</div>}
      {t.daily > 0 && <div>今昨笔记：{t.daily} 字</div>}
      <div>近况：{c.recent?.items ? `${c.recent.items} 条，${c.recent.chars} 字` : "无"}</div>
      <div>较早对话摘要：{t.summary ? `${t.summary} 字` : "无"}</div>
      <div>自动回忆：{c.recall?.hits?.length ? `${c.recall.hits.length} 条（${c.recall.ms}ms）` : c.recall?.why || "没检索"}</div>
      {c.recall?.hits?.map((h: string) => <div class="hit">· {h}</div>)}
      <div>工具 {c.toolCount ?? "?"} 个 · 技能 {t.skills} 个 · 可联系的 agent {t.peers} 个</div>
      {c.pruned > 0 && <div>之前几轮的工具结果有 {c.pruned} 条截短后放进上下文（库里存全文）</div>}
      {c.limit && <div>压缩阈值：历史超过 {k(c.limit)} token 时压缩</div>}
      {c.guard && <div class="over">单轮上限：{c.guard}</div>}
      {c.a2a && <div><a onClick={() => go("a2a", c.a2a)}>看这一轮的 Agent 通信 →</a></div>}
    </>}
    {total > 0 && <>
      <h5>Token</h5>
      <div>输入 {k(sum.input)} · 缓存读 {k(sum.cacheRead)} · 缓存写 {k(sum.cacheWrite)} · 输出 {k(sum.output)}{sum.reasoning ? `（思考 ${k(sum.reasoning)}）` : ""}{sum.cost ? ` · ${money(sum.cost)}` : ""}</div>
      {c && <div>上下文 ≈ 系统提示 {k(c.sys)} + 工具定义 {k(c.tools)} + 历史 {k(c.hist)} = {k(c.sys + c.tools + c.hist)}（窗口 {k(c.win)}）</div>}
      {calls.length > 1 && <table>
        <thead><tr><th>#</th><th>输入</th><th>缓存读</th><th>缓存写</th><th>输出</th><th>费用</th></tr></thead>
        <tbody>{calls.map((x, i) => { const u = x.msg.usage; return (
          <tr><td>{i + 1}</td><td>{k(u.input ?? 0)}</td><td>{k(u.cacheRead ?? 0)}</td><td>{k(u.cacheWrite ?? 0)}</td><td>{k(u.output ?? 0)}{u.reasoning ? `（思考 ${k(u.reasoning)}）` : ""}</td><td>{money(u.cost?.total)}</td></tr>); })}</tbody>
      </table>}
    </>}
  </>;
  return { tip, body, guard: !!c?.guard };
}

/** 压缩事件的图标：为什么压、压了多少、剩多少、顺手记了什么；失败的标红 */
function CompactPop({ events }: { events: any[] }) {
  const failed = events.filter((e) => e.kind === "compact_failed");
  const ok = events.filter((e) => e.kind === "compact");
  const last = ok.at(-1)?.data;
  const tip = [ok.length ? `压缩 ${ok.reduce((n, e) => n + (e.data?.messages ?? 0), 0)} 条 → 摘要 ${last?.summary ?? 0} 字${ok.some((e) => e.data?.remembered?.length) ? "，记下了记忆" : ""}` : "",
    failed.length ? `压缩失败 ${failed.length} 次` : ""].filter(Boolean).join(" · ");
  return (
    <Pop icon="🗜" class={failed.length && !ok.length ? "bad" : ""} tip={tip}>
      {events.map((e) => {
        const d = e.data ?? {};
        const time = new Date(e.ts * 1000).toLocaleString("zh-CN", { hour12: false });
        if (e.kind === "compact_failed") return <><h5 class="over">压缩失败 · {time}</h5><div>{TRIGGER[d.trigger] ?? d.trigger}：{d.error}</div></>;
        return <>
          <h5>压缩 · {time}</h5>
          <div>原因：{TRIGGER[d.trigger] ?? d.trigger}{d.size ? `（历史约 ${k(d.size)} token，阈值 ${k(d.limit ?? 0)}）` : ""}</div>
          <div>压掉 {d.messages} 条（约 {k(d.oldTokens ?? 0)} token）→ 摘要 {d.summary} 字；留下最近 {d.kept} 条（约 {k(d.keptTokens ?? 0)} token）</div>
          <div>摘要模型 {d.model}，分 {d.chunks} 段{d.failed ? `，${d.failed} 段没总结成（只留了用户说过的话）` : ""}，用时 {(d.ms / 1000).toFixed(1)} 秒</div>
          {d.remembered?.map((r: any) => <div class="hit">· 记进 {TARGET[r.target] ?? r.target}：{r.text}</div>)}
        </>;
      })}
    </Pop>
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
