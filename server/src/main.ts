// Kagura 服务端入口：读配置 → 起 HTTP / MQTT / UDP / 直播 TCP → 后台任务。
import { loadConfig, dirs as makeDirs } from "./config.ts";
import { Router } from "./http/router.ts";
import { MqttHub } from "./mqtt.ts";
import { StreamHub } from "./stream.ts";
import { startDiscovery } from "./discovery.ts";
import { Ctx } from "./ctx.ts";
import { SpeechHub } from "./voice/hub.ts";
import { OpenClawBrain } from "./brain/openclaw.ts";
import { FakeProviders } from "./fake.ts";
import { PiBrain } from "./brain/pi.ts";
import { createAgentSystem, attachAgentSystem } from "./agent/system.ts";
import { rgb565ToJpeg } from "./util/image.ts";
import { registerChat } from "./routes/chat.ts";
import { registerDevice } from "./routes/device.ts";
import { registerMonitor } from "./routes/monitor.ts";
import { registerClient } from "./routes/client.ts";
import { Clients } from "./clients.ts";
import { registerAdmin } from "./routes/admin.ts";
import { registerAdminUi } from "./routes/admin-ui.ts";
import { registerDeviceFiles } from "./routes/devicefiles.ts";
import { AppImages } from "./appimages.ts";
import { DeviceFiles } from "./devicefiles.ts";
// 构建时打进来的设备固件（device/src/*.py），见 scripts/build.mjs 的 deviceFw 插件
import { files as deviceFw } from "virtual:device-fw";
import { runCli, VERSION } from "./cli.ts";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { isWsl, toLinuxPath } from "./util/platform.ts";
import { applyProxy, proxiedFetch, activeProxy } from "./util/proxy.ts";
import { makeNodeFetch } from "./util/nodefetch.ts";
import { UpdateChecker } from "./util/update.ts";
import { SelfUpdater, installKind } from "./util/selfupdate.ts";
import { applyPending } from "./backup.ts";
import { registerAdminSystem } from "./routes/admin-system.ts";
import type { PackageManager } from "./agent/packages.ts";
import { initLogFile, installCrashLogging } from "./util/logfile.ts";
import { startTray } from "./tray.ts";
import { isGuiProcess, messageBox } from "./util/wingui.ts";
import { waitForOldProcess, takeRestartNotice, restartSelf } from "./util/restart.ts";
import { gracefulExit, onShutdown } from "./util/shutdown.ts";
import { preflight, realIO, closeAsk, pauseBeforeExit, type PortNeed } from "./startup/preflight.ts";

// Node 22 下 node:sqlite 等会打实验特性警告，对用户只是噪声
process.removeAllListeners("warning");

// 托盘模式（Windows）：开始菜单 / 开机自启打开的是 kagura-tray.exe——和 kagura.exe 是同一个程序，只是可执行文件头标成
// 「图形界面」，启动时根本不建控制台窗口（以前「先开窗口、再用 PowerShell 拉起隐藏进程」在 Windows 11 默认的
// Windows Terminal 下经常不生效，窗口照样出来）。托盘版里 console 输出看不见（日志照常写文件），也不能停下来问人。
const GUI = isGuiProcess();
if (process.platform === "win32" && process.argv.includes("--tray") && !GUI) {
  // 用控制台版加 --tray 启动（老的快捷方式）：交给旁边的托盘版，自己退出
  const trayExe = path.join(path.dirname(process.execPath), "kagura-tray.exe");
  const args = process.argv.slice(1).filter((a) => a !== process.execPath && a !== process.argv[0]);
  if (fs.existsSync(trayExe)) {
    try { spawn(trayExe, args, { detached: true, stdio: "ignore", windowsHide: true }).unref(); }
    catch (e: any) { console.log(`[tray] ⚠️  拉起托盘版失败: ${e.message}`); }
    process.exit(0);
  }
  console.log("[tray] 没找到 kagura-tray.exe，按普通窗口运行");
}
if (GUI) { process.env.KAGURA_NO_PROMPT = "1"; process.env.KAGURA_TRAY_CHILD = "1"; }

