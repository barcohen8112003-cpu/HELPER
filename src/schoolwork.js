// Homework and open assignments from every school source Helper already reads, in one list:
//   Classroom (scheduler.js homework(), every 5 minutes), Webtop (webtop-watch.js, every WEBTOP_ALERTS_MINUTES,
//   60 by default) and the school WhatsApp groups he picks (groups.js, each extraction round).
// - A new assignment is announced once, as soon as the source that carries it is read. Copies of the same
//   assignment from two sources are one item.
// - Every day at SCHOOLWORK_DAILY_TIME (15:00) in SCHOOLWORK_TZ (Asia/Jerusalem) he gets what is still open,
//   with the due date, where it came from, how sure Helper is, and which sources could not be checked.
// - An item is closed only on evidence: Classroom says it was turned in, or he said he finished it.
//   Disappearing from a source, an old date, or a model's guess never closes it, and an open item is never deleted
//   or left out of the summary for being old: it stays until there is evidence, or he asks to forget it.
// - A source that is off, failing or stale is a coverage gap in the summary, never "no homework".
//
// Off until SCHOOLWORK=on. While off nothing is stored and nothing is sent: every hook returns at once.
// Stored on this machine only, in data/schoolwork.json (not in the Drive backup): titles of at most 160 characters,
// the course or group name, due date, status and a few evidence notes. No message bodies, no senders, no numbers.
// Nothing here writes to Classroom, Webtop, a group, a teacher or the calendar.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DATA_DIR, config } from './config.js'
import { state } from './store.js'
import * as groups from './groups.js'
import * as alerts from './homework-alerts.js'

const FILE = () => path.join(DATA_DIR, 'schoolwork.json')
const MAX_CLOSED = 300 // closed items kept for the record; open items are never dropped for room
const DAILY_LINES = 25 // the daily message lists this many open items, then says how many more there are
const MAX_EVIDENCE = 6
const DAY = 86400000
const DAILY_WINDOW_MIN = 5 * 60 // started after 20:00: today's summary is skipped rather than sent at night
// How long a CLOSED item (turned in, or he said he finished) stays on file. Proposed, not agreed: the retention
// decision is still open with the owner, and the feature stays off until it is made. Open items have no limit here.
const KEEP_CLOSED_DAYS = 7

const truthy = (v) => ['on', '1', 'true', 'yes'].includes(String(v || '').trim().toLowerCase())
export const settings = () => {
  const time = String(process.env.SCHOOLWORK_DAILY_TIME || '15:00').trim()
  return {
    on: truthy(process.env.SCHOOLWORK),
    dailyTime: /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, '0') : /^(off|כבוי)$/i.test(time) ? '' : '15:00',
    tz: String(process.env.SCHOOLWORK_TZ || 'Asia/Jerusalem').trim(),
    // Names (or parts of names) of the school groups to read homework from. Empty: no group is read for this.
    groups: String(process.env.SCHOOLWORK_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}
export const enabled = () => settings().on

// ── time, always in the school's zone, so DST and a server clock in UTC change nothing ────────────────
const parts = (ms, tz) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  )
export function wall(ms, tz = settings().tz) {
  const p = parts(ms, tz)
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, minutes: Number(p.hour) * 60 + Number(p.minute) }
}
const dayNum = (day) => Date.UTC(...day.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))) / DAY
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
const weekday = (day) => new Date(dayNum(day) * DAY).getUTCDay()

export function dueLabel(due, nowMs = Date.now()) {
  if (!due?.day) return 'בלי תאריך הגשה'
  const diff = dayNum(due.day) - dayNum(wall(nowMs).day)
  const [, m, d] = due.day.split('-').map(Number)
  const date = diff === 0 ? 'היום' : diff === 1 ? 'מחר' : diff === -1 ? 'אתמול' : `יום ${DAYS[weekday(due.day)]} ${d}.${m}`
  return `${date}${due.time ? ` עד ${due.time}` : ''}`
}
const dueSort = (i) => (i.due?.day ? `${i.due.day}T${i.due.time || '23:59'}` : '9999')
const pastDue = (i, nowMs) => {
  if (!i.due?.day) return false
  const now = wall(nowMs)
  return i.due.day < now.day || (i.due.day === now.day && i.due.time && i.due.time < now.time)
}

// ── the file ───────────────────────────────────────────────────────────────────────────────────────
const empty = () => ({
  items: [], // see addItem
  sources: {}, // { [source]: { lastOk, lastError, lastErrorAt, baselined, note } }
  lastDaily: '', // the school-zone day the last daily summary went out
  pending: [], // [{ key, text, ids, at }]: alerts written down and not yet accepted by the outbox (see accepted())
  pendingDaily: null, // { day, key, at }: today's summary, until the outbox accepted it
  nextNum: 1,
})
let cache = null
export function load() {
  if (cache) return cache
  let saved = {}
  try {
    saved = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') {
      try {
        fs.renameSync(FILE(), `${FILE()}.corrupt-${Date.now()}`)
      } catch {}
    }
  }
  cache = { ...empty(), ...saved }
  // A file from the first draft held one pending alert, not a list.
  if (cache.pending && !Array.isArray(cache.pending)) cache.pending = [cache.pending]
  cache.pending ||= []
  return cache
}
// Written at once, every time: a restart must never announce the same assignment twice.
export function persist() {
  if (!cache) return
  const tmp = FILE() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cache))
  fs.renameSync(tmp, FILE())
}
// Tests: forget what is in memory, so the next load reads the file as a restart would.
export const _reload = () => void (cache = null)
export function forget() {
  cache = empty()
  persist()
  return 'מחקתי את כל מה ששמרתי על שיעורי בית ומטלות.'
}

