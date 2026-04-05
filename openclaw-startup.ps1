# openclaw-startup.ps1
# OpenClaw Windows 一键启动/停止脚本
# 用法：
#   启动：  powershell -ExecutionPolicy Bypass -File openclaw-startup.ps1
#   停止：  powershell -ExecutionPolicy Bypass -File openclaw-startup.ps1 -Stop
#   需要管理员权限（会自动 UAC 提升）

param(
    [switch]$Stop
)

# ============================================================
# 管理员权限检测与提升
# ============================================================
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '[WARN] 需要管理员权限，正在请求 UAC 提升...' -ForegroundColor Yellow
    $argList = "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
    if ($Stop) { $argList += " -Stop" }
    Start-Process powershell -Verb RunAs -ArgumentList $argList
    exit
}

# ============================================================
# 配置
# ============================================================
$ChromePath       = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ChromeDataDir    = "C:\ChromeDebug"
$CdpPort          = 9222
$GatewayPort      = 18789
$VoicePort        = 5000
$MqttPort         = 1883
$DiscoveryPort    = 5001
$DiscoveryScript  = "C:\code\kagura-voice\discovery_relay.ps1"
$DiscoveryScript2 = "C:\code\kagura-voice\discovery_relay.ps1"
$FirewallRuleName = "OpenClaw Services"
$FirewallRuleUdp  = "OpenClaw Services (UDP)"

# ============================================================
# 获取 WSL IP
# ============================================================
function Get-WslIp {
    $raw = (wsl hostname -I 2>$null)
    if ($raw) {
        $ip = ($raw.Trim() -split '\s+')[0]
        if ($ip) { return $ip }
    }
    Write-Host '[FAIL] 无法获取 WSL IP，请确认 WSL 正在运行' -ForegroundColor Red
    pause
    exit 1
}

# ============================================================
# 辅助：检测进程命令行是否包含关键字
# ============================================================
function Test-ProcessCmd($proc, $keyword) {
    try {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction Stop).CommandLine
        return ($cmd -match $keyword)
    } catch {
        return $false
    }
}

# ============================================================
# 停止模式
# ============================================================
if ($Stop) {
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host '  OpenClaw 服务停止' -ForegroundColor Cyan
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host ''

    # 清理 portproxy 规则
    Write-Host '[*] 清理端口转发规则...' -ForegroundColor Yellow
    netsh interface portproxy delete v4tov4 listenport=$GatewayPort listenaddress=0.0.0.0 2>$null
    netsh interface portproxy delete v4tov4 listenport=$VoicePort listenaddress=0.0.0.0 2>$null
    netsh interface portproxy delete v4tov4 listenport=$CdpPort listenaddress=0.0.0.0 2>$null
    netsh interface portproxy delete v4tov4 listenport=$MqttPort listenaddress=0.0.0.0 2>$null

    # 关闭 Chrome debug 实例
    Write-Host '[*] 关闭 Chrome debug 实例...' -ForegroundColor Yellow
    Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { Test-ProcessCmd $_ 'ChromeDebug' } | Stop-Process -Force -ErrorAction SilentlyContinue

    # 停止 discovery relay
    Write-Host '[*] 停止 Discovery Relay...' -ForegroundColor Yellow
    Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'Kagura Discovery' } | Stop-Process -Force -ErrorAction SilentlyContinue

    # 删除防火墙规则
    Write-Host '[*] 清理防火墙规则...' -ForegroundColor Yellow
    Remove-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName $FirewallRuleUdp -ErrorAction SilentlyContinue

    Write-Host ''
    Write-Host '[OK] 所有服务已停止' -ForegroundColor Green
    Write-Host ''
    pause
    exit
}

# ============================================================
# 启动模式
# ============================================================
Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  OpenClaw 一键启动' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''

$WslIp = Get-WslIp
Write-Host "[OK] WSL IP: $WslIp" -ForegroundColor Green

# ------------------------------------------------------------
# 1. 端口转发 (netsh portproxy)
# ------------------------------------------------------------
Write-Host ''
Write-Host '[1/4] 配置端口转发...' -ForegroundColor Yellow

# 清理旧规则
netsh interface portproxy delete v4tov4 listenport=$GatewayPort listenaddress=0.0.0.0 2>$null
netsh interface portproxy delete v4tov4 listenport=$VoicePort listenaddress=0.0.0.0 2>$null
netsh interface portproxy delete v4tov4 listenport=$CdpPort listenaddress=0.0.0.0 2>$null
netsh interface portproxy delete v4tov4 listenport=$MqttPort listenaddress=0.0.0.0 2>$null

# Gateway: 外部/本机 -> WSL (webchat 客户端访问)
netsh interface portproxy add v4tov4 listenport=$GatewayPort listenaddress=0.0.0.0 connectport=$GatewayPort connectaddress=$WslIp
Write-Host "  Gateway : 0.0.0.0:$GatewayPort -> ${WslIp}:$GatewayPort" -ForegroundColor Gray

# Voice Server: 外部设备(CoreS3) -> WSL
netsh interface portproxy add v4tov4 listenport=$VoicePort listenaddress=0.0.0.0 connectport=$VoicePort connectaddress=$WslIp
Write-Host "  Voice   : 0.0.0.0:$VoicePort -> ${WslIp}:$VoicePort" -ForegroundColor Gray

