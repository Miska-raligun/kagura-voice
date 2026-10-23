// Windows 托盘图标：打开管理页面 / 打开日志 / 重启服务端 / 退出。
// 用 PowerShell + WinForms 的 NotifyIcon 实现，单文件可执行里不需要额外原生依赖；
// 托盘进程和主进程分开，主进程重启/退出都不影响图标存在（退出菜单会先调 /api/admin/quit 再自己关）。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function trayScript(port: number, exe: string, url: string, logDir: string): string {
  const logPath = `${logDir}\\tray.log`;
  return `
$ErrorActionPreference = 'Continue'
$trayLog = ${psQuote(logPath)}
function L($m) { try { Add-Content -Path $trayLog -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) } catch {} }
trap { L ('FATAL: ' + $_.Exception.Message); exit 1 }
L 'start'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$created = $false
$mutex = New-Object System.Threading.Mutex($false, 'Global\\KaguraTrayMutex', [ref]$created)
L ('mutex created=' + $created)
if (-not $created) { L 'another tray alive, exit'; exit }
$exe = ${psQuote(exe)}
$url = ${psQuote(url)}
$logDir = ${psQuote(logDir)}
$port = ${port}
# 安装目录里的 icon.ico（神乐的图标）优先；没有再取 exe 自己的图标
$icoFile = Join-Path (Split-Path $exe) 'icon.ico'
$icon = $null
if (Test-Path $icoFile) { try { $icon = New-Object System.Drawing.Icon($icoFile) } catch { L ('ico err: ' + $_.Exception.Message) } }
if (-not $icon) { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe) }
L ('icon=' + ($null -ne $icon))
if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Application }
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = 'Kagura 语音助手'
$ni.Visible = $true
L 'visible'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('打开管理页面')
$open.add_Click({ Start-Process $url })
$openLog = $menu.Items.Add('打开日志文件夹')
$openLog.add_Click({ Start-Process explorer.exe $logDir })
$restart = $menu.Items.Add('重启服务端')
$restart.add_Click({
  try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/admin/restart" -TimeoutSec 15 | Out-Null; L 'restart requested' } catch { L ('restart failed: ' + $_.Exception.Message) }
})
$quit = $menu.Items.Add('退出')
$quit.add_Click({
  L 'quit clicked'
  try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/admin/quit" -TimeoutSec 10 | Out-Null } catch {}
  $ni.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$ni.ContextMenuStrip = $menu
$ni.add_DoubleClick({ Start-Process $url })
try { $ni.ShowBalloonTip(5000, 'Kagura', '已启动。右键托盘图标可以打开管理页面、重启或退出。', 'Info'); L 'balloon' } catch { L ('balloon err: ' + $_.Exception.Message) }
# 服务端被别的途径关掉（/api/admin/quit、任务管理器）时，图标也别一直挂着
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$script:miss = 0
$timer.add_Tick({
  try { Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$port/api/admin/meta" -TimeoutSec 2 | Out-Null; $script:miss = 0 }
  catch { $script:miss++; L ('meta miss ' + $script:miss); if ($script:miss -ge 3) { L 'server gone, exit'; $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() } }
})
$timer.Start()
L 'run'
[System.Windows.Forms.Application]::Run()
L 'exit'
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
  try {
    // 写成 UTF-16（带 BOM）的 .ps1，再用 Start-Process 起一个独立隐藏进程。
    // 直接把 -EncodedCommand 交给 spawn 时，子进程会在当前会话里被带走/静默退出（实测 code=0 什么都不做）。
    const scriptPath = path.join(logDir, "tray.ps1");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(scriptPath, "\ufeff" + script, "utf16le");
    const cmd = `Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(scriptPath)}) -WindowStyle Hidden`;
    execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], { windowsHide: true, timeout: 15000 });
    console.log("[tray] 托盘图标已启动");
  } catch (e: any) {
    console.log(`[tray] ⚠️  启动托盘失败: ${e.message}`);
  }
}

