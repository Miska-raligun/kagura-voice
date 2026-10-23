// 页面之间共用的小部件
import { api, go } from "../api.ts";
import { Select, useLoad } from "../ui.tsx";

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

/** 一条消息的展示：用户 / 助手（含工具调用）/ 工具结果 */
export function Message({ m }: { m: any }) {
  const msg = m.msg ?? m;
  const parts = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];
  const cls = msg.role === "user" ? "u" : msg.role === "assistant" ? "a" : "t";
  return (
    <div class={`msg ${cls} ${m.compacted ? "old" : ""}`}>
      <div class="who">{msg.role === "user" ? "用户" : msg.role === "assistant" ? "助手" : `工具结果 ${msg.toolName ?? ""}`}
        {m.ts && <small> {new Date(m.ts * 1000).toLocaleString("zh-CN", { hour12: false })}</small>}{m.compacted ? <small>（已压缩）</small> : null}{msg.isError && <small class="over"> 出错</small>}</div>
      {parts.map((c: any) => {
        // 运行时自动附在每条消息前的 [时间…] 行，淡化显示
        if (c.type === "text" && /^\[时间 [^\]]*\]$/.test(c.text)) return <div class="muted small">{c.text}</div>;
        if (c.type === "text") return <div class="txt">{c.text}</div>;
        if (c.type === "toolCall") return <div class="tool">🔧 <code>{c.name}</code> {JSON.stringify(c.arguments)}</div>;
        if (c.type === "thinking") return <details class="think"><summary>思考</summary>{c.thinking}</details>;
        if (c.type === "image") return <div class="muted">[图片]</div>;
        return null;
      })}
    </div>
  );
}
