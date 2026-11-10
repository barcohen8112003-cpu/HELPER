// Offline checks for the in-flight list (src/inflight.js) and how whatsapp.js / index.js use it: a message meant for
// the assistant is listed (id and time only) in the same save that marks it seen, leaves the list only after a
// durable inbox receipt or the end of its handling, and whatever a stop or a throw strands reaches the owner once,
// with no message text and nothing answered again.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.HELPER_ENV_FILE = '/nonexistent/.env'
process.env.HELPER_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'inflight-'))
const inflight = await import('./inflight.js')
const inbox = await import('./inbox.js')

let passed = 0
const failed = []
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed.push(name)
    console.log(`FAIL ${name}`)
  }
}

const now = Date.now()
const has = (name) => typeof inflight[name] === 'function'
const saves = []
const save = () => saves.push(1)
const flush = (wa, notify) => (has('flushRecovery') ? inflight.flushRecovery(wa, notify, save) : 0)
const collect = () => {
  const out = []
  return Object.assign((text, urgent, key) => (out.push({ text, key }), Promise.resolve()), { out })
}
const { state } = await import('./store.js')
const { createOutbox } = await import('./outbox.js')
const archiveFile = () => (has('ARCHIVE') ? inflight.ARCHIVE() : path.join(process.env.HELPER_DATA_DIR, 'inflight-archive.jsonl'))
const freshArchive = () => fs.rmSync(archiveFile(), { force: true })
const recoverable = (wa) => (has('recoverableIds') ? inflight.recoverableIds(wa) : new Set((wa.recovery || []).flatMap((r) => r.items?.map((x) => x.id) || r.ids || [])))
const idsInState = (r) => (r.items || []).map((x) => x.id).concat(r.ids || [])
// A real outbox over the real store. Owner offline: nothing is sent, everything waits in state.outbox.
function realOutbox(sendImpl = async () => {}) {
  state.outbox = []
  state.sentKeys = []
  state.outboxSent = []
  state.outboxEvicted = []
  state.owner = null
  const ob = createOutbox(sendImpl)
  return { ob, notify: (text, urgent, key) => ob.notify(text, urgent, key) }
}

// Track and release.
let wa = { seen: [], lastAt: 0 }
inflight.track(wa, 'A', now - 1000, now)
inflight.track(wa, 'A', now - 1000, now)
ok(wa.inflight.length === 1 && wa.inflight[0].id === 'A' && Object.keys(wa.inflight[0]).sort().join() === 'id,receivedAt,sentAt', 'track: id and two times only, once')
ok(inflight.release(wa, 'A') && wa.inflight.length === 0, 'release removes it')
ok(!inflight.release(wa, 'A'), 'release of an unknown id changes nothing')

// Boot: everything left is from the last run, even a few seconds old. With an inbox receipt it is just released
// (the inbox watchdog covers it); without one it moves to recovery.
wa = { seen: ['B', 'C'], lastAt: 0 }
inflight.track(wa, 'B', now - 5000, now - 5000) // crashed between seen and the inbox entry
inflight.track(wa, 'C', now - 5000, now - 5000) // crashed after the receipt, before the release
const list = inbox.received([], 'C', 'שלום', now - 5000)
const moved = inflight.strand(wa, { inbox: list, all: true, now })
ok(moved === 1 && wa.inflight.length === 0, 'boot: a stranded message under a minute old still reaches recovery')
ok(wa.recovery.length === 1 && idsInState(wa.recovery[0])[0] === 'B' && wa.recovery[0].count === 1 && wa.recovery[0].state === 'needs_recovery', 'boot: only the one without a receipt needs recovery')
ok(wa.seen.includes('B'), 'boot: seen is untouched, so a redelivery is still not processed twice')

// One notice per incident, keyed, no text, says "maybe", never replays.
let n1 = collect()
flush(wa, n1)
ok(n1.out.length === 1 && /^inflight-recovery-boot-/.test(n1.out[0].key), 'notice: one, with a stable key')
ok(/ייתכן/.test(n1.out[0]?.text || '') && /שלח אותו שוב/.test(n1.out[0]?.text || '') && !/שלום/.test(n1.out[0]?.text || ''), 'notice: says maybe answered, asks to resend, quotes nothing')
flush(wa, n1)
ok(n1.out.length === 1, 'notice: a second pass says nothing')

