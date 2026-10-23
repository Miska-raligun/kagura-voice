// 配置与路径。
//
// 配置来源（后者覆盖前者）：
//   1. 数据目录下的 config.json（安装版的正式配置，管理 UI 会写它）
//   2. KAGURA_TEST_CONFIG 指向的 JSON（契约测试用，见 contract-tests/README.md）
//   3. 环境变量（端口、数据目录、假服务商开关）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RoleDef { id?: string; name?: string; agent?: string; per?: number; aliases?: string[] }

export interface Config {
  dataDir: string;
  port: number;
  mqttPort: number;
  streamPort: number;
  discPort: number;
  fakeProviders: boolean;
  apiToken: string;
  streamToken: string;
  roles: RoleDef[] | null;
  baidu: { asrKey: string; asrSecret: string; ttsKey: string; ttsSecret: string };
  /** OpenClaw 适配器（M2 的大脑；M3 起可换 pi agent） */
  openclaw: { bin: string; dir: string; defaultAgent: string };
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
  return {
    dataDir,
    port: int(env.KAGURA_PORT, file.port ?? 5000),
    mqttPort: int(env.KAGURA_MQTT_PORT, file.mqtt_port ?? 1883),
    streamPort: int(env.KAGURA_STREAM_PORT, file.stream_port ?? 5002),
    discPort: int(env.KAGURA_DISC_PORT, file.disc_port ?? 5001),
    fakeProviders: env.KAGURA_FAKE_PROVIDERS === "1",
    apiToken: String(file.api_token ?? ""),
    streamToken: String(file.stream_token ?? ""),
    roles: Array.isArray(file.roles) ? file.roles : null,
    baidu: {
      asrKey: baidu.asr_key ?? "", asrSecret: baidu.asr_secret ?? "",
      ttsKey: baidu.tts_key ?? "", ttsSecret: baidu.tts_secret ?? "",
    },
    openclaw: {
      bin: oc.bin ?? path.join(home, ".npm-global", "bin", "openclaw"),
      dir: env.KAGURA_OPENCLAW_DIR || oc.dir || path.join(home, ".openclaw"),
      defaultAgent: oc.default_agent ?? "main",
    },
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
    // 照片临时目录：OpenClaw 要按路径读图，所以沿用它的 workspace/tmp
    visionTmp: (() => { const p = path.join(cfg.openclaw.dir, "workspace", "tmp"); fs.mkdirSync(p, { recursive: true }); return p; })(),
    remindersFile: path.join(cfg.dataDir, "reminders.json"),
    schedulesFile: path.join(cfg.dataDir, "photo_schedules.json"),
    rolesFile: path.join(cfg.dataDir, "roles_state.json"),
  };
}
export type Dirs = ReturnType<typeof dirs>;
