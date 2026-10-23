// Kagura 服务端入口：读配置 → 起 HTTP / MQTT / UDP / 直播 TCP → 后台任务。
import { loadConfig, dirs as makeDirs } from "./config.ts";
import { Router } from "./http/router.ts";
import { MqttHub } from "./mqtt.ts";
import { StreamHub } from "./stream.ts";
import { startDiscovery } from "./discovery.ts";
import { Ctx } from "./ctx.ts";
import { BaiduVoice } from "./voice/baidu.ts";
import { OpenClawBrain } from "./brain/openclaw.ts";
import { FakeProviders } from "./fake.ts";
import { PiBrain } from "./brain/pi.ts";
import { createAgentSystem, attachAgentSystem } from "./agent/system.ts";
import { rgb565ToJpeg } from "./util/image.ts";
import { registerChat } from "./routes/chat.ts";
import { registerDevice } from "./routes/device.ts";
import { registerMonitor } from "./routes/monitor.ts";
import { registerAdmin } from "./routes/admin.ts";
import { registerAdminUi } from "./routes/admin-ui.ts";

// Node 22 下 node:sqlite 等会打实验特性警告，对用户只是噪声
process.removeAllListeners("warning");

async function main() {
  const cfg = loadConfig();
  const dirs = makeDirs(cfg);
  const fake = cfg.fakeProviders ? new FakeProviders(dirs.ttsCache) : null;
  const baidu = fake ? null : new BaiduVoice(cfg.baidu, dirs.ttsCache);
  const voice = fake ?? baidu!;
  // 大脑：内置 agent（pi）或 OpenClaw CLI；假服务商模式下 OpenClaw 位置换成脚本假大脑
  // agent 系统总是建：OpenClaw 模式下管理界面、首次设置向导也要能用；只有「设备对话交给谁」随 brain 配置
  const sys = createAgentSystem(cfg, dirs, fake);
  const pi = cfg.brain === "pi";
  const brain = pi ? new PiBrain(sys.runtime) : (fake ?? new OpenClawBrain(cfg.openclaw.bin));
  const mqtt = new MqttHub();
  // 直播帧质量压到 70：单帧小一半，肉眼几乎看不出差别
  const stream = new StreamHub((raw) => rgb565ToJpeg(raw, 70), cfg.streamToken);
  const ctx = new Ctx(cfg, dirs, voice, brain, mqtt, stream, pi ? sys.registry.roleDefs() : cfg.roles);
  attachAgentSystem(sys, ctx);

  console.log("=".repeat(50));
  console.log("  Kagura 语音服务端" + (fake ? "（假服务商模式）" : ""));
  console.log("=".repeat(50));
  console.log(`数据目录: ${cfg.dataDir}`);
  if (baidu) {
    try { await baidu.warmup(); console.log("百度 token OK"); }
    catch (e: any) { console.log(`⚠️  百度 token 获取失败（语音识别暂不可用）: ${e.message}`); }
  }

  const r = new Router();
  if (fake) fake.register(r, ctx.state);
  registerChat(r, ctx);
  registerDevice(r, ctx);
  registerMonitor(r, ctx);
  registerAdmin(r, ctx, sys);
  registerAdminUi(r);

  await mqtt.start(cfg.mqttPort);
  await stream.start(cfg.streamPort);
  await startDiscovery(cfg.discPort);
  ctx.reminders.start((text, dev) => ctx.sendPush(text, dev));
  sys.scheduler?.start(cfg.schedulerTick);
  sys.channels.startAll().catch((e) => console.log(`[channel] ⚠️  ${e.message}`));
  ctx.schedules.start((s) => ctx.runScheduledCapture(s));
  setInterval(() => ctx.cleanupPhotoResults(), 300_000).unref();
  setInterval(() => ctx.hb.watch(), 30_000).unref();

  await r.listen(cfg.port);
  if (pi) console.log(`Agent : ${sys.registry.list().map((a) => a.id).join(", ")}（内置，默认模型 ${sys.models.defaultRef() || "未配置"}）`);
  else console.log(`Agent : ${cfg.openclaw.defaultAgent}（OpenClaw）`);
  console.log(`管理界面: http://127.0.0.1:${cfg.port}/admin（只限本机）`);
  console.log(`监听 0.0.0.0:${cfg.port}，Ctrl+C 退出`);
  console.log(`监控网页: http://<本机IP>:${cfg.port}/monitor\n`);
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
