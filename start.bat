@echo off
chcp 65001 > nul
echo 启动 Kagura Voice 服务...
echo.

:: 新窗口启动 UDP 发现中继（PowerShell，无需安装 Python）
start "Kagura Discovery" powershell -ExecutionPolicy Bypass -File "%~dp0discovery_relay.ps1"

:: 在 WSL 中启动语音服务端
wsl -e bash -c "cd /home/user/kagura-voice && python3 voice_server.py"
