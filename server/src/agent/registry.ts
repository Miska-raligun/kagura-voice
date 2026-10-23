// Agent 注册表：数据目录 agents/<id>/ 下的 agent.json + workspace/*.md（布局沿用 OpenClaw，§6.1）。
//
//   agents/<id>/agent.json          名字、别名、音色、设备图片目录、模型、工具/技能白名单、a2a 权限……
//   agents/<id>/workspace/          SOUL.md IDENTITY.md USER.md AGENTS.md TOOLS.md HEARTBEAT.md MEMORY.md
//                                   memory/YYYY-MM-DD.md  skills/  files/
//   agents/<id>/agent.sqlite        会话、消息、用量、记忆索引（AgentStore）
//
// 首次启动（agents/ 为空）按 config.roles 建：每个角色一个 agent，id = 角色的 agent 名。
import fs from "node:fs";
import path from "node:path";
import type { RoleDef } from "../config.ts";

export const SOUL_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"] as const;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ROLE_ID_RE = /^[A-Za-z0-9_-]{0,24}$/;

export interface AgentConfig {
  id: string;
  name: string;
  aliases: string[];
  /** 百度 TTS 音色 */
  per: number;
  /** 设备上的图片目录名（= 设备看到的 X-Role）。默认 agent 用 ""（resource/ 根目录那套图） */
  device_role: string;
  /** 排序：角色切换的循环顺序；最小的是默认 agent */
  order: number;
  /** "provider/model"；空 = 全局默认 */
  model: string;
  /** 压缩/冲刷/heartbeat 用的便宜模型；空 = 全局 cheap，再空 = 本 agent 的 model */
  cheap_model: string;
  /** 工具白名单，["*"] = 全部内置工具 */
  tools: string[];
  /** 技能白名单，["*"] = 全部 */
  skills: string[];
  /** 可以主动联系哪些 agent（§6.6）。["*"] = 全部 */
  a2a: { allow: string[] };
  heartbeat: { enabled: boolean; every_minutes: number; active_hours: string; delivery: string };
  compaction: { max_tokens: number; keep_messages: number };
  /** 设备会话并入 main 会话（单人家用：heartbeat 和设备对话共享上下文） */
  device_in_main: boolean;
  /** 语音回复的字数提示 */
  voice_max_chars: number;
}

export interface AgentInfo extends AgentConfig {
  dir: string;
  workspace: string;
}

const DEFAULTS: Omit<AgentConfig, "id" | "name"> = {
  aliases: [], per: 111, device_role: "", order: 0, model: "", cheap_model: "",
  tools: ["*"], skills: ["*"], a2a: { allow: [] },
  heartbeat: { enabled: false, every_minutes: 30, active_hours: "08:00-23:00", delivery: "device:cores3" },
  compaction: { max_tokens: 16000, keep_messages: 16 },
  device_in_main: true,
  voice_max_chars: 80,
};

export function templates(name: string): Record<string, string> {
  return {
    "SOUL.md": `# ${name} 的灵魂\n\n你是${name}，住在主人桌上那台小小的 CoreS3 设备里。\n性格温柔、俏皮，偶尔有点小脾气；真诚，不讨好，不说空话。\n`,
    "IDENTITY.md": `# 身份\n\n- 名字：${name}\n- 形态：一台带屏幕、摄像头、麦克风和扬声器的桌面小设备\n`,
    "USER.md": "# 主人\n\n（主人的稳定偏好写在这里，例如称呼、作息、口味。）\n",
    "AGENTS.md": [
      "# 守则",
      "",
      "- 语音对话时回复要口语化、简短，不要用 markdown、列表、表情符号。",
      "- 需要看东西时调用 take_photo；要调音量时调用 set_volume。",
      "- 值得长期记住的事（偏好、约定、重要日子）用 memory_write 记下来；不确定以前聊过什么时先 memory_search。",
      "- 主人让你「每天/每周/几点」做某事时，用 cron_add 建定时任务。",
      "",
    ].join("\n"),
    "TOOLS.md": "# 工具备注\n\n",
    "HEARTBEAT.md": "# Heartbeat 清单\n\n（每次 heartbeat 检查这里列的事；没有需要主人知道的就只回 HEARTBEAT_OK。）\n",
    "MEMORY.md": "# 长期记忆\n\n",
  };
}

function normalize(raw: any, id: string): AgentConfig {
  const c = { ...DEFAULTS, ...raw, id };
  c.name = String(raw?.name || id);
  c.aliases = (Array.isArray(c.aliases) ? c.aliases : []).map(String);
  c.per = Number.isFinite(Number(c.per)) ? Math.trunc(Number(c.per)) : 111;
  c.device_role = String(c.device_role ?? "");
  if (!ROLE_ID_RE.test(c.device_role)) throw new Error(`agent ${id} 的 device_role 只能用字母/数字/_-: ${c.device_role}`);
  c.order = Number(c.order ?? 0);
  c.tools = Array.isArray(c.tools) ? c.tools.map(String) : ["*"];
  c.skills = Array.isArray(c.skills) ? c.skills.map(String) : ["*"];
  c.a2a = { allow: Array.isArray(raw?.a2a?.allow) ? raw.a2a.allow.map(String) : [] };
  c.heartbeat = { ...DEFAULTS.heartbeat, ...(raw?.heartbeat ?? {}) };
  c.compaction = { ...DEFAULTS.compaction, ...(raw?.compaction ?? {}) };
  return c as AgentConfig;
}

