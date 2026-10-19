// node src/morning-selftest.js          offline checks of the "only today" morning message
// node src/morning-selftest.js --live   also builds today's real message from a COPY of the live data (read only;
//                                       the copy is deleted afterwards, the live data folder is never written)
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const live = process.argv.includes('--live')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-morning-'))
process.env.HELPER_DATA_DIR = tmp
if (live) {
  const real = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
  for (const f of ['state.json', 'google.json']) if (fs.existsSync(path.join(real, f))) fs.copyFileSync(path.join(real, f), path.join(tmp, f))
}

const { config } = await import('./config.js')
const { todayText, nightText } = await import('./monitoring/delivery.js')
const { lessonsOnly } = await import('./day.js')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

const date = new Date(2026, 9, 18) // Sunday 18 October 2026
config.briefAlways = false

// ── the message holds exactly the three things asked for ─────────────────────
const full = todayText(
  {
    events: [{ when: '09:00', title: 'פגישה עם מדריך' }],
    tasks: [{ title: 'להגיש טופס', overdue: false }, { title: 'לשלם חשבון', overdue: true }],
    reminders: [{ time: '18:00', text: 'להתקשר לסבתא' }],
    lessons: '08:10 שיעורים 1-2: מתמטיקה, חדר 12\n10:00 שיעור 3: אנגלית, חדר 4',
    homework: [{ title: 'עבודה בהיסטוריה', course: 'היסטוריה', due: 'מחר' }],
  },
  date
)
ok(full.startsWith('בוקר טוב. היום'), 'starts with a greeting and the day')
ok(full.includes('ביומן:') && full.includes('- 09:00 פגישה עם מדריך'), 'has the calendar event')
ok(full.includes('משימות להיום:') && full.includes('- להגיש טופס') && full.includes('- לשלם חשבון (באיחור)'), 'has tasks, overdue marked')
ok(full.includes('- 18:00 להתקשר לסבתא'), 'reminders count as tasks')
ok(full.includes('שיעורים:') && full.includes('מתמטיקה'), 'has the lessons')
ok(!full.includes('עבודה בהיסטוריה') && !full.includes('מטלות'), 'homework is not in it')
ok(!full.includes('נצבר') && !full.includes('דיוג') && !full.includes('זרקתי'), 'none of the old extras')

ok(todayText({ events: [], tasks: [], reminders: [], lessons: '' }, date) === '', 'nothing today -> no message')
config.briefAlways = true
ok(todayText({ events: [], tasks: [], reminders: [], lessons: '' }, date).includes('אין היום'), 'unless it is set to always send')
config.briefAlways = false
const onlyLessons = todayText({ lessons: '08:10 שיעור 1: מתמטיקה' }, date)
ok(onlyLessons.includes('שיעורים:') && !onlyLessons.includes('ביומן') && !onlyLessons.includes('משימות'), 'a section with nothing is left out entirely')
ok(!todayText({ events: [{ when: '10:00', title: 'x' }] }, date).includes('undefined'), 'missing fields never print "undefined"')

// ── lessons text ─────────────────────────────────────────────────────────────
ok(lessonsOnly('יום ראשון:\n08:10 שיעור 1: מתמטיקה') === '08:10 שיעור 1: מתמטיקה', 'timetable header is stripped')
ok(lessonsOnly('ביום שישי אין שיעורים במערכת') === '', 'a free day gives nothing')
ok(lessonsOnly('Webtop לא מחובר, אין לי מערכת שעות') === '', 'a disconnected Webtop gives nothing')
ok(lessonsOnly('לא הצלחתי לקרוא את מערכת השעות מ-Webtop') === '', 'a read failure gives nothing')

// ── the night's alerts go out separately, and only when there are any ────────
const empty = { watches: [], delivered: [], notes: [], suspicious: [] }
ok(nightText(empty) === '', 'no alerts -> no second message')
const night = nightText({
  watches: [{ pending_batch: [{ event_id: 'a', source: 'mail/x@y.com', title: 'חשבונית חדשה' }, { event_id: 'b', source: 'mail/x@y.com', title: 'כבר נמסר' }] }],
  delivered: ['b'],
  notes: [{ text: 'מטלה חדשה בקלאסרום' }],
  suspicious: [{ title: 'זכית בפרס', source: 'mail/x@y.com' }],
})
ok(night.startsWith('נצבר בלילה:') && night.includes('חשבונית חדשה') && night.includes('מטלה חדשה') && night.includes('דיוג'), 'alerts are kept')
ok(!night.includes('כבר נמסר'), 'an alert already delivered is not repeated')

// ── the real thing, from a copy of today's data ──────────────────────────────
if (live) {
  const { getDay } = await import('./day.js')
  const day = await getDay()
  console.log(`live: events=${day.events.length} tasks=${day.tasks.length} reminders=${day.reminders.length} lessons=${day.lessons ? day.lessons.split('\n').length + ' lines' : 'none'}`)
  console.log('--- what the morning message would be right now ---')
  console.log(todayText(day, new Date()) || '(nothing today: no message would be sent)')
  console.log('---')
  ok(Array.isArray(day.events) && Array.isArray(day.tasks) && typeof day.lessons === 'string', 'getDay returns the expected shape')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
if (failed) process.exit(1)
console.log('הכול תקין')
