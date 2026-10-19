@echo off
rem Opens the browser window that stays signed in to Webtop, so the assistant can read it around the clock.
rem Sign in there once, by hand, and leave the window open (minimize it, do not close it).
rem The address comes from WEBTOP_URL in .env. The window uses its own profile, separate from your normal browser.
chcp 65001 >nul
cd /d "%~dp0"
set URL=
set PORT=9223
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"WEBTOP_URL=" .env') do set URL=%%b
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"WEBTOP_DEBUG_PORT=" .env') do if not "%%b"=="" set PORT=%%b
if "%URL%"=="" goto nourl

set BROWSER=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" if "%BROWSER%"=="" set BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" if "%BROWSER%"=="" set BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
if "%BROWSER%"=="" goto nobrowser

rem The debugging port listens on this computer only (127.0.0.1).
start "" "%BROWSER%" --remote-debugging-port=%PORT% --user-data-dir="%~dp0data\webtop-profile" --no-first-run --disable-background-timer-throttling --disable-renderer-backgrounding "%URL%"
exit /b 0

:nourl
echo WEBTOP_URL is empty. Put the Webtop address in .env first, for example WEBTOP_URL=https://...
pause
exit /b 2

:nobrowser
echo Chrome or Edge was not found.
pause
exit /b 2
