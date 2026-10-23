// Windows 托盘图标：打开管理页面 / 重启服务端 / 退出。
// 用 PowerShell + WinForms 的 NotifyIcon 实现，单文件可执行里不需要额外原生依赖；
// 托盘进程和主进程分开，主进程重启/退出都不影响图标存在（退出菜单会先调 /api/admin/quit 再自己关）。
import { spawn } from "node:child_process";

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

function trayScript(port: number, exe: string, url: string, logDir: string): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$mutex = New-Object System.Threading.Mutex($false, 'Global\\KaguraTrayMutex', [ref]$created)
if (-not $created) { exit }
$exe = ${psQuote(exe)}
$url = ${psQuote(url)}
$logDir = ${psQuote(logDir)}
$port = ${port}
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Application }
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = 'Kagura 语音助手'
$ni.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('打开管理页面')
$open.add_Click({ Start-Process $url })
$log = $menu.Items.Add('打开日志文件夹')
$log.add_Click({ Start-Process explorer.exe $logDir })
$restart = $menu.Items.Add('重启服务端')
$restart.add_Click({
  try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/admin/restart" -TimeoutSec 15 | Out-Null } catch {}
})
$quit = $menu.Items.Add('退出')
$quit.add_Click({
  try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/admin/quit" -TimeoutSec 10 | Out-Null } catch {}
  $ni.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$ni.ContextMenuStrip = $menu
$ni.add_DoubleClick({ Start-Process $url })
$ni.ShowBalloonTip(5000, 'Kagura', '已启动。右键托盘图标可以打开管理页面、重启或退出。', 'Info')
# 服务端被别的途径关掉（/api/admin/quit、任务管理器）时，图标也别一直挂着
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$script:miss = 0
$timer.add_Tick({
  try { Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$port/api/admin/meta" -TimeoutSec 2 | Out-Null; $script:miss = 0 }
  catch { $script:miss++; if ($script:miss -ge 3) { $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() } }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
`;
}

/** 启动托盘（仅 Windows；失败只打日志，不影响服务端） */
export function startTray(port: number, dataDir: string) {
  if (process.platform !== "win32") return;
  if (process.env.KAGURA_NO_TRAY === "1") return;
  const exe = process.execPath;
  const url = `http://127.0.0.1:${port}/admin`;
  const logDir = `${dataDir}\\logs`;
  const script = trayScript(port, exe, url, logDir);
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  try {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", b64], {
      detached: true, windowsHide: true, stdio: "ignore",
    });
    p.on("error", (e: any) => console.log(`[tray] ⚠️  启动托盘失败: ${e.message}`));
    p.unref();
    console.log("[tray] 托盘图标已启动");
  } catch (e: any) {
    console.log(`[tray] ⚠️  启动托盘失败: ${e.message}`);
  }
}
