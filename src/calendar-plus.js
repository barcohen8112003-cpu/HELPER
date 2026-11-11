// Google Calendar beyond adding events: find the exact event, change or delete it, invite or remove guests, and ask
// who is busy. get_calendar, calendar_add and the change watcher (calendarChanges) stay as they were.
//
// Rules this file keeps, in code:
// - Exact ids: account, calendar id and event id. A recurring event needs scope=instance (this occurrence, by its own
//   id from calendar_find) or scope=series (every occurrence). "This and following" is not offered, and the time of a
//   whole series is not moved here: both are refused by name.
// - Times are local wall-clock times in a named IANA time zone, sent to Google with that zone, so Google applies the
//   right offset on each date (DST included). A time that does not exist in that zone (the spring-forward gap) is
//   refused; an hour that happens twice is flagged in the question. All-day events take dates, end inclusive.
// - Guests: who will be emailed is part of the question. When the event has guests or guests change, notify must be
//   chosen explicitly (all, external, none); there is no default that silently emails people.
// - Every change and delete is conditional on the event's etag (If-Match), so an event changed after the question is
//   refused by Google itself, and the etag is checked again after the yes.
// - Free/busy: a calendar Google could not answer for is "unknown", never "free". Helper's grant (calendar.events)
//   does not include the free/busy scopes; without them only the account's own calendar can be read, from its events,
//   and that is labelled. Other people's calendars then come back as setup needed.
import { config } from './config.js'
import * as google from './google.js'
import { boundMutation, googleWriteAccount } from './bound-actions.js'
import { str, obj } from './tool-helpers.js'

const CAL = 'https://www.googleapis.com/calendar/v3'
const S = (name) => `https://www.googleapis.com/auth/${name}`
export const CAL_SCOPES = {
  read: [S('calendar.events'), S('calendar.events.readonly'), S('calendar'), S('calendar.readonly')],
  write: [S('calendar.events'), S('calendar')],
  freebusy: [S('calendar'), S('calendar.readonly'), S('calendar.freebusy'), S('calendar.events.freebusy')],
}
const DEFAULT_TZ = () => process.env.TIMEZONE || 'Asia/Jerusalem'
const fail = (message, code) => Object.assign(new Error(message), code && { code })
const MAX_GUESTS = 20
const NOTIFY = { all: 'all', external: 'externalOnly', none: 'none' }
const ADDR = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

export function calendarIdOf(id) {
  const s = String(id || 'primary').trim()
  if (s === 'primary' || /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(s)) return s
  throw fail(`מזהה יומן לא תקין: "${s.slice(0, 80)}".`)
}
const eventIdOf = (id) => {
  const s = String(id || '')
  if (!/^[A-Za-z0-9_-]{5,300}$/.test(s)) throw fail('צריך event_id מדויק (מ-calendar_find).')
  return s
}

// ---- time zones ----

export function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return /\//.test(tz) || tz === 'UTC'
  } catch {
    return false
  }
}

// "YYYY-MM-DDTHH:MM" as seen in `tz` for an instant.
export function localOf(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

// The instants a local wall-clock time names in `tz`: none (it falls in a DST gap), one, or two (the repeated hour).
export function instantsOf(local, tz) {
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!m) throw fail(`זמן לא תקין "${local}". נדרש YYYY-MM-DDTHH:MM, בזמן מקומי.`)
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  const found = new Set()
  // Every real offset is within ±14h; try each quarter hour and keep the ones that read back as this local time.
  for (let off = -14 * 60; off <= 14 * 60; off += 15) {
    const t = guess - off * 60000
    if (localOf(t, tz) === local) found.add(t)
  }
  return [...found].sort((a, b) => a - b)
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const nextDay = (d) => {
  const t = new Date(`${d}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}
const prevDay = (d) => {
  const t = new Date(`${d}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() - 1)
  return t.toISOString().slice(0, 10)
}

// The UTC offset a zone has at an instant, e.g. "UTC+02:00".
const offsetOf = (ms, tz) => (new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value || '').replace(/^GMT$/, 'UTC+00:00').replace('GMT', 'UTC')

// The instant one side (start or end) names: a dateTime with an offset as it is; a local dateTime in its timeZone
// (the first of a repeated hour, as Google does).
function instantOfSide(side, tz) {
  const dt = side?.dateTime
  if (!dt) return NaN
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(dt)) return Date.parse(dt)
  const at = instantsOf(dt.slice(0, 16), side.timeZone || tz)
  return at.length ? at[0] : NaN
}

