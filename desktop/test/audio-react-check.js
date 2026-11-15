// Offline checks for the avatar dancing to music from any app: the beat feel (src/beat.js), the worker's line
// parser and its lifecycle (src/audio-watch.js, with a fake worker), the avatar's state with Windows' "now playing"
// list, the window's level view, and that no song information or level can leak. Synthetic numbers and lines only:
// no real audio, no real media session, no Windows needed.
// Run: node test/audio-react-check.js (from desktop/), or npm run check.
'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const { createBeat, MIN_BEAT_GAP, LEVEL_HOLD_MS } = require('../src/beat')
const { createAudioWatch, parseLine, ignoreLine, SCRIPT, MIN_WAIT, MAX_WAIT, STEADY_MS } = require('../src/audio-watch')
const { createAvatarState, SYSTEM_STOP_MS, HELPER_GRACE_MS, HELPER_QUIET_MS, MUSIC_MAX_MS, REACT_MS } = require('../src/avatar-state')
const avatarView = require('../ui/avatar.js')
const fixtures = require('./fixtures/audio-react.json')

let passed = 0, failed = 0
const queue = []
function check(name, fn) { queue.push([name, fn]) }

const SECRET = 'SYNTH-SECRET-שיר'
const FRAME = 1000 / 30

/** A synthetic song: a pulse every beat that decays, sampled 30 times a second. */
function song({ bpm = 120, gain = 1, secs = 20, start = 0 } = {}) {
  const period = 60000 / bpm
  const out = []
  for (let i = 0; i < secs * 30; i++) {
    const t = start + i * FRAME
    const since = (i * FRAME) % period
    out.push([gain * (0.15 + 0.7 * Math.exp(-since / 120)), t])
  }
  return out
}
function feel(frames, b = createBeat()) {
  const beats = []
  let last = null
  for (const [x, t] of frames) { const r = b.push(x, t); if (r) { last = r; if (r.beat) beats.push(t) } }
  return { beats, last, b }
}

// ---- beat.js ------------------------------------------------------------------------------------------

