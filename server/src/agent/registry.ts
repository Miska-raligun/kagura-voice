// Agent 注册表：数据目录 agents/<id>/ 下的 agent.json + workspace/*.md（布局沿用 OpenClaw，§6.1）。
//
//   agents/<id>/agent.json          名字、别名、音色、设备图片目录、模型、工具/技能白名单、a2a 权限……
//   agents/<id>/workspace/          SOUL.md IDENTITY.md USER.md AGENTS.md TOOLS.md HEARTBEAT.md MEMORY.md
//                                   memory/YYYY-MM-DD.md  skills/  files/
//   agents/<id>/agent.sqlite        会话、消息、用量、记忆索引（AgentStore）
//
// 工作目录可以改到别处（agent.json 的 workspace_dir，绝对路径或 ~/…；空 = 上面的默认位置）：
// 人设、记忆、技能、exec 的默认目录都跟着走；agent.json 和 agent.sqlite 始终留在数据目录。
//
// 首次启动（agents/ 为空）按 config.roles 建：每个角色一个 agent，id = 角色的 agent 名。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RoleDef } from "../config.ts";
import { personaText, sharedDir, isShared, SHARED_TEMPLATES } from "./persona.ts";

export const SOUL_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"] as const;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ROLE_ID_RE = /^[A-Za-z0-9_-]{0,24}$/;

export interface AgentConfig {
  id: string;
  name: string;
  aliases: string[];
  /** 百度 TTS 音色 */
  per: number;
  /** 语音合成服务商 id（config.json 的 speech.providers），空 = 默认服务商 */
  tts_provider: string;
  /** 该服务商的音色（openai 的 voice、MiniMax 的 voice_id、VoiceStudio 的声音 id）；空 = 服务商默认；百度用 per */
  tts_voice: string;
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
  /** 自定义工作目录（绝对路径或 ~/…）；空 = agents/<id>/workspace */
  workspace_dir: string;
}

export interface AgentInfo extends AgentConfig {
  dir: string;
  /** 实际在用的工作目录 */
  workspace: string;
  /** 自定义工作目录用不了（盘没插、没权限）时的原因；这时临时退回默认目录 */
  workspace_error?: string;
}

/** 工作目录：自定义的（展开 ~、规范化）或默认的 agents/<id>/workspace */
export function resolveWorkspace(agentDir: string, custom: string): string {
  const c = String(custom ?? "").trim();
  if (!c) return path.join(agentDir, "workspace");
  const expanded = c === "~" || c.startsWith("~/") || c.startsWith("~\\") ? path.join(os.homedir(), c.slice(1)) : c;
  return path.resolve(expanded);
}
const inside = (parent: string, child: string) => {
  const r = path.relative(parent, child);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};

const DEFAULTS: Omit<AgentConfig, "id" | "name"> = {
  aliases: [], per: 111, tts_provider: "", tts_voice: "", device_role: "", order: 0, model: "", cheap_model: "",
  tools: ["*"], skills: ["*"], a2a: { allow: [] },
  heartbeat: { enabled: false, every_minutes: 30, active_hours: "08:00-23:00", delivery: "device:cores3" },
  // 现在的模型上下文普遍 12.8 万起、有前缀缓存：攒到 6 万再压，保留最近 30 条原文（以前 1.6 万 / 16 条，压得太勤、丢细节）
  compaction: { max_tokens: 60000, keep_messages: 30 },
  device_in_main: true,
  voice_max_chars: 80,
  workspace_dir: "",
};

