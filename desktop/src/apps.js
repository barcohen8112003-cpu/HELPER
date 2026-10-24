// The apps on this PC, from the Start menu (Get-StartApps lists desktop and Store apps alike), with Hebrew and short
// names for the common ones. Read once at startup and cached on disk, so a launch never waits for PowerShell.
'use strict'
const fs = require('fs')
const path = require('path')
const { execFile, spawn } = require('child_process')

let apps = []
let cacheFile = null

/** Hebrew and everyday names → words in the app's real name (or its window's process name). */
const ALIASES = {
  'כרום': 'chrome', 'גוגל כרום': 'chrome', 'דפדפן': 'chrome', 'chrome': 'chrome',
  'אדג': 'edge', 'אדג׳': 'edge', 'edge': 'edge',
  'ספוטיפיי': 'spotify', 'ספוטיפי': 'spotify', 'spotify': 'spotify',
  'וואטסאפ': 'whatsapp', 'ווטסאפ': 'whatsapp', 'וואצאפ': 'whatsapp', 'whatsapp': 'whatsapp',
  'דיסקורד': 'discord', 'discord': 'discord',
  'סטים': 'steam', 'steam': 'steam',
  'טלגרם': 'telegram', 'telegram': 'telegram',
  'טימס': 'teams', 'teams': 'teams',
  'וורד': 'word', 'word': 'word', 'אקסל': 'excel', 'excel': 'excel', 'פאוורפוינט': 'powerpoint', 'אאוטלוק': 'outlook',
  'פנקס רשימות': ['פנקס רשימות', 'notepad'], 'נוטפד': ['פנקס רשימות', 'notepad'], 'notepad': ['notepad', 'פנקס רשימות'],
  'מחשבון': ['מחשבון', 'calculator'], 'calculator': ['calculator', 'מחשבון'],
  'סייר הקבצים': ['סייר הקבצים', 'file explorer'], 'סייר קבצים': ['סייר הקבצים', 'file explorer'], 'הקבצים': ['סייר הקבצים', 'file explorer'], 'explorer': ['file explorer', 'סייר הקבצים'],
  'הגדרות': ['הגדרות', 'settings'], 'הגדרות המחשב': ['הגדרות', 'settings'], 'settings': ['settings', 'הגדרות'],
  'טרמינל': ['מסוף', 'terminal'], 'terminal': ['terminal', 'מסוף'], 'פאוורשל': 'windows powershell', 'cmd': ['שורת הפקודה', 'command prompt'], 'שורת הפקודה': ['שורת הפקודה', 'command prompt'],
  'וי אס קוד': 'visual studio code', 'ויז׳ואל סטודיו קוד': 'visual studio code', 'vscode': 'visual studio code', 'vs code': 'visual studio code',
  'קלוד': 'claude', 'claude': 'claude', 'צ׳אט ג׳יפיטי': 'chatgpt', 'chatgpt': 'chatgpt',
  'סטרים דק': 'stream deck', 'אובס': 'obs', 'obs': 'obs', 'vlc': 'vlc', 'וי אל סי': 'vlc',
  'צייר': ['צייר', 'paint'], 'פיינט': ['צייר', 'paint'], 'כלי חיתוך': ['כלי החיתוך', 'snipping tool'], 'מצלמה': ['מצלמה', 'camera'], 'תמונות': ['תמונות', 'photos'],
  'חנות': 'microsoft store', 'מנהל המשימות': ['מנהל המשימות', 'task manager'], 'לוח הבקרה': ['לוח הבקרה', 'control panel'],
  'סטרימיו': 'stremio', 'stremio': 'stremio', 'נטפליקס': 'netflix', 'פיירפוקס': 'firefox', 'אופרה': 'opera',
  'קרסר': 'cursor', 'cursor': 'cursor', 'אנדרואיד סטודיו': 'android studio', 'ווינראר': 'winrar', 'פוטפלייר': 'potplayer',
  'אפיק': 'epic games launcher', 'אפיק גיימס': 'epic games launcher', 'ריוט': 'riot client', 'ולורנט': 'valorant', 'מיינקראפט': 'minecraft launcher',
  'רובלוקס': 'roblox', 'אקסבוקס': 'xbox', 'אנידסק': 'anydesk', 'טייל סקייל': 'tailscale', 'אולמה': 'ollama', 'ג׳מיני': 'gemini', 'גמיני': 'gemini',
  'וויס מוד': 'voicemod', 'סאונדפד': 'soundpad', 'קאפקאט': 'capcut', 'טיקטוק לייב': 'tiktok live studio', 'וולפייפר אנג׳ין': 'wallpaper engine',
  'לוח שנה': 'לוח שנה', 'יומן': 'לוח שנה', 'דואר': 'דואר', 'מייל': 'outlook', 'זום': 'zoom workplace',
}

