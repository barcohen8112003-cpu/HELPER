// Control of the user's own Windows PC: media keys, screenshots, apps, status, speech, power, files, installs,
// and mouse and keyboard for the step-by-step "use the computer" tool. Everything goes through PowerShell with
// what ships with Windows; nothing extra is installed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { config } from './config.js'

export const pcEnabled = () => process.platform === 'win32'

// Runs a PowerShell script. -EncodedCommand carries any text (Hebrew, quotes) without quoting trouble.
export function ps(script, timeoutMs = 60000) {
  const full = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`
  const encoded = Buffer.from(full, 'utf16le').toString('base64')
  return new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      err && !stdout ? reject(new Error((stderr || err.message).trim().slice(0, 400))) : resolve(stdout.trim())
    )
  )
}

// A PowerShell string literal: single quotes, with inner single quotes doubled.
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`

// Low-level input. DPI awareness makes screen pixels and cursor positions the same numbers.
const INPUT = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class U {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
  public static void Down(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); }
  public static void Up(byte vk) { keybd_event(vk, 0, 2, UIntPtr.Zero); }
  public static void Tap(byte vk) { Down(vk); Up(vk); }
  public static void WakeMonitor() {
    SendMessage((IntPtr)0xffff, 0x0112, (IntPtr)0xF170, (IntPtr)(-1));
    mouse_event(1, 1, 1, 0, UIntPtr.Zero);
    mouse_event(1, -1, -1, 0, UIntPtr.Zero);
  }
  public static void SleepMonitor() {
    SendMessage((IntPtr)0xffff, 0x0112, (IntPtr)0xF170, (IntPtr)2);
  }
  public static void TypeAscii(char c) {
    if (c >= '0' && c <= '9') {
      Tap((byte)c);
    } else if (c >= 'a' && c <= 'z') {
      Tap((byte)(c - 32));
    } else if (c >= 'A' && c <= 'Z') {
      Down(0x10); Tap((byte)c); Up(0x10);
    } else if (c == ' ') {
      Tap(0x20);
    } else if (c == '.') {
      Tap(0xBE);
    } else if (c == '-') {
      Tap(0xBD);
    } else if (c == '_') {
      Down(0x10); Tap(0xBD); Up(0x10);
    } else if (c == 13 || c == 10) {
      Tap(0x0D);
    } else {
      Tap((byte)c);
    }
  }
}
"@
[U]::SetProcessDPIAware() | Out-Null
`

// ---- media ----

const MEDIA = { play_pause: 0xb3, next: 0xb0, previous: 0xb1, mute: 0xad, volume_down: 0xae, volume_up: 0xaf }

export async function media(action, level) {
  if (action === 'set_volume') {
    // Windows exposes no simple "set volume" call; fifty steps down reach zero, then each step up adds 2%.
    const steps = Math.round(Math.min(100, Math.max(0, Number(level) || 0)) / 2)
    await ps(`${INPUT} 1..50 | % { [U]::Tap(0xAE) }; 1..${Math.max(1, steps)} | % { [U]::Tap(0xAF) }${steps === 0 ? '; [U]::Tap(0xAE)' : ''}`)
    return `הווליום עכשיו בערך ${steps * 2}%`
  }
  const vk = MEDIA[action]
  if (!vk) throw new Error(`פעולה לא מוכרת: ${action}`)
  const presses = action.startsWith('volume_') ? 5 : 1
  await ps(`${INPUT} 1..${presses} | % { [U]::Tap(${vk}) }`)
  return { play_pause: 'הופעל/נעצר', next: 'עבר לשיר הבא', previous: 'חזר לשיר הקודם', mute: 'השתקה הופעלה/בוטלה', volume_up: 'הווליום עלה בכ-10%', volume_down: 'הווליום ירד בכ-10%' }[action]
}

// ---- screen ----

// Captures the primary screen to a PNG. maxWidth scales it down (for the model); 0 keeps full size.
// Returns { file, width, height, scale, left, top } where scale converts image pixels back to screen pixels.
export async function screenshot(maxWidth = 0) {
  const file = path.join(os.tmpdir(), `helper-screen-${Date.now()}.png`)
  const out = await ps(`${INPUT}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $g.Dispose()
