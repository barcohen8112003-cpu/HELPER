# Starts the HELPER face service on this PC. Outbound only: it listens on 127.0.0.1.
# The secret is the same PC_BRIDGE_SECRET already in home-relay/pc-bridge.config.json.
# It is passed in the environment of the Python process and is not printed.
param(
    [string]$HelperRoot = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if (-not $HelperRoot) { $HelperRoot = Split-Path $PSScriptRoot -Parent }
$cfgPath = Join-Path $HelperRoot 'home-relay\pc-bridge.config.json'
if (-not (Test-Path $cfgPath)) { throw "Missing $cfgPath. Fill it in before starting the face (same secret as the server)." }
$cfg = Get-Content -Raw -Path $cfgPath | ConvertFrom-Json
$secret = [string]$cfg.secret
if ($secret.Length -lt 16 -or $secret -like '*paste-the-same*') { throw 'pc-bridge.config.json still has no real secret.' }

$state = Join-Path $env:LOCALAPPDATA 'HelperFace'
$localCfgPath = Join-Path $state 'config.json'
$python = $null
$live = $null
if (Test-Path $localCfgPath) {
    $local = Get-Content -Raw -Path $localCfgPath | ConvertFrom-Json
    if ($local.python -and (Test-Path $local.python)) { $python = [string]$local.python }
    if ($local.livetalking) { $live = [string]$local.livetalking }
}
if (-not $python) {
    $candidate = Join-Path $state 'venv\Scripts\python.exe'
    if (Test-Path $candidate) { $python = $candidate } else { $python = 'python' }
}

try {
    $headers = @{ Authorization = "Bearer $secret" }
    $up = Invoke-WebRequest -Uri 'http://127.0.0.1:8771/health' -Headers $headers -UseBasicParsing -TimeoutSec 3
    if ($up.StatusCode -eq 200) {
        Write-Host 'HELPER face is already running on 127.0.0.1:8771'
        exit 0
    }
} catch { }

$env:PC_BRIDGE_SECRET = $secret
$env:HELPER_FACE_STATE = $state
if ($live) { $env:HELPER_LIVETALKING_DIR = $live }
$env:FACE_PYTHON = $python
New-Item -ItemType Directory -Force -Path $state | Out-Null
$script = Join-Path $PSScriptRoot 'pc\helper_face.py'
if (-not (Test-Path $script)) { $script = Join-Path $HelperRoot 'face\pc\helper_face.py' }
Write-Host 'HELPER face listening on 127.0.0.1:8771'
& $python $script
exit $LASTEXITCODE
