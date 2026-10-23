// 扩展 / MCP：pi 格式的扩展（agent 自己写的工具也在这）+ MCP 服务器配置（mcp.json，与 pi 同格式）。
// 路由参数：#/plugins/ext|<owner>|<name>  或  #/plugins/mcp
import { useEffect, useState } from "preact/hooks";
import { api, enc, go } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Field, Input, Select, Split, Tabs, TextArea, confirmDo, toast, toastErr, useLoad } from "../ui.tsx";

const GLOBAL = "~global";

export function Plugins({ arg }: { arg: string }) {
  const [tab = "ext", ...rest] = arg.split("|");
  return (
    <>
      <Tabs value={tab as "ext" | "mcp"} onChange={(v) => go("plugins", v)} tabs={[["ext", "扩展（自定义工具）"], ["mcp", "MCP 服务器"]]} />
      {tab === "mcp" ? <Mcp /> : <Exts owner={rest[0] ?? ""} name={rest[1] ?? ""} />}
    </>
  );
}

function ExtView({ e }: { e: any }) {
  return (
    <>
      {e.error ? <div class="errbox"><b>加载失败</b><pre>{e.error}</pre></div>
        : <p>工具：{e.tools.length ? e.tools.map((t: any) => <><code>{t.name}</code>{t.allowUntrusted ? <small class="muted">（陌生人也能用）</small> : null} </>) : <span class="muted">（没有注册工具）</span>}
          {e.mcpServers.length ? <> · MCP：{e.mcpServers.map((m: string) => <code>{m}</code>)}</> : null}</p>}
      {e.unsupported?.length ? <p class="muted">这些 pi API 这里不支持、已忽略：{e.unsupported.join("、")}</p> : null}
    </>
  );
}

function Exts({ owner, name }: { owner: string; name: string }) {
  const [d, reload, err] = useLoad(() => api("/extensions"));
  const [creating, setCreating] = useState(false);
  if (!d) return <Err msg={err} />;
  const ownerName = (id: string) => (id === GLOBAL ? "全局" : id);
  return (
    <Split left={<>
      <div class="row">
        <Btn small kind="primary" onClick={() => { setCreating(true); go("plugins", "ext"); }}>＋ 新建扩展</Btn>
        <Btn small onClick={async () => { await api("/extensions/reload", { body: {} }); toast("已重新加载"); reload(); }}>重新加载</Btn>
      </div>
      {d.owners.map((o: any) => {
        const list = d.extensions.filter((e: any) => e.owner === o.id);
        return list.length ? <>
          <h4 class="muted">{ownerName(o.id)}</h4>
          <ul class="list">{list.map((e: any) => (
            <li class={e.owner === owner && e.name === name ? "on" : ""} onClick={() => { setCreating(false); go("plugins", `ext|${e.owner}|${e.name}`); }}>
              <b>{e.name} {e.error ? <Badge s="error" /> : null}</b>
              <small>{e.error ? e.error.split("\n")[0] : e.tools.map((t: any) => t.name).join("、") || "（没有工具）"}</small>
            </li>))}</ul></> : null;
      })}
      {!d.extensions.length && <Empty>还没有扩展。可以自己写，也可以在聊天里让 agent 给自己写一个工具。</Empty>}
    </>}>
      {creating ? <NewExt owners={d.owners} template={d.template} done={(o, n) => { setCreating(false); reload(); go("plugins", `ext|${o}|${n}`); }} />
        : name ? <ExtDetail key={owner + name} owner={owner} name={name} info={d.extensions.find((e: any) => e.owner === owner && e.name === name)}
          onChanged={reload} onDeleted={() => { reload(); go("plugins", "ext"); }} />
        : <Card title="扩展是什么">
          <p>扩展 = 一个 TypeScript / JavaScript 文件，格式与 pi 的扩展一致：<code>export default function (pi) {"{"} pi.registerTool({"{"}…{"}"}) {"}"}</code>。
            注册的工具 agent 直接就能调用，还可以用 <code>pi.registerMcpServer()</code> 带上 MCP 服务器。</p>
          <p><b>agent 能自己给自己写工具</b>：在可信的对话里（网页聊天、设备、主人私聊）它有 <code>extension_write</code> 等工具，写完马上加载、有错看报错再改，下一轮就能用。
            想要什么能力直接跟它说「给自己写个工具，用来……」。</p>
          <p class="muted">扩展代码在这台电脑上运行，权限和服务端一样大。所以扩展里的工具默认只在可信对话里出现；
            要让 IM 里的陌生人也能用，在工具定义里加 <code>allowUntrusted: true</code>。
            全局扩展放在 <code>{d.global_dir}</code>，「只给某个 agent」的放在它工作目录的 extensions/ 下。
            pi 的界面类 API（命令、快捷键、TUI）这里没有，会被忽略。</p>
        </Card>}
    </Split>
  );
}

