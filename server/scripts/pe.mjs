// PE（Windows 可执行文件）头里的「子系统」字段：3 = 控制台程序（启动就开黑窗口），2 = 图形界面程序（不开窗口）。
// 托盘版 kagura-tray.exe 就是 kagura.exe 改了这一个字段：Node 本身支持没有控制台运行（输出自动丢弃），
// 这样从开始菜单 / 开机自启打开时根本不会出现控制台窗口——不用「先开窗口再藏起来」那套在 Windows 11 上靠不住的办法。
export function peSubsystemOffset(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error("不是 Windows 可执行文件（缺 MZ 头）");
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x00004550) throw new Error("不是 Windows 可执行文件（缺 PE 头）");
  const opt = pe + 24;                       // COFF 头 20 字节 + 签名 4 字节
  const magic = buf.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error("可选头格式不认识");
  return opt + 68;                           // PE32 / PE32+ 的 Subsystem 都在可选头第 68 字节
}
export const getSubsystem = (buf) => buf.readUInt16LE(peSubsystemOffset(buf));
export function setSubsystem(buf, value) { buf.writeUInt16LE(value, peSubsystemOffset(buf)); return buf; }
