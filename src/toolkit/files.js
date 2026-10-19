// Notes and data files, strictly inside one sandbox folder: <DATA_DIR>/workspace. Names are flat (no folders at all),
// extensions are allow-listed, symlinks are refused, and sizes/counts are capped. Nothing here executes, downloads or
// reads anything outside the sandbox.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.js'
import { str, num, obj, clip, lines, need, toNumber } from './_kit.js'

export const category = 'files'
export const blurb = 'הערות וקבצי נתונים בתיקייה בטוחה'

const SANDBOX = path.join(DATA_DIR, 'workspace')
const ALLOWED_EXT = new Set(['.txt', '.md', '.csv', '.json', '.log', '.ics'])
const MAX_FILE = 200 * 1024
const MAX_TOTAL = 20 * 1024 * 1024
const MAX_COUNT = 500
const MAX_NAME = 120
const RESERVED = /^(con|prn|aux|nul|clock\$|com[0-9¹²³]|lpt[0-9¹²³])$/i

function sandbox() {
  fs.mkdirSync(SANDBOX, { recursive: true })
  const st = fs.lstatSync(SANDBOX)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('תיקיית העבודה לא תקינה')
  return SANDBOX
}

// Validates a flat file name and returns its absolute path inside the sandbox.
function resolveName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('חסר שם קובץ')
  if (name.includes('\0')) throw new Error('שם קובץ לא תקין')
  if (name.length > MAX_NAME) throw new Error('שם הקובץ ארוך מדי')
  if (/[\x00-\x1f]/.test(name)) throw new Error('שם קובץ לא תקין')
  if (/[\\/]/.test(name)) throw new Error('שם קובץ חייב להיות בלי תיקיות או נתיבים')
  if (name.includes(':')) throw new Error('תו ":" אסור בשם קובץ')
  if (/[<>"|?*]/.test(name)) throw new Error('שם קובץ מכיל תווים אסורים')
  if (name.includes('..') || name.startsWith('.') || name.endsWith('.') || name !== name.trim()) throw new Error('שם קובץ לא תקין')
  const ext = path.extname(name).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) throw new Error(`סיומת לא מותרת. מותר: ${[...ALLOWED_EXT].join(' ')}`)
  const stem = name.slice(0, name.length - ext.length)
  if (!stem) throw new Error('שם קובץ לא תקין')
  if (RESERVED.test(stem.split('.')[0].trim())) throw new Error('שם שמור של המערכת, בחר שם אחר')
  const base = sandbox()
  const full = path.resolve(base, name)
  if (!full.startsWith(base + path.sep) || full === base || path.dirname(full) !== base) throw new Error('הנתיב יוצא מתיקיית העבודה')
  return full
}

// lstat that refuses symlinks. Returns null when the file does not exist.
function statSafe(full) {
  let st
  try {
    st = fs.lstatSync(full)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw new Error('לא ניתן לגשת לקובץ')
  }
  if (st.isSymbolicLink()) throw new Error('קישורים סמליים אסורים')
  if (!st.isFile()) throw new Error('זה לא קובץ רגיל')
  const real = fs.realpathSync(full)
  const realBase = fs.realpathSync(SANDBOX)
  if (!real.startsWith(realBase + path.sep)) throw new Error('הנתיב יוצא מתיקיית העבודה')
  return st
}

