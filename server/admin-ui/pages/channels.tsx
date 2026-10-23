// 渠道：添加飞书 / QQ 账号（填凭据、测试连接）、在线状态、配对审批、白名单、聊天 → agent 绑定、群聊规则
import { useState } from "preact/hooks";
import { api, enc, fmtTime } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Field, Input, Select, Toggle, confirmDo, toast, useInterval, useLoad } from "../ui.tsx";

const KIND_LABEL: Record<string, string> = { feishu: "飞书 / Lark", qq: "QQ 官方机器人", onebot: "QQ（OneBot，非官方）" };
const CRED_FIELDS: Record<string, [string, string, string][]> = {
  feishu: [["app_id", "App ID", "cli_xxx"], ["app_secret", "App Secret", ""], ["domain", "版本", "feishu 或 lark（国际版）"]],
  qq: [["app_id", "AppID", ""], ["secret", "AppSecret", ""], ["sandbox", "沙箱环境", "1 = 用沙箱（调试用）"]],
  onebot: [["url", "WebSocket 地址", "ws://127.0.0.1:3001"], ["token", "access_token", "可选"]],
};
const GUIDE: Record<string, string> = {
  feishu: "飞书开放平台建「企业自建应用」→ 开启机器人能力 → 事件订阅选「使用长连接接收事件」并添加 im.message.receive_v1 → 权限加 im:message、im:message:send_as_bot、im:resource → 发布版本。不需要公网地址。",
  qq: "QQ 开放平台建机器人 → 开发设置里拿 AppID / AppSecret → 回调方式选 WebSocket → 开通单聊、群聊 @ 消息。不需要公网地址。被动回复 5 分钟内有效，主动推送有频次限制。",
  onebot: "⚠️ OneBot 是非官方协议（NapCat、LLOneBot 等），有封号风险，请用小号。在 OneBot 实现里开「正向 WebSocket」，把地址和 token 填到这里。",
};

export function Channels() {
  const [d, reload, err] = useLoad(() => api("/channels"));
  const [agents] = useLoad(() => api<any[]>("/agents"));
  const [edit, setEdit] = useState<any>(null);
  useInterval(reload, 5_000);
  if (!d) return <Err msg={err} />;
  const agentOpts: [string, string][] = [["", "默认 agent"], ...(agents ?? []).map((a) => [a.id, a.name] as [string, string])];
  return (
    <>
      {d.pairings.length > 0 && <Card title={`待审批的配对申请（${d.pairings.length}）`} class="warn">
        <table><thead><tr><th>账号</th><th>用户</th><th>配对码</th><th>时间</th><th></th></tr></thead>
          <tbody>{d.pairings.map((p: any) => <Pairing p={p} done={reload} />)}</tbody></table>
      </Card>}
      {edit ? <AccountForm a={edit} agentOpts={agentOpts} done={() => { setEdit(null); reload(); }} /> : (
        <Card title="账号" actions={<Btn kind="primary" onClick={() => setEdit({ kind: "feishu", credentials: {}, enabled: true, dm_policy: "pairing", group_policy: "mention", daily_limit: 200, voice_push: "home" })}>＋ 添加账号</Btn>}>
          {d.accounts.length ? <table class="hover"><thead><tr><th>名称</th><th>类型</th><th>状态</th><th>默认 agent</th><th>私聊</th><th>群聊</th><th></th></tr></thead>
            <tbody>{d.accounts.map((a: any) => (
              <tr onClick={() => setEdit(a)}>
                <td>{a.name} <small class="muted">{a.id}</small></td><td>{KIND_LABEL[a.kind]}</td>
                <td>{a.enabled ? <><Badge s={a.status?.state ?? "stopped"} /> <small class="muted">{a.status?.detail}</small></> : <Badge s="stopped" text="已停用" />}</td>
                <td>{a.agent || "默认"}</td><td>{{ pairing: "配对制", allowlist: "白名单", open: "开放" }[a.dm_policy as string]}</td>
                <td>{{ mention: "只回 @", all: "全部", off: "不理" }[a.group_policy as string]}</td>
                <td onClick={(e) => e.stopPropagation()}><Btn small onClick={async () => { const s = await api(`/channels/${enc(a.id)}/test`, { body: {} }); toast(s?.state === "online" ? "连接成功" : `连接失败：${s?.detail ?? ""}`, s?.state === "online" ? "ok" : "err"); reload(); }}>测试连接</Btn></td>
              </tr>))}</tbody></table> : <Empty>还没有接入任何 IM。添加后就能在手机上和她聊、把定时任务投递过去。</Empty>}
        </Card>
      )}
      <Allowed d={d} done={reload} />
      <Bindings d={d} agentOpts={agentOpts} done={reload} />
    </>
  );
}