// ── matching the same assignment across sources and updates ──────────────────────────────────────────
const STOP = new Set(['של', 'את', 'עד', 'על', 'עם', 'מחר', 'היום', 'יום', 'שיעורי', 'בית', 'שיעורים', 'להגיש', 'הגשה', 'מטלה', 'מטלת', 'צריך', 'לכתוב', 'לעשות', 'לסיים', 'בבקשה', 'כל', 'גם', 'זה', 'הוא', 'היא', 'נא', 'דף', 'עבודה', 'עבודת', 'ב', 'ל'])
const words = (s) => {
  const out = new Set()
  for (let w of String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ')) {
    if (w.length < 2 || STOP.has(w)) continue
    // One Hebrew prefix letter (ב ל ה ו מ ש כ) is dropped, so "בהיסטוריה" and "היסטוריה" meet.
    if (w.length > 3 && /^[בלהומשכ]/.test(w)) w = w.slice(1)
    if (!STOP.has(w)) out.add(w)
  }
  return out
}
export function similarity(a, b) {
  const x = words(a)
  const y = words(b)
  if (!x.size || !y.size) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / Math.min(x.size, y.size)
}
const textOf = (i) => `${i.title} ${i.course || ''}`
const isOpen = (i) => i.status === 'open'

function note(item, kind, text, nowMs) {
  item.evidence = [...(item.evidence || []), { at: nowMs, kind, text: String(text).slice(0, 120) }].slice(-MAX_EVIDENCE)
}

const RANK = { low: 0, medium: 1, high: 2 }
const clip = (s, n) => String(s || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, n)

function addItem(s, source, e, nowMs) {
  const item = {
    id: `${source}:${e.sourceId}`,
    n: s.nextNum++,
    source,
    link: /^https:\/\//.test(e.link || '') ? e.link : '',
    title: clip(e.title, 160),
    course: clip(e.course, 60),
    due: e.due?.day ? { day: e.due.day, time: e.due.time || null } : null,
    status: e.submitted === true ? 'submitted' : 'open',
    confidence: e.confidence || 'medium',
    also: [],
    evidence: [],
    reported: null, // { kind: 'cancel' | 'change', at, day? }: said in a group, not checked against the source
    firstSeen: nowMs,
    lastSeen: nowMs,
    alerted: false,
  }
  note(item, 'seen', `נמצא ב-${LABEL[source]}`, nowMs)
  if (item.status === 'submitted') note(item, 'submitted', 'Classroom: הוגש', nowMs)
  s.items.push(item)
  return item
}

// The OPEN item that a new entry from another source is a copy of. Cautious on purpose: a wrong match hides new
// work, a missed match only repeats one line. So:
// - only open items: new work is never folded into something already turned in or finished;
// - the same due day on both sides, or no date on either side with nearly the same words. One side dated and the
//   other not is two items;
// - Classroom and Webtop ids are their own: two ids from the same one are two assignments. Group items have no such
//   id, so the same homework written twice in the groups is matched like a copy.
function copyOf(s, source, e) {
  let best = null
  let bestScore = 0
  for (const i of s.items) {
    if (!isOpen(i)) continue
    if ((i.source === source && source !== 'groups') || i.id === `${source}:${e.sourceId}` || i.also.some((a) => a.source === source)) continue
    const dated = Boolean(i.due?.day) + Boolean(e.due?.day)
    if (dated === 1 || (dated === 2 && i.due.day !== e.due.day)) continue
    const score = similarity(textOf(e), textOf(i))
    if (score >= (dated === 2 ? 0.5 : 0.8) && score > bestScore) (best = i), (bestScore = score)
  }
  return best
}

// Submission state from a source that knows it (Classroom), applied the moment it is read.
function applySubmission(item, e, source, nowMs) {
  if (e.submitted === true && item.status === 'open') {
    item.status = 'submitted'
    item.closedAt = nowMs
    note(item, 'submitted', `${LABEL[source]}: הוגש`, nowMs)
  } else if (e.submitted === false && item.status === 'submitted') {
    item.status = 'open'
    item.closedAt = 0
    note(item, 'reopened', `${LABEL[source]}: מסומן שוב כלא הוגש`, nowMs)
  }
}

