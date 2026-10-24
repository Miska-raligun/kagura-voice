// 设置：模型服务商与 Key、默认/便宜模型、嵌入接口、语音推送、百度 Key、端口、token、更新、备份。
// 不预设任何模型——首次向导只给常见服务商的接口地址做参考，模型名和 Key 由用户自己填。
import { useEffect, useState } from "preact/hooks";
import { api, go } from "../api.ts";
import { Btn, Card, Err, Field, Input, Select, Tabs, Toggle, toast, toastErr, useInterval, useLoad } from "../ui.tsx";

const APIS: [string, string][] = [
  ["openai-completions", "OpenAI 兼容（DeepSeek / 通义 / Kimi / 智谱 / Ollama…）"],
  ["anthropic-messages", "Anthropic Messages"], ["openai-responses", "OpenAI Responses"], ["google-generative-ai", "Google Gemini"],
];
/** 只是接口地址参考，不含任何模型 */
const URL_HINTS: [string, string, string][] = [
  ["DeepSeek", "https://api.deepseek.com/v1", "openai-completions"],
  ["通义千问（百炼）", "https://dashscope.aliyuncs.com/compatible-mode/v1", "openai-completions"],
  ["Kimi（Moonshot）", "https://api.moonshot.cn/v1", "openai-completions"],
  ["智谱 GLM", "https://open.bigmodel.cn/api/paas/v4", "openai-completions"],
  ["硅基流动", "https://api.siliconflow.cn/v1", "openai-completions"],
  ["本机 Ollama", "http://127.0.0.1:11434/v1", "openai-completions"],
];

const TABS: [string, string][] = [["wizard", "快速开始"], ["models", "模型"], ["tools", "工具"], ["voice", "语音"], ["update", "更新"], ["backup", "备份"], ["misc", "系统"]];

export function Settings({ arg }: { arg: string }) {
  const [d, reload, err] = useLoad(() => api("/config"));
  const [tab, setTab] = useState(TABS.some(([t]) => t === arg) ? arg : "models");
  useEffect(() => { if (TABS.some(([t]) => t === arg)) setTab(arg); }, [arg]);   // #/settings/update 等直接打开对应标签
  if (!d) return <Err msg={err} />;
  const cfg = d.config;
  // 已经配过模型就不再显示「快速开始」（直接打开 #/settings/wizard 仍可用）
  const configured = (cfg.models?.providers ?? []).length > 0;
  const tabs = TABS.filter(([t]) => t !== "wizard" || !configured || tab === "wizard");
  const save = async (patch: any) => {
    const r = await api("/config", { method: "PUT", body: patch });
    toast(r.restart_needed.length ? `已保存，${r.restart_needed.join("、")} 重启后生效` : "已保存");
    reload();
  };
  return (
    <>
      {d.fake && <div class="notebox">测试模式：模型设置不生效。</div>}
      {cfg.brain === "openclaw" || (!cfg.brain && !(cfg.models?.providers ?? []).length) ? <div class="notebox">当前大脑为 OpenClaw。切换到内置 agent 并重启后，以下设置才生效。</div> : null}
      <Tabs value={tab} onChange={(t) => go("settings", t)} tabs={tabs} />
      {tab === "wizard" && <Wizard cfg={cfg} save={save} done={() => { setTab("models"); go("overview"); }} />}
      {tab === "models" && <Models cfg={cfg} save={save} />}
      {tab === "tools" && <Tools cfg={cfg} save={save} />}
      {tab === "voice" && <Voice cfg={cfg} save={save} />}
      {tab === "misc" && <Misc cfg={cfg} dataDir={d.data_dir} save={save} />}
      {tab === "update" && <Update />}
      {tab === "backup" && <Backup />}
    </>
  );
}