async function main() {
  let cfg = loadConfig();
  // 上次在管理界面导入的备份：在打开任何数据库之前换进去（设置也可能变了，重新读一遍）
  if (applyPending(cfg.dataDir)) cfg = loadConfig();
  await waitForOldProcess();      // IM 里 /restart 拉起的新进程：等旧进程把端口放出来

  // 端口体检：被占了就说清楚是谁、问用户怎么处理（以前是报一行错就退出，Windows 窗口一闪就关）
  const needs: PortNeed[] = [
    { what: "设备接口 / 管理界面", port: cfg.port, proto: "tcp", required: true },
    { what: "MQTT（主动播报）", port: cfg.mqttPort, proto: "tcp", required: true },
    { what: "摄像头直播", port: cfg.streamPort, proto: "tcp", required: true },
    { what: "设备自动发现", port: cfg.discPort, proto: "udp", required: false },
  ];
  if (cfg.adminPort && cfg.adminPort !== cfg.port) needs.push({ what: "本机管理端口", port: cfg.adminPort, proto: "tcp", host: "127.0.0.1", required: true });
  const pf = await preflight(needs, cfg.port, `http://localhost:${cfg.adminPort || cfg.port}/admin`, realIO());
  closeAsk();
  if (pf === "already-running") {
    // 托盘版：多半是已经在跑的时候又点了开始菜单——那就把管理界面打开
    if (GUI && !process.argv.includes("--no-browser")) openUrl(`http://localhost:${cfg.adminPort || cfg.port}/admin`);
    process.exit(0);
  }
  if (pf === "exit") throw new Error("端口被占用，没有启动。");

  const dirs = makeDirs(cfg);
  initLogFile(cfg.dataDir);
  installCrashLogging(() => void gracefulExit(0));
  const proxy = applyProxy(cfg.tools.web.proxy);
  const fake = cfg.fakeProviders ? new FakeProviders(dirs.ttsCache) : null;
  const speech = fake ? null : new SpeechHub(cfg.baidu, dirs.ttsCache, cfg.speech);
  const voice = fake ?? speech!;
  // 大脑：内置 agent（pi）或 OpenClaw CLI；假服务商模式下 OpenClaw 位置换成脚本假大脑
  // agent 系统总是建：OpenClaw 模式下管理界面、首次设置向导也要能用；只有「设备对话交给谁」随 brain 配置
  const sys = createAgentSystem(cfg, dirs, fake);
  const pi = cfg.brain === "pi";
  const brain = pi ? new PiBrain(sys.runtime) : (fake ?? openclawBrain(cfg, dirs.visionTmp));
  const mqtt = new MqttHub();
  // 直播帧质量压到 70：单帧小一半，肉眼几乎看不出差别
  const stream = new StreamHub((raw) => rgb565ToJpeg(raw, 70), cfg.streamToken);
  const ctx = new Ctx(cfg, dirs, voice, brain, mqtt, stream, pi ? sys.registry.roleDefs() : cfg.roles);
  attachAgentSystem(sys, ctx);

  // 重启恢复「在家/出门」（设备 BLE 只在状态变化时上报，不恢复的话一重启就成了「不知道」）
  ctx.loadPresence();
  ctx.loadTrust();
  if (cfg.updateCheck) {
    // KAGURA_RELEASES_API：CI 的在线更新冒烟用本地假发布源
    ctx.updates = new UpdateChecker(VERSION, proxiedFetch, process.env.KAGURA_RELEASES_API || undefined);
    ctx.updates.start();
    const kind = installKind();
    // 下载走 Node 自带的 http（undici 在对方断开 + 背压时会抛未捕获异常，见 util/nodefetch.ts）
    ctx.selfUpdater = new SelfUpdater(cfg.dataDir, makeNodeFetch(activeProxy), kind, kind === "appimage" ? () => setTimeout(() => restartSelf(cfg.dataDir, null), 800) : undefined,
      { mirrors: cfg.updateMirrors, port: cfg.adminPort || cfg.port });
  }

  console.log("=".repeat(50));
  console.log(`  Kagura 语音服务端 ${VERSION}` + (fake ? "（假服务商模式）" : ""));
  console.log("=".repeat(50));
  console.log(`数据目录: ${cfg.dataDir}`);
  if (proxy) console.log(`网络代理: ${proxy.replace(/\/\/[^@/]*@/, "//***@")}（本机地址直连）`);
  if (speech) {
    const name = (id: string) => cfg.speech.providers.find((p) => p.id === id)?.name || id;
    console.log(`语音: 识别 ${name(cfg.speech.asr)} · 合成 ${name(cfg.speech.tts)}`);
    try { if (await speech.warmup()) console.log("百度 token OK"); }
    catch (e: any) { console.log(`⚠️  百度 token 获取失败（语音识别暂不可用）: ${e.message}`); }
  }

  const r = new Router();
  if (fake) fake.register(r, ctx.state);
  registerChat(r, ctx);
  registerDevice(r, ctx);
  registerMonitor(r, ctx);
  // 手机 / 平板网页客户端：配对令牌 + SSE 推送（MQTT 每条发布抄一份过去）
  const clients = new Clients(path.join(cfg.dataDir, "clients.json"));
  ctx.clients = clients;
  mqtt.taps.push((t, p) => clients.onPublish(t, p));
  registerClient(r, ctx, clients);
  registerAdmin(r, ctx, sys);
  registerAdminSystem(r, ctx);
  registerAdminUi(r);
  const builtinFw = Object.fromEntries(Object.entries(deviceFw).map(([p, b64]) => [p, Buffer.from(b64, "base64")]));
  registerDeviceFiles(r, ctx, new DeviceFiles(path.join(cfg.dataDir, "device_files"), builtinFw, VERSION), new AppImages(path.join(cfg.dataDir, "app_images")));

  await listenOrExplain("MQTT", cfg.mqttPort, () => mqtt.start(cfg.mqttPort));
  await listenOrExplain("直播", cfg.streamPort, () => stream.start(cfg.streamPort));
  await listenOrExplain("UDP 发现", cfg.discPort, () => startDiscovery(cfg.discPort));
  // 提醒不属于哪个 agent：有出口（内置 agent）就按 voice_push 策略走，否则照旧直接推
  ctx.reminders.start(async (text, dev) => (ctx.outbox ? (await ctx.outbox.say({ text, agentId: null, device: dev, source: "reminder" })).played : ctx.sendPush(text, dev)));
  sys.scheduler?.start(cfg.schedulerTick);
  sys.tasks?.start(Math.min(30, cfg.schedulerTick));
  // 扩展加载完会顺带（重新）连接 MCP 服务器；都在后台，不拖慢启动
  sys.extensions.reloadAll().catch((e) => console.log(`[ext] ⚠️  ${e.message}`))
    .then(() => reinstallImportedPackages(cfg.dataDir, sys.packages));
  // 退出 / 重启 / 更新前先正常断开 IM 长连接（飞书：不断开的话事件会继续投给死连接十几分钟）
  onShutdown("关闭 IM 渠道", () => sys.channels.stopAll());
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void gracefulExit(0, `收到 ${sig}`); });
  sys.channels.startAll().then(async () => {
    // /restart 之前在哪个聊天里发的，回来在那说一声
    const n = takeRestartNotice(cfg.dataDir);
    if (n?.from) await sys.channels.deliver(`${n.from}:${n.account}:${n.chatId}`, `✅ 重启好了（${VERSION}，用时 ${Math.round(Date.now() / 1000 - n.at)} 秒）`);
  }).catch((e) => console.log(`[channel] ⚠️  ${e.message}`));
  ctx.schedules.start((s) => ctx.runScheduledCapture(s));
  setInterval(() => ctx.cleanupPhotoResults(), 300_000).unref();
  setInterval(() => ctx.hb.watch(), 30_000).unref();

  await listenOrExplain("HTTP", cfg.port, () => r.listen(cfg.port));
  // 只绑本机的管理端口（WSL 里默认开）：管理界面的「只许本机」在这个端口上才分得清
  if (cfg.adminPort && cfg.adminPort !== cfg.port) {
    await listenOrExplain("管理界面", cfg.adminPort, () => r.listen(cfg.adminPort, "127.0.0.1"));
  }
  if (pi) console.log(`Agent : ${sys.registry.list().map((a) => a.id).join(", ")}（内置，默认模型 ${sys.models.defaultRef() || "未配置"}）`);
  else console.log(`Agent : ${cfg.openclaw.defaultAgent}（OpenClaw）`);
  console.log(`管理界面: http://127.0.0.1:${cfg.adminPort || cfg.port}/admin（只限本机）`);
  if (isWsl()) {
    console.log("检测到在 WSL 里运行：");
    console.log(`  · 设备要从局域网连进来，Windows 侧仍需端口转发 ${cfg.port}/${cfg.mqttPort}/${cfg.streamPort} 与 UDP ${cfg.discPort} 发现中继（openclaw-startup.ps1 那套）`);
    console.log(`  · 管理界面请在 Windows 浏览器打开 http://localhost:${cfg.adminPort || cfg.port}/admin（走 WSL 自带的 localhost 转发；经端口转发进来的请求分不清是不是本机，会被拒绝）`);
  }
  console.log(`监听 0.0.0.0:${cfg.port}，Ctrl+C 退出`);
  console.log(`监控网页: http://<本机IP>:${cfg.port}/monitor\n`);
  // 托盘模式（隐藏进程）：图标 + 右键菜单（打开管理界面 / 打开日志 / 重启 / 退出）
  if (process.platform === "win32" && process.env.KAGURA_TRAY_CHILD === "1") startTray(cfg.adminPort || cfg.port, cfg.dataDir);
  maybeOpenAdmin(cfg, !sys.models.defaultRef());
}

