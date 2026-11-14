// 不靠 Blender 的预览图和网格检查：读 STL（二进制 / 文本）→ 焊点 → 数破洞边 / 非流形边、体积 →
// 四个角度正交投影的软件光栅化（z 缓冲 + 平面光照 + 深度跳变处描边）→ 2×2 拼成一张 PNG（zlib，零依赖）。
// 视角和 Blender 那边一致：左上 前面斜上方、右上 正面、左下 右侧、右下 背面斜上方。
import fs from "node:fs";
import zlib from "node:zlib";

export interface Mesh { tris: Float32Array; count: number }   // 每个三角形 9 个数

export function readStl(file: string): Mesh {
  const buf = fs.readFileSync(file);
  const n = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
  if (buf.length >= 84 && 84 + n * 50 === buf.length) {
    const tris = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++) tris[i * 9 + k] = buf.readFloatLE(o + k * 4);
    }
    return { tris, count: n };
  }
  // 文本 STL
  const s = buf.toString("latin1");
  const vs = [...s.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  const count = Math.floor(vs.length / 3);
  const tris = new Float32Array(count * 9);
  for (let i = 0; i < count * 3; i++) tris.set(vs[i], i * 3);
  return { tris, count };
}

export interface MeshCheck { tris: number; boundary: number; non_manifold: number; volume_mm3: number; min: number[]; max: number[] }

