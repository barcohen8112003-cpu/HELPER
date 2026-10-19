// Developer tools: fully offline, no eval, no network, no files.
import net from 'node:net'
import { str, num, oneOf, obj, clip, need, toNumber } from './_kit.js'

export const category = 'dev'
export const blurb = 'כלים למתכנתים: המרות, JSON, regex, cron, רשתות ועוד'

const MAX_IN = 20000
const input = (v, name, max = MAX_IN) => {
  const s = String(need(v, name))
  if (s.length > max) throw new Error(`${name} ארוך מדי (מקסימום ${max} תווים)`)
  return s
}

// ---------- base conversion ----------
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
function parseBase(raw, base) {
  let s = input(raw, 'ערך', 2000).trim().toLowerCase().replace(/[_\s]/g, '')
  let neg = false
  if (s.startsWith('-')) {
    neg = true
    s = s.slice(1)
  } else if (s.startsWith('+')) s = s.slice(1)
  if (base === 16 && s.startsWith('0x')) s = s.slice(2)
  if (base === 2 && s.startsWith('0b')) s = s.slice(2)
  if (base === 8 && s.startsWith('0o')) s = s.slice(2)
  if (!s) throw new Error('ערך ריק')
  let v = 0n
  const b = BigInt(base)
  for (const ch of s) {
    const d = DIGITS.indexOf(ch)
    if (d < 0 || d >= base) throw new Error(`התו "${ch}" לא חוקי בבסיס ${base}`)
    v = v * b + BigInt(d)
  }
  return neg ? -v : v
}
const baseArg = (v, name, def) => {
  const n = v === undefined || v === '' ? def : toNumber(v, name)
  if (!Number.isInteger(n) || n < 2 || n > 36) throw new Error(`${name} חייב להיות מספר שלם בין 2 ל-36`)
  return n
}

// ---------- bitwise ----------
function parseBig(raw, name) {
  let s = String(need(raw, name)).trim().toLowerCase()
  let neg = false
  if (s.startsWith('-')) {
    neg = true
    s = s.slice(1)
  }
  if (!/^(\d+|0x[0-9a-f]+|0b[01]+)$/.test(s) || s.length > 300) throw new Error(`${name} לא תקין (דצימלי, 0x.. או 0b..)`)
  const v = BigInt(s)
  return neg ? -v : v
}

// ---------- JSON ----------
function parseJson(text) {
  try {
    return JSON.parse(input(text, 'JSON'))
  } catch (e) {
    if (e.message.startsWith('JSON ארוך') || e.message.startsWith('חסר')) throw e
    throw new Error(`JSON לא תקין: ${e.message}`)
  }
}

function jsonPath(data, path) {
  let p = String(need(path, 'נתיב')).trim()
  if (p.length > 300) throw new Error('נתיב ארוך מדי')
  if (p.startsWith('$')) p = p.slice(1)
  if (p && !/^[.[]/.test(p)) p = `.${p}`
  const re = /\.\*|\[\*\]|\.([^.[\]*]+)|\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]/y
  let nodes = [data]
  let pos = 0
  while (pos < p.length) {
    re.lastIndex = pos
    const m = re.exec(p)
    if (!m) throw new Error(`נתיב לא תקין ליד "${p.slice(pos, pos + 8)}"`)
    pos = re.lastIndex
    const next = []
    for (const n of nodes) {
      if (m[0] === '.*' || m[0] === '[*]') {
        if (n && typeof n === 'object') next.push(...Object.values(n))
        continue
      }
      const key = m[1] ?? m[2] ?? m[3] ?? m[4]
      if (n && typeof n === 'object' && Object.hasOwn(n, key)) next.push(n[key])
    }
    nodes = next
    if (!nodes.length) throw new Error('הנתיב לא נמצא ב-JSON')
  }
  return nodes.length === 1 ? nodes[0] : nodes
}

// ---------- CSV ----------
function parseCsv(text, delim) {
  const rows = []
  let row = []
  let cur = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"'
          i++
        } else q = false
      } else cur += c
    } else if (c === '"') q = true
    else if (c === delim) {
      row.push(cur)
      cur = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
    } else cur += c
  }
  if (q) throw new Error('מרכאות לא סגורות ב-CSV')
  if (cur !== '' || row.length) {
    row.push(cur)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// ---------- regex safety ----------
function checkRegex(pattern) {
  if (pattern.length > 200) throw new Error('התבנית ארוכה מדי (מקסימום 200 תווים)')
  if (/\\[1-9]|\\k</.test(pattern)) throw new Error('הפניות אחורה (backreference) לא נתמכות מטעמי בטיחות')
  const stack = [{ quant: false, alt: false }]
  let unbounded = 0
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') inClass = true
    else if (c === '(') stack.push({ quant: false, alt: false })
    else if (c === '|') stack[stack.length - 1].alt = true
    else if (c === '*' || c === '+' || (c === '{' && /^\{\d+,\}/.test(pattern.slice(i)))) {
      unbounded++
      stack[stack.length - 1].quant = true
    } else if (c === ')') {
      if (stack.length < 2) throw new Error('סוגר ")" מיותר בתבנית')
      const g = stack.pop()
      const nx = pattern[i + 1]
      const quantified = nx === '*' || nx === '+' || (nx === '{' && /^\{\d+,\}/.test(pattern.slice(i + 1)))
      if (quantified && (g.quant || g.alt)) throw new Error('תבנית מסוכנת (כמת בתוך כמת או | בתוך חזרה) שעלולה לתקוע את המערכת')
      const parent = stack[stack.length - 1]
      if (g.quant || quantified) parent.quant = true
      if (g.alt && false) parent.alt = true
    }
  }
  if (unbounded > 3) throw new Error('יותר מדי כמתים פתוחים (* + {n,}) בתבנית')
  return unbounded
}