// Durable hand-off: notify throws (as on a boot that calls it too early): the incident stays open, and the next
// pass sends it with a new attempt key.
wa = { seen: [], lastAt: 0 }
inflight.track(wa, 'J', now - 5000, now - 5000)
inflight.strand(wa, { all: true, now })
saves.length = 0
let tries = 0
flush(wa, () => {
  tries++
  throw new ReferenceError("Cannot access 'monitoring' before initialization")
})
ok(tries === 1 && has('pendingNotices') && inflight.pendingNotices(wa) === 1, 'durable: not accepted -> still open')
ok(saves.length >= 1 && wa.recovery[0].attempts === 1, 'durable: the attempt is saved before notify is called')
const persisted = JSON.parse(JSON.stringify(wa)) // what a crash right now leaves on disk
n1 = collect()
flush(persisted, n1)
ok(n1.out.length === 1 && /-t2$/.test(n1.out[0].key) && inflight.pendingNotices(persisted) === 0, 'durable: after a restart it is sent with a new attempt key')

// In this run: stuck counts from when this run received it, not from when it was written.
wa = { seen: [], lastAt: 0 }
inflight.track(wa, 'D', now - inflight.STUCK_MS - 1000, now - inflight.STUCK_MS - 1000)
inflight.track(wa, 'E', now - 1000, now - 1000)
inflight.track(wa, 'K', now - 6 * 3600_000, now - 1000) // written 6 hours ago, caught up a second ago
ok(inflight.strand(wa, { now }) === 1 && wa.inflight.map((e) => e.id).join() === 'E,K', 'stuck: only the one received long ago moves; a caught-up old message does not')
n1 = collect()
flush(wa, n1)
ok(n1.out.length === 1 && /לאחרונה/.test(n1.out[0].text), 'stuck: notice words it as recent, not as a restart')

// Overflow: the 201st entry moves the oldest to recovery although strand moved nothing; it is still drained.
wa = { seen: [], lastAt: 0 }
for (let i = 0; i < inflight.MAX_ACTIVE + 1; i++) inflight.track(wa, `F${i}`, now + i, now + i)
ok(wa.inflight.length === inflight.MAX_ACTIVE && wa.recovery.length === 1 && idsInState(wa.recovery[0])[0] === 'F0', 'overflow: oldest moved to recovery, not dropped')
ok(inflight.strand(wa, { now }) === 0 && inflight.pendingNotices(wa) === 1, 'overflow: strand finds nothing new, yet a notice is pending')
n1 = collect()
flush(wa, n1)
ok(n1.out.length === 1 && inflight.pendingNotices(wa) === 0, 'overflow: drained without anything newly stranded')

// ---------- Round 3 ----------

// R1. Same millisecond: 202 eligible messages arrive with one receivedAt, so two overflow incidents are made in the
//     same millisecond. Through the real outbox: two incidents, two different ids, two queued notices.
{
  const { notify } = realOutbox()
  wa = { seen: [], lastAt: 0 }
  const t = now + 1
  for (let i = 0; i < inflight.MAX_ACTIVE + 2; i++) inflight.track(wa, `SAME${i}`, t, t)
  const names = wa.recovery.map((r) => r.incident)
  ok(names.length === 2 && new Set(names).size === 2, `same ms: two incidents with different ids (${names.join(', ')})`)
  flush(wa, notify)
  const keys = state.outbox.map((o) => o.key)
  ok(keys.length === 2 && new Set(keys).size === 2 && wa.recovery.every((r) => r.state === 'handed'), `same ms: two notices queued in the real outbox (${keys.length})`)
  ok(wa.recovery.reduce((a, r) => a + r.count, 0) === 2, 'same ms: each counted once')
}