export function checkMesh(m: Mesh): MeshCheck {
  const ids = new Map<string, number>();
  const q = (x: number) => Math.round(x * 1e4);
  const vid = (i: number) => {
    const k = `${q(m.tris[i])},${q(m.tris[i + 1])},${q(m.tris[i + 2])}`;
    let v = ids.get(k);
    if (v === undefined) { v = ids.size; ids.set(k, v); }
    return v;
  };
  const edges = new Map<string, number>();
  let vol = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  for (let t = 0; t < m.count; t++) {
    const b = t * 9;
    const a = vid(b), c = vid(b + 3), d = vid(b + 6);
    for (let k = 0; k < 9; k++) { const ax = k % 3; const v = m.tris[b + k]; if (v < lo[ax]) lo[ax] = v; if (v > hi[ax]) hi[ax] = v; }
    if (a === c || c === d || a === d) continue;           // 退化三角形
    tris++;
    for (const [x, y] of [[a, c], [c, d], [d, a]]) { const k = x < y ? `${x}_${y}` : `${y}_${x}`; edges.set(k, (edges.get(k) ?? 0) + 1); }
    const [x1, y1, z1, x2, y2, z2, x3, y3, z3] = m.tris.subarray(b, b + 9);
    vol += (x1 * (y2 * z3 - z2 * y3) - y1 * (x2 * z3 - z2 * x3) + z1 * (x2 * y3 - y2 * x3)) / 6;
  }
  let boundary = 0, non_manifold = 0;
  for (const n of edges.values()) { if (n === 1) boundary++; else if (n > 2) non_manifold++; }
  return { tris, boundary, non_manifold, volume_mm3: Math.round(Math.abs(vol) * 10) / 10, min: lo, max: hi };
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

const BG: V3 = [235, 235, 240], BASE: V3 = [217, 140, 64];
export const VIEWS: [string, V3, number][] = [["iso", [1, -1, 0.8], 1.6], ["front", [0, -1, 0], 1.35], ["right", [1, 0, 0], 1.35], ["back", [-1, 1, 0.9], 1.6]];

/** 渲一个角度：d 是相机所在方向（从模型指向相机），scale = 视野宽 / 模型最大尺寸 */
export function renderView(m: Mesh, d: V3, scale: number, W: number, H: number): Uint8Array {
  const fwd = norm([-d[0], -d[1], -d[2]]);
  const upHint: V3 = Math.abs(fwd[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const right = norm(cross(fwd, upHint)), up = cross(right, fwd);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.count * 9; i++) { const ax = i % 3; lo[ax] = Math.min(lo[ax], m.tris[i]); hi[ax] = Math.max(hi[ax], m.tris[i]); }
  if (!m.count) { lo = [0, 0, 0]; hi = [1, 1, 1]; }
  const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1);
  const px = W / (span * scale);                          // 每毫米多少像素（按宽）
  const light = norm([0.45 * right[0] + 0.6 * up[0] - 0.7 * fwd[0], 0.45 * right[1] + 0.6 * up[1] - 0.7 * fwd[1], 0.45 * right[2] + 0.6 * up[2] - 0.7 * fwd[2]]);
  const zb = new Float32Array(W * H).fill(Infinity);
  const col = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) col.set(BG, i * 3);
  const P = new Float32Array(9);
  for (let t = 0; t < m.count; t++) {
    const b = t * 9;
    const v0: V3 = [m.tris[b], m.tris[b + 1], m.tris[b + 2]], v1: V3 = [m.tris[b + 3], m.tris[b + 4], m.tris[b + 5]], v2: V3 = [m.tris[b + 6], m.tris[b + 7], m.tris[b + 8]];
    let n = cross(sub(v1, v0), sub(v2, v0));
    if (!n[0] && !n[1] && !n[2]) continue;
    n = norm(n);
    if (dot(n, fwd) > 0) n = [-n[0], -n[1], -n[2]];        // 背面也画（看得见内腔），法线翻过来朝相机
    const lit = 0.38 + 0.62 * Math.max(0, dot(n, light)) + 0.12 * Math.max(0, -dot(n, fwd));
    const shade: V3 = [Math.min(255, BASE[0] * lit), Math.min(255, BASE[1] * lit), Math.min(255, BASE[2] * lit)];
    for (const [k, v] of [v0, v1, v2].entries()) {
      const r = sub(v, c);
      P[k * 3] = W / 2 + dot(r, right) * px;
      P[k * 3 + 1] = H / 2 - dot(r, up) * px;
      P[k * 3 + 2] = dot(r, fwd);
    }
    const x0 = Math.max(0, Math.floor(Math.min(P[0], P[3], P[6]))), x1 = Math.min(W - 1, Math.ceil(Math.max(P[0], P[3], P[6])));
    const y0 = Math.max(0, Math.floor(Math.min(P[1], P[4], P[7]))), y1 = Math.min(H - 1, Math.ceil(Math.max(P[1], P[4], P[7])));
    const area = (P[3] - P[0]) * (P[7] - P[1]) - (P[4] - P[1]) * (P[6] - P[0]);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const sx = x + 0.5, sy = y + 0.5;
        const w0 = ((P[3] - sx) * (P[7] - sy) - (P[4] - sy) * (P[6] - sx)) / area;
        const w1 = ((P[6] - sx) * (P[1] - sy) - (P[7] - sy) * (P[0] - sx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * P[2] + w1 * P[5] + w2 * P[8];
        const i = y * W + x;
        if (z < zb[i]) { zb[i] = z; col[i * 3] = shade[0]; col[i * 3 + 1] = shade[1]; col[i * 3 + 2] = shade[2]; }
      }
    }
  }
  // 描边：轮廓（有 / 没有模型的交界）+ 深度的二阶差分（正交投影下平面的深度是线性的、二阶差分为零；
  // 台阶、棱、孔口才有）——比直接比深度差稳：斜着看的大平面相邻像素深度差也不小，但不会被误描
  const jump = span * 0.004;
  const out = new Uint8Array(col);
  const at = (i: number) => zb[i];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, z = at(i);
      if (z === Infinity) continue;
      const l = at(i - 1), r = at(i + 1), u = at(i - W), d = at(i + W);
      const sil = l === Infinity || r === Infinity || u === Infinity || d === Infinity;
      const edge = sil || Math.abs(l + r - 2 * z) > jump || Math.abs(u + d - 2 * z) > jump;
      if (edge) for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.round(out[i * 3 + k] * (sil ? 0.35 : 0.55));
    }
  }
  return out;
}

/** 四个角度拼 2×2 */
export function renderGrid(m: Mesh, W = 400, H = 300): Buffer {
  const tiles = VIEWS.map(([, d, s]) => renderView(m, d, s, W, H));
  const GW = W * 2, GH = H * 2;
  const img = new Uint8Array(GW * GH * 3);
  tiles.forEach((t, k) => {
    const ox = (k % 2) * W, oy = Math.floor(k / 2) * H;
    for (let y = 0; y < H; y++) img.set(t.subarray(y * W * 3, (y + 1) * W * 3), ((oy + y) * GW + ox) * 3);
  });
  return encodePng(img, GW, GH);
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** RGB 8 位 → PNG */
export function encodePng(rgb: Uint8Array, W: number, H: number): Buffer {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; raw.set(rgb.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
