// 技能：新建 / 编辑 / 删除，上传脚本和资料文件，上传 .zip 技能包。
// 路由参数：#/skills/<owner>|<技能文件夹>|<文件>；owner = ~global（全局）或 agent id（只给它）
import { useEffect, useState } from "preact/hooks";
import { api, enc, go } from "../api.ts";
import { Btn, Card, Empty, Err, Field, Input, Select, SideList, Split, TextArea, Toggle, confirmDo, toast, toastErr, useLoad } from "../ui.tsx";

const GLOBAL = "~global";

function b64(buf: ArrayBuffer) {
  let s = "";
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function pick(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const el = document.createElement("input");
    el.type = "file"; el.accept = accept; el.multiple = multiple;
    el.onchange = () => resolve([...(el.files ?? [])]);
    el.click();
  });
}

export function Skills({ arg }: { arg: string }) {
  const [owner = "", folder = "", file = ""] = arg.split("|");
  const [d, reload, err] = useLoad(() => api("/skills"));
  const [mode, setMode] = useState<"" | "new" | "zip">("");
  if (!d) return <Err msg={err} />;
  const ownerName = (id: string) => (id === GLOBAL ? "全局" : id);
  const groups: [string, any[]][] = d.owners.map((o: any) => [o.id, d.skills.filter((s: any) => s.owner === o.id)]);
  return (
    <Split left={<>
      <div class="row"><Btn small kind="primary" onClick={() => setMode("new")}>＋ 新建技能</Btn><Btn small onClick={() => setMode("zip")}>上传技能包</Btn></div>
      <SideList groups={groups.map(([id, list]) => ({ id, title: ownerName(id), items: list, collapsed: !!owner && id !== owner && list.length > 10 }))}
        placeholder="搜索技能名或描述" empty={<Empty>暂无技能</Empty>}
        match={(x: any, q) => `${x.name} ${x.description}`.toLowerCase().includes(q)}
        render={(x: any) => (
          <li class={x.owner === owner && x.folder === folder ? "on" : ""} onClick={() => { setMode(""); go("skills", `${x.owner}|${x.folder}`); }}>
            <b>{x.name}</b><small class="clip2">{x.description || "（没写描述）"}</small>
          </li>)} />
    </>}>
      {mode === "new" && <NewSkill owners={d.owners} done={(o, n) => { setMode(""); reload(); go("skills", `${o}|${n}|SKILL.md`); }} />}
      {mode === "zip" && <UploadZip owners={d.owners} done={(o, n) => { setMode(""); reload(); go("skills", `${o}|${n}|SKILL.md`); }} />}
      {!mode && (folder ? <SkillDetail key={owner + folder} owner={owner} folder={folder} file={file || "SKILL.md"} onDeleted={() => { reload(); go("skills"); }} onChanged={reload} />
        : <Card title="技能">
          <p class="muted">一个技能是含 <code>SKILL.md</code> 的文件夹，可附带脚本与资料，兼容 OpenClaw / ClawHub 格式。</p>
          <dl class="kv"><dt>全局目录</dt><dd><code>{d.global_dir}</code></dd><dt>启用</dt><dd>Agents → 工具与技能</dd></dl>
        </Card>)}
    </Split>
  );
}

function OwnerSelect({ owners, value, onChange }: { owners: any[]; value: string; onChange: (v: string) => void }) {
  return <Select value={value} onChange={onChange} options={owners.map((o: any) => [o.id, o.name] as [string, string])} />;
}

function NewSkill({ owners, done }: { owners: any[]; done: (owner: string, name: string) => void }) {
  const [f, set] = useState({ owner: GLOBAL, name: "", description: "", body: "" });
  return (
    <Card title="新建技能">
      <div class="form">
        <Field label="名字" hint="字母、数字、_ . -"><Input value={f.name} onInput={(v) => set({ ...f, name: v })} placeholder="weather-report" /></Field>
        <Field label="给谁用"><OwnerSelect owners={owners} value={f.owner} onChange={(v) => set({ ...f, owner: v })} /></Field>
        <Field label="描述" hint="agent 据此判断何时使用" wide><Input value={f.description} onInput={(v) => set({ ...f, description: v })} placeholder="主人问天气时，查询并播报今明两天的天气" /></Field>
        <Field label="正文（SKILL.md）" wide><TextArea value={f.body} onInput={(v) => set({ ...f, body: v })} rows={10} mono /></Field>
      </div>
      <Btn kind="primary" onClick={async () => {
        try { await api("/skills", { body: f }); toast("已创建"); done(f.owner, f.name); } catch (e) { toastErr(e); }
      }}>创建</Btn>
    </Card>
  );
}

