// 解 .tgz / .tar（npm 包、GitHub 源码包）。只处理普通文件和目录，链接、设备文件一律跳过。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export interface TarEntry { name: string; type: "file" | "dir"; data: Buffer }

const str = (b: Buffer, off: number, len: number) => {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString("utf8");
};
const oct = (b: Buffer, off: number, len: number) => parseInt(str(b, off, len).trim() || "0", 8);

/** 解析 tar（自动识别 gzip），返回文件列表。支持 ustar 前缀、GNU 长文件名（L）、pax 头（x / g 的 path） */
export function parseTar(buf: Buffer): TarEntry[] {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const out: TarEntry[] = [];
  let off = 0, longName = "", paxPath = "";
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = oct(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = str(data, 0, data.length); continue; }
    if (type === "x" || type === "g") {
      for (const line of data.toString("utf8").split("\n")) {
        const m = /^\d+ path=(.*)$/.exec(line);
        if (m && type === "x") paxPath = m[1];
      }
      continue;
    }
    const prefix = str(h, 345, 155);
    let name = longName || paxPath || (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    longName = ""; paxPath = "";
    name = name.replace(/\\/g, "/");
    if (type === "0" || type === "\0" || type === "7") out.push({ name, type: "file", data: Buffer.from(data) });
    else if (type === "5") out.push({ name, type: "dir", data: Buffer.alloc(0) });
  }
  return out;
}

/**
 * 解到 dest。strip = 去掉的前导路径层数（npm 包是 package/，GitHub 是 <repo>-<ref>/）。
 * 路径越出 dest 的条目直接拒绝（防恶意包写到别处）。返回写出的文件数。
 */
export function extractTar(buf: Buffer, dest: string, strip = 1, maxBytes = 200 * 1024 * 1024): number {
  const root = path.resolve(dest);
  let n = 0, total = 0;
  for (const e of parseTar(buf)) {
    const parts = e.name.split("/").filter((p) => p && p !== ".");
    if (parts.length <= strip) continue;
    const rel = parts.slice(strip);
    if (rel.some((p) => p === "..")) throw new Error(`包里有越界路径：${e.name}`);
    const target = path.join(root, ...rel);
    if (!target.startsWith(root + path.sep)) throw new Error(`包里有越界路径：${e.name}`);
    if (e.type === "dir") { fs.mkdirSync(target, { recursive: true }); continue; }
    total += e.data.length;
    if (total > maxBytes) throw new Error(`包太大（超过 ${Math.round(maxBytes / 1048576)}MB）`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data);
    n++;
  }
  return n;
}
