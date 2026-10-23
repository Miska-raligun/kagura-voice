// 自己重启（IM 里发 /restart）。
//   systemd 管着的（Linux deb 包的 user service）：退出码 75，Restart=on-failure 会把它拉起来
//   其它（Windows 双击 / 开机自启、终端里直接跑）：先拉起一个新进程，再自己退出。新进程开头等旧进程退干净
//   （KAGURA_RESTART_WAIT_PID），不然端口还被占着，启动体检会以为「已经有一个 Kagura 在跑」而退出。
// 重启后在哪说一声：写 <数据目录>/restart-notice.json，新进程起来、渠道连上后读出来发过去。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export interface RestartNotice { account: string; chatId: string; at: number; from: string }

const noticeFile = (dataDir: string) => path.join(dataDir, "restart-notice.json");

function isSea(): boolean {
  try { return !!require("node:sea").isSea(); } catch { return false; }
}

/** 重启自己。返回后进程很快就会退出 */
export function restartSelf(dataDir: string, notice: Omit<RestartNotice, "at">, env: NodeJS.ProcessEnv = process.env) {
  try { fs.writeFileSync(noticeFile(dataDir), JSON.stringify({ ...notice, at: Date.now() / 1000 })); } catch { /* 说不了一声也照样重启 */ }
  console.log("[restart] 🔄 收到重启命令");
  if (env.INVOCATION_ID) {
    // systemd：交给它重启（kagura.service 里 Restart=on-failure）
    setTimeout(() => process.exit(75), 500);
    return;
  }
  // 单文件可执行：argv = [exe, exe, ...参数]；node 跑脚本：argv = [node, 脚本, ...参数]
  const args = (isSea() ? process.argv.slice(2) : process.argv.slice(1)).filter((a) => a !== "--no-browser");
  const child = spawn(process.execPath, [...args, "--no-browser"], {
    detached: true,
    // Windows：新进程有自己的控制台窗口（旧窗口随旧进程关掉）；其它系统接着用当前终端
    stdio: process.platform === "win32" ? "ignore" : "inherit",
    env: { ...env, KAGURA_RESTART_WAIT_PID: String(process.pid) },
    windowsHide: false,
  });
  child.unref();
  setTimeout(() => process.exit(0), 500);
}

/** 新进程开头调：等发起重启的旧进程退出（最多 20 秒） */
export async function waitForOldProcess(env: NodeJS.ProcessEnv = process.env) {
  const pid = Number(env.KAGURA_RESTART_WAIT_PID);
  delete env.KAGURA_RESTART_WAIT_PID;
  if (!pid) return;
  for (let i = 0; i < 80; i++) {
    try { process.kill(pid, 0); } catch { return; }       // 进程没了
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** 取出重启前留的「回来说一声」（取了就删） */
export function takeRestartNotice(dataDir: string): RestartNotice | null {
  try {
    const n = JSON.parse(fs.readFileSync(noticeFile(dataDir), "utf8"));
    fs.unlinkSync(noticeFile(dataDir));
    return Date.now() / 1000 - n.at < 600 ? n : null;      // 太久以前的就不说了
  } catch { return null; }
}