// ---------- cron ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DOWS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
function cronField(raw, min, max, names, label) {
  const out = new Set()
  const val = (t) => {
    const lower = t.toLowerCase()
    if (names) {
      const i = names.indexOf(lower)
      if (i >= 0) return i + (label === 'חודש' ? 1 : 0)
    }
    if (!/^\d+$/.test(t)) throw new Error(`ערך לא תקין בשדה ${label}: "${t}"`)
    return Number(t)
  }
  for (const part of raw.split(',')) {
    const [rangePart, stepPart, extra] = part.split('/')
    if (extra !== undefined || part === '') throw new Error(`שדה ${label} לא תקין: "${raw}"`)
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) throw new Error(`צעד לא תקין בשדה ${label}`)
    let lo
    let hi
    if (rangePart === '*') {
      lo = min
      hi = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-')
      lo = val(a)
      hi = val(b)
    } else {
      lo = val(rangePart)
      hi = stepPart === undefined ? lo : max
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`ערך מחוץ לטווח (${min}-${max}) בשדה ${label}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}
function parseCron(expr) {
  const f = String(need(expr, 'ביטוי cron')).trim().split(/\s+/)
  if (f.length !== 5) throw new Error('ביטוי cron חייב להכיל 5 שדות: דקה שעה יום-בחודש חודש יום-בשבוע')
  const dow = cronField(f[4], 0, 7, DOWS, 'יום בשבוע')
  if (dow.has(7)) {
    dow.delete(7)
    dow.add(0)
  }
  return {
    fields: f,
    min: cronField(f[0], 0, 59, null, 'דקה'),
    hour: cronField(f[1], 0, 23, null, 'שעה'),
    dom: cronField(f[2], 1, 31, null, 'יום בחודש'),
    mon: cronField(f[3], 1, 12, MONTHS, 'חודש'),
    dow,
  }
}
const pad = (n) => String(n).padStart(2, '0')
const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
const fmtLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (יום ${HE_DAYS[d.getDay()]})`
function cronNext(c, from, count) {
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const domR = c.dom.size < 31
  const dowR = c.dow.size < 7
  const results = []
  const limit = from.getTime() + 5 * 366 * 86400000
  let guard = 0
  while (results.length < count && d.getTime() < limit && guard++ < 400000) {
    if (!c.mon.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    const dayOk = domR && dowR ? c.dom.has(d.getDate()) || c.dow.has(d.getDay()) : c.dom.has(d.getDate()) && c.dow.has(d.getDay())
    if (!dayOk) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!c.min.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1)
      continue
    }
    results.push(new Date(d.getTime()))
    d.setMinutes(d.getMinutes() + 1)
  }
  return results
}
function describeCronField(raw, label) {
  if (raw === '*') return `${label}: כל אחד`
  const m = /^\*\/(\d+)$/.exec(raw)
  if (m) return `${label}: כל ${m[1]}`
  return `${label}: ${raw}`
}

// ---------- HTTP status ----------
const HTTP = {
  100: 'Continue - המשך, השרת קיבל את הכותרות',
  101: 'Switching Protocols - מעבר פרוטוקול (למשל WebSocket)',
  200: 'OK - הצלחה',
  201: 'Created - משאב חדש נוצר',
  202: 'Accepted - הבקשה התקבלה ותטופל בהמשך',
  204: 'No Content - הצלחה בלי תוכן בתשובה',
  206: 'Partial Content - תוכן חלקי (Range)',
  301: 'Moved Permanently - הועבר לצמיתות לכתובת אחרת',
  302: 'Found - הפניה זמנית',
  303: 'See Other - לך לכתובת אחרת עם GET',
  304: 'Not Modified - לא השתנה, אפשר להשתמש במטמון',
  307: 'Temporary Redirect - הפניה זמנית, שומרת על המתודה',
  308: 'Permanent Redirect - הפניה קבועה, שומרת על המתודה',
  400: 'Bad Request - בקשה לא תקינה',
  401: 'Unauthorized - לא מזוהה, חסר או שגוי אימות',
  403: 'Forbidden - מזוהה אבל אין הרשאה',
  404: 'Not Found - המשאב לא נמצא',
  405: 'Method Not Allowed - המתודה לא מותרת למשאב הזה',
  406: 'Not Acceptable - אין תוכן שמתאים לכותרות Accept',
  408: 'Request Timeout - הבקשה לקחה יותר מדי זמן',
  409: 'Conflict - התנגשות עם מצב המשאב',
  410: 'Gone - המשאב נמחק ולא יחזור',
  413: 'Payload Too Large - הבקשה גדולה מדי',
  415: 'Unsupported Media Type - סוג תוכן לא נתמך',
  418: "I'm a teapot - בדיחת אחד באפריל (RFC 2324)",
  422: 'Unprocessable Entity - המבנה תקין אבל התוכן לא',
  429: 'Too Many Requests - יותר מדי בקשות (rate limit)',
  500: 'Internal Server Error - שגיאה כללית בשרת',
  501: 'Not Implemented - השרת לא תומך בפעולה',
  502: 'Bad Gateway - שרת ביניים קיבל תשובה לא תקינה',
  503: 'Service Unavailable - השרת לא זמין (עומס או תחזוקה)',
  504: 'Gateway Timeout - שרת ביניים לא קיבל תשובה בזמן',
}

// ---------- ports ----------
const PORTS = {
  20: 'FTP (נתונים)',
  21: 'FTP (בקרה)',
  22: 'SSH',
  23: 'Telnet',
  25: 'SMTP (שליחת מייל)',
  53: 'DNS',
  67: 'DHCP (שרת)',
  80: 'HTTP',
  110: 'POP3',
  123: 'NTP (שעון)',
  143: 'IMAP',
  161: 'SNMP',
  389: 'LDAP',
  443: 'HTTPS',
  445: 'SMB (שיתוף קבצים בווינדוס)',
  465: 'SMTPS',
  587: 'SMTP submission',
  993: 'IMAPS',
  995: 'POP3S',
  1433: 'Microsoft SQL Server',
  1521: 'Oracle DB',
  3000: 'שרת פיתוח נפוץ (Node/React)',
  3306: 'MySQL / MariaDB',
  3389: 'RDP (שולחן עבודה מרוחק)',
  5173: 'Vite dev server',
  5432: 'PostgreSQL',
  5672: 'RabbitMQ (AMQP)',
  5900: 'VNC',
  6379: 'Redis',
  8080: 'HTTP חלופי / פרוקסי',
  8443: 'HTTPS חלופי',
  9200: 'Elasticsearch',
  25565: 'Minecraft',
  27017: 'MongoDB',
}

// ---------- semver ----------
function parseSemver(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(need(s, 'גרסה')).trim())
  if (!m) throw new Error(`גרסה לא תקינה: "${s}" (צריך x.y.z)`)
  return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}
