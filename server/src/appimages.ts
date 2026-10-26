// 手机 / 平板网页显示用的角色图（<数据目录>/app_images/[角色/]<图名>.<jpg|png|webp>）。
// 和 CoreS3 那套（device_files，320×240 JPEG、受设备内存限制）分开存：手机屏幕大、竖着拿，
// 可以传高清、任意比例的图。手机没单独传的图位退回 CoreS3 那套，所以不传也照样有图。
import fs from "node:fs";
import path from "node:path";
import { IMAGE_SLOTS } from "./devicefiles.ts";

export const MAX_APP_IMAGE = 4 * 1024 * 1024;   // 请求体上限 8MB（base64 涨三分之一），留点余量
const ROLE_RE = /^[A-Za-z0-9_-]{1,24}$/;
const SLOTS = new Set(IMAGE_SLOTS.map((s) => s.base));
const TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
type Ext = keyof typeof TYPES;
const EXTS = Object.keys(TYPES) as Ext[];

export interface AppImage { role: string; name: string; ext: Ext; n: number; mtime: number }

const bad = (m: string, status = 400) => Object.assign(new Error(m), { status });

export function checkRole(role: string) {
  if (role && !ROLE_RE.test(role)) throw bad(`角色 id 不对: ${JSON.stringify(role)}`);
  return role;
}
export function checkName(name: string) {
  if (!SLOTS.has(name)) throw bad(`没有这个图位: ${JSON.stringify(name)}（只能是 ${[...SLOTS].join(" / ")}）`);
  return name;
}

/** 按文件头认格式：JPEG / PNG / WebP，别的不收 */
export function sniff(b: Buffer): Ext | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

export class AppImages {
  constructor(readonly root: string) { fs.mkdirSync(root, { recursive: true }); }

  private dir(role: string) { return role ? path.join(this.root, checkRole(role)) : this.root; }

  /** 某个图位现在存的文件（每个图位只留一份，换格式时旧的会删掉） */
  find(role: string, name: string): { file: string; ext: Ext } | null {
    const d = this.dir(role);
    for (const ext of EXTS) {
      const file = path.join(d, `${checkName(name)}.${ext}`);
      if (fs.existsSync(file)) return { file, ext };
    }
    return null;
  }

  read(role: string, name: string): { data: Buffer; type: string; mtime: number } | null {
    const f = this.find(role, name);
    if (!f) return null;
    try { return { data: fs.readFileSync(f.file), type: TYPES[f.ext], mtime: fs.statSync(f.file).mtimeMs }; } catch { return null; }
  }

  put(role: string, name: string, data: Buffer): AppImage {
    checkName(name);
    const ext = sniff(data);
    if (!ext) throw bad("只支持 JPEG / PNG / WebP 图片");
    if (data.length > MAX_APP_IMAGE) throw bad(`图片太大（${(data.length / 1048576).toFixed(1)}MB），上限 ${MAX_APP_IMAGE >> 20}MB`);
    const d = this.dir(role);
    fs.mkdirSync(d, { recursive: true });
    this.remove(role, name);
    const file = path.join(d, `${name}.${ext}`), tmp = file + ".tmp";
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
    return { role, name, ext, n: data.length, mtime: fs.statSync(file).mtimeMs };
  }

  remove(role: string, name: string): boolean {
    let hit = false;
    for (;;) {
      const f = this.find(role, name);
      if (!f) break;
      fs.unlinkSync(f.file); hit = true;
    }
    if (hit && role) { try { fs.rmdirSync(this.dir(role)); } catch { /* 目录里还有别的 */ } }
    return hit;
  }

  list(): AppImage[] {
    const out: AppImage[] = [];
    const scan = (d: string, role: string) => {
      let names: string[] = [];
      try { names = fs.readdirSync(d); } catch { return; }
      for (const f of names) {
        const full = path.join(d, f);
        const m = /^([A-Za-z0-9_-]+)\.(jpg|png|webp)$/.exec(f);
        if (m && SLOTS.has(m[1])) {
          const st = fs.statSync(full);
          if (st.isFile()) out.push({ role, name: m[1], ext: m[2] as Ext, n: st.size, mtime: st.mtimeMs });
        } else if (!role && ROLE_RE.test(f) && fs.statSync(full).isDirectory()) scan(full, f);
      }
    };
    scan(this.root, "");
    return out.sort((a, b) => (a.role + "/" + a.name < b.role + "/" + b.name ? -1 : 1));
  }
}