function UploadZip({ owners, done }: { owners: any[]; done: (owner: string, name: string) => void }) {
  const [owner, setOwner] = useState(GLOBAL);
  const [overwrite, setOverwrite] = useState(false);
  return (
    <Card title="上传技能包">
      <p class="muted">.zip 内需包含 SKILL.md（根目录或一级子目录）。</p>
      <div class="form">
        <Field label="给谁用"><OwnerSelect owners={owners} value={owner} onChange={setOwner} /></Field>
        <Field label="同名技能"><Toggle checked={overwrite} onChange={setOverwrite} label="覆盖" /></Field>
      </div>
      <Btn kind="primary" onClick={async () => {
        const [file] = await pick(".zip");
        if (!file) return;
        try { const r = await api("/skills/upload", { body: { owner, overwrite, filename: file.name, b64: b64(await file.arrayBuffer()) } }); toast(`已安装 ${r.name}`); done(owner, r.name); }
        catch (e) { toastErr(e); }
      }}>选择 .zip 文件</Btn>
    </Card>
  );
}

function SkillDetail({ owner, folder, file, onDeleted, onChanged }: { owner: string; folder: string; file: string; onDeleted: () => void; onChanged: () => void }) {
  const base = `/skills/${enc(owner)}/${enc(folder)}`;
  const [d, reload, err] = useLoad(() => api(base), [owner, folder]);
  const nav = (f: string) => go("skills", `${owner}|${folder}|${f}`);
  if (!d) return <Err msg={err} />;
  const cur = d.files.find((f: any) => f.path === file);
  return (
    <>
      <Card title={`${folder}（${owner === GLOBAL ? "全局" : `只给 ${owner}`}）`} actions={<>
        <Btn small onClick={async () => {
          const name = window.prompt("新文件的路径（相对技能目录），如 scripts/run.py");
          if (!name) return;
          try { await api(`${base}/file?path=${enc(name)}`, { method: "PUT", body: { content: "" } }); reload(); nav(name); } catch (e) { toastErr(e); }
        }}>新建文件</Btn>
        <Btn small onClick={async () => {
          const list = await pick("*", true);
          try {
            for (const f of list) await api(`${base}/file?path=${enc(f.name)}`, { method: "PUT", body: { b64: b64(await f.arrayBuffer()) } });
            if (list.length) { toast(`已上传 ${list.length} 个文件`); reload(); }
          } catch (e) { toastErr(e); }
        }}>上传文件</Btn>
        <Btn small kind="danger" onClick={confirmDo(`删除技能 ${folder}？（挪进回收站，可以从 .trash 里找回）`, async () => {
          try { await api(base, { method: "DELETE" }); toast("已删除"); onDeleted(); } catch (e) { toastErr(e); }
        })}>删除技能</Btn>
      </>}>
        <p class="muted">位置：<code>{d.dir}</code></p>
        <table class="hover"><tbody>{d.files.map((f: any) => (
          <tr class={f.path === file ? "on" : ""} onClick={() => f.text && nav(f.path)}>
            <td><code>{f.path}</code></td><td class="muted">{f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`}{f.text ? "" : " · 二进制"}</td>
            <td onClick={(e) => e.stopPropagation()}>{f.path !== "SKILL.md" && <Btn small kind="ghost" onClick={confirmDo(`删除 ${f.path}？`, async () => {
              try { await api(`${base}/file?path=${enc(f.path)}`, { method: "DELETE" }); reload(); if (f.path === file) nav("SKILL.md"); } catch (e) { toastErr(e); }
            })}>删除</Btn>}</td>
          </tr>))}</tbody></table>
      </Card>
      {cur?.text && <SkillFile key={base + file} url={`${base}/file?path=${enc(file)}`} path={file} onSaved={() => { reload(); if (file === "SKILL.md") onChanged(); }} />}
    </>
  );
}

function SkillFile({ url, path, onSaved }: { url: string; path: string; onSaved: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => { api(url).then((r) => { setText(r.content); setOrig(r.content); }).catch((e) => setErr(e.message)); }, [url]);
  if (err) return <Err msg={err} />;
  if (text === null) return <div class="muted">加载中…</div>;
  return (
    <Card title={path}>
      {path === "SKILL.md" && <p class="muted">front matter 中的 name / description 决定技能名与触发场景；脚本路径相对技能目录。</p>}
      <TextArea value={text} onInput={setText} rows={22} mono />
      <div class="row"><span class="grow" />{text !== orig && <span class="muted">未保存</span>}
        <Btn kind="primary" disabled={text === orig} onClick={async () => {
          try { await api(url, { method: "PUT", body: { content: text } }); setOrig(text); toast("已保存"); onSaved(); } catch (e) { toastErr(e); }
        }}>保存</Btn></div>
    </Card>
  );
}
