// 设备文件同步：管理界面里传图 / 换代码，设备收到 MQTT 命令后自己来拉。
//
// 路径都相对设备上的 /flash/kagura/，只认两类：
//   src/<模块>.py                    设备代码。内置一份（构建时从 device/src 打进来，版本 = 服务端版本），
//                                    管理界面上传的同名文件覆盖内置那份；删掉覆盖 = 回到内置
//   resource/<图名>.jpg              默认角色的背景图
//   resource/<角色 id>/<图名>.jpg    某个角色专属的图（没有就沿用默认那张，见 device ui.img_path）
// 自定义文件存在 <数据目录>/device_files/ 下，目录结构与设备一致。
//
// 设备那边：GET /device/files 拿清单（路径 + 大小 + sha256）→ 跟本地比 → 只下载变了的。
// 图片随传随同步；代码要在设备屏幕上点一下确认才装（见 device/src/ota.py）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type Scope = "res" | "code" | "all";
export interface FileEntry { p: string; n: number; h: string; source: "builtin" | "custom" }

const SRC_RE = /^src\/[a-z_][a-z0-9_]{0,31}\.py$/;
const RES_RE = /^resource\/(?:[A-Za-z0-9_-]{1,24}\/)?[A-Za-z0-9_-]{1,32}\.jpg$/;
export const MAX_IMAGE = 200 * 1024;    // 设备堆紧：整屏 JPEG 解码，图太大只会更慢更容易失败
export const MAX_CODE = 128 * 1024;

/** 管理界面里给每个角色列出来的图位（与 device/src/ui.py 用到的图名一致） */
export const IMAGE_SLOTS: { base: string; desc: string }[] = [
  { base: "img_bg", desc: "待机背景（必备，其它图缺了都退回它）" },
  { base: "img_recording", desc: "正在听" },
  { base: "img_streaming", desc: "思考中 / 被摸 / 直播中" },
  { base: "img_playing", desc: "说话 / 播报" },
  { base: "img_shake", desc: "摇一摇彩蛋" },
];

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const inScope = (p: string, s: Scope) => s === "all" || (s === "code" ? p.startsWith("src/") : p.startsWith("resource/"));

export function checkPath(p: string): string {
  if (typeof p !== "string" || !(SRC_RE.test(p) || RES_RE.test(p))) {
    throw Object.assign(new Error(`不支持的设备文件路径: ${JSON.stringify(p)}（只能是 src/<模块>.py 或 resource/[角色/]<图名>.jpg）`), { status: 400 });
  }
  return p;
}

export function checkContent(p: string, data: Buffer) {
  const bad = (m: string) => { throw Object.assign(new Error(m), { status: 400 }); };
  if (p.startsWith("resource/")) {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) bad("图片必须是 JPEG");
    if (data.length > MAX_IMAGE) bad(`图片太大（${data.length >> 10}KB），上限 ${MAX_IMAGE >> 10}KB`);
  } else {
    if (data.length > MAX_CODE) bad(`代码文件太大（${data.length >> 10}KB），上限 ${MAX_CODE >> 10}KB`);
    const text = data.toString("utf8");
    if (Buffer.from(text, "utf8").compare(data) !== 0 || text.includes("\u0000")) bad("代码文件必须是 UTF-8 文本");
  }
}

export class DeviceFiles {
  private builtinHash = new Map<string, { n: number; h: string }>();

  constructor(
    readonly root: string,
    /** 内置固件：{ "src/app.py": 内容 }。来自构建时的 virtual:device-fw */
    private builtin: Record<string, Buffer>,
    readonly builtinVersion: string,
  ) {
    fs.mkdirSync(root, { recursive: true });
    for (const [p, b] of Object.entries(builtin)) this.builtinHash.set(p, { n: b.length, h: sha(b) });
  }

  private abs(p: string) { return path.join(this.root, ...checkPath(p).split("/")); }

  private customs(): string[] {
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        const full = path.join(dir, name), r = rel ? `${rel}/${name}` : name;
        if (fs.statSync(full).isDirectory()) walk(full, r);
        else if (SRC_RE.test(r) || RES_RE.test(r)) out.push(r);
      }
    };
    walk(this.root, "");
    return out;
  }

  /** 全部生效的文件（自定义覆盖内置），按路径排序 */
  list(scope: Scope = "all"): FileEntry[] {
    const m = new Map<string, FileEntry>();
    for (const [p, v] of this.builtinHash) m.set(p, { p, ...v, source: "builtin" });
    for (const p of this.customs()) {
      const b = fs.readFileSync(this.abs(p));
      m.set(p, { p, n: b.length, h: sha(b), source: "custom" });
    }
    return [...m.values()].filter((e) => inScope(e.p, scope)).sort((a, b) => (a.p < b.p ? -1 : 1));
  }

  /** 一组文件的指纹：设备同步成功后记下来随心跳上报，管理界面拿它判断「是不是最新」 */
  static rev(files: { p: string; h: string }[]) {
    return sha(Buffer.from(files.map((f) => `${f.p}:${f.h}`).join("\n"))).slice(0, 12);
  }

  manifest(scope: Scope) {
    const files = this.list(scope).map(({ p, n, h }) => ({ p, n, h }));
    return { scope, version: this.builtinVersion, rev: DeviceFiles.rev(files), files };
  }

  read(p: string): Buffer | null {
    checkPath(p);
    try { return fs.readFileSync(this.abs(p)); } catch { /* 没有自定义的就看内置 */ }
    return this.builtin[p] ?? null;
  }

  isCustom(p: string) { return fs.existsSync(this.abs(p)); }
  isBuiltin(p: string) { return p in this.builtin; }

  put(p: string, data: Buffer) {
    checkContent(checkPath(p), data);
    const f = this.abs(p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, f);
  }

  /** 删掉自定义文件。内置代码删不掉——删的是覆盖，回到内置那份 */
  remove(p: string): boolean {
    const f = this.abs(p);
    if (!fs.existsSync(f)) return false;
    fs.unlinkSync(f);
    try { fs.rmdirSync(path.dirname(f)); } catch { /* 目录里还有别的 */ }
    return true;
  }
}
