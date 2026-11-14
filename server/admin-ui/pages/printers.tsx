// 3D 打印机：添加（IP / 序列号 / 访问码）、连接和打印状态、通知送到哪、原始数据。现在只读（看状态 + 打完 / 出错通知）
import { useState } from "preact/hooks";
import { api, ago, enc } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Field, Input, Select, Toggle, confirmDo, toast, toastErr, useInterval, useLoad } from "../ui.tsx";

const CONN: Record<string, [string, string]> = { online: ["ok", "已连接"], connecting: ["connecting", "连接中"], error: ["error", "连不上"], off: ["stopped", "已停用"] };
const DELIVERED = (to: string) => !to ? "没送出去：没有设投递目标，也没有在线的设备"
  : to.startsWith("muted:") ? `按语音推送的设置没有播（${to.slice(6) === "away" ? "你不在家" : "已关闭语音推送"}）`
  : to.startsWith("held:") ? `设备 ${to.slice(5)} 现在是别的角色，留言了，切过来时播` : `已送到 ${to}`;

export function Printers() {
  const [d, reload, err] = useLoad(() => api<any>("/printers"));
  const [edit, setEdit] = useState<string | null>(null);
  useInterval(reload, 5000);
  if (!d) return <Err msg={err} />;
  const act = (fn: () => Promise<any>, ok = "") => async () => { try { await fn(); if (ok) toast(ok); reload(); } catch (e) { toastErr(e); } };
  return (
    <>
      <div class="row"><Btn kind="primary" onClick={() => setEdit("")}>＋ 添加打印机</Btn></div>
      <Err msg={err} />
      {edit === "" && <PrinterForm d={d} done={() => { setEdit(null); reload(); }} />}
      {d.printers.length === 0 && edit === null && <Card><Empty>还没有打印机。支持拓竹（Bambu Lab）：和这台电脑在同一个局域网即可，不用开「开发者模式」</Empty></Card>}
      {d.printers.map((p: any) => edit === p.id ? <PrinterForm d={d} p={p} done={() => { setEdit(null); reload(); }} /> : (
        <Card title={<>{p.name} <Badge s={CONN[p.enabled ? p.conn : "off"]?.[0] ?? p.conn} text={CONN[p.enabled ? p.conn : "off"]?.[1] ?? p.conn} /></>}
          actions={<>
            <Btn small onClick={async () => { try { const r = await api(`/printers/${enc(p.id)}/test-notify`, { body: {} }); toast(DELIVERED(r.delivered)); } catch (e) { toastErr(e); } }}>发一条测试通知</Btn>
            <Btn small onClick={() => setEdit(p.id)}>编辑</Btn>
            <Btn small kind="danger" onClick={confirmDo(`删除 ${p.name}？`, act(() => api(`/printers/${enc(p.id)}`, { method: "DELETE" })))}>删除</Btn>
          </>}>
          {p.error ? <div class="errbox">{p.error}{" "}
            {p.error.startsWith("证书") ? <Btn small onClick={confirmDo("确认这是你的打印机（恢复过出厂设置 / 换过机器）？", act(() => api(`/printers/${enc(p.id)}/retrust`, { body: {} }), "已重新信任"))}>重新信任</Btn>
              : <Btn small onClick={act(() => api(`/printers/${enc(p.id)}/reconnect`, { body: {} }))}>重连</Btn>}</div> : null}
          {p.text ? <p>{p.text}</p> : p.conn === "online" ? <p class="muted">已连接，等打印机发状态…</p> : null}
          <small class="muted">{p.host} · {p.serial}{p.last_seen ? ` · ${ago(Math.max(0, Date.now() / 1000 - p.last_seen))}更新` : ""} · 通知：{p.delivery || "跟 heartbeat 的投递目标"}</small>
          {p.conn === "online" && <Raw id={p.id} />}
        </Card>
      ))}
    </>
  );
}

/** 打印机发来的原始状态：哪项显示得不对，照着这里核对 */
function Raw({ id }: { id: string }) {
  const [raw, setRaw] = useState<string | null>(null);
  return (
    <details onToggle={async (e: any) => { if (e.target.open) { try { setRaw(JSON.stringify((await api<any>(`/printers/${enc(id)}/raw`)).raw, null, 2)); } catch (x) { toastErr(x); } } }}>
      <summary class="muted">原始数据</summary>
      {raw !== null && <><Btn small onClick={() => { void navigator.clipboard?.writeText(raw); toast("已复制"); }}>复制</Btn><pre>{raw}</pre></>}
    </details>
  );
}

function PrinterForm({ d, p, done }: { d: any; p?: any; done: () => void }) {
  const [f, set] = useState({
    name: p?.name ?? "P2S", host: p?.host ?? "", serial: p?.serial ?? "", access_code: "", enabled: p?.enabled ?? true,
    agent: p?.agent ?? "", delivery: p?.delivery ?? "", warnings: p?.warnings ?? true,
  });
  const save = async () => {
    try {
      await api(p ? `/printers/${enc(p.id)}` : "/printers", { method: p ? "PUT" : "POST", body: f });
      toast("已保存，正在连接");
      done();
    } catch (e) { toastErr(e); }
  };
  return (
    <Card title={p ? `编辑 ${p.name}` : "添加打印机（拓竹）"} actions={<Btn small kind="ghost" onClick={done}>取消</Btn>}>
      <div class="form">
        <Field label="名字"><Input value={f.name} onInput={(v) => set({ ...f, name: v })} /></Field>
        <Field label="IP 地址" hint="打印机屏幕：设置 → 局域网"><Input value={f.host} onInput={(v) => set({ ...f, host: v })} placeholder="192.168.1.50" /></Field>
        <Field label="序列号" hint="打印机屏幕：设置 → 设备信息"><Input value={f.serial} onInput={(v) => set({ ...f, serial: v })} /></Field>
        <Field label="访问码" hint={p?.has_code ? "留空 = 不改" : "打印机屏幕：设置 → 局域网"}><Input type="password" value={f.access_code} onInput={(v) => set({ ...f, access_code: v })} /></Field>
        <Field label="谁来通知"><Select value={f.agent} onChange={(v) => set({ ...f, agent: v })} options={[["", "默认 agent"], ...d.agents.map((a: any) => [a.id, a.name] as [string, string])]} /></Field>
        <Field label="通知送到" hint="留空 = 跟她的 heartbeat 投递目标"><Input value={f.delivery} onInput={(v) => set({ ...f, delivery: v })} placeholder="device:<id> / feishu:<账号>:<聊天id>" /></Field>
        <Field label="其他" wide>
          <Toggle checked={f.enabled} onChange={(v) => set({ ...f, enabled: v })} label="启用" />{" "}
          <Toggle checked={f.warnings} onChange={(v) => set({ ...f, warnings: v })} label="打印中的严重告警也通知" />
        </Field>
      </div>
      <Btn kind="primary" onClick={save} disabled={!f.host.trim() || !f.serial.trim() || (!p?.has_code && !f.access_code.trim())}>保存</Btn>
    </Card>
  );
}
