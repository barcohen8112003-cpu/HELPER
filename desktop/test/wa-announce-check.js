// Offline checks for spoken WhatsApp messages: the notification parser, every reason a message is not said, the
// settings, the voice commands, the listener's line handling, and that the text never reaches a file, a log, the
// console, the network or a command line. Synthetic notifications only (test/fixtures/wa-toasts.json): no real
// WhatsApp, no real Windows notifications, no real voice.
// Run: node test/wa-announce-check.js (from desktop/), or npm run check.
'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const wa = require('../src/wa-announce')
const { createListener } = require('../src/wa-listen')
const { privateOf } = require('../src/private-voice')
const F = require('./fixtures/wa-toasts.json')

let passed = 0, failed = 0
const queue = []
function check(name, fn) { queue.push([name, fn]) }

const SECRET = 'SYNTH-SECRET'
const T0 = new Date(2026, 10, 15, 13, 0, 0).getTime()   // 13:00 local: outside the default quiet hours

// ---- a test bench: fake clock, fake timers, fake PC ------------------------------------------------------------

function bench(over = {}) {
  let t = T0
  let timers = []
  const said = []
  const reasons = []
  const pc = Object.assign({ locked: false, foreground: false, busy: false, paused: false }, over.pc || {})
  let settings = Object.assign({
    waAnnounce: true, waMode: 'allowlist', waChats: [{ name: 'SYNTH-דנה', kind: 'direct' }, { name: 'SYNTH-כיתה', kind: 'group' }, { name: 'SYNTH-Dana', kind: 'direct' }],
    waBlock: [], waGroups: false, waQuiet: { on: true, from: '22:00', to: '07:00' }, waMaxChars: 160, waPerMinute: 4,
  }, over.settings || {})
  const removed = []
  const a = wa.createAnnouncer({
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h },
      clearTimeout: (h) => { timers = timers.filter((x) => x !== h) },
    },
    settings: () => settings,
    env: { running: (toast) => toast.running !== false, locked: () => pc.locked, foreground: () => pc.foreground, busy: () => pc.busy, paused: () => pc.paused },
    speak: over.speak || (async (line) => { said.push(line); return true }),
    onDisappearing: (chat) => removed.push(chat),
    onDecision: (r) => reasons.push(r),
  })
  let n = 0
  const toast = (lines, extra = {}) => a.toast(Object.assign({ id: String(++n), at: t, lines, running: true }, extra))
  const go = async (ms) => {
    const end = t + ms
    await new Promise((r) => setImmediate(r))
    for (;;) {
      timers.sort((x, y) => x.at - y.at)
      const h = timers[0]
      if (!h || h.at > end) break
      timers.shift()
      t = h.at
      h.fn()
      await new Promise((r) => setImmediate(r))
    }
    t = end
  }
  return { a, said, reasons, pc, removed, toast, go, set: (p) => { settings = Object.assign({}, settings, p) }, settings: () => settings, at: () => t, advance: (ms) => { t += ms } }
}

async function reason(lines, over) {
  const b = bench(over)
  const r = await b.toast(lines)
  return { r, said: b.said }
}

// ---- parsing -------------------------------------------------------------------------------------------------

