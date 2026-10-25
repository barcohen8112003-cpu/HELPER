# HELPER in one command, on Windows. Paste this in PowerShell:
#
#   irm https://raw.githubusercontent.com/barcohen8112003-cpu/HELPER/main/install.ps1 | iex
#
# It installs Node.js and Git when they are missing (winget), downloads HELPER (or uses this folder when run from
# inside it), installs its packages, adds the "helper" command, and starts the setup wizard (helper onboard).
# No byte-order mark in this file: through irm | iex it would hide the param block. setup.bat reads it as UTF-8.
# Options as a file: -Dir <folder>  -Branch <name>  -NoWizard, and the rest goes to the wizard (e.g. --yes).
# Through irm | iex there are no arguments, so the same come from the environment: HELPER_DIR, HELPER_BRANCH,
# HELPER_NO_WIZARD=1, HELPER_NO_LINK=1, HELPER_WIZARD_ARGS="--yes --api-key=...".
param(
    [string]$Dir = $(if ($env:HELPER_DIR) { $env:HELPER_DIR } else { Join-Path $HOME 'HELPER' }),
    [string]$Branch = $(if ($env:HELPER_BRANCH) { $env:HELPER_BRANCH } else { 'main' }),
    [switch]$NoWizard,
    [string]$Here,   # the project folder when run from inside it (setup.bat passes it)
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$WizardArgs
)
if ($env:HELPER_NO_WIZARD -eq '1') { $NoWizard = $true }
if (-not $WizardArgs -and $env:HELPER_WIZARD_ARGS) { $WizardArgs = $env:HELPER_WIZARD_ARGS -split '\s+' }
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$Repo = 'https://github.com/barcohen8112003-cpu/HELPER.git'

function Say($t) { Write-Host "  $t" }
function Ok($t) { Write-Host "  ✓ $t" -ForegroundColor Green }
function Step($t) { Write-Host ""; Write-Host "» $t" -ForegroundColor Cyan }
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
# npm, git and winget write progress and warnings to stderr; Windows PowerShell would stop on those. They run with
# their output shown, and only their exit code decides.
function Run([string]$exe, [string[]]$argv) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $exe @argv 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }; return $LASTEXITCODE } finally { $ErrorActionPreference = $old }
}

Write-Host ""
Write-Host "  HELPER — התקנה בפקודה אחת" -ForegroundColor Cyan
Write-Host "  ─────────────────────────" -ForegroundColor Cyan

# ---- Node.js 24+ and Git ----
Step 'Node.js ו-Git'
$nodeOk = $false
if (Has 'node') { $v = (node -v) -replace '^v', ''; $nodeOk = [int]($v.Split('.')[0]) -ge 24 }
if (-not $nodeOk) {
    if (-not (Has 'winget')) { throw 'צריך Node.js 24 ומעלה, ואין winget להתקין אותו. מתקינים מ-https://nodejs.org ומריצים שוב.' }
    Say 'מתקין את Node.js (LTS)…'
    [void](Run 'winget' @('install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'))
    Refresh-Path
    if (-not (Has 'node')) { throw 'Node.js הותקן אבל החלון לא רואה אותו עדיין. פותחים PowerShell חדש ומריצים שוב את אותה שורה.' }
}
Ok ("Node.js " + (node -v))
if (-not (Has 'git')) {
    if (Has 'winget') {
        Say 'מתקין את Git…'
        [void](Run 'winget' @('install', '--id', 'Git.Git', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'))
        Refresh-Path
    }
}
if (Has 'git') { Ok (git --version) } else { Say 'Git לא מותקן: מוריד את HELPER כקובץ zip (helper update לא יעבוד בלי Git)' }

# ---- the project folder ----
Step 'הפרויקט'
$here = if ($Here) { $Here.TrimEnd('\') } elseif ($PSScriptRoot) { $PSScriptRoot } else { $null }
$inRepo = $here -and (Test-Path (Join-Path $here 'package.json')) -and ((Get-Content (Join-Path $here 'package.json') -Raw) -match '"name":\s*"helper"')
if ($inRepo) {
    $Dir = $here
    Ok "משתמש בתיקייה הזו: $Dir"
} elseif (Test-Path (Join-Path $Dir 'package.json')) {
    Ok "כבר קיים: $Dir"
    if ((Has 'git') -and (Test-Path (Join-Path $Dir '.git'))) { [void](Run 'git' @('-C', $Dir, 'pull', '--ff-only')) }
} elseif (Has 'git') {
    Say "מוריד ל-$Dir…"
    if ((Run 'git' @('clone', '--depth', '1', '--branch', $Branch, $Repo, $Dir)) -ne 0) { throw "git clone נכשל" }
    Ok "הורד ל-$Dir"
} else {
    $zip = Join-Path $env:TEMP 'helper.zip'
    Invoke-WebRequest -UseBasicParsing "https://github.com/barcohen8112003-cpu/HELPER/archive/refs/heads/$Branch.zip" -OutFile $zip
    $tmp = Join-Path $env:TEMP ('helper-' + [guid]::NewGuid())
    Expand-Archive $zip $tmp
    Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $Dir
    Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Ok "הורד ל-$Dir"
}

# ---- packages and the helper command ----
Step 'חבילות ופקודת helper'
Push-Location $Dir
try {
    if (-not (Test-Path 'node_modules')) {
        Say 'מתקין חבילות (דקה או שתיים)…'
        if ((Run 'npm' @('install', '--no-audit', '--no-fund')) -ne 0) { throw 'npm install נכשל (השגיאה למעלה)' }
    }
    Ok 'החבילות של הבוט'
    # "helper" from any folder: a tiny launcher in npm's global folder, which is on PATH.
    $linked = 1
    if ($env:HELPER_NO_LINK -ne '1') { $linked = Run 'npm' @('link', '--no-audit', '--no-fund') }
    if ($linked -eq 0 -and (Has 'helper')) { Ok 'הפקודה helper מוכנה (helper doctor, helper onboard, helper start, helper update)' }
    else { Say "בלי פקודת helper גלובלית: מתוך $Dir מריצים npm run setup / npm run doctor" }

    if ($NoWizard) { Say 'האשף דולג (-NoWizard). מריצים אותו מתי שרוצים: helper onboard'; return }
    Step 'אשף ההתקנה'
    # Straight to the console (no pipe), so the wizard can ask its questions.
    $ErrorActionPreference = 'Continue'
    & node scripts/setup.mjs @WizardArgs
    if ($LASTEXITCODE -ne 0) { Write-Host "  האשף לא הסתיים. מריצים שוב מתי שרוצים: helper onboard (או npm run setup בתוך $Dir)" -ForegroundColor Yellow }
} finally { Pop-Location }
