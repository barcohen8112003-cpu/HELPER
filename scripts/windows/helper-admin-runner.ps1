# Helper Admin Runner: started (elevated) by the "Helper Admin Runner" task. Takes each request from the inbox, runs it
# once in a hidden elevated PowerShell with a 60 second limit, and writes the output next to it. Setup copies this file
# into %ProgramData%\HelperAdmin, which only Administrators can change.
$ErrorActionPreference = 'Continue'
$base = Join-Path $env:ProgramData 'HelperAdmin'
$inbox = Join-Path $base 'inbox'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$idle = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $idle) {
  $reqs = @(Get-ChildItem -LiteralPath $inbox -Filter '*.req' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^[0-9a-f]{32}\.req$' })
  foreach ($r in $reqs) {
    $id = $r.BaseName
    $work = Join-Path $inbox "$id.work"
    # Taking a request renames it, so it runs once even if two runners ever met.
    try { Move-Item -LiteralPath $r.FullName -Destination $work -ErrorAction Stop } catch { continue }
    $res = @{ out = ''; err = ''; code = $null; timeout = $false }
    try {
      if ((Get-Item -LiteralPath $work).Length -gt 32000) { throw 'request too large' }
      $cmd = [IO.File]::ReadAllText($work, [Text.Encoding]::UTF8)
      $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("`$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; " + $cmd))
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = 'powershell.exe'
      $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $enc"
      $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
      $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
      $psi.StandardOutputEncoding = [Text.Encoding]::UTF8; $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
      $p = [System.Diagnostics.Process]::Start($psi)
      $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
      if ($p.WaitForExit(60000)) { $res.code = $p.ExitCode } else { $res.timeout = $true; try { $p.Kill() } catch { } }
      if ($o.Wait(5000)) { $res.out = [string]$o.Result }
      if ($e.Wait(5000)) { $res.err = [string]$e.Result }
    } catch { $res.err = [string]$_ }
    Remove-Item -LiteralPath $work -Force -ErrorAction SilentlyContinue
    foreach ($k in 'out', 'err') { if ($res[$k].Length -gt 8000) { $res[$k] = $res[$k].Substring(0, 8000) } }
    $tmp = Join-Path $inbox "$id.outpart"
    [IO.File]::WriteAllText($tmp, ($res | ConvertTo-Json -Compress), $utf8)
    Move-Item -LiteralPath $tmp -Destination (Join-Path $inbox "$id.out") -Force
    $idle = (Get-Date).AddSeconds(20)
  }
  # Answers nobody collected (Helper gave up or restarted) do not pile up.
  Get-ChildItem -LiteralPath $inbox -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-10) } | Remove-Item -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
}