check('parse: a direct message', () => {
  assert.deepStrictEqual(wa.parseToast(F.direct), { chat: 'SYNTH-דנה', sender: '', group: false, body: 'SYNTH-SECRET-מחר בשמונה?' })
})
check('parse: a group "Sender: text"', () => {
  const p = wa.parseToast(F.group)
  assert.strictEqual(p.group, true); assert.strictEqual(p.chat, 'SYNTH-כיתה'); assert.strictEqual(p.sender, 'SYNTH-יוסי'); assert.strictEqual(p.body, 'SYNTH-SECRET-אין מבחן')
})
check('parse: a group title "Sender @ Group"', () => {
  const p = wa.parseToast(F.groupAt)
  assert.strictEqual(p.group, true); assert.strictEqual(p.chat, 'SYNTH-כיתה'); assert.strictEqual(p.sender, 'SYNTH-יוסי')
})
check('parse: "(3 messages)" leaves the chat name', () => {
  assert.strictEqual(wa.parseToast(F.groupCount).chat, 'SYNTH-כיתה')
})
check('parse: direction marks are removed', () => {
  const p = wa.parseToast(F.bidi)
  assert.strictEqual(p.chat, 'SYNTH-דנה'); assert.strictEqual(p.body, 'SYNTH-SECRET-מחר בשמונה?')
})
check('parse: a chat listed as direct keeps "הערה: ..." as text', () => {
  const p = wa.parseToast(F.directColon, { directs: new Set([wa.normName('SYNTH-דנה')]) })
  assert.strictEqual(p.group, false); assert.ok(p.body.startsWith('הערה:'))
})
check('parse: no lines, title only, a "WhatsApp" title → skipped', () => {
  assert.ok(wa.parseToast(null).skip)
  assert.ok(wa.parseToast([]).skip)
  assert.ok(wa.parseToast(F.titleOnly).skip)
  assert.ok(wa.parseToast(F.generic).skip)
  assert.ok(wa.parseToast(F.genericCount).skip)
})

// ---- what is said --------------------------------------------------------------------------------------------

check('say: a listed direct chat is said: who and what', async () => {
  const { r, said } = await reason(F.direct)
  assert.strictEqual(r, 'spoken')
  assert.deepStrictEqual(said, ['הודעה מSYNTH-דנה: SYNTH-SECRET-מחר בשמונה?'])
})
check('say: a listed group: the group, the sender, the text', async () => {
  const { r, said } = await reason(F.group)
  assert.strictEqual(r, 'spoken')
  assert.deepStrictEqual(said, ['בקבוצה SYNTH-כיתה, SYNTH-יוסי: SYNTH-SECRET-אין מבחן'])
})
check('say: English text is said as it is', async () => {
  const { said } = await reason(F.english)
  assert.deepStrictEqual(said, ['הודעה מSYNTH-Dana: SYNTH-SECRET-see you at 8'])
})
check('say: a link becomes "קישור", emoji are dropped', async () => {
  const { said } = await reason(F.link)
  assert.ok(said[0].endsWith('קישור')); assert.ok(!/https?:/.test(said[0]))
  assert.strictEqual(wa.sayable('היי 😀👍🏽 מה'), 'היי מה')
})
check('say: a long text is cut, with "ועוד"', async () => {
  const { said } = await reason(F.long)
  assert.ok(said[0].endsWith('… ועוד'))
  assert.ok(said[0].length < 160 + 30)
})
check('say: emoji only → nothing to say', async () => {
  const { r, said } = await reason(F.emojiOnly)
  assert.strictEqual(r, 'empty'); assert.deepStrictEqual(said, [])
})

// ---- never said: content ----------------------------------------------------------------------------------------

const NEVER = {
  photo: 'media', photoCaption: 'media', photoHe: 'media', video: 'media', voiceNote: 'media', voiceHe: 'media', sticker: 'media',
  document: 'media', location: 'media', groupPhoto: 'media',
  viewOnce: 'view-once', viewOnceHe: 'view-once', viewOnceIcon: 'view-once',
  disappearing: 'disappearing', disappearingOn: 'disappearing',
  generic: 'generic', genericHe: 'generic', genericCount: 'generic', titleOnly: 'generic',
  call: 'call', callHe: 'call', reaction: 'reaction', deleted: 'deleted',
}
for (const [name, why] of Object.entries(NEVER)) {
  check(`never said: ${name} (${why})`, async () => {
    const { r, said } = await reason(F[name])
    assert.strictEqual(r, why)
    assert.deepStrictEqual(said, [])
  })
}
check('view-once: every media kind is dropped even with no view-once marker at all', async () => {
  for (const k of ['photo', 'video', 'voiceNote', 'voiceHe', 'photoHe']) assert.strictEqual((await reason(F[k])).r, 'media')
})
check('disappearing: a sure marker takes the chat off the list; the word "timer" alone does not', async () => {
  const b = bench()
  assert.strictEqual(await b.toast(F.disappearingOn), 'disappearing')
  assert.deepStrictEqual(b.removed, ['SYNTH-דנה'])
  const c = bench()
  assert.strictEqual(await c.toast(['SYNTH-דנה', 'set a timer for 5']), 'disappearing')
  assert.deepStrictEqual(c.removed, [])
})

