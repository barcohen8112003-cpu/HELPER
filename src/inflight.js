// A WhatsApp message that is meant for the assistant (the owner's chat, Instinct's number) is written down here,
// metadata only (id, when it was written, when it reached us), in the same save that marks it as seen. It leaves
// this list only when it reached a durable receipt (the inbox ledger, src/inbox.js, saved) or was handled to the
// end (a command answered at once).
//
// Why: the seen list stops WhatsApp from delivering a message twice, so a crash between "seen" and the inbox entry
// used to lose the message in silence. Now whatever was still in flight when the process stopped, or got stuck for
// STUCK_MS in this run, moves to `recovery` (grouped by incident) and the owner hears once that some messages may
// not have been answered. Nothing is answered again or replayed: an answer may already have left before the crash.
//
// A recovery incident is consumed only after its notice was handed to notify (handOff, src/recovery-notice.js):
// the attempt is saved first, and a notice that was attempted but not accepted is attempted again, never dropped.
//
// Limits, not a no-loss promise: this covers the window between "seen" and the inbox receipt. The inbox keeps its
// own last 50 entries (KEEP in src/inbox.js), and what happens after the receipt is the queue's and the watchdog's.
//
// Pure apart from the notice hand-off: callers pass state.wa and state.inbox, and save.
import { handOff } from './recovery-notice.js'

export const MAX_ACTIVE = 200 // more than this in flight at once: the oldest move to recovery, they are not dropped
export const MAX_INCIDENTS = 50 // past this, delivered incidents are trimmed first, then the oldest open ones merged
export const MAX_IDS = 50 // ids listed per incident; beyond that they are counted (idsOmitted), never uncounted
export const STUCK_MS = 10 * 60000

const lists = (wa) => {
  wa.inflight = Array.isArray(wa.inflight) ? wa.inflight : []
  wa.recovery = Array.isArray(wa.recovery) ? wa.recovery : []
  return wa
}
// Entries saved by an older version had one `at`.
const sentOf = (e) => e.sentAt ?? e.at ?? 0
const receivedOf = (e) => e.receivedAt ?? e.at ?? 0

const open = (r) => r.state !== 'handed'
// Handed and no longer waiting in the outbox: the notice left (or went into a brief). Only these may be trimmed.
const delivered = (r, outbox) => !open(r) && !(outbox || []).some((o) => o.key && o.key === r.handedKey)

function addIncident(wa, entries, incident, outbox) {
  if (!entries.length) return
  const ids = entries.map((e) => e.id)
  wa.recovery.push({
    incident,
    state: 'needs_recovery',
    count: entries.length,
    firstSentAt: Math.min(...entries.map(sentOf)),
    lastSentAt: Math.max(...entries.map(sentOf)),
    ids: ids.slice(0, MAX_IDS),
    idsOmitted: Math.max(0, ids.length - MAX_IDS),
    attempts: 0,
  })
  bound(wa, outbox)
}

// Keeps the list bounded without losing what the owner was not yet told: delivered incidents go first; then the two
// oldest open ones are merged, so their count adds up and the notice still covers them.
function bound(wa, outbox) {
  while (wa.recovery.length > MAX_INCIDENTS) {
    const i = wa.recovery.findIndex((r) => delivered(r, outbox))
    if (i >= 0) {
      wa.recovery.splice(i, 1)
      continue
    }
    const openOnes = wa.recovery.map((r, j) => [r, j]).filter(([r]) => open(r))
    if (openOnes.length < 2) break // the rest is handed and still in the outbox; the outbox has its own cap
    const [[a, ai], [b]] = openOnes
    b.count += a.count
    b.firstSentAt = Math.min(a.firstSentAt, b.firstSentAt)
    b.lastSentAt = Math.max(a.lastSentAt, b.lastSentAt)
    const ids = [...a.ids, ...b.ids]
    b.ids = ids.slice(0, MAX_IDS)
    b.idsOmitted = (a.idsOmitted || 0) + (b.idsOmitted || 0) + Math.max(0, ids.length - MAX_IDS)
    b.merged = (b.merged || 0) + 1 + (a.merged || 0)
    wa.recovery.splice(ai, 1)
  }
}

// A message for the assistant arrived. Called before it is marked seen, and saved with it.
// sentAt: when it was written (for the notice). receivedAt: when this run got it (for "stuck"), so a message
// written hours ago and caught up after a restart is not taken as stuck the moment it arrives.
export function track(wa, id, sentAt = Date.now(), receivedAt = Date.now(), outbox) {
  lists(wa)
  if (!id || wa.inflight.some((e) => e.id === id)) return
  wa.inflight.push({ id, sentAt, receivedAt })
  if (wa.inflight.length > MAX_ACTIVE) addIncident(wa, wa.inflight.splice(0, wa.inflight.length - MAX_ACTIVE), `overflow-${receivedAt}`, outbox)
}

// It reached a durable receipt, or was handled to the end. Returns whether anything changed.
export function release(wa, id) {
  lists(wa)
  const i = wa.inflight.findIndex((e) => e.id === id)
  if (i < 0) return false
  wa.inflight.splice(i, 1)
  return true
}

// Moves what is stranded to recovery. `all`: at start, everything still listed is from the last run. Otherwise
// only entries this run received more than `olderThanMs` ago. An entry whose id already has an inbox receipt is
// just released: the inbox watchdog covers it. Returns the number of entries moved to recovery.
export function strand(wa, { inbox = [], outbox, all = false, olderThanMs = STUCK_MS, now = Date.now(), incident = `${all ? 'boot' : 'stuck'}-${now}` } = {}) {
  lists(wa)
  const old = wa.inflight.filter((e) => all || now - receivedOf(e) >= olderThanMs)
  if (!old.length) return 0
  const receipted = new Set(inbox.map((e) => e.id))
  wa.inflight = wa.inflight.filter((e) => !old.includes(e))
  const lost = old.filter((e) => !receipted.has(e.id))
  addIncident(wa, lost, incident, outbox)
  return lost.length
}

// Open incidents (stranded, overflowed, or attempted but not accepted) waiting for their notice.
export const pendingNotices = (wa) => lists(wa).recovery.filter(open).length

const hhmm = (ms) => new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })

export function noticeText(r) {
  const n = r.count
  const times = r.firstSentAt === r.lastSentAt ? hhmm(r.firstSentAt) : `${hhmm(r.firstSentAt)} עד ${hhmm(r.lastSentAt)}`
  const what = n === 1 ? `הודעה אחת שלך (מ-${times}) הייתה` : `${n} הודעות שלך (מ-${times}) היו`
  const when = r.incident.startsWith('boot') && !r.merged ? 'כשנכביתי' : 'לאחרונה'
  return `${when}, ${what} באמצע טיפול. ייתכן ש${n === 1 ? 'היא נענתה' : 'חלקן נענו'} וייתכן ש${n === 1 ? 'לא' : 'חלקן לא'}. אם משהו חשוב לא קיבל מענה, שלח אותו שוב.`
}

// Hands every open incident's notice to notify (one per incident, no message text: none was kept). An incident
// counts as told only once notify accepted it; a throw leaves it open for the next pass. Returns how many were handed.
export function flushRecovery(wa, notify, save) {
  lists(wa)
  let handed = 0
  for (const r of wa.recovery.filter(open)) if (handOff(r, `inflight-recovery-${r.incident}`, noticeText(r), notify, save)) handed++
  return handed
}
