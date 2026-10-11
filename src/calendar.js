import ical from 'node-ical'
import { config, calendarEnabled } from './config.js'
import { googleAccounts, googleEnabled, googleEvents } from './google.js'

export const calendarOn = () => calendarEnabled() || googleEnabled()

const fmt = (d) => d.toLocaleString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })

async function icsEvents(days) {
  const data = await ical.async.fromURL(config.calendarUrl)
  const from = new Date()
  const to = new Date(from.getTime() + days * 86400000)
  const events = []
  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT') continue
    const starts = ev.rrule ? ev.rrule.between(from, to, true) : [ev.start]
    for (const start of starts) {
      if (!start || start < from || start > to) continue
      events.push({ uid: ev.uid || `${ev.summary}|${ev.start}`, start, title: ev.summary || '', location: ev.location || '' })
    }
  }
  return events
}

// Events in the next `days` from the iCal URL and every connected Google account, sorted.
// Every occurrence of a recurring event shares its uid. A source that fails is logged and skipped.
export async function listEvents(days, accounts = googleAccounts()) {
  const sources = [...(calendarEnabled() ? [icsEvents(days)] : []), ...accounts.map((a) => googleEvents(a, days))]
  const results = await Promise.allSettled(sources)
  for (const r of results) if (r.status === 'rejected') console.log(`[calendar] ${r.reason.message}`)
  return results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .sort((a, b) => a.start - b.start)
    .map((e) => ({ ...e, when: fmt(e.start) }))
}

export async function upcomingEvents(days = 7, accounts) {
  return (await listEvents(days, accounts)).map(({ when, title, location, account }) => ({ when, title, location, ...(account && { account }) }))
}
