@echo off
rem Double-click to run the assistant. It is restarted if it crashes, but a crash loop ends quietly:
rem more than three crashes with no healthy run in between, and this window stops with an error code.
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules call npm install
set fails=0

:loop
node src/index.js
rem Exit code 2 = needs you (missing setup, QR not scanned, already running). No point restarting.
if %errorlevel%==2 (
  pause
  exit /b 2
)
rem Exit code 3 = restart asked for from the settings site. Go again right away.
if %errorlevel%==3 goto loop
rem The assistant writes data\healthy after five minutes of running, so a crash after a good run starts the count over.
if exist data\healthy (
  set fails=0
  del data\healthy >nul 2>&1
)
set /a fails+=1
if %fails% gtr 3 (
  echo.
  echo The assistant crashed %fails% times in a row. Stopping. The error is above.
  echo %date% %time% crash loop: stopped after %fails% crashes>> data\crash.log
  pause
  exit /b 1
)
echo.
echo Crashed. Restarting in 10 seconds ^(attempt %fails% of 3^). Close this window to stop.
timeout /t 10 /nobreak >nul
goto loop