function Pairing({ p, done }: { p: any; done: () => void }) {
  const [owner, setOwner] = useState(false);
  return (
    <tr><td>{p.account}</td><td>{p.name || p.user}</td><td><code>{p.code}</code></td><td>{fmtTime(p.ts)}</td>
      <td><Toggle checked={owner} onChange={setOwner} label="是主人" />
        <Btn small kind="primary" onClick={async () => { await api(`/channels/${enc(p.account)}/approve`, { body: { code: p.code, owner } }); toast("已批准"); done(); }}>批准</Btn>
        <Btn small kind="ghost" onClick={async () => { await api(`/channels/${enc(p.account)}/reject`, { body: { user: p.user } }); done(); }}>拒绝</Btn></td></tr>
  );
}

function AccountForm({ a, agentOpts, done }: { a: any; agentOpts: [string, string][]; done: () => void }) {
  const isNew = !a.id;
  const [f, set] = useState({ ...a, credentials: { ...a.credentials } });
  const save = async () => { await api("/channels", { body: f }); toast("已保存并重新连接"); done(); };
  return (
    <Card title={isNew ? "添加账号" : `编辑：${a.name}`} actions={<>
      {!isNew && <Btn kind="danger" onClick={confirmDo("删除这个账号？它的白名单和绑定会一起删掉。", async () => { await api(`/channels/${enc(a.id)}`, { method: "DELETE" }); done(); })}>删除</Btn>}
      <Btn kind="ghost" onClick={done}>取消</Btn></>}>
      <p class={f.kind === "onebot" ? "over" : "muted"}>{GUIDE[f.kind]}</p>
      <div class="form">
        <Field label="类型">{isNew ? <Select value={f.kind} onChange={(v) => set({ ...f, kind: v, credentials: {} })} options={Object.entries(KIND_LABEL) as [string, string][]} /> : <span>{KIND_LABEL[f.kind]}</span>}</Field>
        <Field label="id" hint="字母/数字，投递目标里要用：feishu:<id>:<聊天>">{isNew ? <Input value={f.id} onInput={(v) => set({ ...f, id: v })} /> : <code>{f.id}</code>}</Field>
        <Field label="名称"><Input value={f.name} onInput={(v) => set({ ...f, name: v })} /></Field>
        {CRED_FIELDS[f.kind].map(([k, l, ph]) => (
          <Field label={l}><Input type={/secret|token/.test(k) ? "password" : "text"} value={f.credentials[k] ?? ""} placeholder={ph} onInput={(v) => set({ ...f, credentials: { ...f.credentials, [k]: v } })} /></Field>))}
        <Field label="默认交给"><Select value={f.agent ?? ""} onChange={(v) => set({ ...f, agent: v })} options={agentOpts} /></Field>
        <Field label="私聊" hint="配对制：陌生人先拿到配对码，你在这里批准后才放行"><Select value={f.dm_policy} onChange={(v) => set({ ...f, dm_policy: v })} options={[["pairing", "配对制（推荐）"], ["allowlist", "只认白名单"], ["open", "完全开放"]]} /></Field>
        <Field label="群聊"><Select value={f.group_policy} onChange={(v) => set({ ...f, group_policy: v })} options={[["mention", "只回应 @ 机器人（推荐）"], ["all", "所有消息"], ["off", "不理群消息"]]} /></Field>
        <Field label="同时播语音" hint="主人私聊的回复要不要同时在家里设备上念出来（系统判断，不靠模型自觉）。在家状态来自设备蓝牙，也可以发 /home、/away 告诉它"><Select value={f.voice_push ?? "home"} onChange={(v) => set({ ...f, voice_push: v })} options={[["home", "在家时播（推荐）"], ["always", "总是播"], ["off", "不播"]]} /></Field>
        <Field label="每日上限" hint="每天最多回复多少条，0 = 不限（防陌生人刷额度）"><Input type="number" value={f.daily_limit} onInput={(v) => set({ ...f, daily_limit: Number(v) })} /></Field>
        <Field label="选项" wide><Toggle checked={f.enabled} onChange={(v) => set({ ...f, enabled: v })} label="启用" />
          <Toggle checked={f.owner_main} onChange={(v) => set({ ...f, owner_main: v })} label="主人的私聊并入 main 会话（和设备、heartbeat 共享上下文）" /></Field>
      </div>
      <Btn kind="primary" onClick={save} disabled={!f.id}>保存并连接</Btn>
    </Card>
  );
}

