// node src/calendar-plus-selftest.js: calendar find/update/delete, guests and free/busy (src/calendar-plus.js),
// through the registered tools and once through the real agent loop. Offline: a stand-in Calendar keeps events
// with etags and answers If-Match like Google, so the checks prove what would change and what would not.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fakeFetch, googleError, makeChecker, askingCtx, scriptedModel } from './testing/fake-services.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-cal-'))
fs.writeFileSync(path.join(dir, '.env'), '')
Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1', GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_READONLY_ACCOUNTS: '', TIMEZONE: 'Asia/Jerusalem' })
fs.writeFileSync(path.join(dir, 'google.json'), JSON.stringify({ 'me@example.com': { refresh_token: 'r1' } }))

const { ok, done } = makeChecker()
const me = { email: 'me@example.com', self: true, responseStatus: 'accepted' }
const tz = 'Asia/Jerusalem'
let etagN = 1
const tag = () => `"e${etagN++}"`
const events = {
  evsolo01: { id: 'evsolo01', status: 'confirmed', summary: 'רופא שיניים', start: { dateTime: '2026-11-20T10:00:00+02:00', timeZone: tz }, end: { dateTime: '2026-11-20T11:00:00+02:00', timeZone: tz }, organizer: { email: 'me@example.com', self: true } },
  evguest1: { id: 'evguest1', status: 'confirmed', summary: 'פגישת עבודה', start: { dateTime: '2026-11-21T09:00:00+02:00', timeZone: tz }, end: { dateTime: '2026-11-21T09:30:00+02:00', timeZone: tz }, organizer: { email: 'me@example.com', self: true }, attendees: [me, { email: 'g@x.org', responseStatus: 'needsAction' }] },
  evinvite1: { id: 'evinvite1', status: 'confirmed', summary: 'הרצאה', start: { dateTime: '2026-11-22T18:00:00+02:00', timeZone: tz }, end: { dateTime: '2026-11-22T19:00:00+02:00', timeZone: tz }, organizer: { email: 'boss@x.org' }, attendees: [me, { email: 'boss@x.org', organizer: true, responseStatus: 'accepted' }] },
  evseries1: { id: 'evseries1', status: 'confirmed', summary: 'חוג', recurrence: ['RRULE:FREQ=WEEKLY'], start: { dateTime: '2026-11-16T10:00:00+02:00', timeZone: tz }, end: { dateTime: '2026-11-16T11:00:00+02:00', timeZone: tz }, organizer: { email: 'me@example.com', self: true } },
  evseries1_20261123T080000Z: { id: 'evseries1_20261123T080000Z', recurringEventId: 'evseries1', status: 'confirmed', summary: 'חוג', start: { dateTime: '2026-11-23T10:00:00+02:00', timeZone: tz }, end: { dateTime: '2026-11-23T11:00:00+02:00', timeZone: tz }, organizer: { email: 'me@example.com', self: true } },
  evallday1: { id: 'evallday1', status: 'confirmed', summary: 'טיול שנתי', start: { date: '2026-12-01' }, end: { date: '2026-12-02' }, organizer: { email: 'me@example.com', self: true } },
  evfree001: { id: 'evfree001', status: 'confirmed', summary: 'תזכורת', transparency: 'transparent', start: { dateTime: '2026-11-20T12:00:00+02:00', timeZone: tz }, end: { dateTime: '2026-11-20T13:00:00+02:00', timeZone: tz }, organizer: { email: 'me@example.com', self: true } },
  evdecl001: { id: 'evdecl001', status: 'confirmed', summary: 'סירבתי', start: { dateTime: '2026-11-20T14:00:00+02:00', timeZone: tz }, end: { dateTime: '2026-11-20T15:00:00+02:00', timeZone: tz }, organizer: { email: 'x@x.org' }, attendees: [{ ...me, responseStatus: 'declined' }] },
}
for (const e of Object.values(events)) e.etag = tag()
const deleted = new Set()
let serverEtagBump = null
const patches = []