// ---- never said: the PC right now ---------------------------------------------------------------------------

check('off by default: the store default is off, allowlist, groups off, quiet hours on, Windows voice', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8')
  assert.ok(/waAnnounce: false/.test(src))
  assert.ok(/waMode: 'allowlist'/.test(src))
  assert.ok(/waGroups: false/.test(src))
  assert.ok(/waQuiet: \{ on: true, from: '22:00', to: '07:00' \}/.test(src))
  assert.ok(/waVoice: 'windows'/.test(src))
})
check('off: nothing is said', async () => {
  const { r, said } = await reason(F.direct, { settings: { waAnnounce: false } })
  assert.strictEqual(r, 'off'); assert.deepStrictEqual(said, [])
})
check('locked PC: dropped, and not said after the unlock', async () => {
  const b = bench({ pc: { locked: true } })
  assert.strictEqual(await b.toast(F.direct), 'locked')
  b.pc.locked = false
  b.a.reset()
  await b.go(20000)
  assert.deepStrictEqual(b.said, [])
})
check('WhatsApp not running: dropped', async () => {
  const b = bench()
  assert.strictEqual(await b.toast(F.direct, { running: false }), 'not-running')
  assert.deepStrictEqual(b.said, [])
})
check('WhatsApp in front: dropped', async () => {
  const { r } = await reason(F.direct, { pc: { foreground: true } })
  assert.strictEqual(r, 'foreground')
})
check('paused ("תשתוק"): dropped', async () => {
  const { r } = await reason(F.direct, { pc: { paused: true } })
  assert.strictEqual(r, 'paused')
})
check('quiet hours: 23:30 and 06:59 are quiet, 07:00 and 13:00 are not; off means never', () => {
  const q = { on: true, from: '22:00', to: '07:00' }
  const at = (h, m) => new Date(2026, 10, 15, h, m)
  assert.strictEqual(wa.inQuiet(q, at(23, 30)), true)
  assert.strictEqual(wa.inQuiet(q, at(6, 59)), true)
  assert.strictEqual(wa.inQuiet(q, at(7, 0)), false)
  assert.strictEqual(wa.inQuiet(q, at(13, 0)), false)
  assert.strictEqual(wa.inQuiet(Object.assign({}, q, { on: false }), at(23, 30)), false)
  assert.strictEqual(wa.inQuiet({ on: true, from: '13:00', to: '14:00' }, at(13, 30)), true)
  assert.strictEqual(wa.inQuiet({ on: true, from: 'x', to: '07:00' }, at(23, 30)), false)
})
check('quiet hours: a message at 23:00 is dropped', async () => {
  const b = bench()
  b.advance(10 * 3600 * 1000)   // 23:00
  const r = await b.a.toast({ id: 'q', at: b.at() - 100, lines: F.direct, running: true })
  assert.strictEqual(r, 'quiet'); assert.deepStrictEqual(b.said, [])
})

// ---- no backlog ------------------------------------------------------------------------------------------------

