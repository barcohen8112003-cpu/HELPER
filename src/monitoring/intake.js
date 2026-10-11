// EventIntake: every source is turned into the same shape before anything looks at it.
//   Event { id, source, occurred_at, title, body, metadata }
// `id` is stable for the life of the item at its source, which is what lets a repeat be recognised.
// How an item was found (a push, a poll every few minutes, a diff) is not part of the event.
import { config } from '../config.js'
import { iso } from './state.js'

// Gmail: the message id. IMAP: UIDVALIDITY plus UID, since a UID alone is only unique within one validity period.
export function mailEvent(mail) {
  return {
    id: mail.id ? `gmail:${mail.account}:${mail.id}` : `imap:${mail.account}:${mail.uidValidity ?? 0}:${mail.uid}`,
    source: `mail/${mail.account}`,
    occurred_at: iso(mail.ms ? new Date(mail.ms) : new Date()),
    title: mail.subject || '(בלי נושא)',
    body: mail.text || '',
    metadata: { from: mail.from || '' },
  }
}

// The event's id plus its start time, so a moved event counts as a new event and an untouched one does not.
export function calendarEvent(e) {
  return {
    id: `calendar:${e.uid}:${new Date(e.start).getTime()}`,
    source: e.account ? `calendar/${e.account}` : 'calendar',
    occurred_at: iso(new Date()),
    title: `${e.title} - ${e.when}`,
    body: e.location ? `מיקום: ${e.location}` : '',
    metadata: { start: new Date(e.start).toISOString() },
  }
}

// True the first time a watch meets this id, false ever after. The list is capped so the file stays small.
export function firstSight(watch, id) {
  if (watch.seen_event_ids.includes(id)) return false
  watch.seen_event_ids = [...watch.seen_event_ids, id].slice(-config.watch.seenCap)
  return true
}