function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i] < b.n[i] ? -1 : 1
  if (!a.pre.length && !b.pre.length) return 0
  if (!a.pre.length) return 1
  if (!b.pre.length) return -1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn) return -1
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return 0
}
const sv = (a, b, c) => ({ n: [a, b, c], pre: [] })
function satisfiesComparator(v, tok) {
  if (tok === '*' || tok === '' || tok === 'x') return true
  const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(-[0-9A-Za-z.-]+)?$/.exec(tok)
  if (!m) throw new Error(`טווח גרסאות לא תקין: "${tok}"`)
  const op = m[1] || ''
  const wild = (x) => x === undefined || x === 'x' || x === '*'
  if (wild(m[2])) return true
  const maj = Number(m[2])
  const min = wild(m[3]) ? null : Number(m[3])
  const pat = wild(m[4]) || min === null ? null : Number(m[4])
  const lowV = sv(maj, min ?? 0, pat ?? 0)
  if (m[5]) lowV.pre = m[5].slice(1).split('.')
  if (op === '' || op === '=') {
    if (min === null) return cmpSemver(v, sv(maj, 0, 0)) >= 0 && cmpSemver(v, sv(maj + 1, 0, 0)) < 0
    if (pat === null) return cmpSemver(v, lowV) >= 0 && cmpSemver(v, sv(maj, min + 1, 0)) < 0
    return cmpSemver(v, lowV) === 0
  }
  if (op === '>=') return cmpSemver(v, lowV) >= 0
  if (op === '<=') return pat === null ? cmpSemver(v, min === null ? sv(maj + 1, 0, 0) : sv(maj, min + 1, 0)) < 0 : cmpSemver(v, lowV) <= 0
  if (op === '>') return pat === null ? cmpSemver(v, min === null ? sv(maj + 1, 0, 0) : sv(maj, min + 1, 0)) >= 0 : cmpSemver(v, lowV) > 0
  if (op === '<') return cmpSemver(v, lowV) < 0
  if (op === '~') {
    const up = min === null ? sv(maj + 1, 0, 0) : sv(maj, min + 1, 0)
    return cmpSemver(v, lowV) >= 0 && cmpSemver(v, up) < 0
  }
  // caret
  let up
  if (maj > 0 || min === null) up = sv(maj + 1, 0, 0)
  else if ((min ?? 0) > 0 || pat === null) up = sv(0, (min ?? 0) + 1, 0)
  else up = sv(0, 0, (pat ?? 0) + 1)
  return cmpSemver(v, lowV) >= 0 && cmpSemver(v, up) < 0
}
function satisfies(v, range) {
  const r = String(need(range, 'טווח')).trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
  if (r.length > 200) throw new Error('טווח ארוך מדי')
  return r.split('||').some((set) => set.trim().split(/\s+/).every((tok) => satisfiesComparator(v, tok)))
}

// ---------- color ----------
function parseColor(raw) {
  const s = String(need(raw, 'צבע')).trim().toLowerCase()
  let m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (m) {
    let h = m[1]
    if (h.length === 3) h = [...h].map((c) => c + c).join('')
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  }
  m = /^rgb\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)$/.exec(s)
  if (m) {
    const c = [m[1], m[2], m[3]].map(Number)
    if (c.some((x) => x > 255)) throw new Error('ערך rgb חייב להיות 0-255')
    return c
  }
  m = /^hsl\(\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)%\s*[, ]\s*(\d+(?:\.\d+)?)%\s*\)$/.exec(s)
  if (m) {
    const h = ((Number(m[1]) % 360) + 360) % 360
    const sat = Math.min(Number(m[2]), 100) / 100
    const l = Math.min(Number(m[3]), 100) / 100
    const k = (n) => (n + h / 30) % 12
    const a = sat * Math.min(l, 1 - l)
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
    return [f(0), f(8), f(4)].map((x) => Math.round(x * 255))
  }
  throw new Error('פורמט צבע לא מוכר (#rrggbb, rgb(r,g,b) או hsl(h,s%,l%))')
}
function toHsl([r, g, b]) {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const mx = Math.max(R, G, B)
  const mn = Math.min(R, G, B)
  const l = (mx + mn) / 2
  const d = mx - mn
  let h = 0
  let s = 0
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (mx === R) h = ((G - B) / d) % 6
    else if (mx === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
    h = (h * 60 + 360) % 360
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)]
}
const hex = (c) => `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`
function luminance(c) {
  const [r, g, b] = c.map((x) => {
    const v = x / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// ---------- IPv4 ----------
function ipToInt(ip) {
  const p = ip.split('.')
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) throw new Error(`כתובת IPv4 לא תקינה: "${ip}"`)
  return p.reduce((a, x) => a * 256 + Number(x), 0)
}
const intToIp = (n) => [n / 16777216, n / 65536, n / 256, n].map((x) => Math.floor(x) % 256).join('.')

// ---------- chmod ----------
const RWX = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx']

// ---------- checksums ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function luhnSum(digits, doubleFirst) {
  let sum = 0
  let dbl = doubleFirst
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i])
    if (dbl) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    dbl = !dbl
  }
  return sum
}