check('no backlog: older than 15 s → dropped', async () => {
  const b = bench()
  assert.strictEqual(await b.a.toast({ id: 'x', at: b.at() - 16000, lines: F.direct }), 'old')
  assert.strictEqual(await b.a.toast({ id: 'y', lines: F.direct }), 'old')   // no time at all
})
check('no backlog: from before the start / unlock → dropped', async () => {
  const b = bench()
  b.advance(5000)
  b.a.reset()
  assert.strictEqual(await b.a.toast({ id: 'x', at: b.at() - 1000, lines: F.direct }), 'old')
  assert.strictEqual(await b.a.toast({ id: 'y', at: b.at(), lines: F.direct }), 'spoken')
})
check('no backlog: seeded ids are never said; an id is said once', async () => {
  const b = bench()
  b.a.seed(['7'])
  assert.strictEqual(await b.a.toast({ id: '7', at: b.at(), lines: F.direct }), 'seen')
  assert.strictEqual(await b.a.toast({ id: '8', at: b.at(), lines: F.direct }), 'spoken')
  assert.strictEqual(await b.a.toast({ id: '8', at: b.at(), lines: F.direct }), 'seen')
  assert.strictEqual(b.said.length, 1)
})

// ---- busy, rate ------------------------------------------------------------------------------------------------

check('busy: waits while HELPER talks, then says it', async () => {
  const b = bench({ pc: { busy: true } })
  const p = b.toast(F.direct)
  await b.go(3000)
  assert.deepStrictEqual(b.said, [])
  b.pc.busy = false
  await b.go(600)
  assert.strictEqual(await p, 'spoken')
})
check('busy for more than 10 s: dropped, never said later', async () => {
  const b = bench({ pc: { busy: true } })
  const p = b.toast(F.direct)
  await b.go(11000)
  assert.strictEqual(await p, 'busy')
  b.pc.busy = false
  await b.go(30000)
  assert.deepStrictEqual(b.said, [])
})
check('busy, then locked meanwhile: dropped', async () => {
  const b = bench({ pc: { busy: true } })
  const p = b.toast(F.direct)
  await b.go(1000)
  b.pc.locked = true
  b.pc.busy = false
  await b.go(1000)
  assert.strictEqual(await p, 'locked')
  assert.deepStrictEqual(b.said, [])
})
check('rate: 4 a minute, then one "יש עוד" per chat (no content), then silence', async () => {
  const b = bench()
  const rs = []
  for (let i = 0; i < 4; i++) rs.push(await b.toast(F.direct))
  rs.push(await b.toast(F.direct))
  rs.push(await b.toast(F.direct))
  rs.push(await b.toast(F.group))
  assert.deepStrictEqual(rs, ['spoken', 'spoken', 'spoken', 'spoken', 'more', 'rate', 'more'])
  assert.strictEqual(b.said[4], 'יש עוד הודעות מSYNTH-דנה')
  assert.strictEqual(b.said[5], 'יש עוד הודעות בקבוצה SYNTH-כיתה')
  assert.ok(!b.said[4].includes(SECRET) && !b.said[5].includes(SECRET))
  b.advance(61000)
  assert.strictEqual(await b.toast(F.direct), 'spoken')
})
check('voice fails: reported, nothing else', async () => {
  const b = bench({ speak: async () => false })
  assert.strictEqual(await b.toast(F.direct), 'voice-failed')
})
check('one at a time: a second message waits for the first to be said', async () => {
  let release
  const said = []
  const b = bench({ speak: (line) => new Promise((r) => { said.push(line); release = () => r(true) }) })
  const p1 = b.toast(F.direct)
  const p2 = b.toast(F.english)
  await b.go(1000)
  assert.strictEqual(said.length, 1)
  release()
  await b.go(600)
  assert.strictEqual(said.length, 2)
  release()
  assert.deepStrictEqual([await p1, await p2], ['spoken', 'spoken'])
})

// ---- per-chat controls ------------------------------------------------------------------------------------------

