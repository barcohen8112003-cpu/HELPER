# One-time opt-in: lets Helper run commands as Administrator, each one only after the owner's yes in the chat.
# Run in PowerShell opened with "Run as administrator", from the HELPER folder:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\helper-admin-setup.ps1
# To undo everything it set up:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\helper-admin-setup.ps1 -Remove
# What it does: copies the runner into %ProgramData%\HelperAdmin (only Administrators and SYSTEM may change it), gives
# the given user write access to the inbox folder only, and registers the "Helper Admin Runner" task with highest
# privileges for that user. Note: any program running as that user can drop a request there too, which is how
# Windows treats an administrator's own account anyway (UAC is not a security boundary). Use -Remove to turn it off.
param([switch]$Remove, [string]$User = "$env:USERDOMAIN\$env:USERNAME")
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Run this from PowerShell opened as Administrator.'; exit 1 }
$task = 'Helper Admin Runner'
$base = Join-Path $env:ProgramData 'HelperAdmin'
$inbox = Join-Path $base 'inbox'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Removed: Helper can no longer run commands as Administrator.'
  exit 0
}
New-Item -ItemType Directory -Force -Path $inbox | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'helper-admin-runner.ps1') -Destination (Join-Path $base 'runner.ps1') -Force
# Administrators and SYSTEM: full. Everyone else: read only. Then the one user may write in the inbox only.
& icacls.exe $base /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
& icacls.exe $inbox /grant "${User}:(OI)(CI)M" | Out-Null
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$base\runner.ps1`""
$who = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $task -Action $action -Principal $who -Settings $settings -Force | Out-Null
Write-Host "Done: Helper can run commands as Administrator for $User, each one only after your yes. Undo with -Remove."