function Wizard({ cfg, save, done }: { cfg: any; save: (p: any) => Promise<void>; done: () => void }) {
  const [f, set] = useState({ id: "main", api: "openai-completions", base_url: "", api_key: "", model: "", image: false });
  const [test, setTest] = useState<any>(null);
  const finish = async () => {
    const providers = [...(cfg.models?.providers ?? []).filter((p: any) => p.id !== f.id),
      { id: f.id, api: f.api, base_url: f.base_url, api_key: f.api_key, models: [{ id: f.model, input: f.image ? ["text", "image"] : ["text"] }] }];
    await save({ brain: "pi", models: { ...(cfg.models ?? {}), providers, default: `${f.id}/${f.model}` } });
    setTest(await api("/models/test", { body: { ref: `${f.id}/${f.model}` } }));
  };
  return (
    <Card title="接入模型">
      <p class="muted">选择服务商以填入接口地址，再填写模型名和 API Key。</p>
      <div class="chips">{URL_HINTS.map(([n, u, a]) => <a class="chip" onClick={() => set({ ...f, base_url: u, api: a })}>{n}</a>)}</div>
      <div class="form">
        <Field label="接口类型"><Select value={f.api} onChange={(v) => set({ ...f, api: v })} options={APIS} /></Field>
        <Field label="接口地址"><Input value={f.base_url} onInput={(v) => set({ ...f, base_url: v })} placeholder="https://…/v1" /></Field>
        <Field label="API Key"><Input type="password" value={f.api_key} onInput={(v) => set({ ...f, api_key: v })} /></Field>
        <Field label="模型名" hint="服务商提供的模型 ID"><Input value={f.model} onInput={(v) => set({ ...f, model: v })} /></Field>
        <Field label="服务商 id" hint="引用格式：服务商 id/模型名"><Input value={f.id} onInput={(v) => set({ ...f, id: v })} /></Field>
        <Field label="多模态"><Toggle checked={f.image} onChange={(v) => set({ ...f, image: v })} label="支持图片输入" /></Field>
      </div>
      <Btn kind="primary" onClick={finish} disabled={!f.base_url || !f.model}>保存并测试</Btn>
      {test && (test.ok
        ? <div class="okbox">✓ 连接成功（{test.ms}ms）：{test.reply}<br />重启服务端后启用内置 agent。<Btn onClick={done}>完成</Btn></div>
        : <div class="errbox">连接失败：{test.error}</div>)}
    </Card>
  );
}