$w = $b.Width; $h = $b.Height; $max = ${Number(maxWidth) || 0}
if ($max -gt 0 -and $w -gt $max) {
  $nh = [int]($h * $max / $w); $s = New-Object System.Drawing.Bitmap $max, $nh
  $g2 = [System.Drawing.Graphics]::FromImage($s); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.DrawImage($bmp, 0, 0, $max, $nh); $g2.Dispose()
  $bmp.Dispose(); $bmp = $s
}
$bmp.Save(${lit(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
"$($bmp.Width) $($bmp.Height) $w $($b.Left) $($b.Top)"
$bmp.Dispose()`)
  const [width, height, fullWidth, left, top] = out.split(/\s+/).map(Number)
  return { file, width, height, scale: fullWidth / width, left, top }
}

// ---- apps ----

// Installed apps whose name contains the query, best match first. Get-StartApps covers ordinary programs and Store apps.
export async function findApps(query) {
  const out = await ps(`Get-StartApps | Where-Object { $_.Name -like ${lit(`*${query}*`)} } | Select-Object -First 15 Name, AppID | ConvertTo-Json -Compress`)
  const list = out ? [].concat(JSON.parse(out)) : []
  const q = String(query).toLowerCase()
  const rank = (a) => (a.Name.toLowerCase() === q ? 0 : a.Name.toLowerCase().startsWith(q) ? 1 : 2)
  return list.sort((a, b) => rank(a) - rank(b) || a.Name.length - b.Name.length)
}

export async function launchApp(query) {
  const apps = await findApps(query)
  if (!apps.length) return null
  await ps(`Start-Process explorer.exe -ArgumentList ${lit(`shell:AppsFolder\\${apps[0].AppID}`)}`)
  return apps[0].Name
}

export async function playSpotify(query) {
  const uri = `spotify:search:${encodeURIComponent(query)}`
  try {
    await ps(`Start-Process ${lit(uri)} -ErrorAction Stop`)
    return `נפתח בספוטיפיי: "${query}"`
  } catch {
    const webUrl = `https://open.spotify.com/search/${encodeURIComponent(query)}`
    await ps(`Start-Process ${lit(webUrl)}`)
    return `נפתח בספוטיפיי בדפדפן: "${query}"`
  }
}


// Closes an app politely (as if its window were closed), and forcibly only if it is still running after a few seconds.
export async function closeApp(name) {
  const proc = String(name).replace(/\.exe$/i, '')
  return ps(`$p = Get-Process -Name ${lit(proc)} -ErrorAction SilentlyContinue
if (-not $p) { 'not running'; return }
$p | ForEach-Object { $_.CloseMainWindow() | Out-Null }
Start-Sleep -Seconds 4
$left = Get-Process -Name ${lit(proc)} -ErrorAction SilentlyContinue
if ($left) { $left | Stop-Process -Force; 'closed (forced)' } else { 'closed' }`)
}

// ---- status ----

export async function status() {
  return ps(`$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
[pscustomobject]@{
  cpuPercent = [int]$cpu
  memoryUsedGB = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 1)
  memoryTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
  battery = $(if ($bat) { "$($bat.EstimatedChargeRemaining)%" } else { 'אין סוללה (מחשב נייח)' })
  disks = @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { "$($_.Name): $([math]::Round($_.Free / 1GB)) GB free of $([math]::Round(($_.Used + $_.Free) / 1GB)) GB" })
  topMemory = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 6 | ForEach-Object { "$($_.ProcessName) $([math]::Round($_.WorkingSet64 / 1MB)) MB" })
  topCpu = @(Get-Process | Where-Object { $_.CPU } | Sort-Object CPU -Descending | Select-Object -First 5 | ForEach-Object { "$($_.ProcessName) $([math]::Round($_.CPU)) s" })
} | ConvertTo-Json -Compress`)
}

// ---- small things ----

export const lock = () => ps('rundll32.exe user32.dll,LockWorkStation')

// Puts monitors into sleep/standby mode immediately without sleeping the PC.
export async function sleepMonitors() {
  await ps(`${INPUT}
[U]::SleepMonitor()
`)
  return 'המסכים כובו (נכנסו למצב שינה / Standby)'
}

// Wakes monitors from sleep/standby mode.
export async function wakeMonitors() {
  await ps(`${INPUT}
[U]::WakeMonitor()
`)
  return 'המסכים הודלקו'
}

// Wakes the monitor, wiggles mouse, dismisses lock screen wallpaper, and enters the password/PIN.
export async function unlock(password = process.env.PC_UNLOCK_PASSWORD || 'naorkk132') {
  await ps(`${INPUT}
[U]::WakeMonitor()
Start-Sleep -Milliseconds 250
[U]::Tap(0x20)
Start-Sleep -Milliseconds 250
[U]::Tap(0x0D)
`)
  const pass = password === 'none' || password === false ? '' : String(password || '').trim()
  if (pass) {
    await new Promise((r) => setTimeout(r, 700))
    await typeText(pass, true)
    return 'מסך הנעילה נפתח והוקלדה הסיסמה'
  }
  return 'מסך הנעילה נפתח (המסך הודלק ומסך הנעילה הועלה לחלון ההתחברות)'
}

// Types text or a PIN into the active window or lock screen.
export async function typeText(text, pressEnter = false) {
  const str = String(text ?? '')
  if (!str) return 'לא נמסר טקסט להקלדה'

  // If text is ASCII / digits (like a PIN or password), use physical keystrokes so it works in password fields and lock screen
  const isKeystrokes = /^[a-zA-Z0-9 _\.\-]+$/.test(str)
  if (isKeystrokes) {
    const script = `
${INPUT}
$chars = ${lit(str)}.ToCharArray()
foreach ($c in $chars) {
  [U]::TypeAscii($c)
  Start-Sleep -Milliseconds 40
}
${pressEnter ? 'Start-Sleep -Milliseconds 80; [U]::Tap(0x0D)' : ''}
`
    await ps(script)
  } else {
    // For Hebrew or complex text in windows, paste via clipboard + Ctrl+V
    await ps(`${INPUT} Set-Clipboard -Value ${lit(str)}; Start-Sleep -Milliseconds 80; [U]::Down(0x11); [U]::Tap(0x56); [U]::Up(0x11)${pressEnter ? '; Start-Sleep -Milliseconds 100; [U]::Tap(0x0D)' : ''}`)
  }

  return `הוקלד: "${str}"${pressEnter ? ' (נלחץ Enter)' : ''}`
}

export async function pressKey(keys) {
  await act({ type: 'key', keys })
  return `נלחץ המקש: ${keys}`
}
export const setClipboard = (text) => ps(`Set-Clipboard -Value ${lit(text)}`)
export const getClipboard = () => ps('Get-Clipboard -Raw')

// A window that stays on top until dismissed, plus a sound. Not waited for, so it never holds anything up.
export function popup(text, title = 'Helper') {
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Media.SystemSounds]::Exclamation.Play()
$f = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
[System.Windows.Forms.MessageBox]::Show($f, ${lit(text)}, ${lit(title)}) | Out-Null`
  const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

// Floating countdown timer on top of the screen that rings and alerts when finished.
export function startTimer(minutes, label = 'טיימר') {
  const mins = Math.max(0.1, Number(minutes) || 1)
  const totalSeconds = Math.round(mins * 60)
  const titleText = lit(String(label).trim() || 'טיימר')
  const script = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$remaining = ${totalSeconds}
$title = ${titleText}
$form = New-Object System.Windows.Forms.Form
$form.Text = $title
$form.Size = New-Object System.Drawing.Size(260, 130)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedToolWindow'
$form.BackColor = [System.Drawing.Color]::FromArgb(28, 28, 28)

$lbl = New-Object System.Windows.Forms.Label
$lbl.Font = New-Object System.Drawing.Font('Segoe UI', 26, [System.Drawing.FontStyle]::Bold)
$lbl.ForeColor = [System.Drawing.Color]::White
$lbl.Dock = 'Fill'
$lbl.TextAlign = 'MiddleCenter'
$form.Controls.Add($lbl)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000

$update = {
  $ts = [TimeSpan]::FromSeconds($remaining)
  if ($ts.Hours -gt 0) {
    $lbl.Text = $ts.ToString('hh\\:mm\\:ss')
  } else {
    $lbl.Text = $ts.ToString('mm\\:ss')
  }
}
&$update

$timer.Add_Tick({
  $script:remaining--
  if ($script:remaining -le 0) {
    $timer.Stop()
    $lbl.Text = '00:00'
    $lbl.ForeColor = [System.Drawing.Color]::IndianRed
    1..3 | ForEach-Object { [System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 300 }
    [System.Windows.Forms.MessageBox]::Show($form, "$title הסתיים!", 'Helper', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    $form.Close()
  } else {
    &$update
  }
})

$timer.Start()
[System.Windows.Forms.Application]::Run($form)`

  const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return `טיימר ל-${mins} דקות ("${label}") הופעל על המסך`
}

