// The one task profile of the team's first version: a flight search with limits ("מצא טיסה זולה לארה״ב לחודש
// וחצי, קונקשן עד 4 שעות"). What the user said is read here without a model; nothing he did not say is filled in.
import { placeName, _test as flightsTest } from '../flights.js'

const { nightsBetween } = flightsTest

// A flight request with at least one limit or a "cheapest" ask: worth a researcher and a checker. "מה זה קונקשן?"
// or "תודה על הטיסה" stays on the normal path.
const FLIGHT = /טיס(ה|ות|ת)|flight/i
const LIMITS = /קונקשן|עצירה|ישיר|לילות|שבוע|חודש|הכי זול|זולה|תקציב|layover|stop|nights|cheap/i
export const matches = (text) => FLIGHT.test(text) && LIMITS.test(text)

const MONTHS = { ינואר: 1, פברואר: 2, מרץ: 3, מרס: 3, אפריל: 4, מאי: 5, יוני: 6, יולי: 7, אוגוסט: 8, ספטמבר: 9, אוקטובר: 10, נובמבר: 11, דצמבר: 12 }
const COUNTRY_US = /ארה["״']?ב|ארצות הברית|אמריקה|\bUSA\b|\bUS\b|united states/i
// US cities he may name. A country alone is not a city: none is picked for him.
const US_CITIES = { 'ניו יורק': 'NYC', 'ניו-יורק': 'NYC', מיאמי: 'MIA', "לוס אנג'לס": 'LAX', 'לוס אנגלס': 'LAX', בוסטון: 'BOS', שיקגו: 'CHI', 'סן פרנסיסקו': 'SFO', וושינגטון: 'WAS', אורלנדו: 'ORL', 'לאס וגאס': 'LAS', NYC: 'NYC', JFK: 'JFK', EWR: 'EWR', MIA: 'MIA', LAX: 'LAX', BOS: 'BOS' }
const ORIGINS = { 'תל אביב': 'TLV', 'נתב"ג': 'TLV', 'נתב״ג': 'TLV', נתבג: 'TLV', TLV: 'TLV', אילת: 'ETM', רמון: 'ETM' }
const pad = (n) => String(n).padStart(2, '0')
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()

// Reads the limits and details out of his own words. Each value says where it came from, so the answer can say
// which ones were his and which were read from his phrasing ("חודש וחצי" = 40-50 nights, as persona.md reads it).
export function readSlots(text, { home } = {}) {
  const s = {}
  const t = String(text || '')
  const lay = t.match(/(?:קונקשן|עצירה|המתנה|layover)[^\d]{0,15}(\d+(?:\.\d+)?)\s*(?:שעות|שעה|h|hours)/i) || t.match(/(?:עד|מקסימום|max)\s*(\d+(?:\.\d+)?)\s*(?:שעות|h|hours)\s*(?:קונקשן|עצירה|המתנה|layover)/i)
  if (lay) s.maxLayoverHours = Number(lay[1])
  if (/(טיסה|טיסות)\s+ישיר|רק ישיר|direct only/i.test(t)) s.directOnly = true

  if (/חודש וחצי|month and a half/i.test(t)) s.nights = { min: 40, max: 50, said: 'חודש וחצי' }
  else if (/חודשיים/.test(t)) s.nights = { min: 56, max: 64, said: 'חודשיים' }
  else if (/שבועיים/.test(t)) s.nights = { min: 13, max: 15, said: 'שבועיים' }
  else if (/(?:^|\s)ל?חודש(?:\s|$|[,.])/.test(t)) s.nights = { min: 28, max: 32, said: 'חודש' }
  else if (/(?:^|\s)ל?שבוע(?:\s|$|[,.])/.test(t)) s.nights = { min: 6, max: 8, said: 'שבוע' }
  const n = t.match(/(\d+)\s*(?:לילות|nights)/i)
  if (n) s.nights = { min: Number(n[1]), max: Number(n[1]), said: `${n[1]} לילות` }

  for (const [name, code] of Object.entries(US_CITIES)) if (t.includes(name)) s.to = { code, said: name }
  if (!s.to && COUNTRY_US.test(t)) s.country = 'US'
  for (const [name, code] of Object.entries(ORIGINS)) if (new RegExp(`(?:^|\\s)מ-?${name}|from ${name}`, 'i').test(t)) s.from = { code, said: name }
  // A home airport he set himself on the settings site counts as his; the built-in default does not.
  if (!s.from && home) s.from = { code: home, said: `${home} (מההגדרות)` }

  // Dates: a month range with a year ("יולי-אוגוסט 2027"), one month with a year, or two ISO dates. No year, no guess.
  const iso = [...t.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)].map((m) => m[0])
  const monthRe = Object.keys(MONTHS).join('|')
  const range = t.match(new RegExp(`(${monthRe})\\s*[-–עד ]+\\s*(${monthRe})\\s+(20\\d\\d)`))
  const one = t.match(new RegExp(`(${monthRe})\\s+(20\\d\\d)`))
  if (iso.length >= 2) s.dates = { from: iso[0], to: iso[1], said: `${iso[0]} עד ${iso[1]}` }
  else if (iso.length === 1) s.dates = { from: iso[0], to: iso[0], said: iso[0] }
  else if (range) {
    const y = Number(range[3])
    const a = MONTHS[range[1]]
    const b = MONTHS[range[2]]
    s.dates = { from: `${y}-${pad(a)}-01`, to: `${y}-${pad(b)}-${lastDay(y, b)}`, said: `${range[1]}-${range[2]} ${y}` }
  } else if (one) {
    const y = Number(one[2])
    const m = MONTHS[one[1]]
    s.dates = { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${lastDay(y, m)}`, said: `${one[1]} ${y}` }
  } else if (new RegExp(monthRe).test(t)) s.monthNoYear = true

  const adults = t.match(/(\d)\s*(?:נוסעים|מבוגרים|adults|people)/i)
  if (adults) s.adults = Number(adults[1])
  else if (/נוסע אחד|נוסעת אחת|לבד|רק אני|one adult|1 adult/i.test(t)) s.adults = 1
  else if (/זוג|שנינו|שניים/.test(t)) s.adults = 2
  return s
}

// What a search needs that he has not said. The order is the order of the one question.
export function missing(s) {
  const out = []
  if (!s.from) out.push('from')
  if (!s.to) out.push('to')
  if (!s.dates) out.push('dates')
  if (!s.nights) out.push('nights')
  if (!s.adults) out.push('adults')
  return out
}

// One question for everything that is missing, never a list of questions one after another.
export function question(s, need) {
  const parts = []
  if (need.includes('from')) parts.push('מאיזה שדה יוצאים')
  if (need.includes('to')) parts.push(s.country === 'US' ? 'לאיזו עיר בארה״ב' : 'לאן')
  if (need.includes('dates')) parts.push(s.monthNoYear ? 'באיזו שנה' : 'באילו חודשים ובאיזו שנה')
  if (need.includes('nights')) parts.push('לכמה זמן')
  if (need.includes('adults')) parts.push('כמה נוסעים')
  const kept = [s.maxLayoverHours && `קונקשן עד ${s.maxLayoverHours} שעות`, s.nights && `${s.nights.said} (${s.nights.min}-${s.nights.max} לילות)`].filter(Boolean)
  return `לפני שאני מחפש: ${parts.join(', ')}?${kept.length ? ` את ${kept.join(' ו')} אני שומר.` : ''}`
}

// The query for find_flights, built from his slots only. The researcher cannot widen it: these fields win.
export function query(s) {
  return {
    from: s.from.code,
    to: s.to.code,
    depart_from: s.dates.from,
    depart_to: s.dates.to,
    nights_min: s.nights.min,
    nights_max: s.nights.max,
    adults: s.adults,
    ...(s.maxLayoverHours ? { max_layover_hours: s.maxLayoverHours } : {}),
    ...(s.directOnly ? { direct_only: true } : {}),
  }
}

// The checker's decision is advice. This is the rule the code enforces on the offer data itself.
// pass | fail (with the reason) | unverified (the data does not show a limit).
export function hardCheck(o, s) {
  const nights = o.depart && o.back ? nightsBetween(o.depart, o.back) : null
  if (s.nights && nights !== null && (nights < s.nights.min || nights > s.nights.max)) return { verdict: 'fail', reason: `שהייה של ${nights} לילות, לא ${s.nights.min}-${s.nights.max}` }
  if (s.nights && nights === null) return { verdict: 'unverified', reason: 'אין תאריך חזרה בנתונים' }
  if (s.directOnly && (o.legs ? o.legs.some((l) => l.stops) : o.stops)) return { verdict: 'fail', reason: 'לא ישירה' }
  if (s.maxLayoverHours) {
    if (!o.legs) return o.stops ? { verdict: 'unverified', reason: 'יש עצירה, ואורך הקונקשן לא מופיע בנתונים' } : { verdict: 'pass' }
    const worst = Math.max(0, ...o.legs.flatMap((l) => l.layovers.map((x) => x.minutes)))
    if (worst > s.maxLayoverHours * 60) return { verdict: 'fail', reason: `קונקשן של ${Math.floor(worst / 60)}:${pad(worst % 60)} שעות, מעל ${s.maxLayoverHours}` }
  }
  return { verdict: 'pass' }
}

export const routeName = (s) => `${placeName(s.from.code)} → ${placeName(s.to.code)}`