function Models({ cfg, save }: { cfg: any; save: (p: any) => Promise<void> }) {
  const [m, set] = useState(() => JSON.parse(JSON.stringify(cfg.models ?? { providers: [], default: "", cheap: "" })));
  const [emb, setEmb] = useState(() => ({ base_url: "", api_key: "", model: "", ...(cfg.embedding ?? {}) }));
  const [brain, setBrain] = useState(cfg.brain ?? "");
  const ref = (p: any, x: any) => `${String(p.id ?? "").trim()}/${String(x.id ?? "").trim()}`;
  const refs: [string, string][] = m.providers.flatMap((p: any) => (p.models ?? []).map((x: any) => [ref(p, x), ref(p, x)] as [string, string]));
  /** 保存前去掉 id / 模型名首尾空格（从网页复制常带上） */
  const clean = (c: any) => ({ ...c, providers: c.providers.map((p: any) => ({ ...p, id: String(p.id ?? "").trim(), base_url: String(p.base_url ?? "").trim(),
    models: (p.models ?? []).map((x: any) => ({ ...x, id: String(x.id ?? "").trim() })) })) });
  const up = (fn: (x: any) => void) => { const c = JSON.parse(JSON.stringify(m)); fn(c); set(c); };
  const testRef = async (ref: string) => { const r = await api("/models/test", { body: { ref, models: clean(m) } }); toast(r.ok ? `✓ ${ref}（${r.ms}ms）：${r.reply}` : `✗ ${ref}：${r.error}`, r.ok ? "ok" : "err"); };
  return (
    <>
      <Card title="大脑">
        <Select value={brain} onChange={setBrain} options={[["", "自动（已配置模型时用内置 agent）"], ["pi", "内置 agent"], ["openclaw", "OpenClaw CLI"]]} />
        <small class="hint">重启后生效</small>
      </Card>
      {m.providers.map((p: any, i: number) => (
        <Card title={`服务商 ${p.id}`} actions={<Btn small kind="danger" onClick={() => up((c) => c.providers.splice(i, 1))}>删除</Btn>}>
          <div class="form">
            <Field label="id"><Input value={p.id} onInput={(v) => up((c) => (c.providers[i].id = v))} /></Field>
            <Field label="接口类型"><Select value={p.api} onChange={(v) => up((c) => (c.providers[i].api = v))} options={APIS} /></Field>
            <Field label="接口地址"><Input value={p.base_url} onInput={(v) => up((c) => (c.providers[i].base_url = v))} /></Field>
            <Field label="API Key" hint="*** 表示已保存"><Input type="password" value={p.api_key} onInput={(v) => up((c) => (c.providers[i].api_key = v))} /></Field>
          </div>
          <table><thead><tr><th>模型名</th><th>图片</th><th>上下文</th><th>最大输出</th><th>输入价</th><th>输出价</th><th></th></tr></thead>
            <tbody>{(p.models ?? []).map((x: any, j: number) => {
              const mm = (fn: (o: any) => void) => up((c) => fn(c.providers[i].models[j]));
              return <tr>
                <td><Input value={x.id} onInput={(v) => mm((o) => (o.id = v))} /></td>
                <td><input type="checkbox" checked={(x.input ?? []).includes("image")} onChange={(e) => mm((o) => (o.input = (e.target as HTMLInputElement).checked ? ["text", "image"] : ["text"]))} /></td>
                <td><Input type="number" value={x.context_window ?? ""} placeholder="64000" onInput={(v) => mm((o) => (o.context_window = v ? Number(v) : undefined))} /></td>
                <td><Input type="number" value={x.max_tokens ?? ""} placeholder="4096" onInput={(v) => mm((o) => (o.max_tokens = v ? Number(v) : undefined))} /></td>
                <td><Input type="number" value={x.cost?.input ?? ""} placeholder="¥/百万" onInput={(v) => mm((o) => (o.cost = { ...(o.cost ?? {}), input: Number(v) }))} /></td>
                <td><Input type="number" value={x.cost?.output ?? ""} placeholder="¥/百万" onInput={(v) => mm((o) => (o.cost = { ...(o.cost ?? {}), output: Number(v) }))} /></td>
                <td><Btn small onClick={() => testRef(ref(p, x))}>测试</Btn><Btn small kind="ghost" onClick={() => up((c) => c.providers[i].models.splice(j, 1))}>✕</Btn></td>
              </tr>;
            })}</tbody></table>
          <Btn small onClick={() => up((c) => (c.providers[i].models = [...(c.providers[i].models ?? []), { id: "", input: ["text"] }]))}>＋ 模型</Btn>
        </Card>
      ))}
      <div class="row"><Btn onClick={() => up((c) => c.providers.push({ id: `p${c.providers.length + 1}`, api: "openai-completions", base_url: "", api_key: "", models: [] }))}>＋ 服务商</Btn></div>
      <Card title="默认模型">
        <div class="form">
          <Field label="默认" hint="agent 未指定模型时使用"><Select value={m.default ?? ""} onChange={(v) => up((c) => (c.default = v))} options={[["", "未选"], ...refs]} /></Field>
          <Field label="便宜模型" hint="用于压缩、记忆整理、heartbeat"><Select value={m.cheap ?? ""} onChange={(v) => up((c) => (c.cheap = v))} options={[["", "同默认"], ...refs]} /></Field>
        </div>
      </Card>
      <Card title="嵌入接口（可选）">
        <p class="muted">OpenAI 兼容的 /embeddings 接口，用于记忆的语义检索；未配置时仅用关键词检索。</p>
        <div class="form">
          <Field label="接口地址"><Input value={emb.base_url} onInput={(v) => setEmb({ ...emb, base_url: v })} /></Field>
          <Field label="API Key"><Input type="password" value={emb.api_key} onInput={(v) => setEmb({ ...emb, api_key: v })} /></Field>
          <Field label="模型名"><Input value={emb.model} onInput={(v) => setEmb({ ...emb, model: v })} /></Field>
        </div>
      </Card>
      <Btn kind="primary" onClick={() => save({ models: clean(m), embedding: emb.base_url && emb.model ? emb : null, ...(brain ? { brain } : {}) })}>保存</Btn>
    </>
  );
}

const SEARCH_PROVIDERS: [string, string][] = [
  ["auto", "自动"], ["bing", "必应网页（无需 Key）"], ["duckduckgo", "DuckDuckGo 网页（无需 Key）"],
  ["bocha", "博查 API"], ["tavily", "Tavily API"], ["brave", "Brave Search API"], ["searxng", "SearXNG（自建）"],
];
const SHELLS: [string, string][] = [
  ["auto", "自动（Windows: PowerShell，其它: bash）"], ["powershell", "PowerShell"], ["cmd", "cmd"], ["wsl", "WSL bash"], ["bash", "bash"], ["sh", "sh"],
];

