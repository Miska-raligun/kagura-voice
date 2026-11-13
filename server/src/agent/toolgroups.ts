// 工具按需加载（LRN 2026-11-13，症状「系统提示上万 token」里固定的那一块：45 个工具的定义约 5300 token，每次调模型都带）。
// 平时用得少的管理类工具分成几组，不摆出来，系统提示里只留一段目录（<more_tools>）；她要用时调 tools_load，
// 这一轮接下来就能直接调（pi 的 prepareNextTurn 换工具集，库会把变化告诉模型），这个会话里之后也一直在（Runtime 记着，闲置 LOADED_TTL_MS 后收回）。
// 常用的留在外面：聊天里随口就会用到的（cron_add 建提醒、sessions_send 传话、task_add 记待办）、干活的（exec、文件工具）、
// 会改响应头 / 被系统按名字认的（take_photo、set_volume）、随处可能要用的（记忆、read_ref、联网）。
// 待办、子任务这类干活的场景不延后（没人盯着，少一步是一步）。
// MCP 服务器也按这个收（2026-11，接浏览器这类大件时）：一个服务器一组（mcp_<名字>），工具自己带着组信息（lazyGroup）。
// 浏览器的 MCP 一接就是二十多个工具、几千 token；小的（定义加起来不到 AUTO_LAZY_TOKENS）照常摆着，服务器配置里 "lazy": true / false 可以指定。
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface ToolGroup { id: string; label: string; hint: string; has: (name: string) => boolean }

const oneOf = (...names: string[]) => (n: string) => names.includes(n);
export const TOOL_GROUPS: ToolGroup[] = [
  { id: "cron", label: "定时任务管理", hint: "看有哪些定时任务 / 提醒，改、删、立即运行（新建用 cron_add，不用加载）", has: (n) => n.startsWith("cron_") && n !== "cron_add" },
  { id: "photo", label: "定时拍照", hint: "每天定点让设备拍一张看看：新建、改、删、列出", has: (n) => n.startsWith("photo_schedule_") },
  { id: "agents", label: "其他 agent 与子任务", hint: "看别的 agent 的会话记录、把一件事派到后台做（子任务）、给子任务补充要求（传话用 sessions_send，不用加载）", has: (n) => n.startsWith("sessions_") && n !== "sessions_send" },
  { id: "ext", label: "扩展", hint: "给自己写 / 装 / 删扩展和扩展包（加新工具）", has: (n) => n.startsWith("extension_") || n.startsWith("package_") },
  { id: "manage", label: "待办与记忆管理", hint: "看 / 改 / 撤销待办（记待办用 task_add，不用加载），整理记忆和守则文件", has: oneOf("task_list", "task_update", "task_cancel", "memory_tidy") },
];
/** 内置的几组里它属于哪组（工具自带的组不在这里，一轮里的归属问 LazyTools.groupOf） */
export const groupOf = (name: string) => TOOL_GROUPS.find((g) => g.has(name))?.id ?? "";
/** 工具自带的组（MCP：一个服务器一组）。lazy：true 一定收着 / false 一定摆出来 / 不写 = 这组定义超过 AUTO_LAZY_TOKENS 才收 */
export interface LazyGroupMeta { id: string; label: string; hint: string; lazy?: boolean }
export const lazyMeta = (t: AgentTool<any>): LazyGroupMeta | undefined => (t as any).lazyGroup;
/** 自带组的工具定义加起来超过这么多 token 才默认收着（三五个小工具的服务器不值得多一次往返） */
export const AUTO_LAZY_TOKENS = 800;
export const isLazy = (lazy: boolean | undefined, tokens: number) => lazy ?? tokens > AUTO_LAZY_TOKENS;
/** 目录里自带组最多列几个工具名（只是让她知道里面大概有什么，加载后才看得到完整定义） */
const CATALOG_NAMES = 12;
export const LOAD_TOOL = "tools_load";
/** 加载过的组在这个会话里留多久（最后一次用到之后） */
export const LOADED_TTL_MS = 6 * 3600_000;

/** 一轮里的工具集：哪些摆出来、哪些还收着 */
export class LazyTools {
  /** 这一轮里刚加载了新的组、还没告诉模型（Runtime 在下一次调模型前换工具集） */
  dirty = false;
  private loader: AgentTool<any>;
  /** 这一轮里能收着的组（内置的按固定顺序在前，工具自带的按出现顺序在后）；只含这一轮真有工具的 */
  private groups: { id: string; label: string; hint: string; own: boolean; tools: AgentTool<any>[] }[] = [];
  private byTool = new Map<string, string>();

