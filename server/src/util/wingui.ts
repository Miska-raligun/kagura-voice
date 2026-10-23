// Windows 托盘版（kagura-tray.exe，图形界面子系统、没有控制台）用的小工具。
import fs from "node:fs";
import { spawn } from "node:child_process";

/** 读可执行文件头里的子系统：2 = 图形界面（没有控制台），3 = 控制台；读不出来返回 null */
export function exeSubsystem(file: string): number | null {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    if (buf.readUInt16LE(0) !== 0x5a4d) return null;
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 24 + 70 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null;
    return buf.readUInt16LE(pe + 24 + 68);
  } catch { return null; }
}

let gui: boolean | null = null;
/** 当前进程是不是托盘版（没有控制台窗口：console.log 看不见，也不能停下来问用户） */
export function isGuiProcess(): boolean {
  if (gui === null) gui = process.platform === "win32" && exeSubsystem(process.execPath) === 2;
  return gui;
}

/** 弹一个 Windows 消息框（托盘版出错时，用户总得看到点什么） */
export function messageBox(title: string, text: string) {
  if (process.platform !== "win32") return;
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(${q(text)}, ${q(title)}, 'OK', 'Warning') | Out-Null`;
  try {
    spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  } catch { /* 弹不出来就算了，日志里有 */ }
}
