@echo off
rem Starts the bridge between this PC and HELPER in the cloud. A shortcut in the Windows Startup folder runs it at
rem sign-in. The bridge only dials out; nothing on this PC opens a port. It reconnects by itself when the network
rem drops, and this window starts it again if it ever exits. Close the window to stop it.
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