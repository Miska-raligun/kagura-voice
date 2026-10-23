// 路径安全：文件类工具只能碰本 agent 的 workspace（§6.1）。产品版没有沙箱，这里比 OpenClaw 默认更严。
import fs from "node:fs";
import path from "node:path";

/** 把相对路径解析到 root 里面；绝对路径、.. 逃逸、符号链接逃逸一律抛错 */
export function resolveInside(root: string, rel: string): string {
  if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.includes("\0")) throw new Error(`路径不合法: ${rel}`);
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, rel);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
  if (!inside(target)) throw new Error(`路径越界: ${rel}`);
  // 已存在的最深一级取真实路径，防符号链接指出去
  let probe = target;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  if (!inside(fs.realpathSync(probe))) throw new Error(`路径越界（符号链接）: ${rel}`);
  return target;
}
