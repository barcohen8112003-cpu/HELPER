// DeliveryPolicy and DailyBrief: when a decided event actually reaches the user, and in what shape.
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { inQuietHours } from '../outbox.js'
import { load, persist, iso } from './state.js'
import { NEVER_INTERRUPT } from './filter.js'
import { deadlineIsNear } from './urgency.js'

const MAX_DELIVERED = 300
const hhmm = (d) => new Date(d).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
const minutes = (s) => (/^\d{1,2}:\d{2}$/.test(s || '') ? Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]) : null)

const LABELS = { mail: 'מייל', calendar: 'יומן', reminder: 'תזכורת', helper: 'העוזר' }
export const sourceLabel = (source) => {
  const [kind, account] = source.split('/')
  return account ? `${LABELS[kind] || kind} ${account}` : LABELS[kind] || kind
}

// Appendix A: one line of what happened, one line of source and time. No greeting.
export const formatAlert = (urgent, event, summary) => `${urgent ? 'דחוף' : 'עדכון'} - ${sourceLabel(event.source)}\n${summary || event.title}\nמקור: ${event.source} - ${hhmm(event.occurred_at)}`

// When the morning brief goes out, in minutes after midnight, or null when nothing is set.
// DAILY_BRIEF_TIME inside quiet hours waits for them to end: max(DAILY_BRIEF_TIME, QUIET_HOURS.end).
export function briefMinutes() {
  const brief = minutes(config.briefTime)
  const q = config.quiet
  if (brief === null) return q ? q.to : null
  if (!q) return brief
  const inside = q.from > q.to ? brief >= q.from || brief < q.to : brief >= q.from && brief < q.to
  return inside ? q.to : brief
}

// The "only today" morning message: calendar events, tasks and lessons, nothing else.
export function todayText(day, today) {
  const lines = []
  if (day.events?.length) lines.push('', 'ביומן:', ...day.events.map((e) => `- ${e.when} ${e.title}`))
  const todo = [...(day.tasks || []).map((t) => `- ${t.title}${t.overdue ? ' (באיחור)' : ''}`), ...(day.reminders || []).map((r) => `- ${r.time} ${r.text}`)]
  if (todo.length) lines.push('', 'משימות להיום:', ...todo)
  if (day.lessons) lines.push('', 'שיעורים:', day.lessons)
  if (day.groups?.length) lines.push('', 'מהקבוצות:', ...day.groups.map((g) => `- ${g}`))
  if (!lines.length) return config.briefAlways ? 'בוקר טוב. אין היום יומן, משימות או שיעורים.' : ''
  return [`בוקר טוב. היום ${today.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' })}:`, ...lines].join('\n')
}

// What piled up overnight (important mail and notices held for the morning). Sent as its own message, and only when
// there is something, so the morning message stays about today.
export function nightText(s) {
  const held = s.watches.flatMap((w) => w.pending_batch).filter((item) => !s.delivered.includes(item.event_id))
  const lines = [...held.map((item) => `- ${sourceLabel(item.source)}: ${item.title}`), ...s.notes.map((n) => `- ${n.text}`)]
  if (s.suspicious.length) lines.push(...s.suspicious.map((x) => `- זוהה ניסיון דיוג חשוד: "${x.title}" (${x.source}). לא נגעתי בו`))
  return lines.length ? ['נצבר בלילה:', ...lines].join('\n') : ''
}