function duration(ms) {
  const m = Math.round(ms / 60000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const min = m % 60
  return [d && `${d} ימים`, h && `${h} שעות`, min && `${min} דקות`].filter(Boolean).join(' ו-') || '0 דקות'
}

const dayCount = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000)

// How an event's time reads to a person: full start AND end date and time, each with its zone and UTC offset, and
// the duration. All-day events: first and last day (inclusive) and the number of days. The same function reads the
// event as it is and the patch that will be sent, so the question shows exactly the times Google will get.
function timeText(ev, tz) {
  if (ev.start?.date) {
    const endEx = ev.end?.date || nextDay(ev.start.date)
    const last = prevDay(endEx)
    const n = dayCount(ev.start.date, endEx)
    return last === ev.start.date ? `${ev.start.date} (כל היום, יום אחד)` : `${ev.start.date} עד ${last} כולל (כל היום, ${n} ימים)`
  }
  const zs = ev.start?.timeZone || tz
  const ze = ev.end?.timeZone || zs
  const a = instantOfSide(ev.start, zs)
  const b = instantOfSide(ev.end, ze)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '(זמן לא ידוע)'
  return `מ-${localOf(a, zs).replace('T', ' ')} (${zs} ${offsetOf(a, zs)}) עד ${localOf(b, ze).replace('T', ' ')} (${ze === zs ? '' : `${ze} `}${offsetOf(b, ze)}), משך ${duration(b - a)}`
}

// The new start/end for a patch, from what was asked and what the event has now.
export function planTimes(ev, { start, end, all_day, time_zone }, calendarTz) {
  if (start == null && end == null && all_day == null && time_zone == null) return null
  const wasAllDay = Boolean(ev.start?.date)
  const allDay = all_day ?? wasAllDay
  if (allDay) {
    const s = start ?? (wasAllDay ? ev.start.date : null)
    if (!s || !DATE.test(s)) throw fail('באירוע של כל היום צריך תאריך YYYY-MM-DD.')
    const lastIncl = end ?? (wasAllDay ? prevDay(ev.end?.date || nextDay(ev.start.date)) : s)
    if (!DATE.test(lastIncl) || lastIncl < s) throw fail('תאריך הסיום חייב להיות YYYY-MM-DD, לא לפני ההתחלה.')
    return { start: { date: s, dateTime: null, timeZone: null }, end: { date: nextDay(lastIncl), dateTime: null, timeZone: null }, notes: [] }
  }
  const tz = time_zone || ev.start?.timeZone || calendarTz || DEFAULT_TZ()
  if (!validZone(tz)) throw fail(`אזור זמן לא מוכר: "${tz}". צריך שם IANA, למשל Asia/Jerusalem.`)
  const notes = []
  const resolve = (local, label) => {
    const at = instantsOf(local, tz)
    if (!at.length) throw fail(`${label} ${local} לא קיים ב-${tz} (מעבר לשעון קיץ). צריך שעה אחרת.`)
    if (at.length > 1) notes.push(`⚠️ השעה ${local} חוזרת פעמיים ב-${tz} (מעבר לשעון חורף). גוגל יבחר את הראשונה.`)
    return at[0]
  }
  let s
  let e
  if (start != null) s = resolve(start, 'זמן ההתחלה')
  else if (wasAllDay) throw fail('כדי להפוך אירוע של כל היום לאירוע בשעה צריך start.')
  else s = Date.parse(ev.start.dateTime)
  if (end != null) e = resolve(end, 'זמן הסיום')
  else if (!wasAllDay && ev.end?.dateTime) e = s + (Date.parse(ev.end.dateTime) - Date.parse(ev.start.dateTime))
  else e = s + 3600000
  if (!(e > s)) throw fail('הסיום חייב להיות אחרי ההתחלה.')
  return { start: { dateTime: `${localOf(s, tz)}:00`, timeZone: tz, date: null }, end: { dateTime: `${localOf(e, tz)}:00`, timeZone: tz, date: null }, notes, startMs: s, endMs: e, tz }
}

