// 设备：绑定哪个 agent、在线状态与遥测、设备日志、崩溃报告、最近一条录音试听；监控页（拍照/直播/定时拍照）嵌入
import { useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { api, ago, enc, fmtTime } from "../api.ts";
import { DeviceFiles } from "./devicefiles.tsx";
import { Badge, Btn, Card, Empty, Err, Field, Input, Select, Tabs, toast, useInterval, useLoad } from "../ui.tsx";

export function Devices() {
  const [devs, reload, err] = useLoad(() => api<any[]>("/devices"));
  const [roles] = useLoad(() => api<any[]>("/roles"));
  const [tab, setTab] = useState<"list" | "files" | "monitor" | "crash">("list");
  const [adding, setAdding] = useState(false);
  const [sel, setSel] = useState("");
  useInterval(reload, 10_000);
  const cur = sel || devs?.[0]?.id || "";
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[["list", "设备与日志"], ["files", "图片与代码"], ["monitor", "监控页（拍照 / 直播）"], ["crash", "崩溃报告"]]} />
      <Err msg={err} />
      {tab === "list" && <>
        <Card title="设备" actions={<Btn small onClick={() => setAdding(!adding)}>{adding ? "收起" : "＋ 添加手机"}</Btn>}>
          {adding && <AddPhone onDone={reload} />}
          {devs?.length ? <table class="hover"><thead><tr><th>设备</th><th>状态</th><th>电量</th><th>信号</th><th>看门狗</th><th title="扬声器音量">音量</th><th title="受信设备的对话可使用执行命令等功能">受信</th><th>当前角色</th></tr></thead>
            <tbody>{devs.map((d) => (
              <tr class={d.id === cur ? "on" : ""} onClick={() => setSel(d.id)}>
                <td>{d.kind === "phone" ? <>📱 {d.name} <small class="muted">{d.id}</small></> : d.id}</td>
                <td>{d.kind === "phone"
                  ? <><Badge s={d.online ? "online" : "stopped"} text={d.online ? "页面开着" : "未打开"} /> {d.secs_ago != null && <small class="muted">{ago(d.secs_ago)}</small>}</>
                  : <><Badge s={d.online ? "online" : "stopped"} text={d.online ? "在线" : "离线"} /> <small class="muted">{ago(d.secs_ago)}</small></>}</td>
                <td>{d.bat != null ? `${d.bat}%` : "—"}</td><td>{d.rssi ?? "—"}</td><td>{d.wdt ?? "—"}</td>
                <td onClick={(e) => e.stopPropagation()}>{d.kind === "phone" ? <span class="muted">跟手机走</span> : <Volume id={d.id} value={d.vol} online={d.online} onDone={reload} />}</td>
                <td onClick={(e) => e.stopPropagation()}>{d.kind === "phone" ? <>
                  <Badge s="ok" text="配对令牌" />{" "}
                  <Btn small kind="ghost" onClick={async () => { const n = window.prompt("名称", d.name); if (!n) return; try { await api(`/clients/${enc(d.id)}/rename`, { body: { name: n } }); reload(); } catch (e: any) { toast(e.message, "err"); } }}>改名</Btn>
                  <Btn small kind="danger" onClick={async () => { if (!window.confirm(`吊销「${d.name}」？\n这台手机会立刻断开，要用的话得重新扫码。`)) return; try { await api(`/clients/${enc(d.id)}`, { method: "DELETE" }); reload(); } catch (e: any) { toast(e.message, "err"); } }}>吊销</Btn>
                </> : d.trust_mode === "all" ? <span class="muted">全部受信</span> : <>
                  <Badge s={d.trusted ? "ok" : "deferred"} text={d.trusted ? "受信" : "待批准"} /> <small class="muted">{d.ip}</small>{" "}
                  <Btn small kind={d.trusted ? "ghost" : "primary"} onClick={async () => {
                    if (!d.trusted && !window.confirm(`批准 ${d.id}（${d.ip}）？\n受信设备的对话可执行命令。`)) return;
                    try { await api(`/devices/${enc(d.id)}/trust`, { body: { trusted: !d.trusted } }); reload(); } catch (e: any) { toast(e.message, "err"); }
                  }}>{d.trusted ? "取消" : "批准"}</Btn></>}</td>
                <td onClick={(e) => e.stopPropagation()}>{(roles ?? []).length > 1 ? <Select value={d.role} onChange={async (v) => {
                  try { await api(`/devices/${enc(d.id)}`, { method: "PUT", body: { role: v } }); toast("已切换"); reload(); } catch (e: any) { toast(e.message, "err"); }
                }} options={(roles ?? []).map((r) => [r.id, `${r.name}（${r.agent}）`] as [string, string])} />
                  : <span>{(roles ?? [])[0]?.name ?? d.agent}</span>}</td>
              </tr>))}</tbody></table> : <Empty>暂无设备</Empty>}
          <p class="muted">首台设备自动受信，之后的新设备需批准才能使用执行命令等功能。手机靠扫码配对的令牌受信，丢了就吊销。</p>
        </Card>
        {(devs ?? []).filter((d) => d.held?.length).map((d) => (
          <Card title={`留言 · ${d.id}`} actions={<Btn small kind="ghost" onClick={async () => { try { await api(`/devices/${enc(d.id)}/held`, { method: "DELETE" }); reload(); } catch (e: any) { toast(e.message, "err"); } }}>清空</Btn>}>
            <p class="muted">切换到对应角色后播放。</p>
            <table><tbody>{d.held.map((h: any) => <tr><td>{h.agent}</td><td class="muted">{fmtTime(h.at)}</td><td>{h.text.slice(0, 80)}</td></tr>)}</tbody></table>
          </Card>))}
        {cur && <DeviceLogs id={cur} />}
      </>}
      {tab === "files" && <DeviceFiles />}
      {tab === "monitor" && <iframe class="monitor" src="/monitor" />}
      {tab === "crash" && <Crashes />}
    </>
  );
}

