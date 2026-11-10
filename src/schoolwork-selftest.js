// node src/schoolwork-selftest.js
// The homework list (src/schoolwork.js), offline, through the real hooks: scheduler.js classroomRound and its job
// list, webtop-watch.js webtopUpdates with a stand-in read, groups.js tick with a stand-in model, the tool, and
// the morning brief. Hebrew fixtures: new work, due-date updates, cancellations, turned in, copies across sources,
// unsure items, source outages, a restart in the middle, and the 15:00 schedule on both sides of a DST change.
// No network, no real account, no real model.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-schoolwork-'))
process.env.HELPER_DATA_DIR = tmp
process.env.HELPER_ENV_FILE = path.join(tmp, '.env')
process.env.HELPER_OFFLINE = '1'
for (const k of ['SCHOOLWORK', 'SCHOOLWORK_GROUPS', 'SCHOOLWORK_DAILY_TIME', 'SCHOOLWORK_TZ', 'WHATSAPP_GROUPS', 'GROUPS_AUTO_ADD', 'WEBTOP_ALERTS']) delete process.env[k]

let ok = true
const check = (name, cond, info = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${info && !cond ? '  ' + String(info).slice(0, 600) : ''}`)
  if (!cond) ok = false
}

const SW = await import('./schoolwork.js')
const { state } = await import('./store.js')
const { _test: sched, classroomRound } = await import('./scheduler.js')
const webtopWatch = await import('./webtop-watch.js')
const groups = await import('./groups.js')
const { tools } = await import('./tools.js')
const { getDay } = await import('./day.js')
const FILE = path.join(tmp, 'schoolwork.json')

state.owner = { jid: 'owner@s.whatsapp.net' }
const sent = []
const notify = async (text, urgent = false, key, kind) => void sent.push({ text, urgent, key, kind })
const clear = () => (sent.length = 0)
// Wall-clock moments in Israel, given as UTC instants.
const at = (iso) => Date.parse(iso)
const fulfilled = (value) => ({ status: 'fulfilled', value })
const cw = (id, title, dueIso, extra = {}) => ({ id, courseId: 'c1', account: 'student@school.example', course: 'מתמטיקה', title, due: dueIso ? new Date(dueIso) : null, submitted: false, link: `https://classroom.google.com/c/c1/a/${id}`, updated: Date.now(), ...extra })

// ── off by default: nothing stored, nothing sent ──────────────────────────────
{
  check('off unless SCHOOLWORK=on', SW.enabled() === false)
  const r = await classroomRound(notify, ['student@school.example'], [fulfilled([cw('w1', 'דף עבודה בטריגונומטריה', '2026-11-12T21:59:00Z')])])
  check('while off, the Classroom hook stores nothing', !fs.existsSync(FILE) && r === undefined)
  check('while off, the first Classroom read is silent as before', sent.length === 0)
  await classroomRound(notify, ['student@school.example'], [fulfilled([cw('w1', 'דף עבודה בטריגונומטריה', '2026-11-12T21:59:00Z'), cw('w2', 'חיבור באנגלית', '2026-11-13T21:59:00Z')])])
  check('while off, the existing Classroom notice still works', sent.length === 1 && sent[0].text.includes('מטלה חדשה') && sent[0].key === 'homework-new:w2', JSON.stringify(sent))
  check('while off, still nothing stored', !fs.existsSync(FILE))
  await SW.schoolworkJob(notify, null, null, at('2026-11-10T13:00:00Z'))
  check('while off, no daily summary', sent.length === 1)
  const tool = tools.find((t) => t.name === 'school_homework')
  check('the tool is registered', Boolean(tool))
  check('while off, the tool says it is off', (await tool.run({ action: 'list' }, {})).includes('עוד לא הופעל'))
  clear()
}

process.env.SCHOOLWORK = 'on'
SW._setProbes({ classroom: async () => true, webtop: async () => true })

// ── time: Asia/Jerusalem whatever the server clock, both sides of DST ─────────
{
  check('15:00 in winter is 13:00 UTC', SW.wall(at('2026-11-10T13:00:00Z')).time === '15:00')
  check('15:00 in summer is 12:00 UTC', SW.wall(at('2026-03-27T12:00:00Z')).time === '15:00')
  check('the day before DST starts is still winter', SW.wall(at('2026-03-26T13:00:00Z')).time === '15:00')
  check('the day DST ends is winter again', SW.wall(at('2026-10-25T13:00:00Z')).time === '15:00' && SW.wall(at('2026-10-24T12:00:00Z')).time === '15:00')
  check('14:59 is not due yet', SW.dailyDue(at('2026-11-10T12:59:00Z'), '') === '')
  check('15:00 is due', SW.dailyDue(at('2026-11-10T13:00:00Z'), '') === '2026-11-10')
  check('summer 15:00 is due at 12:00 UTC, not 13:00', SW.dailyDue(at('2026-03-27T12:00:00Z'), '') === '2026-03-27' && SW.dailyDue(at('2026-03-27T11:59:00Z'), '') === '')
  check('winter 12:00 UTC is 14:00 here, not due', SW.dailyDue(at('2026-03-26T12:00:00Z'), '') === '')
  check('once a day', SW.dailyDue(at('2026-11-10T13:05:00Z'), '2026-11-10') === '')
  check('after 20:00 the day is skipped', SW.dailyDue(at('2026-11-10T18:01:00Z'), '') === '')
  check('a Classroom due time in UTC is shown in Israel time', SW.dueLabel(SW.wall(at('2026-11-12T21:59:00Z')), at('2026-11-10T13:00:00Z')) === 'יום חמישי 12.11 עד 23:59')
  check('a due date right after DST ends', SW.wall(at('2026-10-25T21:59:00Z')).time === '23:59' && SW.wall(at('2026-10-24T20:59:00Z')).time === '23:59')
}

// ── Classroom through scheduler.js classroomRound ─────────────────────────────
const T0 = at('2026-11-10T10:00:00Z') // Tuesday 12:00 in Israel
{
  const acc = ['student@school.example']
  state.homework = { seen: null, nudged: [], open: [], lastPoll: 0 }
  await classroomRound(notify, acc, [fulfilled([cw('m1', 'תרגילים 1-5 בעמוד 40', '2026-11-12T21:59:00Z')])], T0)
  check('the first read only learns what is there', sent.length === 0 && SW.load().items.length === 1, JSON.stringify(sent))
  const r2 = [fulfilled([cw('m1', 'תרגילים 1-5 בעמוד 40', '2026-11-12T21:59:00Z'), cw('m2', 'עבודת חקר על פונקציות', '2026-11-17T21:59:00Z')])]
  await classroomRound(notify, acc, r2, T0 + 60000)
  check('a new assignment is announced once, by the homework list', sent.length === 1 && sent[0].key.startsWith('schoolwork-alert:') && sent[0].text.includes('עבודת חקר על פונקציות'), JSON.stringify(sent))
  check('the old Classroom notice is not sent a second time', !sent.some((m) => m.key?.startsWith('homework-new:')))
  check('the alert has the due date, source and link', sent[0].text.includes('יום שלישי 17.11 עד 23:59') && sent[0].text.includes('Classroom, מתמטיקה') && sent[0].text.includes('https://classroom.google.com/c/c1/a/m2'), sent[0].text)
  clear()
  // A restart: memory dropped, the file read again, the same answer comes back.
  SW._reload()
  await classroomRound(notify, acc, r2, T0 + 120000)
  check('after a restart the same assignment is not announced again', sent.length === 0, JSON.stringify(sent))
  // Due date moved by the teacher.
  await classroomRound(notify, acc, [fulfilled([cw('m1', 'תרגילים 1-5 בעמוד 40', '2026-11-12T21:59:00Z'), cw('m2', 'עבודת חקר על פונקציות', '2026-11-19T21:59:00Z')])], T0 + 180000)
  check('a moved due date is an update', sent.length === 1 && sent[0].text.includes('עדכון במטלה') && sent[0].text.includes('יום חמישי 19.11'), JSON.stringify(sent))
  clear()
  // Gone from the list (past the 30-day window, deleted, filtered): not evidence of anything.
  await classroomRound(notify, acc, [fulfilled([cw('m2', 'עבודת חקר על פונקציות', '2026-11-19T21:59:00Z')])], T0 + 240000)
  check('an assignment that disappeared stays open', SW.load().items.find((i) => i.id.endsWith(':m1')).status === 'open')
  // Turned in, in Classroom.
  await classroomRound(notify, acc, [fulfilled([cw('m1', 'תרגילים 1-5 בעמוד 40', '2026-11-12T21:59:00Z', { submitted: true }), cw('m2', 'עבודת חקר על פונקציות', '2026-11-19T21:59:00Z')])], T0 + 300000)
  const m1 = SW.load().items.find((i) => i.id.endsWith(':m1'))
  check('turned in is closed on Classroom evidence', m1.status === 'submitted' && m1.evidence.some((e) => e.kind === 'submitted'))
  check('closing sends nothing', sent.length === 0)
  // Classroom down for one account: a gap, the list kept.
  await classroomRound(notify, acc, [{ status: 'rejected', reason: new Error('403 insufficient scope') }], T0 + 360000)
  const cov = await SW.coverage(T0 + 360000)
  check('a failed Classroom read is a coverage gap', cov.find((c) => c.source === 'classroom').ok === false && cov.find((c) => c.source === 'classroom').text.includes('נכשלה'), JSON.stringify(cov))
  check('a failed read keeps what was known', SW.load().items.some((i) => i.id.endsWith(':m2') && i.status === 'open'))
  await classroomRound(notify, acc, [fulfilled([cw('m1', 'תרגילים 1-5 בעמוד 40', '2026-11-12T21:59:00Z', { submitted: true }), cw('m2', 'עבודת חקר על פונקציות', '2026-11-19T21:59:00Z')])], T0 + 420000)
  clear()
}

// ── Webtop through webtop-watch.js webtopUpdates ──────────────────────────────
const exam = (id, title, textualType, date) => ({ id, title, textualType, date, from_hour: 3, to_hour: 4 })
const webtopRead = (exams, messages = []) => ({ grades: [], changes: { changes: [], exams, events: [], messages }, school: [] })
const runWebtop = async (read, nowMs) => {
  webtopWatch._resetWebtopClock()
  state.webtopWatch.lastPoll = 0
  const real = Date.now
  Date.now = () => nowMs
  try {
    await webtopWatch.webtopUpdates(notify, null, null, { read: async () => (typeof read === 'function' ? read() : read), on: () => true })
  } finally {
    Date.now = real
  }
}
{
  check('the Webtop job is in the scheduler round before the homework summary', sched.JOBS.indexOf(sched.webtopUpdates) >= 0 && sched.JOBS.indexOf(sched.webtopUpdates) < sched.JOBS.indexOf(SW.schoolworkJob))
  check('the Classroom job runs before the homework summary', sched.JOBS.indexOf(sched.homework) < sched.JOBS.indexOf(SW.schoolworkJob))
  await runWebtop(webtopRead([exam(1, 'מבחן במתמטיקה', 'מבחן', '2026-11-20T00:00:00')]), T0 + 500000)
  check('Webtop first read: silent', sent.length === 0, JSON.stringify(sent))
  check('an exam is not homework', !SW.load().items.some((i) => i.source === 'webtop'))
  await runWebtop(webtopRead([exam(1, 'מבחן במתמטיקה', 'מבחן', '2026-11-20T00:00:00'), exam(2, 'מטלת בגרות ציונות', 'מטלת בגרות', '2026-11-16T00:00:00')]), T0 + 600000)
  const hw = sent.find((m) => m.key?.startsWith('schoolwork-alert:'))
  check('a Webtop assignment is announced', Boolean(hw) && hw.text.includes('מטלת בגרות ציונות') && hw.text.includes('יום שני 16.11') && hw.text.includes('Webtop'), JSON.stringify(sent))
  check('the Webtop notice itself still goes out as before', sent.some((m) => m.key?.startsWith('webtop:') && m.text.includes('מטלת בגרות ציונות')))
  check('a Webtop date has no invented hour', !hw.text.includes('יום שני 16.11 עד'))
  clear()
  await runWebtop(webtopRead([exam(2, 'מטלת בגרות ציונות', 'מטלת בגרות', '2026-11-18T00:00:00')]), T0 + 700000)
  check('a Webtop date change is an update', sent.some((m) => m.key?.startsWith('schoolwork-alert:') && m.text.includes('יום רביעי 18.11')), JSON.stringify(sent))
  clear()
  // Signed out: an error, never an empty list.
  const loginError = Object.assign(new Error('Webtop דורש התחברות מחדש'), { code: 'WEBTOP_LOGIN' })
  await runWebtop(() => {
    throw loginError
  }, T0 + 800000)
  check('a Webtop failure is not announced as homework', !sent.some((m) => m.key?.startsWith('schoolwork-alert:')))
  check('a Webtop failure is a coverage gap', (await SW.coverage(T0 + 800000)).find((c) => c.source === 'webtop').ok === false)
  await runWebtop({ grades: [], changes: null, school: [] }, T0 + 900000)
  check('a read without the exams part is a gap, not "nothing"', (await SW.coverage(T0 + 900000)).find((c) => c.source === 'webtop').text.includes('בלי רשימת'))
  await runWebtop(webtopRead([exam(2, 'מטלת בגרות ציונות', 'מטלת בגרות', '2026-11-18T00:00:00')]), T0 + 1000000)
  check('Webtop gone from the list is not closed', SW.load().items.find((i) => i.id === 'webtop:exam:2').status === 'open')
  clear()
}

// ── the school WhatsApp groups through groups.js tick ─────────────────────────
{
  process.env.WHATSAPP_GROUPS = 'on'
  process.env.SCHOOLWORK_GROUPS = 'י6'
  groups.reset()
  groups.setEnabled(true, T0)
  groups.setGroupNames([{ jid: 'class@g.us', name: 'כיתה י6 🔥' }, { jid: 'ball@g.us', name: 'כדורגל שכונה' }])
  const msg = (g, id, text, sec) => groups.capture({ group: g, id, sender: '972500000000@s.whatsapp.net', senderName: 'דנה המחנכת', at: sec, text })
  const sec = Math.floor((T0 + 1100000) / 1000)
  msg('class@g.us', 'a1', 'להגיש עד יום רביעי את התרגילים 1-5 בעמוד 40 במתמטיקה, מי שלא מגיש מקבל אפס ופרטים אישיים כאן', sec)
  msg('class@g.us', 'a2', 'שיעורי בית בהיסטוריה: לקרוא את פרק 3 על המהפכה הצרפתית', sec + 1)
  msg('class@g.us', 'a3', 'דף עבודה בפיזיקה', sec + 2)
  msg('ball@g.us', 'b1', 'שיעורי בית לאימון: 50 שכיבות סמיכה עד מחר', sec + 3)
  groups.setModel(async () =>
    JSON.stringify({
      items: [
        { msg: 1, type: 'homework', title: 'שיעורי בית במתמטיקה: תרגילים 1-5 עמוד 40', date: '2026-11-12', time: '', importance: 4 },
        { msg: 2, type: 'homework', title: 'לקרוא פרק 3 בהיסטוריה על המהפכה הצרפתית', date: '2026-11-15', time: '', importance: 3 },
        { msg: 3, type: 'homework', title: 'דף עבודה בפיזיקה', date: '', time: '', importance: 3 },
        { msg: 4, type: 'homework', title: '50 שכיבות סמיכה לאימון', date: '2026-11-11', time: '', importance: 3 },
        { msg: 2, type: 'homework', title: 'פרק 3 בהיסטוריה, המהפכה הצרפתית: לקרוא', date: '2026-11-15', time: '', importance: 3 },
      ],
    })
  )
  await groups.tick({ notify, onFresh: SW.groupsHook(notify) }, T0 + 1200000)
  const alert = sent.find((m) => m.key?.startsWith('schoolwork-alert:'))
  check('homework from a chosen school group is announced', Boolean(alert) && alert.text.includes('לקרוא פרק 3 בהיסטוריה'), JSON.stringify(sent))
  check('a group that is not on the list is not read for homework', !JSON.stringify(SW.load()).includes('שכיבות') && !sent.some((m) => m.text.includes('שכיבות')))
  const items = SW.load().items
  const copy = items.find((i) => i.id.endsWith(':m1'))
  check('the same assignment in Classroom and the group is one item', !alert.text.includes('תרגילים 1-5') && copy.also.some((a) => a.source === 'groups'), JSON.stringify(copy))
  check('the same homework written twice in the groups is one item', items.filter((i) => i.title.includes('היסטוריה')).length === 1 && (alert.text.match(/היסטוריה/g) || []).length === 1, alert.text)
  const unsure = items.find((i) => i.title === 'דף עבודה בפיזיקה')
  check('no date from a group: kept as unsure, without a made-up date', unsure && unsure.confidence === 'low' && unsure.due === null && alert.text.includes('בלי תאריך הגשה') && alert.text.includes('(לא בטוח)'), alert.text)
  const file = fs.readFileSync(FILE, 'utf8')
  check('no sender name, number or raw message body is stored', !file.includes('דנה') && !file.includes('972500000000') && !file.includes('פרטים אישיים') && !file.includes('class@g.us'))
  clear()
  // A cancellation and a change, in the group: noted, never applied on a group's word.
  msg('class@g.us', 'a4', 'שיעורי הבית בהיסטוריה בוטלו', sec + 1200)
  groups.setModel(async () => JSON.stringify({ items: [{ msg: 1, type: 'cancel', title: 'שיעורי הבית בהיסטוריה על המהפכה הצרפתית בוטלו', date: '', time: '', importance: 4 }] }))
  await groups.tick({ notify, onFresh: SW.groupsHook(notify) }, T0 + 1200000 + 11 * 60000)
  const hist = SW.load().items.find((i) => i.title.includes('היסטוריה'))
  check('a cancellation in the group is reported, not applied', hist.status === 'open' && hist.reported?.kind === 'cancel', JSON.stringify(hist))
  check('and he is told to check it', sent.some((m) => m.text.includes('נכתב בקבוצה שבוטל') && m.text.includes('לא סימנתי')), JSON.stringify(sent))
  clear()
  // The same group item handed over twice (a second extraction, a restart): no second alert.
  SW._reload()
  await SW.fromGroups(groups.load().items, notify, T0 + 1200000 + 12 * 60000)
  check('the same group items twice: no new alert', !sent.some((m) => m.key?.startsWith('schoolwork-alert:')), JSON.stringify(sent))
  clear()
}

// ── a crash between writing the alert and notify accepting it ─────────────────
{
  let fail = true
  const flaky = async (text, urgent, key) => {
    if (fail) throw new Error('outbox down')
    sent.push({ text, urgent, key })
  }
  await SW.fromClassroom(['student@school.example'], [fulfilled([cw('m2', 'עבודת חקר על פונקציות', '2026-11-19T21:59:00Z'), cw('m3', 'סיכום פרק 4', '2026-11-20T21:59:00Z')])], flaky, T0 + 2000000).catch(() => {})
  const pendingKey = SW.load().pending?.key
  check('an alert that did not go out is kept on disk', Boolean(pendingKey))
  SW._reload()
  fail = false
  await SW.schoolworkJob(flaky, null, null, T0 + 2100000)
  check('after the restart it is sent with the same key (the outbox drops a repeat)', sent.length === 1 && sent[0].key === pendingKey && sent[0].text.includes('סיכום פרק 4'), JSON.stringify(sent))
  check('and then it is done', SW.load().pending === null && SW.load().items.find((i) => i.id.endsWith(':m3')).alerted)
  clear()
}

// ── the 15:00 summary through the scheduler job ───────────────────────────────
{
  SW._setProbes({ webtop: async () => false })
  const D = at('2026-11-10T13:00:00Z')
  // The source jobs ran this round as they do every few minutes.
  await classroomRound(notify, ['student@school.example'], [fulfilled([cw('m1', 'תרגילים 1-5 בעמוד 40', '2026-11-12T21:59:00Z', { submitted: true }), cw('m2', 'עבודת חקר על פונקציות', '2026-11-19T21:59:00Z'), cw('m3', 'סיכום פרק 4', '2026-11-20T21:59:00Z')])], D - 60000)
  groups.load().lastExtract = D - 120000
  clear()
  await SW.schoolworkJob(notify, null, null, at('2026-11-10T12:59:00Z'))
  check('nothing at 14:59', sent.length === 0)
  await SW.schoolworkJob(notify, null, null, D)
  const daily = sent[0]
  check('the daily summary goes out at 15:00, once, as a reminder he set', sent.length === 1 && daily.key === 'schoolwork-daily:2026-11-10' && daily.urgent === true, JSON.stringify(sent))
  check('it lists what is open with due dates and sources', daily.text.includes('עבודת חקר על פונקציות') && daily.text.includes('יום חמישי 19.11 עד 23:59') && daily.text.includes('מטלת בגרות ציונות'), daily.text)
  check('it repeats items still open (announced before)', daily.text.includes('לקרוא פרק 3 בהיסטוריה'))
  check('turned-in work is not listed as open', !daily.text.includes('• ' + SW.load().items.find((i) => i.id.endsWith(':m1')).n + '. תרגילים'))
  check('a reported cancellation is shown as unverified', daily.text.includes('נכתב בקבוצה שבוטל או נדחה, לא מאומת'))
  check('a source that is off is named as not checked', daily.text.includes('✗ Webtop: לא מחובר או כבוי'), daily.text)
  check('a checked source says when', daily.text.includes('✓ Classroom: נבדק'), daily.text)
  clear()
  await SW.schoolworkJob(notify, null, null, D + 5 * 60000)
  SW._reload()
  await SW.schoolworkJob(notify, null, null, D + 60 * 60000)
  check('not again that day, also after a restart', sent.length === 0, JSON.stringify(sent))
  await SW.schoolworkJob(notify, null, null, at('2026-11-11T13:00:00Z'))
  check('the next day at 15:00 again', sent.length === 1 && sent[0].key === 'schoolwork-daily:2026-11-11')
  clear()
  // Past due, with no evidence it was turned in.
  const late = await SW.summaryText(at('2026-11-21T13:00:00Z'))
  check('past due without evidence is shown as such, not closed', late.includes('עבר המועד ואין לי אישור שהוגש') && late.includes('עבודת חקר על פונקציות'), late)
}

// ── no homework found vs not checked ───────────────────────────────────────────
{
  const keep = JSON.stringify(SW.load())
  SW.forget()
  SW._setProbes({ classroom: async () => false, webtop: async () => false })
  process.env.SCHOOLWORK_GROUPS = ''
  const none = await SW.summaryText(T0)
  check('nothing found and nothing checked is never "no homework"', none.includes('זה לא אומר שאין שיעורי בית') && none.includes('✗ Classroom') && none.includes('✗ קבוצות וואטסאפ: לא נבחרו'), none)
  SW._setProbes({ classroom: async () => true, webtop: async () => true })
  process.env.SCHOOLWORK_GROUPS = 'י6'
  const s = SW.load()
  s.sources = { classroom: { lastOk: T0, baselined: true }, webtop: { lastOk: T0, baselined: true } }
  groups.load().lastExtract = T0
  const clean = await SW.summaryText(T0 + 60000)
  check('all sources checked and empty: says which were checked', clean.includes('לא מצאתי מטלות פתוחות ב: Classroom, Webtop, קבוצות') && !clean.includes('✗'), clean)
  const stale = await SW.summaryText(T0 + 3 * 3600000)
  check('an old read is stale, a gap', stale.includes('המידע ישן'), stale)
  process.env.SCHOOLWORK_GROUPS = 'י6,מגמת מחשבים'
  const missing = await SW.summaryText(T0 + 60000)
  check('a chosen group Helper does not know is a gap', missing.includes('לא מצאתי קבוצה בשם: מגמת מחשבים'), missing)
  process.env.SCHOOLWORK_GROUPS = 'י6'
  fs.writeFileSync(FILE, keep)
  SW._reload()
}

// ── the tool and the morning brief ─────────────────────────────────────────────
{
  const tool = tools.find((t) => t.name === 'school_homework')
  const list = await tool.run({ action: 'list' }, {})
  check('the tool lists open work', list.includes('עבודת חקר על פונקציות'), list)
  const n = SW.load().items.find((i) => i.id.endsWith(':m2')).n
  const done = await tool.run({ action: 'done', items: [n] }, {})
  check('"done" closes it in Helper only, on his word', done.includes('ב-Classroom וב-Webtop לא שיניתי כלום') && SW.load().items.find((i) => i.n === n).status === 'done')
  await classroomRound(notify, ['student@school.example'], [fulfilled([cw('m2', 'עבודת חקר על פונקציות', '2026-11-19T21:59:00Z'), cw('m3', 'סיכום פרק 4', '2026-11-20T21:59:00Z')])], T0 + 3000000)
  check('a source that still says not turned in does not reopen what he said he finished', SW.load().items.find((i) => i.n === n).status === 'done')
  check('undo brings it back', (await tool.run({ action: 'undo', items: [n] }, {})).includes('החזרתי') && SW.load().items.find((i) => i.n === n).status === 'open')
  const status = await tool.run({ action: 'status' }, {})
  check('status says Webtop is not real time', status.includes('אין חיבור בזמן אמת ל-Webtop') && status.includes('15:00 (Asia/Jerusalem)'), status)
  const day = await getDay(new Date(T0))
  check('the morning brief takes the same open list', day.homework.some((h) => h.title === 'עבודת חקר על פונקציות' && h.course.includes('Classroom')), JSON.stringify(day.homework))
  clear()
}

// ── retention ──────────────────────────────────────────────────────────────────
{
  SW.prune(at('2026-12-20T10:00:00Z'))
  check('old records go after the set time (open ones two weeks after their date)', !SW.load().items.some((i) => i.due?.day && i.due.day < '2026-12-06'))
  check('the homework file is not in the Drive backup list', !fs.readFileSync(new URL('./backup.js', import.meta.url), 'utf8').includes('schoolwork.json'))
}

console.log(ok ? '\nschoolwork: all passed' : '\nschoolwork: FAILED')
process.exit(ok ? 0 : 1)
