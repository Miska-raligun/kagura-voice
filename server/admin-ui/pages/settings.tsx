// 设置：模型服务商与 Key、默认/便宜模型、嵌入接口、百度 Key、端口、token、从 OpenClaw 导入。
// 不预设任何模型——首次向导只给常见服务商的接口地址做参考，模型名和 Key 由用户自己填。
import { useState } from "preact/hooks";
import { api, go } from "../api.ts";
import { Btn, Card, Err, Field, Input, Select, Tabs, Toggle, toast, useLoad } from "../ui.tsx";

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

export function Settings({ arg }: { arg: string }) {
  const [d, reload, err] = useLoad(() => api("/config"));
  const [tab, setTab] = useState(arg === "wizard" ? "wizard" : "models");
  if (!d) return <Err msg={err} />;
  const cfg = d.config;
  const save = async (patch: any) => {
    const r = await api("/config", { method: "PUT", body: patch });
    toast(r.restart_needed.length ? `已保存；${r.restart_needed.join("、")} 要重启服务端才生效` : "已保存，已生效");
    reload();
  };
  return (
    <>
      {d.fake && <div class="errbox">当前是假服务商模式（测试用），模型设置不会生效。</div>}
      {cfg.brain === "openclaw" || (!cfg.brain && !(cfg.models?.providers ?? []).length) ? <div class="errbox">现在的大脑是 OpenClaw。配好模型并把「大脑」切到内置 agent 后重启才会用这里的设置。</div> : null}
      <Tabs value={tab} onChange={setTab} tabs={[["wizard", "首次设置"], ["models", "模型"], ["voice", "语音与设备"], ["misc", "其它"]]} />
      {tab === "wizard" && <Wizard cfg={cfg} save={save} done={() => { setTab("models"); go("overview"); }} />}
      {tab === "models" && <Models cfg={cfg} save={save} />}
      {tab === "voice" && <Voice cfg={cfg} save={save} />}
      {tab === "misc" && <Misc cfg={cfg} dataDir={d.data_dir} save={save} />}
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
    <Card title="第一步：接一个模型">
      <p class="muted">Kagura 不预设任何模型。选一个你有 Key 的服务商（下面只是接口地址参考），填模型名和 Key。</p>
      <div class="chips">{URL_HINTS.map(([n, u, a]) => <a class="chip" onClick={() => set({ ...f, base_url: u, api: a })}>{n}</a>)}</div>
      <div class="form">
        <Field label="接口类型"><Select value={f.api} onChange={(v) => set({ ...f, api: v })} options={APIS} /></Field>
        <Field label="接口地址"><Input value={f.base_url} onInput={(v) => set({ ...f, base_url: v })} placeholder="https://…/v1" /></Field>
        <Field label="API Key"><Input type="password" value={f.api_key} onInput={(v) => set({ ...f, api_key: v })} /></Field>
        <Field label="模型名" hint="服务商文档里的模型 id"><Input value={f.model} onInput={(v) => set({ ...f, model: v })} /></Field>
        <Field label="服务商 id" hint="随便起，引用时写 id/模型名"><Input value={f.id} onInput={(v) => set({ ...f, id: v })} /></Field>
        <Field label="看图"><Toggle checked={f.image} onChange={(v) => set({ ...f, image: v })} label="这个模型能看图（拍照问「这是什么」要用）" /></Field>
      </div>
      <Btn kind="primary" onClick={finish} disabled={!f.base_url || !f.model}>保存并测试</Btn>
      {test && (test.ok
        ? <div class="okbox">✓ 通了（{test.ms}ms）：{test.reply}<br />切换大脑需要重启服务端一次。之后可以去「Agents」改人设。<Btn onClick={done}>完成</Btn></div>
        : <div class="errbox">没通：{test.error}</div>)}
    </Card>
  );
}

