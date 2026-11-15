# Links HELPER for Windows with iBaila (Glowbeat) on this PC, so iBaila's Govee lamps can answer HELPER.
# It makes one random link code and saves it in two places on this PC only: HELPER's settings (ibailaToken) and
# iBaila's own helper-link.json. The code is never shown. It does NOT turn anything on. After it:
#   1. iBaila tray > HELPER > "Lights follow HELPER"
#   2. HELPER tray > iBaila lights > the first switch
#   3. iBaila tray > Rooms (Govee lamps): "Blink it" on each lamp, then pick its room
# Run it again to make a new code; the old one stops working.
# ASCII only on purpose: Windows PowerShell 5.1 misreads a script without a BOM that has other letters.
param(
    [string]$GlowbeatDir = (Join-Path $env:APPDATA 'glowbeat'),
    [string]$HelperDir = (Join-Path $env:APPDATA 'helper-desktop')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $GlowbeatDir)) {
    Write-Host "iBaila's folder was not found: $GlowbeatDir"
    Write-Host 'Start iBaila once (it makes the folder), or pass -GlowbeatDir. Nothing changed.'
    Read-Host 'Press Enter to close'; exit 1
}
New-Item -ItemType Directory -Force $HelperDir | Out-Null

$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$code = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
$utf8 = New-Object Text.UTF8Encoding $false

# iBaila: its own file, which iBaila only reads (so iBaila saving its settings can never lose the code).
[IO.File]::WriteAllText((Join-Path $GlowbeatDir 'helper-link.json'), ('{"token":"' + $code + '"}'), $utf8)

# HELPER: keep the other settings; change only this one.
$file = Join-Path $HelperDir 'settings.json'
$settings = @{}
if (Test-Path $file) {
    try { (Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $settings[$_.Name] = $_.Value } } catch { }
}
$settings['ibailaToken'] = $code
[IO.File]::WriteAllText($file, ($settings | ConvertTo-Json -Depth 5), $utf8)

# Is iBaila there? Without "Lights follow HELPER" on, it answers 404 on purpose.
try {
    Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:47622/helper/status' -Headers @{ Authorization = "Bearer $code" } -TimeoutSec 5 | Out-Null
    Write-Host 'Linked, and iBaila answers.'
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 404) { Write-Host 'Linked. iBaila is open; turn on "Lights follow HELPER" in its tray (HELPER).' }
    elseif ($status) { Write-Host "Linked. iBaila answered $status." }
    else { Write-Host 'Linked. iBaila is not open right now; that is fine.' }
}
Write-Host ''
Write-Host 'Done. Next: iBaila tray > HELPER > Lights follow HELPER, then HELPER tray > iBaila lights.'
Read-Host 'Press Enter to close'
