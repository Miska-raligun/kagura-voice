// 极简 zip 解包（只读，给「上传技能包」用）：认 stored / deflate 两种压缩，够解普通 zip，不引入依赖。
import zlib from "node:zlib";

export interface ZipEntry { name: string; data: Buffer }

const MAX_ENTRIES = 1000;
const MAX_TOTAL = 30 * 1024 * 1024;

export function unzip(buf: Buffer): ZipEntry[] {
  // 中央目录结束记录：从尾部往前找签名 0x06054b50（后面可能跟最多 64KB 注释）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是 zip 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error(`zip 里文件太多（${count} 个）`);
  const out: ZipEntry[] = [];
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 目录损坏");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const raw = buf.subarray(p + 46, p + 46 + nlen);
    // 第 11 位 = UTF-8 文件名；否则多半是 Windows 资源管理器打的包（GBK）
    const name = (flags & 0x800 ? raw.toString("utf8") : decodeLegacy(raw)).replace(/\\/g, "/");
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;               // 目录
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("zip 文件头损坏");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const comp = buf.subarray(start, start + csize);
    total += usize;
    if (total > MAX_TOTAL) throw new Error("zip 解压后太大（上限 30MB）");
    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp, { maxOutputLength: MAX_TOTAL });
    else throw new Error(`不支持的压缩方式 ${method}（${name}）`);
    out.push({ name, data });
  }
  return out;
}

function decodeLegacy(b: Buffer): string {
  if (b.every((c) => c < 0x80)) return b.toString("ascii");
  try { return new TextDecoder("gbk", { fatal: true }).decode(b); } catch { return b.toString("utf8"); }
}