// R2. Accepted, then pushed out of the real outbox (cap 100) by unrelated notices while the owner is offline: that is
//     not a delivery. The incident is opened again and a new attempt is queued. Unrelated notices keep their contract.
{
  const sentTexts = []
  const { ob, notify } = realOutbox(async (text) => sentTexts.push(text))
  wa = { seen: [], lastAt: 0 }
  inflight.track(wa, 'EVICT', now - 5000, now - 5000)
  inflight.strand(wa, { all: true, now })
  flush(wa, notify)
  const first = wa.recovery[0].handedKey
  ok(state.outbox.some((o) => o.key === first), 'evicted: the notice is queued first')
  for (let i = 0; i < 100; i++) ob.notify(`הודעה כללית ${i}`, false, `general:${i}`)
  ok(state.outbox.length === 100 && !state.outbox.some((o) => o.key === first), 'evicted: the cap pushed it out (outbox at 100)')
  ok(has('reconcile') && inflight.reconcile(wa) && wa.recovery[0].state === 'needs_recovery' && wa.recovery[0].lastLoss === 'evicted', 'evicted: not taken as delivered; opened again')
  ok(inflight.pendingNotices(wa) === 1, 'evicted: pending for retry')
  flush(wa, notify)
  const second = wa.recovery[0].handedKey
  ok(second !== first && /-t2$/.test(second) && state.outbox.some((o) => o.key === second), 'evicted: a new attempt is queued')
  ok(state.outbox.length === 100 && state.outbox[0].key === 'general:1', 'evicted: general notices keep the old contract (oldest pushed out, nothing replayed)')
  // Owner back: the outbox sends; only then is the incident delivered.
  ok(!inflight.reconcile(wa) && wa.recovery[0].state === 'handed', 'evicted: still queued -> still handed, not delivered')
  state.owner = { jid: 'x@s.whatsapp.net' }
  await ob.flush()
  ok(sentTexts.filter((t) => /באמצע טיפול/.test(t)).length === 1, 'evicted: the notice went out once when the owner came back')
  ok(inflight.reconcile(wa) && wa.recovery[0].state === 'delivered', 'evicted: delivered only after the outbox recorded it as sent')
}

// R2b. Crash around the acknowledgement: send accepted, the process dies before the outbox saves. What is on disk
//      still has the notice queued; the next run sends it again (at-least-once), and only that marks it delivered.
{
  let onDisk = null
  const { notify } = realOutbox()
  wa = { seen: [], lastAt: 0 }
  inflight.track(wa, 'ACK', now - 5000, now - 5000)
  inflight.strand(wa, { all: true, now })
  flush(wa, notify)
  const waOnDisk = JSON.parse(JSON.stringify(wa))
  state.owner = { jid: 'x@s.whatsapp.net' }
  const crashing = createOutbox(async () => {
    onDisk = JSON.parse(JSON.stringify({ outbox: state.outbox, outboxSent: state.outboxSent || [] })) // last save before the ack
    throw new Error('process died') // stands in for the crash right after WhatsApp accepted it
  })
  await crashing.flush()
  state.outbox = onDisk.outbox
  state.outboxSent = onDisk.outboxSent
  ok(!inflight.reconcile(waOnDisk) && waOnDisk.recovery[0].state === 'handed', 'ack crash: after restart still handed, not delivered')
  const resent = []
  await createOutbox(async (t) => resent.push(t)).flush()
  ok(resent.length === 1 && inflight.reconcile(waOnDisk) && waOnDisk.recovery[0].state === 'delivered', 'ack crash: sent again on the next run, then delivered')
  state.owner = null
}

