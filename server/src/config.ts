// 配置与路径。
//
// 配置来源（后者覆盖前者）：
//   1. 数据目录下的 config.json（安装版的正式配置，管理 UI 会写它）
//   2. KAGURA_TEST_CONFIG 指向的 JSON（契约测试用，见 contract-tests/README.md）
//   3. 环境变量（端口、数据目录、假服务商开关）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWsl, wslUncPath } from "./util/platform.ts";

export interface RoleDef { id?: string; name?: string; agent?: string; per?: number; aliases?: string[] }

export function parseVoicePush(v: unknown): "presence" | "always" | "never" {
  return v === "always" || v === "never" ? v : "presence";
}

export interface Config {
  dataDir: string;
  port: number;
  mqttPort: number;
  streamPort: number;
  discPort: number;
  fakeProviders: boolean;
  apiToken: string;
  /** 设备对话的可信度：approve = 只有批准过、且从它心跳的 IP 发来的才可信（默认）；all = 所有设备请求都可信（旧行为） */
  deviceTrust: "approve" | "all";
  /** 定时查 GitHub 上有没有新版本（只提示，不自动安装） */
  updateCheck: boolean;
  /** 说给主人听的话（speak、定时任务、提醒、IM 回复同步念）播不播：presence = 在家才播 / always / never。管理界面改了就地生效 */
  voicePush: "presence" | "always" | "never";
  streamToken: string;
  roles: RoleDef[] | null;
  baidu: { asrKey: string; asrSecret: string; ttsKey: string; ttsSecret: string; asrMode?: "standard" | "pro" };
  /** OpenClaw 适配器（可选大脑，作者自用可继续接 OpenClaw） */
  openclaw: {
    bin: string; dir: string; defaultAgent: string;
    /** Windows 版服务端调用装在 WSL 里的 OpenClaw：发行版名（如 Ubuntu）。此时 bin、dir 都是 WSL 里的 Linux 路径 */
    wslDistro: string;
  };
  /**
   * 额外的管理界面端口，只绑 127.0.0.1。WSL 里跑时默认 5080：Windows 的端口转发会把局域网和本机浏览器的
   * 请求一律变成「来自 Windows 主机」，主端口上分不清谁是本机，管理界面只能走 WSL 自带的 localhost 转发进来。
   */
  adminPort: number;
  /** 大脑：pi = 内置 agent 系统（M3 起），openclaw = 调 OpenClaw CLI */
  brain: "pi" | "openclaw";
  /** 模型服务商（全部由用户手动配置，不预设），见 server/README.md */
  models: ModelsConfig;
  /** 可选：嵌入接口（OpenAI 兼容 /embeddings），没配就只用关键词检索 */
  embedding: { baseUrl: string; apiKey: string; model: string } | null;
  runtime: { maxConcurrency: number; timeoutSecs: number };
  a2a: { enabled: boolean; maxHops: number; perPairPerMin: number };
  /** 调度器 tick 间隔（秒）。测试里调小 */
  schedulerTick: number;
  /** 人设文件注入上限覆盖（见 agent/soul.ts 的 DEFAULT_BUDGETS） */
  promptBudgets: Record<string, number>;
  /** 执行命令、联网工具的设置。管理界面改了就地更新这个对象（工具每次调用时读），不用重启 */
  tools: ToolsConfig;
}

export interface ToolsConfig {
  exec: {
    enabled: boolean;
    /** auto = Windows 用 PowerShell、其它用 bash；也可以 bash / sh / powershell / cmd / wsl */
    shell: string;
    /** shell=wsl 时用哪个发行版（空 = 默认发行版） */
    wslDistro: string;
    timeoutSecs: number;
  };
  web: {
    enabled: boolean;
    /** auto = 配了 Key 用对应服务，没配就抓必应网页；brave / tavily / bocha / searxng / bing / duckduckgo */
    searchProvider: string;
    searchApiKey: string;
    /** searxng 的地址 */
    searchBaseUrl: string;
    /** 网络代理（http://127.0.0.1:7890 这种）。空 = 用环境变量 HTTPS_PROXY，没有就直连。对调模型也生效 */
    proxy: string;
  };
}

/** config.json 里的 tools 段 → ToolsConfig（缺省值在这里） */
export function parseToolsConfig(t: any = {}): ToolsConfig {
  const e = t.exec ?? {}, w = t.web ?? {};
  return {
    exec: {
      enabled: e.enabled ?? true,
      shell: String(e.shell ?? "auto"),
      wslDistro: String(e.wsl_distro ?? ""),
      timeoutSecs: Math.max(1, Number(e.timeout_secs ?? 60)),
    },
    web: {
      enabled: w.enabled ?? true,
      searchProvider: String(w.search_provider ?? "auto"),
      searchApiKey: String(w.search_api_key ?? ""),
      searchBaseUrl: String(w.search_base_url ?? ""),
      proxy: String(w.proxy ?? ""),
    },
  };
}

export interface ModelDef {
  id: string; name?: string; input?: ("text" | "image")[]; reasoning?: boolean;
  context_window?: number; max_tokens?: number;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}
export interface ProviderDef {
  id: string; name?: string;
  /** openai-completions（DeepSeek/通义/Kimi/智谱/本地 Ollama 等 OpenAI 兼容接口）| anthropic-messages | openai-responses | google-generative-ai */
  api: string;
  base_url: string; api_key?: string; headers?: Record<string, string>;
  models: ModelDef[];
}
export interface ModelsConfig {
  providers: ProviderDef[];
  /** 默认模型 "provider/model"；agent.json 可覆盖 */
  default: string;
  /** 压缩、记忆冲刷、heartbeat 用的便宜模型；不填就用默认模型 */
  cheap: string;
}

