// Agents：新建/复制/删除；基本信息、人设文件（带字数预算）、工具与技能白名单、heartbeat、通信权限
import { useEffect, useState } from "preact/hooks";
import { api, chars, enc, go } from "../api.ts";
import { Btn, Card, Empty, Err, Field, Input, Select, Split, Tabs, TextArea, Toggle, confirmDo, toast, toastErr, useLoad } from "../ui.tsx";

type Tab = "basic" | "soul" | "tools" | "heartbeat" | "a2a";

export function Agents({ arg }: { arg: string }) {
  const [list, reload, err] = useLoad(() => api<any[]>("/agents"));
  const [creating, setCreating] = useState(false);
  const cur = arg || list?.[0]?.id || "";
  return (
    <Split left={<>
      <Err msg={err} />
      <ul class="list">{list?.map((a) => (
        <li class={a.id === cur ? "on" : ""} onClick={() => go("agents", a.id)}>
          <b>{a.name}</b><small>{a.id}{a.order === Math.min(...list.map((x) => x.order)) ? " · 默认" : ""}</small>
        </li>))}</ul>
      <Btn onClick={() => setCreating(true)}>＋ 新建 agent</Btn>
    </>}>
      {creating ? <NewAgent list={list ?? []} done={(id) => { setCreating(false); reload(); if (id) go("agents", id); }} />
        : cur ? <AgentDetail key={cur} id={cur} onChange={reload} /> : <Empty>还没有 agent</Empty>}
    </Split>
  );
}

function NewAgent({ list, done }: { list: any[]; done: (id?: string) => void }) {
  const [f, set] = useState({ id: "", name: "", per: "111", copy_from: "" });
  const create = async () => {
    await api("/agents", { body: { id: f.id, name: f.name || f.id, per: Number(f.per), copy_from: f.copy_from || undefined } });
    toast("已创建");
    done(f.id);
  };
  return (
    <Card title="新建 agent" actions={<Btn kind="ghost" onClick={() => done()}>取消</Btn>}>
      <div class="form">
        <Field label="id" hint="字母/数字/_-，同时是设备上的图片目录名"><Input value={f.id} onInput={(v) => set({ ...f, id: v })} /></Field>
        <Field label="名字"><Input value={f.name} onInput={(v) => set({ ...f, name: v })} /></Field>
        <Field label="百度音色 per"><Input value={f.per} onInput={(v) => set({ ...f, per: v })} /></Field>
        <Field label="复制人设自"><Select value={f.copy_from} onChange={(v) => set({ ...f, copy_from: v })} options={[["", "不复制（用模板）"], ...list.map((a) => [a.id, a.name] as [string, string])]} /></Field>
      </div>
      <Btn kind="primary" onClick={create} disabled={!f.id}>创建</Btn>
    </Card>
  );
}

function AgentDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const [a, reload, err] = useLoad(() => api(`/agents/${enc(id)}`), [id]);
  const [tab, setTab] = useState<Tab>("basic");
  if (!a) return <Err msg={err} />;
  const save = async (patch: any) => { await api(`/agents/${enc(id)}`, { method: "PATCH", body: patch }); toast("已保存"); reload(); onChange(); };
  return (
    <>
      <div class="titlebar">
        <h3>{a.name} <small class="muted">{a.id}</small></h3>
        <div class="actions">
          <Btn kind="ghost" onClick={() => go("chat", id)}>聊两句</Btn>
          <Btn kind="ghost" onClick={() => go("sessions", id)}>会话</Btn>
          <Btn kind="danger" onClick={confirmDo(`删除 ${a.name}？目录会移进 agents/.trash/，可以手动找回。`, async () => { await api(`/agents/${enc(id)}`, { method: "DELETE" }); toast("已删除"); onChange(); go("agents"); })}>删除</Btn>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[["basic", "基本"], ["soul", "人设文件"], ["tools", "工具与技能"], ["heartbeat", "Heartbeat"], ["a2a", "通信权限"]]} />
      {tab === "basic" && <Basic a={a} save={save} />}
      {tab === "soul" && <SoulFiles id={id} />}
      {tab === "tools" && <ToolsTab a={a} save={save} />}
      {tab === "heartbeat" && <HeartbeatTab a={a} save={save} />}
      {tab === "a2a" && <A2ATab a={a} save={save} />}
    </>
  );
}