// ---- reading ----

async function getEvent(email, cal, id) {
  try {
    return await google.gcall(email, 'GET', `${CAL}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`)
  } catch (e) {
    if (e.status === 404 || e.status === 410) throw fail(`אין אירוע ${id} ביומן ${cal} של ${email}.`)
    throw e
  }
}

// The calendar's own time zone comes back with any events list; calendars.get needs a wider scope than Helper has.
async function calendarZone(email, cal) {
  const r = await google.gcall(email, 'GET', `${CAL}/calendars/${encodeURIComponent(cal)}/events?maxResults=1&fields=timeZone`)
  return r.timeZone || DEFAULT_TZ()
}

const others = (ev, email) => (ev.attendees || []).filter((a) => !a.self && a.email?.toLowerCase() !== email.toLowerCase() && !a.resource)

export async function findEvents(email, { calendar_id, query, from, days = 14 }) {
  const cal = calendarIdOf(calendar_id)
  const tz = await calendarZone(email, cal)
  const startDay = from && DATE.test(from) ? from : localOf(Date.now(), tz).slice(0, 10)
  const [t0] = instantsOf(`${startDay}T00:00`, tz)
  const t1 = t0 + Math.min(120, Math.max(1, days)) * 86400000
  const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '50', timeMin: new Date(t0).toISOString(), timeMax: new Date(t1).toISOString(), ...(query && { q: String(query).slice(0, 200) }) })
  const r = await google.gcall(email, 'GET', `${CAL}/calendars/${encodeURIComponent(cal)}/events?${q}`)
  return {
    account: email,
    calendar_id: cal,
    time_zone: r.timeZone || tz,
    events: (r.items || []).map((ev) => ({
      event_id: ev.id,
      recurring_event_id: ev.recurringEventId || null,
      title: ev.summary || '',
      when: timeText(ev, r.timeZone || tz),
      all_day: Boolean(ev.start?.date),
      organizer_is_me: Boolean(ev.organizer?.self),
      guests: others(ev, email).map((a) => ({ email: a.email, response: a.responseStatus })),
    })),
  }
}

// ---- which event a change applies to ----

async function target(email, cal, eventId, scope) {
  const ev = await getEvent(email, cal, eventId)
  if (ev.status === 'cancelled') throw fail('האירוע כבר בוטל.')
  const instance = Boolean(ev.recurringEventId)
  const master = Array.isArray(ev.recurrence) && ev.recurrence.length > 0
  if (scope === 'following') throw fail('"זה והבאים אחריו" לא נתמך כאן. אפשר לשנות מופע אחד (instance) או את כל הסדרה (series), או לעשות את זה ב-Google Calendar.', 'unsupported')
  if (!instance && !master) {
    if (scope === 'series') throw fail('האירוע הזה לא חוזר, אין לו סדרה.')
    return { ev, id: ev.id, kind: 'single' }
  }
  if (!['instance', 'series'].includes(scope)) throw fail('זה אירוע חוזר. צריך scope=instance (רק המופע הזה) או scope=series (כל המופעים).')
  if (scope === 'instance') {
    if (!instance) throw fail('זה מזהה הסדרה, לא של מופע. למופע אחד צריך את ה-event_id שלו מ-calendar_find.')
    return { ev, id: ev.id, kind: 'instance' }
  }
  const series = instance ? await getEvent(email, cal, ev.recurringEventId) : ev
  return { ev: series, id: series.id, kind: 'series' }
}

const KIND = { single: 'האירוע', instance: 'רק המופע הזה של אירוע חוזר', series: 'כל המופעים של האירוע החוזר' }

