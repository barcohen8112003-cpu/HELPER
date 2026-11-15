# HELPER PC bridge, in the signed-in user's session, with no console window.
# The logon task runs home-relay\bridge-hidden.vbs, which starts this script hidden.
# node (runHomeBridge) stays up across a server restart and retries on its own:
# 2 seconds, then 4, 8, 16, 32, and at most one minute, forever.
# This loop only starts node again if that process exits. 15 seconds matches start-bridge.bat.
# The secret stays in pc-bridge.config.json. It is never passed on the command line and never written to the log.
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$HelperRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $HelperRoot

$logBase = $env:LOCALAPPDATA
if (-not $logBase) { $logBase = $env:TEMP }
$logDir = Join-Path $logBase 'HelperBridge'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$script:LogPath = Join-Path $logDir 'bridge.log'
$script:LogGate = New-Object System.Object
$script:BridgeSecret = ''

function Import-BridgeSecret {
    $cfgPath = Join-Path $PSScriptRoot 'pc-bridge.config.json'
    if (-not (Test-Path -LiteralPath $cfgPath)) { return }
    try {
        $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $script:BridgeSecret = [string]$cfg.secret
    } catch {
        $script:BridgeSecret = ''
    }
}

function Hide-Secret([string]$Text) {
    if (-not $Text) { return '' }
    $s = $script:BridgeSecret
    if ($s -and $s.Length -ge 8 -and $Text.Contains($s)) { return $Text.Replace($s, '[secret]') }
    return $Text
}

function Write-Log([string]$Message) {
    if (-not $Message) { return }
    $line = '{0} {1}{2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), (Hide-Secret $Message), [Environment]::NewLine
    [System.Threading.Monitor]::Enter($script:LogGate)
    try {
        [System.IO.File]::AppendAllText($script:LogPath, $line, (New-Object System.Text.UTF8Encoding $false))
    } catch {
    } finally {
        [System.Threading.Monitor]::Exit($script:LogGate)
    }
}

function Trim-Log {
    if (-not (Test-Path -LiteralPath $script:LogPath)) { return }
    try {
        if ((Get-Item -LiteralPath $script:LogPath).Length -lt 1MB) { return }
        $tail = @(Get-Content -LiteralPath $script:LogPath -Tail 1500 -Encoding UTF8)
        [System.IO.File]::WriteAllLines($script:LogPath, $tail, (New-Object System.Text.UTF8Encoding $false))
    } catch {
    }
}

# webtop-once-before-loop: same side effect as start-bridge.bat, once per service process.
function Start-WebtopOnce {
    $envFile = Join-Path $HelperRoot '.env'
    if (-not (Test-Path -LiteralPath $envFile)) { return }
    $value = ''
    try {
        $hit = Select-String -LiteralPath $envFile -Pattern '^WEBTOP_URL=.+' -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $hit) { return }
        $value = ([string]$hit.Line -replace '^WEBTOP_URL=', '').Trim().Trim('"').Trim("'")
    } catch {
        return
    }
    if (-not $value) { return }
    $bat = Join-Path $HelperRoot 'webtop-browser.bat'
    if (-not (Test-Path -LiteralPath $bat)) { return }
    Write-Log 'פותח את חלון ה-Webtop (ממוזער).'
    try {
        Start-Process -FilePath $bat -WorkingDirectory $HelperRoot -WindowStyle Minimized | Out-Null
    } catch {
        Write-Log 'חלון ה-Webtop לא נפתח. הגשר עצמו ממשיך.'
    }
}

function Find-Node {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }
    $candidates = @()
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    try {
        $found = & where.exe node 2>$null | Select-Object -First 1
        if ($found) {
            $found = $found.ToString().Trim()
            if (Test-Path -LiteralPath $found) { return $found }
        }
    } catch {
    }
    return $null
}

function Get-OtherBridgeNodes {
    try {
        return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop | Where-Object {
            [string]$_.CommandLine -like '*pc-bridge.mjs*'
        })
    } catch {
        return @()
    }
}

Import-BridgeSecret
try { [System.IO.File]::WriteAllText((Join-Path $logDir 'service.pid'), "$PID") } catch { }