check('allowlist: a chat that is not listed is not said', async () => {
  assert.strictEqual((await reason(F.stranger)).r, 'not-listed')
  assert.strictEqual((await reason(F.otherGroup)).r, 'not-listed')
  assert.strictEqual((await reason(F.direct, { settings: { waChats: [] } })).r, 'not-listed')
})
check('all: everyone but the blocked; groups only with waGroups', async () => {
  const all = { waMode: 'all', waChats: [], waBlock: ['SYNTH-זר'] }
  assert.strictEqual((await reason(F.direct, { settings: all })).r, 'spoken')
  assert.strictEqual((await reason(F.stranger, { settings: all })).r, 'not-listed')
  assert.strictEqual((await reason(F.otherGroup, { settings: all })).r, 'not-listed')
  assert.strictEqual((await reason(F.otherGroup, { settings: Object.assign({}, all, { waGroups: true }) })).r, 'spoken')
})
check('names compare without direction marks, case or "(3 messages)"', () => {
  assert.strictEqual(wa.normName('‫SYNTH-Dana‬ (3 messages)'), 'synth-dana')
  assert.ok(wa.chatAllowed({ waMode: 'allowlist', waChats: [{ name: 'synth-dana' }] }, { chat: 'SYNTH-Dana' }))
})

// ---- voice commands -----------------------------------------------------------------------------------------------

check('commands: add, add a group, remove, off, on, hush', () => {
  assert.deepStrictEqual(wa.waCommand('תקריא לי הודעות מדנה'), { op: 'add', name: 'דנה', kind: 'direct' })
  assert.deepStrictEqual(wa.waCommand('הלפר, תקריא לי הודעות וואטסאפ מ-יוסי כהן'), { op: 'add', name: 'יוסי כהן', kind: 'direct' })
  assert.deepStrictEqual(wa.waCommand('תקריא לי הודעות מהקבוצה כיתה ח'), { op: 'add', name: 'כיתה ח', kind: 'group' })
  assert.deepStrictEqual(wa.waCommand('תקריא הודעות מקבוצת הורים'), { op: 'add', name: 'הורים', kind: 'group' })
  assert.deepStrictEqual(wa.waCommand('תפסיק להקריא הודעות מדנה'), { op: 'remove', name: 'דנה', kind: 'direct' })
  assert.deepStrictEqual(wa.waCommand('תפסיק להקריא הודעות'), { op: 'off' })
  assert.deepStrictEqual(wa.waCommand('תפסיק להקריא'), { op: 'off' })
  assert.deepStrictEqual(wa.waCommand('תתחיל להקריא הודעות'), { op: 'on' })
  assert.deepStrictEqual(wa.waCommand('תשתוק'), { op: 'hush' })
})
check('commands: other asks are not WhatsApp commands', () => {
  for (const t of ['תפתח את וואטסאפ', 'תקריא לי את המייל', 'מה שלומך', 'תשלח הודעה לדנה', '']) assert.strictEqual(wa.waCommand(t), null, t)
})
check('commands: the chat list adds once and removes', () => {
  let l = wa.editChats([], { op: 'add', name: 'דנה', kind: 'direct' })
  l = wa.editChats(l, { op: 'add', name: 'דנה', kind: 'direct' })
  l = wa.editChats(l, { op: 'add', name: 'כיתה ח', kind: 'group' })
  assert.deepStrictEqual(l, [{ name: 'דנה', kind: 'direct' }, { name: 'כיתה ח', kind: 'group' }])
  assert.deepStrictEqual(wa.editChats(l, { op: 'remove', name: 'דנה' }), [{ name: 'כיתה ח', kind: 'group' }])
})

// ---- the listener ---------------------------------------------------------------------------------------------

function fakeSpawn() {
  const made = []
  const spawn = (cmd, args) => {
    const c = new EventEmitter()
    c.stdout = new EventEmitter(); c.stdout.setEncoding = () => { }
    c.stderr = new EventEmitter()
    c.kill = () => { c.killed = true; c.emit('exit', null) }
    c.cmd = cmd; c.args = args
    made.push(c)
    return c
  }
  return { spawn, made }
}