function NewExt({ owners, template, done }: { owners: any[]; template: string; done: (owner: string, name: string) => void }) {
  const [f, set] = useState({ owner: GLOBAL, name: "", code: template });
  return (
    <Card title="新建扩展">
      <div class="form">
        <Field label="名字" hint="字母、数字、_ -，当作文件名"><Input value={f.name} onInput={(v) => set({ ...f, name: v })} placeholder="my-tools" /></Field>
        <Field label="给谁用"><Select value={f.owner} onChange={(v) => set({ ...f, owner: v })} options={owners.map((o: any) => [o.id, o.name] as [string, string])} /></Field>
        <Field label="代码" wide><TextArea value={f.code} onInput={(v) => set({ ...f, code: v })} rows={20} mono /></Field>
      </div>
      <Btn kind="primary" onClick={async () => {
        try {
          const r = await api(`/extensions/${enc(f.owner)}/${enc(f.name)}`, { method: "PUT", body: { code: f.code } });
          r.error ? toast("已保存，但加载失败，看右侧报错", "err") : toast("已保存并加载");
          done(f.owner, f.name);
        } catch (e) { toastErr(e); }
      }}>保存并加载</Btn>
    </Card>
  );
}

function ExtDetail({ owner, name, info, onChanged, onDeleted }: { owner: string; name: string; info: any; onChanged: () => void; onDeleted: () => void }) {
  const url = `/extensions/${enc(owner)}/${enc(name)}`;
  const [code, setCode] = useState<string | null>(null);
  const [orig, setOrig] = useState("");
  const [file, setFile] = useState("");
  const [err, setErr] = useState("");
  const [cur, setCur] = useState<any>(info);
  useEffect(() => { api(url).then((r) => { setCode(r.code); setOrig(r.code); setFile(r.file); }).catch((e) => setErr(e.message)); }, [url]);
  useEffect(() => setCur(info), [info]);
  if (err) return <Err msg={err} />;
  if (code === null) return <div class="muted">加载中…</div>;
  return (
    <Card title={`${name}（${owner === GLOBAL ? "全局" : `只给 ${owner}`}）`} actions={
      <Btn small kind="danger" onClick={confirmDo(`删除扩展 ${name}？（挪进回收站 .trash）`, async () => {
        try { await api(url, { method: "DELETE" }); toast("已删除"); onDeleted(); } catch (e) { toastErr(e); }
      })}>删除</Btn>}>
      <p class="muted">文件：<code>{file}</code></p>
      {cur && <ExtView e={cur} />}
      <TextArea value={code} onInput={setCode} rows={24} mono />
      <div class="row"><span class="grow" />{code !== orig && <span class="muted">未保存</span>}
        <Btn kind="primary" disabled={code === orig} onClick={async () => {
          try {
            const r = await api(url, { method: "PUT", body: { code } });
            setOrig(code); setCur(r);
            r.error ? toast("已保存，但加载失败", "err") : toast("已保存并加载，下一轮对话生效");
            onChanged();
          } catch (e) { toastErr(e); }
        }}>保存并加载</Btn></div>
    </Card>
  );
}