/** The names to look for, best first: the alias's when there is one, then what was said. */
function wanted(name) {
  const raw = String(name).trim().toLowerCase()
  const n = raw.replace(/^(את |ה)(?=\S{3,})/, '')
  const a = ALIASES[n] || ALIASES[raw]
  return [...new Set([...(a ? [].concat(a) : []), n])]
}

function init(dataDir) {
  cacheFile = path.join(dataDir, 'apps.json')
  try { apps = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } catch { apps = [] }
  refresh()
}

function refresh() {
  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 8 << 20, timeout: 30000 }, (err, out) => {
    if (err || !out) return
    try {
      const list = JSON.parse(out)
      apps = (Array.isArray(list) ? list : [list]).filter((a) => a && a.Name && a.AppID).map((a) => ({ name: a.Name, id: a.AppID }))
      fs.writeFileSync(cacheFile, JSON.stringify(apps))
    } catch { /* keep the cache */ }
  })
}

const plain = (s) => String(s || '').replace(/[‎‏‪-‮]/g, '').trim().toLowerCase()
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The best Start menu entry for a spoken name, or null. Windows lists its own apps in Hebrew here ("מחשבון") and
 * the rest by their English names ("Spotify"), so the words as said are tried first, then the alias.
 * Exact, then whole word, then substring; uninstallers, manuals and web links never.
 */
function find(name) {
  const said = plain(name).replace(/^(את |ה)(?=\S{3,})/, '')
  const tries = [...new Set([plain(name), said, ...wanted(name).map(plain)].filter(Boolean))]
  const usable = apps.filter((a) => !/uninstall|הסרת|readme|help|manual|documentation|release notes|web site|website|faq|support|license|רישיון|מדריך|reset preferences|skinned|updater|error reporter|installer|setup/i.test(a.name))
  const word = (w) => new RegExp('(^|\\s)' + escape(w) + '(\\s|$|[™®])', 'i')
  // Exact for every name first, then whole words, and only then parts of words: "סטים" must never find "הטקסטים".
  for (const w of tries) { const hit = usable.find((a) => plain(a.name) === w); if (hit) return hit }
  for (const w of tries) { const hit = usable.find((a) => word(w).test(plain(a.name))); if (hit) return hit }
  for (const w of tries) {
    if (w.length < 4 || /[\u0590-\u05FF]/.test(w)) continue   // parts of Hebrew words mislead
    const hit = usable.find((a) => plain(a.name).includes(w))
    if (hit) return hit
  }
  return null
}

/** Starts an app by its Start menu entry (desktop programs and Store apps alike). */
function launch(app) {
  // No windowsHide: explorer passes it on, and the app would start hidden (or a Store app not at all).
  const child = spawn('explorer.exe', ['shell:AppsFolder\\' + app.id], { detached: true, stdio: 'ignore' })
  child.unref()
}

/** Does this window belong to the app with this spoken name? By process name or title. */
function windowMatches(win, name) {
  const app = (win.app || '').toLowerCase()
  const title = plain(win.title)
  for (const w of wanted(name).map(plain)) {
    if (!w) continue
    const first = w.split(' ')[0]
    if (app === w || app === first || (first.length > 3 && /^[a-z]/.test(first) && app.includes(first))) return true
    if ((w === 'file explorer' || w === 'סייר הקבצים') && app === 'explorer') return true
    if (w === 'visual studio code' && app === 'code') return true
    if ((w === 'terminal' || w === 'מסוף') && /windowsterminal/.test(app)) return true
    if ((w === 'calculator' || w === 'מחשבון') && /calculator/.test(app)) return true
    if ((w === 'notepad' || w === 'פנקס רשימות') && app === 'notepad') return true
    if (w.length > 3 && title.includes(w)) return true
  }
  return false
}

module.exports = { init, refresh, find, launch, windowMatches, wanted, list: () => apps }
