// Conversions, dates and time. Fully offline: everything is computed locally (UTC arithmetic for date-only math,
// Intl for time zones and the Hebrew calendar).
import { str, num, obj, oneOf, toNumber, need, lines, clip } from './_kit.js'

export const category = 'units'
export const blurb = 'המרות יחידות, תאריכים וזמן'

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(10))))
const DAY = 86400000

// ---------- unit conversion ----------
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/["'״׳`’.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const GROUPS = {
  length: [
    [1, 'מטר|מטרים|m|meter|meters|metre|metres'],
    [0.01, 'סמ|סנטימטר|סנטימטרים|cm|centimeter|centimeters'],
    [0.001, 'ממ|מילימטר|מילימטרים|mm|millimeter|millimeters'],
    [1000, 'קמ|קילומטר|קילומטרים|km|kilometer|kilometers|kilometre'],
    [1609.344, 'מייל|מיילים|מיל|mile|miles|mi'],
    [0.3048, 'רגל|פיט|feet|foot|ft'],
    [0.0254, 'אינץ|אינצים|inch|inches|in'],
    [0.9144, 'יארד|יארדים|yard|yards|yd'],
    [1852, 'מייל ימי|nmi'],
  ],
  mass: [
    [1, 'קילו|קילוגרם|קג|kg|kilo|kilogram|kilograms'],
    [0.001, 'גרם|גר|g|gram|grams'],
    [0.000001, 'מג|מיליגרם|mg|milligram'],
    [1000, 'טון|tonne|ton|tons'],
    [0.45359237, 'פאונד|ליברה|lb|lbs|pound|pounds'],
    [0.028349523125, 'אונקיה|אונקיות|oz|ounce|ounces'],
  ],
  volume: [
    [1, 'ליטר|ליטרים|l|liter|liters|litre|litres'],
    [0.001, 'מל|מיליליטר|מיליליטרים|ml|milliliter|milliliters'],
    [0.01, 'סל|סנטיליטר|cl'],
    [3.785411784, 'גלון|גלונים|gallon|gallons|gal'],
    [0.24, 'כוס|כוסות|cup|cups'],
    [0.015, 'כף|כפות|tbsp|tablespoon|tablespoons'],
    [0.005, 'כפית|כפיות|tsp|teaspoon|teaspoons'],
    [0.473176473, 'פינט|pint|pints|pt'],
    [0.0295735295625, 'fl oz|floz|אונקיית נוזל'],
    [1000, 'מטר מעוקב|מק|m3|cubic meter'],
  ],
  speed: [
    [1, 'מטר לשנייה|מטר לשניה|מש|m/s|ms'],
    [1 / 3.6, 'קמש|קילומטר לשעה|קמ לשעה|kmh|km/h|kph'],
    [0.44704, 'מייל לשעה|mph'],
    [0.514444444, 'קשר|קשרים|knot|knots|kn'],
  ],
  area: [
    [1, 'מר|מטר רבוע|מטר מרובע|מ2|m2|sqm'],
    [0.0001, 'סמר|סמ רבוע|cm2'],
    [1e6, 'קמר|קמ רבוע|km2'],
    [1000, 'דונם|dunam|dunams'],
    [10000, 'הקטר|hectare|hectares|ha'],
    [4046.8564224, 'אקר|אקרים|acre|acres'],
    [0.09290304, 'רגל רבועה|sqft|sq ft'],
  ],
  data: [
    [1, 'בייט|בתים|byte|bytes'],
    [0.125, 'ביט|bit|bits'],
    [1e3, 'קילובייט|kb|kilobyte|kilobytes'],
    [1e6, 'מגהבייט|מגה|mb|megabyte|megabytes'],
    [1e9, 'גיגהבייט|גיגה|גיגבייט|gb|gigabyte|gigabytes'],
    [1e12, 'טרהבייט|טרה|tb|terabyte|terabytes'],
    [1024, 'kib|קיביבייט'],
    [1048576, 'mib|מביבייט'],
    [1073741824, 'gib|גביבייט'],
  ],
}
const TEMP = { c: 'צלזיוס|מעלות צלזיוס|c|celsius', f: 'פרנהייט|מעלות פרנהייט|f|fahrenheit', k: 'קלווין|k|kelvin' }

const UNITS = new Map() // normalised name -> { group, factor } | { group: 'temp', t }
for (const [group, rows] of Object.entries(GROUPS)) for (const [factor, names] of rows) for (const n of names.split('|')) UNITS.set(norm(n), { group, factor })
for (const [t, names] of Object.entries(TEMP)) for (const n of names.split('|')) UNITS.set(norm(n), { group: 'temp', t })

function findUnit(name) {
  const key = norm(need(name, 'יחידה'))
  const u = UNITS.get(key) ?? UNITS.get(key.replace(/ים$|ות$/, ''))
  if (!u) throw new Error(`יחידה לא מוכרת: ${name}`)
  return u
}

function convertValue(value, from, to) {
  const a = findUnit(from)
  const b = findUnit(to)
  if (a.group !== b.group) throw new Error('אי אפשר להמיר בין סוגים שונים של יחידות')
  if (a.group === 'temp') {
    const c = a.t === 'c' ? value : a.t === 'f' ? ((value - 32) * 5) / 9 : value - 273.15
    return b.t === 'c' ? c : b.t === 'f' ? (c * 9) / 5 + 32 : c + 273.15
  }
  return (value * a.factor) / b.factor
}

