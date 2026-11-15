@echo off
rem Visible window for a manual run of the home PC bridge. The usual launch has no window:
rem   powershell -ExecutionPolicy Bypass -File home-relay\install-bridge-service.ps1
rem That task starts at sign-in, in this user's session, and the process reconnects by itself.
rem If this window is open, the background task waits so two bridges are not connected at once.
rem The bridge only dials out; nothing on this PC opens a port. This window starts the process
rem again if it ever exits. Close the window to stop this copy only.
chcp 65001 >nul
cd /d "%~dp0.."
title HELPER - bridge to the cloud

rem Webtop is read through its own signed-in browser window, so that comes up too when a Webtop address is set.
findstr /r /b /c:"WEBTOP_URL=..*" .env >nul 2>&1 && start "" /min cmd /c webtop-browser.bat

:loop
node home-relay\pc-bridge.mjs
echo.
echo The bridge stopped. Starting it again in 15 seconds. Close this window to stop it.
timeout /t 15 /nobreak >nul
goto loop