@echo off
setlocal
set "ROOT=%~dp0"

start "Agent Flow bridge" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File "%ROOT%scripts\connect-hosted.ps1"
start "Agent Flow Office" "https://launcher.104-248-32-222.sslip.io/agent-flow/"

endlocal

