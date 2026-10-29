// What today holds, for the morning message: calendar events (every calendar), reminders, Google Tasks due today or
// overdue, and today's lessons from the Webtop timetable. Each part is optional: one that fails is simply left out.
import { state } from './store.js'
import { calendarOn, listEvents } from './calendar.js'
import { googleEnabled, googleAccounts, tasksList } from './google.js'
import { timetableText } from './lessons.js'
import { briefLines } from './groups.js'

const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const time = (d) => new Date(d).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })

// `lessonsText` is "יום ראשון:\n08:10 ..." or a sentence saying there is nothing; only a real timetable is kept.
export const lessonsOnly = (text) => (/^יום [^\n]*:\n/.test(text) ? text.replace(/^יום [^\n]*:\n/, '') : '')

export async function getDay(now = new Date()) {
  const end = new Date(now).setHours(23, 59, 59, 999)
  const events = calendarOn() ? (await listEvents(1).catch(() => [])).filter((e) => e.start <= end).map((e) => ({ when: time(e.start), title: e.title })) : []
  const reminders = state.reminders.filter((r) => Date.parse(r.at) <= end).map((r) => ({ time: time(r.at), text: r.text }))
  const today = dateKey(now)
  const tasks = googleEnabled()
    ? (await Promise.all(googleAccounts().map((a) => tasksList(a).catch(() => []))))
        .flat()
        .filter((t) => t.due && t.due <= today)
        .map((t) => ({ title: t.title, overdue: t.due < today }))
    : []
  const lessons = await timetableText(now.getDay()).then(lessonsOnly).catch(() => '')
  // What came up in the WhatsApp groups since yesterday morning (src/groups.js); empty while that is off.
  const groups = (() => {
    try {
      return briefLines(now.getTime())
    } catch {
      return []
    }
  })()
  return { events, reminders, homework: state.homework.open, tasks, lessons, groups }
}
