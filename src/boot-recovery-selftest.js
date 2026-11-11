// Boots the real src/index.js (store, outbox, monitoring, notify, scheduler, timers) with a fake WhatsApp
// (scripts/boot-fixture/) and a state.json from a "crashed" run: one owner message stranded in flight and an Instinct
// conversation with a send still out. Checked in the four ways notify can route a notice:
//   normal   -> the outbox sends it now
//   quiet    -> quiet hours: it waits in the brief notes (monitoring.addNote)
//   budget   -> the daily budget is used up: brief notes
//   batch    -> notice learning moved the kind to "next brief": brief notes
//   evicted  -> normal, plus a notice from an earlier run that the full outbox pushed out unsent: resent
// Each run must boot without an error, hand both recovery notices over exactly once, quote no message text, and
// send nothing to Instinct. Nothing here reaches the network: no WhatsApp, no model call is made at boot.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const REGISTER = path.join(ROOT, 'scripts', 'boot-fixture', 'register.mjs')
const AS_SERVER = path.join(ROOT, 'scripts', 'as-server.cjs')
const BOOT_MS = 4000

let passed = 0
const failed = []
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed.push(name)
    console.log(`FAIL ${name}`)
  }
}

// The child (the Helper under test) sets TZ from TIMEZONE (default Asia/Jerusalem, config.js), so its "today" is
// that zone's date, not the runner's. Taking this process's zone instead broke the check every night from 22:00 UTC
// (already tomorrow in Israel).
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: process.env.TIMEZONE || 'Asia/Jerusalem' })
const OWNER = '972500000000@s.whatsapp.net'
const SECRET = 'תוכן-פרטי-שלא-אמור-להופיע'

function crashedState(mode) {
  const now = Date.now()
  const s = {
    owner: { jid: OWNER, jids: [OWNER], self: true, selfChat: true },
    wa: { seen: ['MSG-STRANDED'], lastAt: Math.floor(now / 1000), inflight: [{ id: 'MSG-STRANDED', sentAt: now - 30_000, receivedAt: now - 30_000 }] },
    inbox: [{ id: 'MSG-OLD', text: SECRET, at: now - 120_000, answered: true, alerted: false, how: 'reply' }],
    outbox: [],
    sentKeys: [],
    instinct: { trusted: true, sent: [], lastAskAt: 0, lateUntil: 0, generation: 3, chat: { active: true, gen: 3, learn: false, started: now - 60_000, turns: 2, paused: false }, ops: [{ op: 'op-boot', kind: 'chat', gen: 3, at: now - 5000 }] },
  }
  if (mode === 'budget') s.metrics = { turns: [], proactive: { day: today(), count: 1 } }
  // A notice from an earlier run that the full outbox pushed out unsent: at boot it is opened again and resent.
  if (mode === 'evicted') {
    s.wa.recovery = [{ incident: 'boot-1-1', state: 'handed', route: 'outbox', handedKey: 'inflight-recovery-boot-1-1-t1', count: 1, firstSentAt: now - 90_000, lastSentAt: now - 90_000, items: [{ id: 'MSG-EARLIER', sentAt: now - 90_000, receivedAt: now - 90_000 }], archived: 0, attempts: 1 }]
    s.outboxEvicted = ['inflight-recovery-boot-1-1-t1']
  }
  if (mode === 'batch') s.notices = { kinds: { recovery: { sent: 6, answered: 0, streak: 4, lastAt: now - 60_000 } }, pending: [], muted: [] }
  return s
}

