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

/** G-code 开头查一遍：第一次挤出（E > 0）之前有没有给喷嘴加热（M104 / M109 到 150℃ 以上）、给热床加热（M140 / M190）。
 *  启动 G-code 不对的文件（LRN 2026-11-15：P2S 的启动代码没展开，打印机一开始就空走、挤不出料）在这里拦住，别发给打印机。
 *  一直没挤出（只有移动）的不下结论：extrudes = false */
export interface StartCheck { extrudes: boolean; nozzleHeat: boolean; bedHeat: boolean; line: number }
export function startCheck(gcode: string): StartCheck {
  let nozzleHeat = false, bedHeat = false, n = 0;
  const val = (line: string, k: string) => { const m = new RegExp(`(?:^|\\s)${k}(-?\\d+(?:\\.\\d+)?)`, "i").exec(line); return m ? Number(m[1]) : null; };
  for (let i = 0, start = 0; start < gcode.length; i++) {
    let end = gcode.indexOf("\n", start); if (end < 0) end = gcode.length;
    const line = gcode.slice(start, end).replace(/;.*/, "").trim();
    start = end + 1; n = i + 1;
    if (!line) continue;
    const cmd = line.split(/\s+/)[0].toUpperCase();
    if (cmd === "M104" || cmd === "M109") { const t = val(line, "S") ?? val(line, "R"); if (t !== null && t >= 150) nozzleHeat = true; }
    else if (cmd === "M140" || cmd === "M190") { const t = val(line, "S") ?? val(line, "R"); if (t !== null && t > 0) bedHeat = true; }
    else if (/^G[0-3]$/.test(cmd)) { const e = val(line, "E"); if (e !== null && e > 0) return { extrudes: true, nozzleHeat, bedHeat, line: n }; }
  }
  return { extrudes: false, nozzleHeat, bedHeat, line: n };
}

/** 喷嘴温度的合理范围（℃，按料的类型前缀认；宽一点，只拦明显不对的：配错料、配置拼错） */
const NOZZLE_RANGE: [RegExp, number, number][] = [
  [/^PLA/, 180, 245], [/^PET/, 210, 280], [/^(ABS|ASA)/, 230, 290], [/^(TPU|TPE)/, 190, 250],
  [/^(PA|PPA)/, 250, 300], [/^PC/, 250, 300], [/^PVA/, 180, 240], [/^HIPS/, 220, 260],
];
/** P2S 这档机器的上限（喷嘴 300℃、热床 110℃）：超过的配置一定是拼错了 */
export const MAX_NOZZLE = 300, MAX_BED = 110;

/** 切好的文件里自带的最终配置（project_settings.config）查温度：这一盘用到的每种料，喷嘴温度在不在那种料的范围里、有没有超上限；热床温度有没有超上限。
 *  不看 G-code 里的温度——启动代码里有擦嘴用的 140 / 170℃ 这类中间步骤，看那个会误报 */
export function tempProblems(file: string, plate: number): string[] {
  let j: any = null;
  try { const b = readZipEntry(file, "Metadata/project_settings.config"); if (b) j = JSON.parse(b.toString("utf8")); } catch { j = null; }
  if (!j || typeof j !== "object") return [];
  const types = arr(j.filament_type), noz = arr(j.nozzle_temperature), noz0 = arr(j.nozzle_temperature_initial_layer);
  const used = sliceInfo(file).find((x) => x.plate === plate)?.filaments.map((f) => f.id - 1).filter((i) => i >= 0 && i < types.length);
  const out: string[] = [];
  for (const i of used?.length ? used : types.map((_, i) => i)) {
    const type = String(types[i] ?? "").toUpperCase();
    const temps = [noz[i], noz0[i]].map(Number).filter((x) => Number.isFinite(x) && x > 0);
    if (!temps.length) continue;
    const hi = Math.max(...temps), lo = Math.min(...temps);
    const r = NOZZLE_RANGE.find(([re]) => re.test(type));
    if (hi > MAX_NOZZLE) out.push(`第 ${i + 1} 种料（${type || "未知"}）喷嘴 ${hi}℃，超过打印机上限 ${MAX_NOZZLE}℃`);
    else if (r && (lo < r[1] || hi > r[2])) out.push(`第 ${i + 1} 种料是 ${type}，喷嘴却是 ${lo === hi ? lo : `${lo}~${hi}`}℃（${type} 一般 ${r[1]}~${r[2]}℃）`);
  }
  for (const [k, v] of Object.entries(j)) {
    if (!/_plate_temp(_initial_layer)?$/.test(k)) continue;
    const hot = arr(v).map(Number).filter((x) => Number.isFinite(x) && x > MAX_BED);
    if (hot.length) { out.push(`热床温度设到了 ${Math.max(...hot)}℃（${k}），超过上限 ${MAX_BED}℃`); break; }
  }
  return out;
}

/** 切好的文件第 N 盘能不能拿去打：启动代码（先加热再挤料）+ 温度。不对返回给人看的原因，对 / 读不出返回空 */
export function startProblem(file: string, plate: number): string {
  const probs: string[] = [];
  const g = readZipEntry(file, `Metadata/plate_${plate}.gcode`, 256 * 1024 * 1024);
  if (g) {
    const c = startCheck(g.toString("latin1"));
    const miss = [!c.nozzleHeat && "给喷嘴加热", !c.bedHeat && "给热床加热"].filter(Boolean);
    if (c.extrudes && miss.length) probs.push(`第 ${plate} 盘的 G-code 在第一次挤料（第 ${c.line} 行）之前没有${miss.join("、")}——启动代码不对，发出去打印机会空走、挤不出料（还可能刮板）`);
  }
  probs.push(...tempProblems(file, plate));
  return probs.join("；");
}
