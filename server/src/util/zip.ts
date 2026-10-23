// 极简 zip 解包（只读，给「上传技能包」用）：认 stored / deflate 两种压缩，够解普通 zip，不引入依赖。
import zlib from "node:zlib";

export interface ZipEntry { name: string; data: Buffer }

const MAX_ENTRIES = 1000;
const MAX_TOTAL = 30 * 1024 * 1024;

export function unzip(buf: Buffer, limits: { maxEntries?: number; maxTotal?: number } = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? MAX_ENTRIES, maxTotal = limits.maxTotal ?? MAX_TOTAL;
  // 中央目录结束记录：从尾部往前找签名 0x06054b50（后面可能跟最多 64KB 注释）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是 zip 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) throw new Error(`zip 里文件太多（${count} 个）`);
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
    if (total > maxTotal) throw new Error(`zip 解压后太大（上限 ${Math.round(maxTotal / 1048576)}MB）`);
    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp, { maxOutputLength: maxTotal });
    else throw new Error(`不支持的压缩方式 ${method}（${name}）`);
    out.push({ name, data });
  }
  return out;
}

function decodeLegacy(b: Buffer): string {
  if (b.every((c) => c < 0x80)) return b.toString("ascii");
  try { return new TextDecoder("gbk", { fatal: true }).decode(b); } catch { return b.toString("utf8"); }
}

/** 打 zip（UTF-8 文件名，能压就 deflate）。给「导出备份」用；单个文件和总大小都要小于 4GB（不做 zip64） */
export function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, "/"), "utf8");
    const crc = zlib.crc32(e.data);
    const deflated = e.data.length > 64 ? zlib.deflateRawSync(e.data, { level: 6 }) : null;
    const useDeflate = !!deflated && deflated.length < e.data.length;
    const body = useDeflate ? deflated! : e.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(useDeflate ? 8 : 0, 10); c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(local, name, body);
    central.push(c, name);
    off += 30 + name.length + body.length;
    if (off > 0xffffffff) throw new Error("备份超过 4GB，请少选几项");
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  if (entries.length > 0xffff) throw new Error("文件太多（超过 65535 个），请少选几项");
  return Buffer.concat([...parts, cd, end]);
}