/** 端口被占用时说人话（最常见：mosquitto 还开着、旧服务端没停、开了两个 Kagura） */
async function listenOrExplain<T>(what: string, port: number, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e?.code === "EADDRINUSE") {
      if (process.platform === "win32" && windowsPortproxyHas(port)) {
        throw new Error(`${what} 端口 ${port} 被旧的 WSL 端口转发占着（openclaw-startup.ps1 加的 netsh portproxy）。`
          + `改用 Windows 版就不需要它了：管理员 PowerShell 里运行「openclaw-startup.ps1 -Stop」，`
          + `或 netsh interface portproxy delete v4tov4 listenport=${port} listenaddress=0.0.0.0`);
      }
      const hint = port === 1883 ? "多半是 mosquitto 还在运行（新服务端自带 MQTT broker），先停掉它" : "可能已经开着一个 Kagura 或旧的 voice_server.py";
      throw new Error(`${what} 端口 ${port} 被占用：${hint}。也可以在 config.json 里改端口。`);
    }
    throw e;
  }
}

/** Windows 上这个端口是不是被 netsh portproxy（旧的 WSL 转发）占着 */
function windowsPortproxyHas(port: number): boolean {
  try {
    const out = execFileSync("netsh", ["interface", "portproxy", "show", "v4tov4"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    return out.split(/\r?\n/).some((l) => new RegExp(`^\\S+\\s+${port}\\s`).test(l.trim()));
  } catch { return false; }
}

/** OpenClaw 大脑；Windows 版配了 openclaw.wsl_distro 就经 wsl.exe 调 WSL 里的 OpenClaw */
function openclawBrain(cfg: ReturnType<typeof loadConfig>, visionTmp: string) {
  const oc = cfg.openclaw;
  if (oc.wslDistro && process.platform === "win32") {
    const linuxTmp = `${oc.dir}/workspace/tmp`;
    console.log(`OpenClaw：经 wsl.exe 调用 ${oc.wslDistro} 里的 ${oc.bin}（照片写到 ${visionTmp}）`);
    return new OpenClawBrain(oc.bin, { distro: oc.wslDistro, toAgentPath: (p) => toLinuxPath(p, visionTmp, linuxTmp) });
  }
  return new OpenClawBrain(oc.bin);
}

/** 首次运行（在终端/桌面双击启动、还没配模型）自动打开管理界面的首次设置向导 */
/** 导入的备份里 npm / git 装的扩展包：启动后在后台重新下载安装 */
async function reinstallImportedPackages(dataDir: string, pm: PackageManager) {
  const f = path.join(dataDir, "packages-reinstall.json");
  if (!fs.existsSync(f)) return;
  let list: string[] = [];
  try { list = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* 坏文件 */ }
  fs.rmSync(f, { force: true });
  for (const src of list) {
    try { await pm.install(src); } catch (e: any) { console.log(`[pkg] ⚠️  重新安装 ${src} 失败：${e.message}`); }
  }
}

function maybeOpenAdmin(cfg: ReturnType<typeof loadConfig>, setupNeeded: boolean) {
  const marker = path.join(cfg.dataDir, ".welcomed");
  // 托盘版没有终端（stdout 不是 TTY）也要能在第一次启动时打开管理界面
  if (cfg.fakeProviders || process.argv.includes("--no-browser") || (!process.stdout.isTTY && !GUI) || fs.existsSync(marker)) return;
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch { return; }
  openUrl(`http://localhost:${cfg.adminPort || cfg.port}/admin${setupNeeded ? "#/settings/wizard" : ""}`);
}

/** 用系统浏览器打开（WSL 里借 Windows 的 cmd.exe） */
function openUrl(url: string) {
  const [bin, args] = process.platform === "win32" || isWsl() ? [process.platform === "win32" ? "cmd" : "cmd.exe", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  execFile(bin, args as string[], { windowsHide: true }, () => {});
  console.log(`已在浏览器打开 ${url}`);
}

runCli(process.argv.slice(2))
  .then((handled) => (handled ? undefined : main()))
  .catch(async (e) => {
    console.error("启动失败:", e?.message ?? e);
    // 托盘版没有窗口：弹个框，不然用户只看到「点了没反应」
    if (GUI) messageBox("Kagura 没能启动", `${e?.message ?? e}\n\n可能是端口被别的程序占用（比如旧版服务端、mosquitto）。\n详细日志：%APPDATA%\\Kagura\\logs\\kagura.log`);
    await pauseBeforeExit();     // Windows 双击启动：不停一下窗口就直接关了，用户什么都看不到
    process.exit(1);
  });