// Says text out loud on the PC's speakers, in the assistant's ElevenLabs voice, or Windows' own voice without a key.
export async function speakOnPc(text) {
  const { apiKey, voiceId, ttsModel } = config.elevenlabs
  if (apiKey && voiceId) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, 1000), model_id: ttsModel }),
      signal: AbortSignal.timeout(60000),
    })
    if (res.ok) {
      const file = path.join(os.tmpdir(), `helper-say-${Date.now()}.mp3`)
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
      await ps(`Add-Type -AssemblyName PresentationCore
$p = New-Object System.Windows.Media.MediaPlayer; $p.Open([uri]${lit(file)}); $p.Volume = 1
$n = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $n -lt 50) { Start-Sleep -Milliseconds 100; $n++ }
$p.Play(); Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 300); $p.Close()`, 120000)
      fs.rmSync(file, { force: true })
      return 'נאמר ברמקולים'
    }
  }
  await ps(`Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(${lit(text)})`, 120000)
  return 'נאמר ברמקולים (בקול של Windows)'
}

// ---- power ----

export function power(action, minutes = 0) {
  const seconds = Math.max(0, Math.round(Number(minutes) * 60))
  const note = lit('Helper: המחשב ייכבה. לביטול: כתוב לעוזר "תבטל כיבוי"')
  if (action === 'cancel') return ps('shutdown.exe /a').then(() => 'הכיבוי בוטל', () => 'לא היה כיבוי מתוזמן')
  if (action === 'shutdown') return ps(`shutdown.exe /s /t ${seconds} /c ${note}`).then(() => `המחשב ייכבה ${seconds ? `בעוד ${minutes} דקות` : 'עכשיו'}`)
  if (action === 'restart') return ps(`shutdown.exe /r /t ${seconds} /c ${note}`).then(() => `המחשב יופעל מחדש ${seconds ? `בעוד ${minutes} דקות` : 'עכשיו'}`)
  if (action === 'sleep') return ps(`Start-Sleep -Seconds ${seconds}; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)`, (seconds + 30) * 1000).then(() => 'המחשב נכנס למצב שינה')
  throw new Error(`פעולה לא מוכרת: ${action}`)
}

