// Inside a window: its buttons, fields, links, tabs and menu items by name, through Windows UI Automation (uia.ps1,
// one PowerShell kept running). "Press Save", "write in the search box", "switch to the YouTube tab" become a control
// found by its label, so HELPER acts inside apps without guessing pixels. No Electron here: tests run it in Node.
'use strict'
const path = require('path')
const { spawn } = require('child_process')

const SCRIPT = path.join(__dirname, 'uia.ps1')
const TIMEOUT_MS = 12000

let child = null
let buf = ''
let seq = 0
const waiting = new Map()

function startWorker() {
  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line.replace(/^﻿/, '')) } catch { continue }
      const w = waiting.get(msg.id)
      if (w) { waiting.delete(msg.id); clearTimeout(w.timer); w.resolve(msg) }
    }
  })
  child.stderr.on('data', () => { })
  const me = child
  child.on('exit', () => {
    if (child === me) child = null
    for (const [id, w] of waiting) { clearTimeout(w.timer); w.reject(new Error('UI Automation stopped')); waiting.delete(id) }
  })
}

/** One request to the worker; a stuck one (an app that hangs) restarts it. */
function call(req, ms = TIMEOUT_MS) {
  if (!child) startWorker()
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      try { child && child.kill() } catch { }
      child = null
      reject(new Error('החלון לא ענה בזמן'))
    }, ms)
    waiting.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify(Object.assign({ id }, req)) + '\n', 'utf8')
  }).then((r) => {
    if (!r.ok) throw new Error(r.error || 'failed')
    return r
  })
}

const hwndNum = (hwnd) => (typeof hwnd === 'number' || typeof hwnd === 'string' ? String(hwnd) : String(require('koffi').address(hwnd)))

/** The controls of a window: [{i, type, name, id, enabled, off, x, y, w, h, value}]. */
async function list(hwnd, { types, max } = {}) {
  const r = await call({ op: 'list', hwnd: hwndNum(hwnd), types, max })
  return Array.isArray(r.items) ? r.items : r.items ? [r.items] : []
}
const act = (hwnd, i) => call({ op: 'act', hwnd: hwndNum(hwnd), i })
const focus = (hwnd, i) => call({ op: 'focus', hwnd: hwndNum(hwnd), i })
const setValue = (hwnd, i, text) => call({ op: 'set', hwnd: hwndNum(hwnd), i, text })
async function read(hwnd, max = 6000) {
  const t = (await call({ op: 'read', hwnd: hwndNum(hwnd), max }, 15000)).text || ''
  // Web pages mark each picture and widget with U+FFFC: dropped, with the blank lines they leave.
  return t.replace(/￼/g, '').replace(/[‎‏‪-‮⁦-⁩]/g, '').split(/\r\n|\r|\n/)   // Notepad ends a line with a bare \r
    .map((l) => l.trim()).filter((l) => l && l !== 'tooltip').join('\n')
}
/** Starts the worker ahead of the first ask, so that one is quick too. */
const warm = () => call({ op: 'ping' }, 20000).catch(() => { })
const stop = () => { if (child) { try { child.kill() } catch { } child = null } }

// ---- finding a control by what the user called it -------------------------------------------------

/** The kinds a user names: "הכפתור", "השדה", "הקישור", "הטאב", "התפריט". */
const KIND_TYPES = {
  button: ['Button', 'SplitButton', 'MenuItem', 'Hyperlink', 'CheckBox', 'RadioButton', 'ListItem', 'TabItem'],
  field: ['Edit', 'ComboBox', 'Document'],
  link: ['Hyperlink'],
  tab: ['TabItem'],
  menu: ['MenuItem'],
  checkbox: ['CheckBox', 'RadioButton'],
  item: ['ListItem', 'TreeItem', 'DataItem'],
}

