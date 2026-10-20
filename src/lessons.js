// A reminder shortly before each lesson: which subject and which room. The week's timetable comes from Webtop
// (cancelled lessons are marked there and skipped), the bell times from the school's schedule.
import { config } from './config.js'
import { state, save } from './store.js'
import { sessionEnabled, readTimetable } from './session.js'

// The timetable is read again this often, so this week's cancellations and next week's timetable show up.
const REFRESH = 3 * 3600000
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
const EN_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY_UNKNOWN = 'יום לא מוכר. today, tomorrow, מחר, היום, מחרתיים, שם יום בעברית או באנגלית, או YYYY-MM-DD.'
const DAY_BEYOND_WEEK = 'יש לי רק את מערכת השעות של השבוע הזה (עד שישה ימים קדימה).'

// today/tomorrow, Hebrew (היום, מחר, מחרתיים, יום רביעי), English weekdays, or YYYY-MM-DD.
// A date more than six days ahead is next week; the saved timetable is only this week.
export function parseTimetableDay(input, now = new Date()) {
  const raw = String(input || '').trim().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ')
  if (!raw) return { error: DAY_UNKNOWN }
  const today = now.getDay()
  const key = raw.toLowerCase()
  if (key === 'today' || raw === 'היום') return { day: today }
  if (key === 'tomorrow' || raw === 'מחר') return { day: (today + 1) % 7 }
  if (raw === 'מחרתיים') return { day: (today + 2) % 7 }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (iso) {
    const y = Number(iso[1])
    const m = Number(iso[2])
    const d = Number(iso[3])
    const utc = Date.UTC(y, m - 1, d)
    const dt = new Date(utc)
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { error: DAY_UNKNOWN }
    const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
    if (Math.round((utc - todayUtc) / 86400000) > 6) return { error: DAY_BEYOND_WEEK }
    return { day: dt.getUTCDay() }
  }
  const bare = raw.replace(/^יום[\s-]+/u, '')
  const he = DAYS.indexOf(bare)
  if (he >= 0) return { day: he }
  const en = EN_DAYS.indexOf(bare.toLowerCase())
  if (en >= 0) return { day: en }
  return { error: DAY_UNKNOWN }
}

const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// "1=08:10,2=08:50" -> { 1: '08:10', 2: '08:50' }
function bellTimes(list = config.lessons.times) {
  return Object.fromEntries(
    list
      .split(',')
      .map((p) => p.trim().match(/^(\d+)=(\d{1,2}):(\d{2})$/))
      .filter(Boolean)
      .map(([, n, h, m]) => [Number(n), `${h.padStart(2, '0')}:${m}`])
  )
}

// After a failed or empty read the next one comes sooner, and a question from the user retries right away:
// a read that failed while Webtop was signed out must not leave the timetable empty for three hours.
const RETRY = 10 * 60000
let reading = null
let lastError = ''

async function week(force = false) {
  const L = (state.lessons ??= { fetchedAt: 0, week: [] })
  const age = Date.now() - L.fetchedAt
  if (age > REFRESH || (!L.week?.length && (force || age > RETRY))) {
    reading ??= (async () => {
      // Stamped before the read, so a failing page is not retried on every tick.
      L.fetchedAt = Date.now()
      try {
        L.week = await readTimetable()
        lastError = ''
      } catch (e) {
        lastError = e.message || String(e)
        console.log(`[lessons] ${lastError}`)
      }
      save()
    })().finally(() => (reading = null))
    await reading
  }
  return L.week || []
}

// A day's lessons as units: lessons that start at the same time are one unit (here, the pairs 1-2, 3-4 ...) and get
// one reminder. Two different subjects in one unit are both named; so is a consecutive double lesson.
function blocks(entries, day) {
  const times = bellTimes()
  const out = []
  for (const e of entries.filter((x) => x.day === day && !x.cancelled).sort((a, b) => a.lesson - b.lesson)) {
    const last = out.at(-1)
    const time = times[e.lesson]
    const sameUnit = last && last.to === e.lesson - 1 && ((time && last.time === time) || (last.subject === e.subject && last.room === e.room))
    if (!sameUnit) {
      out.push({ ...e, from: e.lesson, to: e.lesson, time })
      continue
    }
    last.to = e.lesson
    if (e.subject !== last.subject) last.subject += ` / ${e.subject}`
    if (e.room !== last.room) last.room += ` / ${e.room}`
  }
  return out
}

const describe = (b) => `${b.from === b.to ? `שיעור ${b.from}` : `שיעורים ${b.from}-${b.to}`}: ${b.subject}, חדר ${b.room || '?'}${b.teacher ? ` (${b.teacher})` : ''}`

// Called on every scheduler tick. Each lesson is announced when the lesson before it ends (the first one of the day,
// beforeMinutes ahead). At most one message per lesson, and none for a lesson that already started.
export async function lessonReminders(notify) {
  if (!config.lessons.enabled || !sessionEnabled() || !state.owner) return
  const entries = await week()
  const now = new Date()
  const ends = bellTimes(config.lessons.ends)
  const at = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number)
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime()
  }
  const day = blocks(entries, now.getDay())
  for (const [i, b] of day.entries()) {
    if (!b.time) continue
    const start = at(b.time)
    const prevEnd = i > 0 && ends[day[i - 1].to]
    const remindAt = prevEnd ? at(prevEnd) : start - config.lessons.beforeMinutes * 60000
    if (now.getTime() >= remindAt && now.getTime() < start) {
      await notify(`📚 ${i > 0 ? 'הבא: ' : ''}ב-${b.time} ${describe(b)}`, true, `lesson:${dateKey(now)}:${b.from}`)
    }
  }
}

// For the model: one day's timetable in words, with times. day: 0 (Sunday) - 6.
export async function timetableText(day) {
  if (!sessionEnabled()) return 'Webtop לא מחובר, אין לי מערכת שעות'
  const entries = await week(true)
  if (!entries.length) return `לא הצלחתי לקרוא את מערכת השעות מ-Webtop${lastError ? ` (${lastError})` : ''}`
  const list = blocks(entries, day)
  const cancelled = entries.filter((x) => x.day === day && x.cancelled).map((x) => `שיעור ${x.lesson} ${x.subject}`)
  if (!list.length) return `ביום ${DAYS[day]} אין שיעורים במערכת${cancelled.length ? ` (בוטלו: ${cancelled.join(', ')})` : ''}`
  return [
    `יום ${DAYS[day]}:`,
    ...list.map((b) => `${b.time || '?'} ${describe(b)}`),
    ...(cancelled.length ? [`בוטלו: ${cancelled.join(', ')}`] : []),
  ].join('\n')
}
