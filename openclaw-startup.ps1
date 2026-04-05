# openclaw-startup.ps1
# OpenClaw one-click start/stop script
# Usage:
#   Start: powershell -ExecutionPolicy Bypass -File openclaw-startup.ps1
#   Stop:  powershell -ExecutionPolicy Bypass -File openclaw-startup.ps1 -Stop
#   Requires admin privileges (will auto-elevate via UAC)

param(
    [switch]$Stop
)

# ============================================================
# Admin check and UAC elevation
# ============================================================
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '[WARN] Admin privileges required, requesting UAC elevation...' -ForegroundColor Yellow
    $argList = "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
    if ($Stop) { $argList += " -Stop" }
    Start-Process powershell -Verb RunAs -ArgumentList $argList
    exit
}

# ============================================================
# Configuration
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
# Get WSL IP
# ============================================================
function Get-WslIp {
    $raw = (wsl hostname -I 2>$null)
    if ($raw) {
        $ip = ($raw.Trim() -split '\s+')[0]
        if ($ip) { return $ip }
    }
    Write-Host '[FAIL] Cannot get WSL IP. Make sure WSL is running.' -ForegroundColor Red
    pause
    exit 1
}

# ============================================================
# Helper: check if process command line contains keyword
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
# Stop mode
# ============================================================
if ($Stop) {
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host '  OpenClaw Stop' -ForegroundColor Cyan
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host ''

    Write-Host '[*] Removing port proxy rules...' -ForegroundColor Yellow
    netsh interface portproxy delete v4tov4 listenport=$GatewayPort listenaddress=0.0.0.0 2>$null
    netsh interface portproxy delete v4tov4 listenport=$VoicePort listenaddress=0.0.0.0 2>$null
    netsh interface portproxy delete v4tov4 listenport=$CdpPort listenaddress=0.0.0.0 2>$null
    netsh interface portproxy delete v4tov4 listenport=$MqttPort listenaddress=0.0.0.0 2>$null

    Write-Host '[*] Stopping Chrome debug instance...' -ForegroundColor Yellow
    Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { Test-ProcessCmd $_ 'ChromeDebug' } | Stop-Process -Force -ErrorAction SilentlyContinue

    Write-Host '[*] Stopping Discovery Relay...' -ForegroundColor Yellow
    Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'Kagura Discovery' } | Stop-Process -Force -ErrorAction SilentlyContinue

    Write-Host '[*] Removing firewall rules...' -ForegroundColor Yellow
    Remove-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName $FirewallRuleUdp -ErrorAction SilentlyContinue

    Write-Host ''
    Write-Host '[OK] All services stopped.' -ForegroundColor Green
    Write-Host ''
    pause
    exit
}

# ============================================================
# Start mode
# ============================================================
Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  OpenClaw Start' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''

$WslIp = Get-WslIp
Write-Host "[OK] WSL IP: $WslIp" -ForegroundColor Green

# ------------------------------------------------------------
# 1. Port proxy (netsh portproxy)
# ------------------------------------------------------------
Write-Host ''
Write-Host '[1/4] Configuring port proxy...' -ForegroundColor Yellow

netsh interface portproxy delete v4tov4 listenport=$GatewayPort listenaddress=0.0.0.0 2>$null
netsh interface portproxy delete v4tov4 listenport=$VoicePort listenaddress=0.0.0.0 2>$null
netsh interface portproxy delete v4tov4 listenport=$CdpPort listenaddress=0.0.0.0 2>$null
netsh interface portproxy delete v4tov4 listenport=$MqttPort listenaddress=0.0.0.0 2>$null

# Gateway: external -> WSL
netsh interface portproxy add v4tov4 listenport=$GatewayPort listenaddress=0.0.0.0 connectport=$GatewayPort connectaddress=$WslIp
Write-Host "  Gateway : 0.0.0.0:$GatewayPort -> ${WslIp}:$GatewayPort" -ForegroundColor Gray

# Voice Server: CoreS3 -> WSL
netsh interface portproxy add v4tov4 listenport=$VoicePort listenaddress=0.0.0.0 connectport=$VoicePort connectaddress=$WslIp
Write-Host "  Voice   : 0.0.0.0:$VoicePort -> ${WslIp}:$VoicePort" -ForegroundColor Gray

# MQTT Broker: CoreS3 -> WSL mosquitto
netsh interface portproxy add v4tov4 listenport=$MqttPort listenaddress=0.0.0.0 connectport=$MqttPort connectaddress=$WslIp
Write-Host "  MQTT    : 0.0.0.0:$MqttPort -> ${WslIp}:$MqttPort" -ForegroundColor Gray

