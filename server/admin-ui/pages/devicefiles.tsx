// 设备文件：给每个角色传背景图、更新设备代码。设备收到 MQTT 命令后自己来拉（device/src/ota.py）。
// 图片在浏览器里先裁成 320×240 JPEG 再传——手机原图几 MB，设备解不动。
// 手机 / 平板网页显示的是另一套（服务端 app_images/），不限尺寸比例，没传的图位沿用 CoreS3 这套。
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

const PHONE_MAX = 3.5 * 1024 * 1024, PHONE_SIDE = 2560;
/** 手机那套：原图够小就原样传；太大就缩到长边 2560 的 JPEG（不裁） */
async function toPhoneImage(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  if (/^image\/(jpeg|png|webp)$/.test(file.type) && file.size <= PHONE_MAX && Math.max(bmp.width, bmp.height) <= PHONE_SIDE) return b64(await file.arrayBuffer());
  const k = Math.min(1, PHONE_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  for (const q of [0.9, 0.82, 0.72, 0.6]) {
    const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("转换失败"))), "image/jpeg", q));
    if (blob.size <= PHONE_MAX || q === 0.6) return b64(await blob.arrayBuffer());
  }
  throw new Error("转换失败");
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
  const [target, setTarget] = useState("cores3");
  const [bust, setBust] = useState(Date.now());
  useInterval(reload, 8_000);
  if (!d) return <Err msg={err} />;
  const files = new Map<string, any>(d.files.map((f: any) => [f.p, f]));
  const refresh = () => { setBust(Date.now()); reload(); };
  const sync = async (scope: string) => {
    try {
      const r = await api("/device-files/sync", { body: { scope } });
      const msgs: string[] = [];
      if (r.sent.length) msgs.push(scope === "code" ? `已通知 ${r.sent.join("、")}，请在设备屏幕上确认更新` : `已通知 ${r.sent.join("、")} 同步图片`);
      if (r.up_to_date.length) msgs.push(`${r.up_to_date.join("、")} 已是最新`);
      if (r.offline.length) msgs.push(`${r.offline.join("、")} 不在线`);
      if (r.unsupported.length) msgs.push(`${r.unsupported.join("、")} 固件不支持在线更新`);
      toast(msgs.join("；"), r.sent.length ? "ok" : "err");
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
              <td>{x.ota_capable ? <RevBadge dev={x.res_rev} want={d.res_rev} /> : <Badge s="error" text="固件太旧，不支持" />}</td>
              <td>{x.ota_capable ? <RevBadge dev={x.code_rev} want={d.code_rev} unknown="未知（手动烧录）" /> : <Badge s="error" text="先用 USB 刷一次" />}{x.fw_version && <small class="muted"> {x.fw_version}</small>}</td>
              <td>{x.last_sync ? <>{x.last_sync.ok ? <Badge s="ok" text="成功" /> : <Badge s="error" text="失败" />}{" "}
                <small class="muted">{x.last_sync.ok ? `更新 ${x.last_sync.changed}、删除 ${x.last_sync.removed}` : x.last_sync.error} · {ago(Date.now() / 1000 - x.last_sync.ts)}</small></> : "—"}</td>
            </tr>))}</tbody></table> : <Empty>暂无设备</Empty>}
        <p class="muted">图片上传后自动同步；代码更新需在设备屏幕上确认，启动失败会自动回滚。</p>
        {d.devices.some((x: any) => !x.ota_capable) && <p class="over">部分设备固件不支持在线更新：请先通过 USB 上传固件包中的 <code>flash/main.py</code> 与 <code>flash/kagura/src/*.py</code>。</p>}
      </Card>

      <Card title="角色图片" actions={<>
        <Select value={target} onChange={setTarget} options={[["cores3", "CoreS3"], ["phone", "手机 / 平板"]]} />
        <Select value={role} onChange={setRole}
          options={d.roles.map((r: any) => [r.id, r.id ? `${r.name}（${r.id}）` : `${r.name}（默认）`] as [string, string])} /></>}>
        {target === "phone" ? <PhoneImages role={role} slots={d.slots} coreFiles={files} /> : <>
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
                  try { await api("/device-files", { method: "PUT", body: { p, b64: await toDeviceJpeg(file) } }); toast("已上传"); refresh(); } catch (e) { toastErr(e); }
                }}>{f ? "替换" : "上传"}</Btn>
                {f && <Btn small kind="danger" onClick={confirmDo(`删除 ${p}？设备上也会删掉。`, async () => {
                  try { await api(`/device-files?p=${enc(p)}`, { method: "DELETE" }); refresh(); } catch (e) { toastErr(e); }
                })}>删除</Btn>}
              </div>
            </div>);
        })}</div></>}
      </Card>

      <Card title={`设备代码（内置版本 ${d.version}）`} actions={<Btn small onClick={async () => {
        const list = await pick(".py", true);
        try {
          for (const file of list) await api("/device-files", { method: "PUT", body: { p: `src/${file.name}`, b64: b64(await file.arrayBuffer()) } });
          if (list.length) { toast(`已上传 ${list.length} 个文件`); reload(); }
        } catch (e) { toastErr(e); }
      }}>上传 .py 覆盖</Btn>}>
        <p class="muted">内置与服务端同版本的设备代码；上传的文件覆盖同名内置文件。</p>
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

/** 手机 / 平板显示的那套：每个图位单独传，没传的沿用 CoreS3 那套（先角色的、再默认的），手机这套缺了某个状态用它自己的待机图 */
function PhoneImages(p: { role: string; slots: any[]; coreFiles: Map<string, any> }) {
  const [d, reload, err] = useLoad(() => api("/app-images"));
  const [bust, setBust] = useState(Date.now());
  if (!d) return <Err msg={err} />;
  const has = (role: string, name: string) => d.files.find((f: any) => f.role === role && f.name === name);
  const raw = (role: string, name: string) => `/api/admin/app-images/raw?role=${enc(role)}&name=${name}&t=${bust}`;
  const core = (role: string, name: string) => p.coreFiles.get(`resource/${role ? role + "/" : ""}${name}.jpg`);
  const refresh = () => { setBust(Date.now()); reload(); };
  /** 和服务端 /app/img 同一个顺序：先角色、再默认；同一层手机优先；缺状态退回待机图 */
  const fallback = (name: string): { src: string; text: string } | null => {
    for (const ro of p.role ? [p.role, ""] : [""]) {
      for (const n of name === "img_bg" ? [name] : [name, "img_bg"]) {
        if ((ro !== p.role || n !== name) && has(ro, n)) return { src: raw(ro, n), text: `沿用手机${ro === p.role ? "" : "默认角色"}${n === name ? "" : "的待机图"}` };
      }
      for (const n of name === "img_bg" ? [name] : [name, "img_bg"]) {
        const f = core(ro, n);
        if (f) return { src: `/api/admin/device-files/raw?p=${enc(f.p)}&t=${bust}`, text: `沿用 CoreS3${ro === p.role ? "" : "默认角色"}${n === name ? "" : "的待机图"}` };
      }
    }
    return null;
  };
  return <>
    <p class="muted">手机 / 平板网页上显示的图，和 CoreS3 分开存：不裁切、不限比例（竖图也行），单张最大 4MB，太大的会自动缩到长边 {PHONE_SIDE}。没传的沿用 CoreS3 那套。手机上点右上角「形象」也能改。</p>
    <div class="slots">{p.slots.map((s: any) => {
      const own = has(p.role, s.base), fb = own ? null : fallback(s.base);
      return (
        <div class="slot">
          {own ? <img class="tall" src={raw(p.role, s.base)} />
            : fb ? <div class="ph tall"><img class="dim" src={fb.src} /><span>{fb.text}</span></div>
              : <div class="ph tall"><span>未设置</span></div>}
          <div class="row"><b>{s.base}</b><small class="muted grow">{s.desc}{own && ` · ${own.ext.toUpperCase()} ${(own.n / 1024).toFixed(0)}KB`}</small></div>
          <div class="row">
            <Btn small onClick={async () => {
              const [file] = await pick("image/*");
              if (!file) return;
              try { await api("/app-images", { method: "PUT", body: { role: p.role, name: s.base, b64: await toPhoneImage(file) } }); toast("已上传，开着的手机页面会自动换上"); refresh(); } catch (e) { toastErr(e); }
            }}>{own ? "替换" : "上传"}</Btn>
            {own && <Btn small kind="danger" onClick={confirmDo(`删除手机的 ${p.role || "默认"}/${s.base}？之后沿用 CoreS3 那套。`, async () => {
              try { await api(`/app-images?role=${enc(p.role)}&name=${s.base}`, { method: "DELETE" }); refresh(); } catch (e) { toastErr(e); }
            })}>删除</Btn>}
          </div>
        </div>);
    })}</div>
  </>;
}

function RevBadge(p: { dev: string | null; want: string; unknown?: string }) {
  if (!p.dev) return <Badge s="muted" text={p.unknown ?? "未同步过"} />;
  return p.dev === p.want ? <Badge s="ok" text="最新" /> : <Badge s="deferred" text="有更新" />;
}
