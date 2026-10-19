// Israel-specific calculators and info. Offline except the two Hebcal tools.
import { str, num, obj, toNumber, need, lines, fetchJson } from './_kit.js'

export const category = 'israel'
export const blurb = 'מחשבונים ומידע ישראלי: ת"ז, מס, חגים, שבת, מרחקים'

const r2 = (n) => Math.round(n * 100) / 100
const money = (n) => r2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const DAY = 86_400_000

// ---------- dates ----------
function parseDate(input, name = 'תאריך') {
  const s = String(need(input, name)).trim()
  let y, m, d
  let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (mt) [y, m, d] = [mt[1], mt[2], mt[3]]
  else if ((mt = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s))) [d, m, y] = [mt[1], mt[2], mt[3]]
  else throw new Error(`${name} לא תקין, צריך YYYY-MM-DD או DD/MM/YYYY`)
  const ms = Date.UTC(+y, +m - 1, +d)
  const chk = new Date(ms)
  if (chk.getUTCFullYear() !== +y || chk.getUTCMonth() !== +m - 1 || chk.getUTCDate() !== +d) throw new Error(`${name} לא קיים בלוח`)
  return ms
}
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
const todayMs = () => {
  const n = new Date()
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())
}
const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

const hebFmt = new Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: 'UTC', day: 'numeric', month: 'long' })
function hebParts(ms) {
  const p = hebFmt.formatToParts(new Date(ms))
  return { day: Number(p.find((x) => x.type === 'day').value), month: p.find((x) => x.type === 'month').value }
}

// Holiday rules by Hebrew month/day. kind: off = no work, chol = intermediate days, other = not an official day off.
const RULES = [
  { name: 'ראש השנה', month: ['Tishri'], days: [1, 2], kind: 'off' },
  { name: 'יום כיפור', month: ['Tishri'], days: [10], kind: 'off' },
  { name: 'סוכות', month: ['Tishri'], days: [15], kind: 'off' },
  { name: 'חול המועד סוכות', month: ['Tishri'], days: [16, 17, 18, 19, 20, 21], kind: 'chol' },
  { name: 'שמיני עצרת / שמחת תורה', month: ['Tishri'], days: [22], kind: 'off' },
  { name: 'חנוכה (נר ראשון)', month: ['Kislev'], days: [25], kind: 'other' },
  { name: 'ט"ו בשבט', month: ['Shevat'], days: [15], kind: 'other' },
  { name: 'פורים', month: ['Adar', 'Adar II'], days: [14], kind: 'other' },
  { name: 'פסח', month: ['Nisan'], days: [15], kind: 'off' },
  { name: 'חול המועד פסח', month: ['Nisan'], days: [16, 17, 18, 19, 20], kind: 'chol' },
  { name: 'שביעי של פסח', month: ['Nisan'], days: [21], kind: 'off' },
  { name: 'יום הזיכרון (לפי התאריך העברי, ייתכנו הזזות)', month: ['Iyar'], days: [4], kind: 'other' },
  { name: 'יום העצמאות (לפי התאריך העברי, ייתכנו הזזות)', month: ['Iyar'], days: [5], kind: 'off' },
  { name: 'ל"ג בעומר', month: ['Iyar'], days: [18], kind: 'other' },
  { name: 'שבועות', month: ['Sivan'], days: [6], kind: 'off' },
  { name: 'תשעה באב (לפי התאריך העברי, נדחה אם חל בשבת)', month: ['Av'], days: [9], kind: 'other' },
]

function holidaysOfYear(year) {
  const out = []
  for (let ms = Date.UTC(year, 0, 1); new Date(ms).getUTCFullYear() === year; ms += DAY) {
    const h = hebParts(ms)
    for (const r of RULES) if (r.days.includes(h.day) && r.month.includes(h.month)) out.push({ date: iso(ms), name: r.name, kind: r.kind })
  }
  return out
}