function Models({ cfg, save }: { cfg: any; save: (p: any) => Promise<void> }) {
  const [m, set] = useState(() => JSON.parse(JSON.stringify(cfg.models ?? { providers: [], default: "", cheap: "" })));
  const [emb, setEmb] = useState(() => ({ base_url: "", api_key: "", model: "", ...(cfg.embedding ?? {}) }));
  const [brain, setBrain] = useState(cfg.brain ?? "");
  const refs: [string, string][] = m.providers.flatMap((p: any) => (p.models ?? []).map((x: any) => [`${p.id}/${x.id}`, `${p.id}/${x.id}`] as [string, string]));
  const up = (fn: (x: any) => void) => { const c = JSON.parse(JSON.stringify(m)); fn(c); set(c); };
  const testRef = async (ref: string) => { const r = await api("/models/test", { body: { ref } }); toast(r.ok ? `✓ ${ref}（${r.ms}ms）：${r.reply}` : `✗ ${ref}：${r.error}`, r.ok ? "ok" : "err"); };
  return (
    <>
      <Card title="大脑">
        <Select value={brain} onChange={setBrain} options={[["", "自动（配了模型就用内置 agent）"], ["pi", "内置 agent"], ["openclaw", "OpenClaw CLI"]]} />
        <small class="muted"> 切换要重启</small>
      </Card>
      {m.providers.map((p: any, i: number) => (
        <Card title={`服务商 ${p.id}`} actions={<Btn small kind="danger" onClick={() => up((c) => c.providers.splice(i, 1))}>删除</Btn>}>
          <div class="form">
            <Field label="id"><Input value={p.id} onInput={(v) => up((c) => (c.providers[i].id = v))} /></Field>
            <Field label="接口类型"><Select value={p.api} onChange={(v) => up((c) => (c.providers[i].api = v))} options={APIS} /></Field>
            <Field label="接口地址"><Input value={p.base_url} onInput={(v) => up((c) => (c.providers[i].base_url = v))} /></Field>
            <Field label="API Key" hint="显示 *** 表示已保存，不改就保持"><Input type="password" value={p.api_key} onInput={(v) => up((c) => (c.providers[i].api_key = v))} /></Field>
          </div>
          <table><thead><tr><th>模型名</th><th>看图</th><th>上下文</th><th>最大输出</th><th>输入价</th><th>输出价</th><th></th></tr></thead>
            <tbody>{(p.models ?? []).map((x: any, j: number) => {
              const mm = (fn: (o: any) => void) => up((c) => fn(c.providers[i].models[j]));
              return <tr>
                <td><Input value={x.id} onInput={(v) => mm((o) => (o.id = v))} /></td>
                <td><input type="checkbox" checked={(x.input ?? []).includes("image")} onChange={(e) => mm((o) => (o.input = (e.target as HTMLInputElement).checked ? ["text", "image"] : ["text"]))} /></td>
                <td><Input type="number" value={x.context_window ?? ""} placeholder="64000" onInput={(v) => mm((o) => (o.context_window = v ? Number(v) : undefined))} /></td>
                <td><Input type="number" value={x.max_tokens ?? ""} placeholder="4096" onInput={(v) => mm((o) => (o.max_tokens = v ? Number(v) : undefined))} /></td>
                <td><Input type="number" value={x.cost?.input ?? ""} placeholder="¥/百万" onInput={(v) => mm((o) => (o.cost = { ...(o.cost ?? {}), input: Number(v) }))} /></td>
                <td><Input type="number" value={x.cost?.output ?? ""} placeholder="¥/百万" onInput={(v) => mm((o) => (o.cost = { ...(o.cost ?? {}), output: Number(v) }))} /></td>
                <td><Btn small onClick={() => testRef(`${p.id}/${x.id}`)}>测试</Btn><Btn small kind="ghost" onClick={() => up((c) => c.providers[i].models.splice(j, 1))}>✕</Btn></td>
              </tr>;
            })}</tbody></table>
          <Btn small onClick={() => up((c) => (c.providers[i].models = [...(c.providers[i].models ?? []), { id: "", input: ["text"] }]))}>＋ 模型</Btn>
        </Card>
      ))}
      <div class="row"><Btn onClick={() => up((c) => c.providers.push({ id: `p${c.providers.length + 1}`, api: "openai-completions", base_url: "", api_key: "", models: [] }))}>＋ 服务商</Btn></div>
      <Card title="默认模型">
        <div class="form">
          <Field label="默认" hint="agent 没单独指定时用它"><Select value={m.default ?? ""} onChange={(v) => up((c) => (c.default = v))} options={[["", "未选"], ...refs]} /></Field>
          <Field label="便宜模型" hint="压缩、记忆冲刷、heartbeat"><Select value={m.cheap ?? ""} onChange={(v) => up((c) => (c.cheap = v))} options={[["", "同默认"], ...refs]} /></Field>
        </div>
      </Card>
      <Card title="嵌入接口（可选）">
        <p class="muted">配了以后记忆检索会加上语义相似度（近义说法也能搜到）；不配就只用关键词。OpenAI 兼容的 /embeddings 接口。</p>
        <div class="form">
          <Field label="接口地址"><Input value={emb.base_url} onInput={(v) => setEmb({ ...emb, base_url: v })} /></Field>
          <Field label="API Key"><Input type="password" value={emb.api_key} onInput={(v) => setEmb({ ...emb, api_key: v })} /></Field>
          <Field label="模型名"><Input value={emb.model} onInput={(v) => setEmb({ ...emb, model: v })} /></Field>
        </div>
      </Card>
      <Btn kind="primary" onClick={() => save({ models: m, embedding: emb.base_url && emb.model ? emb : null, ...(brain ? { brain } : {}) })}>保存</Btn>
    </>
  );
}