const MCP_EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/docs"]
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer \${MY_TOKEN}" }
    }
  }
}`;

function Mcp() {
  const [d, reload, err] = useLoad(() => api("/mcp"));
  const [text, setText] = useState<string | null>(null);
  useEffect(() => { if (d && text === null) setText(d.config || ""); }, [d]);
  if (!d) return <Err msg={err} />;
  const dirty = text !== null && text.trim() !== (d.config || "").trim();
  return (
    <>
      <Card title="服务器" actions={<Btn small onClick={reload}>刷新</Btn>}>
        {d.servers.length ? <table><thead><tr><th>名字</th><th>状态</th><th>工具</th><th /></tr></thead><tbody>
          {d.servers.map((s: any) => (
            <tr>
              <td><b>{s.name}</b>{s.allowUntrusted ? <small class="muted">（陌生人也能用）</small> : null}<br /><small class="muted">{s.transport} · {s.target}{s.source !== "mcp.json" ? ` · 来自${s.source}` : ""}</small>
                {s.description ? <><br /><small class="muted">{s.description}</small></> : null}</td>
              <td><Badge s={s.state === "connected" ? "ok" : s.state === "connecting" ? "connecting" : s.state === "disabled" ? "stopped" : "error"}
                text={{ connected: "已连接", connecting: "连接中", disabled: "已停用", error: "出错" }[s.state as string] ?? s.state} />
                {s.error ? <details><summary class="muted">错误</summary><pre>{s.error}{s.stderr ? `\n\n${s.stderr}` : ""}</pre></details> : null}</td>
              <td>{s.tools.length ? <details><summary>{s.tools.length} 个</summary><ul>{s.tools.map((t: any) => (
                <li><code>{t.tool}</code>{t.exposure === "hidden" ? <small class="muted">（已隐藏）</small> : null}<br /><small class="muted">{t.description.slice(0, 160)}</small></li>))}</ul></details> : "—"}</td>
              <td>{s.state !== "disabled" && s.transport ? <Btn small onClick={async () => { await api(`/mcp/${enc(s.name)}/reconnect`, { body: {} }); toast("已重连"); reload(); }}>重连</Btn> : null}</td>
            </tr>))}
        </tbody></table> : <Empty>还没有 MCP 服务器。在下面的 mcp.json 里加，或从别的客户端导入。</Empty>}
        <p class="muted">工具名是 <code>mcp__服务器__工具</code>。MCP 工具默认只在可信对话（网页、设备、主人私聊）里出现；服务器配置里加 <code>"allowUntrusted": true</code> 才给 IM 里的陌生人用。</p>
      </Card>
      <Card title="mcp.json" actions={<>
        {d.import_sources.map((s: any) => (
          <Btn small disabled={!s.exists} title={s.file} onClick={async () => {
            try {
              const r = await api("/mcp/import", { body: { from: s.id } });
              toast(r.added.length ? `导入了 ${r.added.join("、")}${r.skipped.length ? `；同名跳过 ${r.skipped.join("、")}` : ""}` : "没有新的服务器");
              setText(null); reload();
            } catch (e) { toastErr(e); }
          }}>从 {s.label.split("（")[0]} 导入</Btn>))}
      </>}>
        <p class="muted">位置：<code>{d.file}</code>。格式与 pi / Claude Desktop 一致：本地程序写 <code>command</code>/<code>args</code>/<code>env</code>，远程写 <code>url</code>/<code>headers</code>；
          值里可以写 <code>${"{"}环境变量{"}"}</code>。每个服务器还可以设 <code>enabled</code>、<code>timeout</code>（秒）、<code>toolExposure</code>（<code>{"{"}"某工具": "hidden"{"}"}</code> 隐藏不想给的工具）。</p>
        {text === null ? <div class="muted">加载中…</div> : <TextArea value={text} onInput={setText} rows={18} mono placeholder={MCP_EXAMPLE} />}
        <div class="row">
          {!text && <Btn small kind="ghost" onClick={() => setText(MCP_EXAMPLE)}>填入示例</Btn>}
          <span class="grow" />{dirty && <span class="muted">未保存</span>}
          <Btn kind="primary" disabled={!dirty} onClick={async () => {
            try { await api("/mcp", { method: "PUT", body: { config: text } }); toast("已保存，正在连接"); reload(); } catch (e) { toastErr(e); }
          }}>保存并连接</Btn>
        </div>
      </Card>
    </>
  );
}