function notifyChoice(notify, needed) {
  if (notify == null || notify === '') {
    if (needed) throw fail('לאירוע יש אורחים (או שהם משתנים). צריך לבחור notify: all (לשלוח להם מייל), external (רק לאורחים מחוץ לארגון) או none (לא לשלוח).')
    return 'none'
  }
  if (!NOTIFY[notify]) throw fail('notify צריך להיות all, external או none.')
  return NOTIFY[notify]
}
const notifyText = (sendUpdates, guests) =>
  !guests.length ? '' : sendUpdates === 'all' ? `\n*מיילים מגוגל יישלחו ל:* ${guests.join(', ')}` : sendUpdates === 'externalOnly' ? `\n*מיילים מגוגל:* רק לאורחים מחוץ לארגון מבין ${guests.join(', ')}` : '\n*מיילים:* לא יישלחו לאורחים'

// ---- tools' work ----

export async function updateEvent(ctx, args) {
  return boundMutation(ctx, {
    tool: 'calendar_update',
    async prepare() {
      const email = await googleWriteAccount(args.account, { scopesAny: CAL_SCOPES.write, google, readOnly: config.google.readOnly })
      const cal = calendarIdOf(args.calendar_id)
      const t = await target(email, cal, eventIdOf(args.event_id), args.scope)
      const ev = t.ev
      const patch = {}
      const lines = []
      if (args.title != null) { patch.summary = String(args.title).slice(0, 500); lines.push(`*כותרת:* ${ev.summary || ''} ← ${patch.summary}`) }
      if (args.location != null) { patch.location = String(args.location).slice(0, 500); lines.push(`*מקום:* ${ev.location || '—'} ← ${patch.location || '—'}`) }
      if (args.description != null) { patch.description = String(args.description).slice(0, 2000); lines.push(`*פירוט:* ${patch.description || '(ריק)'}`) }
      const timed = { start: args.start, end: args.end, all_day: args.all_day, time_zone: args.time_zone }
      let notes = []
      if (Object.values(timed).some((v) => v != null)) {
        if (t.kind === 'series') throw fail('הזזת הזמן של כל הסדרה לא נתמכת כאן (היא משנה את חוק החזרה). אפשר להזיז מופע אחד (scope=instance) או לעשות את זה ב-Google Calendar.', 'unsupported')
        const tz = await calendarZone(email, cal)
        const times = planTimes(ev, timed, tz)
        patch.start = times.start
        patch.end = times.end
        notes = times.notes
        // "After" is read from the patch itself, the exact values sent.
        const before = timeText(ev, tz)
        const after = timeText({ start: patch.start, end: patch.end }, tz)
        lines.push(`*זמן עכשיו:* ${before}\n*זמן חדש:* ${after}`)
        if (after === before) notes.push('⚠️ הזמן החדש זהה לזמן הנוכחי.')
      }
      const add = [...new Set([].concat(args.add_guests || []).map((a) => String(a).trim().toLowerCase()))]
      const remove = [...new Set([].concat(args.remove_guests || []).map((a) => String(a).trim().toLowerCase()))]
      const current = ev.attendees || []
      if (add.length || remove.length) {
        if (ev.organizer && !ev.organizer.self) throw fail('רק מי שארגן את האירוע יכול להזמין או להסיר אורחים.')
        for (const a of add) if (!ADDR.test(a)) throw fail(`כתובת אורח לא תקינה: "${a.slice(0, 80)}".`)
        for (const r of remove) if (!current.some((x) => x.email?.toLowerCase() === r)) throw fail(`${r} לא מוזמן לאירוע הזה.`)
        const kept = current.filter((x) => !remove.includes(x.email?.toLowerCase()))
        const fresh = add.filter((a) => !kept.some((x) => x.email?.toLowerCase() === a))
        if (kept.length + fresh.length > MAX_GUESTS) throw fail(`יותר מדי אורחים (מקסימום ${MAX_GUESTS}).`)
        patch.attendees = [...kept, ...fresh.map((email) => ({ email }))]
        if (fresh.length) lines.push(`*להזמין:* ${fresh.join(', ')}`)
        if (remove.length) lines.push(`*להסיר מהאורחים:* ${remove.join(', ')}`)
      }
      if (!Object.keys(patch).length) throw fail('אין שינוי לבצע.')
      const guests = [...new Set([...others(ev, email), ...(patch.attendees || []).filter((a) => a.email?.toLowerCase() !== email.toLowerCase())].map((a) => a.email.toLowerCase()))]
      const sendUpdates = notifyChoice(args.notify, guests.length > 0)
      return {
        account: email,
        op: { email, cal, id: t.id, etag: ev.etag, patch, sendUpdates },
        fingerprint: { etag: ev.etag },
        question: `לשנות ביומן ${cal} של ${email} את ${KIND[t.kind]} "${ev.summary || ''}" (${timeText(ev, ev.start?.timeZone)})?\n${lines.join('\n')}${notifyText(sendUpdates, guests)}${notes.length ? `\n${notes.join('\n')}` : ''}\n\nאם האירוע ישתנה לפני השליחה, גוגל יסרב.`,
      }
    },
    recheck: async (op) => ({ etag: (await getEvent(op.email, op.cal, op.id)).etag }),
    async execute(op) {
      const res = await google.gcall(op.email, 'PATCH', `${CAL}/calendars/${encodeURIComponent(op.cal)}/events/${encodeURIComponent(op.id)}?sendUpdates=${op.sendUpdates}`, { json: op.patch, headers: { 'If-Match': op.etag } })
      return { confirmed: res.id === op.id && res.etag && res.etag !== op.etag, ref: res.htmlLink || res.id, text: `האירוע עודכן${res.htmlLink ? `: ${res.htmlLink}` : ''}` }
    },
  })
}

