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
  'זום': 'zoom', 'טימס': 'teams', 'teams': 'teams',
  'וורד': 'word', 'word': 'word', 'אקסל': 'excel', 'excel': 'excel', 'פאוורפוינט': 'powerpoint', 'אאוטלוק': 'outlook',
  'פנקס רשימות': 'notepad', 'נוטפד': 'notepad', 'notepad': 'notepad',
  'מחשבון': 'calculator', 'calculator': 'calculator',
  'סייר הקבצים': 'file explorer', 'סייר קבצים': 'file explorer', 'הקבצים': 'file explorer', 'explorer': 'file explorer',
  'הגדרות': 'settings', 'הגדרות המחשב': 'settings', 'settings': 'settings',
  'טרמינל': 'terminal', 'terminal': 'terminal', 'פאוורשל': 'powershell', 'cmd': 'command prompt',
  'וי אס קוד': 'visual studio code', 'ויז׳ואל סטודיו קוד': 'visual studio code', 'vscode': 'visual studio code', 'vs code': 'visual studio code',
  'קלוד': 'claude', 'claude': 'claude', 'צ׳אט ג׳יפיטי': 'chatgpt', 'chatgpt': 'chatgpt',
  'סטרים דק': 'stream deck', 'אובס': 'obs', 'obs': 'obs', 'vlc': 'vlc', 'וי אל סי': 'vlc',
  'צייר': 'paint', 'פיינט': 'paint', 'כלי חיתוך': 'snipping tool', 'מצלמה': 'camera', 'תמונות': 'photos',
  'חנות': 'microsoft store', 'מנהל המשימות': 'task manager', 'לוח הבקרה': 'control panel',
}

/** The words to look for: the alias when there is one, else what was said. */
function wanted(name) {
  const n = String(name).trim().toLowerCase().replace(/^(את |ה)(?=\S{3,})/, '')
  return ALIASES[n] || ALIASES[String(name).trim().toLowerCase()] || n
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

/** The best Start menu entry for a spoken name, or null. Exact, then whole word, then substring; uninstallers never. */
function find(name) {
  const w = wanted(name)
  if (!w) return null
  const lower = (s) => s.toLowerCase()
  const usable = apps.filter((a) => !/uninstall|הסרת|readme|help|documentation|release notes/i.test(a.name))
  return usable.find((a) => lower(a.name) === w)
    || usable.find((a) => new RegExp('(^|\\s)' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)', 'i').test(a.name))
    || usable.find((a) => lower(a.name).includes(w))
    || null
}

/** Starts an app by its Start menu entry (desktop programs and Store apps alike). */
function launch(app) {
  const child = spawn('explorer.exe', ['shell:AppsFolder\\' + app.id], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

/** Does this window belong to the app with this spoken name? By process name or title. */
function windowMatches(win, name) {
  const w = wanted(name)
  const app = (win.app || '').toLowerCase()
  const title = (win.title || '').toLowerCase()
  if (!w) return false
  const first = w.split(' ')[0]
  if (app === w || app.includes(first) || (w === 'file explorer' && app === 'explorer')) return true
  if (w === 'visual studio code' && app === 'code') return true
  if (w === 'terminal' && /windowsterminal|wt/.test(app)) return true
  return title.includes(w) || (first.length > 3 && title.includes(first))
}

module.exports = { init, refresh, find, launch, windowMatches, wanted, list: () => apps }
