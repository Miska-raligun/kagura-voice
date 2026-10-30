// 工具权限（按场景，场景见 soul.ts 的 sceneOf）：在 agent 自己的工具白名单之上再收一层，所有 agent 共用。
//
//   群聊 / 陌生人（guest）：**默认什么都不给，只放白名单**。以前反过来（默认都给、危险的单独拦），漏拦一个就是一个洞——
//                          2026-10-27 检查出陌生人能让家里摄像头拍照并发回群里、问出主人在不在家、读主人的聊天记录、借 web_fetch 读本机管理接口。
//                          碰家里设备、主人隐私、执行代码、替主人花额度的工具（GUEST_LOCKED）配置里也加不上。
//                          扩展 / MCP 的工具：作者或主人标了 allowUntrusted 的才会出现在陌生人那边（提供者自己就过滤了），这里默认放行，可单独关。
//   其它场景（主人对话、heartbeat、定时任务、待办、子任务、agent 间）：默认全给，按需关掉（deny）。
//
// config.json：{ "tool_policy": { "guest": ["web_search", …], "deny": { "task": ["take_photo"], "guest": ["mcp_x"] } } }
import type { Scene } from "./soul.ts";

export const DEFAULT_GUEST_TOOLS = ["web_search", "web_fetch", "skill_read", "set_volume"];
const LOCKED_NAMES = new Set(["exec", "take_photo", "get_presence", "set_presence", "announce"]);
const LOCKED_PREFIX = ["sessions_", "memory_", "task_", "cron_", "photo_schedule_", "extension_", "package_"];

/** 永远不给群聊 / 陌生人的内置工具 */
export const guestLocked = (name: string) => LOCKED_NAMES.has(name) || LOCKED_PREFIX.some((p) => name.startsWith(p));

export interface ToolPolicy { guest: string[]; deny: Partial<Record<Scene, string[]>> }

export const POLICY: ToolPolicy = { guest: [...DEFAULT_GUEST_TOOLS], deny: {} };

export function applyToolPolicy(raw: any) {
  const p = raw && typeof raw === "object" ? raw : {};
  POLICY.guest = Array.isArray(p.guest) ? p.guest.map(String).filter((n: string) => !guestLocked(n)) : [...DEFAULT_GUEST_TOOLS];
  POLICY.deny = {};
  for (const [k, v] of Object.entries(p.deny ?? {})) if (Array.isArray(v)) (POLICY.deny as any)[k] = v.map(String);
}

/** 这个场景能不能用这个工具。plugin = 扩展 / MCP 提供的（陌生人那边能看到的已经是标了 allowUntrusted 的） */
export function toolAllowed(scene: Scene, name: string, plugin: boolean): boolean {
  if (POLICY.deny[scene]?.includes(name)) return false;
  if (scene !== "guest") return true;
  if (plugin) return true;
  return !guestLocked(name) && POLICY.guest.includes(name);
}