const ISRAEL_CITIES = {
  ירושלים: [31.7683, 35.2137], 'תל אביב': [32.0853, 34.7818], חיפה: [32.794, 34.9896], 'באר שבע': [31.2518, 34.7913],
  אילת: [29.5577, 34.9519], נתניה: [32.3215, 34.8532], אשדוד: [31.804, 34.6553], אשקלון: [31.6688, 34.5743],
  'ראשון לציון': [31.973, 34.7925], 'פתח תקווה': [32.084, 34.8878], חולון: [32.0158, 34.7874], 'בני ברק': [32.0807, 34.8338],
  'רמת גן': [32.0684, 34.8248], רחובות: [31.8928, 34.8113], הרצליה: [32.1624, 34.8447], 'כפר סבא': [32.175, 34.9066],
  רעננה: [32.1848, 34.8713], חדרה: [32.434, 34.9196], טבריה: [32.7959, 35.5312], נצרת: [32.6996, 35.3035],
  עפולה: [32.6078, 35.2897], עכו: [32.9281, 35.082], נהריה: [33.0058, 35.0941], צפת: [32.9646, 35.496],
  'קריית שמונה': [33.2075, 35.5696], כרמיאל: [32.917, 35.295], מודיעין: [31.8969, 35.0104], 'בית שמש': [31.747, 34.9881],
  דימונה: [31.07, 35.033], 'מצפה רמון': [30.61, 34.8014], ערד: [31.2589, 35.2128], נתיבות: [31.4208, 34.5886],
  שדרות: [31.525, 34.5967], 'קריית גת': [31.61, 34.7642], לוד: [31.9515, 34.8955], רמלה: [31.9292, 34.8667], יבנה: [31.878, 34.739],
}
function findCity(name, table) {
  const q = String(need(name, 'שם עיר')).trim().replace(/[֑-ׇ"׳']/g, '').replace(/-/g, ' ')
  const keys = Object.keys(table)
  const hit = keys.find((k) => k === q) ?? keys.find((k) => k.startsWith(q)) ?? keys.find((k) => k.includes(q) || q.includes(k))
  if (!hit) throw new Error(`העיר "${name}" לא ברשימה`)
  return hit
}
function haversine([la1, lo1], [la2, lo2]) {
  const rad = Math.PI / 180
  const a = Math.sin(((la2 - la1) * rad) / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(((lo2 - lo1) * rad) / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(a))
}

const GEONAME = { ירושלים: 281184, 'תל אביב': 293397, חיפה: 294801, 'באר שבע': 295530 }

async function hebcalShabbat(city) {
  const key = findCity(city || 'ירושלים', GEONAME)
  const data = await fetchJson(`https://www.hebcal.com/shabbat?cfg=json&geonameid=${GEONAME[key]}`)
  return { key, items: data.items ?? [] }
}
const hhmm = (item) => String(item.date).slice(11, 16)

// ---------- salary (ESTIMATE) ----------
const TAX_YEAR = 2025
const TAX_BRACKETS = [[7010, 0.1], [10060, 0.14], [16150, 0.2], [22440, 0.31], [46690, 0.35], [Infinity, 0.47]] // monthly, approximate
const CREDIT_POINT = 242 // NIS per credit point per month, approximate
const NI_LOW_LIMIT = 7522
const NI_MAX = 50695
const NI_RATES = [0.004, 0.07] // employee national insurance, below / above the low limit
const HEALTH_RATES = [0.031, 0.05]

function estimateNet(gross, points, pensionPct) {
  let tax = 0
  let prev = 0
  for (const [limit, rate] of TAX_BRACKETS) {
    if (gross > prev) tax += (Math.min(gross, limit) - prev) * rate
    prev = limit
  }
  tax = Math.max(0, tax - points * CREDIT_POINT)
  const low = Math.min(gross, NI_LOW_LIMIT)
  const high = Math.max(0, Math.min(gross, NI_MAX) - NI_LOW_LIMIT)
  const ni = low * NI_RATES[0] + high * NI_RATES[1]
  const health = low * HEALTH_RATES[0] + high * HEALTH_RATES[1]
  const pension = (gross * pensionPct) / 100
  return { tax, ni, health, pension, net: gross - tax - ni - health - pension }
}

const EMERGENCY = [
  ['100', 'משטרה'], ['101', 'מגן דוד אדום (מד"א)'], ['102', 'כבאות והצלה'], ['103', 'חברת החשמל (תקלות)'],
  ['104', 'פיקוד העורף'], ['105', 'קו חם להגנה על ילדים ונוער'], ['106', 'מוקד עירוני'], ['1201', 'ער"ן - עזרה ראשונה נפשית'],
]

export const tools = [
  {
    name: 'il_id_check',
    description: 'בודק אם מספר תעודת זהות ישראלית תקין לפי ספרת הביקורת.',
    parameters: obj({ id: str('מספר ת"ז, עד 9 ספרות') }),
    run({ id }) {
      const digits = String(need(id, 'מספר ת"ז')).replace(/[\s-]/g, '')
      if (!/^\d{1,9}$/.test(digits)) throw new Error('ת"ז צריכה להיות 1 עד 9 ספרות')
      const full = digits.padStart(9, '0')
      const sum = [...full].reduce((s, c, i) => {
        const v = Number(c) * (i % 2 === 0 ? 1 : 2)
        return s + (v > 9 ? v - 9 : v)
      }, 0)
      return sum % 10 === 0 ? `${full}: מספר תקין (ספרת הביקורת מתאימה)` : `${full}: מספר לא תקין (ספרת הביקורת לא מתאימה)`
    },
  },
  {
    name: 'il_id_complete',
    description: 'משלים ספרת ביקורת (הספרה התשיעית) למספר ת"ז בן 8 ספרות.',
    parameters: obj({ first8: str('8 הספרות הראשונות') }),
    run({ first8 }) {
      const digits = String(need(first8, '8 ספרות')).replace(/[\s-]/g, '')
      if (!/^\d{1,8}$/.test(digits)) throw new Error('צריך עד 8 ספרות')
      const base = digits.padStart(8, '0')
      const sum = [...base].reduce((s, c, i) => {
        const v = Number(c) * (i % 2 === 0 ? 1 : 2)
        return s + (v > 9 ? v - 9 : v)
      }, 0)
      const check = (10 - (sum % 10)) % 10
      return `${base}${check} (ספרת ביקורת: ${check})`
    },
  },
  {
    name: 'il_phone',
    description: 'מנרמל ובודק מספר טלפון ישראלי: נייד, קווי או VoIP, בפורמט מקומי ובינלאומי.',
    parameters: obj({ phone: str('מספר טלפון, למשל 054-1234567 או +972541234567') }),
    run({ phone }) {
      let d = String(need(phone, 'מספר טלפון')).replace(/[\s\-().]/g, '')
      if (d.startsWith('+972')) d = '0' + d.slice(4)
      else if (d.startsWith('00972')) d = '0' + d.slice(5)
      else if (d.startsWith('972') && d.length >= 11) d = '0' + d.slice(3)
      if (!/^0\d+$/.test(d)) throw new Error('המספר צריך להכיל רק ספרות')
      let type
      let area
      if (/^05\d{8}$/.test(d)) {
        type = 'נייד'
        area = d.slice(0, 3)
      } else if (/^07\d{8}$/.test(d)) {
        type = 'VoIP / חברות תקשורת (07x)'
        area = d.slice(0, 3)
      } else if (/^0[23489]\d{7}$/.test(d)) {
        type = 'קווי'
        area = d.slice(0, 2)
      } else throw new Error('לא נראה כמו מספר ישראלי תקין (נייד 05x+7 ספרות, קווי 0X+7 ספרות)')
      const rest = d.slice(area.length)
      return lines(`סוג: ${type}`, `מקומי: ${area}-${rest}`, `בינלאומי: +972${d.slice(1)}`, `קידומת: ${area}`)
    },
  },
  {
    name: 'il_vat',
    description: 'מחשב מע"מ: מוסיף למחיר לפני מע"מ או מפרק מחיר כולל. שיעור המע"מ ניתן לשינוי.',
    parameters: obj({ amount: num('הסכום'), mode: { type: 'string', enum: ['add', 'remove'], description: 'add: הסכום ללא מע"מ. remove: הסכום כולל מע"מ' }, rate_percent: num('שיעור מע"מ באחוזים, ברירת מחדל 18 (נכון ל-2025)') }, ['amount', 'mode']),
    run({ amount, mode, rate_percent = 18 }) {
      const a = toNumber(amount, 'סכום')
      const rate = toNumber(rate_percent, 'שיעור')
      if (rate < 0 || rate > 100) throw new Error('שיעור לא סביר')
      if (mode === 'add') return `לפני מע"מ ${money(a)}, מע"מ ${money((a * rate) / 100)}, כולל מע"מ ${money(a * (1 + rate / 100))} (שיעור ${rate}%)`
      if (mode === 'remove') {
        const base = a / (1 + rate / 100)
        return `כולל מע"מ ${money(a)}, לפני מע"מ ${money(base)}, מע"מ ${money(a - base)} (שיעור ${rate}%)`
      }
      throw new Error('מצב צריך להיות add או remove')
    },
  },
  {
    name: 'il_net_salary',
    description: 'הערכה גסה של שכר נטו מברוטו חודשי (מס הכנסה, ביטוח לאומי, מס בריאות).',
    parameters: obj({ gross: num('שכר ברוטו חודשי בשקלים'), credit_points: num('נקודות זיכוי, ברירת מחדל 2.25 (גבר תושב)'), pension_percent: num('אחוז הפרשת עובד לפנסיה, ברירת מחדל 0') }, ['gross']),
    run({ gross, credit_points = 2.25, pension_percent = 0 }) {
      const g = toNumber(gross, 'ברוטו')
      if (g < 0) throw new Error('ברוטו לא תקין')
      const p = toNumber(credit_points, 'נקודות זיכוי')
      const pen = toNumber(pension_percent, 'פנסיה')
      const e = estimateNet(g, p, pen)
      return lines(
        `הערכה בלבד, לפי טבלאות מס מקורבות של שנת ${TAX_YEAR} (ייתכנו הבדלים; לבדוק בתלוש השכר):`,
        `ברוטו ${money(g)}`,
        `מס הכנסה (אחרי ${p} נקודות זיכוי): ${money(e.tax)}`,
        `ביטוח לאומי: ${money(e.ni)}`,
        `מס בריאות: ${money(e.health)}`,
        pen ? `פנסיה (${pen}%): ${money(e.pension)}` : '',
        `נטו מוערך: ${money(e.net)}`,
        'לא כולל מס יסף, קרן השתלמות, הטבות או שינויי שנת המס.',
      )
    },
  },
  {
    name: 'il_overtime',
    description: 'מחשב שכר כולל שעות נוספות לפי החוק: 125% לשעתיים הראשונות ביום, 150% אחר כך.',
    parameters: obj({ hourly_rate: num('שכר לשעה'), regular_hours: num('שעות רגילות'), overtime_per_day: num('שעות נוספות בכל יום עם נוספות'), days: num('כמה ימים, ברירת מחדל 1') }, ['hourly_rate', 'regular_hours', 'overtime_per_day']),
    run({ hourly_rate, regular_hours, overtime_per_day, days = 1 }) {
      const rate = toNumber(hourly_rate, 'שכר לשעה')
      const reg = toNumber(regular_hours, 'שעות רגילות')
      const ot = toNumber(overtime_per_day, 'שעות נוספות')
      const n = Math.floor(toNumber(days, 'ימים'))
      if (rate < 0 || reg < 0 || ot < 0 || n < 1) throw new Error('ערכים לא תקינים')
      const h125 = Math.min(ot, 2) * n
      const h150 = Math.max(0, ot - 2) * n
      const total = reg * rate + h125 * rate * 1.25 + h150 * rate * 1.5
      return lines(`שעות רגילות: ${reg} = ${money(reg * rate)}`, `שעות ב-125%: ${h125} = ${money(h125 * rate * 1.25)}`, `שעות ב-150%: ${h150} = ${money(h150 * rate * 1.5)}`, `סה"כ ברוטו: ${money(total)}`, '(לפי הכלל: שעתיים ראשונות ביום 125%, מעבר לכך 150%; לא כולל תוספות שבת/חג)')
    },
  },
  {
    name: 'il_bagrut_average',
    description: 'מחשב ממוצע בגרות משוקלל לפי יחידות לימוד, כולל בונוס אופציונלי לכל מקצוע.',
    parameters: obj({ subjects: str('רשימה בצורה "יחידות:ציון" או "יחידות:ציון:בונוס", מופרדת בפסיקים. למשל 5:90:25, 4:85, 3:100') }),
    run({ subjects }) {
      let units = 0
      let sum = 0
      const rows = []
      for (const part of String(need(subjects, 'מקצועות')).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)) {
        const [u, g, b = 0] = part.split(':').map((s) => toNumber(s, 'ערך'))
        if (u <= 0 || g < 0 || g > 100) throw new Error(`שורה לא תקינה: ${part}`)
        units += u
        sum += u * (g + b)
        rows.push(`${u} יח' x ${g + b}`)
      }
      if (!units) throw new Error('אין מקצועות')
      return `ממוצע משוקלל: ${r2(sum / units)} ב-${units} יחידות (${rows.join(', ')})`
    },
  },
  {
    name: 'il_holidays',
    description: 'רשימת חגים ומועדים עבריים בשנה לועזית, מחושבת מהלוח העברי.',
    parameters: obj({ year: num('שנה לועזית, למשל 2026') }),
    run({ year }) {
      const y = Math.floor(toNumber(year, 'שנה'))
      if (y < 1900 || y > 2200) throw new Error('שנה מחוץ לטווח')
      const list = holidaysOfYear(y)
      const label = { off: 'יום חופש', chol: 'חול המועד', other: '' }
      return lines(`חגים ומועדים ${y} (מחושב מהלוח העברי; יום העצמאות ותשעה באב עשויים להיות מוזזים):`, list.map((h) => `${h.date} (${WEEKDAYS[new Date(`${h.date}T00:00:00Z`).getUTCDay()]}) ${h.name}${label[h.kind] ? ' - ' + label[h.kind] : ''}`))
    },
  },
  {
    name: 'il_is_holiday',
    description: 'בודק אם תאריך הוא שבת, חג, חול המועד או יום רגיל, ומציג תאריך עברי.',
    parameters: obj({ date: str('תאריך YYYY-MM-DD') }),
    run({ date }) {
      const ms = parseDate(date)
      const day = new Date(ms).getUTCDay()
      const found = holidaysOfYear(new Date(ms).getUTCFullYear()).filter((h) => h.date === iso(ms))
      const parts = [`${iso(ms)} יום ${WEEKDAYS[day]}`]
      if (day === 6) parts.push('שבת')
      if (day === 5) parts.push('ערב שבת')
      for (const h of found) parts.push(`${h.name}${h.kind === 'off' ? ' (יום חופש)' : h.kind === 'chol' ? '' : ' (לא יום חופש רשמי)'}`)
      if (parts.length === 1) parts.push('יום רגיל')
      return parts.join(' | ')
    },
  },
  {
    name: 'il_hebrew_date',
    description: 'ממיר תאריך לועזי לתאריך עברי.',
    parameters: obj({ date: str('תאריך YYYY-MM-DD') }),
    run({ date }) {
      const ms = parseDate(date)
      return new Intl.DateTimeFormat('he-IL-u-ca-hebrew', { timeZone: 'UTC', dateStyle: 'full' }).format(new Date(ms))
    },
  },
  {
    name: 'il_shabbat_times',
    description: 'זמני כניסת ויציאת השבת הקרובה בעיר (דרך Hebcal).',
    network: true,
    parameters: obj({ city: str('ירושלים, תל אביב, חיפה או באר שבע; ברירת מחדל ירושלים') }, []),
    async run({ city }) {
      const { key, items } = await hebcalShabbat(city)
      const rows = items.filter((i) => ['candles', 'havdalah'].includes(i.category))
      if (!rows.length) throw new Error('לא התקבלו זמנים')
      return lines(`זמני שבת ב${key}:`, rows.map((i) => `${i.category === 'candles' ? 'כניסה' : 'יציאה'}: ${String(i.date).slice(0, 10)} ${hhmm(i)}`))
    },
  },
  {
    name: 'il_parasha',
    description: 'פרשת השבוע הקרובה (דרך Hebcal).',
    network: true,
    parameters: obj({ city: str('עיר, ברירת מחדל ירושלים') }, []),
    async run({ city }) {
      const { items } = await hebcalShabbat(city)
      const p = items.find((i) => i.category === 'parashat')
      if (!p) throw new Error('לא נמצאה פרשה (ייתכן שבת חג)')
      return `${p.hebrew || p.title} (${String(p.date).slice(0, 10)})`
    },
  },
  {
    name: 'il_city_distance',
    description: 'מרחק אווירי בין שתי ערים בישראל והערכה גסה לנסיעה.',
    parameters: obj({ from: str('עיר מוצא'), to: str('עיר יעד') }),
    run({ from, to }) {
      const a = findCity(from, ISRAEL_CITIES)
      const b = findCity(to, ISRAEL_CITIES)
      const km = haversine(ISRAEL_CITIES[a], ISRAEL_CITIES[b])
      return `${a} - ${b}: ${Math.round(km)} ק"מ בקו אווירי; הערכת נסיעה גסה (x1.3): כ-${Math.round(km * 1.3)} ק"מ`
    },
  },
  {
    name: 'il_emergency',
    description: 'מספרי חירום ושירותי סיוע בישראל, אפשר לחפש לפי מילה.',
    parameters: obj({ query: str('מילת חיפוש, ריק = הכול') }, []),
    run({ query }) {
      const q = String(query ?? '').trim()
      const hit = EMERGENCY.filter(([n, d]) => !q || n.includes(q) || d.includes(q))
      if (!hit.length) throw new Error('לא נמצא שירות מתאים')
      return hit.map(([n, d]) => `${n} - ${d}`).join('\n')
    },
  },
  {
    name: 'il_days_between',
    description: 'כמה ימים עברו או נשארו עד תאריך (ספירה לאחור גנרית), עם שבועות וחודשים.',
    parameters: obj({ date: str('התאריך YYYY-MM-DD'), from: str('תאריך התייחסות, ברירת מחדל היום') }, ['date']),
    run({ date, from }) {
      const target = parseDate(date)
      const base = from ? parseDate(from, 'תאריך התייחסות') : todayMs()
      const diff = Math.round((target - base) / DAY)
      const abs = Math.abs(diff)
      const when = diff === 0 ? 'זה היום' : diff > 0 ? `נשארו ${abs} ימים` : `עברו ${abs} ימים`
      return `${when} (${Math.floor(abs / 7)} שבועות ו-${abs % 7} ימים, כ-${r2(abs / 30.4375)} חודשים), בין ${iso(base)} ל-${iso(target)}`
    },
  },
  {
    name: 'il_service_progress',
    description: 'אחוז התקדמות בין תאריך התחלה לתאריך סיום (למשל שירות), וכמה ימים נשארו.',
    parameters: obj({ start: str('תאריך התחלה YYYY-MM-DD'), end: str('תאריך סיום YYYY-MM-DD'), today: str('תאריך התייחסות, ברירת מחדל היום') }, ['start', 'end']),
    run({ start, end, today }) {
      const s = parseDate(start, 'תאריך התחלה')
      const e = parseDate(end, 'תאריך סיום')
      if (e <= s) throw new Error('הסיום חייב להיות אחרי ההתחלה')
      const t = today ? parseDate(today, 'תאריך התייחסות') : todayMs()
      const total = Math.round((e - s) / DAY)
      const done = Math.round((t - s) / DAY)
      const pct = Math.min(100, Math.max(0, (done / total) * 100))
      const left = Math.max(0, Math.round((e - t) / DAY))
      const state = t < s ? 'עוד לא התחיל' : t > e ? 'הסתיים' : 'בעיצומו'
      return `${state}: ${r2(pct)}% (${Math.max(0, done)} מתוך ${total} ימים), נשארו ${left} ימים`
    },
  },
]

export const tests = [
  { tool: 'il_id_check', args: { id: '000000018' }, check: (r) => r.includes('מספר תקין') },
  { tool: 'il_id_check', args: { id: '123456789' }, check: (r) => r.includes('לא תקין') },
  { tool: 'il_id_check', args: { id: 'abc' }, throws: true, check: () => false },
  { tool: 'il_id_complete', args: { first8: '00000001' }, check: (r) => r.startsWith('000000018') },
  { tool: 'il_id_complete', args: { first8: '12345678' }, check: (r) => r.startsWith('123456782') },
  { tool: 'il_phone', args: { phone: '+972 54-123-4567' }, check: (r) => r.includes('054-1234567') && r.includes('+972541234567') && r.includes('נייד') },
  { tool: 'il_phone', args: { phone: '02-5551234' }, check: (r) => r.includes('קווי') && r.includes('+97225551234') },
  { tool: 'il_phone', args: { phone: '12345' }, throws: true, check: () => false },
  { tool: 'il_vat', args: { amount: 100, mode: 'add' }, check: (r) => r.includes('118.00') },
  { tool: 'il_vat', args: { amount: 118, mode: 'remove' }, check: (r) => r.includes('100.00') },
  { tool: 'il_vat', args: { amount: 100, mode: 'add', rate_percent: 17 }, check: (r) => r.includes('117.00') },
  { tool: 'il_net_salary', args: { gross: 10000 }, check: (r) => r.includes('2025') && r.includes('הערכה') && /נטו מוערך: 8,8\d\d\.\d\d/.test(r) },
  { tool: 'il_overtime', args: { hourly_rate: 40, regular_hours: 8, overtime_per_day: 3 }, check: (r) => r.includes('סה"כ ברוטו: 480.00') },
  { tool: 'il_bagrut_average', args: { subjects: '5:90, 4:80, 3:100' }, check: (r) => r.includes('ממוצע משוקלל: 89.17 ') },
  { tool: 'il_holidays', args: { year: 2025 }, check: (r) => r.includes('2025-09-23') && r.includes('ראש השנה') && r.includes('2025-10-02') },
  { tool: 'il_holidays', args: { year: 2026 }, check: (r) => /2026-04-02 \([^)]*\) פסח/.test(r) && r.includes('2026-05-22') },
  { tool: 'il_is_holiday', args: { date: '2025-09-23' }, check: (r) => r.includes('ראש השנה') && r.includes('יום חופש') },
  { tool: 'il_is_holiday', args: { date: '2026-04-04' }, check: (r) => r.includes('שבת') && r.includes('חול המועד') },
  { tool: 'il_is_holiday', args: { date: '2026-01-14' }, check: (r) => r.includes('יום רגיל') },
  { tool: 'il_hebrew_date', args: { date: '2025-09-23' }, check: (r) => r.includes('תשרי') && r.includes('תשפ״ו') },
  { tool: 'il_shabbat_times', args: { city: 'ירושלים' }, check: (r) => r.includes('כניסה') },
  { tool: 'il_parasha', args: {}, check: (r) => r.length > 3 },
  { tool: 'il_city_distance', args: { from: 'ירושלים', to: 'תל אביב' }, check: (r) => /\b(5[0-8]) ק"מ בקו/.test(r) },
  { tool: 'il_city_distance', args: { from: 'ערד', to: 'אטלנטיס' }, throws: true, check: () => false },
  { tool: 'il_emergency', args: { query: 'משטרה' }, check: (r) => r.trim() === '100 - משטרה' },
  { tool: 'il_days_between', args: { date: '2026-03-01', from: '2026-01-01' }, check: (r) => r.includes('נשארו 59 ימים') },
  { tool: 'il_service_progress', args: { start: '2025-01-01', end: '2025-01-11', today: '2025-01-06' }, check: (r) => r.includes('50%') && r.includes('נשארו 5 ימים') },
]