// R3. 3000 unresolved entries: every id stays recoverable (state or archive), state stays bounded, no text kept.
{
  freshArchive()
  inflight._setArchiveWriter?.(undefined) // keep the real writer
  wa = { seen: [], lastAt: 0 }
  const all = []
  for (let i = 0; i < 3000; i++) {
    const id = `M${i}`
    all.push(id)
    inflight.track(wa, id, now + i, now + i)
    if (i % 37 === 0) inflight.strand(wa, { now: now + i + inflight.STUCK_MS + 1 })
  }
  inflight.strand(wa, { all: true, now: now + 5000 })
  // Some incidents are delivered (their notice was recorded as sent), so trimming has something to archive.
  const { notify } = realOutbox()
  flush(wa, notify)
  state.outboxSent = state.outbox.map((o) => o.key).slice(0, 20)
  state.outbox = state.outbox.filter((o) => !state.outboxSent.includes(o.key))
  inflight.reconcile(wa)
  for (let i = 0; i < 60; i++) {
    inflight.track(wa, `N${i}`, now + i, now + i)
    inflight.strand(wa, { all: true, now: now + 10_000 + i })
    all.push(`N${i}`)
  }
  const got = has('recoverableIds') ? inflight.recoverableIds(wa) : recoverable(wa)
  const missing = all.filter((id) => !got.has(id))
  ok(missing.length === 0, `3000+: every id recoverable (missing ${missing.length} of ${all.length})`)
  ok(wa.recovery.length <= inflight.MAX_INCIDENTS && wa.recovery.every((r) => idsInState(r).length <= inflight.MAX_ITEMS), `3000+: state bounded (${wa.recovery.length} incidents)`)
  ok(wa.recovery.reduce((a, r) => a + r.count, 0) + archivedClosedCount() === all.length, '3000+: counts add up to every entry')
  const text = fs.existsSync(archiveFile()) ? fs.readFileSync(archiveFile(), 'utf8') : ''
  ok(text.length > 0 && !/שלום|text/.test(text), '3000+: archive holds metadata only')
}
function archivedClosedCount() {
  if (!fs.existsSync(archiveFile())) return 0
  return fs.readFileSync(archiveFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.closed).reduce((a, x) => a + x.count, 0)
}

// R3b. The archive cannot be written: nothing is taken out of state (it grows instead), so nothing is lost; once the
//      archive works again, state goes back under its bounds and everything is still recoverable.
{
  freshArchive()
  wa = { seen: [], lastAt: 0 }
  inflight._setArchiveWriter?.(() => false)
  const all = []
  for (let i = 0; i < 400; i++) {
    inflight.track(wa, `X${i}`, now + i, now + i)
    inflight.strand(wa, { all: true, now: now + i })
    all.push(`X${i}`)
  }
  const inState = new Set(wa.recovery.flatMap(idsInState))
  ok(all.every((id) => inState.has(id)), 'archive error: every id kept in state, none dropped')
  if (has('_setArchiveWriter')) {
    // Back to the real writer; the next incident lets bound() catch up.
    const real = (lines) => (fs.appendFileSync(archiveFile(), lines.map((l) => JSON.stringify(l)).join('\n') + '\n'), true)
    inflight._setArchiveWriter(real)
    inflight.track(wa, 'X-last', now, now)
    inflight.strand(wa, { all: true, now })
    all.push('X-last')
  }
  const got = recoverable(wa)
  ok(all.every((id) => got.has(id)) && wa.recovery.length <= inflight.MAX_INCIDENTS, 'archive error: after it recovers, bounded again and all recoverable')
}

// R3c. Crash after the archive write but before the state save: the ids are in the archive and in the old state;
//      nothing is lost (a reader dedupes by id). Helper never deletes the archive.
{
  freshArchive()
  wa = { seen: [], lastAt: 0 }
  for (let i = 0; i < inflight.MAX_INCIDENTS; i++) {
    inflight.track(wa, `C${i}`, now + i, now + i)
    inflight.strand(wa, { all: true, now: now + i })
  }
  const before = JSON.parse(JSON.stringify(wa))
  inflight.track(wa, 'C-new', now, now)
  inflight.strand(wa, { all: true, now })
  const got = recoverable(before) // the state on disk is the old one; the archive has the new lines
  ok([...Array(inflight.MAX_INCIDENTS).keys()].every((i) => got.has(`C${i}`)), 'crash after archive write: nothing lost')
  const src = fs.readFileSync(new URL('./inflight.js', import.meta.url), 'utf8')
  ok(!/unlinkSync|rmSync|truncate/.test(src), 'the archive is never deleted or trimmed by Helper')
}

// ---------- Round 4 ----------