check('listener: JSON lines → toasts, access, ready; split lines and a BOM are fine', () => {
  const { spawn, made } = fakeSpawn()
  const got = [], access = [], logs = []
  let ready = 0
  const l = createListener({ spawn, log: (c) => logs.push(c), onToast: (t) => got.push(t), onAccess: (s) => access.push(s), onReady: () => ready++ })
  l.start()
  const out = made[0].stdout
  out.emit('data', '﻿{"op":"access","status":"Allowed"}\n{"op":"ready"}\n{"op":"toast","id":"5","at":12')
  out.emit('data', '3,"lines":' + JSON.stringify(F.direct) + ',"running":true}\n{"op":"toast","id":"6","at":1,"lines":"SYNTH-only-one"}\nnot json\n')
  out.emit('data', '{"op":"error","code":"poll"}\n')
  assert.deepStrictEqual(access, ['Allowed']); assert.strictEqual(ready, 1)
  assert.deepStrictEqual(got[0], { id: '5', at: 123, lines: F.direct, running: true })
  assert.deepStrictEqual(got[1].lines, ['SYNTH-only-one'])
  assert.deepStrictEqual(logs, ['wa: poll'])
  l.stop()
  assert.ok(made[0].killed)
})
check('listener: the worker runs with -STA and the script path only (no text on its command line)', () => {
  const { spawn, made } = fakeSpawn()
  const l = createListener({ spawn })
  l.start()
  assert.strictEqual(made[0].cmd, 'powershell.exe')
  assert.ok(made[0].args.includes('-STA'))
  assert.ok(made[0].args[made[0].args.length - 1].endsWith('wa-toasts.ps1'))
  l.stop()
})
check('listener: a stopped worker is started again while on; not after stop()', async () => {
  const { spawn, made } = fakeSpawn()
  const l = createListener({ spawn, log: () => { } })
  l.start()
  made[0].emit('exit', 3)
  await new Promise((r) => setTimeout(r, 2100))
  assert.strictEqual(made.length, 2)
  l.stop()
  await new Promise((r) => setTimeout(r, 50))
  assert.strictEqual(made.length, 2)
})
check('listener: an error code is cleaned before it is logged', () => {
  const { spawn, made } = fakeSpawn()
  const logs = []
  const l = createListener({ spawn, log: (c) => logs.push(c) })
  l.start()
  made[0].stdout.emit('data', '{"op":"error","code":"' + SECRET + ' poll"}\n')
  l.stop()
  assert.ok(!logs.join(' ').includes('SYNTH'))
})

// ---- the private voice ---------------------------------------------------------------------------------------

function voiceSpawn(reply, code = 0) {
  const calls = []
  const spawn = (cmd, args, opts) => {
    const c = new EventEmitter()
    c.stdout = new EventEmitter()
    const input = []
    c.stdin = { on: () => { }, end: (b) => { input.push(Buffer.from(b).toString('utf8')); setImmediate(() => { c.stdout.emit('data', Buffer.from(reply)); c.emit('close', code) }) } }
    c.kill = () => { }
    calls.push({ cmd, args, opts, input })
    return c
  }
  return { spawn, calls }
}

