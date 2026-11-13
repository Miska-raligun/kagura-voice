// 工具按需加载（LRN 2026-11-13，症状「系统提示上万 token」里固定的那一块：45 个工具的定义约 5300 token，每次调模型都带）。
// 平时用得少的管理类工具分成几组，不摆出来，系统提示里只留一段目录（<more_tools>）；她要用时调 tools_load，
// 这一轮接下来就能直接调（pi 的 prepareNextTurn 换工具集，库会把变化告诉模型），这个会话里之后也一直在（Runtime 记着，闲置 LOADED_TTL_MS 后收回）。
// 常用的留在外面：聊天里随口就会用到的（cron_add 建提醒、sessions_send 传话、task_add 记待办）、干活的（exec、文件工具）、
// 会改响应头 / 被系统按名字认的（take_photo、set_volume）、随处可能要用的（记忆、read_ref、联网）。
// 待办、子任务这类干活的场景不延后（没人盯着，少一步是一步）。
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
export const groupOf = (name: string) => TOOL_GROUPS.find((g) => g.has(name))?.id ?? "";
export const LOAD_TOOL = "tools_load";
/** 加载过的组在这个会话里留多久（最后一次用到之后） */
export const LOADED_TTL_MS = 6 * 3600_000;

/** 一轮里的工具集：哪些摆出来、哪些还收着 */
export class LazyTools {
  /** 这一轮里刚加载了新的组、还没告诉模型（Runtime 在下一次调模型前换工具集） */
  dirty = false;
  private loader: AgentTool<any>;

  constructor(private all: AgentTool<any>[], readonly loaded: Set<string>, wrap: (t: AgentTool<any>) => AgentTool<any>, private onLoad: (ids: string[]) => void) {
    this.loader = wrap({
      name: LOAD_TOOL, label: "加载工具组",
      description: "把还没摆出来的工具组加载进来（有哪些组见系统提示里的 <more_tools>）。加载后马上就能直接调用里面的工具，这个对话里之后一直在。可以一次加载多组。",
      parameters: Type.Object({ groups: Type.Array(Type.String(), { description: "组名，如 [\"cron\"]" }) }),
      execute: async (_id: string, p: any) => {
        const want = (Array.isArray(p?.groups) ? p.groups : [p?.groups ?? p?.group]).map((x: unknown) => String(x ?? "").trim()).filter(Boolean);
        const hidden = this.hidden();
        const got = this.load(want);
        const lines = got.map((id) => `${id}：${hidden.get(id)!.map((t) => `${t.name}（${t.label}）`).join("、")}`);
        const bad = want.filter((id: string) => !got.includes(id) && !this.loaded.has(id));
        if (!got.length && bad.length) return { content: [{ type: "text", text: `没有这个工具组：${bad.join("、")}。还没加载的有：${[...hidden.keys()].join("、") || "（都加载了）"}` }], details: {}, isError: true } as any;
        return { content: [{ type: "text", text: (lines.length ? `加载好了，现在直接调用就行：\n${lines.join("\n")}` : "这几组本来就加载着，直接调用就行") + (bad.length ? `\n（没有这个组：${bad.join("、")}）` : "") }], details: { loaded: got } } as any;
      },
    } as AgentTool<any>);
  }

  private deferred = (t: AgentTool<any>) => { const g = groupOf(t.name); return !!g && !this.loaded.has(g); };
  /** 还收着的：组 → 工具 */
  hidden(): Map<string, AgentTool<any>[]> {
    const m = new Map<string, AgentTool<any>[]>();
    for (const g of TOOL_GROUPS) {                 // 按组的固定顺序，不跟着工具注册顺序变
      const ts = this.all.filter((t) => this.deferred(t) && g.has(t.name));
      if (ts.length) m.set(g.id, ts);
    }
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
    const lines = TOOL_GROUPS.filter((g) => hidden.has(g.id)).map((g) => `- ${g.id}（${g.label}）：${g.hint}——${hidden.get(g.id)!.map((t) => t.name).join("、")}`);
    return `<more_tools>\n下面几组工具平时用得少，没有摆出来。要用时先调 ${LOAD_TOOL}（groups 填组名，可以一次几组），加载后直接调用，这个对话里之后一直能用：\n${lines.join("\n")}\n`
      + "别因为眼前没有这个工具就说做不了——先看这里有没有。\n</more_tools>";
  }
}