function Tools({ cfg, save }: { cfg: any; save: (p: any) => Promise<void> }) {
  const t = cfg.tools ?? {};
  const [w, setW] = useState({ enabled: true, search_provider: "auto", search_api_key: "", search_base_url: "", proxy: "", ...(t.web ?? {}) });
  const [e, setE] = useState({ enabled: true, shell: "auto", wsl_distro: "", timeout_secs: 60, ...(t.exec ?? {}) });
  const [q, setQ] = useState("今天的新闻");
  const [cmd, setCmd] = useState("echo hello from Kagura");
  const [sr, setSr] = useState<any>(null);
  const [er, setEr] = useState<any>(null);
  const saveAll = () => save({ tools: { web: w, exec: e } });
  return (
    <>
      <Card title="联网">
        <p class="muted">网页搜索与读取。默认使用必应网页，可改用搜索 API。</p>
        <div class="form">
          <Field label="启用"><Toggle checked={w.enabled} onChange={(v) => setW({ ...w, enabled: v })} label="启用" /></Field>
          <Field label="搜索服务"><Select value={w.search_provider} onChange={(v) => setW({ ...w, search_provider: v })} options={SEARCH_PROVIDERS} /></Field>
          <Field label="API Key" hint="博查 / Tavily / Brave"><Input type="password" value={w.search_api_key} onInput={(v) => setW({ ...w, search_api_key: v })} /></Field>
          <Field label="SearXNG 地址" hint="如 http://127.0.0.1:8888"><Input value={w.search_base_url} onInput={(v) => setW({ ...w, search_base_url: v })} /></Field>
          <Field label="网络代理" hint="如 http://127.0.0.1:7890，模型请求同样走代理，本机地址直连"><Input value={w.proxy} onInput={(v) => setW({ ...w, proxy: v })} placeholder="留空则使用 HTTPS_PROXY 环境变量" /></Field>
        </div>
        <div class="row"><Input value={q} onInput={setQ} /><Btn onClick={async () => { await saveAll(); setSr({ loading: true }); try { setSr(await api("/tools/test-search", { body: { query: q } })); } catch (x: any) { setSr({ errors: [x.message] }); } }}>保存并测试</Btn></div>
        {sr && (sr.loading ? <p class="muted">搜索中…</p> : sr.ok
          ? <><p>✓ {sr.provider}，{sr.ms}ms{sr.proxy ? `，经代理 ${sr.proxy}` : ""}</p><ul>{sr.hits.map((h: any) => <li><a href={h.url} target="_blank">{h.title}</a> <small class="muted">{h.snippet.slice(0, 80)}</small></li>)}</ul></>
          : <p class="over">✗ 失败：{(sr.errors ?? []).join("；")}</p>)}
      </Card>
      <Card title="执行命令">
        <p class="muted">允许 agent 在本机执行命令。仅对可信会话开放（设备、网页聊天、定时任务、主人 IM 私聊），也可在 Agents → 工具 中按 agent 关闭。</p>
        <div class="form">
          <Field label="启用"><Toggle checked={e.enabled} onChange={(v) => setE({ ...e, enabled: v })} label="启用" /></Field>
          <Field label="Shell"><Select value={e.shell} onChange={(v) => setE({ ...e, shell: v })} options={SHELLS} /></Field>
          <Field label="WSL 发行版" hint="留空为默认发行版"><Input value={e.wsl_distro} onInput={(v) => setE({ ...e, wsl_distro: v })} /></Field>
          <Field label="默认超时（秒）"><Input type="number" value={e.timeout_secs} onInput={(v) => setE({ ...e, timeout_secs: Number(v) })} /></Field>
        </div>
        <div class="row"><Input value={cmd} onInput={setCmd} /><Btn onClick={async () => { await saveAll(); setEr({ loading: true }); try { setEr(await api("/tools/test-exec", { body: { command: cmd } })); } catch (x: any) { setEr({ error: x.message }); } }}>保存并测试</Btn></div>
        {er && (er.loading ? <p class="muted">执行中…</p> : <><p class={er.ok ? "" : "over"}>{er.ok ? "✓" : "✗"} {er.timed_out ? "超时" : er.error || `exit=${er.code}`}，{er.ms}ms</p>{er.output && <pre class="log">{er.output}</pre>}</>)}
      </Card>
      <Btn kind="primary" onClick={saveAll}>保存</Btn>
    </>
  );
}

