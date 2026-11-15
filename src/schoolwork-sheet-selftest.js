// node src/schoolwork-sheet-selftest.js
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-sw-sheet-'))
process.env.HELPER_DATA_DIR = tmp
for (const k of ['SCHOOLWORK', 'SCHOOLWORK_GROUPS', 'SCHOOLWORK_DAILY_TIME', 'SCHOOLWORK_TZ']) delete process.env[k]
process.env.SCHOOLWORK = 'on'
process.env.SCHOOLWORK_GROUPS = 'מתמטיקה כיתה י 4 יחל של עינב'
process.env.SCHOOLWORK_DAILY_TIME = '18:00'

const { urgencyLabel, sheetRows, HEAD } = await import('./schoolwork-sheet.js')
const SW = await import('./schoolwork.js')
const { collectedHomework, entriesFromItems, LOOKBACK_DAYS } = await import('./schoolwork-lookback.js')

let ok = true
const check = (cond, name, extra) => {
  if (cond) return
  ok = false
  console.log(`FAIL  ${name}${extra ? `  ${extra}` : ''}`)
}

const dayNum = (day) => Date.UTC(...day.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))) / 86400000
const pastDue = (i, nowMs) => {
  const now = SW.wall(nowMs)
  if (!i.due?.day) return false
  return i.due.day < now.day || (i.due.day === now.day && i.due.time && i.due.time < now.time)
}
const H = {
  pastDue,
  dayNum,
  dueLabel: SW.dueLabel,
  where: (i) => (i.course ? `קבוצת ${i.course}` : ''),
  wall: SW.wall,
  isOpen: (i) => i.status !== 'done' && i.status !== 'submitted',
}

const T = Date.parse('2026-11-12T16:00:00+02:00')
check(urgencyLabel({ due: { day: '2026-11-10' } }, T, H) === 'עבר המועד', 'past due is urgent')
check(urgencyLabel({ due: { day: '2026-11-12' } }, T, H) === 'היום', 'due today')
check(urgencyLabel({ due: { day: '2026-11-13' } }, T, H) === 'מחר', 'due tomorrow')
check(urgencyLabel({ due: { day: '2026-11-14' } }, T, H) === 'מחרתיים', 'due in two days')
check(urgencyLabel({ due: null }, T, H) === 'בלי תאריך', 'no date')

const rows = sheetRows(
  [
    { n: 1, title: 'דף 12', course: 'מתמטיקה', due: { day: '2026-11-15' }, status: 'open' },
    { n: 2, title: 'תרגיל 3', course: 'מתמטיקה', due: { day: '2026-11-10' }, status: 'open' },
    { n: 3, title: 'ישן', course: 'מתמטיקה', due: { day: '2026-11-01' }, status: 'done', closedAt: T - 2 * 86400000 },
    { n: 4, title: 'עתיק', course: 'מתמטיקה', due: { day: '2026-10-01' }, status: 'done', closedAt: T - 10 * 86400000 },
  ],
  T,
  H
)
check(rows[0].join() === HEAD.join(), 'header')
check(rows[1][2] === 'תרגיל 3' && rows[1][4] === 'עבר המועד' && rows[1][5] === '', 'overdue open item first, no V')
check(rows[2][2] === 'דף 12' && rows[2][5] === '', 'open item has empty status')
check(rows[3][2] === 'ישן' && rows[3][5] === 'V', 'done item is marked V')
check(rows.length === 4, 'done items older than a week are dropped', String(rows.length))

check(SW.settings().dailyTime === '18:00', 'daily time is 18:00 from env')
check(SW.dailyDue(Date.parse('2026-11-12T18:00:00+02:00'), '') === '2026-11-12', '18:00 is due')
check(SW.dailyDue(Date.parse('2026-11-12T17:59:00+02:00'), '') === '', '17:59 is not due yet')
check(SW.dailyDue(Date.parse('2026-11-12T23:01:00+02:00'), '') === '', 'after the window it is skipped')

const summary = await SW.summaryText(T, { daily: true })
check(summary.includes('מה פתוח'), 'daily summary keeps "מה פתוח"')
check(typeof SW.markSaidDone === 'function', 'markSaidDone is exported')
check(LOOKBACK_DAYS === 14, 'lookback is 14 days')

SW.forget()
SW.ingest('groups', [
  { sourceId: '1:1', title: 'דף עבודה במתמטיקה', course: 'מתמטיקה כיתה י 4 יחל של עינב', due: { day: '2026-11-15' }, confidence: 'medium' },
  { sourceId: '2:2', title: 'חיבור באנגלית', course: 'אנגלית 4 יחל', due: { day: '2026-11-16' }, confidence: 'medium' },
], T)
const items = SW.load().items.filter((i) => i.status === 'open')
check(items.length === 2, 'two open items after first ingest', String(items.length))

let r = SW.markSaidDone('עשיתי', T)
check(r.includes('כמה מטלות') || r.includes('יש כמה'), 'bare עשיתי with two items asks which', r)

r = SW.markSaidDone('עשיתי מתמטיקה', T)
check(/סימנתי/.test(r) && /דף עבודה/.test(r), 'עשיתי מתמטיקה marks the math item', r)
check(SW.load().items.find((i) => i.title.includes('דף')).status === 'done', 'math item is done')

r = SW.markSaidDone('עשיתי', T)
check(/סימנתי/.test(r) && /חיבור/.test(r), 'עשיתי with one left marks it', r)
check(SW.load().items.filter((i) => i.status === 'open').length === 0, 'no open items left')

r = SW.markSaidDone('עשיתי', T)
check(r.includes('אין לי מטלה'), 'עשיתי with none left says so', r)

const doneRows = sheetRows(SW.load().items, T, H)
check(doneRows.some((row) => row[2].includes('דף עבודה') && row[5] === 'V'), 'sheet has V on the done math item')

SW.forget()
SW.ingest('groups', [
  { sourceId: '3:3', title: 'תרגיל 7', course: 'מתמטיקה כיתה י 4 יחל של עינב', due: { day: '2026-11-17' }, confidence: 'medium' },
], T)
r = SW.markSaidDone('סיימתי את 1', T)
check(/סימנתי/.test(r), 'סיימתי את 1 marks by number', r)

const daily = await SW.summaryText(Date.parse('2026-11-12T18:05:00+02:00'), { daily: true })
// after forget+one item marked done, maybe nothing open — just ensure phrase still in a fresh ingest
SW.forget()
SW.ingest('groups', [
  { sourceId: '4:4', title: 'דף אחרון', course: 'מתמטיקה', due: { day: '2026-11-12' }, confidence: 'medium' },
], T)
const d2 = await SW.summaryText(T, { daily: true })
check(d2.includes('מה פתוח'), 'מה פתוח still present with open work')
check(d2.includes('עשיתי') || d2.includes('סיימתי את 3'), 'daily mentions עשיתי')
check(d2.includes('מה שדחוף יותר'), 'daily mentions urgency')

console.log(ok ? '\nsheet+lookback: all passed' : '\nsheet+lookback: FAILED')
process.exit(ok ? 0 : 1)