function Voice({ cfg, save }: { cfg: any; save: (p: any) => Promise<void> }) {
  const [b, setB] = useState({ asr_key: "", asr_secret: "", tts_key: "", tts_secret: "", ...(cfg.baidu ?? {}) });
  const [tok, setTok] = useState({ api_token: cfg.api_token ?? "", stream_token: cfg.stream_token ?? "" });
  return (
    <>
      <Card title="百度语音（识别 + 合成）">
        <div class="form">
          <Field label="识别 API Key"><Input value={b.asr_key} onInput={(v) => setB({ ...b, asr_key: v })} /></Field>
          <Field label="识别 Secret Key"><Input type="password" value={b.asr_secret} onInput={(v) => setB({ ...b, asr_secret: v })} /></Field>
          <Field label="合成 API Key"><Input value={b.tts_key} onInput={(v) => setB({ ...b, tts_key: v })} /></Field>
          <Field label="合成 Secret Key"><Input type="password" value={b.tts_secret} onInput={(v) => setB({ ...b, tts_secret: v })} /></Field>
        </div>
        <Btn kind="primary" onClick={() => save({ baidu: b })}>保存（重启生效）</Btn>
      </Card>
      <Card title="局域网访问密钥">
        <p class="muted">API_TOKEN：设置后监控页和推送/拍照接口要带 X-Api-Token（留空 = 局域网开放）。STREAM_TOKEN 要同时改设备端。设备上行接口不受影响。</p>
        <div class="form">
          <Field label="API_TOKEN"><Input type="password" value={tok.api_token} onInput={(v) => setTok({ ...tok, api_token: v })} /></Field>
          <Field label="STREAM_TOKEN"><Input type="password" value={tok.stream_token} onInput={(v) => setTok({ ...tok, stream_token: v })} /></Field>
        </div>
        <Btn kind="primary" onClick={() => save(tok)}>保存（重启生效）</Btn>
      </Card>
    </>
  );
}

function Misc({ cfg, dataDir, save }: { cfg: any; dataDir: string; save: (p: any) => Promise<void> }) {
  const [p, setP] = useState({ port: cfg.port ?? 5000, mqtt_port: cfg.mqtt_port ?? 1883, disc_port: cfg.disc_port ?? 5001, stream_port: cfg.stream_port ?? 5002 });
  const [rt, setRt] = useState({ max_concurrency: cfg.runtime?.max_concurrency ?? 4, timeout_secs: cfg.runtime?.timeout_secs ?? 120 });
  return (
    <>
      <Card title="数据目录"><code>{dataDir}</code><p class="muted">人设、记忆、对话、定时任务、渠道配置都在这里。备份就拷这个目录。</p></Card>
      <Card title="端口（重启生效）">
        <p class="muted">改了端口：WSL 用户要同步改 Windows 端口转发和防火墙；设备靠 UDP 广播自动发现服务端，HTTP 端口变了要改设备配置。</p>
        <div class="form">
          {(["port", "mqtt_port", "disc_port", "stream_port"] as const).map((k) => (
            <Field label={{ port: "HTTP", mqtt_port: "MQTT", disc_port: "UDP 发现", stream_port: "直播 TCP" }[k]}>
              <Input type="number" value={p[k]} onInput={(v) => setP({ ...p, [k]: Number(v) })} /></Field>))}
        </div>
        <Btn kind="primary" onClick={() => save(p)}>保存</Btn>
      </Card>
      <Card title="运行时（重启生效）">
        <div class="form">
          <Field label="同时跑几轮对话" hint="全局并发上限"><Input type="number" value={rt.max_concurrency} onInput={(v) => setRt({ ...rt, max_concurrency: Number(v) })} /></Field>
          <Field label="单轮超时（秒）"><Input type="number" value={rt.timeout_secs} onInput={(v) => setRt({ ...rt, timeout_secs: Number(v) })} /></Field>
        </div>
        <Btn kind="primary" onClick={() => save({ runtime: rt })}>保存</Btn>
      </Card>
      <Card title="从 OpenClaw 导入"><p class="muted">在「定时任务」页点「从 OpenClaw 导入」：人设、记忆、定时任务一起搬过来。</p><Btn onClick={() => go("jobs")}>去导入</Btn></Card>
    </>
  );
}