function Voice({ cfg, save }: { cfg: any; save: (p: any) => Promise<void> }) {
  const [b, setB] = useState({ asr_key: "", asr_secret: "", tts_key: "", tts_secret: "", ...(cfg.baidu ?? {}) });
  const [tok, setTok] = useState({ api_token: cfg.api_token ?? "", stream_token: cfg.stream_token ?? "" });
  const [vp, setVp] = useState({ voice_push: cfg.voice_push ?? "presence", role_push: cfg.role_push ?? "hold" });
  return (
    <>
      <Card title="语音推送">
        <p class="muted">agent 发给你的消息（IM 与网页回复、定时任务、heartbeat、提醒）同时在设备上播报。在家状态来自设备蓝牙、对设备的操作，或 IM 中的 /home、/away。</p>
        <div class="form">
          <Field label="播报"><Select value={vp.voice_push} onChange={(v) => setVp({ ...vp, voice_push: v })} options={[["presence", "在家时播放"], ["always", "总是播放"], ["never", "从不播放"]]} /></Field>
          <Field label="说话的不是设备当前角色时" hint="IM / 网页回复在角色不一致时不播报">
            <Select value={vp.role_push} onChange={(v) => setVp({ ...vp, role_push: v })} options={[["hold", "留言，切换到该角色后播放"], ["switch", "立即播放，临时显示该角色"]]} /></Field>
        </div>
        <Btn kind="primary" onClick={() => save(vp)}>保存</Btn>
      </Card>
      <Speech cfg={cfg} save={save} />
      <Card title="百度语音">
        <div class="form">
          <Field label="识别 API Key"><Input value={b.asr_key} onInput={(v) => setB({ ...b, asr_key: v })} /></Field>
          <Field label="识别 Secret Key"><Input type="password" value={b.asr_secret} onInput={(v) => setB({ ...b, asr_secret: v })} /></Field>
          <Field label="合成 API Key"><Input value={b.tts_key} onInput={(v) => setB({ ...b, tts_key: v })} /></Field>
          <Field label="合成 Secret Key"><Input type="password" value={b.tts_secret} onInput={(v) => setB({ ...b, tts_secret: v })} /></Field>
          <Field label="识别档位" hint="极速版更准更快，需在百度智能云开通「短语音识别极速版」"><Select value={b.asr_mode ?? "standard"} onChange={(v) => setB({ ...b, asr_mode: v })} options={[["standard", "标准版"], ["pro", "极速版"]]} /></Field>
        </div>
        <Btn kind="primary" onClick={() => save({ baidu: b })}>保存（重启生效）</Btn>
      </Card>
      <Card title="访问令牌">
        <p class="muted">API_TOKEN 保护监控页与推送 / 拍照接口（留空则局域网开放）。STREAM_TOKEN 需与设备端一致。</p>
        <div class="form">
          <Field label="API_TOKEN"><Input type="password" value={tok.api_token} onInput={(v) => setTok({ ...tok, api_token: v })} /></Field>
          <Field label="STREAM_TOKEN"><Input type="password" value={tok.stream_token} onInput={(v) => setTok({ ...tok, stream_token: v })} /></Field>
        </div>
        <Btn kind="primary" onClick={() => save(tok)}>保存（重启生效）</Btn>
      </Card>
    </>
  );
}