// ---- files ----

const HOME = os.homedir()
const SEARCH_ROOTS = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive'].map((d) => path.join(HOME, d)).filter((d) => fs.existsSync(d))

export async function findFiles(query, folder) {
  const roots = folder ? [folder] : SEARCH_ROOTS
  const out = await ps(`$r = @(); foreach ($d in @(${roots.map(lit).join(',')})) { $r += Get-ChildItem -LiteralPath $d -Recurse -Filter ${lit(`*${query}*`)} -ErrorAction SilentlyContinue -Depth 6 | Select-Object -First 25 FullName, Length, LastWriteTime }
$r | Sort-Object LastWriteTime -Descending | Select-Object -First 25 | ForEach-Object { "$($_.LastWriteTime.ToString('dd/MM/yy HH:mm'))  $([math]::Round($_.Length / 1KB)) KB  $($_.FullName)" }`, 90000)
  return out || 'לא נמצאו קבצים'
}

const KINDS = {
  'תמונות': ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg'],
  'מסמכים': ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf', 'odt'],
  'וידאו': ['mp4', 'mov', 'mkv', 'avi', 'webm'],
  'מוזיקה': ['mp3', 'wav', 'ogg', 'flac', 'm4a'],
  'ארכיונים': ['zip', 'rar', '7z', 'tar', 'gz'],
  'תוכנות': ['exe', 'msi', 'msix'],
}

// Moves the loose files in Downloads into folders by kind. Folders are left alone, and so is anything changed in the
// last ten minutes, which may still be downloading.
export function organizeDownloads() {
  const dir = path.join(HOME, 'Downloads')
  const moved = {}
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = fs.statSync(full, { throwIfNoEntry: false })
    if (!st?.isFile() || Date.now() - st.mtimeMs < 10 * 60000 || /\.(crdownload|part|tmp)$/i.test(name)) continue
    const ext = path.extname(name).slice(1).toLowerCase()
    const kind = Object.keys(KINDS).find((k) => KINDS[k].includes(ext)) || 'אחר'
    fs.mkdirSync(path.join(dir, kind), { recursive: true })
    let target = path.join(dir, kind, name)
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, kind, `${path.parse(name).name} (${n})${path.extname(name)}`)
    fs.renameSync(full, target)
    moved[kind] = (moved[kind] || 0) + 1
  }
  const total = Object.values(moved).reduce((a, b) => a + b, 0)
  return total ? `הועברו ${total} קבצים: ${Object.entries(moved).map(([k, v]) => `${k} ${v}`).join(', ')}` : 'לא היה מה לסדר'
}

