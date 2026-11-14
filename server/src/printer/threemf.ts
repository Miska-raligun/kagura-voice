// 读 3MF（zip）里的几样东西，不整个解压：有没有切片、给哪台打印机配的、用了哪些料、切完的预计时间和用量。
// 字段名照 Bambu Studio 导出的项目文件（Metadata/project_settings.config 是 JSON，Metadata/slice_info.config 是 XML），
// 写的时候没有真机文件对照，读不到的一律当「不知道」，不当成错。
import fs from "node:fs";
import zlib from "node:zlib";

interface ZipItem { name: string; method: number; csize: number; usize: number; local: number }

/** zip 的目录（只读末尾的中央目录） */
export function zipIndex(file: string): ZipItem[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 66_000);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error("不是 zip / 3mf 文件");
    const cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (cdSize > 32 * 1024 * 1024 || cdOff + cdSize > size) throw new Error("文件目录不对（文件可能不完整）");
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out: ZipItem[] = [];
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const n = cd.readUInt16LE(p + 28), x = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32);
      out.push({ name: cd.subarray(p + 46, p + 46 + n).toString("utf8"), method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), local: cd.readUInt32LE(p + 42) });
      p += 46 + n + x + c;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

export const zipNames = (file: string) => zipIndex(file).map((e) => e.name);

/** 读 zip 里的一个文件（不超过 maxBytes，大的不读） */
export function readZipEntry(file: string, name: string, maxBytes = 16 * 1024 * 1024): Buffer | null {
  const it = zipIndex(file).find((e) => e.name === name);
  if (!it || it.usize > maxBytes || it.csize > maxBytes) return null;
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, it.local);
    if (head.readUInt32LE(0) !== 0x04034b50) return null;
    const start = it.local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const data = Buffer.alloc(it.csize);
    fs.readSync(fd, data, 0, it.csize, start);
    return it.method === 0 ? data : it.method === 8 ? zlib.inflateRawSync(data) : null;
  } finally { fs.closeSync(fd); }
}

/** 切好片的盘号（Metadata/plate_N.gcode） */
export const platesOf = (names: string[]) => names.map((n) => /^Metadata\/plate_(\d+)\.gcode$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);

export interface ProjectInfo {
  /** Bambu Studio 的项目（带配置）；false = 普通 3MF，没有配置 */
  bambu: boolean;
  /** 「Bambu Lab P2S」这种；不知道是空 */
  printerModel: string;
  printerProfile: string;
  processProfile: string;
  layerHeight: string;
  filaments: { type: string; color: string; profile: string }[];
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);

export function projectInfo(file: string): ProjectInfo {
  let j: any = null;
  try { const b = readZipEntry(file, "Metadata/project_settings.config"); if (b) j = JSON.parse(b.toString("utf8")); } catch { j = null; }
  if (!j || typeof j !== "object") return { bambu: false, printerModel: "", printerProfile: "", processProfile: "", layerHeight: "", filaments: [] };
  const types = arr(j.filament_type), colors = arr(j.filament_colour), ids = arr(j.filament_settings_id);
  return {
    bambu: true, printerModel: String(j.printer_model ?? ""), printerProfile: String(j.printer_settings_id ?? ""),
    processProfile: String(j.print_settings_id ?? ""), layerHeight: String(j.layer_height ?? ""),
    filaments: types.map((t, i) => ({ type: t, color: colors[i] ?? "", profile: ids[i] ?? "" })),
  };
}

export interface SliceInfo { plate: number; seconds: number | null; grams: number | null; printerModelId: string; filaments: { id: number; type: string; color: string; grams: number | null }[] }

/** 切完的统计（Metadata/slice_info.config）：每盘的预计时间、总重、每种料用多少 */
export function sliceInfo(file: string): SliceInfo[] {
  const b = readZipEntry(file, "Metadata/slice_info.config");
  if (!b) return [];
  const xml = b.toString("utf8");
  const meta = (block: string, key: string) => new RegExp(`<metadata\\s+key="${key}"\\s+value="([^"]*)"`).exec(block)?.[1] ?? "";
  const attr = (tag: string, k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(tag)?.[1] ?? "";
  const n = (s: string) => (s !== "" && Number.isFinite(Number(s)) ? Number(s) : null);
  return [...xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((m) => {
    const blk = m[1];
    return {
      plate: n(meta(blk, "index")) ?? 0, seconds: n(meta(blk, "prediction")), grams: n(meta(blk, "weight")), printerModelId: meta(blk, "printer_model_id"),
      filaments: [...blk.matchAll(/<filament\b[^>]*>/g)].map((f) => ({ id: n(attr(f[0], "id")) ?? 0, type: attr(f[0], "type"), color: attr(f[0], "color"), grams: n(attr(f[0], "used_g")) })),
    };
  });
}

/** 这个机型名对不对得上（「Bambu Lab P2S」对 P2S） */
export const modelMatches = (printerModel: string, model: string) => !!model && new RegExp(`(^|\\s)${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i").test(printerModel.trim());

export const fmtSeconds = (s: number) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ""}` : `${Math.max(1, m)} 分钟`; };
