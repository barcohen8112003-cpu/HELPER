// A reminder shortly before each lesson: which subject and which room. The week's timetable comes from Webtop
// (cancelled lessons are marked there and skipped), the bell times from the school's schedule.
import { config } from './config.js'
import { state, save } from './store.js'
import { sessionEnabled, readTimetable } from './session.js'

// The timetable is read again this often, so this week's cancellations and next week's timetable show up.
const REFRESH = 3 * 3600000
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

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