function envFor(mode, dir) {
  const port = 41000 + Math.floor(Math.random() * 20000)
  const env = {
    ...process.env,
    HELPER_DATA_DIR: dir,
    HELPER_ENV_FILE: path.join(dir, 'empty.env'),
    HELPER_OFFLINE: '1',
    BOOT_FIXTURE_LOG: path.join(dir, 'fixture-log.jsonl'),
    // A model has to be named for index.js to start; nothing at boot calls it, and the address cannot be reached.
    LLM_API_KEY: 'fixture-not-a-key',
    LLM_MODEL: 'fixture-model',
    LLM_BASE_URL: 'http://127.0.0.1:9/v1',
    UPDATE_NOTES: 'off',
    UI_PORT: String(port),
    VOICE_PORT: String(port + 1),
    PC_BRIDGE_PORT: '0',
    QUIET_HOURS: '',
    MESSAGE_BUDGET: '',
    NOTICE_LEARNING: '',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${AS_SERVER} --import ${pathToUrl(REGISTER)}`.trim(),
  }
  delete env.PORT
  if (mode === 'quiet') env.QUIET_HOURS = '00:00-23:59'
  if (mode === 'budget') env.MESSAGE_BUDGET = '1'
  if (mode === 'batch') env.NOTICE_LEARNING = 'true'
  return env
}
const pathToUrl = (p) => new URL(`file://${p.startsWith('/') ? '' : '/'}${p.replace(/\\/g, '/')}`).href

async function boot(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `boot-${mode}-`))
  fs.writeFileSync(path.join(dir, 'empty.env'), '')
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(crashedState(mode)))
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], { cwd: ROOT, env: envFor(mode, dir) })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
  const early = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), BOOT_MS))])
  if (!early) child.kill('SIGTERM')
  const end = early || (await Promise.race([exited, new Promise((r) => setTimeout(() => (child.kill('SIGKILL'), r({ code: null, signal: 'SIGKILL' })), 5000))]))
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8')
    } catch {
      return ''
    }
  }
  const state = JSON.parse(read('state.json') || '{}')
  const log = read('fixture-log.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  // Brief notes live in monitoring's own file; read every json in the data folder so the test does not hard-code it.
  const notes = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'state.json').map((f) => read(f)).join('\n')
  fs.rmSync(dir, { recursive: true, force: true })
  return { out, early, end, state, log, notes }
}

for (const mode of ['normal', 'quiet', 'budget', 'batch', 'evicted']) {
  const r = await boot(mode)
  const crashed = /ReferenceError|before initialization|TypeError/.test(r.out)
  ok(!r.early && !crashed, `${mode}: boots and keeps running${crashed || r.early ? `\n${r.out.split('\n').filter((l) => /Error|at /.test(l)).slice(0, 6).join('\n')}` : ''}`)
  const recovery = r.state.wa?.recovery || []
  // Normal: queued in the outbox and sent by the fake WhatsApp, so the outbox recorded it as sent (positive evidence);
  // the watchdog marks it delivered on its next minute. Other routes: kept for the brief, which counts as delivered.
  const sentKeys = r.state.outboxSent || []
  const settledOk = (x) => (mode === 'normal' || mode === 'evicted' ? x?.state === 'handed' && x.route === 'outbox' && sentKeys.includes(x.handedKey) : x?.state === 'delivered' && x.route === 'noted')
  const fresh = recovery.filter((x) => x.incident !== 'boot-1-1')
  ok(fresh.length === 1 && fresh[0].count === 1 && settledOk(fresh[0]), `${mode}: the stranded message's notice was handed over (${fresh[0]?.state}/${fresh[0]?.route})`)
  if (mode === 'evicted') {
    const old = recovery.find((x) => x.incident === 'boot-1-1')
    ok(old && settledOk(old) && /-t2$/.test(old.handedKey) && old.lastLoss === 'evicted', 'evicted: the pushed-out notice was opened again and resent as attempt 2')
  }
  ok((r.state.instinct?.recovery || []).length === 1 && settledOk(r.state.instinct.recovery[0]), `${mode}: the Instinct notice was handed over`)
  ok(!r.state.instinct?.chat && !(r.state.instinct?.ops || []).length && r.state.instinct?.lastSend?.status === 'uncertain', `${mode}: Instinct conversation ended, in-flight send uncertain`)
  ok(!r.log.some((e) => e.type === 'sendAs'), `${mode}: nothing sent to Instinct`)
  const sends = r.log.filter((e) => e.type === 'send').map((e) => e.text)
  const outboxText = (r.state.outbox || []).map((o) => o.text)
  const everywhere = [...sends, ...outboxText, r.notes].join('\n')
  const inflightTold = (everywhere.match(/באמצע טיפול/g) || []).length
  const instinctTold = (everywhere.match(/עם Instinct נקטעה/g) || []).length
  ok(inflightTold === (mode === 'evicted' ? 2 : 1) && instinctTold === 1, `${mode}: each notice exists exactly once (inflight ${inflightTold}, instinct ${instinctTold})`)
  ok(!everywhere.includes(SECRET), `${mode}: no message text quoted`)
  if (mode === 'normal' || mode === 'evicted') ok(sends.some((t) => /באמצע טיפול/.test(t)) && sends.some((t) => /Instinct נקטעה/.test(t)), 'normal: both notices went out through the outbox')
  else ok(!sends.some((t) => /באמצע טיפול|Instinct נקטעה/.test(t)) && /באמצע טיפול/.test(r.notes) && /Instinct נקטעה/.test(r.notes), `${mode}: both notices wait in the brief notes, not sent now`)
}

console.log(`boot recovery selftest: ${passed} passed, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
