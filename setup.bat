@echo off
rem Double-click: HELPER's setup wizard (Node.js and Git are installed first when missing).
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