let scopes = 'openid email https://www.googleapis.com/auth/calendar.events'
const C = 'www\\.googleapis\\.com/calendar/v3/calendars/([^/]+)'
const routes = [
  ['GET', new RegExp(`${C}/events\\?maxResults=1&fields=timeZone`), () => ({ json: { timeZone: tz } })],
  ['GET', new RegExp(`${C}/events\\?(.*)$`), ({ match }) => {
    const q = new URLSearchParams(match[2])
    const t0 = Date.parse(q.get('timeMin'))
    const t1 = Date.parse(q.get('timeMax'))
    const items = Object.values(events).filter((e) => !deleted.has(e.id) && !e.recurrence).filter((e) => {
      const s = Date.parse(e.start.dateTime || `${e.start.date}T00:00:00+02:00`)
      return s >= t0 && s < t1 && (!q.get('q') || e.summary.includes(q.get('q')))
    })
    return { json: { timeZone: tz, items } }
  }],
  ['GET', new RegExp(`${C}/events/([^/?]+)$`), ({ match }) => (deleted.has(match[2]) ? googleError(410, 'deleted', 'Resource has been deleted') : events[match[2]] ? { json: events[match[2]] } : googleError(404, 'notFound'))],
  ['PATCH', new RegExp(`${C}/events/([^/?]+)\\?sendUpdates=(\\w+)$`), (req) => {
    const ev = events[req.match[2]]
    if (!ev || deleted.has(ev.id)) return googleError(404, 'notFound')
    if (serverEtagBump) { ev.etag = serverEtagBump; serverEtagBump = null }
    if (req.headers['if-match'] !== ev.etag) return googleError(412, 'conditionNotMet', 'Precondition Failed')
    const body = req.json()
    patches.push({ id: ev.id, sendUpdates: req.match[3], body, ifMatch: req.headers['if-match'] })
    for (const [k, v] of Object.entries(body)) ev[k] = k === 'start' || k === 'end' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null)) : v
    ev.etag = tag()
    return { json: { ...ev, htmlLink: `https://calendar.google.com/event?eid=${ev.id}` } }
  }],
  ['DELETE', new RegExp(`${C}/events/([^/?]+)\\?sendUpdates=(\\w+)$`), (req) => {
    const ev = events[req.match[2]]
    if (!ev || deleted.has(ev.id)) return googleError(410, 'deleted')
    if (req.headers['if-match'] !== ev.etag) return googleError(412, 'conditionNotMet')
    patches.push({ id: ev.id, deleted: true, sendUpdates: req.match[3] })
    deleted.add(ev.id)
    return { status: 204, text: '' }
  }],
  ['POST', /calendar\/v3\/freeBusy$/, (req) => {
    const body = req.json()
    const calendars = {}
    for (const { id } of body.items) calendars[id] = id === 'other@x.org' ? { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] } : id === 'missing@x.org' ? undefined : { busy: [{ start: '2026-11-20T08:00:00Z', end: '2026-11-20T09:00:00Z' }] }
    for (const k of Object.keys(calendars)) if (!calendars[k]) delete calendars[k]
    return { json: { kind: 'calendar#freeBusy', calendars } }
  }],
  ['POST', /calendar\/v3\/calendars\/primary\/events$/, () => ({ json: { id: 'new1', htmlLink: 'https://calendar.google.com/event?eid=new1' } })],
]
const fake = fakeFetch({ routes, scopes: () => scopes })
globalThis.fetch = fake.fetch

const { config } = await import('./config.js')
const google = await import('./google.js')
const { tools } = await import('./tools.js')
const cp = await import('./calendar-plus.js')
const byName = new Map(tools.map((t) => [t.name, t]))
const run = async (name, args, answers) => {
  const { ctx, asked } = askingCtx(answers)
  const before = fake.writes().length
  const r = await byName.get(name).run(args, ctx)
  return { r, asked, text: typeof r === 'string' ? r : r.text, status: r?.status, wrote: fake.writes().filter((c) => c.method !== 'POST' || !/freeBusy/.test(c.url)).length - before }
}
const BYPASS = { confirmed: true, approved: true, force: true }
const setScopes = async (s) => { scopes = s; await google.accessToken('me@example.com', { fresh: true }) }

for (const n of ['calendar_find', 'calendar_update', 'calendar_delete', 'calendar_freebusy', 'calendar_add', 'get_calendar']) ok(byName.has(n), `${n} is registered`)

