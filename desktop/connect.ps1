# Connects HELPER for Windows to HELPER on the cloud (memory, WhatsApp, mail, calendar, and its voice).
# The bridge token is typed here, in your own window, and is kept only in this PC's HELPER settings.
# Find it on HELPER's settings site, next to the app QR code ("show").
param(
    [string]$Url = 'http://37.60.240.231:3210'
)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:APPDATA 'helper-desktop'
$file = Join-Path $dir 'settings.json'
New-Item -ItemType Directory -Force $dir | Out-Null

Write-Host "HELPER on the cloud: $Url"
$sec = Read-Host -AsSecureString 'HELPER access code (bridge token)'
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
if (-not $token) { Write-Host 'No code typed, nothing changed.'; Read-Host 'Press Enter to close'; exit 1 }
# The bridge token is hex. Anything else was pasted by mistake (a label, the masked dots).
if ($token -notmatch '^[A-Za-z0-9_-]{16,128}$') { Write-Host 'That does not look like the access code (letters and digits only). Nothing changed.'; Read-Host 'Press Enter to close'; exit 1 }

# Keep the other settings; change only these two.
$settings = @{}
if (Test-Path $file) {
    try { (Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $settings[$_.Name] = $_.Value } } catch { }
}
$settings['helperUrl'] = $Url
$settings['helperToken'] = $token
$json = $settings | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($file, $json, (New-Object Text.UTF8Encoding $false))

# Is the server there? (An empty ask is refused without costing anything.)
try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($Url.TrimEnd('/') + '/bridge/ask') -ContentType 'application/json' `
        -Headers @{ Authorization = "Bearer $token" } -Body '{"text":""}' -TimeoutSec 15
    Write-Host 'Connected.'
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 400) { Write-Host 'Connected.' }
    elseif ($code -eq 403) { Write-Host 'The server says the code is wrong. Saved anyway; run this again with the right code.' }
    else { Write-Host "Saved. The server did not answer right now ($($_.Exception.Message))." }
}
Write-Host ''
Write-Host 'Done. HELPER for Windows uses it from the next ask, no restart needed.'
Read-Host 'Press Enter to close'
