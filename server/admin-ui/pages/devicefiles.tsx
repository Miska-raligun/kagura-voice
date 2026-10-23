// 设备文件：给每个角色传背景图、更新设备代码。设备收到 MQTT 命令后自己来拉（device/src/ota.py）。
// 图片在浏览器里先裁成 320×240 JPEG 再传——手机原图几 MB，设备解不动。
import { useState } from "preact/hooks";
import { api, ago, enc } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Select, confirmDo, toast, toastErr, useInterval, useLoad } from "../ui.tsx";

const W = 320, H = 240;
const MAX_BYTES = 150 * 1024;

/** 任意图片 → 320×240 JPEG（居中裁切铺满），返回 base64 */
async function toDeviceJpeg(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const s = Math.max(W / bmp.width, H / bmp.height);
  const w = bmp.width * s, h = bmp.height * s;
  g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
  g.drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
  for (const q of [0.85, 0.75, 0.6, 0.45]) {
    const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("转换失败"))), "image/jpeg", q));
    if (blob.size <= MAX_BYTES || q === 0.45) return b64(await blob.arrayBuffer());
  }
  throw new Error("转换失败");
}

function b64(buf: ArrayBuffer) {
  let s = "";
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 弹出系统选文件框 */
function pick(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const el = document.createElement("input");
    el.type = "file"; el.accept = accept; el.multiple = multiple;
    el.onchange = () => resolve([...(el.files ?? [])]);
    el.click();
  });
}

