// 用法：node scripts/gui-exe.mjs dist/kagura.exe dist/kagura-tray.exe
// 复制一份，把子系统改成「图形界面」（不开控制台窗口），给托盘模式用。
import fs from "node:fs";
import { getSubsystem, setSubsystem } from "./pe.mjs";
const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error("usage: node scripts/gui-exe.mjs <in.exe> <out.exe>"); process.exit(2); }
const buf = fs.readFileSync(src);
const before = getSubsystem(buf);
setSubsystem(buf, 2);
fs.writeFileSync(dst, buf);
console.log(`${dst}: subsystem ${before} → ${getSubsystem(fs.readFileSync(dst))}（2 = 图形界面，不开控制台）`);
