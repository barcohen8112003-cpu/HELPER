# One-off probe: what WhatsApp Desktop's Windows notifications LOOK like on this PC, without their text.
# For each new WhatsApp notification it prints only its shape: the app id, how many text lines, each line's length,
# whether it has Hebrew, what kind of character it starts with, and whether a view-once / disappearing / media / call
# word appears. Never the text, never a name. Nothing is written to disk.
# Use: send yourself test messages (plain, group, photo, view-once, disappearing), run this for a few minutes:
#   powershell -NoProfile -ExecutionPolicy Bypass -STA -File desktop\test\wa-toast-shape.ps1 -Minutes 5
# Ctrl+C stops it. The first run may show Windows' "let it access your notifications" question.
param([int]$Minutes = 5)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait() | Out-Null; $t.Result }

$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
$status = "$($listener.GetAccessStatus())"
if ($status -eq 'Unspecified') {
  try { $status = "$(Await ($listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]))" } catch { $status = 'Error: ' + $_.Exception.HResult }
}
Write-Output "access: $status  (packaged: no, PowerShell $($PSVersionTable.PSVersion))"
if ($status -ne 'Allowed') { Write-Output 'No access: this is the answer to D5 (Windows needs identity or Settings > Privacy > Notifications).'; exit 0 }

function Kind($s) {
  if (-not $s) { return 'empty' }
  $c = [int][char]$s[0]
  if ($c -ge 0x0590 -and $c -le 0x05FF) { return 'hebrew' }
  if (($c -ge 0x41 -and $c -le 0x5A) -or ($c -ge 0x61 -and $c -le 0x7A)) { return 'latin' }
  if ($c -ge 0x30 -and $c -le 0x39) { return 'digit' }
  if ($c -ge 0xD800 -and $c -le 0xDBFF) { return 'emoji' }
  return ('U+{0:X4}' -f $c)
}
$markers = [ordered]@{
  viewonce = 'view[\s-]*once|חד[\s-]*פעמי|🔂|①'
  disappearing = 'disappear|נעלמ|⏱|⏲|timer'
  media = '📷|🎥|🎤|📄|📍|Photo|Video|Voice|Sticker|GIF|תמונה|סרטון|קולית|מדבקה'
  call = 'call|שיחה'
  colon = '^[^:]{1,40}: '
  at = ' @ '
}

$listType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
$seen = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($n in (Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $listType)) { [void]$seen.Add([uint32]$n.Id) }
Write-Output "skipped $($seen.Count) notifications already there. Waiting for new WhatsApp ones for $Minutes min…"
$end = (Get-Date).AddMinutes($Minutes)
$k = 0
while ((Get-Date) -lt $end) {
  foreach ($n in (Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $listType)) {
    $id = [uint32]$n.Id
    if (-not $seen.Add($id)) { continue }
    $aumid = "$($n.AppInfo.AppUserModelId)"; $name = "$($n.AppInfo.DisplayInfo.DisplayName)"
    if (-not (($aumid -match 'WhatsApp') -or ($name -match '^WhatsApp'))) { continue }
    $k++
    $b = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
    $texts = @(); if ($b) { foreach ($t in $b.GetTextElements()) { $texts += [string]$t.Text } }
    $shape = @()
    $i = 0
    foreach ($t in $texts) {
      $hits = @(); foreach ($m in $markers.Keys) { if ($t -match $markers[$m]) { $hits += $m } }
      $shape += "line$i len=$($t.Length) hebrew=$([bool]($t -match '[֐-׿]')) starts=$(Kind $t) marks=[$($hits -join ',')]"
      $i++
    }
    Write-Output ("#{0} app={1} lines={2} running={3}" -f $k, $aumid, $texts.Count, [bool](Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'WhatsApp*' }))
    foreach ($s in $shape) { Write-Output "   $s" }
    $texts = $null
  }
  Start-Sleep -Milliseconds 1500
}
Write-Output "done: $k WhatsApp notifications seen"
