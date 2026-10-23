// 生成应用图标（不往仓库里放二进制）：一台小设备的「脸」——紫色圆角底 + 白色屏幕 + 两只眼睛和微笑。
// 输出 dist/icon.png（256）与 dist/icon.ico（内嵌 PNG，Windows Vista+ 支持）。
import fs from "node:fs";
import zlib from "node:zlib";
const S = 256;
const px = Buffer.alloc(S * S * 4);
const rr = (x, y, x0, y0, x1, y1, r) => {            // 圆角矩形的有符号距离
  const cx = Math.max(x0 + r, Math.min(x, x1 - r)), cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return Math.hypot(x - cx, y - cy) - r;
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const X = x + 0.5, Y = y + 0.5;
  let c = [0, 0, 0, 0];
  const bg = rr(X, Y, 8, 8, 248, 248, 56);
  if (bg < 1) c = [...mix([137, 120, 245], [104, 86, 225], Y / S), Math.round(255 * Math.min(1, 1 - bg))];
  const scr = rr(X, Y, 40, 56, 216, 200, 28);
  if (scr < 1) c = [...mix(c.slice(0, 3), [255, 255, 255], Math.min(1, 1 - scr)), 255];
  for (const ex of [96, 160]) {
    const e = Math.hypot((X - ex) / 1, (Y - 112) / 1.25) - 15;
    if (e < 1) c = [...mix(c.slice(0, 3), [40, 34, 70], Math.min(1, 1 - e)), 255];
  }
  const d = Math.hypot(X - 128, Y - 132), ang = Math.atan2(Y - 132, X - 128);
  const smile = Math.abs(d - 30) - 5;
  if (ang > 0.5 && ang < Math.PI - 0.5 && smile < 1) c = [...mix(c.slice(0, 3), [232, 110, 150], Math.min(1, 1 - smile)), 255];
  px.set(c, (y * S + x) * 4);
}
const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
const ico = Buffer.alloc(22); ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/icon.png", png);
fs.writeFileSync("dist/icon.ico", Buffer.concat([ico, png]));
console.log(`icon.png ${png.length} B, icon.ico ${ico.length + png.length} B`);