const SPEECH_KINDS: [string, string][] = [["openai", "OpenAI 兼容（VoiceStudio、OpenAI、硅基流动等）"], ["minimax", "MiniMax（仅合成）"], ["baidu", "百度"]];
const SPEECH_PRESETS: { name: string; p: any }[] = [
  { name: "VoiceStudio（本机）", p: { kind: "openai", name: "VoiceStudio", base_url: "http://127.0.0.1:3900/v1", model: "", voice: "" } },
  { name: "OpenAI", p: { kind: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", voice: "alloy", asr_model: "whisper-1" } },
  { name: "硅基流动", p: { kind: "openai", name: "硅基流动", base_url: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/CosyVoice2-0.5B", voice: "FunAudioLLM/CosyVoice2-0.5B:anna", asr_model: "FunAudioLLM/SenseVoiceSmall" } },
  { name: "MiniMax", p: { kind: "minimax", name: "MiniMax", base_url: "https://api.minimaxi.com/v1", model: "speech-02-turbo", voice: "female-shaonv" } },
];

/** 语音识别 / 合成服务商：选默认的那家，增删改服务商 */
function Speech({ cfg, save }: { cfg: any; save: (p: any) => Promise<void> }) {
  const init = () => {
    const sp = JSON.parse(JSON.stringify(cfg.speech ?? {}));
    const providers: any[] = sp.providers?.length ? sp.providers : [];
    if (!providers.some((p) => p.kind === "baidu")) providers.unshift({ id: "baidu", kind: "baidu", name: "百度" });
    return { asr: sp.asr || providers[0].id, tts: sp.tts || providers[0].id, providers };
  };
  const [sp, setSp] = useState(init);
  const [text, setText] = useState("你好，我是你的桌面小助手。");
  const up = (fn: (x: any) => void) => { const c = JSON.parse(JSON.stringify(sp)); fn(c); setSp(c); };
  const name = (p: any) => p.name || p.id;
  const asrOpts = sp.providers.filter((p: any) => p.kind !== "minimax").map((p: any) => [p.id, name(p)] as [string, string]);
  const ttsOpts = sp.providers.map((p: any) => [p.id, name(p)] as [string, string]);
  const add = (preset: any) => up((c) => {
    let id = (preset.name === "VoiceStudio（本机）" ? "voicestudio" : String(preset.p.name || preset.p.kind)).toLowerCase().replace(/[^a-z0-9_-]/g, "") || "tts";
    while (c.providers.some((p: any) => p.id === id)) id += "2";
    c.providers.push({ id, api_key: "", ...preset.p });
  });
  const test = async (id: string) => {
    try {
      const blob = await api<Blob>("/tts", { body: { provider: id, text, speech: sp } });
      new Audio(URL.createObjectURL(blob)).play();
    } catch (e) { toastErr(e); }
  };
  return (
    <Card title="语音服务" actions={<Select value="" onChange={(v) => { const pr = SPEECH_PRESETS.find((x) => x.name === v); if (pr) add(pr); }}
      options={[["", "＋ 添加服务商"], ...SPEECH_PRESETS.map((x) => [x.name, x.name] as [string, string])]} />}>
      <div class="form">
        <Field label="语音识别"><Select value={sp.asr} onChange={(v) => setSp({ ...sp, asr: v })} options={asrOpts} /></Field>
        <Field label="语音合成（默认）" hint="agent 可在 基本 设置中单独指定；失败时退回默认"><Select value={sp.tts} onChange={(v) => setSp({ ...sp, tts: v })} options={ttsOpts} /></Field>
      </div>
      {sp.providers.filter((p: any) => p.kind !== "baidu").map((p: any) => {
        const i = sp.providers.indexOf(p);
        const set = (k: string, v: any) => up((c) => (c.providers[i][k] = v));
        return (
          <details class="pkg" open={!p.base_url || !p.model}>
            <summary><b>{name(p)}</b> <small class="muted">{p.id} · {p.kind}</small></summary>
            <div class="form" style="margin-top:10px">
              <Field label="名称"><Input value={p.name ?? ""} onInput={(v) => set("name", v)} /></Field>
              <Field label="类型"><Select value={p.kind} onChange={(v) => set("kind", v)} options={SPEECH_KINDS.filter(([k]) => k !== "baidu")} /></Field>
              <Field label="接口地址"><Input value={p.base_url ?? ""} onInput={(v) => set("base_url", v)} placeholder="https://…/v1" /></Field>
              <Field label="API Key" hint="*** 表示已保存；本机服务可留空"><Input type="password" value={p.api_key ?? ""} onInput={(v) => set("api_key", v)} /></Field>
              <Field label="合成模型" hint={p.kind === "minimax" ? "如 speech-02-turbo" : "如 tts-1；VoiceStudio 填引擎 id 或留空"}><Input value={p.model ?? ""} onInput={(v) => set("model", v)} /></Field>
              <Field label="默认音色" hint={p.kind === "minimax" ? "voice_id（含复刻的音色）" : "voice 名或 VoiceStudio 的声音 id"}><Input value={p.voice ?? ""} onInput={(v) => set("voice", v)} /></Field>
              {p.kind === "openai" && <Field label="识别模型" hint="用作语音识别时填，如 whisper-1"><Input value={p.asr_model ?? ""} onInput={(v) => set("asr_model", v)} /></Field>}
              <Field label="语速" hint="1 为正常"><Input type="number" value={p.speed ?? ""} placeholder="1" onInput={(v) => set("speed", v ? Number(v) : undefined)} /></Field>
            </div>
            <div class="row">
              <Btn small onClick={() => test(p.id)}>试听</Btn>
              <Btn small kind="danger" onClick={() => up((c) => {
                c.providers.splice(i, 1);
                if (c.asr === p.id) c.asr = c.providers[0].id;
                if (c.tts === p.id) c.tts = c.providers[0].id;
              })}>删除</Btn>
            </div>
          </details>
        );
      })}
      <div class="row">
        <Input value={text} onInput={setText} />
        <Btn onClick={() => test(sp.tts)}>试听默认</Btn>
        <Btn kind="primary" onClick={() => save({ speech: { ...sp, providers: sp.providers.map((p: any) => ({ ...p, id: String(p.id).trim(), base_url: String(p.base_url ?? "").trim() })) } })}>保存</Btn>
      </div>
    </Card>
  );
}

function Misc({ cfg, dataDir, save }: { cfg: any; dataDir: string; save: (p: any) => Promise<void> }) {
  const [p, setP] = useState({ port: cfg.port ?? 5000, mqtt_port: cfg.mqtt_port ?? 1883, disc_port: cfg.disc_port ?? 5001, stream_port: cfg.stream_port ?? 5002 });
  const [rt, setRt] = useState({ max_concurrency: cfg.runtime?.max_concurrency ?? 4, timeout_secs: cfg.runtime?.timeout_secs ?? 120, max_secs: cfg.runtime?.max_secs ?? 1800 });
  return (
    <>
      <Card title="数据目录"><code>{dataDir}</code></Card>
      <Card title="端口">
        <p class="muted">重启后生效。WSL 下需同步修改 Windows 端口转发与防火墙。</p>
        <div class="form">
          {(["port", "mqtt_port", "disc_port", "stream_port"] as const).map((k) => (
            <Field label={{ port: "HTTP", mqtt_port: "MQTT", disc_port: "UDP 发现", stream_port: "直播 TCP" }[k]}>
              <Input type="number" value={p[k]} onInput={(v) => setP({ ...p, [k]: Number(v) })} /></Field>))}
        </div>
        <Btn kind="primary" onClick={() => save(p)}>保存</Btn>
      </Card>
      <Card title="运行时">
        <div class="form">
          <Field label="最大并发" hint="重启后生效"><Input type="number" value={rt.max_concurrency} onInput={(v) => setRt({ ...rt, max_concurrency: Number(v) })} /></Field>
          <Field label="无进展超时（秒）" hint="多久没有出字、没有工具在执行就中断"><Input type="number" value={rt.timeout_secs} onInput={(v) => setRt({ ...rt, timeout_secs: Number(v) })} /></Field>
          <Field label="单轮总时长上限（秒）" hint="长任务的兜底，默认 1800"><Input type="number" value={rt.max_secs} onInput={(v) => setRt({ ...rt, max_secs: Number(v) })} /></Field>
        </div>
        <Btn kind="primary" onClick={() => save({ runtime: rt })}>保存</Btn>
      </Card>
      <Card title="重启">
        <p class="muted">IM 中主人也可发送 <code>/restart</code>。</p>
        <Btn kind="danger" onClick={async () => {
          if (!window.confirm("重启服务端？进行中的对话会中断。")) return;
          await api("/restart", { body: {} });
          toast("正在重启…");
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            try { const r = await fetch("/health"); if (r.ok && i > 2) { toast("已重启"); location.reload(); return; } } catch { /* 还没起来 */ }
          }
          toast("未能重新连接，请稍后刷新", "err");
        }}>重启服务端</Btn>
      </Card>
      <Card title="从 OpenClaw 导入"><p class="muted">导入人设、记忆与定时任务。</p><Btn onClick={() => go("jobs")}>打开</Btn></Card>
    </>
  );
}

const fmtMB = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1048576).toFixed(1)}MB`);

/** 在线更新：查新版本、一键下载安装 */
export function Update() {
  const [d, reload, err] = useLoad(() => api("/update"));
  const busy = ["downloading", "verifying", "installing"].includes(d?.state?.phase);
  useInterval(() => { if (busy) reload(); }, 1000);
  if (!d) return <Err msg={err} />;
  const st = d.state, info = d.info;
  const kindText: Record<string, string> = { windows: "静默安装后自动重启（需管理员确认一次）", appimage: "替换 AppImage 后自动重启", deb: "下载后给出安装命令（需管理员权限）", unsupported: "当前运行方式不支持在线更新，请从发布页下载" };
  return (
    <Card title="更新" actions={<Btn small disabled={!d.enabled || busy} onClick={async () => { try { await api("/update/check", { body: {} }); reload(); } catch (e) { toastErr(e); } }}>检查更新</Btn>}>
      <p>当前版本 <b>{d.current}</b>{info ? (info.newer ? <> · 最新 <b>{info.latest}</b></> : <> · 已是最新</>) : null}
        {info?.error ? <span class="muted"> · 检查失败：{info.error}</span> : null}</p>
      {!d.enabled && <p class="muted">更新检查已关闭（update_check: false）。</p>}
      <p class="muted">{kindText[d.kind] ?? ""}</p>
      {info?.newer && <>
        {info.notes ? <details><summary>更新内容</summary><pre>{info.notes}</pre></details> : null}
        <div class="row">
          <Btn kind="primary" disabled={busy || d.kind === "unsupported"} onClick={async () => {
            if (!window.confirm(`更新到 ${info.latest}？\n安装后服务端将重启，数据与设置保留。`)) return;
            try { await api("/update/install", { body: {} }); reload(); } catch (e) { toastErr(e); }
          }}>更新到 {info.latest}</Btn>
          <a href={info.url} target="_blank">发布页 ↗</a>
        </div>
      </>}
      {st && st.phase !== "idle" && <div class={st.phase === "error" ? "errbox" : "card"}>
        <p>{st.message}{st.phase === "downloading" && st.total ? `：${fmtMB(st.done)} / ${fmtMB(st.total)}（${Math.round(st.done * 100 / st.total)}%）` : ""}</p>
        {st.phase === "downloading" && st.total ? <progress max={st.total} value={st.done} style="width:100%" /> : null}
        {st.phase === "installing" && <p class="muted">服务端重启中，稍后刷新页面。</p>}
        {st.command && <pre>{st.command}</pre>}
      </div>}
    </Card>
  );
}

/** 导出 / 导入：勾选要带走的东西打成一个 zip；导入时先看包里有什么再勾选 */
function Backup() {
  const [cat, , err] = useLoad(() => api("/backup/catalog"));
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [secrets, setSecrets] = useState(false);
  const [man, setMan] = useState<any>(null);
  const [imp, setImp] = useState<Set<string>>(new Set());
  if (!cat) return <Err msg={err} />;
  const items: any[] = cat.items;
  const chosen = sel ?? new Set(items.filter((i) => i.default).map((i) => i.id));
  const toggle = (set: Set<string>, id: string, on: boolean) => { const n = new Set(set); on ? n.add(id) : n.delete(id); return n; };
  const groups = [...new Set(items.map((i) => i.group))];
  const total = items.filter((i) => chosen.has(i.id)).reduce((n, i) => n + i.bytes, 0);
  return (
    <>
      <Card title="导出">
        <p class="muted">选择要导出的内容，生成 .zip。分享给他人时不要包含密钥。</p>
        {groups.map((g) => (
          <div class="bk-group">
            <h4>{g} <a class="muted" onClick={() => { let n = new Set(chosen); const ids = items.filter((i) => i.group === g).map((i) => i.id); const all = ids.every((id) => n.has(id)); ids.forEach((id) => (n = toggle(n, id, !all))); setSel(n); }}>全选</a></h4>
            {items.filter((i) => i.group === g).map((i) => (
              <div><Toggle checked={chosen.has(i.id)} onChange={(v) => setSel(toggle(chosen, i.id, v))} label={i.label} />
                <small class="muted">{fmtMB(i.bytes)}{i.secret ? " · 含密钥项" : ""}{i.note ? ` · ${i.note}` : ""}</small></div>))}
          </div>))}
        <div class="row">
          <Toggle checked={secrets} onChange={setSecrets} label="包含密钥（API Key、IM 凭据等）" />
          <span class="grow" /><span class="muted">约 {fmtMB(total)}</span>
          <Btn kind="primary" disabled={!chosen.size} onClick={async () => {
            const r = await fetch("/api/admin/backup/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [...chosen], secrets }) });
            if (!r.ok) { toast((await r.json()).error ?? `HTTP ${r.status}`, "err"); return; }
            const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "kagura-backup.zip";
            const a = document.createElement("a");
            a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          }}>导出</Btn>
        </div>
      </Card>
      <Card title="导入">
        <p class="muted">被替换的内容先备份到 backups/；端口等本机设置与空缺的密钥保留本机值。导入后自动重启。</p>
        <Btn onClick={() => {
          const el = document.createElement("input");
          el.type = "file"; el.accept = ".zip";
          el.onchange = async () => {
            const f = el.files?.[0];
            if (!f) return;
            const r = await fetch("/api/admin/backup/inspect", { method: "POST", headers: { "content-type": "application/zip" }, body: f });
            const j = await r.json();
            if (!r.ok) { toast(j.error ?? `HTTP ${r.status}`, "err"); return; }
            setMan(j.manifest); setImp(new Set(j.manifest.items.map((i: any) => i.id)));
          };
          el.click();
        }}>选择文件…</Btn>
        {man && <>
          <p>来自 <b>{man.host}</b> · {new Date(man.createdAt).toLocaleString("zh-CN", { hour12: false })} · Kagura {man.version}{man.secrets ? " · 含密钥" : " · 不含密钥"}</p>
          {man.items.map((i: any) => <div><Toggle checked={imp.has(i.id)} onChange={(v) => setImp(toggle(imp, i.id, v))} label={i.label} /> <small class="muted">{fmtMB(i.bytes)}</small></div>)}
          <div class="row"><span class="grow" />
            <Btn kind="primary" disabled={!imp.size} onClick={async () => {
              if (!window.confirm(`导入 ${imp.size} 项并重启服务端？`)) return;
              try { await api("/backup/import", { body: { items: [...imp] } }); toast("导入中，服务端重启后刷新页面"); setMan(null); } catch (e) { toastErr(e); }
            }}>导入并重启</Btn></div>
        </>}
      </Card>
    </>
  );
}