export async function deleteEvent(ctx, args) {
  return boundMutation(ctx, {
    tool: 'calendar_delete',
    async prepare() {
      const email = await googleWriteAccount(args.account, { scopesAny: CAL_SCOPES.write, google, readOnly: config.google.readOnly })
      const cal = calendarIdOf(args.calendar_id)
      const t = await target(email, cal, eventIdOf(args.event_id), args.scope)
      const ev = t.ev
      const guests = others(ev, email).map((a) => a.email.toLowerCase())
      const sendUpdates = notifyChoice(args.notify, guests.length > 0)
      const notMine = ev.organizer && !ev.organizer.self ? `\n⚠️ לא אתה ארגנת את האירוע (${ev.organizer.email}). המחיקה מסירה אותו מהיומן שלך.` : ''
      return {
        account: email,
        op: { email, cal, id: t.id, etag: ev.etag, sendUpdates },
        fingerprint: { etag: ev.etag },
        question: `למחוק מהיומן ${cal} של ${email} את ${KIND[t.kind]} "${ev.summary || ''}" (${timeText(ev, ev.start?.timeZone)})?${t.kind === 'series' ? '\n⚠️ כל המופעים יימחקו.' : ''}${notMine}${notifyText(sendUpdates, guests)}`,
      }
    },
    recheck: async (op) => ({ etag: (await getEvent(op.email, op.cal, op.id)).etag }),
    async execute(op) {
      await google.gcall(op.email, 'DELETE', `${CAL}/calendars/${encodeURIComponent(op.cal)}/events/${encodeURIComponent(op.id)}?sendUpdates=${op.sendUpdates}`, { headers: { 'If-Match': op.etag } })
      // Google answers a delete with an empty 204. The event is read again to confirm it is gone.
      let gone = false
      try {
        const after = await google.gcall(op.email, 'GET', `${CAL}/calendars/${encodeURIComponent(op.cal)}/events/${encodeURIComponent(op.id)}`)
        gone = after.status === 'cancelled'
      } catch (e) {
        gone = e.status === 404 || e.status === 410
      }
      return { confirmed: gone, ref: op.id, text: gone ? 'האירוע נמחק' : 'גוגל קיבל את המחיקה אבל האירוע עדיין מופיע' }
    },
  })
}