// ---- installs ----

export const wingetSearch = (query) => ps(`winget search ${lit(query)} --accept-source-agreements --disable-interactivity | Select-Object -First 14 | Out-String -Width 160`, 90000)
export const wingetInstall = (id) => ps(`winget install -e --id ${lit(id)} --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Select-Object -Last 6 | Out-String -Width 160`, 600000)

// ---- mouse and keyboard ----

const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, windows: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, delete: 0x2e, del: 0x2e, space: 0x20,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 0x70 + i])),
}
const keyCode = (k) => VK[k] ?? (/^[a-z0-9]$/.test(k) ? k.toUpperCase().charCodeAt(0) : null)

// Runs one action on the real screen. x and y are screen pixels.
export async function act(action) {
  const { type, x, y, text, keys, amount } = action
  const at = Number.isFinite(x) && Number.isFinite(y) ? `[U]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null; Start-Sleep -Milliseconds 80; ` : ''
  if (type === 'click') return ps(`${INPUT} ${at}[U]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [U]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`)
  if (type === 'double_click') return ps(`${INPUT} ${at}1..2 | % { [U]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [U]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }`)
  if (type === 'right_click') return ps(`${INPUT} ${at}[U]::mouse_event(8,0,0,0,[UIntPtr]::Zero); [U]::mouse_event(16,0,0,0,[UIntPtr]::Zero)`)
  if (type === 'move') return ps(`${INPUT} ${at}`)
  if (type === 'scroll') return ps(`${INPUT} ${at}[U]::mouse_event(0x800,0,0,${Math.round(-(Number(amount) || 3) * 120)},[UIntPtr]::Zero)`)
  // Typed through the clipboard and Ctrl+V: the reliable way to enter Hebrew and symbols in any window.
  if (type === 'type') return ps(`${INPUT} Set-Clipboard -Value ${lit(text ?? '')}; Start-Sleep -Milliseconds 80; [U]::Down(0x11); [U]::Tap(0x56); [U]::Up(0x11)`)
  if (type === 'key') {
    const codes = String(keys || '').toLowerCase().split('+').map((k) => k.trim()).filter(Boolean).map(keyCode)
    if (!codes.length || codes.includes(null)) throw new Error(`מקש לא מוכר: ${keys}`)
    const mods = codes.slice(0, -1)
    const main = codes.at(-1)
    return ps(`${INPUT} ${mods.map((c) => `[U]::Down(${c}); `).join('')}[U]::Tap(${main}); ${mods.reverse().map((c) => `[U]::Up(${c}); `).join('')}`)
  }
  if (type === 'wait') return new Promise((r) => setTimeout(r, Math.min(10, Number(amount) || 2) * 1000))
  throw new Error(`פעולה לא מוכרת: ${type}`)
}

// ---- security, webcam & screen recording ----

export async function webcamSnap(deviceName) {
  const tmpFile = path.join(os.tmpdir(), `helper-webcam-${Date.now()}.jpg`)
  const cam = deviceName || 'Logitech Webcam C925e'
  return new Promise((resolve, reject) => {
    execFile('ffmpeg.exe', ['-y', '-f', 'dshow', '-i', `video=${cam}`, '-vframes', '1', tmpFile], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !fs.existsSync(tmpFile)) {
        return reject(new Error(`שגיאה בצילום ממצלמת הרשת: ${(stderr || err.message).slice(-200)}`))
      }
      resolve({ file: tmpFile })
    })
  })
}