// ---- time zones and DST ----
{
  ok(cp.instantsOf('2027-03-14T02:30', 'America/New_York').length === 0, 'DST: a time in the spring-forward gap does not exist')
  ok(cp.instantsOf('2026-11-01T01:30', 'America/New_York').length === 2, 'DST: a time in the fall-back hour happens twice')
  ok(cp.instantsOf('2026-11-20T10:00', 'Asia/Jerusalem')[0] === Date.parse('2026-11-20T08:00:00Z'), 'a local time in Jerusalem in winter is UTC+2')
  ok(cp.instantsOf('2026-07-20T10:00', 'Asia/Jerusalem')[0] === Date.parse('2026-07-20T07:00:00Z'), 'and in summer UTC+3')
  ok(!cp.validZone('Mars/Olympus') && cp.validZone('Asia/Jerusalem'), 'unknown time zones are refused')
}

// ---- find ----
{
  const f = JSON.parse(await byName.get('calendar_find').run({ from: '2026-11-16', days: 14 }))
  const inst = f.events.find((e) => e.recurring_event_id === 'evseries1')
  ok(f.time_zone === tz && inst?.event_id === 'evseries1_20261123T080000Z' && /מ-2026-11-23 10:00 .* עד 2026-11-23 11:00/.test(inst.when), 'find: occurrences come with their own id, the series id and local time')
  ok(f.events.find((e) => e.event_id === 'evguest1').guests[0].email === 'g@x.org', 'find: guests are listed (without me)')
}