function Basic({ a, save }: { a: any; save: (p: any) => Promise<void> }) {
  const [f, set] = useState({ ...a, aliases: a.aliases.join("，") });
  const [models] = useLoad(() => api("/models"));
  const opts: [string, string][] = [["", `默认（${models?.default || "未配置"}）`], ...(models?.models ?? []).map((m: any) => [m.ref, m.ref] as [string, string])];
  const cheapOpts: [string, string][] = [["", `默认（${models?.cheap || "同主模型"}）`], ...(models?.models ?? []).map((m: any) => [m.ref, m.ref] as [string, string])];
  const preview = async () => {
    const blob = await api<Blob>("/tts", { body: { per: Number(f.per), text: `你好，我是${f.name}。` } });
    new Audio(URL.createObjectURL(blob)).play();
  };
  return (
    <Card>
      <div class="form">
        <Field label="名字"><Input value={f.name} onInput={(v) => set({ ...f, name: v })} /></Field>
        <Field label="别名" hint="语音里可能被认成的叫法，用逗号分隔（切换角色时识别用）"><Input value={f.aliases} onInput={(v) => set({ ...f, aliases: v })} /></Field>
        <Field label="百度音色 per" hint={<a onClick={preview}>▶ 试听</a>}><Input value={f.per} onInput={(v) => set({ ...f, per: v })} /></Field>
        <Field label="设备图片目录" hint={'设备上 resource/<目录>/ 那套图；默认 agent 留空 = 根目录'}><Input value={f.device_role} onInput={(v) => set({ ...f, device_role: v })} /></Field>
        <Field label="模型"><Select value={f.model} onChange={(v) => set({ ...f, model: v })} options={opts} /></Field>
        <Field label="便宜模型" hint="压缩、记忆冲刷、heartbeat 用"><Select value={f.cheap_model} onChange={(v) => set({ ...f, cheap_model: v })} options={cheapOpts} /></Field>
        <Field label="排序" hint="角色切换顺序；最小的是默认 agent"><Input type="number" value={f.order} onInput={(v) => set({ ...f, order: v })} /></Field>
        <Field label="语音回复字数" hint="设备语音里提示她别超过这么多字"><Input type="number" value={f.voice_max_chars} onInput={(v) => set({ ...f, voice_max_chars: v })} /></Field>
        <Field label="压缩阈值（token）" hint="历史超过就压缩成摘要——成本的主要旋钮"><Input type="number" value={f.compaction.max_tokens} onInput={(v) => set({ ...f, compaction: { ...f.compaction, max_tokens: v } })} /></Field>
        <Field label="压缩后保留条数"><Input type="number" value={f.compaction.keep_messages} onInput={(v) => set({ ...f, compaction: { ...f.compaction, keep_messages: v } })} /></Field>
        <Field label="会话" wide><Toggle checked={f.device_in_main} onChange={(v) => set({ ...f, device_in_main: v })} label="设备对话并入 main 会话（与 heartbeat、主人私聊共享上下文）" /></Field>
      </div>
      <Btn kind="primary" onClick={() => save({
        name: f.name, aliases: String(f.aliases).split(/[,，\s]+/).filter(Boolean), per: Number(f.per), device_role: f.device_role,
        model: f.model, cheap_model: f.cheap_model, order: Number(f.order), voice_max_chars: Number(f.voice_max_chars),
        compaction: { max_tokens: Number(f.compaction.max_tokens), keep_messages: Number(f.compaction.keep_messages) }, device_in_main: f.device_in_main,
      })}>保存</Btn>
    </Card>
  );
}

const SOUL_DESC: Record<string, string> = {
  "SOUL.md": "性格、语气、价值观（所有会话）", "IDENTITY.md": "名字、自我介绍、外形", "USER.md": "主人的稳定偏好（子任务不注入）",
  "AGENTS.md": "操作守则：何时用哪个工具、语音要短……", "TOOLS.md": "工具使用备注", "HEARTBEAT.md": "heartbeat 检查清单（只在 heartbeat 时注入）",
  "MEMORY.md": "长期记忆（子任务不注入；也可以在「记忆」页编辑）",
};