function allFiles() {
  const base = sandbox()
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isFile() && ALLOWED_EXT.has(path.extname(d.name).toLowerCase()))
    .map((d) => {
      const st = fs.lstatSync(path.join(base, d.name))
      return { name: d.name, size: st.size, mtime: st.mtime }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function readText(name) {
  const full = resolveName(name)
  const st = statSafe(full)
  if (!st) throw new Error(`הקובץ "${name}" לא נמצא`)
  if (st.size > MAX_FILE) throw new Error('הקובץ גדול מדי')
  return fs.readFileSync(full, 'utf8')
}

function writeText(name, text) {
  const full = resolveName(name)
  const data = String(text ?? '')
  const bytes = Buffer.byteLength(data, 'utf8')
  if (bytes > MAX_FILE) throw new Error('הקובץ יהיה גדול מ-200KB')
  const existing = statSafe(full)
  const files = allFiles()
  if (!existing && files.length >= MAX_COUNT) throw new Error('יותר מדי קבצים בתיקייה (500)')
  const total = files.reduce((s, f) => s + f.size, 0) - (existing?.size ?? 0) + bytes
  if (total > MAX_TOTAL) throw new Error('התיקייה תעבור 20MB')
  fs.writeFileSync(full, data, 'utf8')
  return bytes
}

const lineList = (text) => text.split(/\r?\n/)
const fmtDate = (d) => d.toISOString().slice(0, 16).replace('T', ' ')

// ---- CSV ----
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let q = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

const csvCell = (v) => (/[",\n\r]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'

function loadCsv(name) {
  const rows = parseCsv(readText(name))
  if (!rows.length) throw new Error('הקובץ ריק')
  return { header: rows[0], body: rows.slice(1) }
}

function colIndex(header, column) {
  const c = String(need(column, 'עמודה')).trim()
  let i = header.findIndex((h) => h.trim().toLowerCase() === c.toLowerCase())
  if (i < 0 && /^\d+$/.test(c)) i = Number(c) - 1
  if (i < 0 || i >= header.length) throw new Error(`העמודה "${c}" לא נמצאה`)
  return i
}

// ---- JSON paths ----
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
function pathParts(p) {
  const parts = String(need(p, 'נתיב'))
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((x) => x !== '')
  if (!parts.length) throw new Error('נתיב ריק')
  for (const k of parts) if (BAD_KEYS.has(k)) throw new Error('מפתח אסור בנתיב')
  return parts
}

// ---- ICS ----
function parseIcs(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '')
  const events = []
  let cur = null
  for (const raw of lineList(unfolded)) {
    const line = raw.trim()
    if (line === 'BEGIN:VEVENT') cur = {}
    else if (line === 'END:VEVENT') {
      if (cur) events.push(cur)
      cur = null
    } else if (cur) {
      const i = line.indexOf(':')
      if (i < 0) continue
      const key = line.slice(0, i).split(';')[0].toUpperCase()
      const val = line.slice(i + 1).replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1')
      if (['SUMMARY', 'DTSTART', 'DTEND', 'LOCATION'].includes(key)) cur[key] = val
    }
  }
  return events
}

function icsDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/.exec(v ?? '')
  if (!m) return v ?? ''
  return m[4] ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`
}

const NAME = str('שם הקובץ בלי תיקיות, למשל notes.txt (סיומות: txt md csv json log ics)')

export const tools = [
  {
    name: 'files_write',
    description: 'יוצר או מחליף קובץ טקסט בתיקיית העבודה של Helper.',
    parameters: obj({ name: NAME, content: str('התוכן') }),
    run({ name, content }) {
      const n = writeText(name, need(content, 'תוכן'))
      return `נשמר ${name} (${n} בתים)`
    },
  },
  {
    name: 'files_append',
    description: 'מוסיף טקסט לסוף קובץ (נוצר אם לא קיים), בשורה חדשה.',
    parameters: obj({ name: NAME, content: str('הטקסט להוספה') }),
    run({ name, content }) {
      need(content, 'תוכן')
      const full = resolveName(name)
      const old = statSafe(full) ? readText(name) : ''
      const sep = old && !old.endsWith('\n') ? '\n' : ''
      const n = writeText(name, `${old}${sep}${content}\n`)
      return `נוסף ל-${name} (עכשיו ${n} בתים)`
    },
  },
  {
    name: 'files_read',
    description: 'קורא קובץ מתיקיית העבודה (מקוצר אם ארוך).',
    parameters: obj({ name: NAME, max_chars: num('מקסימום תווים, ברירת מחדל 4000') }, ['name']),
    run({ name, max_chars = 4000 }) {
      const max = Math.min(20000, Math.max(100, Math.floor(toNumber(max_chars, 'אורך'))))
      return clip(readText(name), max)
    },
  },
  {
    name: 'files_list',
    description: 'מציג את הקבצים בתיקיית העבודה עם גודל ותאריך עדכון.',
    parameters: obj({}),
    run() {
      const files = allFiles()
      if (!files.length) return 'התיקייה ריקה'
      const total = files.reduce((s, f) => s + f.size, 0)
      return lines(files.map((f) => `${f.name} | ${f.size} בתים | ${fmtDate(f.mtime)}`), `סה"כ ${files.length} קבצים, ${total} בתים`)
    },
  },
  {
    name: 'files_delete',
    description: 'מוחק קובץ אחד לפי שם מדויק מתיקיית העבודה.',
    parameters: obj({ name: NAME }),
    run({ name }) {
      const full = resolveName(name)
      if (!statSafe(full)) throw new Error(`הקובץ "${name}" לא נמצא`)
      fs.unlinkSync(full)
      return `נמחק ${name}`
    },
  },
  {
    name: 'files_rename',
    description: 'משנה שם של קובץ בתיקיית העבודה (לא דורס קובץ קיים).',
    parameters: obj({ name: NAME, new_name: str('השם החדש') }),
    run({ name, new_name }) {
      const from = resolveName(name)
      const to = resolveName(new_name)
      if (!statSafe(from)) throw new Error(`הקובץ "${name}" לא נמצא`)
      if (statSafe(to)) throw new Error('כבר קיים קובץ בשם הזה')
      fs.renameSync(from, to)
      return `${name} שונה ל-${new_name}`
    },
  },
  {
    name: 'files_copy',
    description: 'מעתיק קובץ בתיקיית העבודה לשם חדש (לא דורס קובץ קיים).',
    parameters: obj({ name: NAME, new_name: str('שם ההעתק') }),
    run({ name, new_name }) {
      const text = readText(name)
      resolveName(new_name)
      if (statSafe(resolveName(new_name))) throw new Error('כבר קיים קובץ בשם הזה')
      writeText(new_name, text)
      return `${name} הועתק ל-${new_name}`
    },
  },
  {
    name: 'files_search',
    description: 'מחפש טקסט (בלי רגישות לאותיות) בכל הקבצים ומחזיר קובץ:שורה וקטע.',
    parameters: obj({ query: str('הטקסט לחיפוש'), max_results: num('מקסימום תוצאות, ברירת מחדל 20') }, ['query']),
    run({ query, max_results = 20 }) {
      const q = String(need(query, 'חיפוש')).toLowerCase()
      const max = Math.min(50, Math.max(1, Math.floor(toNumber(max_results, 'מקסימום'))))
      const out = []
      for (const f of allFiles()) {
        if (f.size > MAX_FILE) continue
        let text
        try {
          text = readText(f.name)
        } catch {
          continue
        }
        const ls = lineList(text)
        for (let i = 0; i < ls.length && out.length < max; i++) {
          if (ls[i].toLowerCase().includes(q)) out.push(`${f.name}:${i + 1}: ${clip(ls[i].trim(), 160)}`)
        }
        if (out.length >= max) break
      }
      return out.length ? out.join('\n') : 'לא נמצא'
    },
  },
  {
    name: 'files_count',
    description: 'סופר שורות, מילים ותווים בקובץ.',
    parameters: obj({ name: NAME }),
    run({ name }) {
      const text = readText(name)
      const words = text.split(/\s+/).filter(Boolean).length
      const n = text === '' ? 0 : lineList(text.replace(/\n$/, '')).length
      return `${n} שורות, ${words} מילים, ${text.length} תווים`
    },
  },
  {
    name: 'files_csv_summary',
    description: 'מסכם קובץ CSV: כותרות, מספר שורות וסטטיסטיקה לעמודות מספריות.',
    parameters: obj({ name: NAME }),
    run({ name }) {
      const { header, body } = loadCsv(name)
      const out = [`עמודות: ${header.join(', ')}`, `שורות: ${body.length}`]
      header.forEach((h, i) => {
        const vals = body.map((r) => (r[i] ?? '').trim()).filter((v) => v !== '')
        const nums = vals.map(Number)
        if (vals.length && nums.every(Number.isFinite)) {
          const sum = nums.reduce((a, b) => a + b, 0)
          const r = (x) => Number(x.toPrecision(10))
          out.push(`${h}: מינימום ${r(Math.min(...nums))}, מקסימום ${r(Math.max(...nums))}, סכום ${r(sum)}, ממוצע ${r(sum / nums.length)}`)
        }
      })
      return out.join('\n')
    },
  },
  {
    name: 'files_csv_filter',
    description: 'מסנן שורות בקובץ CSV לפי עמודה=ערך (בלי רגישות לאותיות), ומחזיר או שומר לקובץ.',
    parameters: obj({ name: NAME, column: str('שם או מספר העמודה'), value: str('הערך'), save_as: str('שם קובץ csv לשמירה (לא חובה)') }, ['name', 'column', 'value']),
    run({ name, column, value, save_as }) {
      const { header, body } = loadCsv(name)
      const i = colIndex(header, column)
      const v = String(value ?? '').trim().toLowerCase()
      const hit = body.filter((r) => (r[i] ?? '').trim().toLowerCase() === v)
      const csv = toCsv([header, ...hit])
      if (save_as) {
        writeText(save_as, csv)
        return `${hit.length} שורות נשמרו ב-${save_as}`
      }
      return hit.length ? `${hit.length} שורות:\n${clip(csv, 3000)}` : 'אין שורות תואמות'
    },
  },
  {
    name: 'files_csv_sort',
    description: 'ממיין קובץ CSV לפי עמודה (מספרית אם אפשר) ושומר לקובץ או מחזיר.',
    parameters: obj({ name: NAME, column: str('שם או מספר העמודה'), descending: { type: 'boolean', description: 'מיון יורד' }, save_as: str('שם קובץ csv לשמירה (לא חובה)') }, ['name', 'column']),
    run({ name, column, descending = false, save_as }) {
      const { header, body } = loadCsv(name)
      const i = colIndex(header, column)
      const numeric = body.every((r) => Number.isFinite(Number((r[i] ?? '').trim())) && (r[i] ?? '').trim() !== '')
      const sorted = [...body].sort((a, b) => (numeric ? Number(a[i]) - Number(b[i]) : String(a[i] ?? '').localeCompare(String(b[i] ?? ''))))
      if (descending === true || descending === 'true') sorted.reverse()
      const csv = toCsv([header, ...sorted])
      if (save_as) {
        writeText(save_as, csv)
        return `${sorted.length} שורות ממוינות נשמרו ב-${save_as}`
      }
      return clip(csv, 3000)
    },
  },
  {
    name: 'files_json_get',
    description: 'קורא ערך מקובץ JSON לפי נתיב, למשל a.b[0].c.',
    parameters: obj({ name: NAME, path: str('נתיב בנקודות, למשל user.tags[0]') }),
    run({ name, path: p }) {
      let cur
      try {
        cur = JSON.parse(readText(name))
      } catch (e) {
        if (e instanceof SyntaxError) throw new Error('הקובץ אינו JSON תקין')
        throw e
      }
      for (const k of pathParts(p)) {
        if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, k)) throw new Error(`הנתיב "${p}" לא קיים`)
        cur = cur[k]
      }
      return clip(typeof cur === 'string' ? cur : JSON.stringify(cur, null, 2), 3000)
    },
  },
  {
    name: 'files_json_set',
    description: 'קובע ערך בקובץ JSON לפי נתיב (נוצר אם לא קיים). הערך הוא JSON או טקסט.',
    parameters: obj({ name: NAME, path: str('נתיב בנקודות, למשל user.age'), value: str('הערך, למשל 5 או "טקסט" או {"a":1}') }),
    run({ name, path: p, value }) {
      const full = resolveName(name)
      let root = {}
      if (statSafe(full)) {
        try {
          root = JSON.parse(readText(name))
        } catch (e) {
          if (e instanceof SyntaxError) throw new Error('הקובץ אינו JSON תקין')
          throw e
        }
      }
      if (root === null || typeof root !== 'object') throw new Error('שורש ה-JSON חייב להיות אובייקט או מערך')
      let val
      try {
        val = JSON.parse(String(value))
      } catch {
        val = String(value)
      }
      const parts = pathParts(p)
      let cur = root
      parts.forEach((k, idx) => {
        if (idx === parts.length - 1) {
          cur[k] = val
          return
        }
        if (!Object.hasOwn(cur, k) || cur[k] === null || typeof cur[k] !== 'object') cur[k] = /^\d+$/.test(parts[idx + 1]) ? [] : {}
        cur = cur[k]
      })
      writeText(name, JSON.stringify(root, null, 2))
      return `עודכן ${p} ב-${name}`
    },
  },
  {
    name: 'files_daily_note',
    description: 'מוסיף שורה עם שעה לקובץ ההערות של היום (notes-YYYY-MM-DD.md).',
    parameters: obj({ text: str('ההערה') }),
    run({ text }) {
      const d = new Date()
      const p2 = (n) => String(n).padStart(2, '0')
      const file = `notes-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.md`
      const full = resolveName(file)
      const old = statSafe(full) ? readText(file) : `# הערות ${file.slice(6, 16)}\n\n`
      writeText(file, `${old}${old.endsWith('\n') ? '' : '\n'}- ${p2(d.getHours())}:${p2(d.getMinutes())} ${String(need(text, 'טקסט')).replace(/\s*\n\s*/g, ' ')}\n`)
      return `נוסף ל-${file}`
    },
  },
  {
    name: 'files_merge',
    description: 'מחבר שני קבצי טקסט לקובץ חדש (הראשון ואז השני).',
    parameters: obj({ first: str('קובץ ראשון'), second: str('קובץ שני'), save_as: str('שם קובץ התוצאה') }),
    run({ first, second, save_as }) {
      const a = readText(first)
      const b = readText(second)
      const target = resolveName(save_as)
      if (statSafe(target)) throw new Error('כבר קיים קובץ בשם הזה')
      writeText(save_as, `${a}${a.endsWith('\n') || !a ? '' : '\n'}${b}`)
      return `${first} + ${second} נשמרו ב-${save_as}`
    },
  },
  {
    name: 'files_dedupe',
    description: 'מסיר שורות כפולות מקובץ ושומר את הסדר המקורי.',
    parameters: obj({ name: NAME, save_as: str('שם קובץ חדש (אחרת הקובץ עצמו מתעדכן)') }, ['name']),
    run({ name, save_as }) {
      const ls = lineList(readText(name).replace(/\n$/, ''))
      const seen = new Set()
      const out = ls.filter((l) => (seen.has(l) ? false : (seen.add(l), true)))
      writeText(save_as || name, out.join('\n') + '\n')
      return `הוסרו ${ls.length - out.length} שורות כפולות, נשארו ${out.length}`
    },
  },
  {
    name: 'files_split',
    description: 'מפצל קובץ טקסט ארוך ל-N חלקים לפי שורות (name-part1.ext ...).',
    parameters: obj({ name: NAME, parts: num('מספר חלקים, 2 עד 20') }),
    run({ name, parts }) {
      const n = Math.floor(toNumber(parts, 'חלקים'))
      if (n < 2 || n > 20) throw new Error('מספר החלקים חייב להיות בין 2 ל-20')
      const ls = lineList(readText(name).replace(/\n$/, ''))
      const ext = path.extname(name)
      const stem = name.slice(0, name.length - ext.length)
      const size = Math.ceil(ls.length / n)
      const made = []
      for (let i = 0; i < n; i++) {
        const chunk = ls.slice(i * size, (i + 1) * size)
        if (!chunk.length) break
        const out = `${stem}-part${i + 1}${ext}`
        writeText(out, chunk.join('\n') + '\n')
        made.push(out)
      }
      return `נוצרו: ${made.join(', ')}`
    },
  },
  {
    name: 'files_ics_events',
    description: 'מציג אירועים מקובץ ‎.ics בתיקיית העבודה: כותרת, תאריכים ומיקום.',
    parameters: obj({ name: NAME, max_events: num('מקסימום אירועים, ברירת מחדל 30') }, ['name']),
    run({ name, max_events = 30 }) {
      const max = Math.min(100, Math.max(1, Math.floor(toNumber(max_events, 'מקסימום'))))
      const events = parseIcs(readText(name)).sort((a, b) => String(a.DTSTART ?? '').localeCompare(String(b.DTSTART ?? '')))
      if (!events.length) return 'לא נמצאו אירועים'
      return events
        .slice(0, max)
        .map((e) => `${icsDate(e.DTSTART)}${e.DTEND ? ` עד ${icsDate(e.DTEND)}` : ''} | ${e.SUMMARY ?? '(בלי כותרת)'}${e.LOCATION ? ` | ${e.LOCATION}` : ''}`)
        .join('\n')
    },
  },
]