/** Words the same control is called in the other language, or in other words. */
const SAME = [
  ['שמור', 'שמירה', 'save'], ['שמור בשם', 'save as'], ['שלח', 'שליחה', 'send'], ['ביטול', 'בטל', 'cancel'], ['אישור', 'אשר', 'אוקיי', 'ok'],
  ['חפש', 'חיפוש', 'search', 'find'], ['סגור', 'סגירה', 'close'], ['הבא', 'המשך', 'next', 'continue'], ['הקודם', 'חזור', 'חזרה', 'back', 'previous'],
  ['כן', 'yes'], ['לא', 'no'], ['מחק', 'מחיקה', 'delete', 'remove'], ['העתק', 'העתקה', 'copy'], ['הדבק', 'הדבקה', 'paste'], ['גזור', 'cut'],
  ['הוסף', 'הוספה', 'add'], ['חדש', 'new'], ['פתח', 'פתיחה', 'open'], ['הגדרות', 'settings', 'options'], ['התחבר', 'התחברות', 'כניסה', 'sign in', 'log in', 'login'],
  ['הרשמה', 'הירשם', 'sign up', 'subscribe'], ['שתף', 'שיתוף', 'share'], ['הורד', 'הורדה', 'download'], ['העלה', 'העלאה', 'upload'],
  ['נגן', 'הפעל', 'play'], ['השהה', 'עצור', 'pause'], ['לייק', 'אהבתי', 'like'], ['קובץ', 'file'], ['עריכה', 'ערוך', 'edit'], ['תצוגה', 'view'],
  ['עזרה', 'help'], ['הדפס', 'הדפסה', 'print'], ['רענן', 'refresh', 'reload'], ['בית', 'home'], ['תפריט', 'menu', 'more options', 'עוד אפשרויות'],
  ['מזער', 'minimize'], ['הגדל', 'maximize'], ['שווה', 'equals', '='], ['פלוס', 'ועוד', 'plus', '+'], ['מינוס', 'פחות', 'minus', '-'],
  ['כפול', 'כפל', 'multiply by', 'times', '×'], ['חלקי', 'חילוק', 'divide by', '÷'], ['נקה', 'clear', 'c'], ['הודעה', 'message'], ['צרף', 'attach'],
  ['שורת הכתובת', 'כתובת', 'address and search bar', 'address bar'], ['תשובה', 'השב', 'reply'], ['העבר', 'forward'], ['ארכיון', 'archive'],
  // Names of sites and apps, the way they are said and the way they are written.
  ['יוטיוב', 'youtube'], ['יוטיוב מיוזיק', 'youtube music'], ['טיקטוק', 'tiktok'], ['ג׳ימייל', 'גימייל', 'גמייל', 'gmail'], ['וואטסאפ', 'ווטסאפ', 'whatsapp'],
  ['גוגל', 'google'], ['פייסבוק', 'facebook'], ['אינסטגרם', 'instagram'], ['ספוטיפיי', 'spotify'], ['נטפליקס', 'netflix'], ['גיטהאב', 'github'],
  ['קיק', 'kick'], ['טוויטר', 'twitter'], ['ג׳מיני', 'גמיני', 'gemini', 'google gemini'], ['צאט גיפיטי', 'צ׳אט גי פי טי', 'chatgpt'], ['קלוד', 'claude'],
  ['דיסקורד', 'discord'], ['וויינט', 'ווינט', 'ynet'], ['טוויץ', 'טוויץ׳', 'twitch'], ['רדיט', 'reddit'], ['אמזון', 'amazon'], ['ויקיפדיה', 'wikipedia'],
  ['לינקדאין', 'linkedin'], ['טלגרם', 'telegram'], ['אאוטלוק', 'outlook'], ['דרייב', 'drive'], ['יומן', 'calendar'], ['מפות', 'maps'],
]
const NUMBERS = [
  ['0', 'אפס', 'zero'], ['1', 'אחת', 'אחד', 'one'], ['2', 'שתיים', 'שניים', 'two'], ['3', 'שלוש', 'שלושה', 'three'], ['4', 'ארבע', 'ארבעה', 'four'],
  ['5', 'חמש', 'חמישה', 'five'], ['6', 'שש', 'שישה', 'six'], ['7', 'שבע', 'שבעה', 'seven'], ['8', 'שמונה', 'eight'], ['9', 'תשע', 'תשעה', 'nine'],
]

