// Handing a recovery notice ("some messages may not have been answered", "the Instinct conversation was cut off")
// to notify in a way a crash or a full queue cannot turn into silence:
// 1. the attempt is counted and saved first, so a restart knows a notice was attempted but maybe not accepted;
// 2. notify is called with a key per attempt (base-t1, base-t2…), so a new attempt is never swallowed by notify's
//    dedup of an older attempt that did not get through;
// 3. after notify returned, the record is 'handed', with the route it took: 'outbox' (queued to be sent) or 'noted'
//    (notify kept it for the next brief, or the owner muted that kind). A throw leaves it open for the next pass.
// 4. settle() then needs positive evidence: an outbox notice counts as delivered only once the outbox recorded it as
//    sent (state.outboxSent, src/outbox.js). If the outbox pushed it out unsent (state.outboxEvicted), or it is in
//    neither list nor still queued, the record is opened again and the next pass sends a new attempt.
// An attempt is not a delivery. The cost of being sure is that the same notice can arrive twice (a crash between
// send and save, or a reopened attempt); never none. Nothing here replays the message or action a notice is about.
import { state } from './store.js'

export const isOpen = (r) => !r.state || r.state === 'needs_recovery'
export const isDelivered = (r) => r.state === 'delivered'

export function handOff(record, base, text, notify, save) {
  record.attempts = (record.attempts || 0) + 1
  const key = `${base}-t${record.attempts}`
  save()
  try {
    const p = notify(text, false, key, 'recovery')
    Promise.resolve(p).catch((e) => console.log(`[recovery] ${e?.message || e}`))
  } catch (e) {
    console.log(`[recovery] notice not accepted yet: ${e?.message || e}`)
    return false
  }
  // outbox.notify pushes before it awaits anything, so a queued notice is visible here.
  const queued = (state.outbox || []).some((o) => o.key === key)
  Object.assign(record, { state: 'handed', handedKey: key, handedAt: Date.now(), route: queued ? 'outbox' : 'noted' })
  if (!queued) record.state = 'delivered' // the brief notes are saved by notify itself; a mute is the owner's choice
  save()
  return true
}

// Moves a handed record on, from what the outbox recorded. Returns true when it changed.
export function settle(record) {
  if (record.state !== 'handed' || record.route !== 'outbox') return false
  const key = record.handedKey
  if ((state.outboxSent || []).includes(key)) {
    record.state = 'delivered'
    record.deliveredAt = Date.now()
    return true
  }
  if ((state.outbox || []).some((o) => o.key === key)) return false // still waiting to be sent
  // Pushed out unsent, or no trace at all: not delivered. Open again; the next pass makes a new attempt.
  record.state = 'needs_recovery'
  record.reopened = (record.reopened || 0) + 1
  record.lastLoss = (state.outboxEvicted || []).includes(key) ? 'evicted' : 'unknown'
  return true
}