export function DeviceFiles() {
  const [d, reload, err] = useLoad(() => api("/device-files"));
  const [role, setRole] = useState("");
  const [bust, setBust] = useState(Date.now());
  useInterval(reload, 8_000);
  if (!d) return <Err msg={err} />;
  const files = new Map<string, any>(d.files.map((f: any) => [f.p, f]));
  const refresh = () => { setBust(Date.now()); reload(); };
  const sync = async (scope: string) => {
    try {
      const r = await api("/device-files/sync", { body: { scope } });
      toast(scope === "code" ? `已通知 ${r.sent.join("、")}：请在设备屏幕上点「更新」` : `已通知 ${r.sent.join("、")} 同步`);
      reload();
    } catch (e) { toastErr(e); }
  };
  const resPath = (base: string, r = role) => `resource/${r ? r + "/" : ""}${base}.jpg`;
  const code = d.files.filter((f: any) => f.p.startsWith("src/"));

  return (
    <>
      <Err msg={err} />
      <Card title="同步状态" actions={<>
        <Btn small onClick={() => sync("res")}>同步图片</Btn>
        <Btn small kind="primary" onClick={() => sync("code")}>更新设备代码</Btn></>}>
        {!d.mqtt && <p class="over">MQTT 不可用，没法通知设备。</p>}
        {d.devices.length ? <table><thead><tr><th>设备</th><th>图片</th><th>代码</th><th>最近一次同步</th></tr></thead>
          <tbody>{d.devices.map((x: any) => (
            <tr>
              <td>{x.id} {!x.online && <Badge s="stopped" text="离线" />}</td>
              <td><RevBadge dev={x.res_rev} want={d.res_rev} /></td>
              <td><RevBadge dev={x.code_rev} want={d.code_rev} unknown="未知（手动烧录）" />{x.fw_version && <small class="muted"> {x.fw_version}</small>}</td>
              <td>{x.last_sync ? <>{x.last_sync.ok ? <Badge s="ok" text="成功" /> : <Badge s="error" text="失败" />}{" "}
                <small class="muted">{x.last_sync.ok ? `更新 ${x.last_sync.changed}、删除 ${x.last_sync.removed}` : x.last_sync.error} · {ago(Date.now() / 1000 - x.last_sync.ts)}</small></> : "—"}</td>
            </tr>))}</tbody></table> : <Empty>还没收到设备心跳。</Empty>}
        <p class="muted">图片传上去就会自动同步（设备离线的话下次开机补上）。代码更新要在设备屏幕上点「更新」，装完自动重启；
          新代码起不来会自动换回旧的（需要设备上的 /flash/main.py 是新版，固件包里有）。</p>
      </Card>

      <Card title="角色图片" actions={<Select value={role} onChange={setRole}
        options={d.roles.map((r: any) => [r.id, r.id ? `${r.name}（${r.id}）` : `${r.name}（默认）`] as [string, string])} />}>
        <p class="muted">{role ? "这个角色没传的图沿用默认角色的。" : "默认图：所有角色都没传时用这一套。"}任意图片都行，会自动裁成 320×240。</p>
        <div class="slots">{d.slots.map((s: any) => {
          const p = resPath(s.base), f = files.get(p), fallback = role ? files.get(resPath(s.base, "")) : null;
          return (
            <div class="slot">
              {f ? <img src={`/api/admin/device-files/raw?p=${enc(p)}&t=${bust}`} />
                : fallback ? <div class="ph"><img class="dim" src={`/api/admin/device-files/raw?p=${enc(fallback.p)}&t=${bust}`} /><span>沿用默认</span></div>
                  : <div class="ph"><span>未设置</span></div>}
              <div class="row"><b>{s.base}</b><small class="muted grow">{s.desc}</small></div>
              <div class="row">
                <Btn small onClick={async () => {
                  const [file] = await pick("image/*");
                  if (!file) return;
                  try { await api("/device-files", { method: "PUT", body: { p, b64: await toDeviceJpeg(file) } }); toast("已上传，正在同步到设备"); refresh(); } catch (e) { toastErr(e); }
                }}>{f ? "替换" : "上传"}</Btn>
                {f && <Btn small kind="danger" onClick={confirmDo(`删除 ${p}？设备上也会删掉。`, async () => {
                  try { await api(`/device-files?p=${enc(p)}`, { method: "DELETE" }); refresh(); } catch (e) { toastErr(e); }
                })}>删除</Btn>}
              </div>
            </div>);
        })}</div>
      </Card>

      <Card title={`设备代码（内置版本 ${d.version}）`} actions={<Btn small onClick={async () => {
        const list = await pick(".py", true);
        try {
          for (const file of list) await api("/device-files", { method: "PUT", body: { p: `src/${file.name}`, b64: b64(await file.arrayBuffer()) } });
          if (list.length) { toast(`已上传 ${list.length} 个文件，点「更新设备代码」装到设备上`); reload(); }
        } catch (e) { toastErr(e); }
      }}>上传 .py 覆盖</Btn>}>
        <p class="muted">服务端自带一份与它同版本的设备代码。自己改过的文件可以传上来覆盖同名内置文件，删掉覆盖就回到内置版本。</p>
        <table><thead><tr><th>文件</th><th>来源</th><th>大小</th><th /></tr></thead>
          <tbody>{code.map((f: any) => (
            <tr><td><code>{f.p.slice(4)}</code></td>
              <td>{f.source === "builtin" ? <Badge s="muted" text="内置" /> : <Badge s="deferred" text={f.overrides_builtin ? "自定义（覆盖内置）" : "自定义"} />}</td>
              <td>{(f.n / 1024).toFixed(1)}KB</td>
              <td>{f.source === "custom" && <Btn small kind="ghost" onClick={confirmDo(f.overrides_builtin ? `删掉覆盖，${f.p} 回到内置版本？` : `删除 ${f.p}？`, async () => {
                try { await api(`/device-files?p=${enc(f.p)}`, { method: "DELETE" }); reload(); } catch (e) { toastErr(e); }
              })}>{f.overrides_builtin ? "恢复内置" : "删除"}</Btn>}</td></tr>))}</tbody></table>
      </Card>
    </>
  );
}

function RevBadge(p: { dev: string | null; want: string; unknown?: string }) {
  if (!p.dev) return <Badge s="muted" text={p.unknown ?? "未同步过"} />;
  return p.dev === p.want ? <Badge s="ok" text="最新" /> : <Badge s="deferred" text="有更新" />;
}