check('beat: 120 BPM gives a beat every 500 ms and a tempo of 120', () => {
  const { beats, last } = feel(song({ bpm: 120 }))
  assert.ok(beats.length >= 37 && beats.length <= 40, 'beats: ' + beats.length + ' (the first one or two only set the level)')
  for (let i = 2; i < beats.length; i++) assert.ok(Math.abs(beats[i] - beats[i - 1] - 500) <= FRAME + 1, 'gap ' + (beats[i] - beats[i - 1]))
  assert.ok(Math.abs(last.bpm - 120) <= 3, 'bpm ' + last.bpm)
})
check('beat: 90 and 170 BPM are followed', () => {
  for (const bpm of [90, 170]) {
    const { beats, last } = feel(song({ bpm }))
    assert.ok(Math.abs(beats.length - Math.round(20 * bpm / 60)) <= 3, bpm + ': ' + beats.length)
    assert.ok(Math.abs(last.bpm - bpm) / bpm <= 0.08, bpm + ' → ' + last.bpm)
  }
})
check('beat: 20% volume uses the same range as full volume (auto-gain)', () => {
  const loud = feel(song({ gain: 1 })).last
  const quiet = feel(song({ gain: 0.2 })).last
  assert.strictEqual(quiet.energy, loud.energy)
  assert.strictEqual(quiet.level, loud.level)
  assert.strictEqual(quiet.bpm, loud.bpm)
})
check('beat: silence is energy 0, no beats, no tempo', () => {
  const frames = []
  for (let i = 0; i < 300; i++) frames.push([0, i * FRAME])
  const { beats, last } = feel(frames)
  assert.deepStrictEqual([beats.length, last.energy, last.level, last.bpm], [0, 0, 0, 0])
})
check('beat: a steady sound (constant, tiny jitter) gives no beats after it starts', () => {
  const frames = []
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  for (let i = 0; i < 600; i++) frames.push([0.5 + (rnd() - 0.5) * 0.04, i * FRAME])
  const { beats } = feel(frames)
  assert.ok(beats.every((t) => t < 300), 'only the very start may count: ' + beats.length)
  assert.ok(beats.length <= 1)
})
check('beat: one ding gives at most one beat and no tempo', () => {
  const frames = []
  for (let i = 0; i < 300; i++) frames.push([i >= 100 && i < 103 ? 0.9 : 0.01, i * FRAME])
  const { beats, last } = feel(frames)
  assert.ok(beats.length <= 1)
  assert.strictEqual(last.bpm, 0)
})
check('beat: clipped input (1.0 all along) is no beat storm', () => {
  const frames = []
  for (let i = 0; i < 600; i++) frames.push([1, i * FRAME])
  assert.ok(feel(frames).beats.length <= 1)
})
check('beat: no two beats closer than the minimum gap, even for a buzz', () => {
  const frames = []
  for (let i = 0; i < 300; i++) frames.push([i % 2 ? 0.9 : 0.02, i * FRAME])
  const { beats } = feel(frames)
  for (let i = 1; i < beats.length; i++) assert.ok(beats[i] - beats[i - 1] >= MIN_BEAT_GAP)
})
check('beat: numbers that are not a level are ignored', () => {
  const b = createBeat()
  for (const bad of [NaN, -0.1, 1.5, Infinity, '0.4', null, undefined, {}, [0.4], SECRET]) assert.strictEqual(b.push(bad, 0), null)
  assert.strictEqual(b.push(0.4, NaN), null)
  assert.ok(b.push(0.4, 100))
  assert.strictEqual(b.push(0.4, 50), null, 'time going back')
})
check('beat: the step (quiet / medium / loud) changes only after it held', () => {
  const b = createBeat()
  let t = 0, r
  for (let i = 0; i < 90; i++) { r = b.push(0.9, t); t += FRAME }   // loud for 3 s
  assert.strictEqual(r.level, 2)
  for (let i = 0; i < 15; i++) { r = b.push(0.01, t); t += FRAME } // half a second of near silence
  assert.strictEqual(r.level, 2, 'too soon to change')
  for (let i = 0; i < Math.ceil(LEVEL_HOLD_MS / FRAME) + 30; i++) { r = b.push(0.01, t); t += FRAME }
  assert.strictEqual(r.level, 0)
})
check('beat: energy is a number 0..1 in steps of 0.05', () => {
  const b = createBeat()
  for (const [x, t] of song({ secs: 5 })) {
    const r = b.push(x, t)
    assert.ok(r.energy >= 0 && r.energy <= 1)
    assert.ok(Math.abs(r.energy * 20 - Math.round(r.energy * 20)) < 1e-9, String(r.energy))
    assert.deepStrictEqual(Object.keys(r).sort(), ['beat', 'bpm', 'energy', 'level'])
  }
})
check('beat: reset forgets everything', () => {
  const { b } = feel(song({ secs: 10 }))
  b.reset()
  const r = b.push(0, 0)
  assert.deepStrictEqual([r.energy, r.level, r.bpm, r.beat], [0, 0, 0, false])
})

// ---- the worker's lines --------------------------------------------------------------------------------

check('parser: the two good line shapes pass', () => {
  for (const [line, want] of fixtures.good) assert.deepStrictEqual(parseLine(line), want, line)
})
check('parser: everything else is dropped, song information included', () => {
  for (const line of fixtures.bad) assert.strictEqual(parseLine(line), null, line)
  assert.strictEqual(parseLine('{"l":0.4' + '0'.repeat(30) + '}'), null)
  assert.strictEqual(parseLine('{"l":1e999}'), null)
  for (const bad of [null, undefined, 42, {}, ['{"p":1}']]) assert.strictEqual(parseLine(bad), null)
})
check('parser: the ignore list is cleaned to plain app ids', () => {
  assert.strictEqual(ignoreLine(['Teams', ' VLC.exe ', 'a', '../x;rm', 42, SECRET, 'x'.repeat(80)]), 'ignore teams,vlc.exe,..xrm,synth-secret-')
  assert.strictEqual(ignoreLine(null), 'ignore ')
  assert.strictEqual(ignoreLine(Array(30).fill('spotify')).split(',').length, 20)
})

