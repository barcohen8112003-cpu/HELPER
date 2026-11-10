// New things on Webtop, sent to WhatsApp: a grade that was entered or changed, a change in his timetable
// (cancelled lesson, substitute, room change), a new exam, and school events and messages for today and tomorrow.
// Read from the site's own API answers through the signed-in session (session.js readWebtopUpdates).
// The first read only remembers what is there. After that, one message per round with everything new,
// through notify, so quiet hours and the daily message budget apply.
import { config } from './config.js'
import { state, save } from './store.js'
import { sessionEnabled, readWebtopUpdates, isWebtopLoginError, isWebtopBlockedError } from './session.js'
import { fromWebtop, sourceFailed } from './schoolwork.js'

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
const KEEP = 800

const clean = (v) => String(v ?? '').replace(/``/g, '"').replace(/`/g, "'").replace(/\s+/g, ' ').trim()
const dayOf = (iso) => String(iso || '').slice(0, 10)

function when(iso, now = new Date()) {
  const d = dayOf(iso)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return ''
  const [y, m, dd] = d.split('-').map(Number)
  const date = new Date(y, m - 1, dd)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diff = Math.round((date - today) / 86400000)
  if (diff === 0) return 'היום'
  if (diff === 1) return 'מחר'
  return `יום ${DAYS[date.getDay()]} ${dd}.${m}`
}

// "ג`ראמנה סוזן, אנגלית 4,  י' 1 י' 2 (רמה: 4 יח``ל)" -> "אנגלית 4 (ג'ראמנה סוזן)"
export function lessonName(group) {
  const parts = clean(group).split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length >= 2) return `${parts[1]} (${parts[0]})`
  return parts[0] || ''
}

const gradeText = (g) => clean(g.grade ?? '') || clean(g.gradeTranslation ?? '')
const notPast = (iso, now) => !dayOf(iso) || dayOf(iso) >= dayOf(new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString())
const titleOf = (x) => clean(x.title || x.subject || x.content || x.name || x.description || x.message || x.text)

// Everything the read holds, each with a stable key and the line that announces it.
// A grade's key carries the grade, so a changed grade is news again.
export function webtopItems(read, now = new Date()) {
  const items = []
  for (const g of read?.grades || []) {
    if (g.isDeleted) continue
    const value = gradeText(g)
    if (!value) continue
    const what = [clean(g.subject), clean(g.title)].filter(Boolean).join(' - ')
    items.push({ key: `grade:${g.evaluationID}:${value}`, base: `grade:${g.evaluationID}`, kind: 'grade', line: `${what}: *${value}*${g.remark ? ` (${clean(g.remark)})` : ''}` })
  }
  const ch = read?.changes || {}
  for (const c of ch.changes || []) {
    if (!notPast(c.date, now)) continue
    const what = clean(c.content || c.definition || c.fillUpType)
    const room = c.room ? `, חדר ${clean(c.room)}` : ''
    items.push({ key: `change:${c.id}:${what}`, kind: 'change', line: `${when(c.date, now)}, שיעור ${c.hour}: ${what}${c.group ? ` - ${lessonName(c.group)}` : ''}${room}` })
  }
  for (const e of ch.exams || []) {
    if (!notPast(e.date, now)) continue
    const hours = e.from_hour ? `, שיעורים ${e.from_hour}${e.to_hour && e.to_hour !== e.from_hour ? `-${e.to_hour}` : ''}` : ''
    const type = clean(e.textualType)
    const title = clean(e.title)
    items.push({ key: `exam:${e.id}:${dayOf(e.date)}`, kind: 'exam', line: `${type && !title.startsWith(type) ? `${type}: ` : ''}${title} - ${when(e.date, now)}${hours}` })
  }
  for (const e of ch.events || []) {
    if (!notPast(e.date, now)) continue
    items.push({ key: `event:${e.id ?? titleOf(e)}:${dayOf(e.date)}`, kind: 'event', line: `${titleOf(e)}${e.date ? ` - ${when(e.date, now)}` : ''}` })
  }
  for (const m of ch.messages || []) {
    items.push({ key: `message:${m.id ?? titleOf(m)}`, kind: 'message', line: titleOf(m) })
  }
  // The school-changes board: events, exams and messages for his class on that day.
  for (const { date, data } of read?.school || []) {
    for (const m of data?.generalMessages || []) items.push({ key: `message:${m.id ?? titleOf(m)}`, kind: 'message', line: titleOf(m) })
    for (const cls of data?.classes || []) {
      for (const h of cls.hours || []) {
        for (const e of h.events || []) items.push({ key: `event:${e.id ?? titleOf(e)}:${dayOf(date)}`, kind: 'event', line: `${titleOf(e)} - ${when(date, now)}${h.hour?.hour ? `, שיעור ${h.hour.hour}` : ''}` })
        for (const e of h.exams || []) items.push({ key: `exam:${e.id}:${dayOf(e.date || date)}`, kind: 'exam', line: `${titleOf(e)} - ${when(e.date || date, now)}` })
        for (const m of h.messages || []) items.push({ key: `message:${m.id ?? titleOf(m)}`, kind: 'message', line: titleOf(m) })
      }
    }
  }
  const seen = new Set()
  return items.filter((i) => i.line && !seen.has(i.key) && seen.add(i.key))
}

const HEAD = { grade: '📝 *ציון חדש*', change: '🔄 *שינוי במערכת*', exam: '🗓️ *מבחן / מטלה*', event: '📣 *אירוע בבית הספר*', message: '📌 *הודעה מבית הספר*' }

// What to send for this read, and the new seen list. A missing part (null) keeps what was seen for it.
export function planWebtopNotice(read, seen, now = new Date()) {
  const items = webtopItems(read, now)
  const keys = items.map((i) => i.key)
  if (!Array.isArray(seen)) return { text: '', fresh: [], seen: keys.slice(-KEEP) }
  const known = new Set(seen)
  const fresh = items.filter((i) => !known.has(i.key))
  const before = new Set(seen.filter((k) => k.startsWith('grade:')).map((k) => k.split(':').slice(0, 2).join(':')))
  const lines = []
  for (const kind of Object.keys(HEAD)) {
    const list = fresh.filter((i) => i.kind === kind)
    if (!list.length) continue
    const head = kind === 'grade' && list.every((i) => before.has(i.base)) ? '📝 *ציון עודכן*' : HEAD[kind]
    lines.push(head, ...list.slice(0, 8).map((i) => `• ${kind === 'grade' && before.has(i.base) ? 'עודכן: ' : ''}${i.line}`), '')
  }
  const text = lines.length ? `${lines.join('\n').trim()}\n\nמ-Webtop` : ''
  return { text, fresh, seen: [...new Set([...seen, ...keys])].slice(-KEEP) }
}

let last = 0
let running = false
// Self-tests only: the next call reads again at once.
export const _resetWebtopClock = () => void (last = 0)

// Scheduler job. Silent while Webtop is signed out or blocked: the keepalive job already says so once.
// deps lets the self-test hand in a stand-in read; the scheduler passes nothing there.
export async function webtopUpdates(notify, _runTask, _monitoring, { read: readNow = readWebtopUpdates, on = sessionEnabled } = {}) {
  if (!config.webtop.alerts || !on() || !state.owner || running) return
  const w = (state.webtopWatch ??= { seen: null, lastPoll: 0 })
  if (Date.now() - Math.max(last, w.lastPoll || 0) < config.webtop.alertsMinutes * 60000) return
  last = Date.now()
  running = true
  try {
    const read = await readNow()
    w.lastPoll = Date.now()
    const plan = planWebtopNotice(read, w.seen)
    w.seen = plan.seen
    w.error = ''
    // A change in the timetable: the lesson reminders read the timetable again.
    if (plan.fresh.some((i) => i.kind === 'change') && state.lessons) state.lessons.fetchedAt = 0
    save()
    if (plan.text) {
      await notify(plan.text, false, `webtop:${plan.fresh.map((i) => i.key).join('|').slice(0, 300)}`, 'webtop')
    }
    // The same read feeds the homework list (src/schoolwork.js; does nothing while SCHOOLWORK is off).
    await fromWebtop(read, notify).catch((e) => console.log(`[schoolwork] ${e.message}`))
  } catch (e) {
    w.error = e.message || String(e)
    save()
    sourceFailed('webtop', isWebtopLoginError(e) ? 'Webtop לא מחובר (צריך להתחבר מחדש)' : isWebtopBlockedError(e) ? 'Webtop חסום מהשרת' : w.error)
    if (!isWebtopLoginError(e) && !isWebtopBlockedError(e)) console.log(`[webtop-watch] ${w.error}`)
  } finally {
    running = false
  }
}