// Busy times per calendar. Each calendar is { state: 'known', busy } or { state: 'unknown', reason }: an error or a
// missing answer is never read as free.
export async function freeBusy(email, { calendars, from, to, time_zone }) {
  const tz = time_zone || DEFAULT_TZ()
  if (!validZone(tz)) throw fail(`אזור זמן לא מוכר: "${tz}".`)
  const ids = [...new Set([].concat(calendars?.length ? calendars : ['primary']).map((c) => calendarIdOf(c)))]
  if (ids.length > 20) throw fail('יותר מדי יומנים (מקסימום 20).')
  const t0 = instantsOf(from, tz)[0]
  const t1 = instantsOf(to, tz)[0]
  if (t0 == null || t1 == null) throw fail('from/to לא קיימים באזור הזמן הזה (מעבר שעון).')
  if (!(t1 > t0) || t1 - t0 > 62 * 86400000) throw fail('הטווח חייב להיות חיובי ועד 62 יום.')
  const granted = (await google.grantedScopes(email)) || []
  const out = { account: email, time_zone: tz, from, to, calendars: {} }
  if (CAL_SCOPES.freebusy.some((s) => granted.includes(s))) {
    let r
    try {
      r = await google.gcall(email, 'POST', `${CAL}/freeBusy`, { json: { timeMin: new Date(t0).toISOString(), timeMax: new Date(t1).toISOString(), timeZone: tz, items: ids.map((id) => ({ id })) } })
    } catch (e) {
      for (const id of ids) out.calendars[id] = { state: 'unknown', reason: e.message.slice(0, 120) }
      return out
    }
    for (const id of ids) {
      const c = r.calendars?.[id]
      if (!c) out.calendars[id] = { state: 'unknown', reason: 'גוגל לא החזיר תשובה ליומן הזה' }
      else if (c.errors?.length) out.calendars[id] = { state: 'unknown', reason: c.errors.map((x) => x.reason).join(', ') }
      else out.calendars[id] = { state: 'known', source: 'freebusy', busy: (c.busy || []).map((b) => ({ start: localOf(Date.parse(b.start), tz), end: localOf(Date.parse(b.end), tz) })) }
    }
    return out
  }
  // Without a free/busy scope: only this account's own calendar, from its events (needs calendar.events).
  const canRead = CAL_SCOPES.read.some((s) => granted.includes(s))
  for (const id of ids) {
    const own = id === 'primary' || id.toLowerCase() === email.toLowerCase()
    if (!own || !canRead) {
      out.calendars[id] = { state: 'unknown', reason: `setup needed: אין ל-Helper הרשאת free/busy (${CAL_SCOPES.freebusy.slice(2).join(' או ')}). לא נוספה אוטומטית.` }
      continue
    }
    try {
      const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeMin: new Date(t0).toISOString(), timeMax: new Date(t1).toISOString() })
      const r = await google.gcall(email, 'GET', `${CAL}/calendars/${encodeURIComponent(id)}/events?${q}`)
      if (r.nextPageToken) {
        out.calendars[id] = { state: 'unknown', reason: 'יותר מ-250 אירועים בטווח; צריך טווח קצר יותר' }
        continue
      }
      const busy = (r.items || [])
        .filter((ev) => ev.status !== 'cancelled' && ev.transparency !== 'transparent' && !(ev.attendees || []).some((a) => a.self && a.responseStatus === 'declined'))
        .map((ev) => (ev.start?.date ? { start: `${ev.start.date}T00:00`, end: `${ev.end?.date || nextDay(ev.start.date)}T00:00`, all_day: true } : { start: localOf(Date.parse(ev.start.dateTime), tz), end: localOf(Date.parse(ev.end.dateTime), tz) }))
      out.calendars[id] = { state: 'known', source: 'events (היומן שלך; אירועים שסומנו "פנוי" או שסירבת להם לא נספרים)', busy }
    } catch (e) {
      out.calendars[id] = { state: 'unknown', reason: e.message.slice(0, 120) }
    }
  }
  return out
}

// ---- tools ----

