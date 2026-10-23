// 命令行子命令：kagura --version / migrate / import-openclaw / help。没有子命令 = 启动服务端。
import os from "node:os";
import path from "node:path";
import { loadConfig, dirs as makeDirs } from "./config.ts";
import { migratePython } from "./migrate.ts";

declare const __KAGURA_VERSION__: string | undefined;
export const VERSION = typeof __KAGURA_VERSION__ === "string" ? __KAGURA_VERSION__ : "dev";

const HELP = `Kagura 语音服务端 ${VERSION}

用法：
  kagura                         启动服务端（管理界面 http://127.0.0.1:5000/admin）
  kagura --no-browser            启动但首次运行不自动打开浏览器
  kagura migrate <旧版目录>       从 Python 版（voice_server.py 所在目录）迁移配置、提醒、定时拍照、快照、TTS 缓存
  kagura import-openclaw [目录]   从 OpenClaw 导入人设、记忆与定时任务（默认 ~/.openclaw；任务导入后默认暂停）
  kagura --version               显示版本
  加 --force 覆盖已存在的文件。数据目录可用环境变量 KAGURA_DATA_DIR 指定。
`;

/** 返回 true = 已经处理完（不要再启动服务端） */
export async function runCli(argv: string[]): Promise<boolean> {
  const [cmd, ...rest] = argv.filter((a) => !a.startsWith("--") || ["--version", "-v", "--help", "-h"].includes(a));
  const force = argv.includes("--force");
  if (cmd === "--version" || cmd === "-v") { console.log(VERSION); return true; }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") { console.log(HELP); return true; }
  if (cmd === "migrate") {
    if (!rest[0]) throw new Error("用法：kagura migrate <旧版目录>");
    const cfg = loadConfig();
    for (const l of migratePython(path.resolve(rest[0]), cfg.dataDir, force)) console.log("  " + l);
    console.log(`完成。数据目录：${cfg.dataDir}\n启动前先停掉旧的 voice_server.py 和 mosquitto（1883 端口由新服务端内置 broker 占用）。`);
    return true;
  }
  if (cmd === "import-openclaw") {
    const cfg = loadConfig();
    const dirs = makeDirs(cfg);
    const { createAgentSystem } = await import("./agent/system.ts");
    const { Scheduler } = await import("./agent/scheduler.ts");
    const { importOpenClaw, findOpenClawDirs, describeImport } = await import("./agent/import-openclaw.ts");
    let dir = rest[0] ? path.resolve(rest[0]) : "";
    if (!dir) {
      const found = findOpenClawDirs(cfg.openclaw.dir, os.homedir());
      if (!found.length) throw new Error("没找到 OpenClaw 目录（本机 ~/.openclaw 和 WSL 里都找过了）。请写明路径，例如：\n"
        + "  kagura import-openclaw \"\\\\wsl.localhost\\Ubuntu\\home\\你\\.openclaw\"");
      dir = found[0];
      if (found.length > 1) console.log(`找到多个 OpenClaw 目录，用第一个；要用别的请写明路径：\n${found.map((f) => "  " + f).join("\n")}`);
    }
    const sys = createAgentSystem(cfg, dirs, null);
    const sched = new Scheduler(dirs.systemDb, sys.runtime, sys.registry, { deliver: async () => "", busy: () => false });
    const rep = importOpenClaw(dir, sys.registry, sched, { overwrite: force, skillsDir: dirs.skills });
    for (const l of describeImport(rep)) console.log(l);
    if (rep.agents.some((a) => a.created)) console.log("\n新建的 agent 要重启服务端才会加载（开着的话先关掉再开）。");
    console.log("提示：人设里写着 cores3-speak / cores3-camera 的地方，可以删掉（播报由系统自动处理），拍照改用内置的 take_photo 工具。");
    sys.runtime.close();
    return true;
  }
  if (cmd && !cmd.startsWith("-")) throw new Error(`不认识的命令 ${cmd}\n\n${HELP}`);
  return false;
}