export function templates(name: string): Record<string, string> {
  return {
    "SOUL.md": `# ${name} 的灵魂\n\n你是${name}，住在主人桌上那台小小的 CoreS3 设备里。\n性格温柔、俏皮，偶尔有点小脾气；真诚，不讨好，不说空话。\n`,
    "IDENTITY.md": `# 身份\n\n- 名字：${name}\n- 形态：一台带屏幕、摄像头、麦克风和扬声器的桌面小设备\n`,
    "USER.md": "# 主人\n\n（主人的稳定偏好写在这里，例如称呼、作息、口味。）\n",
    "AGENTS.md": SHARED_TEMPLATES["AGENTS.md"],
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
  c.tts_provider = String(c.tts_provider ?? "");
  c.tts_voice = String(c.tts_voice ?? "");
  c.device_role = String(c.device_role ?? "");
  if (!ROLE_ID_RE.test(c.device_role)) throw new Error(`agent ${id} 的 device_role 只能用字母/数字/_-: ${c.device_role}`);
  c.order = Number(c.order ?? 0);
  c.workspace_dir = String(c.workspace_dir ?? "").trim();
  if (c.workspace_dir && !(path.isAbsolute(c.workspace_dir) || c.workspace_dir === "~" || /^~[\\/]/.test(c.workspace_dir))) {
    throw new Error(`工作目录要写完整路径（例如 D:\\Kagura\\${id} 或 /home/me/${id}），也可以用 ~/ 开头`);
  }
  c.tools = Array.isArray(c.tools) ? c.tools.map(String) : ["*"];
  c.skills = Array.isArray(c.skills) ? c.skills.map(String) : ["*"];
  c.a2a = { allow: Array.isArray(raw?.a2a?.allow) ? raw.a2a.allow.map(String) : [] };
  c.heartbeat = { ...DEFAULTS.heartbeat, ...(raw?.heartbeat ?? {}) };
  c.compaction = { ...DEFAULTS.compaction, ...(raw?.compaction ?? {}) };
  // 管理界面保存过就会把当时的默认值（16000 / 16）原样写进 agent.json：没改过的跟着新默认走
  if (c.compaction.max_tokens === 16000 && c.compaction.keep_messages === 16) c.compaction = { ...DEFAULTS.compaction };
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
    const conf = normalize(JSON.parse(fs.readFileSync(path.join(dir, "agent.json"), "utf8")), id);
    const mk = (ws: string) => { for (const sub of ["memory", "skills", "files"]) fs.mkdirSync(path.join(ws, sub), { recursive: true }); };
    const ws = resolveWorkspace(dir, conf.workspace_dir);
    try { mk(ws); return { ...conf, dir, workspace: ws }; }
    catch (e: any) {
      if (!conf.workspace_dir) throw e;
      // 自定义目录暂时用不了（移动硬盘没插、网络盘断开）：先用默认目录顶上，别让整个 agent 加载失败
      const fallback = path.join(dir, "workspace");
      mk(fallback);
      const why = `${ws} 用不了（${e.code || e.message}），暂时用默认目录`;
      console.log(`[agent] ⚠️  ${id} 的工作目录 ${why}`);
      return { ...conf, dir, workspace: fallback, workspace_error: why };
    }
  }

  /** 检查自定义工作目录：不能包住数据目录，也不能和别的 agent 的工作目录重叠（记忆会串） */
  private checkWorkspace(id: string, custom: string) {
    if (!custom) return;
    const ws = resolveWorkspace(path.join(this.root, id), custom);
    if (inside(ws, this.root)) throw new Error("工作目录不能是数据目录或它的上级目录");
    for (const a of this.list()) {
      if (a.id === id) continue;
      if (inside(ws, a.workspace) || inside(a.workspace, ws)) throw new Error(`工作目录和 ${a.name}（${a.id}）的工作目录重叠了`);
    }
    if (fs.existsSync(ws) && !fs.statSync(ws).isDirectory()) throw new Error(`${ws} 不是文件夹`);
  }

  /**
   * 换工作目录：新目录是空的（或不存在）就把旧目录里的东西整个复制过去；已经有东西（比如原来 OpenClaw 的工作区）就原样用，
   * 只补上缺的人设文件。旧目录不删，留着当备份。
   */
  private migrateWorkspace(from: string, to: string) {
    if (path.resolve(from) === path.resolve(to) || !fs.existsSync(from)) return;
    fs.mkdirSync(to, { recursive: true });
    // 只有空文件夹（默认目录建好的 memory/ skills/ files/ 空壳也算空）才整个搬
    const hasFiles = (d: string): boolean => fs.readdirSync(d, { withFileTypes: true }).some((e) => e.isFile() || (e.isDirectory() && hasFiles(path.join(d, e.name))));
    const empty = !hasFiles(to);
    if (empty) { fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: false }); return; }
    for (const f of SOUL_FILES) {
      const src = path.join(from, f), dst = path.join(to, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
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
    // 没指定设备图片目录就用 id（"" 留给默认 agent，重复了角色表会冲突）
    const conf = normalize({ ...cfg, order: cfg.order ?? this.list().length, device_role: cfg.device_role ?? id.slice(0, 24) }, id);
    if (this.list().some((a) => a.device_role === conf.device_role)) throw new Error(`设备图片目录「${conf.device_role}」已被别的 agent 占用`);
    this.checkWorkspace(id, conf.workspace_dir);
    const ws = resolveWorkspace(dir, conf.workspace_dir);
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    const { id: _id, ...rest } = conf;
    fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify(rest, null, 2));
    // 指到一个已有的工作区（比如 OpenClaw 的）时别覆盖里面的人设
    // 共享的 USER / AGENTS / TOOLS 不再每个 agent 建一份（要补充时管理界面里再建）
    for (const [f, t] of Object.entries(templates(conf.name))) if (!fs.existsSync(path.join(ws, f)) && !(sharedDir() && isShared(f))) fs.writeFileSync(path.join(ws, f), t);
    const info = this.read(id);
    this.agents.set(id, info);
    return info;
  }

  /** 改 agent.json 里的字段（浅合并，a2a/heartbeat/compaction 按对象合并） */
  update(id: string, patch: Partial<AgentConfig>): AgentInfo {
    const cur = this.get(id);
    if (!cur) throw new Error(`没有 agent ${id}`);
    const { dir, workspace, workspace_error: _we, id: _i, ...base } = cur;
    const merged: any = { ...base, ...patch };
    for (const k of ["a2a", "heartbeat", "compaction"] as const) if (patch[k]) merged[k] = { ...(base as any)[k], ...patch[k] };
    const conf = normalize(merged, id);
    if (patch.device_role !== undefined && this.list().some((a) => a.id !== id && a.device_role === conf.device_role)) throw new Error(`设备图片目录「${conf.device_role}」已被别的 agent 占用`);
    const newWs = resolveWorkspace(dir, conf.workspace_dir);
    if (newWs !== workspace) {
      this.checkWorkspace(id, conf.workspace_dir);
      this.migrateWorkspace(workspace, newWs);
    }
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
    const seen = new Set<string>();
    const out: RoleDef[] = [];
    for (const a of this.list()) {
      if (seen.has(a.device_role)) { console.log(`[agent] ⚠️  ${a.id} 的 device_role「${a.device_role}」重复，设备上切换不到它`); continue; }
      seen.add(a.device_role);
      out.push({ id: a.device_role, name: a.name, agent: a.id, per: a.per, tts_provider: a.tts_provider, tts_voice: a.tts_voice, aliases: a.aliases });
    }
    return out;
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
    return personaText(a.workspace, name);
  }
}
