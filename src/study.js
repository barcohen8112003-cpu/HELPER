// School help that runs on its own or on request: the week ahead (Saturday evening), a study plan for an exam,
// and the pieces the scheduler and tools share. The pure parts take their data as arguments so they can be tested.
import { state } from './store.js'
import { googleAccounts, googleEnabled, classroomWork } from './google.js'
import { listEvents, calendarOn } from './calendar.js'

const DAY = 86400000
const pad = (n) => String(n).padStart(2, '0')
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const dayName = (d) => d.toLocaleDateString('he-IL', { weekday: 'long' })
const shortDate = (d) => `${d.getDate()}.${d.getMonth() + 1}`
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

// ---- the week ahead ----

// WEEKLY_REVIEW_TIME: "20:00" (default) sends it on Saturday at that time; "off" turns it off.
export function weeklyDue(now = new Date(), setting = process.env.WEEKLY_REVIEW_TIME, lastDate = '') {
  const value = (setting || '20:00').trim()
  if (/^(off|false|0|כבוי)$/i.test(value) || !/^\d{1,2}:\d{2}$/.test(value)) return false
  const [h, m] = value.split(':').map(Number)
  const late = now.getHours() * 60 + now.getMinutes() - (h * 60 + m)
  // Saturday, at or after the time and within four hours of it: a "week ahead" at 2 am is noise.
  return now.getDay() === 6 && late >= 0 && late < 240 && lastDate !== isoDay(now)
}

// work: Classroom items ({ title, course, due: Date|null, submitted, link }), events: ({ start: Date, title }),
// exams: ({ name, date: 'YYYY-MM-DD' }). Covers Sunday to Saturday after `now`. Returns '' when the week is empty.
export function weekAheadText({ work = [], events = [], exams = [], now = new Date() }) {
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)
  from.setDate(from.getDate() + ((7 - from.getDay()) % 7 || 7)) // next Sunday
  const to = new Date(from.getTime() + 7 * DAY)
  const inWeek = (d) => d && d >= from && d < to

  const due = work.filter((w) => inWeek(w.due)).sort((a, b) => a.due - b.due)
  const open = due.filter((w) => !w.submitted)
  const soonExams = exams
    .map((e) => ({ ...e, at: new Date(`${e.date}T00:00`) }))
    .filter((e) => !isNaN(e.at) && e.at >= from && e.at < new Date(to.getTime() + 7 * DAY))
    .sort((a, b) => a.at - b.at)
  const week = events.filter((e) => inWeek(e.start))

  if (!due.length && !soonExams.length && !week.length) return ''
  const lines = [`*השבוע שמתחיל ב-${shortDate(from)}*`]
  if (soonExams.length) {
    lines.push('', '*מבחנים*')
    for (const e of soonExams) lines.push(`• ${e.name}, ${dayName(e.at)} ${shortDate(e.at)}${e.at >= to ? ' (שבוע אחרי)' : ''}`)
  }
  if (due.length) {
    lines.push('', '*הגשות*')
    for (const w of due) lines.push(`• ${w.title} (${w.course}), ${dayName(w.due)} ${hhmm(w.due)}${w.submitted ? ', הוגש' : ''}`)
  }
  if (week.length) {
    lines.push('', '*ביומן*')
    const byDay = new Map()
    for (const e of week) {
      const k = isoDay(e.start)
      if (!byDay.has(k)) byDay.set(k, [])
      byDay.get(k).push(e)
    }
    for (const list of byDay.values()) {
      const shown = list.slice(0, 3).map((e) => `${hhmm(e.start) === '00:00' ? '' : `${hhmm(e.start)} `}${e.title}`).join(', ')
      lines.push(`• ${dayName(list[0].start)}: ${shown}${list.length > 3 ? ` ועוד ${list.length - 3}` : ''}`)
    }
  }
  // The one line that says what matters most this week, in plain words.
  if (soonExams.length) lines.push('', `רוצה שאבנה תוכנית למידה ל${soonExams[0].name}?`)
  else if (open.length >= 2) lines.push('', `${open.length} הגשות פתוחות השבוע. כדאי להתחיל מ${open[0].title}.`)
  return lines.join('\n')
}

