# HELPER's eyes inside a window: Windows UI Automation, kept running so each call takes a fraction of a second.
# One JSON request per line on stdin, one JSON answer per line on stdout. Driven by src/uia.js.
#   {"op":"list","hwnd":123,"max":300,"types":["Button"]}  -> {"ok":true,"items":[{i,type,name,id,enabled,off,x,y,w,h,value}]}
#   {"op":"act","hwnd":123,"i":4}                           -> {"ok":true,"done":"selected"} or {"ok":true,"click":{x,y}}
#   {"op":"focus","hwnd":123,"i":4}                         -> {"ok":true,"rect":{x,y,w,h}}
#   {"op":"set","hwnd":123,"i":4,"text":"..."}              -> {"ok":true,"done":"set"} or {"ok":false,"error":"no value"}
#   {"op":"read","hwnd":123,"max":6000}                     -> {"ok":true,"text":"..."}
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

# Physical pixels, the same as HELPER's clicks (Electron is per-monitor DPI aware).
Add-Type -Namespace HelperUia -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v);'
try { [HelperUia.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$script:last = $null
$script:lastHwnd = 0

$KINDS = @{
  Button = $CT::Button; Edit = $CT::Edit; Hyperlink = $CT::Hyperlink; MenuItem = $CT::MenuItem; TabItem = $CT::TabItem
  ListItem = $CT::ListItem; CheckBox = $CT::CheckBox; ComboBox = $CT::ComboBox; RadioButton = $CT::RadioButton
  SplitButton = $CT::SplitButton; TreeItem = $CT::TreeItem; DataItem = $CT::DataItem; Slider = $CT::Slider
  Document = $CT::Document; Text = $CT::Text
}
$DEFAULT = @('Button', 'Edit', 'Hyperlink', 'MenuItem', 'TabItem', 'ListItem', 'CheckBox', 'ComboBox', 'RadioButton', 'SplitButton', 'TreeItem', 'DataItem', 'Slider', 'Document')

function Root($hwnd) {
  $e = $AE::FromHandle([IntPtr][long]$hwnd)
  if (-not $e) { throw 'no such window' }
  return $e
}

function Cond($types) {
  $conds = @()
  foreach ($t in $types) { if ($KINDS.ContainsKey($t)) { $conds += New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $KINDS[$t]) } }
  if ($conds.Count -eq 1) { return $conds[0] }
  return New-Object System.Windows.Automation.OrCondition(,[System.Windows.Automation.Condition[]]$conds)
}

function Info($e, $i) {
  $c = $e.Cached
  $o = [ordered]@{ i = $i; type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', ''); name = [string]$c.Name; id = [string]$c.AutomationId; enabled = [bool]$c.IsEnabled; off = [bool]$c.IsOffscreen }
  $r = $c.BoundingRectangle
  if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.X)) { $o.x = [int]$r.X; $o.y = [int]$r.Y; $o.w = [int]$r.Width; $o.h = [int]$r.Height }
  try {
    $v = $e.GetCachedPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty, $true)
    if ($v -is [string] -and $v) { $o.value = $v.Substring(0, [Math]::Min(120, $v.Length)) }
  } catch { }
  return $o
}

function List($req) {
  $root = Root $req.hwnd
  $types = if ($req.types) { @($req.types) } else { $DEFAULT }
  $cr = New-Object System.Windows.Automation.CacheRequest
  foreach ($p in @($AE::NameProperty, $AE::ControlTypeProperty, $AE::AutomationIdProperty, $AE::BoundingRectangleProperty, $AE::IsEnabledProperty, $AE::IsOffscreenProperty, [System.Windows.Automation.ValuePattern]::ValueProperty)) { $cr.Add($p) }
  $cr.Push()
  try { $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (Cond $types)) } finally { $cr.Pop() }
  $max = if ($req.max) { [int]$req.max } else { 400 }
  $keep = New-Object System.Collections.ArrayList
  $items = New-Object System.Collections.ArrayList
  foreach ($e in $all) {
    if ($keep.Count -ge $max) { break }
    $info = Info $e $keep.Count
    # Nameless controls say nothing to anyone, except fields (a search box often has no name) and documents.
    if (-not $info.name -and $info.type -ne 'Edit' -and $info.type -ne 'Document' -and $info.type -ne 'ComboBox') { continue }
    [void]$keep.Add($e)
    [void]$items.Add($info)
  }
  $script:last = $keep
  $script:lastHwnd = [long]$req.hwnd
  return @{ ok = $true; items = @($items) }
}

