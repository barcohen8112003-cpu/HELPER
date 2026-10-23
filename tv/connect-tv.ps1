# Connects the HELPER home screen on the TV to a HELPER server (the cloud one by default).
# The bridge token is typed here, in your own window, and goes only to the TV over adb.
# Find it on HELPER's settings site, next to the app QR code ("show"). Needs adb connected to the TV.
param(
    [string]$Url = 'http://37.60.240.231:3210'
)
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$tv = (& $adb devices | Select-String '\tdevice$' | Select-Object -First 1).ToString().Split("`t")[0]
if (-not $tv) { Write-Host 'No TV connected over adb. Turn on Wireless debugging on the TV and connect first.'; exit 1 }
Write-Host "TV: $tv"
Write-Host "HELPER: $Url"
$sec = Read-Host -AsSecureString 'HELPER access code (bridge token)'
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
if (-not $token) { Write-Host 'No code typed, nothing changed.'; exit 1 }
& $adb -s $tv shell am broadcast -a com.gathin.tvhome.HELPER_SETUP -n com.gathin.tvhome/.HelperSetupReceiver --es url $Url --es token $token
Write-Host ''
Write-Host 'Done. Go back to Claude and say "connected".'
Read-Host 'Press Enter to close'
