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
import { rgb565ToJpeg } from "./util/image.ts";
import { registerChat } from "./routes/chat.ts";
import { registerDevice } from "./routes/device.ts";
import { registerMonitor } from "./routes/monitor.ts";

// Node 22 下 node:sqlite 等会打实验特性警告，对用户只是噪声
process.removeAllListeners("warning");

async function main() {
  const cfg = loadConfig();
  const dirs = makeDirs(cfg);
  const fake = cfg.fakeProviders ? new FakeProviders(dirs.ttsCache) : null;
  const baidu = fake ? null : new BaiduVoice(cfg.baidu, dirs.ttsCache);
  const voice = fake ?? baidu!;
  const brain = fake ?? new OpenClawBrain(cfg.openclaw.bin);
  const mqtt = new MqttHub();
  // 直播帧质量压到 70：单帧小一半，肉眼几乎看不出差别
  const stream = new StreamHub((raw) => rgb565ToJpeg(raw, 70), cfg.streamToken);
  const ctx = new Ctx(cfg, dirs, voice, brain, mqtt, stream);

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

  await mqtt.start(cfg.mqttPort);
  await stream.start(cfg.streamPort);
  await startDiscovery(cfg.discPort);
  ctx.reminders.start((text, dev) => ctx.sendPush(text, dev));
  ctx.schedules.start((s) => ctx.runScheduledCapture(s));
  setInterval(() => ctx.cleanupPhotoResults(), 300_000).unref();
  setInterval(() => ctx.hb.watch(), 30_000).unref();

  await r.listen(cfg.port);
  console.log(`Agent : ${cfg.openclaw.defaultAgent}（OpenClaw）`);
  console.log(`监听 0.0.0.0:${cfg.port}，Ctrl+C 退出`);
  console.log(`监控网页: http://<本机IP>:${cfg.port}/monitor\n`);
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