// ---------- cooking ----------
// Grams per ml.
const DENSITY = [
  ['מים|water', 1],
  ['קמח|flour', 125 / 240],
  ['סוכר|sugar', 200 / 240],
  ['סוכר חום|brown sugar', 213 / 240],
  ['אבקת סוכר|powdered sugar', 120 / 240],
  ['חמאה|butter', 227 / 240],
  ['שמן|oil', 218 / 240],
  ['חלב|milk', 245 / 240],
  ['דבש|honey', 340 / 240],
  ['אורז|rice', 185 / 240],
  ['מלח|salt', 288 / 240],
  ['קקאו|cocoa', 85 / 240],
  ['שוקולד צ׳יפס|chocolate chips', 170 / 240],
  ['שיבולת שועל|oats', 90 / 240],
]
const densityOf = (name) => {
  const key = norm(need(name, 'מצרך'))
  for (const [names, d] of DENSITY) if (names.split('|').some((n) => norm(n) === key)) return d
  throw new Error(`מצרך לא מוכר: ${name}. מוכרים: מים, קמח, סוכר, חמאה, שמן, חלב, דבש, אורז, מלח, קקאו`)
}

// ---------- dates ----------
const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

function mk(y, m, d) {
  const dt = new Date(0)
  dt.setUTCFullYear(y, m - 1, d)
  dt.setUTCHours(0, 0, 0, 0)
  return dt
}
function parseDate(input, name = 'תאריך') {
  const s = String(need(input, name)).trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  let y, mo, d
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]]
  else if ((m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s))) [d, mo, y] = [+m[1], +m[2], +m[3]]
  else throw new Error(`${name} לא תקין, צריך YYYY-MM-DD`)
  const dt = mk(y, mo, d)
  if (y < 1000 || y > 9999 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error(`${name} לא קיים: ${s}`)
  return dt
}
const iso = (dt) => `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
const dayName = (dt) => `יום ${HE_DAYS[dt.getUTCDay()]}`
const daysBetween = (a, b) => Math.round((b - a) / DAY)
const daysInMonth = (y, m) => (m === 1 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m])

function addMonths(dt, months) {
  const total = dt.getUTCFullYear() * 12 + dt.getUTCMonth() + months
  const y = Math.floor(total / 12)
  const m = total - y * 12
  if (y < 1000 || y > 9999) throw new Error('התאריך מחוץ לטווח')
  return mk(y, m + 1, Math.min(dt.getUTCDate(), daysInMonth(y, m)))
}
function intArg(v, name) {
  if (v === undefined || v === null || v === '') return 0
  const n = toNumber(v, name)
  if (!Number.isInteger(n) || Math.abs(n) > 100000) throw new Error(`${name} חייב להיות מספר שלם סביר`)
  return n
}
// Whole years, months, days between a <= b using calendar months (end of month clamps).
function ymd(a, b) {
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())
  if (addMonths(a, months) > b) months--
  const rest = addMonths(a, months)
  return { years: Math.floor(months / 12), months: months % 12, days: daysBetween(rest, b) }
}
const part = (n, one, _two, many) => (n === 1 ? one : `${n} ${many}`)
function joinHe(items) {
  if (items.length <= 1) return items[0] ?? ''
  const last = items.at(-1)
  return `${items.slice(0, -1).join(', ')} ${/^\d/.test(last) ? 'ו-' : 'ו'}${last}`
}
function ymdText({ years, months, days }) {
  const p = []
  if (years) p.push(part(years, 'שנה', 'שנתיים', 'שנים'))
  if (months) p.push(part(months, 'חודש', 'חודשיים', 'חודשים'))
  if (days || !p.length) p.push(part(days, 'יום', 'יומיים', 'ימים'))
  return joinHe(p)
}

// ---------- time zones ----------
const ZONE_ALIASES = [
  ['תל אביב', 'Asia/Jerusalem'], ['ירושלים', 'Asia/Jerusalem'], ['ישראל', 'Asia/Jerusalem'], ['israel', 'Asia/Jerusalem'], ['jerusalem', 'Asia/Jerusalem'], ['tel aviv', 'Asia/Jerusalem'],
  ['ניו יורק', 'America/New_York'], ['new york', 'America/New_York'], ['nyc', 'America/New_York'], ['מיאמי', 'America/New_York'], ['miami', 'America/New_York'],
  ['לונדון', 'Europe/London'], ['london', 'Europe/London'],
  ['טוקיו', 'Asia/Tokyo'], ['tokyo', 'Asia/Tokyo'],
  ['פריז', 'Europe/Paris'], ['paris', 'Europe/Paris'],
  ['ברלין', 'Europe/Berlin'], ['berlin', 'Europe/Berlin'],
  ['רומא', 'Europe/Rome'], ['rome', 'Europe/Rome'],
  ['מדריד', 'Europe/Madrid'], ['madrid', 'Europe/Madrid'],
  ['אמסטרדם', 'Europe/Amsterdam'], ['amsterdam', 'Europe/Amsterdam'],
  ['ציריך', 'Europe/Zurich'], ['zurich', 'Europe/Zurich'],
  ['אתונה', 'Europe/Athens'], ['athens', 'Europe/Athens'],
  ['איסטנבול', 'Europe/Istanbul'], ['istanbul', 'Europe/Istanbul'],
  ['לוס אנג׳לס', 'America/Los_Angeles'], ['לוס אנגלס', 'America/Los_Angeles'], ['לוס אנג לס', 'America/Los_Angeles'], ['los angeles', 'America/Los_Angeles'], ['סן פרנסיסקו', 'America/Los_Angeles'], ['san francisco', 'America/Los_Angeles'],
  ['שיקגו', 'America/Chicago'], ['chicago', 'America/Chicago'],
  ['טורונטו', 'America/Toronto'], ['toronto', 'America/Toronto'],
  ['מקסיקו סיטי', 'America/Mexico_City'], ['mexico city', 'America/Mexico_City'],
  ['סאו פאולו', 'America/Sao_Paulo'], ['sao paulo', 'America/Sao_Paulo'],
  ['בואנוס איירס', 'America/Argentina/Buenos_Aires'], ['buenos aires', 'America/Argentina/Buenos_Aires'],
  ['מוסקבה', 'Europe/Moscow'], ['moscow', 'Europe/Moscow'],
  ['דובאי', 'Asia/Dubai'], ['dubai', 'Asia/Dubai'],
  ['מומבאי', 'Asia/Kolkata'], ['דלהי', 'Asia/Kolkata'], ['הודו', 'Asia/Kolkata'], ['mumbai', 'Asia/Kolkata'], ['delhi', 'Asia/Kolkata'],
  ['בנגקוק', 'Asia/Bangkok'], ['bangkok', 'Asia/Bangkok'],
  ['סינגפור', 'Asia/Singapore'], ['singapore', 'Asia/Singapore'],
  ['הונג קונג', 'Asia/Hong_Kong'], ['hong kong', 'Asia/Hong_Kong'],
  ['בייגינג', 'Asia/Shanghai'], ['שנגחאי', 'Asia/Shanghai'], ['beijing', 'Asia/Shanghai'], ['shanghai', 'Asia/Shanghai'],
  ['סיאול', 'Asia/Seoul'], ['seoul', 'Asia/Seoul'],
  ['סידני', 'Australia/Sydney'], ['sydney', 'Australia/Sydney'],
  ['מלבורן', 'Australia/Melbourne'], ['melbourne', 'Australia/Melbourne'],
  ['אוקלנד', 'Pacific/Auckland'], ['auckland', 'Pacific/Auckland'],
  ['קהיר', 'Africa/Cairo'], ['cairo', 'Africa/Cairo'],
  ['יוהנסבורג', 'Africa/Johannesburg'], ['johannesburg', 'Africa/Johannesburg'],
  ['הוואי', 'Pacific/Honolulu'], ['honolulu', 'Pacific/Honolulu'],
  ['utc', 'UTC'], ['gmt', 'UTC'],
]
const ALIAS = new Map(ZONE_ALIASES.map(([k, v]) => [norm(k), v]))

function resolveZone(name, fallback) {
  if (name === undefined || name === null || name === '') {
    if (fallback) return fallback
    throw new Error('חסרה עיר או אזור זמן')
  }
  const raw = String(name).trim()
  if (raw.length > 60) throw new Error('שם עיר ארוך מדי')
  const hit = ALIAS.get(norm(raw))
  if (hit) return hit
  if (/^[A-Za-z]+(?:[_+-][A-Za-z0-9]+)*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(raw)) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: raw })
      return raw
    } catch {
      /* falls through */
    }
  }
  throw new Error(`עיר או אזור זמן לא מוכרים: ${raw}`)
}

const dtfCache = new Map()
function zoneParts(ms, zone) {
  let f = dtfCache.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    dtfCache.set(zone, f)
  }
  const o = {}
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = +p.value
  return o
}
function offsetMs(ms, zone) {
  const base = Math.floor(ms / 1000) * 1000
  const p = zoneParts(base, zone)
  const asUtc = new Date(0)
  asUtc.setUTCFullYear(p.year, p.month - 1, p.day)
  asUtc.setUTCHours(p.hour, p.minute, p.second, 0)
  return asUtc.getTime() - base
}
function localToUtc(y, mo, d, h, mi, zone) {
  const guess = mk(y, mo, d).getTime() + h * 3600000 + mi * 60000
  const o1 = offsetMs(guess, zone)
  let t = guess - o1
  const o2 = offsetMs(t, zone)
  if (o2 !== o1) t = guess - o2
  return t
}
// "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (also with T) interpreted in a zone.
function parseLocal(input, zone, name = 'זמן') {
  const m = /^(\d{4}-\d{1,2}-\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(String(need(input, name)).trim())
  if (!m) throw new Error(`${name} לא תקין, צריך YYYY-MM-DD HH:MM`)
  const d = parseDate(m[1])
  const h = m[2] === undefined ? 0 : +m[2]
  const mi = m[3] === undefined ? 0 : +m[3]
  if (h > 23 || mi > 59) throw new Error(`${name}: שעה לא תקינה`)
  return localToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi, zone)
}
function offsetLabel(ms, zone) {
  const o = offsetMs(ms, zone) / 60000
  const sign = o < 0 ? '-' : '+'
  const a = Math.abs(o)
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}`
}
function showInZone(ms, zone) {
  const p = zoneParts(ms, zone)
  const dt = mk(p.year, p.month, p.day)
  return `${iso(dt)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} (${dayName(dt)}, ${offsetLabel(ms, zone)})`
}

