// 内置 MQTT broker（aedes，纯 JS）。设备照旧连 1883，不再需要单独装 mosquitto。
// 服务端自己不当客户端，直接往 broker 里发布。
import net from "node:net";
import { Aedes } from "aedes";

export class MqttHub {
  private broker: any = null;
  private server: net.Server | null = null;
  /** broker 起来了没有（/api/monitor/state 的 mqtt 字段；起不来时推送类接口返回 503） */
  get ok() { return this.broker !== null; }

  async start(port: number, host = "0.0.0.0"): Promise<boolean> {
    try {
      const broker = await Aedes.createBroker();
      const server = net.createServer(broker.handle);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
      });
      broker.on("client", (c: any) => console.log(`[mqtt] 🔌 ${c?.id} 已连接`));
      broker.on("clientDisconnect", (c: any) => console.log(`[mqtt] 🔌 ${c?.id} 断开`));
      this.broker = broker;
      this.server = server;
      console.log(`MQTT broker 监听 ${host}:${port}`);
      return true;
    } catch (e: any) {
      console.log(`⚠️  MQTT broker 启动失败（推送功能不可用）: ${e.message}`);
      return false;
    }
  }

  /** 每条发布抄一份（手机客户端的 SSE 推送靠它，见 clients.ts）；broker 没起来也照样抄 */
  taps: ((topic: string, payload: unknown) => void)[] = [];

  publish(topic: string, payload: unknown, qos: 0 | 1 = 1): void {
    for (const t of this.taps) { try { t(topic, payload); } catch { /* 抄送失败不影响设备 */ } }
    if (!this.broker) return;
    this.broker.publish({ cmd: "publish", topic, payload: Buffer.from(JSON.stringify(payload)), qos, dup: false, retain: false }, () => {});
  }

  close() { this.server?.close(); this.broker?.close(); }
}
