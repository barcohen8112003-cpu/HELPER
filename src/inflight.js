// A WhatsApp message that is meant for the assistant (the owner's chat, Instinct's number) is written down here,
// metadata only (id, when it was written, when it reached us), in the same save that marks it as seen. It leaves
// this list only when it reached a durable receipt (the inbox ledger, src/inbox.js, saved) or was handled to the
// end (a command answered at once).
//
// Why: the seen list stops WhatsApp from delivering a message twice, so a crash between "seen" and the inbox entry
// used to lose the message in silence. Now whatever was still in flight when the process stopped, or got stuck for
// STUCK_MS in this run, moves to `recovery` (one incident per event, each with its own id) and the owner hears
// once that some messages may not have been answered. Nothing is answered again or replayed.
//
// Keeping the metadata: every stranded entry stays recoverable, in state or in an append-only archive file
// (data/inflight-archive.jsonl: incident, id, sentAt, receivedAt; no message text). State stays bounded: at most
// MAX_INCIDENTS incidents with at most MAX_ITEMS entries each; what does not fit is written to the archive first and
// only then taken out of state. If the archive cannot be written, nothing is taken out (state grows instead, and the
// log says so) until it can. The archive is never trimmed or deleted by Helper: removing it is the owner's call.
//
// A notice is consumed only when there is positive evidence it was delivered (src/recovery-notice.js).
//
// Limits, not a no-loss promise: this covers the window between "seen" and the inbox receipt. The inbox keeps its
// own last 50 entries (KEEP in src/inbox.js), and what happens after the receipt is the queue's and the watchdog's.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'
import { handOff, settle, isOpen, isDelivered } from './recovery-notice.js'

export const MAX_ACTIVE = 200 // more than this in flight at once: the oldest move to recovery, they are not dropped
export const MAX_INCIDENTS = 50
export const MAX_ITEMS = 50 // entries kept in state per incident; the rest are in the archive
export const STUCK_MS = 10 * 60000
export const ARCHIVE = () => path.join(DATA_DIR, 'inflight-archive.jsonl')