check('voice (windows): text on stdin only, base64 WAV back, no file', async () => {
  const wav = Buffer.alloc(2000, 7).toString('base64')
  const { spawn, calls } = voiceSpawn(wav + '\r\n')
  const s = await privateOf('הודעה מ' + SECRET, { spawn })
  assert.deepStrictEqual(s, { b64: wav, mime: 'audio/wav' })
  assert.strictEqual(calls[0].cmd, 'powershell.exe')
  assert.ok(calls[0].args[calls[0].args.length - 1].endsWith('say-stdin.ps1'))
  assert.ok(!calls[0].args.join(' ').includes(SECRET), 'text on the command line')
  assert.strictEqual(calls[0].input[0], 'הודעה מ' + SECRET)
})
check('voice (edge): "--file -" with stdin, mp3 from stdout, no --write-media', async () => {
  const { spawn, calls } = voiceSpawn(Buffer.alloc(3000, 1))
  const s = await privateOf(SECRET + ' שלום', { voice: 'edge', spawn })
  assert.strictEqual(s.mime, 'audio/mpeg')
  assert.strictEqual(calls[0].cmd, 'edge-tts')
  assert.ok(calls[0].args.includes('--file') && calls[0].args[calls[0].args.indexOf('--file') + 1] === '-')
  assert.ok(!calls[0].args.includes('--write-media') && !calls[0].args.includes('--text'))
  assert.ok(!calls[0].args.join(' ').includes(SECRET))
})
check('voice: no Hebrew voice / a failure / nothing to say → null', async () => {
  assert.strictEqual(await privateOf('שלום', { spawn: voiceSpawn('NOVOICE\n').spawn }), null)
  assert.strictEqual(await privateOf('שלום', { spawn: voiceSpawn('', 1).spawn }), null)
  assert.strictEqual(await privateOf('   ', { spawn: voiceSpawn('x').spawn }), null)
  assert.strictEqual(await privateOf('שלום', { spawn: () => { throw new Error('no powershell') } }), null)
})
check('voice: the module never touches the cloud or a cache', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'private-voice.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  for (const bad of ['fetch(', 'brain', 'voiceOf', 'elevenlabs', 'writeFile', 'appendFile', 'createWriteStream', 'tmpdir', 'helper-voice-cache', '--write-media', '--text']) {
    assert.ok(!src.toLowerCase().includes(bad.toLowerCase()), bad)
  }
})

// ---- the leak test: the whole path, with every way out watched ----------------------------------------------------

check('leak: notification text never reaches a file, the console, the network or a decision', async () => {
  const caught = []
  const watch = (obj, names) => names.map((n) => { const orig = obj[n]; obj[n] = function (...a) { caught.push(n + ' ' + a.map((x) => { try { return typeof x === 'string' ? x : Buffer.isBuffer(x) ? x.toString('utf8') : JSON.stringify(x) } catch { return String(x) } }).join(' ')); return typeof orig === 'function' && /^(log|warn|error|info|debug)$/.test(n) ? undefined : undefined }; return () => { obj[n] = orig } })
  const undo = [].concat(
    watch(fs, ['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile', 'createWriteStream', 'writeSync']),
    watch(fs.promises, ['writeFile', 'appendFile']),
    watch(console, ['log', 'warn', 'error', 'info', 'debug']),
  )
  const realFetch = global.fetch
  global.fetch = (...a) => { caught.push('fetch ' + JSON.stringify(a)); return Promise.reject(new Error('no network')) }
  const decisions = [], logs = []
  const voice = voiceSpawn(Buffer.alloc(2000, 7).toString('base64'))
  try {
    const { spawn, made } = fakeSpawn()
    let t = Date.now()
    const ann = wa.createAnnouncer({
      now: () => t,
      settings: () => ({ waAnnounce: true, waMode: 'all', waGroups: true, waChats: [], waQuiet: { on: false } }),
      env: { running: () => true, locked: () => false, foreground: () => false, busy: () => false, paused: () => false },
      speak: async (line) => Boolean(await privateOf(line, { spawn: voice.spawn })),
      onDecision: (r) => decisions.push(r),
    })
    const pending = []
    const l = createListener({ spawn, log: (c) => logs.push(c), onToast: (x) => pending.push(ann.toast(x)) })
    l.start()
    let id = 100
    for (const [name, lines] of Object.entries(F)) {
      if (name.startsWith('_')) continue
      made[0].stdout.emit('data', JSON.stringify({ op: 'toast', id: String(++id), at: t, lines, running: true }) + '\n')
    }
    made[0].stdout.emit('data', '{"op":"error","code":"poll"}\n')
    await Promise.all(pending)
    l.stop()
  } finally {
    undo.forEach((u) => u())
    global.fetch = realFetch
  }
  assert.ok(decisions.includes('spoken'), 'something was said (the test ran the whole path)')
  for (const c of caught) assert.ok(!c.includes('SYNTH'), 'leaked: ' + c.slice(0, 80))
  for (const d of decisions.concat(logs)) assert.ok(!String(d).includes('SYNTH'), 'leaked into a reason or log: ' + d)
  for (const c of voice.calls) assert.ok(!c.args.join(' ').includes('SYNTH'), 'text on a command line')
  assert.ok(voice.calls.some((c) => c.input[0].includes(SECRET)), 'the voice got the text on stdin')
})