const ATTACKS = ['../x.txt', 'a/../../x.txt', 'C:\\Windows\\x.txt', '\\\\server\\share\\x.txt', 'x.txt:stream', 'CON.txt', 'nul.md', '/etc/passwd', 'bad.exe', 'a\0b.txt', 'sub/x.txt', '..', '.hidden.txt', 'x.txt.', 'a'.repeat(130) + '.txt']
const ICS = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260301T093000\r\nDTEND:20260301T103000\r\nSUMMARY:פגישה\r\nLOCATION:תל אביב\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260101\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'

export const tests = [
  { tool: 'files_write', args: { name: 'a.txt', content: 'hello\nWorld\nhello\n' }, check: (r) => r.includes('a.txt') },
  { tool: 'files_append', args: { name: 'a.txt', content: 'last line' }, check: (r) => r.includes('a.txt') },
  { tool: 'files_read', args: { name: 'a.txt' }, check: (r) => r.includes('World') && r.includes('last line') },
  { tool: 'files_count', args: { name: 'a.txt' }, check: (r) => r.startsWith('4 שורות') },
  { tool: 'files_search', args: { query: 'WORLD' }, check: (r) => r.includes('a.txt:2') },
  { tool: 'files_dedupe', args: { name: 'a.txt', save_as: 'b.txt' }, check: (r) => r.includes('הוסרו 1') },
  { tool: 'files_copy', args: { name: 'b.txt', new_name: 'c.txt' }, check: (r) => r.includes('c.txt') },
  { tool: 'files_merge', args: { first: 'b.txt', second: 'c.txt', save_as: 'm.txt' }, check: (r) => r.includes('m.txt') },
  { tool: 'files_split', args: { name: 'm.txt', parts: 2 }, check: (r) => r.includes('m-part1.txt') && r.includes('m-part2.txt') },
  { tool: 'files_rename', args: { name: 'c.txt', new_name: 'd.txt' }, check: (r) => r.includes('d.txt') },
  { tool: 'files_write', args: { name: 'p.csv', content: 'name,age\nדן,30\nרות,25\nנועה,41\n' }, check: (r) => r.includes('p.csv') },
  { tool: 'files_csv_summary', args: { name: 'p.csv' }, check: (r) => r.includes('שורות: 3') && r.includes('מקסימום 41') },
  { tool: 'files_csv_filter', args: { name: 'p.csv', column: 'name', value: 'רות' }, check: (r) => r.includes('רות,25') && !r.includes('דן') },
  { tool: 'files_csv_sort', args: { name: 'p.csv', column: 'age', descending: true }, check: (r) => r.indexOf('41') < r.indexOf('25') },
  { tool: 'files_json_set', args: { name: 'j.json', path: 'user.tags[1]', value: '"x"' }, check: (r) => r.includes('j.json') },
  { tool: 'files_json_get', args: { name: 'j.json', path: 'user.tags[1]' }, check: (r) => r === 'x' },
  { tool: 'files_json_set', args: { name: 'j.json', path: '__proto__.polluted', value: '1' }, throws: true, check: () => false },
  { tool: 'files_daily_note', args: { text: 'בדיקה' }, check: (r) => /notes-\d{4}-\d{2}-\d{2}\.md/.test(r) },
  { tool: 'files_write', args: { name: 'e.ics', content: ICS }, check: (r) => r.includes('e.ics') },
  { tool: 'files_ics_events', args: { name: 'e.ics' }, check: (r) => r.includes('2026-03-01 09:30') && r.includes('פגישה') && r.includes('Holiday') },
  { tool: 'files_write', args: { name: 'big.txt', content: 'x'.repeat(210 * 1024) }, throws: true, check: () => false },
  { tool: 'files_write', args: { name: 'ok.json', content: '{}' }, check: (r) => r.includes('ok.json') },
  { tool: 'files_list', args: {}, check: (r) => r.includes('a.txt') && r.includes('p.csv') && r.includes('קבצים') },
  { tool: 'files_delete', args: { name: 'd.txt' }, check: (r) => r.includes('d.txt') },
  { tool: 'files_read', args: { name: 'd.txt' }, throws: true, check: () => false },
  ...ATTACKS.flatMap((name) => [
    { tool: 'files_write', args: { name, content: 'x' }, throws: true, check: () => false },
    { tool: 'files_read', args: { name }, throws: true, check: () => false },
    { tool: 'files_delete', args: { name }, throws: true, check: () => false },
    { tool: 'files_rename', args: { name: 'a.txt', new_name: name }, throws: true, check: () => false },
    { tool: 'files_copy', args: { name: 'a.txt', new_name: name }, throws: true, check: () => false },
  ]),
]