const norm = (s) => String(s || '').toLowerCase()
  .replace(/[֑-ׇ]/g, '')             // niqqud
  .replace(/[‎‏‪-‮⁦-⁩]/g, '')
  .replace(/[״"'`׳]/g, '')
  .replace(/\s*\(.*?\)\s*/g, ' ')              // "Save (Ctrl+S)"
  .replace(/[.:…,!?]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

/** "את הכפתור שמור" → "שמור": the words around a name that are not the name. */
function bare(s) {
  return norm(s)
    .replace(/^(על|את|ב|ל)\s+/, '')
    .replace(/^(ה)?(כפתור|לחצן|שדה|תיבת|תיבה|קישור|לינק|טאב|כרטיסייה|כרטיסיית|תפריט|אפשרות|סימון|button|field|link|tab|menu|the)\s+/, '')
    .replace(/^של\s+/, '')
    .trim()
}

/** The ways the user's word could be written on a control: itself, its translation, the digit for a number word. */
function variants(q) {
  const n = norm(q)
  const out = new Set([n])
  if (/^ה\S{2,}/.test(n)) out.add(n.slice(1))
  for (const group of SAME.concat(NUMBERS)) {
    if (group.includes(n) || group.includes(n.replace(/^ה/, ''))) group.forEach((g) => out.add(g))
  }
  return [...out].filter(Boolean)
}

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

/** How well a control's name fits what was asked, 0 for not at all. */
function score(item, wants) {
  const name = norm(item.name)
  const id = norm(item.id)
  const value = norm(item.value)
  let best = 0
  for (const w of wants) {
    if (!w) continue
    if (name === w) best = Math.max(best, 100)
    // A browser tab ends with its site ("… - YouTube"): that site, named, is this tab.
    else if (name.includes(' - ') && name.split(' - ').some((part) => part.trim() === w)) best = Math.max(best, 85)
    else if (id && id === w.replace(/\s+/g, '')) best = Math.max(best, 90)
    else if (w.length >= 2 && name.startsWith(w + ' ')) best = Math.max(best, 80)
    else if (w.length >= 3 && new RegExp('(^|\\s)' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)').test(name)) best = Math.max(best, 70)
    else if (w.length >= 3 && name.includes(w)) best = Math.max(best, 55 - Math.min(20, Math.floor((name.length - w.length) / 8)))
    else if (w.length >= 4 && name.length <= 40 && lev(name, w) <= (w.length >= 7 ? 2 : 1)) best = Math.max(best, 50)
    else if (value && w.length >= 3 && value.includes(w)) best = Math.max(best, 35)
  }
  return best
}

/**
 * The control that fits a name best, or null. kind narrows it ("button", "field", "tab"...). Enabled, visible
 * controls win ties; with the same score, the first on the window (top, then left) wins.
 */
function match(items, query, kind) {
  const q = bare(query)
  const types = kind && KIND_TYPES[kind]
  const pool = (items || []).filter((it) => !types || types.includes(it.type))
  if (!q) return null
  const wants = variants(q)
  let best = null, bestScore = 0
  for (const it of pool) {
    let s = score(it, wants)
    if (!s) continue
    if (it.enabled === false) s -= 25
    if (it.off) s -= 15
    if (it.type === 'Document' || it.type === 'Text') s -= 10
    if (s > bestScore) { best = it; bestScore = s }
  }
  return bestScore >= 30 ? best : null
}

/** The field to write in when none was named: the focused one is not known here, so a search box, then the first edit. */
function defaultField(items) {
  const edits = (items || []).filter((it) => (it.type === 'Edit' || it.type === 'ComboBox') && it.enabled !== false && !it.off)
  return edits.find((it) => /search|חיפוש|חפש|כתובת|address|message|הודעה|הקלד|type/i.test(it.name + ' ' + it.id)) || edits[0]
    || (items || []).find((it) => it.type === 'Document' && !it.off) || null
}

const TYPE_WORDS = {
  Button: 'כפתור', SplitButton: 'כפתור', Edit: 'שדה', Hyperlink: 'קישור', MenuItem: 'תפריט', TabItem: 'טאב', ListItem: 'פריט',
  CheckBox: 'תיבת סימון', ComboBox: 'רשימה', RadioButton: 'בחירה', TreeItem: 'פריט', DataItem: 'שורה', Slider: 'מחוון', Document: 'מסמך',
}

/** The controls in short lines for Claude: "כפתור: שמור", "שדה: חיפוש = (ריק)". Off-screen ones last, capped. */
function describe(items, cap = 120) {
  const seen = new Set()
  const lines = []
  const sorted = (items || []).slice().sort((a, b) => Number(Boolean(a.off)) - Number(Boolean(b.off)))
  for (const it of sorted) {
    const key = it.type + '|' + it.name
    if (seen.has(key)) continue
    seen.add(key)
    let line = `${TYPE_WORDS[it.type] || it.type}: ${it.name || '(בלי שם)'}`
    if (it.type === 'Edit' || it.type === 'ComboBox') line += ` = ${it.value ? it.value : '(ריק)'}`
    if (it.enabled === false) line += ' (לא פעיל)'
    if (it.off) line += ' (לא בתצוגה)'
    lines.push(line)
    if (lines.length >= cap) { lines.push(`…ועוד ${sorted.length - cap}`); break }
  }
  return lines.join('\n')
}

module.exports = { list, act, focus, setValue, read, warm, stop, match, defaultField, describe, bare, variants, norm, KIND_TYPES }