// ---------- Hebrew calendar ----------
const HEB_MONTHS = {
  tishri: 'תשרי', heshvan: 'חשוון', kislev: 'כסלו', tevet: 'טבת', shevat: 'שבט', adar: 'אדר', 'adar i': 'אדר א׳', 'adar ii': 'אדר ב׳',
  nisan: 'ניסן', iyar: 'אייר', sivan: 'סיוון', tamuz: 'תמוז', av: 'אב', elul: 'אלול',
}
const HEB_INPUT = new Map(
  Object.entries({
    tishri: 'תשרי tishri tishrei', heshvan: 'חשוון חשון cheshvan heshvan', kislev: 'כסלו kislev', tevet: 'טבת tevet', shevat: 'שבט shevat',
    adar: 'אדר adar', 'adar i': 'אדר א adar1', 'adar ii': 'אדר ב adar2', nisan: 'ניסן nisan', iyar: 'אייר iyar', sivan: 'סיוון סיון sivan',
    tamuz: 'תמוז tamuz', av: 'אב av', elul: 'אלול elul',
  }).flatMap(([k, v]) => v.split(' ').map((n) => [norm(n), k])),
)
const hebParts = new Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' })
function hebOf(dt) {
  const o = {}
  for (const p of hebParts.formatToParts(dt)) if (p.type !== 'literal') o[p.type] = p.value
  return { day: +o.day, month: o.month.toLowerCase(), year: +o.year }
}