  constructor(private all: AgentTool<any>[], readonly loaded: Set<string>, wrap: (t: AgentTool<any>) => AgentTool<any>, private onLoad: (ids: string[]) => void,
    size: (t: AgentTool<any>) => number = (t) => Math.ceil(JSON.stringify([t.name, t.description, t.parameters]).length / 3)) {
    for (const g of TOOL_GROUPS) {
      const tools = all.filter((t) => g.has(t.name));
      if (tools.length) this.groups.push({ id: g.id, label: g.label, hint: g.hint, own: false, tools });
    }
    const own = new Map<string, { meta: LazyGroupMeta; tools: AgentTool<any>[] }>();
    for (const t of all) {
      const meta = lazyMeta(t);
      if (!meta?.id || groupOf(t.name)) continue;
      const e = own.get(meta.id) ?? { meta, tools: [] };
      e.tools.push(t);
      own.set(meta.id, e);
    }
    for (const { meta, tools } of own.values()) {
      if (!isLazy(meta.lazy, tools.reduce((n, t) => n + size(t), 0))) continue;
      this.groups.push({ id: meta.id, label: meta.label, hint: meta.hint, own: true, tools });
    }
    for (const g of this.groups) for (const t of g.tools) this.byTool.set(t.name, g.id);
    this.loader = wrap({
      name: LOAD_TOOL, label: "加载工具组",
      description: "把还没摆出来的工具组加载进来（有哪些组见系统提示里的 <more_tools>）。加载后马上就能直接调用里面的工具，这个对话里之后一直在。可以一次加载多组。",
      parameters: Type.Object({ groups: Type.Array(Type.String(), { description: "组名，如 [\"cron\"]" }) }),
      execute: async (_id: string, p: any) => {
        // 组名写得不太对也认：给了里面某个工具的名字、MCP 服务器只写了名字没带 mcp_
        const want = (Array.isArray(p?.groups) ? p.groups : [p?.groups ?? p?.group]).map((x: unknown) => String(x ?? "").trim()).filter(Boolean)
          .map((x: string) => (this.groups.some((g) => g.id === x) ? x : this.byTool.get(x) ?? (this.groups.some((g) => g.id === `mcp_${x}`) ? `mcp_${x}` : x)));
        const hidden = this.hidden();
        const got = this.load(want);
        const lines = got.map((id) => `${id}：${hidden.get(id)!.map((t) => `${t.name}（${t.label}）`).join("、")}`);
        const bad = want.filter((id: string) => !got.includes(id) && !this.loaded.has(id));
        if (!got.length && bad.length) return { content: [{ type: "text", text: `没有这个工具组：${bad.join("、")}。还没加载的有：${[...hidden.keys()].join("、") || "（都加载了）"}` }], details: {}, isError: true } as any;
        return { content: [{ type: "text", text: (lines.length ? `加载好了，现在直接调用就行：\n${lines.join("\n")}` : "这几组本来就加载着，直接调用就行") + (bad.length ? `\n（没有这个组：${bad.join("、")}）` : "") }], details: { loaded: got } } as any;
      },
    } as AgentTool<any>);
  }

  /** 这一轮里这个工具归哪组（不在任何能收的组里 = ""） */
  groupOf(name: string): string { return this.byTool.get(name) ?? ""; }
  private deferred = (t: AgentTool<any>) => { const g = this.byTool.get(t.name); return !!g && !this.loaded.has(g); };
  /** 还收着的：组 → 工具 */
  hidden(): Map<string, AgentTool<any>[]> {
    const m = new Map<string, AgentTool<any>[]>();
    for (const g of this.groups) if (!this.loaded.has(g.id)) m.set(g.id, g.tools);   // 按组的固定顺序，不跟着工具注册顺序变
    return m;
  }
  /** 摆出来的（还有收着的组时带上 tools_load） */
  visible(): AgentTool<any>[] {
    const v = this.all.filter((t) => !this.deferred(t));
    return this.hidden().size ? [...v, this.loader] : v;
  }
  /** 加载几组，返回真正新加载的 */
  load(ids: string[]): string[] {
    const hidden = this.hidden();
    const got = [...new Set(ids)].filter((id) => hidden.has(id));
    if (!got.length) return [];
    for (const id of got) this.loaded.add(id);
    this.dirty = true;
    this.onLoad(got);
    return got;
  }
  /** 系统提示里的目录 */
  catalog(): string {
    const hidden = this.hidden();
    if (!hidden.size) return "";
    const lines = this.groups.filter((g) => hidden.has(g.id)).map((g) => {
      if (!g.own) return `- ${g.id}（${g.label}）：${g.hint}——${g.tools.map((t) => t.name).join("、")}`;
      // 工具自带的组（MCP 服务器）：工具多、名字长，只列一部分（去掉共同的前缀），加载后才有完整定义
      const pre = g.tools.every((t) => t.name.startsWith(`${g.id.replace(/^mcp_/, "mcp__")}__`)) ? `${g.id.replace(/^mcp_/, "mcp__")}__` : "";
      const names = g.tools.slice(0, CATALOG_NAMES).map((t) => t.name.slice(pre.length)).join("、");
      return `- ${g.id}（${g.label}）：${g.hint ? `${Array.from(g.hint).slice(0, 120).join("")}——` : ""}共 ${g.tools.length} 个工具${pre ? `（名字以 ${pre} 开头）` : ""}：${names}${g.tools.length > CATALOG_NAMES ? " 等" : ""}`;
    });
    return `<more_tools>\n下面几组工具平时用得少，没有摆出来。要用时先调 ${LOAD_TOOL}（groups 填组名，可以一次几组），加载后直接调用，这个对话里之后一直能用：\n${lines.join("\n")}\n`
      + "别因为眼前没有这个工具就说做不了——先看这里有没有。\n</more_tools>";
  }
}