/** 各系统的应用数据目录（安装版默认位置）。 */
export function defaultDataDir(): string {
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Kagura");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Kagura");
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "kagura");
}

function readJson(file: string | undefined): Record<string, any> {
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    if (e.code !== "ENOENT") console.log(`⚠️  配置文件读取失败 ${file}: ${e.message}`);
    return {};
  }
}

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.KAGURA_DATA_DIR || defaultDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const file = { ...readJson(path.join(dataDir, "config.json")), ...readJson(env.KAGURA_TEST_CONFIG) };
  const baidu = file.baidu ?? {};
  const oc = file.openclaw ?? {};
  const home = os.homedir();
  const m = file.models ?? {};
  const models: ModelsConfig = {
    providers: Array.isArray(m.providers) ? m.providers : [],
    default: String(m.default ?? ""),
    cheap: String(m.cheap ?? ""),
  };
  const fake = env.KAGURA_FAKE_PROVIDERS === "1";
  // 没写 brain 时：配了模型就用内置 agent，否则沿用 OpenClaw（老用户升级零配置）
  const brain = (env.KAGURA_BRAIN || file.brain || (models.providers.length ? "pi" : "openclaw")) === "pi" ? "pi" : "openclaw";
  const emb = file.embedding;
  const rt = file.runtime ?? {};
  const a2a = file.a2a ?? {};
  return {
    dataDir,
    port: int(env.KAGURA_PORT, file.port ?? 5000),
    mqttPort: int(env.KAGURA_MQTT_PORT, file.mqtt_port ?? 1883),
    streamPort: int(env.KAGURA_STREAM_PORT, file.stream_port ?? 5002),
    discPort: int(env.KAGURA_DISC_PORT, file.disc_port ?? 5001),
    fakeProviders: fake,
    apiToken: String(file.api_token ?? ""),
    deviceTrust: file.device_trust === "all" ? "all" : "approve",
    updateCheck: file.update_check !== false && !fake,
    voicePush: parseVoicePush(file.voice_push),
    streamToken: String(file.stream_token ?? ""),
    roles: Array.isArray(file.roles) ? file.roles : null,
    baidu: {
      asrKey: baidu.asr_key ?? "", asrSecret: baidu.asr_secret ?? "",
      ttsKey: baidu.tts_key ?? "", ttsSecret: baidu.tts_secret ?? "",
      // 识别档位：standard = 标准版（免费额度多）；pro = 极速版（更准更快，要在百度控制台开通，按次计费）
      asrMode: baidu.asr_mode === "pro" ? "pro" : "standard",
    },
    openclaw: {
      bin: oc.bin ?? path.join(home, ".npm-global", "bin", "openclaw"),
      dir: env.KAGURA_OPENCLAW_DIR || oc.dir || path.join(home, ".openclaw"),
      defaultAgent: oc.default_agent ?? "main",
      wslDistro: String(oc.wsl_distro ?? ""),
    },
    adminPort: int(env.KAGURA_ADMIN_PORT, file.admin_port ?? (isWsl(env) && !fake ? 5080 : 0)),
    brain,
    models,
    embedding: emb && emb.base_url && emb.model ? { baseUrl: String(emb.base_url), apiKey: String(emb.api_key ?? ""), model: String(emb.model) } : null,
    runtime: { maxConcurrency: Number(rt.max_concurrency ?? 4), timeoutSecs: Number(rt.timeout_secs ?? 120) },
    a2a: { enabled: a2a.enabled ?? true, maxHops: Number(a2a.max_hops ?? 3), perPairPerMin: Number(a2a.per_pair_per_min ?? 10) },
    tools: parseToolsConfig(file.tools),
    promptBudgets: file.prompt_budgets && typeof file.prompt_budgets === "object" ? file.prompt_budgets : {},
    schedulerTick: Number(env.KAGURA_SCHEDULER_TICK || file.scheduler_tick || 15),
  };
}

/** 数据目录下的固定子目录（与 Python 版同名，迁移时直接拷贝） */
export function dirs(cfg: Config) {
  const d = (name: string) => {
    const p = path.join(cfg.dataDir, name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  return {
    pushAudio: d("push_audio"),
    ttsCache: d("tts_cache"),
    snapshots: d("snapshots"),
    debugAudio: d("debug_audio"),
    deviceLogs: d("device_logs"),
    crashReports: d("crash_reports"),
    // 照片临时目录：OpenClaw 要按路径读图，所以沿用它的 workspace/tmp；内置 agent 直接读文件，放数据目录
    visionTmp: cfg.brain === "pi" ? d("tmp") : (() => { const p = openclawTmp(cfg); fs.mkdirSync(p, { recursive: true }); return p; })(),
    agents: d("agents"),
    skills: d("skills"),
    extensions: d("extensions"),
    packages: d("packages"),
    systemDb: path.join(cfg.dataDir, "system.sqlite"),
    remindersFile: path.join(cfg.dataDir, "reminders.json"),
    schedulesFile: path.join(cfg.dataDir, "photo_schedules.json"),
    rolesFile: path.join(cfg.dataDir, "roles_state.json"),
  };
}
export type Dirs = ReturnType<typeof dirs>;

/** OpenClaw 读图的临时目录（它按路径读图）。Windows 版接 WSL 里的 OpenClaw 时走 \\wsl.localhost 写进去 */
export function openclawTmp(cfg: Config): string {
  if (cfg.openclaw.wslDistro && process.platform === "win32") return wslUncPath(cfg.openclaw.wslDistro, `${cfg.openclaw.dir}/workspace/tmp`);
  return path.join(cfg.openclaw.dir, "workspace", "tmp");
}