// ---------- Israel DST ----------
function lastSunday(y, month) {
  const last = mk(y, month, 31)
  return mk(y, month, 31 - last.getUTCDay())
}
const clipAll = (t) => clip(t, 1500)

export const tools = [
  {
    name: 'units_convert',
    description: 'ממיר ערך בין יחידות: אורך, משקל, נפח, מהירות, שטח, נפח נתונים וטמפרטורה (עברית או אנגלית).',
    parameters: obj({ value: num('המספר להמרה'), from: str('יחידת מקור, למשל ק"מ, מייל, פאונד, F'), to: str('יחידת יעד') }),
    run({ value, from, to }) {
      const v = toNumber(need(value, 'ערך'), 'ערך')
      const r = convertValue(v, from, to)
      return `${fmt(v)} ${from} = ${fmt(r)} ${to}`
    },
  },
  {
    name: 'units_cooking',
    description: 'ממיר כמויות בישול בין כוסות, כפות, כפיות, מ"ל, ליטר וגרמים לפי מצרך (קמח, סוכר, חמאה, מים ועוד).',
    parameters: obj({ amount: num('הכמות'), from: str('יחידת מקור: כוס, כף, כפית, מ"ל, גרם...'), to: str('יחידת יעד'), ingredient: str('המצרך, חובה רק כשממירים בין נפח למשקל') }, ['amount', 'from', 'to']),
    run({ amount, from, to, ingredient }) {
      const v = toNumber(need(amount, 'כמות'), 'כמות')
      const a = findUnit(from)
      const b = findUnit(to)
      const ok = ['volume', 'mass']
      if (!ok.includes(a.group) || !ok.includes(b.group)) throw new Error('רק נפח (כוס, כף, מ"ל) ומשקל (גרם, קילו)')
      let r
      if (a.group === b.group) r = convertValue(v, from, to)
      else {
        const d = densityOf(ingredient) // g per ml
        if (a.group === 'volume') r = (v * a.factor * 1000 * d) / (b.factor * 1000) // base: ml -> g -> kg
        else r = (v * a.factor * 1000) / d / 1000 / b.factor
      }
      return `${fmt(v)} ${from}${ingredient ? ` ${ingredient}` : ''} = ${fmt(r)} ${to} (כוס = 240 מ"ל, כף = 15 מ"ל, כפית = 5 מ"ל)`
    },
  },
  {
    name: 'units_fuel',
    description: 'צריכת דלק: מ-ק"מ לליטר ללליטרים ל-100 ק"מ ולהפך, או עלות נסיעה לפי מרחק, צריכה ומחיר ליטר.',
    parameters: obj(
      { mode: oneOf(['kmpl_to_l100', 'l100_to_kmpl', 'trip_cost'], 'kmpl_to_l100 / l100_to_kmpl / trip_cost'), value: num('הצריכה (ק"מ לליטר, או ליטר ל-100 ק"מ)'), distance_km: num('מרחק בק"מ, ל-trip_cost'), price_per_liter: num('מחיר ליטר, ל-trip_cost') },
      ['mode', 'value'],
    ),
    run({ mode, value, distance_km, price_per_liter }) {
      const v = toNumber(need(value, 'ערך'), 'ערך')
      if (v <= 0) throw new Error('הערך חייב להיות חיובי')
      if (mode === 'kmpl_to_l100') return `${fmt(v)} ק"מ לליטר = ${fmt(100 / v)} ליטר ל-100 ק"מ`
      if (mode === 'l100_to_kmpl') return `${fmt(v)} ליטר ל-100 ק"מ = ${fmt(100 / v)} ק"מ לליטר`
      if (mode === 'trip_cost') {
        const km = toNumber(need(distance_km, 'מרחק'), 'מרחק')
        const price = toNumber(need(price_per_liter, 'מחיר ליטר'), 'מחיר')
        if (km < 0 || price < 0) throw new Error('מרחק ומחיר לא יכולים להיות שליליים')
        const liters = (km * v) / 100
        return `${fmt(km)} ק"מ דורשים ${fmt(Math.round(liters * 100) / 100)} ליטר, עלות ${fmt(Math.round(liters * price * 100) / 100)}`
      }
      throw new Error('מצב לא מוכר')
    },
  },
  {
    name: 'date_diff',
    description: 'מחשב כמה ימים (וכמה שנים/חודשים/ימים) יש בין שני תאריכים בפורמט YYYY-MM-DD.',
    parameters: obj({ from: str('תאריך התחלה YYYY-MM-DD'), to: str('תאריך סיום YYYY-MM-DD') }),
    run({ from, to }) {
      const a = parseDate(from, 'תאריך התחלה')
      const b = parseDate(to, 'תאריך סיום')
      const days = daysBetween(a, b)
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      return `${Math.abs(days)} ימים ${days < 0 ? '(התאריך השני קודם) ' : ''}= ${ymdText(ymd(lo, hi))} (${Math.floor(Math.abs(days) / 7)} שבועות ו-${Math.abs(days) % 7} ימים)`
    },
  },
  {
    name: 'date_add',
    description: 'מוסיף או מחסיר ימים, שבועות, חודשים ושנים (מספר שלילי מחסיר) לתאריך YYYY-MM-DD.',
    parameters: obj({ date: str('תאריך YYYY-MM-DD'), days: num('ימים'), weeks: num('שבועות'), months: num('חודשים'), years: num('שנים') }, ['date']),
    run({ date, days, weeks, months, years }) {
      let dt = parseDate(date)
      dt = addMonths(dt, intArg(years, 'שנים') * 12 + intArg(months, 'חודשים'))
      dt = new Date(dt.getTime() + (intArg(days, 'ימים') + intArg(weeks, 'שבועות') * 7) * DAY)
      if (dt.getUTCFullYear() < 1000 || dt.getUTCFullYear() > 9999) throw new Error('התאריך מחוץ לטווח')
      return `${iso(dt)} (${dayName(dt)})`
    },
  },
  {
    name: 'date_weekday',
    description: 'אומר באיזה יום בשבוע חל תאריך YYYY-MM-DD, ואם זה סוף שבוע בישראל.',
    parameters: obj({ date: str('תאריך YYYY-MM-DD') }),
    run({ date }) {
      const dt = parseDate(date)
      const wd = dt.getUTCDay()
      return `${iso(dt)} הוא ${dayName(dt)}${wd === 5 || wd === 6 ? ' (סוף שבוע בישראל)' : ''}`
    },
  },
  {
    name: 'date_age',
    description: 'מחשב גיל מתאריך לידה YYYY-MM-DD (לפי היום, או לפי תאריך "on" אם צוין).',
    parameters: obj({ birth_date: str('תאריך לידה YYYY-MM-DD'), on: str('תאריך ייחוס YYYY-MM-DD, ברירת מחדל היום') }, ['birth_date']),
    run({ birth_date, on }) {
      const b = parseDate(birth_date, 'תאריך לידה')
      const ref = on ? parseDate(on, 'תאריך ייחוס') : parseDate(new Date().toISOString().slice(0, 10))
      if (ref < b) throw new Error('תאריך הלידה אחרי תאריך הייחוס')
      const r = ymd(b, ref)
      return `גיל ${r.years} (${ymdText(r)}), ${daysBetween(b, ref)} ימים מאז הלידה`
    },
  },
  {
    name: 'date_countdown',
    description: 'סופר לאחור (ימים, שעות, דקות) מעכשיו או מזמן "from" עד תאריך/שעה יעד, באזור זמן של עיר (ברירת מחדל ירושלים).',
    parameters: obj({ target: str('יעד YYYY-MM-DD או YYYY-MM-DD HH:MM'), from: str('זמן התחלה באותו פורמט, ברירת מחדל עכשיו'), city: str('עיר או אזור זמן, ברירת מחדל ירושלים') }, ['target']),
    run({ target, from, city }) {
      const zone = resolveZone(city, 'Asia/Jerusalem')
      const t = parseLocal(target, zone, 'יעד')
      const f = from ? parseLocal(from, zone, 'זמן התחלה') : Date.now()
      const diff = t - f
      const abs = Math.abs(diff)
      const d = Math.floor(abs / DAY)
      const h = Math.floor((abs % DAY) / 3600000)
      const m = Math.floor((abs % 3600000) / 60000)
      const text = `${d} ימים, ${h} שעות ו-${m} דקות`
      return diff >= 0 ? `נשארו ${text} (סה"כ ${Math.floor(abs / 3600000)} שעות)` : `היעד עבר לפני ${text}`
    },
  },
  {
    name: 'date_workdays',
    description: 'סופר ימי עבודה בין שני תאריכים כולל (בישראל ראשון עד חמישי; אפשר גם שני עד שישי).',
    parameters: obj({ from: str('תאריך התחלה YYYY-MM-DD'), to: str('תאריך סיום YYYY-MM-DD'), week: oneOf(['israel', 'mon-fri'], 'israel (א-ה, ברירת מחדל) או mon-fri') }, ['from', 'to']),
    run({ from, to, week }) {
      let a = parseDate(from, 'תאריך התחלה')
      let b = parseDate(to, 'תאריך סיום')
      if (a > b) [a, b] = [b, a]
      const span = daysBetween(a, b) + 1
      if (span > 36600) throw new Error('טווח גדול מדי (עד 100 שנה)')
      const work = week === 'mon-fri' ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4]
      let n = 0
      for (let i = 0; i < span; i++) if (work.includes((a.getUTCDay() + i) % 7)) n++
      return `${n} ימי עבודה מתוך ${span} ימים (${iso(a)} עד ${iso(b)}, כולל; בלי חגים)`
    },
  },
  {
    name: 'date_to_hebrew',
    description: 'ממיר תאריך לועזי YYYY-MM-DD לתאריך עברי (חישוב עם לוח השנה העברי של המערכת).',
    parameters: obj({ date: str('תאריך YYYY-MM-DD') }),
    run({ date }) {
      const dt = parseDate(date)
      const he = new Intl.DateTimeFormat('he-u-ca-hebrew', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(dt)
      const letters = new Intl.DateTimeFormat('he-u-ca-hebrew', { timeZone: 'UTC', dateStyle: 'long' }).format(dt)
      return `${iso(dt)} = ${he} (${letters}). התאריך העברי מתחלף בשקיעה.`
    },
  },
  {
    name: 'date_from_hebrew',
    description: 'ממיר תאריך עברי (יום, חודש עברי, שנה כמו 5787) לתאריך לועזי.',
    parameters: obj({ day: num('היום בחודש 1-30'), month: str('שם החודש: תשרי, חשוון, כסלו, טבת, שבט, אדר (א/ב), ניסן, אייר, סיוון, תמוז, אב, אלול'), year: num('שנה עברית, למשל 5787') }),
    run({ day, month, year }) {
      const d = toNumber(need(day, 'יום'), 'יום')
      const y = toNumber(need(year, 'שנה'), 'שנה')
      if (!Number.isInteger(d) || d < 1 || d > 30) throw new Error('יום לא תקין')
      if (!Number.isInteger(y) || y < 5000 || y > 6500) throw new Error('שנה עברית צריכה להיות בין 5000 ל-6500')
      const key = HEB_INPUT.get(norm(need(month, 'חודש')))
      if (!key) throw new Error(`חודש עברי לא מוכר: ${month}`)
      // The Hebrew year starts in autumn of (year - 3761) and ends in the autumn after.
      let cur = mk(y - 3761, 8, 1)
      const end = mk(y - 3760, 11, 1)
      while (cur < end) {
        const h = hebOf(cur)
        if (h.year === y && h.day === d && (h.month === key || (key === 'adar' && h.month === 'adar ii') || (key === 'adar ii' && h.month === 'adar'))) {
          return `${d} ב${HEB_MONTHS[h.month] ?? month} ${y} = ${iso(cur)} (${dayName(cur)})`
        }
        cur = new Date(cur.getTime() + DAY)
      }
      throw new Error('התאריך העברי לא קיים בשנה הזו')
    },
  },
  {
    name: 'date_tz_convert',
    description: 'ממיר שעה בין שתי ערים/אזורי זמן, כולל שעון קיץ: זמן "YYYY-MM-DD HH:MM" בעיר מקור ועיר יעד.',
    parameters: obj({ datetime: str('YYYY-MM-DD HH:MM בעיר המקור'), from_city: str('עיר מקור, למשל ירושלים'), to_city: str('עיר יעד, למשל ניו יורק') }),
    run({ datetime, from_city, to_city }) {
      const a = resolveZone(from_city)
      const b = resolveZone(to_city)
      const ms = parseLocal(datetime, a)
      return `${showInZone(ms, a)} ב${from_city} = ${showInZone(ms, b)} ב${to_city}`
    },
  },
  {
    name: 'date_now_in',
    description: 'מציג את השעה והתאריך הנוכחיים בעיר או באזור זמן (ירושלים, ניו יורק, טוקיו...).',
    parameters: obj({ city: str('עיר או אזור זמן IANA, ברירת מחדל ירושלים') }, []),
    run({ city }) {
      const zone = resolveZone(city, 'Asia/Jerusalem')
      return `${showInZone(Date.now(), zone)} (${zone})`
    },
  },
  {
    name: 'date_unix',
    description: 'ממיר חותמת זמן יוניקס (שניות/מילישניות) לתאריך קריא, או תאריך YYYY-MM-DD HH:MM ליוניקס.',
    parameters: obj({ mode: oneOf(['to_date', 'to_unix'], 'to_date או to_unix'), value: str('חותמת הזמן, או תאריך YYYY-MM-DD HH:MM'), city: str('אזור זמן לתאריך (to_unix), ברירת מחדל UTC') }, ['mode', 'value']),
    run({ mode, value, city }) {
      if (mode === 'to_date') {
        let n = toNumber(need(value, 'חותמת'), 'חותמת')
        if (Math.abs(n) > 1e11) n = Math.floor(n / 1000)
        const ms = n * 1000
        if (!Number.isFinite(new Date(ms).getTime()) || Math.abs(ms) > 253402300799000) throw new Error('חותמת מחוץ לטווח')
        return `${Math.floor(n)} = ${showInZone(ms, 'UTC')} UTC = ${showInZone(ms, 'Asia/Jerusalem')} ירושלים`
      }
      if (mode === 'to_unix') {
        const zone = resolveZone(city, 'UTC')
        return String(Math.floor(parseLocal(value, zone) / 1000))
      }
      throw new Error('מצב לא מוכר')
    },
  },
  {
    name: 'date_week_number',
    description: 'מחזיר את מספר השבוע בשנה (ISO 8601, שבוע מתחיל ביום שני) ואת היום בשנה לתאריך YYYY-MM-DD.',
    parameters: obj({ date: str('תאריך YYYY-MM-DD') }),
    run({ date }) {
      const dt = parseDate(date)
      const wd = dt.getUTCDay() || 7
      const thursday = new Date(dt.getTime() + (4 - wd) * DAY)
      const isoYear = thursday.getUTCFullYear()
      const week = Math.floor(daysBetween(mk(isoYear, 1, 1), thursday) / 7) + 1
      const doy = daysBetween(mk(dt.getUTCFullYear(), 1, 1), dt) + 1
      return `שבוע ${week} של ${isoYear} (ISO), היום ה-${doy} בשנה ${dt.getUTCFullYear()}`
    },
  },
  {
    name: 'date_leap_year',
    description: 'בודק אם שנה לועזית היא שנה מעוברת, וכמה ימים יש בה.',
    parameters: obj({ year: num('שנה, למשל 2028') }),
    run({ year }) {
      const y = toNumber(need(year, 'שנה'), 'שנה')
      if (!Number.isInteger(y) || y < 1 || y > 9999) throw new Error('שנה לא תקינה')
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
      return `${y} ${leap ? 'היא שנה מעוברת (366 ימים, פברואר 29 ימים)' : 'אינה שנה מעוברת (365 ימים)'}`
    },
  },
  {
    name: 'date_format_duration',
    description: 'ממיר מספר שניות למשך קריא בעברית, למשל 7500 שניות = 2 שעות ו-5 דקות.',
    parameters: obj({ seconds: num('מספר שניות') }),
    run({ seconds }) {
      const s = Math.floor(Math.abs(toNumber(need(seconds, 'שניות'), 'שניות')))
      if (s > 1e10) throw new Error('מספר גדול מדי')
      const d = Math.floor(s / 86400)
      const h = Math.floor((s % 86400) / 3600)
      const m = Math.floor((s % 3600) / 60)
      const sec = s % 60
      const p = []
      if (d) p.push(part(d, 'יום', 'יומיים', 'ימים'))
      if (h) p.push(part(h, 'שעה', 'שעתיים', 'שעות'))
      if (m) p.push(part(m, 'דקה', 'שתי דקות', 'דקות'))
      if (sec || !p.length) p.push(part(sec, 'שנייה', 'שתי שניות', 'שניות'))
      return joinHe(p)
    },
  },
  {
    name: 'date_israel_dst',
    description: 'מחזיר מתי מתחיל ומתי נגמר שעון הקיץ בישראל בשנה נתונה (2013 ואילך), מאומת מול Intl.',
    parameters: obj({ year: num('שנה לועזית, למשל 2026') }),
    run({ year }) {
      const y = toNumber(need(year, 'שנה'), 'שנה')
      if (!Number.isInteger(y) || y < 2013 || y > 2037) throw new Error('הכלל תקף לשנים 2013 עד 2037')
      const zone = 'Asia/Jerusalem'
      const start = new Date(lastSunday(y, 3).getTime() - 2 * DAY) // Friday before the last Sunday of March, 02:00
      const end = lastSunday(y, 10) // last Sunday of October, 02:00
      const startMs = start.getTime() + 0 // 02:00 at +02:00 is 00:00 UTC
      const endMs = end.getTime() - 3600000 // 02:00 at +03:00 is 23:00 UTC the day before... minus one hour from 00:00
      const ok = offsetMs(startMs - 3600000, zone) === 7200000 && offsetMs(startMs + 3600000, zone) === 10800000 && offsetMs(endMs - 3600000, zone) === 10800000 && offsetMs(endMs + 3600000, zone) === 7200000
      return lines(
        `שעון קיץ ${y}: מתחיל ב-${iso(start)} (${dayName(start)}) בשעה 02:00, נגמר ב-${iso(end)} (${dayName(end)}) בשעה 02:00 (חוזרים ל-01:00)`,
        ok ? 'אומת מול נתוני אזורי הזמן של המערכת.' : 'שימו לב: נתוני המערכת לא תואמים לחישוב.',
      )
    },
  },
]