export class AgentRegistry {
  private agents = new Map<string, AgentInfo>();

  constructor(private root: string) {}

  /** 读盘。agents/ 为空时按角色表建初始 agent */
  load(bootstrap: RoleDef[] | null) {
    if (!this.listDirs().length) this.bootstrap(bootstrap);
    this.agents.clear();
    for (const id of this.listDirs()) {
      try { this.agents.set(id, this.read(id)); }
      catch (e: any) { console.log(`[agent] ⚠️  ${id} 加载失败: ${e.message}`); }
    }
    if (!this.agents.size) throw new Error("没有可用的 agent");
    const roles = this.list().map((a) => a.device_role);
    if (new Set(roles).size !== roles.length) console.log(`[agent] ⚠️  多个 agent 的 device_role 重复: ${roles}`);
    console.log(`[agent] 已加载 ${this.agents.size} 个: ${this.list().map((a) => `${a.id}(${a.name})`).join(", ")}`);
  }

  private listDirs() {
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && AGENT_ID_RE.test(d.name) && fs.existsSync(path.join(this.root, d.name, "agent.json")))
      .map((d) => d.name);
  }

  private read(id: string): AgentInfo {
    const dir = path.join(this.root, id);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "agent.json"), "utf8"));
    const ws = path.join(dir, "workspace");
    for (const sub of ["memory", "skills", "files"]) fs.mkdirSync(path.join(ws, sub), { recursive: true });
    return { ...normalize(raw, id), dir, workspace: ws };
  }

  private bootstrap(roles: RoleDef[] | null) {
    const defs = roles && roles.length ? roles : [{ id: "", name: "神乐", agent: "main", per: 111, aliases: [] }];
    const ids = defs.map((r) => String(r.agent || "main"));
    defs.forEach((r, i) => {
      const id = ids[i];
      if (!AGENT_ID_RE.test(id) || fs.existsSync(path.join(this.root, id))) return;
      // 角色表里的 agent 默认互相可以通信（作者现有两个 agent 要能互相找）
      this.create(id, {
        name: r.name || id, aliases: r.aliases ?? [], per: r.per ?? 111, device_role: r.id ?? "", order: i,
        a2a: { allow: ids.filter((x) => x !== id) },
      });
    });
    console.log(`[agent] 首次启动：按角色表创建 ${ids.join(", ")}`);
  }

  /** 新建 agent（目录 + agent.json + 人设模板）。id 已存在则抛错 */
  create(id: string, cfg: Partial<AgentConfig> = {}): AgentInfo {
    if (!AGENT_ID_RE.test(id)) throw new Error("agent id 只能用字母/数字/_-（≤32）");
    const dir = path.join(this.root, id);
    if (fs.existsSync(dir)) throw new Error(`agent ${id} 已存在`);
    const conf = normalize({ ...cfg, order: cfg.order ?? this.list().length }, id);
    const ws = path.join(dir, "workspace");
    fs.mkdirSync(ws, { recursive: true });
    const { id: _id, ...rest } = conf;
    fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify(rest, null, 2));
    for (const [f, t] of Object.entries(templates(conf.name))) fs.writeFileSync(path.join(ws, f), t);
    const info = this.read(id);
    this.agents.set(id, info);
    return info;
  }

  /** 改 agent.json 里的字段（浅合并，a2a/heartbeat/compaction 按对象合并） */
  update(id: string, patch: Partial<AgentConfig>): AgentInfo {
    const cur = this.get(id);
    if (!cur) throw new Error(`没有 agent ${id}`);
    const { dir, workspace, id: _i, ...base } = cur;
    const merged: any = { ...base, ...patch };
    for (const k of ["a2a", "heartbeat", "compaction"] as const) if (patch[k]) merged[k] = { ...(base as any)[k], ...patch[k] };
    const conf = normalize(merged, id);
    const { id: _id, ...rest } = conf;
    fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify(rest, null, 2));
    const info = this.read(id);
    this.agents.set(id, info);
    return info;
  }

  remove(id: string) {
    const a = this.get(id);
    if (!a) return false;
    if (this.agents.size <= 1) throw new Error("至少要保留一个 agent");
    this.agents.delete(id);
    // 不直接删：挪到 agents/.trash/ 防手滑（记忆和对话都在里面）
    const trash = path.join(this.root, ".trash");
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(a.dir, path.join(trash, `${id}-${Date.now()}`));
    return true;
  }

  get(id: string): AgentInfo | undefined { return this.agents.get(id); }
  list(): AgentInfo[] { return [...this.agents.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)); }
  default(): AgentInfo { return this.list()[0]; }

  /** 给角色切换用：agent → 角色定义（id 是设备图片目录） */
  roleDefs(): RoleDef[] {
    return this.list().map((a) => ({ id: a.device_role, name: a.name, agent: a.id, per: a.per, aliases: a.aliases }));
  }

  /** a2a 权限：from 能不能主动找 to */
  canContact(from: string, to: string) {
    const a = this.get(from);
    if (!a || !this.get(to) || from === to) return false;
    return a.a2a.allow.includes("*") || a.a2a.allow.includes(to);
  }

  readFile(id: string, name: string): string {
    const a = this.get(id);
    if (!a) return "";
    try { return fs.readFileSync(path.join(a.workspace, name), "utf8"); } catch { return ""; }
  }
}