// Writes lines to the archive and makes sure they are on disk. Returns false on any error. Tests can swap it.
const realWriter = (lines) => {
  try {
    const fd = fs.openSync(ARCHIVE(), 'a')
    try {
      fs.writeSync(fd, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    return true
  } catch (e) {
    console.log(`[inflight] archive not written, keeping the entries in state: ${e.message}`)
    return false
  }
}
let writeArchive = realWriter
export const _setArchiveWriter = (fn) => (writeArchive = fn || realWriter)

const lists = (wa) => {
  wa.inflight = Array.isArray(wa.inflight) ? wa.inflight : []
  wa.recovery = Array.isArray(wa.recovery) ? wa.recovery : []
  return wa
}
// Entries saved by an older build had one `at`.
const sentOf = (e) => e.sentAt ?? e.at ?? 0
const receivedOf = (e) => e.receivedAt ?? e.at ?? 0
const item = (e) => ({ id: e.id, sentAt: sentOf(e), receivedAt: receivedOf(e) })
const itemsOf = (r) => r.items || (r.ids || []).map((id) => ({ id, sentAt: r.firstSentAt, receivedAt: r.firstSentAt }))

// Unique per state, even for two incidents in the same millisecond.
function incidentId(wa, kind, now) {
  wa.recoverySeq = (wa.recoverySeq || 0) + 1
  return `${kind}-${now}-${wa.recoverySeq}`
}

// Moves a record's entries beyond `keep` to the archive. Returns false (and changes nothing) if the archive failed.
function spill(r, keep = MAX_ITEMS) {
  const items = itemsOf(r)
  if (items.length <= keep) return true
  const out = items.slice(keep)
  if (!writeArchive(out.map((x) => ({ incident: r.incident, ...x })))) return false
  r.items = items.slice(0, keep)
  delete r.ids
  r.archived = (r.archived || 0) + out.length
  return true
}

function addIncident(wa, entries, kind, now) {
  if (!entries.length) return null
  const items = entries.map(item)
  const r = {
    incident: incidentId(wa, kind, now),
    state: 'needs_recovery',
    count: items.length,
    firstSentAt: Math.min(...items.map((x) => x.sentAt)),
    lastSentAt: Math.max(...items.map((x) => x.sentAt)),
    items,
    archived: 0,
    attempts: 0,
  }
  wa.recovery.push(r)
  spill(r)
  bound(wa)
  return r
}

// Keeps the incident list bounded. A delivered incident is archived in full and then taken out of state. Otherwise
// the two oldest open ones are merged (counts add up, entries over MAX_ITEMS go to the archive). An incident whose
// notice is handed but not yet delivered is never taken out. If the archive fails, the list is left as it is.
function bound(wa) {
  while (wa.recovery.length > MAX_INCIDENTS) {
    const i = wa.recovery.findIndex(isDelivered)
    if (i >= 0) {
      const r = wa.recovery[i]
      const rest = itemsOf(r).map((x) => ({ incident: r.incident, ...x }))
      if (!writeArchive([...rest, { incident: r.incident, closed: true, count: r.count, handedKey: r.handedKey, deliveredAt: r.deliveredAt || null }])) return
      wa.recovery.splice(i, 1)
      continue
    }
    const open = wa.recovery.map((r, j) => [r, j]).filter(([r]) => isOpen(r))
    if (open.length < 2) return // the rest is handed and waiting for delivery evidence
    const [[a, ai], [b]] = open
    const merged = { ...b, items: [...itemsOf(a), ...itemsOf(b)], count: a.count + b.count }
    merged.firstSentAt = Math.min(a.firstSentAt, b.firstSentAt)
    merged.lastSentAt = Math.max(a.lastSentAt, b.lastSentAt)
    merged.archived = (a.archived || 0) + (b.archived || 0)
    merged.mergedFrom = [...(b.mergedFrom || []), a.incident, ...(a.mergedFrom || [])].slice(-20)
    delete merged.ids
    if (!spill(merged)) return
    wa.recovery.splice(ai, 1)
    wa.recovery[wa.recovery.indexOf(b)] = merged
  }
}

// A message for the assistant arrived. Called before it is marked seen, and saved with it.
// sentAt: when it was written (for the notice). receivedAt: when this run got it (for "stuck"), so a message
// written hours ago and caught up after a restart is not taken as stuck the moment it arrives.
export function track(wa, id, sentAt = Date.now(), receivedAt = Date.now()) {
  lists(wa)
  if (!id || wa.inflight.some((e) => e.id === id)) return
  wa.inflight.push({ id, sentAt, receivedAt })
  if (wa.inflight.length > MAX_ACTIVE) addIncident(wa, wa.inflight.splice(0, wa.inflight.length - MAX_ACTIVE), 'overflow', receivedAt)
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
export function strand(wa, { inbox = [], all = false, olderThanMs = STUCK_MS, now = Date.now() } = {}) {
  lists(wa)
  const old = wa.inflight.filter((e) => all || now - receivedOf(e) >= olderThanMs)
  if (!old.length) return 0
  const receipted = new Set(inbox.map((e) => e.id))
  wa.inflight = wa.inflight.filter((e) => !old.includes(e))
  const lost = old.filter((e) => !receipted.has(e.id))
  addIncident(wa, lost, all ? 'boot' : 'stuck', now)
  return lost.length
}

// Updates handed incidents from the outbox's record of what it sent or pushed out. Returns whether any changed.
export function reconcile(wa) {
  lists(wa)
  let changed = false
  for (const r of wa.recovery) if (settle(r)) changed = true
  if (changed) bound(wa)
  return changed
}

// Open incidents (stranded, overflowed, attempted but not accepted, or reopened) waiting for their notice.
export const pendingNotices = (wa) => lists(wa).recovery.filter(isOpen).length

// Every id that was stranded and is still recoverable: in state, or in the archive. For checks and for the owner.
export function recoverableIds(wa, file = ARCHIVE()) {
  const ids = new Set()
  for (const r of lists(wa).recovery) for (const x of itemsOf(r)) ids.add(x.id)
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {}
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const x = JSON.parse(line)
      if (x.id) ids.add(x.id)
    } catch {}
  }
  return ids
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })

export function noticeText(r) {
  const n = r.count
  const times = r.firstSentAt === r.lastSentAt ? hhmm(r.firstSentAt) : `${hhmm(r.firstSentAt)} עד ${hhmm(r.lastSentAt)}`
  const what = n === 1 ? `הודעה אחת שלך (מ-${times}) הייתה` : `${n} הודעות שלך (מ-${times}) היו`
  const when = r.incident.startsWith('boot') && !r.mergedFrom ? 'כשנכביתי' : 'לאחרונה'
  return `${when}, ${what} באמצע טיפול. ייתכן ש${n === 1 ? 'היא נענתה' : 'חלקן נענו'} וייתכן ש${n === 1 ? 'לא' : 'חלקן לא'}. אם משהו חשוב לא קיבל מענה, שלח אותו שוב.`
}

// Hands every open incident's notice to notify (one per incident, no message text: none was kept).
// Returns how many were handed.
export function flushRecovery(wa, notify, save) {
  lists(wa)
  let handed = 0
  for (const r of wa.recovery.filter(isOpen)) if (handOff(r, `inflight-recovery-${r.incident}`, noticeText(r), notify, save)) handed++
  return handed
}
