// 页面之间共用的小部件
import { api, go } from "../api.ts";
import { Select, useLoad } from "../ui.tsx";
import { renderMarkdown } from "../md.ts";

/** 顶部的 agent 选择器（切换时改路由参数） */
export function AgentPicker({ page, value }: { page: string; value: string }) {
  const [list] = useLoad(() => api<any[]>("/agents"));
  if (!list) return null;
  const v = value || list[0]?.id || "";
  return <div class="picker">Agent：<Select value={v} onChange={(x) => go(page, x)} options={list.map((a) => [a.id, `${a.name}（${a.id}）`] as [string, string])} /></div>;
}

export function useAgentId(arg: string) {
  const [list] = useLoad(() => api<any[]>("/agents"));
  return arg.split("|")[0] || list?.[0]?.id || "";
}

/** 用户消息里附的文件：<file name=… path=…>内容</file> 折叠起来，只显示文件名 */
function UserText({ text }: { text: string }) {
  const parts: any[] = [];
  const re = /<file name="([^"]*)" path="([^"]*)">\n?([\s\S]*?)\n?<\/file>|\[附件 ([^（\]]+)（([^）]*)）已保存到[^\]]*\]/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) parts.push(<div class="txt">{text.slice(last, m.index).trim()}</div>);
    parts.push(m[1] !== undefined
      ? <details class="file"><summary>📎 {m[1]} <small class="muted">{m[2]}</small></summary><pre>{m[3]}</pre></details>
      : <div class="file">📎 {m[4]} <small class="muted">{m[5]} · 已存到工作目录</small></div>);
    last = m.index + m[0].length;
  }
  if (last < text.length && text.slice(last).trim()) parts.push(<div class="txt">{text.slice(last).trim()}</div>);
  return <>{parts}</>;
}

/** 一条消息的展示：用户 / 助手（Markdown 渲染，含工具调用）/ 工具结果（折叠） */
const SRC: Record<string, string> = { webchat: "网页", device: "设备", feishu: "飞书", qq: "QQ", onebot: "QQ", a2a: "agent", system: "系统" };
const PURPOSE_SRC: Record<string, string> = { heartbeat: "heartbeat", cron: "定时任务", task: "待办" };
/** 这条用户消息从哪来：飞书 / 设备 cores3 / heartbeat… */
function srcLabel(k: { channel: string; purpose?: string; device?: string }) {
  if (k.purpose && PURPOSE_SRC[k.purpose]) return PURPOSE_SRC[k.purpose];
  return (SRC[k.channel] ?? k.channel) + (k.device ? ` ${k.device}` : "");
}

export function Message({ m, agent = "" }: { m: any; agent?: string }) {
  const upl = (rel: string) => `/api/admin/agents/${encodeURIComponent(agent)}/uploads?path=${encodeURIComponent(rel)}`;
  const imgRef = (t: string) => /^\[图片 (uploads\/[^\]]+)\]$/.exec(t.trim())?.[1];
  const msg = m.msg ?? m;
  const parts = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];
  const cls = msg.role === "user" ? "u" : msg.role === "assistant" ? "a" : "t";
  const time = m.ts && <small> {new Date(m.ts * 1000).toLocaleString("zh-CN", { hour12: false })}</small>;
  if (cls === "t") {
    const text = parts.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    return (
      <details class={`msg t ${m.compacted ? "old" : ""}`}>
        <summary class="who">🔧 工具结果 {msg.toolName ?? ""}{msg.isError && <small class="over"> 出错</small>}{time}</summary>
        {text && (agent && imgRef(text) ? <a href={upl(imgRef(text)!)} target="_blank"><img class="chatimg" src={upl(imgRef(text)!)} /></a> : <pre class="toolout">{text}</pre>)}
        {parts.filter((c: any) => c.type === "image").map((c: any) => <img class="chatimg" src={`data:${c.mimeType};base64,${c.data}`} />)}
      </details>
    );
  }
  return (
    <div class={`msg ${cls} ${m.compacted ? "old" : ""}`}>
      <div class="who">{msg.role === "user" ? (msg.ksrc?.purpose === "note" ? `她主动说的（${msg.ksrc.tag}）` : "用户") : "助手"}{msg.role === "user" && msg.ksrc && msg.ksrc.purpose !== "note" ? <small class="src">{srcLabel(msg.ksrc)}</small> : null}{time}{m.compacted ? <small>（已压缩）</small> : null}{msg.isError && <small class="over"> 出错</small>}</div>
      {parts.map((c: any) => {
        // 运行时自动附在每条消息前的 [时间…] 行，淡化显示
        if (c.type === "text" && /^\[时间 [^\]]*\]$/.test(c.text)) return <div class="muted small">{c.text}</div>;
        if (c.type === "text" && agent && imgRef(c.text)) return <a href={upl(imgRef(c.text)!)} target="_blank"><img class="chatimg" src={upl(imgRef(c.text)!)} /></a>;
        if (c.type === "text") return cls === "a" ? <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.text) }} /> : <UserText text={c.text} />;
        if (c.type === "toolCall") return <div class="tool">🔧 <code>{c.name}</code> <span class="muted">{JSON.stringify(c.arguments).slice(0, 300)}</span></div>;
        if (c.type === "thinking") return <details class="think"><summary>思考</summary>{c.thinking}</details>;
        if (c.type === "image") return c.data ? <img class="chatimg" src={`data:${c.mimeType};base64,${c.data}`} /> : <div class="muted">[图片]</div>;
        return null;
      })}
      {msg.errorMessage && <div class="over small">{msg.errorMessage}</div>}
    </div>
  );
}