# MQTT Broker: 外部设备(CoreS3) -> WSL mosquitto
netsh interface portproxy add v4tov4 listenport=$MqttPort listenaddress=0.0.0.0 connectport=$MqttPort connectaddress=$WslIp
Write-Host "  MQTT    : 0.0.0.0:$MqttPort -> ${WslIp}:$MqttPort" -ForegroundColor Gray

# Chrome CDP: WSL -> Windows Chrome (WSL 通过 Windows host IP 访问)
netsh interface portproxy add v4tov4 listenport=$CdpPort listenaddress=0.0.0.0 connectport=$CdpPort connectaddress=127.0.0.1
Write-Host "  CDP     : 0.0.0.0:$CdpPort -> 127.0.0.1:$CdpPort" -ForegroundColor Gray

Write-Host '[OK] 端口转发已配置' -ForegroundColor Green

# ------------------------------------------------------------
# 2. 防火墙规则
# ------------------------------------------------------------
Write-Host ''
Write-Host '[2/4] 配置防火墙规则...' -ForegroundColor Yellow

Remove-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName $FirewallRuleUdp -ErrorAction SilentlyContinue

New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $GatewayPort,$VoicePort,$MqttPort,$CdpPort -Profile Any -ErrorAction SilentlyContinue | Out-Null
New-NetFirewallRule -DisplayName $FirewallRuleUdp -Direction Inbound -Action Allow -Protocol UDP -LocalPort $DiscoveryPort -Profile Any -ErrorAction SilentlyContinue | Out-Null

Write-Host '[OK] 防火墙规则已添加' -ForegroundColor Green

# ------------------------------------------------------------
# 3. 启动 Chrome debugger 模式
# ------------------------------------------------------------
Write-Host ''
Write-Host "[3/4] 启动 Chrome (remote-debugging-port=$CdpPort)..." -ForegroundColor Yellow

$chromeRunning = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { Test-ProcessCmd $_ 'ChromeDebug' }

if ($chromeRunning) {
    Write-Host '[OK] Chrome debug 实例已在运行' -ForegroundColor Green
} elseif (Test-Path $ChromePath) {
    Start-Process $ChromePath -ArgumentList "--remote-debugging-port=$CdpPort --remote-debugging-address=0.0.0.0 --remote-allow-origins=* --user-data-dir=$ChromeDataDir"
    Start-Sleep -Seconds 2
    Write-Host '[OK] Chrome 已启动' -ForegroundColor Green
} else {
    Write-Host '[WARN] 未找到 Chrome，请修改脚本中的 $ChromePath' -ForegroundColor Red
}

# ------------------------------------------------------------
# 4. UDP Discovery Relay
# ------------------------------------------------------------
Write-Host ''
Write-Host "[4/4] 启动 UDP Discovery Relay (port $DiscoveryPort)..." -ForegroundColor Yellow

$discoveryRunning = Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'Kagura Discovery' }

if ($discoveryRunning) {
    Write-Host '[OK] Discovery Relay 已在运行' -ForegroundColor Green
} else {
    $scriptPath = $null
    if (Test-Path $DiscoveryScript) { $scriptPath = $DiscoveryScript }
    elseif (Test-Path $DiscoveryScript2) { $scriptPath = $DiscoveryScript2 }

    if ($scriptPath) {
        Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -NoExit -Command `"& { `$host.UI.RawUI.WindowTitle = 'Kagura Discovery'; & '$scriptPath' }`""
        Write-Host '[OK] Discovery Relay 已启动 (新窗口)' -ForegroundColor Green
    } else {
        Write-Host '[WARN] 未找到 discovery_relay.ps1，请手动启动' -ForegroundColor Red
    }
}

# ============================================================
# 状态摘要
# ============================================================
Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  状态摘要' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "  WSL IP       : $WslIp" -ForegroundColor White
Write-Host "  Gateway      : 0.0.0.0:$GatewayPort -> WSL" -ForegroundColor White
Write-Host "  Voice Server : 0.0.0.0:$VoicePort -> WSL" -ForegroundColor White
Write-Host "  MQTT Broker  : 0.0.0.0:$MqttPort -> WSL" -ForegroundColor White
Write-Host "  Chrome CDP   : 0.0.0.0:$CdpPort -> 127.0.0.1 (WSL 通过 host IP 访问)" -ForegroundColor White
Write-Host "  Discovery    : UDP :$DiscoveryPort" -ForegroundColor White
Write-Host ''
Write-Host '  portproxy 当前规则:' -ForegroundColor Gray
netsh interface portproxy show v4tov4
Write-Host ''

# 验证 Chrome CDP
Write-Host '  验证 Chrome CDP...' -ForegroundColor Gray
try {
    $null = Invoke-WebRequest -Uri "http://localhost:$CdpPort/json" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    Write-Host '  [OK] Chrome CDP 可访问' -ForegroundColor Green
} catch {
    Write-Host '  [WARN] Chrome CDP 暂不可访问（Chrome 可能还在启动）' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '提示：' -ForegroundColor DarkGray
Write-Host '  WSL 中访问 Chrome CDP: curl http://<Windows_Host_IP>:9222/json' -ForegroundColor DarkGray
Write-Host '  停止所有服务: openclaw-startup.ps1 -Stop' -ForegroundColor DarkGray
Write-Host ''
pause