export async function weekAhead(now = new Date()) {
  const accounts = googleEnabled() ? googleAccounts() : []
  const [work, events] = await Promise.all([
    Promise.allSettled(accounts.map((a) => classroomWork(a, 14))).then((r) => r.flatMap((x) => (x.status === 'fulfilled' ? x.value : []))),
    calendarOn() ? listEvents(14).catch(() => []) : [],
  ])
  return weekAheadText({ work, events, exams: state.toolkit?.study_exams || [], now })
}

// ---- deadline reminders ----

// Which unsubmitted assignments get a reminder now. Two per assignment at most: the evening before (from 18:00, or
// once 24h are left), and
// on the morning it is due (from 07:00, when it is due later that day). sent: ids already reminded, as "id:kind".
export function deadlineReminders(work, sent = [], now = new Date()) {
  const out = []
  const today = isoDay(now)
  for (const w of work) {
    if (w.submitted || !w.due || w.due <= now) continue
    const left = w.due - now
    if (isoDay(w.due) === today && now.getHours() >= 7 && !sent.includes(`${w.id}:morning`)) out.push({ w, kind: 'morning' })
    else if ((left <= DAY || (isoDay(w.due) === isoDay(new Date(now.getTime() + DAY)) && now.getHours() >= 18)) && isoDay(w.due) !== today && !sent.includes(`${w.id}:eve`) && !sent.includes(w.id)) out.push({ w, kind: 'eve' })
  }
  return out
}

// ---- study plan ----

const DAY_NAMES = { ראשון: 0, שני: 1, שלישי: 2, רביעי: 3, חמישי: 4, שישי: 5, שבת: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

// Spreads topics over the days left before the exam, one session a day at `start` for `minutes`. The last day
// before the exam is always a full review. Days in `skip` (names or 0-6) are left free. When there are more
// topics than days, a day takes several; when there are more days than topics, the hardest-first topics repeat.
export function planStudy({ exam, date, topics = [], minutes = 60, start = '17:00', skip = ['שבת'], today = new Date() }) {
  const examDay = new Date(`${date}T00:00`)
  if (isNaN(examDay)) throw new Error('תאריך המבחן לא תקין, נדרש YYYY-MM-DD')
  if (!/^\d{1,2}:\d{2}$/.test(start)) throw new Error('שעת ההתחלה צריכה להיות HH:MM')
  const len = Math.min(240, Math.max(15, Number(minutes) || 60))
  const off = new Set(skip.map((s) => (typeof s === 'number' ? s : DAY_NAMES[String(s).replace(/^יום\s*/, '').trim().toLowerCase()])).filter((n) => n !== undefined))
  const list = topics.map((t) => String(t).trim()).filter(Boolean).slice(0, 30)
  if (!list.length) list.push(exam)

  const first = new Date(today)
  first.setHours(0, 0, 0, 0)
  first.setDate(first.getDate() + 1)
  const days = []
  for (let d = new Date(first); d < examDay && days.length < 60; d.setDate(d.getDate() + 1)) if (!off.has(d.getDay())) days.push(new Date(d))
  if (!days.length) throw new Error('אין ימים פנויים לפני המבחן')

  const learning = days.length > 1 ? days.slice(0, -1) : []
  const slots = learning.map(() => [])
  if (learning.length) {
    if (list.length >= learning.length) list.forEach((t, i) => slots[Math.floor((i * learning.length) / list.length)].push(t))
    else learning.forEach((_, i) => slots[i].push(i < list.length ? list[i] : `חזרה: ${list[(i - list.length) % list.length]}`))
  }
  const [h, m] = start.split(':').map(Number)
  const at = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m)
  const sessions = learning.map((d, i) => ({ start: at(d), end: new Date(at(d).getTime() + len * 60000), title: `${exam}: ${slots[i].join(', ')}` }))
  const last = days[days.length - 1]
  sessions.push({ start: at(last), end: new Date(at(last).getTime() + len * 60000), title: `${exam}: חזרה כללית${learning.length ? '' : ` (${list.join(', ')})`}` })
  return sessions
}

export const planText = (sessions) =>
  sessions.map((s) => `• ${dayName(s.start)} ${shortDate(s.start)}, ${hhmm(s.start)}-${hhmm(s.end)}: ${s.title}`).join('\n')

// For calendarAdd, which takes local "YYYY-MM-DDTHH:MM".
export const localStamp = (d) => `${isoDay(d)}T${hhmm(d)}`