// ---- the worker's lifecycle (fake worker) ---------------------------------------------------------------

function fakeWorld() {
  const kids = []
  const timers = []
  let t = 0
  function spawnImpl() {
    const c = new EventEmitter()
    c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {}
    c.stderr = new EventEmitter()
    c.stdin = new EventEmitter(); c.stdin.lines = []; c.stdin.write = (s) => { c.stdin.lines.push(s.trim()) }; c.stdin.end = () => { c.ended = true }
    c.kill = () => { c.killed = true }
    c.say = (s) => c.stdout.emit('data', s)
    kids.push(c)
    return c
  }
  return {
    kids, timers, spawnImpl,
    now: () => t, go: (ms) => { t += ms },
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h },
    clearTimer: (h) => { h.cleared = true },
    fire: () => { const h = timers.filter((x) => !x.cleared && !x.done).shift(); if (h) { h.done = true; h.fn() } return h },
  }
}

check('watch: nothing is spawned until start', () => {
  const w = fakeWorld()
  const a = createAudioWatch({ spawnImpl: w.spawnImpl, setTimer: w.setTimer, clearTimer: w.clearTimer, now: w.now })
  assert.strictEqual(w.kids.length, 0)
  a.start(); a.start()
  assert.strictEqual(w.kids.length, 1)
  assert.deepStrictEqual(w.kids[0].stdin.lines, ['ignore', 'rate 0'])
})
check('watch: playing and levels reach the app; levels only after rate(30)', () => {
  const w = fakeWorld()
  const playing = [], levels = []
  const a = createAudioWatch({ spawnImpl: w.spawnImpl, setTimer: w.setTimer, clearTimer: w.clearTimer, now: w.now, onPlaying: (p) => playing.push(p), onLevel: (l) => levels.push(l) })
  a.start()
  const c = w.kids[0]
  c.say('{"p":1}\n{"l":0.3}\n')
  assert.deepStrictEqual(levels, [], 'not asked for yet')
  a.rate(30)
  assert.strictEqual(c.stdin.lines.at(-1), 'rate 30')
  c.say('{"l":0.3}\n{"l":0.')
  c.say('5}\n{"p":1}\n{"p":0}\n')
  a.rate(0)
  c.say('{"l":0.9}\n')
  assert.deepStrictEqual(playing, [true, false])
  assert.deepStrictEqual(levels, [0.3, 0.5])
  a.rate(7)
  assert.strictEqual(a._state().hz, 0, 'only 0 or 30')
})
check('watch: a worker that dies is restarted with backoff, and the backoff resets after a steady run', () => {
  const w = fakeWorld()
  const lines = []
  const playing = []
  const a = createAudioWatch({ spawnImpl: w.spawnImpl, setTimer: w.setTimer, clearTimer: w.clearTimer, now: w.now, log: (s) => lines.push(s), onPlaying: (p) => playing.push(p) })
  a.start()
  w.kids[0].say('{"p":1}\n')
  w.kids[0].emit('exit', 1)
  assert.deepStrictEqual(playing, [true, false], 'a dead worker means nothing known to play')
  assert.strictEqual(w.timers.at(-1).ms, MIN_WAIT)
  w.fire(); w.kids[1].emit('exit', 1)
  assert.strictEqual(w.timers.at(-1).ms, MIN_WAIT * 2)
  for (let i = 0; i < 20; i++) { w.fire(); w.kids.at(-1).emit('exit', 1) }
  assert.strictEqual(w.timers.at(-1).ms, MAX_WAIT)
  w.fire(); w.go(STEADY_MS + 1); w.kids.at(-1).emit('exit', 1)
  assert.strictEqual(w.timers.at(-1).ms, MIN_WAIT)
  assert.ok(lines.every((l) => /^audio watch (started|stopped)/.test(l)))
})
check('watch: stop ends the worker, cancels a pending restart and does not restart', () => {
  const w = fakeWorld()
  const a = createAudioWatch({ spawnImpl: w.spawnImpl, setTimer: w.setTimer, clearTimer: w.clearTimer, now: w.now })
  a.start()
  const c = w.kids[0]
  a.stop()
  assert.ok(c.killed && c.ended)
  assert.strictEqual(c.stdin.lines.at(-1), 'quit')
  c.emit('exit', 0)
  assert.strictEqual(w.timers.length, 0)
  a.start(); w.kids[1].emit('exit', 1)
  const pending = w.timers.at(-1)
  a.stop()
  assert.ok(pending.cleared)
  assert.strictEqual(a.running(), false)
})
check('watch: a spawn that throws is retried, not fatal', () => {
  const w = fakeWorld()
  let n = 0
  const a = createAudioWatch({ spawnImpl: () => { n++; throw new Error('no powershell') }, setTimer: w.setTimer, clearTimer: w.clearTimer, now: w.now })
  a.start()
  assert.strictEqual(n, 1)
  assert.strictEqual(w.timers.length, 1)
  a.stop()
})
check('watch: a flood of junk output is not kept', () => {
  const w = fakeWorld()
  const levels = []
  const a = createAudioWatch({ spawnImpl: w.spawnImpl, setTimer: w.setTimer, clearTimer: w.clearTimer, now: w.now, onLevel: (l) => levels.push(l) })
  a.start(); a.rate(30)
  w.kids[0].say(SECRET.repeat(2000))
  w.kids[0].say('\n{"l":0.2}\n')
  assert.deepStrictEqual(levels, [0.2])
})
check('watch: the ignore list goes to the worker cleaned', () => {
  const w = fakeWorld()
  const a = createAudioWatch({ spawnImpl: w.spawnImpl, setTimer: w.setTimer, clearTimer: w.clearTimer, now: w.now, ignore: ['Teams'] })
  a.start()
  a.setIgnore(['VLC'])
  assert.deepStrictEqual(w.kids[0].stdin.lines, ['ignore teams', 'rate 0', 'ignore vlc'])
})

