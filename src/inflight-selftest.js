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

// Track and release.
let wa = { seen: [], lastAt: 0 }
inflight.track(wa, 'A', now - 1000)
inflight.track(wa, 'A', now - 1000)
ok(wa.inflight.length === 1 && wa.inflight[0].id === 'A' && Object.keys(wa.inflight[0]).sort().join() === 'at,id', 'track: id and time only, once')
ok(inflight.release(wa, 'A') && wa.inflight.length === 0, 'release removes it')
ok(!inflight.release(wa, 'A'), 'release of an unknown id changes nothing')

// Boot: everything left is from the last run, even a few seconds old. With an inbox receipt it is just released
// (the inbox watchdog covers it); without one it moves to recovery.
wa = { seen: ['B', 'C'], lastAt: 0 }
inflight.track(wa, 'B', now - 5000) // crashed between seen and the inbox entry
inflight.track(wa, 'C', now - 5000) // crashed after the receipt, before the release
const list = inbox.received([], 'C', 'שלום', now - 5000)
const moved = inflight.strand(wa, { inbox: list, all: true, now })
ok(moved === 1 && wa.inflight.length === 0, 'boot: a stranded message under a minute old still reaches recovery')
ok(wa.recovery.length === 1 && wa.recovery[0].id === 'B' && wa.recovery[0].state === 'needs_recovery', 'boot: only the one without a receipt needs recovery')
ok(wa.seen.includes('B'), 'boot: seen is untouched, so a redelivery is still not processed twice')

// One notice per incident, keyed, no text, says "maybe", never replays.
let notes = inflight.recoveryNotices(wa)
ok(notes.length === 1 && /^inflight-recovery-boot-/.test(notes[0].key), 'notice: one, with a stable key')
ok(/ייתכן/.test(notes[0].text) && /שלח אותו שוב/.test(notes[0].text) && !/שלום/.test(notes[0].text), 'notice: says maybe answered, asks to resend, quotes nothing')
ok(inflight.recoveryNotices(wa).length === 0, 'notice: a second pass says nothing')

// In this run: only entries stuck longer than STUCK_MS move.
wa = { seen: [], lastAt: 0 }
inflight.track(wa, 'D', now - inflight.STUCK_MS - 1000)
inflight.track(wa, 'E', now - 1000)
ok(inflight.strand(wa, { now }) === 1 && wa.inflight.map((e) => e.id).join() === 'E', 'stuck: only the old one moves, a fresh one stays')
notes = inflight.recoveryNotices(wa)
ok(notes.length === 1 && /לפני כמה דקות/.test(notes[0].text), 'stuck: notice words it as now, not as a restart')

// Bounded: overflow moves to recovery instead of being dropped; recovery trims only what was already noticed.
wa = { seen: [], lastAt: 0 }
for (let i = 0; i < inflight.MAX_ACTIVE + 3; i++) inflight.track(wa, `F${i}`, now + i)
ok(wa.inflight.length === inflight.MAX_ACTIVE && wa.recovery.length === 3 && wa.recovery[0].id === 'F0', 'overflow: oldest moved to recovery, not dropped')
wa = { seen: [], lastAt: 0, recovery: Array.from({ length: inflight.MAX_RECOVERY }, (_, i) => ({ id: `R${i}`, at: now, incident: 'x', state: 'needs_recovery', noticed: false })) }
inflight.track(wa, 'G', now - inflight.STUCK_MS - 1)
inflight.strand(wa, { now })
ok(wa.recovery.length === inflight.MAX_RECOVERY + 1, 'recovery: a record still waiting for its notice is never trimmed')
inflight.recoveryNotices(wa)
inflight.track(wa, 'H', now - inflight.STUCK_MS - 1)
inflight.strand(wa, { now })
ok(wa.recovery.length === inflight.MAX_RECOVERY && wa.recovery.at(-1).id === 'H', 'recovery: past the cap, only noticed records are trimmed')

// Old state without the new fields still works.
wa = { seen: ['x'], lastAt: 5 }
ok(inflight.strand(wa, { all: true }) === 0 && inflight.recoveryNotices(wa).length === 0 && wa.seen[0] === 'x', 'old state (no inflight/recovery) reads fine')

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
ok(idx.indexOf('recoverInstinct()') > 0 && idx.indexOf('recoverInstinct()') < idx.indexOf('const wa = await startWhatsApp') && idx.includes("instinctBoot.key, 'recovery'"), 'index: Instinct recovery before WhatsApp, its notice through notify')

console.log(`inflight selftest: ${passed} passed, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