// entries: [{ sourceId, title, course, due: { day, time } | null, link, submitted?, confidence, kind? }]
// kind 'cancel' / 'change' (groups only) attaches to the open item it is about and is never applied on its own.
// Returns { fresh, updated }. The first read of a source only learns what is there.
export function ingest(source, entries, nowMs = Date.now()) {
  const s = load()
  const src = (s.sources[source] ??= {})
  const first = !src.baselined
  const fresh = []
  const updated = []
  for (const e of entries || []) {
    if (!e?.sourceId || !clip(e.title, 160)) continue
    if (e.kind === 'cancel' || e.kind === 'change') {
      const target = s.items.filter(isOpen).map((i) => ({ i, score: similarity(textOf(e), textOf(i)) })).filter((x) => x.score >= 0.5).sort((a, b) => b.score - a.score)[0]?.i
      if (!target || target.reported?.ref === e.sourceId) continue
      target.reported = { kind: e.kind, at: nowMs, ref: e.sourceId, ...(e.due?.day && { due: e.due }) }
      note(target, e.kind === 'cancel' ? 'reported-cancel' : 'reported-change', `${LABEL[source]}: ${clip(e.title, 100)}`, nowMs)
      updated.push({ item: target, what: e.kind })
      continue
    }
    const id = `${source}:${e.sourceId}`
    let item = s.items.find((i) => i.id === id) || s.items.find((i) => i.also.some((a) => a.source === source && a.id === e.sourceId))
    if (item) {
      item.lastSeen = nowMs
      // A changed due date from the source that owns the item is applied and said; from a copy it is only noted.
      const sameDue = (item.due?.day || '') === (e.due?.day || '') && (item.due?.time || '') === (e.due?.time || '')
      if (!sameDue && e.due?.day && item.source === source) {
        note(item, 'due-changed', `המועד השתנה מ-${item.due ? dueLabel(item.due, nowMs) : 'בלי תאריך'}`, nowMs)
        item.due = { day: e.due.day, time: e.due.time || null }
        if (!first) updated.push({ item, what: 'due' })
      }
      // Not seeing it any more is not evidence; only a source's own submission state is.
      applySubmission(item, e, source, nowMs)
      continue
    }
    const copy = copyOf(s, source, e)
    if (copy) {
      copy.also.push({ source, id: e.sourceId, ...(e.link && /^https:\/\//.test(e.link) && { link: e.link }) })
      copy.lastSeen = nowMs
      if (!copy.due && e.due?.day) copy.due = { day: e.due.day, time: e.due.time || null }
      if (RANK[e.confidence] > RANK[copy.confidence]) copy.confidence = e.confidence
      if (!copy.link && /^https:\/\//.test(e.link || '')) copy.link = e.link
      note(copy, 'also', `גם ב-${LABEL[source]}`, nowMs)
      // Classroom saying "turned in" for the copy closes it now, not on the next read.
      applySubmission(copy, e, source, nowMs)
      continue
    }
    const added = addItem(s, source, e, nowMs)
    // Already turned in when first seen, or seen on the very first read: remembered, not announced.
    if (first || added.status !== 'open') added.alerted = true
    else fresh.push(added)
  }
  src.baselined = true
  src.lastOk = nowMs
  src.lastError = ''
  capClosed(s)
  persist()
  return { fresh, updated }
}

// Room is made by dropping the oldest closed items only.
function capClosed(s) {
  const closed = s.items.filter((i) => !isOpen(i))
  if (closed.length <= MAX_CLOSED) return
  const drop = new Set(closed.sort((a, b) => (a.closedAt || a.lastSeen) - (b.closedAt || b.lastSeen)).slice(0, closed.length - MAX_CLOSED))
  s.items = s.items.filter((i) => !drop.has(i))
}

export function sourceFailed(source, error, nowMs = Date.now()) {
  if (!enabled()) return
  const s = load()
  const src = (s.sources[source] ??= {})
  src.lastError = clip(error?.message || error, 160) || 'error'
  src.lastErrorAt = nowMs
  persist()
}

// ── alerts ─────────────────────────────────────────────────────────────────────────────────────────
const LABEL = { classroom: 'Classroom', webtop: 'Webtop', webtopHomework: 'לוח שיעורי הבית ב-Webtop', groups: 'קבוצת וואטסאפ' }
const where = (i) => (i.source === 'groups' ? `קבוצת ${i.course || 'וואטסאפ'}` : `${LABEL[i.source]}${i.course ? `, ${i.course}` : ''}`)
const UNSURE = { low: ' (לא בטוח)', medium: '', high: '' }
export const itemLine = (i, nowMs = Date.now()) => `${i.n}. ${i.title} · ${dueLabel(i.due, nowMs)} · ${where(i)}${UNSURE[i.confidence] || ''}${i.also.length ? ` (גם ב-${[...new Set(i.also.map((a) => LABEL[a.source]))].join(', ')})` : ''}`

// What notify's answer means (src/index.js notify -> src/outbox.js notify). A resolved call is NOT proof of
// anything: outbox.notify resolves after a flush that swallows send errors, and a muted kind resolves having sent
// nothing. What is grounded is this: every path that takes a keyed notice (sent, queued in the outbox, held for
// the brief, or dropped by his own mute) writes the key into state.sentKeys and saves state.json synchronously,
// before notify returns. So "accepted" = the key is in state.sentKeys. Delivery after that is the outbox's
// at-least-once queue. Not accepted (notify threw first, or the process died before that save) = safe to hand over
// again with the same key: the outbox ignores a key it already has.
export const accepted = (key) => Boolean(key && state.sentKeys?.includes(key))
const digest = (parts) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)

// One message for a round, through notify (quiet hours and the daily budget apply). Written to the file before
// notify is called, and taken off only once accepted, so a crash or a throw in between hands it over again.
async function announce(notify, fresh, updated, nowMs) {
  const s = load()
  const lines = []
  if (fresh.length) lines.push('📚 *מטלה חדשה:*', ...fresh.map((i) => `• ${itemLine(i, nowMs)}${i.link ? `\n  ${i.link}` : ''}`))
  const changes = updated.filter((u) => u.what === 'due' || u.item.reported)
  if (changes.length) {
    if (lines.length) lines.push('')
    lines.push('🔁 *עדכון במטלה:*')
    for (const { item, what } of changes) {
      if (what === 'due') lines.push(`• ${item.title}: המועד עכשיו ${dueLabel(item.due, nowMs)} (${where(item)})`)
      else if (what === 'cancel') lines.push(`• ${item.title}: נכתב בקבוצה שבוטל. לא סימנתי אותו כסגור, כדאי לוודא.`)
      else lines.push(`• ${item.title}: נכתב בקבוצה שהמועד השתנה${item.reported?.due ? ` ל${dueLabel(item.reported.due, nowMs)}` : ''}. המועד אצלי נשאר ${dueLabel(item.due, nowMs)} עד שזה יאומת.`)
    }
  }
  if (!lines.length) return false
  const ids = [...fresh.map((i) => i.id), ...changes.map((u) => `${u.item.id}~${u.what}~${u.item.due?.day || ''}${u.item.due?.time || ''}~${u.item.reported?.ref || ''}`)]
  s.pending.push({ key: `schoolwork-alert:${digest(ids)}`, text: lines.join('\n'), ids: fresh.map((i) => i.id), at: nowMs })
  persist()
  return flushPending(notify)
}

// Hands over what is written down, oldest first. Each is taken off only when accepted. A throw leaves it (and the
// rest) for the next round. Returns how many were accepted.
export async function flushPending(notify) {
  const s = load()
  let done = 0
  for (const p of [...s.pending]) {
    if (!accepted(p.key)) {
      try {
        await notify(p.text, false, p.key, 'schoolwork')
      } catch (e) {
        console.log(`[schoolwork] alert not handed over yet: ${e.message}`)
      }
    }
    if (!accepted(p.key)) break
    for (const i of s.items) if (p.ids.includes(i.id)) i.alerted = true
    s.pending = s.pending.filter((x) => x !== p)
    persist()
    done++
  }
  return done
}

// ── adapters: what each existing hook hands over ──────────────────────────────────────────────────────

// scheduler.js homework(): the same Classroom read that already runs every 5 minutes.
// results: Promise.allSettled answers, one per account; work: classroomWork() items.
export async function fromClassroom(accounts, results, notify, nowMs = Date.now()) {
  if (!enabled()) return null
  const failed = results.map((r, i) => (r.status === 'rejected' ? `${accounts[i]}: ${r.reason?.message || r.reason}` : '')).filter(Boolean)
  if (!results.some((r) => r.status === 'fulfilled')) {
    sourceFailed('classroom', failed.join('; ') || 'אין חשבון שאפשר לקרוא ממנו', nowMs)
    return null
  }
  const work = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  const entries = work.map((w) => ({
    sourceId: `${w.account}:${w.courseId}:${w.id}`,
    title: w.title,
    course: w.course,
    due: w.due ? wall(w.due instanceof Date ? w.due.getTime() : Date.parse(w.due)) : null,
    link: w.link,
    submitted: Boolean(w.submitted),
    confidence: 'high',
  }))
  const out = ingest('classroom', entries, nowMs)
  // One account answered and another did not: the gap is still a gap.
  const s = load()
  s.sources.classroom.note = failed.length ? `חלק מהחשבונות לא נקראו: ${clip(failed.join('; '), 140)}` : ''
  persist()
  await announce(notify, out.fresh, out.updated, nowMs)
  return out
}

// Webtop lists assignments among its exams ("מטלת בגרות", "עבודה", "הגשה") and sometimes in school messages.
const ASSIGNMENT = /מטל|עבודה|עבודת|הגשה|להגיש|שיעורי ה?בית|ש"ב|תרגיל|פרויקט|דף עבודה/
const plain = (v) => String(v ?? '').replace(/``/g, '"').replace(/`/g, "'").replace(/\s+/g, ' ').trim()
const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : '')
export function webtopAssignments(read) {
  const out = []
  const exam = (e, date) => {
    const type = plain(e.textualType)
    const title = plain(e.title || e.subject || e.content)
    if (!ASSIGNMENT.test(`${type} ${title}`)) return
    const day = isoDay(e.date || date)
    out.push({ sourceId: `exam:${e.id ?? title}`, title: type && !title.startsWith(type) ? `${type}: ${title}` : title, course: plain(e.subject || ''), due: day ? { day, time: null } : null, confidence: 'medium' })
  }
  const message = (m) => {
    const title = plain(m.title || m.subject || m.content || m.message || m.text)
    if (!/שיעורי ה?בית|ש"ב|להגיש|הגשה|מטלה/.test(title)) return
    out.push({ sourceId: `message:${m.id ?? title.slice(0, 40)}`, title, course: '', due: null, confidence: 'low' })
  }
  for (const e of read?.changes?.exams || []) exam(e)
  for (const m of read?.changes?.messages || []) message(m)
  for (const { date, data } of read?.school || []) {
    for (const m of data?.generalMessages || []) message(m)
    for (const c of data?.classes || []) for (const h of c.hours || []) {
      for (const e of h.exams || []) exam(e, date)
      for (const m of h.messages || []) message(m)
    }
  }
  const seen = new Set()
  return out.filter((e) => !seen.has(e.sourceId) && seen.add(e.sourceId))
}

// webtop-watch.js webtopUpdates(): the same read that sends grade and timetable notices.
export async function fromWebtop(read, notify, nowMs = Date.now()) {
  if (!enabled()) return null
  const out = { fresh: [], updated: [] }
  const add = (r) => (out.fresh.push(...r.fresh), out.updated.push(...r.updated))
  // The changes part is where exams and assignments are. Without it this read says nothing about them.
  if (!read?.changes) sourceFailed('webtop', 'הקריאה מ-Webtop חזרה בלי רשימת המבחנים והמטלות', nowMs)
  else add(ingest('webtop', webtopAssignments(read), nowMs))
  // The homework board, from the same read (session.js, dashboard/GetHomeWork). Its own source, so its coverage is
  // said on its own line: not asked, not answered, or an answer in a shape Helper does not know are all gaps.
  const hw = webtopHomework(read?.homework)
  if (hw.error) sourceFailed('webtopHomework', hw.error, nowMs)
  else add(ingest('webtopHomework', hw.entries, nowMs))
  await announce(notify, out.fresh, out.updated, nowMs)
  return out
}

// The answer of dashboard/GetHomeWork. Its fields are not documented anywhere and were not seen on a real account
// (pywebtop names the call, not its answer), so this reads the common names and refuses anything else: a list
// whose items have no recognizable text is "a shape I do not know", never "no homework".
// -> { entries } or { error }
const pick = (o, names) => {
  for (const n of names) if (o?.[n] !== undefined && o[n] !== null && String(o[n]).trim() !== '') return o[n]
  return ''
}
const noTags = (v) => plain(String(v ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' '))
export function webtopHomework(part) {
  if (!part?.asked) return { error: 'לא נקרא: הקריאה מ-Webtop לא כללה את לוח שיעורי הבית (למשל חלון בבית עם קוד ישן)' }
  if (part.data === undefined) return { error: `הדף ${config.webtop.homeworkPath} לא ביקש את לוח שיעורי הבית, אז לא נקרא${part.error ? ` (${clip(part.error, 80)})` : ''}` }
  const d = part.data
  const list = Array.isArray(d) ? d : [d?.homeWork, d?.homeWorks, d?.homework, d?.HomeWork, d?.items, d?.list, d?.data].find(Array.isArray)
  if (!list) return { error: 'התשובה של לוח שיעורי הבית בצורה שאני לא מכיר, אז לא נקרא' }
  const entries = []
  for (const h of list) {
    const title = noTags(pick(h, ['homeWork', 'homework', 'homeWorkText', 'homeworkText', 'description', 'content', 'title', 'text', 'remark']))
    const course = noTags(pick(h, ['subject', 'subjectName', 'professionName', 'lessonName', 'course', 'teacherSubject']))
    if (!title) return { error: 'יש פריטים בלוח שיעורי הבית, אבל בלי שדה טקסט שאני מכיר, אז לא נקרא' }
    const day = isoDay(pick(h, ['dueDate', 'toDate', 'homeWorkDate', 'homeworkDate', 'endDate', 'date', 'lessonDate']))
    const id = pick(h, ['id', 'homeWorkId', 'homeworkId', 'HomeWorkId', 'homeWorkID'])
    entries.push({ sourceId: id !== '' ? `hw:${id}` : `hw:${day}:${digest([course, title])}`, title, course, due: day ? { day, time: null } : null, confidence: 'medium' })
  }
  return { entries }
}

const HOMEWORK_WORDS = /שיעורי ה?בית|ש"ב|להגיש|הגשה|מטלה|מטלות|דף עבודה|תרגיל|עבודה ב/
const allowedGroup = (name) => settings().groups.some((q) => groups.groupNameMatches(name, q))

// groups.js tick(): the items this round extracted. Only groups on SCHOOLWORK_GROUPS are looked at; anything else
// is not stored here at all.
export async function fromGroups(items, notify, nowMs = Date.now()) {
  if (!enabled() || !settings().groups.length) return null
  const g = groups.load().groups
  const entries = []
  const refs = new Map() // item id -> the source message, for the alert shared with src/mathwork.js
  for (const i of items || []) {
    const name = g[i.g]?.name || ''
    if (!name || g[i.g]?.muted || !allowedGroup(name)) continue
    const base = { sourceId: `${i.id}:${i.at}`, title: i.title, course: name, due: i.date ? { day: i.date, time: i.time || null } : null }
    refs.set(`groups:${base.sourceId}`, { g: i.g, s: i.s, mid: i.mid || '', day: i.date || '', text: i.title })
    if (i.type === 'homework') entries.push({ ...base, confidence: i.date ? 'medium' : 'low' })
    else if ((i.type === 'cancel' || i.type === 'change') && HOMEWORK_WORDS.test(i.title)) entries.push({ ...base, kind: i.type })
  }
  // The groups are read once a round whether or not anything was found; freshness comes from groups.json.
  const s = load()
  ;(s.sources.groups ??= {}).baselined = true
  const out = ingest('groups', entries, nowMs)
  // The same homework already alerted by the math report (src/mathwork.js, same group message) is listed here as
  // usual but not alerted a second time. One alerted here first is claimed, so the math report does not repeat it.
  let skipped = false
  out.fresh = out.fresh.filter((item) => {
    const ref = refs.get(item.id)
    if (!ref) return true
    if (alerts.claimedByOther(ref, 'schoolwork', nowMs)) return !(item.alerted = skipped = true)
    alerts.claim(ref, 'schoolwork', nowMs)
    return true
  })
  if (skipped) persist()
  await announce(notify, out.fresh, out.updated, nowMs)
  return out
}
export const groupsHook = (notify) => (items) => fromGroups(items, notify).catch((e) => console.log(`[schoolwork] ${e.message}`))

// ── coverage: what was checked, how fresh, and what was not ───────────────────────────────────────────
let probes = {
  classroom: async () => {
    const { googleEnabled, googleAccounts } = await import('./google.js')
    return googleEnabled() && googleAccounts().length > 0
  },
  webtop: async () => {
    const { sessionEnabled } = await import('./session.js')
    return Boolean(config.webtop.alerts && sessionEnabled())
  },
}
export const _setProbes = (p) => (probes = { ...probes, ...p })

const ago = (ms, nowMs) => {
  const min = Math.max(0, Math.round((nowMs - ms) / 60000))
  return min < 60 ? `לפני ${min} דק'` : min < 48 * 60 ? `לפני ${Math.round(min / 60)} שעות` : `לפני ${Math.round(min / 1440)} ימים`
}

// [{ source, label, ok, text }]: ok false means "not checked", and the summary says so.
export async function coverage(nowMs = Date.now()) {
  const s = load()
  const rows = []
  const row = (source, label, maxAgeMin, every, configured, extra = '') => {
    const src = s.sources[source] || {}
    if (!configured) return rows.push({ source, label, ok: false, text: `${label}: לא מחובר או כבוי${extra ? `, ${extra}` : ''}` })
    const last = src.lastOk || 0
    if (src.lastErrorAt && src.lastErrorAt > last) return rows.push({ source, label, ok: false, text: `${label}: הקריאה האחרונה נכשלה (${ago(src.lastErrorAt, nowMs)}): ${src.lastError}` })
    if (!last) return rows.push({ source, label, ok: false, text: `${label}: עוד לא נקרא מאז שהופעל` })
    if (nowMs - last > maxAgeMin * 60000) return rows.push({ source, label, ok: false, text: `${label}: המידע ישן, נקרא לאחרונה ${ago(last, nowMs)}` })
    rows.push({ source, label, ok: !src.note, text: `${label}: נבדק ${ago(last, nowMs)} (${every})${src.note ? `. ${src.note}` : ''}` })
  }
  row('classroom', 'Classroom', 30, 'נבדק כל 5 דקות', await probes.classroom().catch(() => false))
  const webtopEvery = config.webtop.alertsMinutes
  row('webtop', 'Webtop (מבחנים, מטלות והודעות)', webtopEvery * 2 + 15, `נבדק פעם ב-${webtopEvery} דק', לא בזמן אמת`, await probes.webtop().catch(() => false))
  // The homework board: one more page in that same hourly read, on its own line, so a board that was not read is a
  // gap even when the rest of Webtop was.
  row('webtopHomework', 'לוח שיעורי הבית ב-Webtop', webtopEvery * 2 + 15, `באותה קריאה, פעם ב-${webtopEvery} דק'`, await probes.webtop().catch(() => false))
  const wanted = settings().groups
  if (!wanted.length) rows.push({ source: 'groups', label: 'קבוצות', ok: false, text: 'קבוצות וואטסאפ: לא נבחרו קבוצות של בית הספר (SCHOOLWORK_GROUPS)' })
  else if (!groups.groupsOn()) rows.push({ source: 'groups', label: 'קבוצות', ok: false, text: 'קבוצות וואטסאפ: המעקב אחרי הקבוצות כבוי' })
  else {
    const g = groups.load()
    const known = Object.values(g.groups).filter((x) => x.name && !x.muted)
    const missing = wanted.filter((q) => !known.some((x) => groups.groupNameMatches(x.name, q)))
    const every = groups.settings().everyMinutes
    const last = g.lastExtract || 0
    const since = g.readingSince ? ` (קורא רק מ-${wall(g.readingSince).day})` : ''
    if (!last) rows.push({ source: 'groups', label: 'קבוצות', ok: false, text: 'קבוצות וואטסאפ: עוד לא נקראו' })
    else if (nowMs - last > every * 3 * 60000 + 5 * 60000) rows.push({ source: 'groups', label: 'קבוצות', ok: false, text: `קבוצות וואטסאפ: המידע ישן, נקרא לאחרונה ${ago(last, nowMs)}` })
    else rows.push({ source: 'groups', label: 'קבוצות', ok: !missing.length, text: `קבוצות וואטסאפ: נבדקו ${ago(last, nowMs)}${since}${missing.length ? `. לא מצאתי קבוצה בשם: ${missing.join(', ')}` : ''}` })
  }
  return rows
}

// ── the daily summary ──────────────────────────────────────────────────────────────────────────────
// limit: how many open items the message lists (the daily message caps it; the tool shows all). Anything past it is
// counted, never silently left out. Every open item counts, however old.
export async function summaryText(nowMs = Date.now(), { daily = false, limit = daily ? DAILY_LINES : Infinity } = {}) {
  const s = load()
  const now = wall(nowMs)
  const open = s.items.filter(isOpen).sort((a, b) => dueSort(a).localeCompare(dueSort(b)))
  const late = open.filter((i) => pastDue(i, nowMs))
  const upcoming = open.filter((i) => !pastDue(i, nowMs))
  const reported = open.filter((i) => i.reported)
  const submitted = s.items.filter((i) => i.status === 'submitted' && nowMs - (i.closedAt || 0) < 7 * DAY).length
  const cov = await coverage(nowMs)
  const gaps = cov.filter((c) => !c.ok)
  const [, m, d] = now.day.split('-').map(Number)
  const lines = [`📚 *מה פתוח בשיעורי בית ומטלות* (יום ${DAYS[weekday(now.day)]} ${d}.${m}${daily ? `, ${now.time}` : ''})`, `פתוחות: ${open.length}${late.length ? `, מהן ${late.length} שעבר המועד שלהן` : ''}`]
  // Past due first: they are the ones most likely to be forgotten.
  const shownLate = late.slice(0, limit)
  const shownUpcoming = upcoming.slice(0, Math.max(0, limit - shownLate.length))
  const overdueBy = (i) => dayNum(now.day) - dayNum(i.due.day)
  if (shownLate.length) lines.push('', '⚠️ עבר המועד ואין לי אישור שהוגש:', ...shownLate.map((i) => `• ${itemLine(i, nowMs)}${overdueBy(i) > 1 ? ` (לפני ${overdueBy(i)} ימים)` : ''}`))
  if (shownUpcoming.length) lines.push('', ...shownUpcoming.map((i) => `• ${itemLine(i, nowMs)}${i.reported ? ' ❓' : ''}`))
  const hidden = open.length - shownLate.length - shownUpcoming.length
  if (hidden > 0) lines.push('', `ועוד ${hidden} פתוחות שלא נכנסו להודעה. "מה פתוח בשיעורי בית?" מציג את כולן.`)
  if (reported.length) lines.push('', '❓ נכתב בקבוצה שבוטל או נדחה, לא מאומת:', ...reported.map((i) => `• ${i.title} (${i.reported.kind === 'cancel' ? 'בוטל?' : `נדחה${i.reported.due ? ` ל${dueLabel(i.reported.due, nowMs)}` : ''}?`})`))
  if (submitted) lines.push('', `✅ הוגשו לפי Classroom בשבוע האחרון: ${submitted}`)
  if (!open.length) {
    lines.push('', gaps.length ? 'לא מצאתי מטלות פתוחות במה שהצלחתי לבדוק, אבל זה לא אומר שאין שיעורי בית: חלק מהמקורות לא נבדקו (למטה).' : `לא מצאתי מטלות פתוחות ב: ${cov.map((c) => c.label).join(', ')}.`)
  }
  lines.push('', '*מה נבדק:*', ...cov.filter((c) => c.ok).map((c) => `✓ ${c.text}`))
  if (gaps.length) lines.push(...gaps.map((c) => `✗ ${c.text}`))
  if (open.length) lines.push('', 'סיימת משהו? תגיד לי "סיימתי את 3" ואסמן אצלי. אני לא מסמן כלום ב-Classroom או ב-Webtop.')
  return lines.join('\n')
}

// A due daily summary: at or after the set time, within the window, once per school-zone day.
export function dailyDue(nowMs = Date.now(), lastDaily = load().lastDaily) {
  const { dailyTime } = settings()
  if (!dailyTime) return ''
  const now = wall(nowMs)
  const [h, m] = dailyTime.split(':').map(Number)
  const late = now.minutes - (h * 60 + m)
  return late >= 0 && late < DAILY_WINDOW_MIN && lastDaily !== now.day ? now.day : ''
}

// Only closed items are let go (KEEP_CLOSED_DAYS after closing). An open item stays, however old, until there is
// evidence it is done or he asks to forget; age is never a reason to drop it or to treat it as done.
export function prune(nowMs = Date.now()) {
  const s = load()
  const before = s.items.length
  s.items = s.items.filter((i) => isOpen(i) || nowMs - (i.closedAt || i.lastSeen) < KEEP_CLOSED_DAYS * DAY)
  if (s.items.length !== before) persist()
}

// The daily summary, so a day is never lost between "it is time" and "the outbox has it":
//   1. pendingDaily { day, key } is written first.
//   2. notify is called. Whatever it returns or throws, the outcome is read from accepted(key) (see above).
//   3. Accepted: lastDaily = day and pendingDaily is cleared. Not accepted: it stays, and the next round (or the
//      first round after a restart) hands it over again with the same key. That is not a blind retry: a key the
//      outbox already has is ignored by it, so the most that can happen is the one message, once.
// An ordinary WhatsApp outage is not a failure here: the outbox queues the message and accepts it.
async function sendDaily(notify, day, nowMs) {
  const s = load()
  const key = `schoolwork-daily:${day}`
  if (!accepted(key)) {
    try {
      // He asked for this reminder at this hour, like a reminder he set: it is not held back by the daily budget.
      await notify(await summaryText(nowMs, { daily: true }), true, key, 'schoolwork')
    } catch (e) {
      console.log(`[schoolwork] daily summary not handed over yet: ${e.message}`)
    }
  }
  if (!accepted(key)) return false
  s.lastDaily = day
  s.pendingDaily = null
  persist()
  return true
}

// Scheduler job: alerts written down and not yet accepted, then the daily summary. Runs after the source jobs, so a
// read that was due this round is already in.
export async function schoolworkJob(notify, _runTask, _monitoring, nowMs = Date.now()) {
  if (!enabled() || !state.owner) return
  await flushPending(notify)
  prune(nowMs)
  const s = load()
  const today = wall(nowMs).day
  // A summary from an earlier day that never reached the outbox is not sent late as if it were today's.
  if (s.pendingDaily && s.pendingDaily.day !== today && !accepted(s.pendingDaily.key)) {
    console.log(`[schoolwork] the summary for ${s.pendingDaily.day} never reached the outbox; today's replaces it`)
    s.pendingDaily = null
    persist()
  }
  // Accepted just before a crash, so only the bookkeeping is left.
  if (s.pendingDaily && accepted(s.pendingDaily.key)) return void (await sendDaily(notify, s.pendingDaily.day, nowMs))
  const day = s.pendingDaily?.day === today ? today : dailyDue(nowMs)
  if (!day) return
  if (!s.pendingDaily) {
    s.pendingDaily = { day, key: `schoolwork-daily:${day}`, at: nowMs }
    persist()
  }
  await sendDaily(notify, day, nowMs)
}

// For the morning brief (day.js): the same lines the existing homework section prints.
// Eight lines at most, and a last line with how many more, so nothing open is silently left out.
export function briefHomework(nowMs = Date.now()) {
  const open = load().items.filter(isOpen).sort((a, b) => dueSort(a).localeCompare(dueSort(b)))
  const lines = open.slice(0, 8).map((i) => ({ title: i.title, course: where(i), due: dueLabel(i.due, nowMs) }))
  if (open.length > 8) lines.push({ title: `ועוד ${open.length - 8} פתוחות`, course: 'הרשימה המלאה: "מה פתוח בשיעורי בית?"', due: 'וגם בסיכום של אחר הצהריים' })
  return lines
}

// He said he finished: closed here only, with his word as the evidence. Nothing is sent to the source.
export function markDone(nums, nowMs = Date.now()) {
  const s = load()
  const hit = s.items.filter((i) => nums.includes(i.n) && isOpen(i))
  for (const i of hit) {
    i.status = 'done'
    i.closedAt = nowMs
    note(i, 'done', 'הוא אמר שסיים', nowMs)
  }
  persist()
  return hit.length ? `סימנתי אצלי כגמור: ${hit.map((i) => i.title).join(', ')}. ב-Classroom וב-Webtop לא שיניתי כלום.` : 'לא מצאתי מטלה פתוחה במספרים האלה.'
}
export function reopen(nums, nowMs = Date.now()) {
  const s = load()
  const hit = s.items.filter((i) => nums.includes(i.n) && i.status === 'done')
  for (const i of hit) (i.status = 'open'), (i.closedAt = 0), note(i, 'reopened', 'הוא אמר שעוד לא סיים', nowMs)
  persist()
  return hit.length ? `החזרתי לרשימה: ${hit.map((i) => i.title).join(', ')}.` : 'לא מצאתי מטלה שסימנתי כגמורה במספרים האלה.'
}

export async function statusText(nowMs = Date.now()) {
  const st = settings()
  const cov = await coverage(nowMs)
  return [
    `מעקב שיעורי בית: ${st.on ? 'פעיל' : 'כבוי (SCHOOLWORK=on מפעיל, אחרי אישור)'}`,
    `סיכום יומי: ${st.dailyTime ? `${st.dailyTime} (${st.tz})` : 'כבוי'}`,
    `קבוצות בית ספר: ${st.groups.length ? st.groups.join(', ') : 'לא נבחרו'}`,
    '',
    ...cov.map((c) => `${c.ok ? '✓' : '✗'} ${c.text}`),
    '',
    `שום מקור לא בזמן אמת. מטלה חדשה מגיעה כשהמקור נקרא: Classroom כל 5 דקות, קבוצות כל ${groups.settings().everyMinutes} דקות, Webtop (כולל לוח שיעורי הבית) פעם ב-${config.webtop.alertsMinutes} דקות. ההתראה עוברת בשעות השקט ובתקציב ההודעות כמו כל התראה.`,
  ].join('\n')
}