check('leak: the modules hold no file, network or cloud calls of their own', () => {
  for (const f of ['wa-announce.js', 'wa-listen.js']) {
    const extra = f === 'wa-announce.js' ? ['child_process'] : []
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '')
    for (const bad of ['require(\'fs\')', 'require("fs")', 'fetch(', 'require(\'./brain\')', 'avatar-feed', 'console.', 'store.log', "require('http", "require('https", 'net.'].concat(extra)) assert.ok(!src.includes(bad), `${f}: ${bad}`)
  }
})
check('leak: main.js keeps spoken WhatsApp text out of the log, the asks history and the cloud', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const a = src.indexOf('// ---- spoken WhatsApp messages')
  const b = src.indexOf('// ---- talking', a)
  assert.ok(a > 0 && b > a)
  const part = src.slice(a, b)
  // log() calls get fixed codes only (no variables but the cleaned access status).
  const calls = part.split('\n').filter((l) => /\blog\(/.test(l) && !/^\s*\/\//.test(l))
  const SAFE = [/log\('wa: [a-z -]+'\)/g, /log\('wa: access ' \+ String\(st\)\.replace\(\/\[\^A-Za-z\]\/g, ''\)\)/g, /createListener\(\{\s*$/g, /^\s*log,\s*$/g]
  for (const l of calls) {
    let rest = l
    for (const re of SAFE) rest = rest.replace(re, '')
    assert.ok(!/\blog\(/.test(rest), 'log with content: ' + l.trim())
  }
  for (const bad of ['store.log', 'finish(', 'answer(', 'bubbleState(', 'brain.', 'voiceOut.', 'askHelper']) assert.ok(!part.includes(bad), bad)
  // The cloud events feed does not carry it.
  assert.ok(!/avatarFeed/.test(part))
})

check('worker: the PowerShell script writes no file and prints no text but JSON lines', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'wa-toasts.ps1'), 'utf8').replace(/^\s*#.*$/gm, '')
  for (const bad of ['Out-File', 'Set-Content', 'Add-Content', 'WriteAllText', 'WriteAllBytes', 'Write-Host', 'Write-Error', 'Start-Transcript', 'Export-']) assert.ok(!src.includes(bad), bad)
  assert.ok(/IsWhatsApp/.test(src) && /\$first/.test(src), 'WhatsApp only, skips what was already there')
  const say = fs.readFileSync(path.join(__dirname, '..', 'src', 'say-stdin.ps1'), 'utf8').replace(/^\s*#.*$/gm, '')
  for (const bad of ['WriteAllBytes', 'Out-File', 'Set-Content', 'param(']) assert.ok(!say.includes(bad), 'say-stdin: ' + bad)
  assert.ok(/\[Console\]::In\.ReadToEnd\(\)/.test(say))
})

// ---- run ------------------------------------------------------------------------------------------------------

;(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++ } catch (e) { failed++; console.log('FAIL', name, '\n  ', e && e.message) }
  }
  console.log(`wa-announce-check: ${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
