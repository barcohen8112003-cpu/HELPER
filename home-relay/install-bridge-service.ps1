# Registers (or removes) the hidden HELPER PC bridge for this Windows user.
# Run from the HELPER folder, in a normal PowerShell window. Administrator is not required.
#
#   powershell -ExecutionPolicy Bypass -File .\home-relay\install-bridge-service.ps1
#   powershell -ExecutionPolicy Bypass -File .\home-relay\install-bridge-service.ps1 -Uninstall
#
# The task runs at logon in the signed-in user's session (LogonType Interactive, RunLevel Limited),
# not as SYSTEM and not as a service that cannot see the desktop. It can be run again safely.
# The secret already in home-relay\pc-bridge.config.json is used as-is. This script does not
# create that file, does not invent a secret, and does not print one.
param(
    [switch]$Uninstall,
    [string]$HelperRoot = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if (-not $HelperRoot) {
    $HelperRoot = Split-Path -Parent $PSScriptRoot
}

$TaskName = 'HELPER PC Bridge'
$entry = Join-Path $HelperRoot 'home-relay\pc-bridge.mjs'
$vbs = Join-Path $HelperRoot 'home-relay\bridge-hidden.vbs'
$service = Join-Path $HelperRoot 'home-relay\bridge-service.ps1'
if (-not (Test-Path -LiteralPath $entry) -or -not (Test-Path -LiteralPath $vbs) -or -not (Test-Path -LiteralPath $service)) {
    Write-Host "HELPER לא נמצא ב-$HelperRoot"
    exit 1
}

function Stop-HelperBridge([string]$Root) {
    # Match the service script by its own path. "*bridge-service.ps1*" would also match
    # install-bridge-service.ps1 and this window would stop itself.
    $needle = [WildcardPattern]::Escape($Root.TrimEnd('\'))
    for ($i = 0; $i -lt 5; $i++) {
        $killed = $false
        $procs = @()
        try { $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) } catch { $procs = @() }
        foreach ($p in $procs) {
            if ([int]$p.ProcessId -eq $PID) { continue }
            $cmd = [string]$p.CommandLine
            $name = [string]$p.Name
            $hit = $false
            if ($name -eq 'wscript.exe' -and $cmd -like '*bridge-hidden.vbs*') { $hit = $true }
            elseif ($name -eq 'powershell.exe' -and ($cmd -like '*\bridge-service.ps1*' -or $cmd -like '*/bridge-service.ps1*')) { $hit = $true }
            elseif ($name -eq 'node.exe' -and $cmd -like '*pc-bridge.mjs*' -and $cmd -like "*$needle*") { $hit = $true }
            if ($hit) {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
                $killed = $true
            }
        }
        if (-not $killed) { return }
        Start-Sleep -Milliseconds 400
    }
}

function Test-BridgeConfig([string]$Root) {
    $cfgPath = Join-Path $Root 'home-relay\pc-bridge.config.json'
    if (-not (Test-Path -LiteralPath $cfgPath)) {
        Write-Host 'חסר home-relay\pc-bridge.config.json. ממלאים url ואת אותו סוד כמו PC_BRIDGE_SECRET לפי pc-bridge.config.example.json. הסקריפט לא יוצר סוד ולא כותב את הקובץ.'
        return $false
    }
    $url = ''
    $hasSecret = $false
    $placeholder = $false
    try {
        $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $url = [string]$cfg.url
        $sec = [string]$cfg.secret
        if ($sec) { $hasSecret = $true }
        if ($url.Contains('YOUR_SERVER') -or $sec.Contains('paste-the-same')) { $placeholder = $true }
        $sec = $null
    } catch {
        Write-Host 'pc-bridge.config.json לא נקרא. צריך JSON עם url ו-secret. התוכן לא מודפס.'
        return $false
    }
    if (-not $url -or -not $hasSecret -or $placeholder) {
        Write-Host 'צריך למלא url ו-secret ב-pc-bridge.config.json (אותו סוד כמו PC_BRIDGE_SECRET בשרת). לא נרשמה משימה.'
        return $false
    }
    return $true
}

# A bad config must not stop a bridge that is already running.
if (-not $Uninstall) {
    if (-not (Test-BridgeConfig -Root $HelperRoot)) { exit 1 }
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
# Remove it before killing the process, so "restart on failure" cannot start a second copy
# while this script is between the old task and the new one.
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}
Stop-HelperBridge -Root $HelperRoot
if ($Uninstall) {
    Write-Host 'הגשר ברקע הוסר. הוא לא יעלה עם ההתחברות. start-bridge.bat נשאר להרצה ידנית, עם חלון.'
    exit 0
}

$user = $env:USERNAME
if ($env:USERDOMAIN) { $user = "$env:USERDOMAIN\$env:USERNAME" }
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$action = New-ScheduledTaskAction -Execute $wscript -Argument "//B //Nologo `"$vbs`"" -WorkingDirectory $HelperRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
# PT0S: no time limit. The default of three days would stop the bridge.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$settings.ExecutionTimeLimit = [TimeSpan]::Zero
try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'גשר HELPER למחשב: בלי חלון, בסשן של המשתמש, עולה עם ההתחברות ומתחבר מחדש לבד.' -Force | Out-Null
} catch {
    Write-Host 'לא הצלחתי לרשום את המשימה. מריצים את הסקריפט מחלון PowerShell של המשתמש עצמו (לא חייב מנהל).'
    Write-Host $_.Exception.Message
    exit 1
}

try {
    Start-ScheduledTask -TaskName $TaskName
} catch {
    Write-Host 'המשימה נרשמה. אם הגשר לא עלה עכשיו, הוא יעלה עם ההתחברות הבאה ל-Windows.'
    exit 0
}

Start-Sleep -Seconds 2
$state = ''
try { $state = [string](Get-ScheduledTask -TaskName $TaskName).State } catch { $state = '' }
if ($state -eq 'Running') {
    Write-Host 'הגשר רץ עכשיו ברקע, בלי חלון. הוא גם יעלה לבד בכל התחברות ל-Windows.'
} else {
    Write-Host "המשימה נרשמה (מצב: $state). אם הגשר לא רץ עכשיו, הוא יעלה עם ההתחברות הבאה ל-Windows."
}
Write-Host 'אם חלון start-bridge.bat פתוח, סוגרים אותו. הגשר ברקע יחכה לו ואז יתחבר, בלי שני חיבורים.'
$logBase = $env:LOCALAPPDATA
if (-not $logBase) { $logBase = $env:TEMP }
Write-Host ("יומן: " + (Join-Path $logBase 'HelperBridge\bridge.log'))
Write-Host 'להסרה: powershell -ExecutionPolicy Bypass -File .\home-relay\install-bridge-service.ps1 -Uninstall'