function Allowed({ d, done }: { d: any; done: () => void }) {
  if (!d.allowed.length) return null;
  return (
    <Card title="白名单（已批准的人）">
      <table><thead><tr><th>账号</th><th>用户</th><th>主人</th><th>加入时间</th><th></th></tr></thead>
        <tbody>{d.allowed.map((x: any) => (
          <tr><td>{x.account}</td><td>{x.name || x.user} <small class="muted">{x.user}</small></td>
            <td><input type="checkbox" checked={!!x.owner} onChange={async (e) => { await api(`/channels/${enc(x.account)}/allowed`, { method: "PUT", body: { user: x.user, name: x.name, owner: (e.target as HTMLInputElement).checked } }); done(); }} /></td>
            <td>{fmtTime(x.since)}</td>
            <td><Btn small kind="ghost" onClick={confirmDo("移出白名单？", async () => { await api(`/channels/${enc(x.account)}/allowed/${enc(x.user)}`, { method: "DELETE" }); done(); })}>移除</Btn></td></tr>))}</tbody></table>
    </Card>
  );
}

function Bindings({ d, agentOpts, done }: { d: any; agentOpts: [string, string][]; done: () => void }) {
  const [f, set] = useState({ account: d.accounts[0]?.id ?? "", chatId: "", agent: agentOpts[1]?.[0] ?? "", label: "" });
  if (!d.accounts.length) return null;
  const bind = async (b: any) => { await api("/channels/bindings", { method: "PUT", body: b }); done(); };
  return (
    <Card title="聊天 → agent 绑定">
      <p class="muted">某个群或私聊固定交给某个 agent（没绑定的走账号的默认 agent）。聊天 id 在服务端日志 <code>[channel] 💬</code> 那一行里能看到。</p>
      {d.bindings.length > 0 && <table><tbody>{d.bindings.map((b: any) => (
        <tr><td>{b.account}</td><td><code>{b.chatId}</code> {b.label}</td><td>→ {b.agent}</td><td><Btn small kind="ghost" onClick={() => bind({ ...b, agent: "" })}>解除</Btn></td></tr>))}</tbody></table>}
      <div class="row">
        <Select value={f.account} onChange={(v) => set({ ...f, account: v })} options={d.accounts.map((a: any) => [a.id, a.name] as [string, string])} />
        <Input value={f.chatId} onInput={(v) => set({ ...f, chatId: v })} placeholder="聊天 id（飞书 oc_xxx / QQ group:xxx）" />
        <Input value={f.label} onInput={(v) => set({ ...f, label: v })} placeholder="备注" />
        <Select value={f.agent} onChange={(v) => set({ ...f, agent: v })} options={agentOpts.slice(1)} />
        <Btn onClick={() => bind(f)} disabled={!f.chatId || !f.agent}>绑定</Btn>
      </div>
    </Card>
  );
}