for (const t of tools) {
  const run = t.run
  t.run = (args, ctx) => {
    const r = run(args ?? {}, ctx)
    return typeof r === 'string' ? clipAll(r) : r
  }
}

export const tests = [
  { tool: 'units_convert', args: { value: 10, from: 'ק"מ', to: 'מייל' }, check: (r) => r.includes('6.213711922') },
  { tool: 'units_convert', args: { value: 100, from: 'C', to: 'F' }, check: (r) => r.endsWith('= 212 F') },
  { tool: 'units_convert', args: { value: 2, from: 'קילו', to: 'פאונד' }, check: (r) => r.includes('4.409245244') },
  { tool: 'units_convert', args: { value: 1, from: 'GB', to: 'MB' }, check: (r) => r.endsWith('= 1000 MB') },
  { tool: 'units_convert', args: { value: 100, from: 'קמ"ש', to: 'mph' }, check: (r) => r.includes('62.13711922') },
  { tool: 'units_convert', args: { value: 1, from: 'ק"מ', to: 'קילו' }, throws: true, check: () => false },
  { tool: 'units_cooking', args: { amount: 1, from: 'כוס', to: 'גרם', ingredient: 'קמח' }, check: (r) => r.includes('= 125 גרם') },
  { tool: 'units_cooking', args: { amount: 3, from: 'כפות', to: 'מ"ל' }, check: (r) => r.includes('= 45 מ"ל') },
  { tool: 'units_cooking', args: { amount: 200, from: 'גרם', to: 'כוס', ingredient: 'סוכר' }, check: (r) => r.includes('= 1 כוס') },
  { tool: 'units_cooking', args: { amount: 1, from: 'כוס', to: 'גרם' }, throws: true, check: () => false },
  { tool: 'units_fuel', args: { mode: 'kmpl_to_l100', value: 12.5 }, check: (r) => r.includes('= 8 ליטר ל-100') },
  { tool: 'units_fuel', args: { mode: 'l100_to_kmpl', value: 8 }, check: (r) => r.includes('= 12.5 ק"מ לליטר') },
  { tool: 'units_fuel', args: { mode: 'trip_cost', value: 8, distance_km: 200, price_per_liter: 7.5 }, check: (r) => r.includes('16 ליטר') && r.includes('עלות 120') },
  { tool: 'date_diff', args: { from: '2024-01-31', to: '2024-03-01' }, check: (r) => r.startsWith('30 ימים') && r.includes('חודש ויום') },
  { tool: 'date_diff', args: { from: '2026-01-01', to: '2026-12-31' }, check: (r) => r.startsWith('364 ימים') },
  { tool: 'date_diff', args: { from: '2026-02-30', to: '2026-03-01' }, throws: true, check: () => false },
  { tool: 'date_add', args: { date: '2024-01-31', months: 1 }, check: (r) => r.startsWith('2024-02-29') },
  { tool: 'date_add', args: { date: '2026-10-17', weeks: 2, days: -1 }, check: (r) => r.startsWith('2026-10-30') },
  { tool: 'date_add', args: { date: '2026-03-15', years: -1, days: 10 }, check: (r) => r.startsWith('2025-03-25') },
  { tool: 'date_weekday', args: { date: '2026-01-01' }, check: (r) => r.includes('יום חמישי') },
  { tool: 'date_weekday', args: { date: '2026-10-17' }, check: (r) => r.includes('יום שבת') && r.includes('סוף שבוע') },
  { tool: 'date_age', args: { birth_date: '1990-05-15', on: '2026-10-17' }, check: (r) => r.startsWith('גיל 36') && r.includes('5 חודשים ו-2 ימים') && r.includes('13304 ימים') },
  { tool: 'date_age', args: { birth_date: '2030-01-01', on: '2026-10-17' }, throws: true, check: () => false },
  { tool: 'date_countdown', args: { target: '2026-10-20 18:00', from: '2026-10-17 12:00' }, check: (r) => r.includes('3 ימים, 6 שעות ו-0 דקות') },
  { tool: 'date_countdown', args: { target: '2026-10-17', from: '2026-10-18 00:00' }, check: (r) => r.startsWith('היעד עבר') },
  { tool: 'date_workdays', args: { from: '2026-10-18', to: '2026-10-24' }, check: (r) => r.startsWith('5 ימי עבודה מתוך 7') },
  { tool: 'date_workdays', args: { from: '2026-10-18', to: '2026-10-24', week: 'mon-fri' }, check: (r) => r.startsWith('5 ימי עבודה') },
  { tool: 'date_to_hebrew', args: { date: '2026-09-12' }, check: (r) => r.includes('1 בתשרי 5787') },
  { tool: 'date_from_hebrew', args: { day: 1, month: 'תשרי', year: 5787 }, check: (r) => r.includes('2026-09-12') },
  { tool: 'date_from_hebrew', args: { day: 15, month: 'ניסן', year: 5786 }, check: (r) => r.includes('2026-04-02') },
  { tool: 'date_from_hebrew', args: { day: 1, month: 'בלה', year: 5787 }, throws: true, check: () => false },
  { tool: 'date_tz_convert', args: { datetime: '2026-01-15 12:00', from_city: 'ירושלים', to_city: 'ניו יורק' }, check: (r) => r.includes('= 2026-01-15 05:00') },
  { tool: 'date_tz_convert', args: { datetime: '2026-07-01 12:00', from_city: 'Jerusalem', to_city: 'לונדון' }, check: (r) => r.includes('= 2026-07-01 10:00') },
  { tool: 'date_tz_convert', args: { datetime: '2026-01-15 12:00', from_city: 'ירושלים', to_city: 'טוקיו' }, check: (r) => r.includes('= 2026-01-15 19:00') },
  { tool: 'date_tz_convert', args: { datetime: '2026-01-15 12:00', from_city: 'ירושלים', to_city: 'עיר דמיונית' }, throws: true, check: () => false },
  { tool: 'date_now_in', args: { city: 'טוקיו' }, check: (r) => r.includes('UTC+9') },
  { tool: 'date_unix', args: { mode: 'to_date', value: '0' }, check: (r) => r.startsWith('0 = 1970-01-01 00:00') },
  { tool: 'date_unix', args: { mode: 'to_unix', value: '2026-01-01 00:00' }, check: (r) => r === '1767225600' },
  { tool: 'date_week_number', args: { date: '2026-01-01' }, check: (r) => r.startsWith('שבוע 1 של 2026') && r.includes('היום ה-1 ') },
  { tool: 'date_week_number', args: { date: '2026-12-31' }, check: (r) => r.startsWith('שבוע 53 של 2026') },
  { tool: 'date_leap_year', args: { year: 2024 }, check: (r) => r.includes('היא שנה מעוברת') },
  { tool: 'date_leap_year', args: { year: 1900 }, check: (r) => r.includes('אינה שנה מעוברת') },
  { tool: 'date_format_duration', args: { seconds: 7500 }, check: (r) => r === '2 שעות ו-5 דקות' },
  { tool: 'date_format_duration', args: { seconds: 90061 }, check: (r) => r === 'יום, שעה, דקה ושנייה' },
  { tool: 'date_israel_dst', args: { year: 2026 }, check: (r) => r.includes('מתחיל ב-2026-03-27') && r.includes('נגמר ב-2026-10-25') && r.includes('אומת') },
  { tool: 'date_israel_dst', args: { year: 1990 }, throws: true, check: () => false },
]
