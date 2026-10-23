// M0 验证：node:sqlite（含 FTS5 中文检索）、aedes 内置 MQTT broker、纯 JS RGB565→JPEG。
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let ok = true;
const check = (name: string, cond: boolean, info = "") => { console.log(`${cond ? "✅" : "❌"} ${name} ${info}`); ok &&= cond; };

// ── 1. node:sqlite + FTS5 ────────────────────────────────────────────
// trigram 分词至少 3 字，两字中文词（"出差"）搜不到 → 改为 CJK 逐字切开 + unicode61 + 短语查询（详见 fts-cjk.ts）
const seg = (t: string) => t.replace(/([\u3400-\u9fff])/g, " $1 ").replace(/\s+/g, " ").trim();
const db = new DatabaseSync(":memory:");
db.exec("CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, body, tokenize='unicode61')");
const ins = db.prepare("INSERT INTO notes(path, body) VALUES (?, ?)");
ins.run("memory/2026-10-20.md", seg("主人说下周三要去杭州出差，记得提醒带充电器"));
ins.run("MEMORY.md", seg("主人喜欢喝无糖乌龙茶，不喜欢香菜"));
const hit = db.prepare("SELECT path FROM notes WHERE notes MATCH ?").all('"' + seg("出差") + '"') as any[];
check("node:sqlite FTS5 中文两字词", hit.length === 1 && hit[0].path === "memory/2026-10-20.md", JSON.stringify(hit));
// 向量：存成 BLOB，JS 里算余弦
db.exec("CREATE TABLE vec(id INTEGER PRIMARY KEY, v BLOB)");
db.prepare("INSERT INTO vec(v) VALUES (?)").run(new Uint8Array(new Float32Array([0.1, 0.9, 0.3]).buffer));
const row = db.prepare("SELECT v FROM vec").get() as any;
const back = new Float32Array(new Uint8Array(row.v).buffer);
check("向量 BLOB 往返", Math.abs(back[1] - 0.9) < 1e-6);

// ── 2. aedes broker：设备订阅 → 服务端发布 ─────────────────────────────
const { Aedes } = require("aedes");
const broker = await Aedes.createBroker();
const srv = net.createServer(broker.handle);
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const port = (srv.address() as any).port;
// 手写一个最小 MQTT 3.1.1 客户端（设备用的就是 umqtt 这类最简实现）
const enc = (s: string) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
const pkt = (type: number, body: Buffer) => Buffer.concat([Buffer.from([type, body.length]), body]);
const got = await new Promise<string>((resolve, reject) => {
  const c = net.connect(port, "127.0.0.1");
  let stage = 0;
  c.on("data", (d) => {
    if (stage === 0 && d[0] === 0x20) { stage = 1; c.write(pkt(0x82, Buffer.concat([Buffer.from([0, 1]), enc("kagura/push/cores3"), Buffer.from([1])]))); }
    else if (stage === 1 && d[0] === 0x90) { stage = 2; broker.publish({ topic: "kagura/push/cores3", payload: Buffer.from('{"type":"push","url":"/push-audio/a.wav"}'), qos: 1, retain: false, cmd: "publish", dup: false }, () => {}); }
    else if (stage === 2 && (d[0] & 0xf0) === 0x30) {
      const tl = d.readUInt16BE(2); const off = 4 + tl + ((d[0] & 0x06) ? 2 : 0);
      resolve(d.subarray(off).toString()); c.end();
    }
  });
  c.on("error", reject);
  c.write(pkt(0x10, Buffer.concat([enc("MQTT"), Buffer.from([4, 2, 0, 60]), enc("cores3")])));
  setTimeout(() => reject(new Error("timeout")), 3000);
});
check("aedes 内置 broker：订阅 + 发布到设备", got.includes("/push-audio/a.wav"), got);
broker.close(); srv.close();

// ── 3. RGB565 → JPEG（纯 JS）──────────────────────────────────────────
const jpeg = require("jpeg-js");
const W = 320, H = 240;
const raw = Buffer.alloc(W * H * 2);
for (let i = 0; i < W * H; i++) raw.writeUInt16BE(((i % W) >> 4) << 11 | 0x07e0 >> 1, i * 2); // 大端：与 voice_server 的 frombuffer+byteswap 一致
const t0 = performance.now();
const rgba = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  const v = raw.readUInt16BE(i * 2);
  rgba[i * 4] = Math.floor(((v >> 11) & 31) * 255 / 31); rgba[i * 4 + 1] = Math.floor(((v >> 5) & 63) * 255 / 63); rgba[i * 4 + 2] = Math.floor((v & 31) * 255 / 31); // 与 Python 的 // 整除一致 rgba[i * 4 + 3] = 255;
}
const out = jpeg.encode({ data: rgba, width: W, height: H }, 80);
const ms = performance.now() - t0;
check("RGB565→JPEG 320×240", out.data[0] === 0xff && out.data[1] === 0xd8, `${out.data.length} 字节 ${ms.toFixed(0)}ms`);
const dec = jpeg.decode(out.data);
check("JPEG 可解码回去", dec.width === W && dec.height === H);

process.exit(ok ? 0 : 1);
