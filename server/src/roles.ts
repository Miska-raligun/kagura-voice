// 角色切换：每台设备当前在跟哪个角色说话（对应 roles.py）。
// 一个角色 = 一个 agent + 一个百度音色 + 设备上一套背景图。
// - 第一个角色是默认角色：会话 key 就是 device_id（沿用旧会话），其他角色是 "device_id~role_id"
// - 每台设备当前角色落盘 roles_state.json，服务端重启不丢
import fs from "node:fs";
import type { RoleDef } from "./config.ts";

export interface Role { id: string; name: string; agent: string; per: number; tts_provider: string; tts_voice: string; aliases: string[] }

/** 这个角色说话用的声音（合成服务商 + 音色；百度用 per） */
export const roleVoice = (r: Pick<Role, "per" | "tts_provider" | "tts_voice">) =>
  ({ per: r.per, ...(r.tts_provider ? { provider: r.tts_provider } : {}), ...(r.tts_voice ? { voice: r.tts_voice } : {}) });

const DEFAULT: RoleDef[] = [{ id: "", name: "神乐", agent: "main", per: 111, aliases: [] }];
const ID_RE = /^[A-Za-z0-9_-]{0,24}$/;
const PUNCT = /[\s，。！？、,.!?~～…]+/g;
// 只有"切换意图词"和"角色名"同时出现才算：防止"换个话题""让我想想"误触发
const SWITCH = /(切换|切到|切成|换成|换到|换回|召唤|我要找|我想找|我要和|我想和|我要跟|我想跟)/;
// 「叫/让」太常见（"让神乐唱首歌"不是切换），只认「叫 XX 出来」「让 XX 来」
const LIST = /(有哪些|有几个|都有谁|有什么)(角色|人)/;
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function norm(r: RoleDef): Role {
  const id = String(r.id ?? "");
  // id 要进 HTTP 头（X-Role）、要当设备上的目录名：只许 ASCII 字母数字
  if (!ID_RE.test(id)) throw new Error(`角色 id 只能用字母/数字/_-（≤24）: ${JSON.stringify(id)}`);
  return {
    id,
    name: String(r.name || r.id || "默认"),
    agent: String(r.agent || "main"),
    per: Number.isFinite(Number(r.per)) && r.per !== undefined ? Math.trunc(Number(r.per)) : 111,
    tts_provider: String(r.tts_provider ?? ""),
    tts_voice: String(r.tts_voice ?? ""),
    aliases: (r.aliases ?? []).map(String),
  };
}

export class Roles {
  private roles: Role[] = [];
  private current = new Map<string, string>();

  constructor(defs: RoleDef[] | null, private stateFile: string) {
    this.roles = (defs && defs.length ? defs : DEFAULT).map(norm);
    const ids = this.roles.map((r) => r.id);
    if (new Set(ids).size !== ids.length) throw new Error(`ROLES 里 id 重复: ${ids}`);
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      for (const [k, v] of Object.entries(data)) if (ids.includes(v as string)) this.current.set(k, v as string);
    } catch { /* 没有状态文件 = 都是默认角色 */ }
  }

  all(): Role[] { return [...this.roles]; }
  default(): Role { return this.roles[0]; }
  find(id: string): Role | undefined { return this.roles.find((r) => r.id === id); }

  get(dev: string): Role {
    const id = this.current.get(dev);
    return (id !== undefined && this.find(id)) || this.default();
  }

  /** 设备换了角色时回调（出口：切到某个角色就把留给它的话播出来） */
  onSwitch: ((dev: string, role: Role) => void) | null = null;

  /** 切换设备角色并落盘。role_id 不存在返回 null。 */
  set(dev: string, id: string): Role | null {
    const role = this.find(id);
    if (!role) return null;
    const changed = this.get(dev).id !== id;
    if (id === this.default().id) this.current.delete(dev);
    else this.current.set(dev, id);
    try {
      const tmp = this.stateFile.replace(/\.json$/, "") + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.current)), "utf8");
      fs.renameSync(tmp, this.stateFile);
    } catch (e: any) {
      console.log(`[role] 状态落盘失败: ${e.message}`);
    }
    if (changed) this.onSwitch?.(dev, role);
    return role;
  }

  next(dev: string): Role {
    const ids = this.roles.map((r) => r.id);
    return this.roles[(ids.indexOf(this.get(dev).id) + 1) % this.roles.length];
  }

  greeting(r: Role) { return `我是${r.name}，有什么事吗？`; }

  sessionKey(dev: string, r: Role) { return r.id === this.default().id ? dev : `${dev}~${r.id}`; }

  private names(r: Role) { return [r.name, r.id, ...r.aliases].filter(Boolean); }

  /** 「切换到 XX / 叫 XX 出来 / 我想和 XX 说话」→ 目标角色 */
  matchSwitch(text: string): Role | null {
    if (this.roles.length < 2) return null;
    const t = (text || "").replace(PUNCT, "").toLowerCase();
    const strong = SWITCH.test(t);
    let best: Role | null = null, bestLen = 0;
    for (const r of this.roles) {
      for (let n of this.names(r)) {
        n = n.toLowerCase();
        if (!t.includes(n) || Array.from(n).length <= bestLen) continue;   // 最长匹配：「小神乐」优先于「神乐」
        if (strong || new RegExp("(叫|让)" + reEscape(n) + "(出来|过来|来)").test(t)) { best = r; bestLen = Array.from(n).length; }
      }
    }
    return best;
  }

  matchList(text: string): string | null {
    if (this.roles.length < 2 || !LIST.test((text || "").replace(PUNCT, ""))) return null;
    return "现在有" + this.roles.map((r) => r.name).join("、") + "，说「切换到」加名字就能换。";
  }
}