// ---- the avatar's state with Windows' list ---------------------------------------------------------------

function machine() {
  let t = 5000000
  const m = createAvatarState({ now: () => t })
  return { m, go: (ms) => { t += ms; return m.tick() } }
}

check('state: not tracked (setting off) → Windows reports change nothing', () => {
  const { m } = machine()
  assert.strictEqual(m.systemMusic(true).state, 'idle')
})
check('state: tracked → playing dances, stopping ends it only after the debounce', () => {
  const { m, go } = machine()
  m.trackSystem(true)
  assert.strictEqual(m.systemMusic(true).state, 'dance')
  assert.strictEqual(m.systemMusic(false).state, 'dance')
  assert.strictEqual(m.nextChangeIn(), SYSTEM_STOP_MS)
  assert.strictEqual(go(SYSTEM_STOP_MS - 1).state, 'dance')
  assert.strictEqual(go(2).state, 'idle')
})
check('state: the gap between two songs does not stop the dance', () => {
  const { m, go } = machine()
  m.trackSystem(true)
  m.systemMusic(true); m.systemMusic(false)
  go(1500)
  assert.strictEqual(m.systemMusic(true).state, 'dance')
  assert.strictEqual(go(SYSTEM_STOP_MS * 3).state, 'dance')
})
check('state: turning tracking off stops the system dance at once', () => {
  const { m } = machine()
  m.trackSystem(true); m.systemMusic(true)
  assert.strictEqual(m.trackSystem(false).state, 'idle')
})
check('state: HELPER music still dances with tracking off, 10 minutes as before', () => {
  const { m, go } = machine()
  assert.strictEqual(m.music(true).state, 'dance')
  assert.strictEqual(go(MUSIC_MAX_MS - 1).state, 'dance')
  assert.strictEqual(go(2).state, 'idle')
})
check('state: tracked, HELPER music ends early once Windows lists nothing playing (after the grace)', () => {
  const { m, go } = machine()
  m.trackSystem(true)
  m.music(true)
  assert.strictEqual(go(HELPER_GRACE_MS - 1).state, 'dance', 'the browser gets time to start')
  assert.strictEqual(go(2).state, 'idle')
})
check('state: tracked, HELPER music keeps dancing while Windows says playing, ends after quiet', () => {
  const { m, go } = machine()
  m.trackSystem(true)
  m.music(true)
  go(5000); m.systemMusic(true)
  assert.strictEqual(go(5 * 60000).state, 'dance')
  m.systemMusic(false)
  assert.strictEqual(go(HELPER_QUIET_MS - 1).state, 'dance')
  assert.strictEqual(go(2).state, 'idle')
})
check('state: alert and HELPER speaking still win over a system dance', () => {
  const { m, go } = machine()
  m.trackSystem(true); m.systemMusic(true)
  assert.strictEqual(m.event({ type: 'alert' }).state, 'alert')
  go(10000)
  assert.deepStrictEqual(m.activity('speak'), { state: 'react', variant: 'speak' })
  assert.strictEqual(m.activity(null).state, 'dance')
  assert.strictEqual(m.event({ type: 'message' }).variant, 'wave')
  assert.strictEqual(go(REACT_MS + 1).state, 'dance')
})
check('state: Windows reports that are not true/false count as not playing', () => {
  const { m } = machine()
  m.trackSystem(true)
  for (const bad of [1, 'yes', SECRET, {}, null]) assert.strictEqual(m.systemMusic(bad).state, 'idle')
})