const ACC = str('חשבון Google. חובה כשיש יותר מחשבון אחד לכתיבה.')
const readAccount = async (account) => {
  const email = google.resolveAccounts(account)[0]
  if (!email) throw fail('אין חשבון Google מחובר.')
  const granted = await google.grantedScopes(email)
  if (!granted || !CAL_SCOPES.read.some((s) => granted.includes(s))) throw fail(`לחשבון ${email} אין הרשאת יומן בגישה שגוגל נתן.`)
  return email
}

export const calendarPlusTools = [
  {
    name: 'calendar_find',
    enabled: google.googleEnabled,
    description: 'קריאה בלבד: מוצא אירועים ביומן Google עם event_id מדויק לכל מופע (גם של אירוע חוזר), recurring_event_id, זמן, ואורחים. לפני calendar_update או calendar_delete.',
    parameters: obj({ account: str('החשבון'), calendar_id: str('ברירת מחדל primary'), query: str('טקסט לחפש'), from: str('מתאריך YYYY-MM-DD (ברירת מחדל היום)'), days: { type: 'number', description: 'כמה ימים (ברירת מחדל 14)' } }, []),
    async run(args) {
      try {
        return JSON.stringify(await findEvents(await readAccount(args.account), args))
      } catch (e) {
        return `שגיאה: ${e.message}`
      }
    },
  },
  {
    name: 'calendar_update',
    enabled: google.googleEnabled,
    description:
      'משנה אירוע קיים: כותרת, מקום, פירוט, זמן (זמן מקומי YYYY-MM-DDTHH:MM ב-time_zone, או all_day עם תאריכים), הזמנה או הסרה של אורחים. אירוע חוזר: scope=instance או series. כשיש אורחים: notify=all/external/none חובה. המשתמש מאשר.',
    parameters: obj(
      {
        account: ACC,
        calendar_id: str('ברירת מחדל primary'),
        event_id: str('מ-calendar_find'),
        scope: str('instance | series, לאירוע חוזר'),
        title: str('כותרת חדשה'),
        location: str('מקום'),
        description: str('פירוט'),
        start: str('התחלה: YYYY-MM-DDTHH:MM מקומי, או YYYY-MM-DD עם all_day'),
        end: str('סיום (ברירת מחדל: אותו משך)'),
        all_day: { type: 'boolean' },
        time_zone: str('IANA, למשל Asia/Jerusalem'),
        add_guests: { type: 'array', items: { type: 'string' } },
        remove_guests: { type: 'array', items: { type: 'string' } },
        notify: str('all | external | none'),
      },
      ['event_id']
    ),
    run: (args, ctx) => updateEvent(ctx, args),
  },
  {
    name: 'calendar_delete',
    enabled: google.googleEnabled,
    description: 'מוחק אירוע מיומן Google. אירוע חוזר: scope=instance (מופע אחד) או series (כולם). כשיש אורחים: notify חובה. המשתמש מאשר.',
    parameters: obj({ account: ACC, calendar_id: str('ברירת מחדל primary'), event_id: str('מ-calendar_find'), scope: str('instance | series'), notify: str('all | external | none') }, ['event_id']),
    run: (args, ctx) => deleteEvent(ctx, args),
  },
  {
    name: 'calendar_freebusy',
    enabled: google.googleEnabled,
    description: 'מתי תפוס בטווח זמן, לכל יומן. יומן שגוגל לא ענה עליו מסומן unknown ולא פנוי. בלי הרשאת free/busy רק היומן שלך נקרא, מהאירועים שלו.',
    parameters: obj({ account: str('החשבון'), calendars: { type: 'array', items: { type: 'string' }, description: 'מזהי יומנים או כתובות (ברירת מחדל primary)' }, from: str('YYYY-MM-DDTHH:MM מקומי'), to: str('YYYY-MM-DDTHH:MM מקומי'), time_zone: str('IANA') }, ['from', 'to']),
    async run(args) {
      try {
        const email = google.resolveAccounts(args.account)[0]
        if (!email) return 'אין חשבון Google מחובר'
        return JSON.stringify(await freeBusy(email, args))
      } catch (e) {
        return `שגיאה: ${e.message}`
      }
    },
  },
]