function Pick($req) {
  if ($script:lastHwnd -ne [long]$req.hwnd -or -not $script:last -or [int]$req.i -ge $script:last.Count) { throw 'stale: list again' }
  return $script:last[[int]$req.i]
}

function Center($e) {
  $r = $e.Current.BoundingRectangle
  if ($r.IsEmpty -or [double]::IsInfinity($r.X) -or $r.Width -le 0) { return $null }
  return @{ x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2) }
}

function Act($req) {
  $q = $null
  $e = Pick $req
  $p = $null
  # Tabs and list rows: selected, the way a click would.
  if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p) -and -not $e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$q)) {
    $p.Select(); return @{ ok = $true; done = 'selected' }
  }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return @{ ok = $true; done = 'toggled' } }
  $hasInvoke = $e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)
  # A visible button is clicked for real: Invoke can hang until a dialog it opens is closed.
  $c = if (-not $e.Current.IsOffscreen) { Center $e } else { $null }
  if ($c) { return @{ ok = $true; click = $c } }
  if ($hasInvoke) { $p.Invoke(); return @{ ok = $true; done = 'invoked' } }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
    if ($p.Current.ExpandCollapseState -eq 'Collapsed') { $p.Expand() } else { $p.Collapse() }
    return @{ ok = $true; done = 'expanded' }
  }
  if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return @{ ok = $true; done = 'selected' } }
  try { $e.SetFocus(); return @{ ok = $true; done = 'focused' } } catch { throw 'cannot press it' }
}

function FocusOne($req) {
  $e = Pick $req
  try { $e.SetFocus() } catch { }
  $r = $e.Current.BoundingRectangle
  $rect = if ($r.IsEmpty -or [double]::IsInfinity($r.X)) { $null } else { @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } }
  return @{ ok = $true; rect = $rect; off = [bool]$e.Current.IsOffscreen }
}

function SetOne($req) {
  $e = Pick $req
  $p = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p) -and -not $p.Current.IsReadOnly) {
    $p.SetValue([string]$req.text); return @{ ok = $true; done = 'set' }
  }
  return @{ ok = $false; error = 'no value' }
}

function ReadText($req) {
  $root = Root $req.hwnd
  $max = if ($req.max) { [int]$req.max } else { 6000 }
  # A document (a web page, Notepad, Word) reads as one text.
  $docs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (Cond @('Document')))
  foreach ($d in $docs) {
    $p = $null
    if ($d.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$p)) {
      $t = $p.DocumentRange.GetText($max)
      if ($t -and $t.Trim()) { return @{ ok = $true; text = $t.Trim(); from = 'document' } }
    }
  }
  # Otherwise the words the window shows: its texts and the values of its fields, in order.
  $cr = New-Object System.Windows.Automation.CacheRequest
  foreach ($p in @($AE::NameProperty, $AE::ControlTypeProperty, [System.Windows.Automation.ValuePattern]::ValueProperty)) { $cr.Add($p) }
  $cr.Push()
  try { $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (Cond @('Text', 'Edit', 'ListItem', 'DataItem', 'Hyperlink'))) } finally { $cr.Pop() }
  $sb = New-Object System.Text.StringBuilder
  $seen = @{}
  foreach ($e in $all) {
    $s = [string]$e.Cached.Name
    try { $v = $e.GetCachedPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty, $true); if ($v -is [string] -and $v) { $s = $v } } catch { }
    $s = $s.Trim()
    if (-not $s -or $seen.ContainsKey($s)) { continue }
    $seen[$s] = 1
    [void]$sb.AppendLine($s)
    if ($sb.Length -ge $max) { break }
  }
  return @{ ok = $true; text = $sb.ToString().Trim(); from = 'texts' }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $res = switch ($req.op) {
      'ping' { @{ ok = $true } }
      'list' { List $req }
      'act' { Act $req }
      'focus' { FocusOne $req }
      'set' { SetOne $req }
      'read' { ReadText $req }
      default { @{ ok = $false; error = 'unknown op' } }
    }
  } catch {
    $res = @{ ok = $false; error = [string]$_.Exception.Message }
  }
  $res.id = $id
  [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}