# Reads the node process on a thread pool thread. A PowerShell event handler has no runspace
# there, and an unread pipe would eventually stall the bridge.
if (-not ('HelperBridgeLog' -as [type])) {
    try {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
public static class HelperBridgeLog {
  public static void Pump(StreamReader reader, string path, object gate, string secret) {
    var enc = new UTF8Encoding(false);
    try {
      string line;
      while ((line = reader.ReadLine()) != null) {
        if (!string.IsNullOrEmpty(secret) && secret.Length >= 8 && line.IndexOf(secret, StringComparison.Ordinal) >= 0)
          line = line.Replace(secret, "[secret]");
        var text = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + line + Environment.NewLine;
        lock (gate) { File.AppendAllText(path, text, enc); }
      }
    } catch (Exception) { }
  }
  public static void Start(StreamReader reader, string path, object gate, string secret) {
    ThreadPool.QueueUserWorkItem(delegate { Pump(reader, path, gate, secret); });
  }
}
'@
    } catch {
        Write-Log 'היומן החי לא נפתח. הגשר עצמו ירוץ.'
    }
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\HELPER-PC-Bridge')
$hasMutex = $false
try {
    try {
        $hasMutex = $mutex.WaitOne(20000)
    } catch {
        $ex = $_.Exception
        if ($ex -is [System.Threading.AbandonedMutexException] -or $ex.InnerException -is [System.Threading.AbandonedMutexException]) {
            $hasMutex = $true
        } else {
            Write-Log 'נעילת הגשר נכשלה.'
            exit 1
        }
    }
    if (-not $hasMutex) {
        Write-Log 'הגשר כבר רץ ברקע. לא מפעילים עותק שני.'
        exit 0
    }

    # webtop-once-before-loop
    Start-WebtopOnce
    $announcedOther = $false
    while ($true) {
        $proc = $null
        try {
            $others = @(Get-OtherBridgeNodes)
            if ($others.Count -gt 0) {
                if (-not $announcedOther) {
                    Write-Log 'חלון הגשר כבר פתוח. מחכים שהוא ייסגר, כדי שלא ירוצו שניים.'
                    $announcedOther = $true
                }
                Start-Sleep -Seconds 15
                continue
            }
            $announcedOther = $false

            $node = Find-Node
            if (-not $node) {
                Write-Log 'node.exe לא נמצא. נסיון נוסף בעוד 30 שניות.'
                Start-Sleep -Seconds 30
                continue
            }

            Trim-Log
            $scriptPath = Join-Path $PSScriptRoot 'pc-bridge.mjs'
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $node
            $psi.Arguments = '"' + $scriptPath + '"'
            $psi.WorkingDirectory = $HelperRoot
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
            $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding $false
            $proc = New-Object System.Diagnostics.Process
            $proc.StartInfo = $psi
            Write-Log 'מפעיל את הגשר.'
            [void]$proc.Start()
            try { [System.IO.File]::WriteAllText((Join-Path $logDir 'node.pid'), "$($proc.Id)") } catch { }
            if ('HelperBridgeLog' -as [type]) {
                [HelperBridgeLog]::Start($proc.StandardOutput, $script:LogPath, $script:LogGate, $script:BridgeSecret)
                [HelperBridgeLog]::Start($proc.StandardError, $script:LogPath, $script:LogGate, $script:BridgeSecret)
            } else {
                # Still drain the pipes so a full buffer cannot stall node. The lines are dropped.
                [void]$proc.StandardOutput.ReadToEndAsync()
                [void]$proc.StandardError.ReadToEndAsync()
            }
            $proc.WaitForExit()
            try { $null = $proc.WaitForExit(5000) } catch { }
            $code = -1
            try { $code = $proc.ExitCode } catch { }
            Write-Log "הגשר נעצר (קוד $code). מתחילים שוב בעוד 15 שניות."
            Start-Sleep -Seconds 15
        } catch {
            if ($proc) {
                try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
            }
            Write-Log 'הפעלה נכשלה. נסיון נוסף בעוד 15 שניות.'
            Start-Sleep -Seconds 15
        }
    }
} finally {
    if ($hasMutex) {
        try { $mutex.ReleaseMutex() } catch { }
    }
    try { $mutex.Dispose() } catch { }
}