/** 音量滑块：松手才下发，下发后设备用当前角色的声音说一句「现在的音量是…」 */
function Volume({ id, value, online, onDone }: { id: string; value: number | null; online: boolean; onDone: () => void }) {
  const [v, setV] = useState<number | null>(null);
  const shown = v ?? value;
  if (shown == null) return <span class="muted" title="设备代码更新后才会上报音量">—</span>;
  const send = async (level: number) => {
    try { await api(`/devices/${enc(id)}/volume`, { body: { level, test: true } }); toast(`音量 ${level}%`); onDone(); }
    catch (e: any) { toast(e.message, "err"); }
    finally { setV(null); }
  };
  return (
    <span class="vol">
      <input type="range" min={10} max={100} step={5} value={shown} disabled={!online} title={online ? "" : "设备离线"}
        onInput={(e) => setV(Number((e.target as HTMLInputElement).value))}
        onChange={(e) => send(Number((e.target as HTMLInputElement).value))} />
      <small class="mono">{shown}%</small>
    </span>
  );
}

function DeviceLogs({ id }: { id: string }) {
  const [d, reload] = useLoad(() => api(`/devices/${enc(id)}/logs?n=200`), [id]);
  const [audio, setAudio] = useState("");
  return (
    <Card title={`${id} 的日志`} actions={<>
      <Btn small onClick={async () => { try { setAudio(URL.createObjectURL(await api<Blob>(`/devices/${enc(id)}/audio`))); } catch (e: any) { toast(e.message, "err"); } }}>听最近一条录音</Btn>
      <Btn small onClick={reload}>刷新</Btn></>}>
      {audio && <audio controls autoPlay src={audio} />}
      <p class="muted">录音不清晰为设备端问题，清晰但识别错误为 ASR 问题。</p>
      {d?.heartbeat && <details><summary>最近一次心跳</summary><pre>{JSON.stringify(d.heartbeat, null, 2)}</pre></details>}
      <pre class="log">{(d?.lines ?? []).join("\n") || "（没有日志）"}</pre>
    </Card>
  );
}