// deps: { send(text) => Promise<messageId>, now() => Date, getDay() => Promise<{ reminders, events, homework }>,
//   news?() => Promise<string> (the morning news lines, '' for none) }
export function createDelivery(deps) {
  const now = () => deps.now()

  // The intent is written to disk before the message leaves, and cleared only after it has left.
  // A crash in between leaves a 'sending' record, which the next start treats as "possibly sent".
  async function sendNow(text, { event_id, watch } = {}) {
    const s = load()
    const record = { id: randomUUID(), event_id: event_id || null, watch_id: watch?.id || null, text, status: 'sending', created_at: iso(now()) }
    s.pending.push(record)
    persist()
    return transmit(record)
  }

  async function transmit(record, text = record.text) {
    const s = load()
    let messageId
    try {
      messageId = await deps.send(text)
    } catch (e) {
      // The send itself reported failure, so nothing went out: safe to repeat as it is.
      // A doubtful record stays doubtful: the note about a possible repeat must still go with it.
      if (record.status !== 'doubtful') record.status = 'failed'
      persist()
      return false
    }
    s.pending = s.pending.filter((p) => p.id !== record.id)
    if (record.event_id) s.delivered = [...s.delivered, record.event_id].slice(-MAX_DELIVERED)
    const watch = s.watches.find((w) => w.id === record.watch_id)
    if (watch) watch.last_sent_message_id = messageId || null
    persist()
    return true
  }

  // After a restart. A 'sending' record means the process died between sending and recording it, so nobody
  // knows whether the message arrived. It is not sent blind a second time: it goes once more, saying so.
  async function reconcile() {
    for (const record of [...load().pending]) {
      if (record.status === 'sending') {
        record.status = 'doubtful'
        persist()
        await transmit(record, `${record.text}\n\n(ייתכן שכבר שלחתי לך את זה לפני שנפלתי)`)
      }
    }
  }

  // Messages that could not be sent because WhatsApp was offline.
  async function retry() {
    for (const record of [...load().pending]) if (record.status === 'failed' || record.status === 'doubtful') await transmit(record, record.status === 'doubtful' ? `${record.text}\n\n(ייתכן שכבר שלחתי לך את זה לפני שנפלתי)` : record.text)
  }

  // out: the urgency decision. category: from classify().
  async function deliver(event, watch, out, category) {
    const s = load()
    if (out.decision === 'drop') {
      s.dropped++
      persist()
      return 'dropped'
    }
    const quiet = inQuietHours(now())
    const interrupt = out.decision === 'interrupt' && !NEVER_INTERRUPT.includes(category)
    // An interrupt goes out now, quiet hours or not. Anything else goes out now only outside quiet hours.
    if (interrupt || !quiet) {
      await sendNow(formatAlert(interrupt, event, out.summary), { event_id: event.id, watch })
      return interrupt ? 'interrupted' : 'sent'
    }
    watch.pending_batch.push({ event_id: event.id, source: event.source, title: out.summary || event.title, at: iso(now()), deadline: out.deadline || null, topic: out.topic || '', incomplete: Boolean(out.incomplete) })
    persist()
    return 'batched'
  }

  // A quiet-hours notice from another part of the assistant (a web watch, a new assignment): it joins the brief.
  function addNote(text) {
    load().notes.push({ text: text.replace(/\s*\n+\s*/g, ' · ').slice(0, 300), at: iso(now()) })
    persist()
  }

  // Batched items whose deadline has come close are promoted and sent at once.
  async function escalate() {
    for (const watch of load().watches) {
      for (const item of [...watch.pending_batch]) {
        if (!deadlineIsNear(item, now())) continue
        watch.pending_batch = watch.pending_batch.filter((x) => x !== item)
        watch.stats.interrupts++
        persist()
        await sendNow(`דחוף - ${sourceLabel(item.source)}\n${item.title}\nמקור: ${item.source} - המועד מתקרב: ${new Date(item.deadline).toLocaleString('he-IL', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`, { event_id: item.event_id, watch })
      }
    }
  }

  // The whole brief as text, or '' when there is nothing worth sending.
  async function buildBrief() {
    const s = load()
    const today = now()
    const day = (await deps.getDay?.().catch(() => null)) || { reminders: [], events: [], homework: [] }
    if (config.briefOnlyToday) return todayText(day, today)
    const lines = []
    const agenda = [...day.events.map((e) => `- ${e.when} ${e.title}`), ...day.reminders.map((r) => `- ${r.time} ${r.text}`)]
    if (agenda.length) lines.push(`היום (${today.toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' })}):`, ...agenda)
    if (day.homework?.length) lines.push('', 'מטלות שאין לי אישור שהוגשו:', ...day.homework.map((h) => `- ${h.title} (${h.course}) - ${h.due}`))
    if (day.groups?.length) lines.push('', 'מהקבוצות:', ...day.groups.map((g) => `- ${g}`))

    // What was already delivered as an interrupt is not repeated here.
    const held = s.watches.flatMap((w) => w.pending_batch).filter((item) => !s.delivered.includes(item.event_id))
    const bySource = new Map()
    for (const item of held) bySource.set(item.source, [...(bySource.get(item.source) || []), item])
    const batch = [...bySource].flatMap(([source, items]) => items.map((item) => `- ${sourceLabel(source)}: ${item.title}${item.incomplete ? ' (לא הושלם ניתוח)' : ''}`))
    const notes = s.notes.map((n) => `- ${n.text}`)
    if (batch.length || notes.length) lines.push('', 'נצבר בלילה:', ...batch, ...notes)

    if (s.suspicious.length) lines.push('', ...s.suspicious.map((x) => `זוהה ניסיון דיוג חשוד: "${x.title}" (${x.source}). לא נגעתי בו, ועדיף לא ללחוץ על שום דבר בו.`))
    const hasContent = lines.length > 0
    if (s.dropped && hasContent) lines.push('', `זרקתי בשבילך: ${s.dropped} אירועים (שיווק ועדכונים אוטומטיים).`)

    // A watch that threw away nine events in ten is worth a second look. Said once.
    for (const w of s.watches) {
      if (w.suggested || w.state !== 'active' || w.stats.events_seen < 20 || w.stats.dropped / w.stats.events_seen < 0.9) continue
      if (hasContent) {
        lines.push('', `המעקב ${w.id} זרק ${w.stats.dropped} מתוך ${w.stats.events_seen} אירועים. שווה לשקול להשהות אותו: /watch pause ${w.id}`)
        w.suggested = true
      }
    }
    if (!hasContent) return config.briefAlways ? 'בוקר טוב. אין חדש.' : ''
    return `בוקר טוב. ${lines.join('\n')}`.replace(/^בוקר טוב\. \n/, 'בוקר טוב.\n')
  }

  // Sends the brief once a day, at briefMinutes(). The night's batch leaves with it, as one message.
  async function brief() {
    const at = briefMinutes()
    if (at === null) return false
    const s = load()
    const t = now()
    const today = t.toDateString()
    if (s.brief.lastDate === today || t.getHours() * 60 + t.getMinutes() < at) return false
    const day = await buildBrief()
    s.brief.lastDate = today
    // The morning news, when it is set for about the same time, rides in the same message (deps.news, src/scheduler.js).
    const news = deps.news ? await Promise.resolve(deps.news()).catch((e) => (console.log(`[news] ${e.message}`), '')) : ''
    const text = news ? `${day || 'בוקר טוב.'}\n\n📰 *מה קרה מאז אתמול בערב*\n${news}` : day
    if (text) await sendNow(text, { event_id: `brief:${today}` })
    // In the only-today mode the night's alerts are not part of that message; they leave on their own, if there are any.
    const night = config.briefOnlyToday ? nightText(s) : ''
    if (night) await sendNow(night, { event_id: `night:${today}` })
    for (const w of s.watches) w.pending_batch = []
    s.notes = []
    s.suspicious = []
    s.dropped = 0
    persist()
    return Boolean(text)
  }

  return { deliver, sendNow, reconcile, retry, escalate, brief, buildBrief, addNote }
}