// ---------- Levenshtein ----------
function levenshtein(a, b) {
  const A = [...a]
  const B = [...b]
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i)
  for (let i = 1; i <= A.length; i++) {
    const cur = [i]
    for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[B.length]
}

export const tools = [
  {
    name: 'dev_base_convert',
    description: 'ממיר מספר בין בסיסים 2 עד 36 (בינארי, אוקטלי, דצימלי, הקסה), גם מספרים ענקיים.',
    parameters: obj({ value: str('המספר, למשל ff או 1010'), from_base: num('בסיס המקור 2-36, ברירת מחדל 10'), to_base: num('בסיס היעד 2-36, ברירת מחדל 2') }, ['value']),
    run({ value, from_base, to_base }) {
      const fb = baseArg(from_base, 'בסיס מקור', 10)
      const tb = baseArg(to_base, 'בסיס יעד', 2)
      const v = parseBase(value, fb)
      return `${String(value).trim()} (בסיס ${fb}) = ${v.toString(tb)} (בסיס ${tb})\nדצימלי: ${v.toString(10)}\nהקסה: ${v.toString(16)}\nבינארי: ${v.toString(2)}`
    },
  },
  {
    name: 'dev_bitwise',
    description: 'פעולת ביטים (and, or, xor, not, shl, shr) על מספרים שלמים, עם הצגה בינארית. a ו-b דצימליים או 0x/0b.',
    parameters: obj({ op: oneOf(['and', 'or', 'xor', 'not', 'shl', 'shr'], 'הפעולה'), a: str('המספר הראשון'), b: str('המספר השני או כמות הזזה (לא נדרש ב-not)') }, ['op', 'a']),
    run({ op, a, b }) {
      const x = parseBig(a, 'a')
      let r
      if (op === 'not') r = ~x
      else {
        const y = parseBig(b, 'b')
        if (op === 'and') r = x & y
        else if (op === 'or') r = x | y
        else if (op === 'xor') r = x ^ y
        else if (op === 'shl' || op === 'shr') {
          if (y < 0n || y > 1024n) throw new Error('כמות הזזה חייבת להיות בין 0 ל-1024')
          r = op === 'shl' ? x << y : x >> y
        } else throw new Error('פעולה לא מוכרת')
      }
      const bin = (n) => (n < 0n ? `-${(-n).toString(2)}` : n.toString(2))
      return `${op}: ${r.toString(10)}\nבינארי: ${bin(r)}\nהקסה: ${r < 0n ? '-' : ''}0x${(r < 0n ? -r : r).toString(16)}\n(a בינארי: ${bin(x)})`
    },
  },
  {
    name: 'dev_json_format',
    description: 'בודק תקינות JSON, מעצב (pretty) או מכווץ (minify) אותו.',
    parameters: obj({ json: str('טקסט ה-JSON'), mode: oneOf(['validate', 'pretty', 'minify'], 'פעולה, ברירת מחדל validate') }, ['json']),
    run({ json, mode = 'validate' }) {
      const data = parseJson(json)
      if (mode === 'pretty') return clip(JSON.stringify(data, null, 2))
      if (mode === 'minify') return clip(JSON.stringify(data))
      const type = Array.isArray(data) ? `מערך עם ${data.length} איברים` : data && typeof data === 'object' ? `אובייקט עם ${Object.keys(data).length} מפתחות` : `ערך בודד (${typeof data})`
      return `JSON תקין: ${type}`
    },
  },
  {
    name: 'dev_json_path',
    description: 'שולף ערך מתוך JSON לפי נתיב פשוט כמו a.b[0].c או $.items[*].name (ללא eval).',
    parameters: obj({ json: str('טקסט ה-JSON'), path: str('הנתיב, למשל users[0].name') }),
    run({ json, path }) {
      return clip(JSON.stringify(jsonPath(parseJson(json), path), null, 2))
    },
  },
  {
    name: 'dev_json_csv',
    description: 'ממיר בין JSON (מערך אובייקטים) ל-CSV ובחזרה.',
    parameters: obj({ mode: oneOf(['json_to_csv', 'csv_to_json'], 'כיוון ההמרה'), text: str('הטקסט להמרה'), delimiter: str('מפריד ל-CSV, ברירת מחדל פסיק') }, ['mode', 'text']),
    run({ mode, text, delimiter = ',' }) {
      const d = String(delimiter)
      if (d.length !== 1 || d === '"') throw new Error('המפריד חייב להיות תו אחד')
      if (mode === 'json_to_csv') {
        const data = parseJson(text)
        if (!Array.isArray(data) || !data.length) throw new Error('צריך מערך לא ריק של אובייקטים')
        const rows = data.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r }))
        const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))]
        return clip([keys.map(csvCell).join(d), ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(d))].join('\n'))
      }
      if (mode === 'csv_to_json') {
        const rows = parseCsv(input(text, 'CSV'), d)
        if (rows.length < 2) throw new Error('צריך שורת כותרת ולפחות שורת נתונים')
        const [head, ...body] = rows
        const out = body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
        return clip(JSON.stringify(out, null, 2))
      }
      throw new Error('מצב לא מוכר')
    },
  },
  {
    name: 'dev_regex_test',
    description: 'בודק ביטוי רגולרי (JavaScript) על טקסט ומחזיר התאמות וקבוצות; מסרב לתבניות מסוכנות.',
    parameters: obj({ pattern: str('התבנית בלי לוכסנים'), text: str('הטקסט לבדיקה'), flags: str('דגלים: i m s u, ברירת מחדל ריק') }, ['pattern', 'text']),
    run({ pattern, text, flags = '' }) {
      const p = input(pattern, 'תבנית', 200)
      const q = checkRegex(p)
      const t = input(text, 'טקסט', 1000)
      if (q === 3 && t.length > 300) throw new Error('עם 3 כמתים פתוחים הטקסט מוגבל ל-300 תווים')
      const f = String(flags)
      if (!/^[imsu]*$/.test(f)) throw new Error('דגלים מותרים: i m s u')
      let re
      try {
        re = new RegExp(p, [...new Set(`${f}g`)].join(''))
      } catch (e) {
        throw new Error(`תבנית לא תקינה: ${e.message}`)
      }
      const out = []
      for (const m of t.matchAll(re)) {
        if (out.length >= 30) break
        const groups = m.slice(1).map((g, i) => `$${i + 1}=${g === undefined ? 'undefined' : JSON.stringify(g)}`)
        const named = m.groups ? Object.entries(m.groups).map(([k, v]) => `${k}=${JSON.stringify(v)}`) : []
        out.push(`#${out.length + 1} ב-${m.index}: ${JSON.stringify(m[0])}${groups.length ? ` [${groups.join(', ')}]` : ''}${named.length ? ` {${named.join(', ')}}` : ''}`)
      }
      return out.length ? clip(`${out.length} התאמות (מוצגות עד 30):\n${out.join('\n')}`) : 'אין התאמות'
    },
  },
  {
    name: 'dev_cron',
    description: 'מסביר ביטוי cron של 5 שדות ומחשב את N ההרצות הבאות לפי שעון המחשב.',
    parameters: obj({ cron: str('למשל "*/15 9-17 * * 1-5"'), count: num('כמה הרצות להציג, ברירת מחדל 5, מקסימום 20'), from: str('תאריך התחלה אופציונלי, למשל 2025-01-01T00:00:00') }, ['cron']),
    run({ cron, count = 5, from }) {
      const c = parseCron(cron)
      const n = Math.min(20, Math.max(1, Math.floor(toNumber(count, 'כמות'))))
      let start = new Date()
      if (from) {
        start = new Date(String(from))
        if (Number.isNaN(start.getTime())) throw new Error('תאריך התחלה לא תקין')
      }
      const runs = cronNext(c, start, n)
      const [m, h, dom, mon, dow] = c.fields
      return clip(
        [
          `cron: ${c.fields.join(' ')}`,
          describeCronField(m, 'דקה'),
          describeCronField(h, 'שעה'),
          describeCronField(dom, 'יום בחודש'),
          describeCronField(mon, 'חודש'),
          describeCronField(dow, 'יום בשבוע (0=ראשון)'),
          runs.length ? `הרצות הבאות:\n${runs.map((d, i) => `${i + 1}. ${fmtLocal(d)}`).join('\n')}` : 'אין הרצות ב-5 השנים הקרובות',
        ].join('\n'),
      )
    },
  },
  {
    name: 'dev_http_status',
    description: 'מסביר קוד סטטוס HTTP בעברית, או מחפש לפי מילה (למשל "redirect" או "הרשאה").',
    parameters: obj({ query: str('קוד כמו 404, או מילת חיפוש') }),
    run({ query }) {
      const q = String(need(query, 'קוד')).trim().toLowerCase()
      if (/^\d{3}$/.test(q)) {
        if (HTTP[q]) return `${q} ${HTTP[q]}`
        const cls = { 1: 'מידע', 2: 'הצלחה', 3: 'הפניה', 4: 'שגיאת לקוח', 5: 'שגיאת שרת' }[q[0]]
        if (!cls) throw new Error('קוד HTTP חייב להיות בין 100 ל-599')
        return `${q}: קוד לא נפוץ, משפחת ${q[0]}xx (${cls})`
      }
      const hits = Object.entries(HTTP).filter(([, v]) => v.toLowerCase().includes(q))
      if (!hits.length) throw new Error('לא נמצא קוד מתאים')
      return clip(hits.map(([k, v]) => `${k} ${v}`).join('\n'))
    },
  },
  {
    name: 'dev_jwt_decode',
    description: 'מפענח כותרת ותוכן של JWT (base64url) להצגה בלבד, בלי אימות חתימה.',
    parameters: obj({ token: str('ה-JWT המלא') }),
    run({ token }) {
      const parts = input(token, 'טוקן', 8000).trim().split('.')
      if (parts.length !== 3 && parts.length !== 2) throw new Error('JWT חייב להכיל 3 חלקים מופרדים בנקודות')
      const dec = (s, name) => {
        if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error(`${name} אינו base64url תקין`)
        try {
          return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
        } catch {
          throw new Error(`${name} אינו JSON תקין`)
        }
      }
      const header = dec(parts[0], 'הכותרת')
      const payload = dec(parts[1], 'התוכן')
      const times = ['iat', 'nbf', 'exp'].filter((k) => typeof payload[k] === 'number').map((k) => `${k}: ${new Date(payload[k] * 1000).toISOString()}`)
      return clip(`כותרת: ${JSON.stringify(header)}\nתוכן: ${JSON.stringify(payload)}${times.length ? `\n${times.join('\n')}` : ''}\nשים לב: החתימה לא אומתה, הפענוח להצגה בלבד ואין להסיק ממנו שהטוקן אמיתי.`)
    },
  },
  {
    name: 'dev_semver',
    description: 'משווה שתי גרסאות semver, או בודק אם גרסה עומדת בטווח כמו ^1.2.0 או >=2 <3.',
    parameters: obj({ a: str('גרסה, למשל 1.2.3'), b: str('גרסה להשוואה (אופציונלי אם יש range)'), range: str('טווח לבדיקה, למשל ^1.2.0') }, ['a']),
    run({ a, b, range }) {
      const va = parseSemver(a)
      if (range) return `${String(a).trim()} ${satisfies(va, range) ? 'עומדת' : 'לא עומדת'} בטווח ${range}`
      const c = cmpSemver(va, parseSemver(b))
      return c === 0 ? `${a} שווה ל-${b}` : c < 0 ? `${a} ישנה מ-${b}` : `${a} חדשה מ-${b}`
    },
  },
  {
    name: 'dev_color',
    description: 'ממיר צבע בין hex, rgb ו-hsl, ואופציונלית מחשב יחס ניגודיות WCAG מול צבע שני.',
    parameters: obj({ color: str('#rrggbb, rgb(r,g,b) או hsl(h,s%,l%)'), color2: str('צבע שני לחישוב ניגודיות (אופציונלי)') }, ['color']),
    run({ color, color2 }) {
      const c = parseColor(color)
      const [h, s, l] = toHsl(c)
      let out = `hex: ${hex(c)}\nrgb(${c.join(', ')})\nhsl(${h}, ${s}%, ${l}%)`
      if (color2) {
        const d = parseColor(color2)
        const [hi, lo] = [luminance(c), luminance(d)].sort((x, y) => y - x)
        const ratio = Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
        out += `\nניגודיות מול ${hex(d)}: ${ratio}:1 (טקסט רגיל AA ${ratio >= 4.5 ? 'עובר' : 'נכשל'}, AAA ${ratio >= 7 ? 'עובר' : 'נכשל'})`
      }
      return out
    },
  },
  {
    name: 'dev_cidr',
    description: 'מחשבון תת-רשת IPv4: מקבל x.x.x.x/n ומחזיר מסכה, כתובת רשת, שידור וטווח מארחים.',
    parameters: obj({ cidr: str('למשל 192.168.1.130/26') }),
    run({ cidr }) {
      const m = /^\s*([\d.]+)\/(\d{1,2})\s*$/.exec(String(need(cidr, 'CIDR')))
      if (!m) throw new Error('פורמט צריך להיות x.x.x.x/n')
      const bits = Number(m[2])
      if (bits > 32) throw new Error('הקידומת חייבת להיות 0 עד 32')
      const ip = ipToInt(m[1])
      const size = 2 ** (32 - bits)
      const mask = size === 2 ** 32 ? 0 : 2 ** 32 - size
      const net0 = Math.floor(ip / size) * size
      const bc = net0 + size - 1
      const hosts = bits >= 31 ? size : size - 2
      const range = bits >= 31 ? `${intToIp(net0)} - ${intToIp(bc)}` : `${intToIp(net0 + 1)} - ${intToIp(bc - 1)}`
      return `רשת: ${intToIp(net0)}/${bits}\nמסכה: ${intToIp(mask)}\nשידור: ${intToIp(bc)}\nטווח מארחים: ${range}\nמספר מארחים: ${hosts}\nכתובות סה"כ: ${size}`
    },
  },
  {
    name: 'dev_chmod',
    description: 'ממיר הרשאות יוניקס בין אוקטלי (755) לסימון rwx (rwxr-xr-x) ובחזרה.',
    parameters: obj({ value: str('למשל 755 או rwxr-xr-x') }),
    run({ value }) {
      const v = String(need(value, 'ערך')).trim()
      if (/^0?[0-7]{3}$/.test(v)) {
        const d = v.slice(-3)
        const sym = [...d].map((x) => RWX[Number(x)]).join('')
        return `${d} = ${sym}\nבעלים: ${RWX[d[0]]}, קבוצה: ${RWX[d[1]]}, אחרים: ${RWX[d[2]]}\nchmod ${d} קובץ`
      }
      if (/^[r-][w-][x-][r-][w-][x-][r-][w-][x-]$/.test(v)) {
        const oct = [0, 3, 6].map((i) => RWX.indexOf(v.slice(i, i + 3))).join('')
        return `${v} = ${oct}\nchmod ${oct} קובץ`
      }
      throw new Error('צריך 3 ספרות אוקטליות (755) או 9 תווי rwx')
    },
  },
  {
    name: 'dev_epoch',
    description: 'ממיר חותמת זמן יוניקס (שניות או מילישניות) לתאריך, או תאריך/now לחותמת זמן.',
    parameters: obj({ value: str('מספר epoch, תאריך כמו 2025-01-01T00:00:00Z, או now') }),
    run({ value }) {
      const v = String(need(value, 'ערך')).trim()
      let ms
      if (v === 'now') ms = Date.now()
      else if (/^-?\d+(\.\d+)?$/.test(v)) {
        const n = Number(v)
        ms = Math.abs(n) >= 1e11 ? n : n * 1000
      } else {
        ms = new Date(v).getTime()
        if (Number.isNaN(ms)) throw new Error('תאריך לא מוכר')
      }
      const d = new Date(ms)
      if (Number.isNaN(d.getTime())) throw new Error('חותמת זמן מחוץ לטווח')
      const il = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'full', timeStyle: 'medium' }).format(d)
      return `ISO (UTC): ${d.toISOString()}\nשניות: ${Math.floor(ms / 1000)}\nמילישניות: ${ms}\nשעון ישראל: ${il}`
    },
  },
  {
    name: 'dev_levenshtein',
    description: 'מחשב מרחק לוונשטיין (מספר עריכות מינימלי) ודמיון באחוזים בין שתי מחרוזות.',
    parameters: obj({ a: str('מחרוזת ראשונה'), b: str('מחרוזת שנייה') }),
    run({ a, b }) {
      const x = input(a, 'a', 2000)
      const y = String(b ?? '')
      if (y.length > 2000) throw new Error('b ארוך מדי (מקסימום 2000 תווים)')
      const d = levenshtein(x, y)
      const mx = Math.max([...x].length, [...y].length) || 1
      return `מרחק: ${d}\nדמיון: ${Math.round((1 - d / mx) * 100)}%`
    },
  },
  {
    name: 'dev_checksum',
    description: 'מחשב CRC32 של טקסט, בודק ספרת ביקורת Luhn (כרטיס אשראי), או תעודת זהות ישראלית.',
    parameters: obj({ mode: oneOf(['crc32', 'luhn', 'il_id'], 'סוג הבדיקה'), text: str('הטקסט או המספר') }),
    run({ mode, text }) {
      const t = input(text, 'ערך', 5000)
      if (mode === 'crc32') {
        const c = crc32(Buffer.from(t, 'utf8'))
        return `CRC32: ${c.toString(16).padStart(8, '0')} (דצימלי ${c})`
      }
      const digits = t.replace(/[\s-]/g, '')
      if (mode === 'luhn') {
        if (!/^\d{2,40}$/.test(digits)) throw new Error('צריך 2 עד 40 ספרות')
        const ok = luhnSum(digits, false) % 10 === 0
        const check = (10 - (luhnSum(digits.slice(0, -1) + '0', false) % 10)) % 10
        return `${ok ? 'תקין' : 'לא תקין'} לפי Luhn (ספרת ביקורת נכונה לקידומת הזו: ${check})`
      }
      if (mode === 'il_id') {
        if (!/^\d{1,9}$/.test(digits)) throw new Error('תעודת זהות היא עד 9 ספרות')
        const p = digits.padStart(9, '0')
        let sum = 0
        for (let i = 0; i < 9; i++) {
          let d = Number(p[i]) * (i % 2 === 0 ? 1 : 2)
          if (d > 9) d -= 9
          sum += d
        }
        return `${p}: ${sum % 10 === 0 ? 'ספרת ביקורת תקינה' : 'ספרת ביקורת לא תקינה'}`
      }
      throw new Error('סוג בדיקה לא מוכר')
    },
  },
  {
    name: 'dev_url_parse',
    description: 'מפרק כתובת URL לחלקיה: פרוטוקול, מארח, פורט, נתיב, פרמטרים ו-hash.',
    parameters: obj({ url: str('הכתובת המלאה') }),
    run({ url }) {
      let u
      try {
        u = new URL(input(url, 'כתובת', 4000).trim())
      } catch {
        throw new Error('כתובת לא תקינה (צריך כולל https://)')
      }
      const params = [...u.searchParams].slice(0, 30).map(([k, v]) => `  ${k} = ${v}`)
      const ipKind = net.isIP(u.hostname.replace(/^\[|\]$/g, ''))
      return clip(
        [
          `פרוטוקול: ${u.protocol}`,
          u.username ? `משתמש: ${u.username} (סיסמה מוסתרת)` : '',
          `מארח: ${u.hostname}${ipKind ? ` (כתובת IPv${ipKind})` : ''}`,
          `פורט: ${u.port || '(ברירת מחדל)'}`,
          `נתיב: ${u.pathname}`,
          params.length ? `פרמטרים:\n${params.join('\n')}` : '',
          u.hash ? `hash: ${u.hash}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    },
  },
  {
    name: 'dev_port_lookup',
    description: 'מחפש איזה שירות רץ בדרך כלל על פורט (למשל 5432), או איזה פורט שייך לשירות (למשל redis).',
    parameters: obj({ query: str('מספר פורט או שם שירות') }),
    run({ query }) {
      const q = String(need(query, 'שאילתה')).trim().toLowerCase()
      if (/^\d+$/.test(q)) {
        const p = Number(q)
        if (p > 65535) throw new Error('פורט חייב להיות 0 עד 65535')
        if (PORTS[p]) return `${p}: ${PORTS[p]}`
        return `${p}: לא ברשימה (${p < 1024 ? 'פורט מערכת 0-1023' : p < 49152 ? 'פורט רשום 1024-49151' : 'פורט דינמי 49152+'})`
      }
      const hits = Object.entries(PORTS).filter(([, v]) => v.toLowerCase().includes(q))
      if (!hits.length) throw new Error('שירות לא נמצא ברשימה')
      return hits.map(([k, v]) => `${k}: ${v}`).join('\n')
    },
  },
]

const J = '{"a":{"b":[1,2,{"c":"x"}]},"list":[{"n":1},{"n":2}]}'
const jwt = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"123","exp":1700000000}').toString('base64url')}.sig`

export const tests = [
  { tool: 'dev_base_convert', args: { value: 'ff', from_base: 16, to_base: 10 }, check: (r) => r.startsWith('ff (בסיס 16) = 255') },
  { tool: 'dev_base_convert', args: { value: '255', to_base: 2 }, check: (r) => r.includes('= 11111111 ') },
  { tool: 'dev_base_convert', args: { value: 'ffffffffffffffffffff', from_base: 16, to_base: 10 }, check: (r) => r.includes('1208925819614629174706175') },
  { tool: 'dev_base_convert', args: { value: '129', from_base: 8 }, throws: true, check: () => false },
  { tool: 'dev_bitwise', args: { op: 'and', a: '12', b: '10' }, check: (r) => r.startsWith('and: 8') },
  { tool: 'dev_bitwise', args: { op: 'xor', a: '12', b: '10' }, check: (r) => r.startsWith('xor: 6') },
  { tool: 'dev_bitwise', args: { op: 'shl', a: '1', b: '4' }, check: (r) => r.startsWith('shl: 16') },
  { tool: 'dev_bitwise', args: { op: 'not', a: '5' }, check: (r) => r.startsWith('not: -6') },
  { tool: 'dev_json_format', args: { json: '{"a": [1, 2]}', mode: 'minify' }, check: (r) => r === '{"a":[1,2]}' },
  { tool: 'dev_json_format', args: { json: '{"a":1}' }, check: (r) => r.includes('אובייקט עם 1 מפתחות') },
  { tool: 'dev_json_format', args: { json: '{a:1}' }, throws: true, check: () => false },
  { tool: 'dev_json_path', args: { json: J, path: 'a.b[2].c' }, check: (r) => r === '"x"' },
  { tool: 'dev_json_path', args: { json: J, path: '$.list[*].n' }, check: (r) => JSON.stringify(JSON.parse(r)) === '[1,2]' },
  { tool: 'dev_json_path', args: { json: J, path: 'a.zzz' }, throws: true, check: () => false },
  { tool: 'dev_json_csv', args: { mode: 'json_to_csv', text: '[{"a":1,"b":"x,y"},{"a":2,"b":"z"}]' }, check: (r) => r === 'a,b\n1,"x,y"\n2,z' },
  { tool: 'dev_json_csv', args: { mode: 'csv_to_json', text: 'a,b\n1,"x,y"\n' }, check: (r) => JSON.stringify(JSON.parse(r)) === '[{"a":"1","b":"x,y"}]' },
  { tool: 'dev_regex_test', args: { pattern: '(\\d+)-(\\d+)', text: 'tel 050-1234 ok' }, check: (r) => r.includes('"050-1234"') && r.includes('$1="050"') && r.includes('ב-4') },
  { tool: 'dev_regex_test', args: { pattern: '(a+)+$', text: 'aaaaaaaaaaaaaaaaaaaaaaaa!' }, throws: true, check: () => false },
  { tool: 'dev_cron', args: { cron: '*/15 9 * * *', from: '2025-01-01T00:00:00', count: 3 }, check: (r) => r.includes('1. 2025-01-01 09:00') && r.includes('2. 2025-01-01 09:15') && r.includes('3. 2025-01-01 09:30') },
  { tool: 'dev_cron', args: { cron: '0 8 * * 1', from: '2025-01-01T00:00:00', count: 1 }, check: (r) => r.includes('2025-01-06 08:00 (יום שני)') },
  { tool: 'dev_cron', args: { cron: '61 * * * *' }, throws: true, check: () => false },
  { tool: 'dev_http_status', args: { query: '404' }, check: (r) => r.startsWith('404 Not Found') },
  { tool: 'dev_http_status', args: { query: '1000' }, throws: true, check: () => false },
  { tool: 'dev_jwt_decode', args: { token: jwt }, check: (r) => r.includes('"alg":"HS256"') && r.includes('exp: 2023-11-14T22:13:20.000Z') && r.includes('לא אומתה') },
  { tool: 'dev_semver', args: { a: '1.10.0', b: '1.9.9' }, check: (r) => r.includes('חדשה מ') },
  { tool: 'dev_semver', args: { a: '1.0.0-alpha', b: '1.0.0' }, check: (r) => r.includes('ישנה מ') },
  { tool: 'dev_semver', args: { a: '1.5.2', range: '^1.2.0' }, check: (r) => r.includes('עומדת בטווח') && !r.includes('לא עומדת') },
  { tool: 'dev_semver', args: { a: '2.0.0', range: '^1.2.0' }, check: (r) => r.includes('לא עומדת') },
  { tool: 'dev_semver', args: { a: '0.2.5', range: '^0.2.3' }, check: (r) => !r.includes('לא עומדת') },
  { tool: 'dev_semver', args: { a: '1.3.0', range: '~1.2.0' }, check: (r) => r.includes('לא עומדת') },
  { tool: 'dev_color', args: { color: '#ff0000' }, check: (r) => r.includes('rgb(255, 0, 0)') && r.includes('hsl(0, 100%, 50%)') },
  { tool: 'dev_color', args: { color: 'hsl(120, 100%, 50%)' }, check: (r) => r.includes('hex: #00ff00') },
  { tool: 'dev_color', args: { color: '#000', color2: '#fff' }, check: (r) => r.includes('21:1') },
  { tool: 'dev_cidr', args: { cidr: '192.168.1.130/26' }, check: (r) => r.includes('רשת: 192.168.1.128/26') && r.includes('מסכה: 255.255.255.192') && r.includes('שידור: 192.168.1.191') && r.includes('מספר מארחים: 62') },
  { tool: 'dev_cidr', args: { cidr: '10.0.0.1/33' }, throws: true, check: () => false },
  { tool: 'dev_chmod', args: { value: '755' }, check: (r) => r.startsWith('755 = rwxr-xr-x') },
  { tool: 'dev_chmod', args: { value: 'rw-r--r--' }, check: (r) => r.startsWith('rw-r--r-- = 644') },
  { tool: 'dev_epoch', args: { value: '0' }, check: (r) => r.includes('1970-01-01T00:00:00.000Z') },
  { tool: 'dev_epoch', args: { value: '1700000000' }, check: (r) => r.includes('2023-11-14T22:13:20.000Z') },
  { tool: 'dev_epoch', args: { value: '2023-11-14T22:13:20Z' }, check: (r) => r.includes('שניות: 1700000000') },
  { tool: 'dev_levenshtein', args: { a: 'kitten', b: 'sitting' }, check: (r) => r.startsWith('מרחק: 3') },
  { tool: 'dev_checksum', args: { mode: 'crc32', text: '123456789' }, check: (r) => r.startsWith('CRC32: cbf43926') },
  { tool: 'dev_checksum', args: { mode: 'luhn', text: '79927398713' }, check: (r) => r.startsWith('תקין') },
  { tool: 'dev_checksum', args: { mode: 'luhn', text: '79927398710' }, check: (r) => r.startsWith('לא תקין') && r.includes('3)') },
  { tool: 'dev_checksum', args: { mode: 'il_id', text: '18' }, check: (r) => r.includes('000000018') && r.includes('תקינה') && !r.includes('לא תקינה') },
  { tool: 'dev_url_parse', args: { url: 'https://user:pw@example.com:8080/a/b?x=1&y=2#top' }, check: (r) => r.includes('מארח: example.com') && r.includes('פורט: 8080') && r.includes('y = 2') && r.includes('hash: #top') && !r.includes('pw') },
  { tool: 'dev_port_lookup', args: { query: '5432' }, check: (r) => r.includes('PostgreSQL') },
  { tool: 'dev_port_lookup', args: { query: 'redis' }, check: (r) => r.startsWith('6379') },
]