// ---- the window ------------------------------------------------------------------------------------------

check('window: a level message becomes numbers only, clamped', () => {
  const { levelView } = avatarView
  assert.deepStrictEqual(levelView({ e: 0.43, b: 1, k: 1, t: 120 }), { energy: 0.45, step: 1, beat: true, beatSec: 0.5 })
  assert.deepStrictEqual(levelView({ e: 5, b: 0, k: 2, t: 160 }), { energy: 1, step: 2, beat: false, beatSec: 0.75 })
  assert.deepStrictEqual(levelView({ e: -1, k: 0, t: 0 }), { energy: 0, step: 0, beat: false, beatSec: null })
  assert.deepStrictEqual(levelView({ e: SECRET, b: 'x', k: 0, t: SECRET }), { energy: 0, step: 0, beat: false, beatSec: null })
  assert.deepStrictEqual(levelView({ e: 0.5, k: 0, t: 500 }).beatSec, null, 'tempo out of range')
})
check('window: no step means no live moves (the dance as before)', () => {
  for (const m of [null, undefined, {}, { k: -1 }, { k: 3 }, { k: '1' }, { e: 0.5 }, SECRET]) assert.strictEqual(avatarView.levelView(m), null)
})
check('window: the level handler never writes text, and the stage has the live styles', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'ui', 'avatar.js'), 'utf8')
  assert.ok(!/textContent|innerHTML|innerText|insertAdjacent|document\.write/.test(js))
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'avatar.html'), 'utf8')
  assert.ok(html.includes('id="stage"') && html.includes('id="amp"'))
  for (const k of ['bounceLo', 'bounceHi', 'chipDanceLo', 'chipDanceHi', 'swayLo', 'swayHi']) assert.ok(html.includes('@keyframes ' + k), k)
  const preload = fs.readFileSync(path.join(__dirname, '..', 'ui', 'preload.js'), 'utf8')
  assert.ok(/'avatar-level'/.test(preload))
})

