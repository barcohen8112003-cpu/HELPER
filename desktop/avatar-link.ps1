# Links the avatar on this PC to HELPER on the cloud, so it can react to messages, tasks and urgent alerts.
# It only saves the panel address and the avatar's own code; it does NOT turn anything on. Turn the avatar and its
# events on from the tray (the avatar submenu), and the avatar events switch on the settings site.
# The code is made on HELPER's settings site, remote panel section, "credential for the desktop avatar". It reads types
# of events only (message / task / alert), never any content, and nothing else on the server.
# ASCII only on purpose: Windows PowerShell 5.1 misreads a script without a BOM that has other letters.
param(
    [string]$Url = 'https://naor-helper.duckdns.org'
)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:APPDATA 'helper-desktop'
$file = Join-Path $dir 'settings.json'
New-Item -ItemType Directory -Force $dir | Out-Null

$Url = $Url.Trim().TrimEnd('/')
if ($Url -notmatch '^https://[A-Za-z0-9.-]+(:\d+)?$') { Write-Host 'The address must be https://host (no path). Nothing changed.'; Read-Host 'Press Enter to close'; exit 1 }
Write-Host "HELPER panel: $Url"
$sec = Read-Host -AsSecureString 'Avatar code (hpn_...)'
$code = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
if ($code -notmatch '^hpn_[0-9a-f]{10}_[A-Za-z0-9_-]{20,}$') { Write-Host 'That does not look like an avatar code (hpn_...). Nothing changed.'; Read-Host 'Press Enter to close'; exit 1 }

# Keep the other settings; change only these two.
$settings = @{}
if (Test-Path $file) {
    try { (Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $settings[$_.Name] = $_.Value } } catch { }
}
$settings['avatarPanelUrl'] = $Url
$settings['avatarCredential'] = $code
$json = $settings | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($file, $json, (New-Object Text.UTF8Encoding $false))

# Is the feed there? Without a cursor the server answers at once and replays nothing.
try {
    Invoke-WebRequest -UseBasicParsing -Uri ($Url + '/panel/api/events') -Headers @{ Authorization = "Bearer $code" } -TimeoutSec 15 | Out-Null
    Write-Host 'Connected.'
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 403) { Write-Host 'Saved. The server says this code may not read events yet: turn on the avatar events switch for it on the settings site.' }
    elseif ($status -eq 404) { Write-Host 'Saved. The events feed is off on the server (PANEL_EVENTS) or not routed yet.' }
    else { Write-Host "Saved. The server did not answer right now ($($_.Exception.Message))." }
}
Write-Host ''
Write-Host 'Done. Turn it on from the HELPER tray icon, avatar submenu.'
Read-Host 'Press Enter to close'