function Crashes() {
  const [list] = useLoad(() => api<any[]>("/crash-reports"));
  const [cur, setCur] = useState<{ name: string; content: string } | null>(null);
  return (
    <Card title="崩溃报告">
      {list?.length ? <ul class="links">{list.map((c) => (
        <li><a onClick={async () => setCur({ name: c.name, content: (await api(`/crash-reports/${enc(c.name)}`)).content })}>{c.name}</a> <small class="muted">{c.size} 字节</small></li>))}</ul>
        : <Empty>无崩溃报告</Empty>}
      {cur && <><h4>{cur.name}（死因在末尾）</h4><pre class="log">{cur.content}</pre></>}
    </Card>
  );
}

/** 添加手机 / 平板：生成配对二维码（手机打开 /app 就是一台新设备，也能远程看 CoreS3） */
function AddPhone({ onDone }: { onDone: () => void }) {
  const [d] = useLoad(() => api<any>("/clients"));
  const saved = (() => { try { return localStorage.getItem("kagura_phone_base") || ""; } catch { return ""; } })();
  const [base, setBase] = useState(saved);
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ link: string; name: string; svg: string } | null>(null);
  const guess = d?.lan?.[0] ? `http://${d.lan[0]}:${d.port}` : "";
  const b = (base || guess).trim().replace(/\/+$/, "");
  const https = /^https:/.test(b);
  const add = async () => {
    if (!b) return toast("先填手机能访问到的地址", "err");
    try {
      const r = await api<any>("/clients", { body: { name: name || "我的手机", base: b } });
      try { localStorage.setItem("kagura_phone_base", base); } catch { /* 无痕模式 */ }
      const qr = qrcode(0, "M");
      qr.addData(r.link);
      qr.make();
      setMade({ link: r.link, name: r.client.name, svg: qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true }) });
      setName("");
      onDone();
    } catch (e: any) { toast(e.message, "err"); }
  };
  return (
    <div class="card" style="margin-bottom:12px">
      <p class="muted">手机扫码打开即可对话，记忆和角色与其它设备共用。</p>
      <div class="form">
        <Field label="手机能访问到的地址" wide hint={https ? "HTTPS 地址：按住说话也能用。" : <>局域网 http 地址：打字、听她说话、收推送、拍照、看家都能用，只有「按住说话」不行（浏览器只在 <b>HTTPS</b> 下让网页录音），且只能在家里 WiFi 下用。想按住说话、出门在外也能连：装 Tailscale 用它给的 https 地址，见 README「手机客户端」。</>}>
          <Input value={base} placeholder={guess || "https://你的电脑.tail1234.ts.net"} onInput={setBase} />
        </Field>
        <Field label="名称"><Input value={name} placeholder="我的手机" onInput={setName} /></Field>
      </div>
      <div class="row"><Btn kind="primary" onClick={add}>生成配对二维码</Btn></div>
      {made && <div style="margin-top:12px; display:flex; gap:16px; align-items:center; flex-wrap:wrap">
        <div style="width:200px; height:200px; background:#fff; border-radius:8px; padding:6px" dangerouslySetInnerHTML={{ __html: made.svg }} />
        <div style="flex:1; min-width:220px">
          <p><b>{made.name}</b>：用手机相机扫码打开（iPhone 在 Safari 里点「分享 → 添加到主屏幕」就像 App 一样用）。</p>
          <p class="muted">二维码里带着这台手机的令牌，只显示这一次，别发给别人。</p>
          <div class="row"><Btn small onClick={() => { navigator.clipboard?.writeText(made.link); toast("已复制配对链接"); }}>复制链接</Btn><Btn small kind="ghost" onClick={() => setMade(null)}>收起</Btn></div>
        </div>
      </div>}
    </div>
  );
}