// R4-1. The outbox shifts while a send is awaited: the first general notice is being sent (deferred), the recovery
//       notice and 99 keyed general notices are queued behind it, the cap pushes the first one out, then the first
//       send resolves and every later send fails. Only what send really accepted may be recorded as sent; the
//       recovery notice must stay queued and pending.
{
  const calls = []
  let release
  const gate = new Promise((r) => (release = r))
  let n = 0
  const { ob, notify } = realOutbox(async (text) => {
    calls.push(text)
    if (++n === 1) return gate // first send waits
    throw new Error('send failed') // every later send fails
  })
  state.owner = { jid: 'x@s.whatsapp.net' }
  const running = ob.notify('GENERAL FIRST', false, 'general:first')
  await new Promise((r) => setTimeout(r, 5))
  wa = { seen: [], lastAt: 0 }
  inflight.track(wa, 'R4', now - 5000, now - 5000)
  inflight.strand(wa, { all: true, now })
  flush(wa, notify)
  const recoveryKey = wa.recovery[0].handedKey
  for (let i = 0; i < 99; i++) ob.notify(`general ${i}`, false, `general:${i}`)
  ok(state.outbox.length === 100 && state.outbox[0].key === recoveryKey, 'shift: the cap pushed the first message out while its send was awaited')
  release()
  await running
  await ob.flush()
  const accepted = calls.slice(0, 1) // only the first send resolved
  ok(accepted[0] === 'GENERAL FIRST', 'shift: the only accepted send was GENERAL FIRST')
  ok(!(state.outboxSent || []).includes(recoveryKey), 'shift: the recovery notice is not recorded as sent')
  ok((state.outboxSent || []).join() === 'general:first', `shift: outboxSent holds exactly what send accepted (${(state.outboxSent || []).join()})`)
  ok(state.outbox.some((o) => o.key === recoveryKey), 'shift: the recovery notice is still queued')
  ok(!inflight.reconcile(wa) && wa.recovery[0].state === 'handed', 'shift: reconcile does not take it as delivered')
  ok(state.outbox.length === 100 && state.outbox.some((o) => o.key === 'general:0'), 'shift: the general notice behind it was not removed in its place')
  // The owner's WhatsApp works again: it goes out, and only then is it delivered.
  const later = []
  await createOutbox(async (t) => later.push(t)).flush()
  ok(later.some((t) => /באמצע טיפול/.test(t)) && inflight.reconcile(wa) && wa.recovery[0].state === 'delivered', 'shift: delivered only after its own send was accepted')
  state.owner = null
}

// R4-2. The archive is written completely or not at all as far as state is concerned.
const realWriteSync = fs.writeSync
// Calls the real writeSync with at most `cap(len)` bytes, for both call forms (buffer+offset, or a string).
const limitedWrite = (cap) => (fd, buf, off, len, ...rest) => {
  if (typeof buf === 'string') {
    const b = Buffer.from(buf, 'utf8')
    return realWriteSync(fd, b, 0, cap(b.length))
  }
  off ??= 0
  len ??= buf.length - off
  return realWriteSync(fd, buf, off, cap(len), ...rest)
}
const strand100 = (prefix) => {
  wa = { seen: [], lastAt: 0 }
  for (let i = 0; i < 100; i++) inflight.track(wa, `${prefix}${i}`, now + i, now + i)
  inflight.strand(wa, { all: true, now })
  return [...Array(100).keys()].map((i) => `${prefix}${i}`)
}
const parsedLines = () => fs.readFileSync(archiveFile(), 'utf8').split('\n').filter(Boolean).map((l) => {
  try {
    return JSON.parse(l)
  } catch {
    return null
  }
})
inflight._setArchiveWriter?.(undefined)

// Short writes (half of what was asked each call, no throw): the writer keeps going until all bytes are written.
{
  freshArchive()
  fs.writeSync = limitedWrite((len) => Math.max(1, Math.floor(len / 2)))
  let all
  try {
    all = strand100('SHORT')
  } finally {
    fs.writeSync = realWriteSync
  }
  const got = recoverable(wa)
  ok(all.every((id) => got.has(id)), `short writes: every id recoverable (${all.filter((id) => got.has(id)).length}/100)`)
  ok(wa.recovery[0].items.length === 50 && wa.recovery[0].archived === 50 && parsedLines().filter((x) => x?.id).length === 50, 'short writes: 50 in state, 50 complete lines in the archive')
}

// Zero progress: treated as failure; nothing leaves state.
{
  freshArchive()
  fs.writeSync = () => 0
  let all
  try {
    all = strand100('ZERO')
  } finally {
    fs.writeSync = realWriteSync
  }
  ok(wa.recovery[0].items.length === 100 && !wa.recovery[0].archived, 'zero write: all 100 stay in state, none marked archived')
  ok(all.every((id) => recoverable(wa).has(id)), 'zero write: every id recoverable')
}

