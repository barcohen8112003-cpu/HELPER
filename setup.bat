@echo off
rem Double-click: HELPER's setup wizard (Node.js and Git are installed first when missing).
rem install.ps1 is read as UTF-8 here, the same way irm | iex gets it, so its Hebrew shows right.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((Get-Content -Raw -Encoding UTF8 '%~dp0install.ps1'))) -Here '%~dp0' %*"
echo.
pause