export function FileEditor({ id, path, budget, budgets, onBudget }: { id: string; path: string; budget?: number; budgets?: Record<string, number>; onBudget?: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState("");
  useEffect(() => { setText(null); api(`/agents/${enc(id)}/file?path=${enc(path)}`).then((r) => { setText(r.content); setOrig(r.content); }); }, [id, path]);
  if (text === null) return <div class="muted">加载中…</div>;
  const n = chars(text.trim());
  return (
    <>
      <TextArea value={text} onInput={setText} rows={18} mono />
      <div class="row">
        <span class={budget && n > budget ? "over" : "muted"}>{n} 字{budget ? ` / 注入上限 ${budget}（超出部分不会给模型看，文件本身不动）` : ""}</span>
        {budget && budgets && <Btn small kind="ghost" title="所有 agent 的同名文件共用这个上限" onClick={async () => {
          const v = window.prompt(`${path} 最多注入多少字？（所有 agent 共用；越大越费 token）`, String(budget));
          const nb = Math.trunc(Number(v));
          if (!v || !(nb > 0)) return;
          try { await api("/config", { method: "PUT", body: { prompt_budgets: { ...budgets, [path]: nb } } }); toast(`注入上限改成 ${nb}，下一轮对话生效`); onBudget?.(); } catch (e) { toastErr(e); }
        }}>改上限</Btn>}
        <span class="grow" />
        {text !== orig && <span class="muted">未保存</span>}
        <Btn kind="primary" disabled={text === orig} onClick={async () => { await api(`/agents/${enc(id)}/file?path=${enc(path)}`, { method: "PUT", body: { content: text } }); setOrig(text); toast("已保存，下一轮对话生效"); }}>保存</Btn>
      </div>
    </>
  );
}

function SoulFiles({ id }: { id: string }) {
  const [meta, reloadMeta] = useLoad(() => api("/meta"));
  const [file, setFile] = useState("SOUL.md");
  const files: string[] = meta?.soul_files ?? Object.keys(SOUL_DESC);
  return (
    <Card>
      <Tabs value={file} onChange={setFile} tabs={files.map((f) => [f, f.replace(".md", "")] as [string, string])} />
      <p class="muted">{SOUL_DESC[file]}</p>
      <FileEditor id={id} path={file} budget={meta?.budgets?.[file]} budgets={meta?.budgets} onBudget={reloadMeta} />
    </Card>
  );
}

function AllowList({ all, value, onChange }: { all: { name: string; label?: string; description?: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const star = value.includes("*");
  return (
    <>
      <Toggle checked={star} onChange={(v) => onChange(v ? ["*"] : all.map((t) => t.name))} label="全部允许（以后新增的也自动允许）" />
      {!star && <div class="checks">{all.map((t) => (
        <label title={t.description}><input type="checkbox" checked={value.includes(t.name)}
          onChange={(e) => onChange((e.target as HTMLInputElement).checked ? [...value, t.name] : value.filter((x) => x !== t.name))} />
          <code>{t.name}</code> {t.label}</label>))}</div>}
    </>
  );
}

function ToolsTab({ a, save }: { a: any; save: (p: any) => Promise<void> }) {
  const [meta] = useLoad(() => api("/meta"));
  const [skills] = useLoad(() => api<any[]>(`/agents/${enc(a.id)}/skills`), [a.id]);
  const [tools, setTools] = useState<string[]>(a.tools);
  const [sk, setSk] = useState<string[]>(a.skills);
  return (
    <>
      <Card title="工具白名单"><AllowList all={meta?.tools ?? []} value={tools} onChange={setTools} /></Card>
      <Card title="技能白名单">
        <p class="muted">技能放在 数据目录/skills/&lt;名字&gt;/SKILL.md（全局）或 agent 的 workspace/skills/（只给它）。本期只读说明，不执行脚本。</p>
        {skills?.length ? <AllowList all={skills} value={sk} onChange={setSk} /> : <Empty>还没有技能</Empty>}
      </Card>
      <Btn kind="primary" onClick={() => save({ tools, skills: sk })}>保存</Btn>
    </>
  );
}

function HeartbeatTab({ a, save }: { a: any; save: (p: any) => Promise<void> }) {
  const [h, set] = useState({ ...a.heartbeat });
  return (
    <Card>
      <p class="muted">每隔一段时间在 main 会话里按 HEARTBEAT.md 的清单检查一次；没事回 HEARTBEAT_OK 就不打扰，有事才投递。默认用便宜模型。</p>
      <div class="form">
        <Field label="开关" wide><Toggle checked={h.enabled} onChange={(v) => set({ ...h, enabled: v })} label="开启 heartbeat" /></Field>
        <Field label="间隔（分钟）"><Input type="number" value={h.every_minutes} onInput={(v) => set({ ...h, every_minutes: v })} /></Field>
        <Field label="活跃时段" hint="时段外不跑，如 08:00-23:00；留空 = 全天"><Input value={h.active_hours} onInput={(v) => set({ ...h, active_hours: v })} /></Field>
        <Field label="投递到" hint="device:<设备id> / feishu:<账号>:<聊天id> / none"><Input value={h.delivery} onInput={(v) => set({ ...h, delivery: v })} /></Field>
      </div>
      <div class="row"><Btn kind="primary" onClick={() => save({ heartbeat: { ...h, every_minutes: Number(h.every_minutes) } })}>保存</Btn>
        <a href={`#/jobs/hb-${a.id}`}>查看运行记录 →</a></div>
    </Card>
  );
}

function A2ATab({ a, save }: { a: any; save: (p: any) => Promise<void> }) {
  const [all] = useLoad(() => api<any[]>("/agents"));
  const [allow, setAllow] = useState<string[]>(a.a2a.allow);
  const others = (all ?? []).filter((x) => x.id !== a.id);
  return (
    <Card>
      <p class="muted">{a.name} 可以主动联系哪些 agent（发消息、派子任务）。完整矩阵与通信记录在「Agent 通信」页。</p>
      <AllowList all={others.map((o) => ({ name: o.id, label: o.name }))} value={allow} onChange={setAllow} />
      <Btn kind="primary" onClick={() => save({ a2a: { allow } })}>保存</Btn>
    </Card>
  );
}
