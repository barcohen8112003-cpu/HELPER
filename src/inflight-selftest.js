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
ok(wa.recovery.length === 1 && wa.recovery[0].ids?.[0] === 'B' && wa.recovery[0].count === 1 && wa.recovery[0].state === 'needs_recovery', 'boot: only the one without a receipt needs recovery')
ok(wa.seen.includes('B'), 'boot: seen is untouched, so a redelivery is still not processed twice')

// One notice per incident, keyed, no text, says "maybe", never replays.
let n1 = collect()
flush(wa, n1)
ok(n1.out.length === 1 && /^inflight-recovery-boot-/.test(n1.out[0].key), 'notice: one, with a stable key')
ok(/ייתכן/.test(n1.out[0]?.text || '') && /שלח אותו שוב/.test(n1.out[0]?.text || '') && !/שלום/.test(n1.out[0]?.text || ''), 'notice: says maybe answered, asks to resend, quotes nothing')
flush(wa, n1)
ok(n1.out.length === 1, 'notice: a second pass says nothing')

// Durable hand-off: the incident is consumed only after notify accepted it. A crash before that (here: notify
// throws, as it would on a boot that calls it too early) leaves it open, and the next pass sends it.
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
ok(n1.out.length === 1 && /-t2$/.test(n1.out[0].key) && inflight.pendingNotices(persisted) === 0, 'durable: after a restart it is sent with a new attempt key and then consumed')

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
ok(wa.inflight.length === inflight.MAX_ACTIVE && wa.recovery.length === 1 && wa.recovery[0].ids[0] === 'F0', 'overflow: oldest moved to recovery, not dropped')
ok(inflight.strand(wa, { now }) === 0 && has('pendingNotices') && inflight.pendingNotices(wa) === 1, 'overflow: strand finds nothing new, yet a notice is pending')
n1 = collect()
flush(wa, n1)
ok(n1.out.length === 1 && inflight.pendingNotices(wa) === 0, 'overflow: drained without anything newly stranded')

// Bounds. Handed but still waiting in the outbox is not trimmed; open incidents are merged, their count kept.
wa = { seen: [], lastAt: 0, recovery: [] }
const outbox = []
for (let i = 0; i < inflight.MAX_INCIDENTS; i++) {
  inflight.track(wa, `R${i}`, now + i, now + i)
  inflight.strand(wa, { all: true, now: now + i, incident: `stuck-${i}`, outbox })
}
const handedKeys = []
flush(wa, (text, urgent, key) => (handedKeys.push(key), outbox.push({ text, key }), Promise.resolve()))
ok(wa.recovery.length === inflight.MAX_INCIDENTS && wa.recovery.every((r) => r.state === 'handed'), 'bounds: all handed, all still in the outbox')
inflight.track(wa, 'S', now, now)
inflight.strand(wa, { all: true, now, incident: 'stuck-new', outbox })
ok(wa.recovery.length === inflight.MAX_INCIDENTS + 1 && wa.recovery.filter((r) => r.state === 'handed').length === inflight.MAX_INCIDENTS, 'bounds: handed but undelivered (still in the outbox) is never trimmed')
outbox.splice(0, 1) // the first notice left the outbox
inflight.track(wa, 'T', now, now)
inflight.strand(wa, { all: true, now, incident: 'stuck-new2', outbox })
ok(!wa.recovery.some((r) => r.handedKey === handedKeys[0]) && wa.recovery.some((r) => r.incident === 'stuck-new2'), 'bounds: only a delivered incident is trimmed to make room')
wa = { seen: [], lastAt: 0, recovery: [] }
let total = 0
for (let i = 0; i < inflight.MAX_INCIDENTS + 10; i++) {
  inflight.track(wa, `U${i}`, now + i, now + i)
  total += inflight.strand(wa, { all: true, now: now + i, incident: `stuck-u${i}` })
}
ok(wa.recovery.length <= inflight.MAX_INCIDENTS && wa.recovery.reduce((a, r) => a + r.count, 0) === total, 'bounds: open incidents stay bounded by merging, and every message is still counted')

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