# Chrome CDP: WSL -> Windows Chrome
netsh interface portproxy add v4tov4 listenport=$CdpPort listenaddress=0.0.0.0 connectport=$CdpPort connectaddress=127.0.0.1
Write-Host "  CDP     : 0.0.0.0:$CdpPort -> 127.0.0.1:$CdpPort" -ForegroundColor Gray

Write-Host '[OK] Port proxy configured.' -ForegroundColor Green

# ------------------------------------------------------------
# 2. Firewall rules
# ------------------------------------------------------------
Write-Host ''
Write-Host '[2/4] Configuring firewall rules...' -ForegroundColor Yellow

Remove-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName $FirewallRuleUdp -ErrorAction SilentlyContinue

New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $GatewayPort,$VoicePort,$MqttPort,$CdpPort -Profile Any -ErrorAction SilentlyContinue | Out-Null
New-NetFirewallRule -DisplayName $FirewallRuleUdp -Direction Inbound -Action Allow -Protocol UDP -LocalPort $DiscoveryPort -Profile Any -ErrorAction SilentlyContinue | Out-Null

Write-Host '[OK] Firewall rules added.' -ForegroundColor Green

# ------------------------------------------------------------
# 3. Launch Chrome in debug mode
# ------------------------------------------------------------
Write-Host ''
Write-Host "[3/4] Starting Chrome (remote-debugging-port=$CdpPort)..." -ForegroundColor Yellow

$chromeRunning = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { Test-ProcessCmd $_ 'ChromeDebug' }

if ($chromeRunning) {
    Write-Host '[OK] Chrome debug instance already running.' -ForegroundColor Green
} elseif (Test-Path $ChromePath) {
    Start-Process $ChromePath -ArgumentList "--remote-debugging-port=$CdpPort --remote-debugging-address=0.0.0.0 --remote-allow-origins=* --user-data-dir=$ChromeDataDir"
    Start-Sleep -Seconds 2
    Write-Host '[OK] Chrome started.' -ForegroundColor Green
} else {
    Write-Host '[WARN] Chrome not found. Update $ChromePath in script.' -ForegroundColor Red
}

# ------------------------------------------------------------
# 4. UDP Discovery Relay
# ------------------------------------------------------------
Write-Host ''
Write-Host "[4/4] Starting UDP Discovery Relay (port $DiscoveryPort)..." -ForegroundColor Yellow

$discoveryRunning = Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'Kagura Discovery' }

if ($discoveryRunning) {
    Write-Host '[OK] Discovery Relay already running.' -ForegroundColor Green
} else {
    $scriptPath = $null
    if (Test-Path $DiscoveryScript) { $scriptPath = $DiscoveryScript }
    elseif (Test-Path $DiscoveryScript2) { $scriptPath = $DiscoveryScript2 }

    if ($scriptPath) {
        Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -NoExit -Command `"& { `$host.UI.RawUI.WindowTitle = 'Kagura Discovery'; & '$scriptPath' }`""
        Write-Host '[OK] Discovery Relay started (new window).' -ForegroundColor Green
    } else {
        Write-Host '[WARN] discovery_relay.ps1 not found. Start it manually.' -ForegroundColor Red
    }
}

# ============================================================
# Summary
# ============================================================
Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  Summary' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "  WSL IP       : $WslIp" -ForegroundColor White
Write-Host "  Gateway      : 0.0.0.0:$GatewayPort -> WSL" -ForegroundColor White
Write-Host "  Voice Server : 0.0.0.0:$VoicePort -> WSL" -ForegroundColor White
Write-Host "  MQTT Broker  : 0.0.0.0:$MqttPort -> WSL" -ForegroundColor White
Write-Host "  Chrome CDP   : 0.0.0.0:$CdpPort -> 127.0.0.1" -ForegroundColor White
Write-Host "  Discovery    : UDP :$DiscoveryPort" -ForegroundColor White
Write-Host ''
Write-Host '  Current portproxy rules:' -ForegroundColor Gray
netsh interface portproxy show v4tov4
Write-Host ''

# Verify Chrome CDP
Write-Host '  Checking Chrome CDP...' -ForegroundColor Gray
try {
    $null = Invoke-WebRequest -Uri "http://localhost:$CdpPort/json" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    Write-Host '  [OK] Chrome CDP accessible.' -ForegroundColor Green
} catch {
    Write-Host '  [WARN] Chrome CDP not yet accessible (may still be starting).' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Tips:' -ForegroundColor DarkGray
Write-Host '  Access Chrome CDP from WSL: curl http://<Windows_Host_IP>:9222/json' -ForegroundColor DarkGray
Write-Host '  Stop all services: openclaw-startup.ps1 -Stop' -ForegroundColor DarkGray
Write-Host ''
pause