// ---- leaks -------------------------------------------------------------------------------------------------

check('leak: the worker never asks for the song, never opens an audio stream, never writes or sends', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  for (const bad of ['TryGetMediaPropertiesAsync', 'MediaProperties', 'Thumbnail', 'Title', 'Artist', 'IAudioCaptureClient', 'IAudioClient', 'AUDCLNT_STREAMFLAGS_LOOPBACK', 'Out-File', 'Set-Content', 'Add-Content', 'Start-Transcript', 'Invoke-WebRequest', 'Invoke-RestMethod', 'WebClient', 'HttpClient', 'Net.Sockets', 'File]::', 'System.IO.File', 'Tee-Object', 'Export-']) {
    assert.ok(!src.includes(bad), 'audio-watch.ps1 has ' + bad)
  }
  assert.ok(src.includes('IAudioMeterInformation') && src.includes('GetPeakValue') && src.includes('PlaybackStatus'))
  assert.ok(!/[^\x00-\x7F]/.test(src), 'ASCII only for PowerShell 5.1')
})
check('leak: 1,000 synthetic lines with song text reach no file, console, network or log', () => {
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, fetch: global.fetch }
  const fsNames = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream']
  const fsOrig = {}
  const hits = []
  const trap = (name) => (...a) => { hits.push(name + ' ' + a.map(String).join(' ')) }
  for (const n of fsNames) { fsOrig[n] = fs[n]; fs[n] = trap('fs.' + n) }
  console.log = console.error = console.warn = console.info = trap('console')
  global.fetch = trap('fetch')
  const logged = []
  try {
    const w = fakeWorld()
    const sent = []
    const b = createBeat()
    const a = createAudioWatch({ spawnImpl: w.spawnImpl, setTimer: w.setTimer, clearTimer: w.clearTimer, now: w.now, log: (s) => logged.push(s), onLevel: (x) => { const r = b.push(x, w.now()); w.go(FRAME); if (r) sent.push(r) } })
    a.start(); a.rate(30)
    let chunk = ''
    for (let i = 0; i < 1000; i++) chunk += (i % 3 ? '{"l":0.' + String(100 + (i % 800)).slice(1) + '}\n' : '{"p":1,"title":"' + SECRET + '"}\n')
    w.kids[0].say(chunk)
    w.kids[0].emit('exit', 1)
    a.stop()
    assert.ok(sent.length > 600, 'the levels went through: ' + sent.length)
    for (const r of sent) assert.ok(!JSON.stringify(r).includes('SYNTH'))
  } finally {
    for (const n of fsNames) fs[n] = fsOrig[n]
    Object.assign(console, { log: orig.log, error: orig.error, warn: orig.warn, info: orig.info })
    global.fetch = orig.fetch
  }
  assert.deepStrictEqual(hits, [])
  for (const l of logged) assert.ok(!/SYNTH|0\.\d/.test(l), 'log line: ' + l)
})
check('leak: main.js sends levels only on the avatar-level channel and never logs them', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const start = main.indexOf('function avatarLevelIn')
  const body = main.slice(start, main.indexOf('\n}\n', start))
  assert.ok(start > 0 && !/log\(|console\./.test(body))
  assert.ok(/send\('avatar-level', msg\)/.test(main))
  assert.ok(/avatarSystemMusic && process\.platform === 'win32'/.test(main), 'the worker needs the setting')
})
check('setting: both are off by default and the ignore list is empty', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8')
  assert.ok(/avatarSystemMusic: false/.test(src) && /avatarBeat: false/.test(src) && /avatarMusicIgnore: \[\]/.test(src))
})

;(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++ } catch (e) { failed++; console.log('FAIL', name, '\n  ', e.message) }
  }
  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
