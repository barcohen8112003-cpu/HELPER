// node src/study-selftest.js: offline checks of the week ahead, deadline reminders and the study plan.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

process.env.HELPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-study-'))
const { weeklyDue, weekAheadText, deadlineReminders, planStudy, planText, localStamp } = await import('./study.js')
const { tools } = await import('./tools.js')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

// Saturday 24 October 2026, 20:30. The coming week is Sunday 25 to Saturday 31.
const sat = new Date(2026, 9, 24, 20, 30)

// ── when the week ahead goes out ─────────────────────────────────────────────
ok(weeklyDue(sat, '', ''), 'Saturday 20:30 with the default time')
ok(!weeklyDue(sat, '', '2026-10-24'), 'only once that Saturday')
ok(!weeklyDue(new Date(2026, 9, 24, 19, 59), '', ''), 'not before the time')
ok(!weeklyDue(new Date(2026, 9, 25, 0, 30), '', ''), 'not on Sunday')
ok(!weeklyDue(new Date(2026, 9, 24, 23, 59), '19:00', ''), 'not more than four hours late')
ok(!weeklyDue(sat, 'off', ''), 'off turns it off')

// ── what it says ─────────────────────────────────────────────────────────────
const work = [
  { id: 'a', title: 'עבודה בהיסטוריה', course: 'היסטוריה', due: new Date(2026, 9, 27, 23, 59), submitted: false },
  { id: 'b', title: 'דף עבודה', course: 'מתמטיקה', due: new Date(2026, 9, 26, 8, 0), submitted: true },
  { id: 'c', title: 'רחוק', course: 'ספרות', due: new Date(2026, 10, 10, 8, 0), submitted: false },
]
const events = [
  { start: new Date(2026, 9, 25, 16, 0), title: 'חוג' },
  { start: new Date(2026, 9, 25, 18, 0), title: 'אימון' },
  { start: new Date(2026, 9, 24, 21, 0), title: 'היום, לא בשבוע' },
]
const exams = [{ name: 'מבחן בביולוגיה', date: '2026-10-29' }, { name: 'ישן', date: '2026-10-01' }]
const week = weekAheadText({ work, events, exams, now: sat })
ok(week.startsWith('*השבוע שמתחיל ב-25.10*'), 'title names the Sunday')
ok(/מבחן בביולוגיה, יום חמישי 29\.10/.test(week), 'exam listed with its day')
ok(!week.includes('ישן'), 'past exam left out')
ok(/עבודה בהיסטוריה \(היסטוריה\), יום שלישי 23:59/.test(week), 'open assignment with day and time')
ok(/דף עבודה .*, הוגש/.test(week), 'submitted assignment marked')
ok(!week.includes('רחוק'), 'assignment beyond the week left out')
ok(/יום ראשון: 16:00 חוג, 18:00 אימון/.test(week), 'calendar grouped by day')
ok(!week.includes('היום, לא בשבוע'), 'tonight is not next week')
ok(week.trim().endsWith('רוצה שאבנה תוכנית למידה למבחן בביולוגיה?'), 'ends with one offer')
ok(!/\*\*|^#|—/m.test(week), 'WhatsApp formatting, no Markdown')
ok(weekAheadText({ work: [], events: [], exams: [], now: sat }) === '', 'empty week sends nothing')

// ── deadline reminders ───────────────────────────────────────────────────────
const due = [{ id: 'x', title: 'הגשה', course: 'אנגלית', due: new Date(2026, 9, 27, 23, 59), submitted: false }]
ok(deadlineReminders(due, [], new Date(2026, 9, 27, 0, 30)).length === 0, 'past midnight on the day is not yet the morning')
ok(deadlineReminders(due, [], new Date(2026, 9, 26, 23, 0)).map((r) => r.kind).join() === 'eve', 'the evening before')
ok(deadlineReminders(due, ['x:eve'], new Date(2026, 9, 26, 23, 30)).length === 0, 'the evening one only once')
ok(deadlineReminders(due, ['x'], new Date(2026, 9, 26, 23, 30)).length === 0, 'old-style sent ids still count')
ok(deadlineReminders(due, ['x:eve'], new Date(2026, 9, 27, 7, 5)).map((r) => r.kind).join() === 'morning', 'the morning it is due')
ok(deadlineReminders(due, ['x:eve', 'x:morning'], new Date(2026, 9, 27, 12, 0)).length === 0, 'the morning one only once')
ok(deadlineReminders([{ ...due[0], submitted: true }], [], new Date(2026, 9, 27, 8, 0)).length === 0, 'nothing once submitted')
ok(deadlineReminders(due, [], new Date(2026, 9, 28, 8, 0)).length === 0, 'nothing after the deadline')
ok(deadlineReminders(due, [], new Date(2026, 9, 25, 8, 0)).length === 0, 'nothing two days before')
ok(deadlineReminders(due, [], new Date(2026, 9, 26, 17, 0)).length === 0, 'not before the evening')

// ── study plan ───────────────────────────────────────────────────────────────
const today = new Date(2026, 9, 22, 12, 0) // Thursday
const plan = planStudy({ exam: 'ביולוגיה', date: '2026-10-29', topics: ['תא', 'גנטיקה', 'אקולוגיה'], today })
// Fri 23, Sun 25, Mon 26, Tue 27, Wed 28 (Saturday skipped by default): 4 learning days and a review.
ok(plan.length === 5, `five sessions (${plan.length})`)
ok(!plan.some((s) => s.start.getDay() === 6), 'no Saturday')
ok(plan[plan.length - 1].title === 'ביולוגיה: חזרה כללית' && plan[plan.length - 1].start.getDate() === 28, 'last day before the exam is review')
ok(plan[0].title === 'ביולוגיה: תא' && plan[3].title === 'ביולוגיה: חזרה: תא', 'topics in order, spare days repeat')
ok(plan[0].start.getHours() === 17 && plan[0].end - plan[0].start === 3600000, 'default 17:00 for an hour')
const tight = planStudy({ exam: 'מתמטיקה', date: '2026-10-26', topics: ['א', 'ב', 'ג', 'ד'], today, skip: [] })
ok(tight.length === 3 && tight[0].title === 'מתמטיקה: א, ב' && tight[1].title === 'מתמטיקה: ג, ד', 'more topics than days share days')
const one = planStudy({ exam: 'כימיה', date: '2026-10-24', topics: ['מולים'], today, skip: [] })
ok(one.length === 1 && one[0].title === 'כימיה: חזרה כללית (מולים)', 'a single day is a review that names the topics')
let threw = false
try {
  planStudy({ exam: 'x', date: '2026-10-23', today })
} catch {
  threw = true
}
ok(threw, 'no days left is an error, not an empty plan')
ok(localStamp(plan[0].start) === '2026-10-23T17:00', 'calendar stamp is local time')
ok(planText(plan).split('\n').length === 5 && planText(plan).startsWith('• יום שישי 23.10, 17:00-18:00'), 'plan text one line per session')

// ── the tool asks before touching the calendar ───────────────────────────────
const tool = tools.find((t) => t.name === 'study_plan')
let asked = 0
const draft = await tool.run({ exam: 'ביולוגיה', date: '2099-01-10', topics: ['תא'] }, { confirm: async () => (asked++, true) })
ok(draft.startsWith('טיוטה') && asked === 0, 'draft without asking')
const declined = await tool.run({ exam: 'ביולוגיה', date: '2099-01-10', add_to_calendar: true }, { confirm: async () => (asked++, false) })
ok(asked === 0 ? /אין יומן/.test(declined) : /לא אישר/.test(declined), 'adding needs a yes (or a connected calendar)')

console.log(failed ? `\n${failed} נכשלו, ${passed} עברו` : `\nכל ${passed} הבדיקות של הלימודים עברו`)
process.exit(failed ? 1 : 0)
