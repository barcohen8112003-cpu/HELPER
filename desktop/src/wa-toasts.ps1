# HELPER's ears for WhatsApp Desktop: Windows' own notification list (UserNotificationListener), read every 1.5 s.
# Only WhatsApp's notifications, and only ones that appeared after this started (those already there are skipped).
# One JSON line per event on stdout, read by src/wa-listen.js:
#   {"op":"access","status":"Allowed|Denied|Unspecified|Error"}
#   {"op":"ready"}                                   the notifications already there were skipped
#   {"op":"toast","id":"123","at":1731660000000,"lines":["title","body"],"running":true}
#   {"op":"error","code":"poll"}                     a code only, never text
# Nothing is written to disk and nothing is printed to stderr. Windows asks the owner once ("let HELPER access your
# notifications"); it can be changed later in Settings > Privacy & security > Notifications.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Say($obj) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 4)); [Console]::Out.Flush() }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime]
} catch { Say @{ op = 'access'; status = 'Error' }; exit 2 }

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [Type]$type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait() | Out-Null
  $t.Result
}

$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
$statusType = [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]
$listType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]

function Access() {
  try {
    $s = $listener.GetAccessStatus()
    if ("$s" -eq 'Unspecified') { $s = Await ($listener.RequestAccessAsync()) $statusType }
    return "$s"
  } catch { return 'Error' }
}

# Allowed: wait for it, checking every 10 s (the owner may turn it on in Settings).
$status = Access
Say @{ op = 'access'; status = $status }
while ($status -ne 'Allowed') {
  Start-Sleep -Seconds 10
  try { $now = "$($listener.GetAccessStatus())" } catch { $now = 'Error' }
  if ($now -ne $status) { $status = $now; Say @{ op = 'access'; status = $status } }
}

function IsWhatsApp($n) {
  try {
    $a = $n.AppInfo
    $id = "$($a.AppUserModelId)"
    $name = "$($a.DisplayInfo.DisplayName)"
    return ($id -match 'WhatsApp') -or ($name -match '^WhatsApp')
  } catch { return $false }
}

function Running() {
  try { return [bool](Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'WhatsApp*' } | Select-Object -First 1) } catch { return $false }
}

$seen = New-Object 'System.Collections.Generic.HashSet[uint32]'
$first = $true
$fails = 0
while ($true) {
  try {
    $list = Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $listType
    $fails = 0
    $here = New-Object 'System.Collections.Generic.HashSet[uint32]'
    foreach ($n in $list) {
      $id = [uint32]$n.Id
      [void]$here.Add($id)
      if ($seen.Contains($id)) { continue }
      [void]$seen.Add($id)
      if ($first) { continue }
      if (-not (IsWhatsApp $n)) { continue }
      $lines = @()
      try {
        $b = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
        if ($b) { foreach ($t in $b.GetTextElements()) { $lines += [string]$t.Text } }
      } catch { }
      $at = 0
      try { $at = $n.CreationTime.ToUnixTimeMilliseconds() } catch { }
      Say @{ op = 'toast'; id = [string]$id; at = $at; lines = [string[]]$lines; running = (Running) }
      $lines = $null
    }
    # Dismissed notifications leave the list; their ids are let go, so the set stays small.
    $seen.IntersectWith($here)
    if ($first) { $first = $false; Say @{ op = 'ready' } }
  } catch {
    $fails++
    Say @{ op = 'error'; code = 'poll' }
    if ($fails -ge 20) { exit 3 }
    # Access taken away in Settings: back to waiting for it.
    try { if ("$($listener.GetAccessStatus())" -ne 'Allowed') { Say @{ op = 'access'; status = "$($listener.GetAccessStatus())" }; exit 4 } } catch { }
  }
  Start-Sleep -Milliseconds 1500
}
