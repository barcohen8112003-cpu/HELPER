# Installs the HELPER face on this Windows PC (RTX GPU). Run from PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File .\face\install-face.ps1
#   powershell -ExecutionPolicy Bypass -File .\face\install-face.ps1 -Autostart
#
# The service listens on 127.0.0.1 only and uses the secret already in
# home-relay\pc-bridge.config.json. It does not open a port on the router or on the VPS.
# LiveTalking (Apache-2.0) is cloned for the GPU render. The portrait is HELPER's own
# illustration. Model weights are not fetched from a third-party URL: the script prints
# the links published by LiveTalking and waits until models\wav2lip.pth is in place.
param(
    [switch]$Autostart,
    [string]$HelperRoot = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Say([string]$Text) { Write-Host $Text }

if (-not $HelperRoot) {
    $HelperRoot = Split-Path $PSScriptRoot -Parent
}
if (-not (Test-Path (Join-Path $HelperRoot 'src\face-avatar.png'))) {
    throw "HELPER was not found next to this script ($HelperRoot)."
}

$state = Join-Path $env:LOCALAPPDATA 'HelperFace'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$live = Join-Path $state 'LiveTalking'
$venv = Join-Path $state 'venv'
$py = Join-Path $venv 'Scripts\python.exe'

Say 'HELPER face: checking Python, Git and the bridge config.'
$cfgPath = Join-Path $HelperRoot 'home-relay\pc-bridge.config.json'
if (-not (Test-Path $cfgPath)) {
    Say 'Create home-relay\pc-bridge.config.json first (see pc-bridge.config.example.json). The face uses that same secret and does not invent a new one.'
    throw 'missing pc-bridge.config.json'
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Say 'Installing Git...'
    winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements
}
$pythonLauncher = $null
foreach ($cand in @(
        "$env:LocalAppData\Programs\Python\Python312\python.exe",
        "$env:LocalAppData\Programs\Python\Python311\python.exe"
    )) {
    if (Test-Path $cand) { $pythonLauncher = $cand; break }
}
if (-not $pythonLauncher) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $pythonLauncher = $cmd.Source }
}
if (-not $pythonLauncher) {
    Say 'Installing Python 3.12...'
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    $pythonLauncher = "$env:LocalAppData\Programs\Python\Python312\python.exe"
}
if (-not (Test-Path $pythonLauncher)) { throw 'Python was not found after install. Open a new PowerShell window and run this script again.' }

if (-not (Test-Path $py)) {
    Say 'Creating the face virtualenv...'
    & $pythonLauncher -m venv $venv
}
& $py -m pip install --upgrade pip
& $py -m pip install -r (Join-Path $HelperRoot 'face\pc\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'pip install pillow failed' }

if (-not (Test-Path (Join-Path $live 'app.py'))) {
    Say 'Cloning LiveTalking (Apache-2.0)...'
    git clone --depth 1 https://github.com/lipku/LiveTalking.git $live
} else {
    Say 'LiveTalking is already cloned.'
}

Say 'Preparing the HELPER portrait (original illustration, not a photo of a person)...'
& $py (Join-Path $HelperRoot 'face\pc\prepare_avatar.py') `
    --livetalking $live `
    --png (Join-Path $HelperRoot 'src\face-avatar.png') `
    --box (Join-Path $HelperRoot 'face\avatar\box.json')
if ($LASTEXITCODE -ne 0) { Say 'The portrait folder was not written. The browser face still works. Re-run this script after Pillow is installed.' }

Say 'Installing PyTorch for CUDA 12.8 (this is a large download). If it fails, the browser face still works.'
& $py -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
if ($LASTEXITCODE -ne 0) {
    Say 'PyTorch did not install. Check nvidia-smi and https://pytorch.org/get-started/previous-versions/ then re-run this script.'
} else {
    $req = Join-Path $live 'requirements.txt'
    if (Test-Path $req) {
        Say 'Installing LiveTalking requirements...'
        & $py -m pip install -r $req
        if ($LASTEXITCODE -ne 0) { Say 'Some LiveTalking packages failed. /health will say the engine is unavailable until they install.' }
    }
}

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    Say 'ffmpeg was not found. The GPU face needs it to convert ElevenLabs audio. Installing via winget...'
    winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
    Say 'If ffmpeg is still not on PATH, open a new PowerShell window before the next start.'
}

@{
    python = $py
    livetalking = $live
    helper = $HelperRoot
} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $state 'config.json')

try {
    foreach ($port in 8010, 8771) {
        $name = "HELPER face block TCP $port"
        $existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
        if (-not $existing) {
            New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Block -Protocol TCP -LocalPort $port -Profile Any | Out-Null
        }
    }
    Say 'Inbound TCP 8010 and 8771 are blocked. The service still answers on 127.0.0.1. Do not forward those ports.'
} catch {
    Say 'Could not add a firewall rule (not running as Administrator). The service still binds 127.0.0.1 only. Do not forward 8010 or 8771.'
}

$model = Join-Path $live 'models\wav2lip.pth'
if (-not (Test-Path $model)) {
    Say ''
    Say 'The wav2lip weights are not in the repo (they are large, and HELPER does not download them from a random link).'
    Say 'From LiveTalking docs, download wav2lip256.pth and s3fd.pth, then:'
    Say "  copy wav2lip256.pth to $model"
    Say "  copy s3fd.pth to $(Join-Path $live 'wav2lip\face_detection\detection\sfd\s3fd.pth')"
    Say 'Links published by the project: https://github.com/lipku/LiveTalking/blob/main/README-EN.md'
    Say 'Until that file exists, HELPER draws the face in the browser. Nothing else breaks.'
}

if ($Autostart) {
    try {
        $start = Join-Path $HelperRoot 'face\start-face.ps1'
        $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$start`""
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        Register-ScheduledTask -TaskName 'HELPER Face' -Action $action -Trigger $trigger -Force | Out-Null
        Say 'Scheduled task "HELPER Face" will start the service at logon.'
    } catch {
        Say 'Could not register the logon task. Start it yourself with face\start-face.ps1, or re-run this script as the same Windows user from an elevated PowerShell.'
    }
}

Say ''
Say 'Start it now with:  powershell -ExecutionPolicy Bypass -File .\face\start-face.ps1'
Say 'On the server, set FACE_ENABLED=on (default is off) and restart HELPER. Open /face on the TV, phone or settings site.'
Say 'If this PC is off or the model is missing, that page draws the face itself.'
