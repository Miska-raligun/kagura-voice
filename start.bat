@echo off
chcp 65001 > nul
echo 启动 Kagura Voice 服务...
echo.

:: 新窗口启动 UDP 发现中继（Windows 侧，用 Windows Python）
start "Kagura Discovery" cmd /k "python %~dp0discovery_relay.py"

:: 在 WSL 中启动语音服务端
wsl -e bash -c "cd /home/user/kagura-voice && python3 voice_server.py"