export async function screenRecord(seconds = 3, maxWidth = 1000) {
  const sec = Math.min(10, Math.max(1, Number(seconds) || 3))
  const dir = path.join(os.tmpdir(), `helper-rec-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  const frameCount = sec * 2
  const delayMs = Math.round(1000 / 2)
  try {
    for (let i = 0; i < frameCount; i++) {
      const shot = await screenshot(maxWidth)
      fs.copyFileSync(shot.file, path.join(dir, `frame_${i}.png`))
      fs.rmSync(shot.file, { force: true })
      if (i < frameCount - 1) await new Promise((r) => setTimeout(r, delayMs))
    }
    const outMp4 = path.join(os.tmpdir(), `helper-screen-${Date.now()}.mp4`)
    await new Promise((resolve, reject) => {
      execFile('ffmpeg.exe', ['-y', '-framerate', '2', '-i', path.join(dir, 'frame_%d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outMp4], { timeout: 30000, windowsHide: true }, (err) => {
        if (err || !fs.existsSync(outMp4)) return reject(new Error('שגיאה ביצירת סרטון המסך'))
        resolve()
      })
    })
    return { file: outMp4 }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export async function topProcesses(count = 10) {
  const c = Math.min(30, Math.max(1, Number(count) || 10))
  const json = await ps(`Get-Process | Where-Object { $_.WorkingSet64 -gt 20MB } | Sort-Object WorkingSet64 -Descending | Select-Object -First ${c} Id, ProcessName, @{N='MemoryMB';E={[math]::Round($_.WorkingSet64 / 1MB)}}, @{N='CpuSeconds';E={[math]::Round($_.CPU, 1)}}, MainWindowTitle | ConvertTo-Json -Compress`)
  const list = json ? [].concat(JSON.parse(json)) : []
  return list
}

export async function killProcess(idOrName) {
  const val = String(idOrName).trim()
  if (/^\d+$/.test(val)) {
    await ps(`Stop-Process -Id ${val} -Force -ErrorAction Stop`)
    return `תהליך מספר ${val} נסגר בכוח`
  }
  const name = val.replace(/\.exe$/i, '')
  await ps(`Stop-Process -Name ${lit(name)} -Force -ErrorAction Stop`)
  return `תהליך ${name} נסגר בכוח`
}

export function resolveFile(query) {
  const raw = String(query).trim().replace(/^['"]|['"]$/g, '')
  if (fs.existsSync(raw) && fs.statSync(raw).isFile()) return raw

  for (const root of SEARCH_ROOTS) {
    const candidate = path.join(root, raw)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }

  const cleanQ = path.basename(raw).toLowerCase()
  let best = null
  let bestMtime = 0
  for (const root of [path.join(HOME, 'Downloads'), path.join(HOME, 'Desktop'), path.join(HOME, 'Documents')]) {
    if (!fs.existsSync(root)) continue
    try {
      const files = fs.readdirSync(root, { withFileTypes: true, recursive: true })
      for (const f of files) {
        if (!f.isFile()) continue
        const full = path.join(f.parentPath || f.path || root, f.name)
        if (f.name.toLowerCase().includes(cleanQ)) {
          const st = fs.statSync(full, { throwIfNoEntry: false })
          if (st && st.mtimeMs > bestMtime) {
            bestMtime = st.mtimeMs
            best = full
          }
        }
      }
    } catch {}
  }
  return best
}

// ---- browser tabs ----

const BROWSER_DEBUG_PORTS = [9222, 9223]

export async function getBrowserTabs() {
  const tabs = []
  for (const port of BROWSER_DEBUG_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) continue
      const list = await res.json()
      for (const item of list) {
        if (item.type === 'page' && item.url && !item.url.startsWith('devtools://')) {
          tabs.push({
            id: item.id,
            port,
            title: item.title || 'ללא כותרת',
            url: item.url,
          })
        }
      }
    } catch {}
  }
  return tabs
}

export async function closeBrowserTab(idOrQuery) {
  const q = String(idOrQuery || '').trim().toLowerCase()
  if (q) {
    const tabs = await getBrowserTabs()
    const match = tabs.find((t) => t.id === q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q))
    if (match) {
      await fetch(`http://127.0.0.1:${match.port}/json/close/${match.id}`).catch(() => {})
      return `הלשונית "${match.title}" נסגרה בהצלחה`
    }
  }
  await act({ type: 'key', keys: 'ctrl+w' })
  return 'נשלחה פקודת סגירת לשונית (Ctrl+W) לחלון הפעיל'
}

export async function openBrowserTab(url) {
  const u = String(url || 'https://www.google.com').trim()
  for (const port of BROWSER_DEBUG_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(u)}`, { method: 'PUT', signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        return `נפתחה לשונית חדשה בדפדפן: ${u}`
      }
    } catch {}
  }
  await ps(`Start-Process ${lit(u)}`)
  return `נפתח בדפדפן: ${u}`
}

export async function activateBrowserTab(idOrQuery) {
  const q = String(idOrQuery || '').trim().toLowerCase()
  const tabs = await getBrowserTabs()
  const match = tabs.find((t) => t.id === q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q))
  if (!match) return `לא נמצאה לשונית שמתאימה ל-"${idOrQuery}"`
  await fetch(`http://127.0.0.1:${match.port}/json/activate/${match.id}`).catch(() => {})
  return `הלשונית "${match.title}" הועברה לקדמת המסך`
}
