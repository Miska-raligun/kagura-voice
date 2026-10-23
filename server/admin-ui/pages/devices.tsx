// 设备：绑定哪个 agent、在线状态与遥测、设备日志、崩溃报告、最近一条录音试听；监控页（拍照/直播/定时拍照）嵌入
import { useState } from "preact/hooks";
import { api, ago, enc } from "../api.ts";
import { DeviceFiles } from "./devicefiles.tsx";
import { Badge, Btn, Card, Empty, Err, Select, Tabs, toast, useInterval, useLoad } from "../ui.tsx";

export function Devices() {
  const [devs, reload, err] = useLoad(() => api<any[]>("/devices"));
  const [roles] = useLoad(() => api<any[]>("/roles"));
  const [tab, setTab] = useState<"list" | "files" | "monitor" | "crash">("list");
  const [sel, setSel] = useState("");
  useInterval(reload, 10_000);
  const cur = sel || devs?.[0]?.id || "";
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[["list", "设备与日志"], ["files", "图片与代码"], ["monitor", "监控页（拍照 / 直播）"], ["crash", "崩溃报告"]]} />
      <Err msg={err} />
      {tab === "list" && <>
        <Card title="设备">
          {devs?.length ? <table class="hover"><thead><tr><th>设备</th><th>状态</th><th>电量</th><th>信号</th><th>看门狗</th><th title="受信设备的对话才能用执行命令、扩展等高风险功能">受信</th><th>当前角色</th></tr></thead>
            <tbody>{devs.map((d) => (
              <tr class={d.id === cur ? "on" : ""} onClick={() => setSel(d.id)}>
                <td>{d.id}</td><td><Badge s={d.online ? "online" : "stopped"} text={d.online ? "在线" : "离线"} /> <small class="muted">{ago(d.secs_ago)}</small></td>
                <td>{d.bat ?? "—"}%</td><td>{d.rssi ?? "—"}</td><td>{d.wdt ?? "—"}</td>
                <td onClick={(e) => e.stopPropagation()}>{d.trust_mode === "all" ? <span class="muted">全部受信</span> : <>
                  <Badge s={d.trusted ? "ok" : "deferred"} text={d.trusted ? "受信" : "待批准"} /> <small class="muted">{d.ip}</small>{" "}
                  <Btn small kind={d.trusted ? "ghost" : "primary"} onClick={async () => {
                    if (!d.trusted && !window.confirm(`批准 ${d.id}（${d.ip}）？\n受信设备的对话能让 agent 执行命令、装扩展。确认这是你自己的设备。`)) return;
                    try { await api(`/devices/${enc(d.id)}/trust`, { body: { trusted: !d.trusted } }); reload(); } catch (e: any) { toast(e.message, "err"); }
                  }}>{d.trusted ? "取消" : "批准"}</Btn></>}</td>
                <td onClick={(e) => e.stopPropagation()}>{(roles ?? []).length > 1 ? <Select value={d.role} onChange={async (v) => {
                  try { await api(`/devices/${enc(d.id)}`, { method: "PUT", body: { role: v } }); toast("已切换：设备会换图，并用新角色的声音问好"); reload(); } catch (e: any) { toast(e.message, "err"); }
                }} options={(roles ?? []).map((r) => [r.id, `${r.name}（${r.agent}）`] as [string, string])} />
                  : <span>{(roles ?? [])[0]?.name ?? d.agent}</span>}</td>
              </tr>))}</tbody></table> : <Empty>还没收到设备心跳。设备开机、连上 WiFi 后会自动出现。</Empty>}
          <p class="muted">第一台连上来的设备自动受信；之后新出现的设备要在这里批准，它的语音对话才能用执行命令、扩展这些高风险功能（防止同一 WiFi 下有人冒充设备）。没批准的设备照常能聊天。</p>
        </Card>
        {cur && <DeviceLogs id={cur} />}
      </>}
      {tab === "files" && <DeviceFiles />}
      {tab === "monitor" && <iframe class="monitor" src="/monitor" />}
      {tab === "crash" && <Crashes />}
    </>
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
      <p class="muted">先听这条录音：糊 = 设备端问题，清楚却认不出 = 语音识别问题。</p>
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
        : <Empty>没有崩溃报告 ✓</Empty>}
      {cur && <><h4>{cur.name}（死因在末尾）</h4><pre class="log">{cur.content}</pre></>}
    </Card>
  );
}
