// M0 单文件冒烟：在打包后的可执行里把 pi（假模型）、node:sqlite、aedes、jpeg-js 各跑一遍。
// CI 在 Windows / Linux / macOS 上执行打出来的可执行文件，输出 SEA-SMOKE-OK 即通过。
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Aedes } from "aedes";
import jpeg from "jpeg-js";

async function main() {
  const faux = fauxProvider({ models: [{ id: "f" }], tokensPerSecond: 5000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("你好，我是神乐")]);
  const agent = new Agent({ initialState: { systemPrompt: "x", model: faux.getModel() }, streamFn: models.streamSimple.bind(models) });
  await agent.prompt("hi");
  await agent.waitForIdle();
  const reply = (agent.state.messages.at(-1) as any).content[0].text;

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(b)");
  db.prepare("INSERT INTO t VALUES (?)").run("出 差");
  const fts = (db.prepare("SELECT count(*) n FROM t WHERE t MATCH ?").get('"出 差"') as any).n;

  const broker = await Aedes.createBroker();
  const srv = net.createServer(broker.handle);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  srv.close(); broker.close();

  const img = jpeg.encode({ data: Buffer.alloc(16 * 16 * 4, 128), width: 16, height: 16 }, 80);

  const ok = reply === "你好，我是神乐" && fts === 1 && img.data[0] === 0xff;
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, reply, fts, jpeg: img.data.length }));
  console.log(ok ? "SEA-SMOKE-OK" : "SEA-SMOKE-FAIL");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
