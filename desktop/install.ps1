# Puts HELPER for Windows in the Start menu and on the desktop, and starts it. It starts with Windows from then on
# (switch that off in its tray menu). Run from this folder: powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = Join-Path $here 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
    Write-Host 'Installing the app''s parts (npm)...'
    Push-Location $here
    npm install
    npm approve-scripts electron koffi uiohook-napi
    npm rebuild electron koffi uiohook-napi
    Pop-Location
}
$speech = Join-Path $here 'vendor\whisper\Release\whisper-server.exe'
if (-not (Test-Path $speech)) {
    Write-Host 'Note: the speech engine is not in vendor\ yet; typing works, talking needs it (see README).'
}

$shell = New-Object -ComObject WScript.Shell
$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'HELPER.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'HELPER.lnk')
)
foreach ($t in $targets) {
    $s = $shell.CreateShortcut($t)
    $s.TargetPath = $electron
    $s.Arguments = '"' + $here + '"'
    $s.WorkingDirectory = $here
    $s.IconLocation = (Join-Path $here 'ui\icon.ico')
    $s.Description = 'HELPER: hold Ctrl+Alt+Space and talk'
    $s.Save()
}
Write-Host 'Shortcuts: Start menu and desktop ("HELPER").'
Start-Process -FilePath $electron -ArgumentList ('"' + $here + '"') -WorkingDirectory $here
Write-Host 'HELPER is running: its icon is next to the clock. Hold Ctrl+Alt+Space and talk.'
