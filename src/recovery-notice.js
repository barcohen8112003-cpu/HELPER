// Handing a recovery notice ("some messages may not have been answered", "the Instinct conversation was cut off")
// to notify in a way a crash cannot turn into silence:
// 1. the attempt is counted and saved first, so a restart knows a notice was attempted but maybe not accepted;
// 2. notify is called with a key per attempt (base-t1, base-t2…). notify's own dedup then protects one attempt,
//    and a new attempt after a crash is not swallowed by the key of one that never reached the outbox;
// 3. only after notify returned without throwing is the record marked handed (it now sits in the outbox, the brief
//    notes, or was muted by the owner), and saved.
// An attempt is not a delivery: a record stays open until step 3. The worst case of a crash between 2 and 3 is the
// same notice twice, never none. Nothing here replays the message or action the notice is about.
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
  record.state = 'handed'
  record.handedKey = key
  record.handedAt = Date.now()
  save()
  return true
}
