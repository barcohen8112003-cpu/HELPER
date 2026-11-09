// A WhatsApp message that is meant for the assistant (the owner's chat, Instinct's number) is written down here,
// metadata only (id, time), in the same save that marks it as seen. It leaves this list only when it reached a
// durable receipt (the inbox ledger, src/inbox.js, saved) or was handled to the end (a command answered at once).
//
// Why: the seen list stops WhatsApp from delivering a message twice, so a crash between "seen" and the inbox entry
// used to lose the message in silence. Now whatever was still in flight when the process stopped, or got stuck for
// STUCK_MS in this run, moves to `recovery` and the owner hears once that some messages may not have been answered.
// Nothing is answered again or replayed: an answer may already have left before the crash.
//
// Pure: callers pass state.wa and state.inbox, and save.
export const MAX_ACTIVE = 200 // more than this in flight at once: the oldest move to recovery, they are not dropped
export const MAX_RECOVERY = 500 // only entries the owner was already told about are trimmed past this
export const STUCK_MS = 10 * 60000

const lists = (wa) => {
  wa.inflight = Array.isArray(wa.inflight) ? wa.inflight : []
  wa.recovery = Array.isArray(wa.recovery) ? wa.recovery : []
  return wa
}

function toRecovery(wa, entries, incident) {
  for (const e of entries) wa.recovery.push({ id: e.id, at: e.at, incident, state: 'needs_recovery', noticed: false })
  // Trim only what the owner was already told about; a record still waiting for its notice is never dropped.
  while (wa.recovery.length > MAX_RECOVERY) {
    const i = wa.recovery.findIndex((r) => r.noticed)
    if (i < 0) break
    wa.recovery.splice(i, 1)
  }
}

// A message for the assistant arrived. Called before it is marked seen, and saved with it.
export function track(wa, id, at = Date.now(), now = Date.now()) {
  lists(wa)
  if (!id || wa.inflight.some((e) => e.id === id)) return
  wa.inflight.push({ id, at })
  if (wa.inflight.length > MAX_ACTIVE) toRecovery(wa, wa.inflight.splice(0, wa.inflight.length - MAX_ACTIVE), `overflow-${now}`)
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
// only entries older than `olderThanMs` (stuck in this run). An entry whose id already has an inbox receipt is just
// released: the inbox watchdog already covers it. Returns the number moved to recovery.
export function strand(wa, { inbox = [], all = false, olderThanMs = STUCK_MS, now = Date.now(), incident = `${all ? 'boot' : 'stuck'}-${now}` } = {}) {
  lists(wa)
  const old = wa.inflight.filter((e) => all || now - e.at >= olderThanMs)
  if (!old.length) return 0
  const receipted = new Set(inbox.map((e) => e.id))
  wa.inflight = wa.inflight.filter((e) => !old.includes(e))
  const lost = old.filter((e) => !receipted.has(e.id))
  toRecovery(wa, lost, incident)
  return lost.length
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })

// One notice per incident, no message text (none was kept). Marks them noticed; the caller queues the notice with
// the returned key, so a repeated pass or a restart does not announce the same incident twice.
export function recoveryNotices(wa) {
  lists(wa)
  const byIncident = new Map()
  for (const r of wa.recovery) if (!r.noticed) byIncident.set(r.incident, [...(byIncident.get(r.incident) || []), r])
  const out = []
  for (const [incident, rs] of byIncident) {
    rs.forEach((r) => (r.noticed = true))
    const n = rs.length
    const times = [...new Set(rs.map((r) => hhmm(r.at)))].slice(0, 5).join(', ')
    const what = n === 1 ? `הודעה אחת שלך (מ-${times}) הייתה` : `${n} הודעות שלך (מ-${times}) היו`
    const when = incident.startsWith('boot') ? 'כשנכביתי' : 'לפני כמה דקות'
    out.push({ key: `inflight-recovery-${incident}`, text: `${when}, ${what} באמצע טיפול. ייתכן ש${n === 1 ? 'היא נענתה' : 'חלקן נענו'} וייתכן ש${n === 1 ? 'לא' : 'חלקן לא'}. אם משהו חשוב לא קיבל מענה, שלח אותו שוב.` })
  }
  return out
}