// Error after a partial write: the file is left with a broken last line; state keeps everything; the next archive
// write closes the broken line first, and everything after it reads fine.
{
  freshArchive()
  let calls = 0
  const partial = limitedWrite((len) => Math.min(len, 17))
  fs.writeSync = (...args) => {
    if (++calls === 1) return partial(...args)
    throw new Error('EIO')
  }
  let first
  try {
    first = strand100('PART')
  } finally {
    fs.writeSync = realWriteSync
  }
  const waFirst = wa
  ok(waFirst.recovery[0].items.length === 100 && !fs.readFileSync(archiveFile(), 'utf8').endsWith('\n'), 'error after partial: all in state, archive ends in a broken line')
  const second = strand100('AFTER')
  const got = new Set([...recoverable(waFirst), ...recoverable(wa)])
  ok([...first, ...second].every((id) => got.has(id)), 'error after partial: every id of both batches recoverable')
  ok(parsedLines().filter((x) => x?.id?.startsWith('AFTER')).length === 50, 'error after partial: the next records are whole lines, not glued to the broken one')
}

// A crash left half a line at the end of the archive (restart): the next append starts on a new line.
{
  freshArchive()
  fs.writeFileSync(archiveFile(), '{"incident":"boot-1-1","id":"CRASHED-HALF","sen')
  const all = strand100('TAIL')
  const got = recoverable(wa)
  ok(all.every((id) => got.has(id)) && parsedLines().filter((x) => x?.id?.startsWith('TAIL')).length === 50, 'partial tail: later records stay recoverable')
}

// Old state without the new fields, and entries in the old {id, at} shape, still work.
wa = { seen: ['x'], lastAt: 5, inflight: [{ id: 'old', at: now - 1000 }] }
ok(inflight.strand(wa, { all: true, now }) === 1 && wa.recovery[0].firstSentAt === now - 1000 && wa.seen[0] === 'x', 'old state ({id, at}, no recovery) reads fine')

// Inbox after a restart: an unanswered entry says "maybe", it is never marked answered.
const rs = inbox.received([], 'I', 'מה המצב', now - 10 * 60000)
rs[0].restarted = true
const late = inbox.overdue(rs, { minutes: 5, now })
ok(late.length === 1 && /ייתכן שעניתי/.test(late[0].text) && rs[0].answered === false, 'inbox after restart: maybe answered, not marked answered')

// whatsapp.js: listed before it is marked seen, released after the receipt or the end of onMessage, kept on a throw.
const waSrc = fs.readFileSync(new URL('./whatsapp.js', import.meta.url), 'utf8')
const loop = waSrc.slice(waSrc.indexOf("sock.ev.on('messages.upsert'"))
ok(loop.indexOf('inflight.track(') > 0 && loop.indexOf('inflight.track(') < loop.indexOf('remember(id, sentAt)'), 'whatsapp: tracked before remember (one save)')
ok(/\.then\(receipt\)\s*\n?\s*\.catch\(/.test(loop), 'whatsapp: released only when onMessage resolved, not in finally')
ok(/notSent: true/.test(waSrc) && /return messageId/.test(waSrc), 'whatsapp: "not connected" is marked as not sent, sendAs returns the id')

// index.js: the boot pass runs before WhatsApp starts; the receipt is saved before the queue; nothing is replayed.
const idx = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
ok(idx.indexOf('inflight.strand(state.wa') < idx.indexOf('const wa = await startWhatsApp'), 'index: boot pass before WhatsApp connects')
const recv = idx.indexOf('state.inbox = inbox.received(')
const handoff = idx.slice(recv, idx.indexOf('queue = queue.then', recv))
ok(/save\(\)\s*\n\s*m\.receipt\?\.\(\)/.test(handoff), 'index: inbox receipt saved, then released, before the queue')
ok(idx.indexOf('recoverInstinct()') > 0 && idx.indexOf('recoverInstinct()') < idx.indexOf('const wa = await startWhatsApp'), 'index: Instinct recovery consumed before WhatsApp connects')

console.log(`inflight selftest: ${passed} passed, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