// ---- update ----
{
  const no = await run('calendar_update', { event_id: 'evsolo01', title: 'רופא שיניים - ד"ר כהן', ...BYPASS }, [false])
  ok(no.status === 'declined' && no.wrote === 0 && /רופא שיניים ← רופא שיניים - ד"ר כהן/.test(no.asked[0]), 'update: a no (with bypass arguments) changes nothing; the question shows before and after')
  const yes = await run('calendar_update', { event_id: 'evsolo01', title: 'רופא שיניים - ד"ר כהן' }, [true])
  const p = patches.at(-1)
  ok(yes.status === 'done' && p.ifMatch === '"e1"' && p.sendUpdates === 'none' && Object.keys(p.body).join() === 'summary', `update: only the title is sent, conditional on the etag (${yes.text})`)
}
{
  const r = await run('calendar_update', { event_id: 'evsolo01', start: '2026-11-20T12:30' }, [true])
  const p = patches.at(-1)
  ok(r.status === 'done' && p.body.start.dateTime === '2026-11-20T12:30:00' && p.body.start.timeZone === tz && p.body.end.dateTime === '2026-11-20T13:30:00', 'update: a new start keeps the duration, sent as local time with its zone')
  ok(/12:30/.test(r.asked[0]) && /Asia\/Jerusalem/.test(r.asked[0]), 'update: the question shows the new local time and the zone')
  const gap = await run('calendar_update', { event_id: 'evsolo01', start: '2027-03-14T02:30', time_zone: 'America/New_York' }, [true])
  ok(gap.status === 'refused' && /לא קיים/.test(gap.text) && gap.asked.length === 0, 'update: a time that does not exist (DST gap) is refused')
  const amb = await run('calendar_update', { event_id: 'evsolo01', start: '2026-11-01T01:30', time_zone: 'America/New_York' }, [false])
  ok(/חוזרת פעמיים/.test(amb.asked[0] || ''), 'update: an hour that happens twice is flagged in the question')
  const back = await run('calendar_update', { event_id: 'evsolo01', end: '2026-11-20T12:00' }, [true])
  ok(back.status === 'refused' && /אחרי ההתחלה/.test(back.text), 'update: an end before the start is refused')
}
{
  const r = await run('calendar_update', { event_id: 'evallday1', all_day: true, start: '2026-12-01', end: '2026-12-02' }, [true])
  const p = patches.at(-1)
  ok(r.status === 'done' && p.body.start.date === '2026-12-01' && p.body.end.date === '2026-12-03' && p.body.start.dateTime === null, 'all-day: end date is inclusive for him and exclusive for Google')
  const mix = await run('calendar_update', { event_id: 'evallday1', all_day: true, start: '2026-12-01T10:00' }, [true])
  ok(mix.status === 'refused', 'all-day: a time with all_day is refused')
}
{
  const none = await run('calendar_update', { event_id: 'evguest1', title: 'פגישה' }, [true])
  ok(none.status === 'refused' && /notify/.test(none.text) && none.asked.length === 0, 'guests: an event with guests needs an explicit notify choice')
  const quiet = await run('calendar_update', { event_id: 'evguest1', title: 'פגישה', notify: 'none' }, [false])
  ok(/לא יישלחו/.test(quiet.asked[0]), 'guests: notify=none says no mail is sent')
  const inv = await run('calendar_update', { event_id: 'evguest1', add_guests: ['new@y.org'], notify: 'all' }, [true])
  const p = patches.at(-1)
  ok(inv.status === 'done' && p.sendUpdates === 'all' && p.body.attendees.map((a) => a.email).join() === 'me@example.com,g@x.org,new@y.org', 'guests: invite keeps existing guests and adds the new one, emailing all as approved')
  ok(/new@y\.org/.test(inv.asked[0]) && /יישלחו ל:.*g@x\.org/.test(inv.asked[0]), 'guests: the question names who will be emailed')
  const rm = await run('calendar_update', { event_id: 'evguest1', remove_guests: ['stranger@z.org'], notify: 'none' }, [true])
  ok(rm.status === 'refused' && /לא מוזמן/.test(rm.text), 'guests: removing someone who is not a guest is refused')
  const badaddr = await run('calendar_update', { event_id: 'evguest1', add_guests: ['not an email'], notify: 'all' }, [true])
  ok(badaddr.status === 'refused', 'guests: an invalid address is refused')
  const notorg = await run('calendar_update', { event_id: 'evinvite1', add_guests: ['friend@y.org'], notify: 'all' }, [true])
  ok(notorg.status === 'refused' && /ארגן/.test(notorg.text), 'guests: only the organizer can invite')
}
{
  const noscope = await run('calendar_update', { event_id: 'evseries1_20261123T080000Z', title: 'x' }, [true])
  ok(noscope.status === 'refused' && /scope=instance/.test(noscope.text), 'recurring: an occurrence without scope is refused')
  const masterAsInst = await run('calendar_update', { event_id: 'evseries1', scope: 'instance', title: 'x' }, [true])
  ok(masterAsInst.status === 'refused' && /מופע/.test(masterAsInst.text), 'recurring: the series id with scope=instance is refused')
  const one = await run('calendar_update', { event_id: 'evseries1_20261123T080000Z', scope: 'instance', start: '2026-11-23T11:00' }, [true])
  ok(one.status === 'done' && patches.at(-1).id === 'evseries1_20261123T080000Z' && /רק המופע הזה/.test(one.asked[0]), 'recurring: scope=instance moves only that occurrence')
  const all = await run('calendar_update', { event_id: 'evseries1_20261123T080000Z', scope: 'series', title: 'חוג שחמט' }, [true])
  ok(all.status === 'done' && patches.at(-1).id === 'evseries1' && /כל המופעים/.test(all.asked[0]), 'recurring: scope=series changes the series event itself')
  const move = await run('calendar_update', { event_id: 'evseries1', scope: 'series', start: '2026-11-16T12:00' }, [true])
  ok(move.status === 'unsupported' && move.asked.length === 0, 'recurring: moving the whole series is refused by name')
  const fol = await run('calendar_update', { event_id: 'evseries1', scope: 'following', title: 'x' }, [true])
  ok(fol.status === 'unsupported', 'recurring: "this and following" is refused by name')
}
{
  const { ctx } = askingCtx()
  ctx.confirm = async () => { events.evsolo01.etag = tag(); return true }
  const before = patches.length
  const r = await byName.get('calendar_update').run({ event_id: 'evsolo01', location: 'קליניקה' }, ctx)
  ok(r.status === 'changed' && patches.length === before, 'etag: an event changed during the question is not touched')
  serverEtagBump = '"concurrent"'
  const s = await run('calendar_update', { event_id: 'evsolo01', location: 'קליניקה' }, [true])
  ok(s.status === 'changed' && patches.length === before && events.evsolo01.location === undefined, `etag: Google's 412 is reported as changed (${s.status})`)
}
{
  await setScopes('openid email https://www.googleapis.com/auth/calendar.readonly')
  const r = await run('calendar_update', { event_id: 'evsolo01', title: 'x' }, [true])
  ok(r.status === 'setup_needed' && r.asked.length === 0, 'scopes: a read-only calendar grant cannot change events')
  await setScopes('openid email https://www.googleapis.com/auth/calendar.events')
}

// ---- delete ----
{
  const no = await run('calendar_delete', { event_id: 'evseries1', scope: 'series', ...BYPASS }, [false])
  ok(no.status === 'declined' && !deleted.has('evseries1') && /כל המופעים יימחקו/.test(no.asked[0]), 'delete: a no keeps the series; the question warns every occurrence goes')
  const guests = await run('calendar_delete', { event_id: 'evguest1' }, [true])
  ok(guests.status === 'refused' && /notify/.test(guests.text), 'delete: with guests, notify must be chosen')
  const yes = await run('calendar_delete', { event_id: 'evsolo01' }, [true])
  ok(yes.status === 'done' && deleted.has('evsolo01') && patches.at(-1).sendUpdates === 'none', `delete: deleted, and confirmed by reading it back (${yes.text})`)
  const again = await run('calendar_delete', { event_id: 'evsolo01' }, [true])
  ok(again.status === 'refused' && again.asked.length === 0, 'delete: a deleted event is not deleted again')
  const inv = await run('calendar_delete', { event_id: 'evinvite1', notify: 'none' }, [false])
  ok(/לא אתה ארגנת/.test(inv.asked[0]), 'delete: an event someone else organised says so')
}

// ---- free/busy ----
{
  const own = JSON.parse(await byName.get('calendar_freebusy').run({ calendars: ['primary', 'other@x.org'], from: '2026-11-20T00:00', to: '2026-11-21T00:00' }))
  ok(own.calendars.primary.state === 'known' && /events/.test(own.calendars.primary.source), 'free/busy without the scope: own calendar from its events, labelled')
  // The only events left that day are one marked free and one he declined.
  ok(own.calendars.primary.busy.length === 0, 'free/busy fallback: "free" events and declined invitations are not busy')
  ok(own.calendars['other@x.org'].state === 'unknown' && /setup needed/.test(own.calendars['other@x.org'].reason), 'free/busy without the scope: someone else\'s calendar is unknown (setup needed), not free')
  ok(!fake.calls.some((c) => /freeBusy/.test(c.url)), 'free/busy: the freeBusy endpoint is not called without its scope')
  await setScopes('openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy')
  const fb = JSON.parse(await byName.get('calendar_freebusy').run({ calendars: ['primary', 'other@x.org', 'missing@x.org'], from: '2026-11-20T00:00', to: '2026-11-21T00:00' }))
  ok(fb.calendars.primary.state === 'known' && fb.calendars.primary.busy[0].start === '2026-11-20T10:00', 'free/busy: busy times come back in local time')
  ok(fb.calendars['other@x.org'].state === 'unknown' && /notFound/.test(fb.calendars['other@x.org'].reason), 'free/busy: a calendar with errors is unknown, never free')
  ok(fb.calendars['missing@x.org'].state === 'unknown', 'free/busy: a calendar Google left out is unknown, never free')
  await setScopes('openid email https://www.googleapis.com/auth/calendar.events')
}

// ---- existing add still works ----
{
  const r = await byName.get('calendar_add').run({ title: 'בדיקה', start: '2026-12-05T10:00' })
  ok(/האירוע נוסף/.test(r), 'calendar_add (unchanged) still adds')
}

// ---- through the real agent loop ----
{
  const { runTurn, resetHistory } = await import('./agent.js')
  const model = scriptedModel(config, fake.fetch)
  resetHistory()
  const asked = []
  model.next = [['calendar_delete', { event_id: 'evallday1', confirmed: true, approved: true, notify: 'all' }]]
  await runTurn('תמחק את הטיול', { source: 'whatsapp', confirm: async (q) => (asked.push(q), false), say: async () => {} })
  ok(asked.length === 1 && !deleted.has('evallday1') && model.toolResults().some((t) => /\[declined\]/.test(t)), 'agent loop: confirmed=true from the model does not delete; the owner is asked and said no')
  model.next = [['calendar_delete', { event_id: 'evallday1' }]]
  await runTurn('כן תמחק', { source: 'whatsapp', confirm: async () => true, say: async () => {} })
  ok(deleted.has('evallday1') && model.toolResults().some((t) => /\[done\]/.test(t)), 'agent loop: with the owner\'s yes the registered path deletes it')
}

// ---- the question shows full start AND end, as sent (review: an end moved by 3 days read as unchanged) ----
{
  const fresh = (id, over = {}) => (events[id] = { id, etag: `e-${id}`, status: 'confirmed', summary: 'סקירה', start: { dateTime: '2026-11-20T10:00:00+02:00', timeZone: tz }, end: { dateTime: '2026-11-20T11:00:00+02:00', timeZone: tz }, organizer: { email: 'me@example.com', self: true }, ...over })
  fresh('evreview1')
  const r = await run('calendar_update', { event_id: 'evreview1', end: '2026-11-23T11:00' }, [true])
  const sent = patches.at(-1)
  ok(r.status === 'done' && sent.body.end.dateTime === '2026-11-23T11:00:00' && sent.body.start.dateTime === '2026-11-20T10:00:00', `the reviewer's end-only change is sent as asked (${r.status})`)
  ok(/זמן עכשיו:\* מ-2026-11-20 10:00 .*עד 2026-11-20 11:00.*משך 1 שעות/.test(r.asked[0]) && /זמן חדש:\* מ-2026-11-20 10:00 .*עד 2026-11-23 11:00.*משך 3 ימים ו-1 שעות/.test(r.asked[0]), `the question shows the new end date and the 3-day duration (${r.asked[0].split('\n').filter((l) => /זמן/.test(l)).join(' | ')})`)
  ok(/UTC\+02:00/.test(r.asked[0]), 'each time carries its UTC offset')

  // Across the end of summer time (Asia/Jerusalem, 25 Oct 2026): two different offsets, true duration.
  fresh('evreview2')
  const d = await run('calendar_update', { event_id: 'evreview2', start: '2026-10-24T22:00', end: '2026-10-25T03:00' }, [false])
  ok(/מ-2026-10-24 22:00 \(Asia\/Jerusalem UTC\+03:00\) עד 2026-10-25 03:00 \(UTC\+02:00\), משך 6 שעות/.test(d.asked[0]), `across a DST change the offsets and real duration are shown (${d.asked[0].split('\n').find((l) => /זמן חדש/.test(l))})`)

  // All-day: first and last day inclusive and the count; what is sent is the exclusive end date.
  fresh('evreview3')
  const a = await run('calendar_update', { event_id: 'evreview3', all_day: true, start: '2026-11-20', end: '2026-11-22' }, [true])
  ok(/זמן חדש:\* 2026-11-20 עד 2026-11-22 כולל \(כל היום, 3 ימים\)/.test(a.asked[0]) && patches.at(-1).body.end.date === '2026-11-23' && patches.at(-1).body.start.date === '2026-11-20', 'all-day: inclusive days and count are shown; the exclusive end is sent')

  // A zone change: the new zone and its offset are shown.
  fresh('evreview4')
  const z = await run('calendar_update', { event_id: 'evreview4', start: '2026-11-20T10:00', time_zone: 'Europe/London' }, [false])
  ok(/זמן חדש:\* מ-2026-11-20 10:00 \(Europe\/London UTC\+00:00\) עד 2026-11-20 11:00/.test(z.asked[0]) && /זמן עכשיו:\* מ-2026-11-20 10:00 \(Asia\/Jerusalem UTC\+02:00\)/.test(z.asked[0]), 'a time zone change shows both zones and offsets')

  // One occurrence of a series: its own full dates.
  const i = await run('calendar_update', { event_id: 'evseries1_20261123T080000Z', scope: 'instance', end: '2026-11-23T12:30' }, [false])
  ok(/זמן חדש:\* מ-2026-11-23 11:00 .*עד 2026-11-23 12:30.*משך 1 שעות ו-30 דקות/.test(i.asked[0]), `an occurrence shows its full dates and new duration (${i.status})`)

  // The same time again is flagged.
  fresh('evreview5')
  const same = await run('calendar_update', { event_id: 'evreview5', end: '2026-11-20T11:00' }, [false])
  ok(/זהה לזמן הנוכחי/.test(same.asked[0]), 'a "change" to the same time is flagged')
}

done('calendar-plus')
