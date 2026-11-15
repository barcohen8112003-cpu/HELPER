// Offline checks for the live avatar: the state machine, the cloud event client, the setting, and that the avatar
// window can only show a state, never event content. Synthetic events only: no real server, no real messages.
// Run: node test/avatar-check.js (from desktop/), or npm run check.
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createAvatarState, actionFor, musicFromStep, STATES, EVENT_TYPES, REACT_MS, ALERT_MS, MUSIC_MAX_MS } = require('../src/avatar-state')
const { createAvatarFeed, cleanUrl, validCredential, MIN_WAIT, MAX_WAIT, SLOW_WAIT, POLL_GAP } = require('../src/avatar-feed')
const avatarView = require('../ui/avatar.js')

let passed = 0, failed = 0
const queue = []
function check(name, fn) { queue.push([name, fn]) }

const SECRET = 'SYNTH-SECRET-תוכן-ההודעה'
const SENDER = 'SYNTH-שולח'
const CRED = 'hpn_0123456789_' + 'A'.repeat(32)

// ---- the state machine -------------------------------------------------------------------------------

check('state: four states, four event types', () => {
  assert.deepStrictEqual(STATES, ['idle', 'dance', 'react', 'alert'])
  assert.deepStrictEqual(EVENT_TYPES, ['message', 'task-start', 'task-end', 'alert'])
})
check('state: each type maps to its animation', () => {
  assert.deepStrictEqual(actionFor('message'), { state: 'react', variant: 'wave' })
  assert.deepStrictEqual(actionFor('task-start'), { state: 'react', variant: 'work' })
  assert.deepStrictEqual(actionFor('task-end'), { state: 'react', variant: 'done' })
  assert.deepStrictEqual(actionFor('alert'), { state: 'alert', variant: '' })
  for (const bad of ['', 'nope', SECRET, null, undefined, 42, { type: 'alert' }, '__proto__', 'constructor']) assert.strictEqual(actionFor(bad), null)
})

function machine() {
  let t = 1000000
  const seen = []
  const m = createAvatarState({ now: () => t, onChange: (s) => seen.push(s) })
  return { m, seen, at: () => t, go: (ms) => { t += ms; return m.tick() } }
}

check('state: starts idle', () => {
  const { m } = machine()
  assert.deepStrictEqual(m.tick(), { state: 'idle', variant: '' })
})
check('state: a message waves, then back to idle by itself', () => {
  const { m, go } = machine()
  assert.deepStrictEqual(m.event({ type: 'message' }), { state: 'react', variant: 'wave' })
  assert.strictEqual(m.nextChangeIn(), REACT_MS)
  assert.strictEqual(go(REACT_MS - 1).state, 'react')
  assert.deepStrictEqual(go(2), { state: 'idle', variant: '' })
  assert.strictEqual(m.nextChangeIn(), null)
})
check('state: task start and end react with their own variants', () => {
  const { m } = machine()
  assert.strictEqual(m.event({ type: 'task-start' }).variant, 'work')
  assert.strictEqual(m.event({ type: 'task-end' }).variant, 'done')
})
check('state: an alert jumps, stops on its own', () => {
  const { m, go } = machine()
  assert.strictEqual(m.event({ type: 'alert' }).state, 'alert')
  assert.strictEqual(go(ALERT_MS - 1).state, 'alert')
  assert.strictEqual(go(2).state, 'idle')
})
check('state: a react never cuts an alert short; an alert replaces a react', () => {
  const { m, go } = machine()
  m.event({ type: 'alert' })
  go(1000)
  assert.strictEqual(m.event({ type: 'message' }).state, 'alert')
  go(ALERT_MS)
  assert.strictEqual(m.tick().state, 'idle')
  m.event({ type: 'message' })
  assert.strictEqual(m.event({ type: 'alert' }).state, 'alert')
})
check('state: music dances, and after a react or alert it goes back to dancing', () => {
  const { m, go } = machine()
  assert.strictEqual(m.music(true).state, 'dance')
  assert.strictEqual(m.event({ type: 'message' }).state, 'react')
  assert.strictEqual(go(REACT_MS + 1).state, 'dance')
  m.event({ type: 'alert' })
  assert.strictEqual(go(ALERT_MS + 1).state, 'dance')
  assert.strictEqual(m.music(false).state, 'idle')
})
check('state: play/pause toggles; the dance ends by itself after the cap', () => {
  const { m, go } = machine()
  assert.strictEqual(m.music('toggle').state, 'dance')
  assert.strictEqual(m.music('toggle').state, 'idle')
  m.music(true)
  assert.strictEqual(go(MUSIC_MAX_MS - 1).state, 'dance')
  assert.strictEqual(go(2).state, 'idle')
})
check('state: unknown events change nothing', () => {
  const { m } = machine()
  for (const bad of [{ type: 'nope' }, { text: SECRET }, null, 'message-x', { type: { toString: () => 'alert' } }]) assert.strictEqual(m.event(bad).state, 'idle')
})
check('state: onChange gets only {state, variant}, never what the event carried', () => {
  const { m, seen } = machine()
  m.event({ type: 'message', text: SECRET, sender: SENDER, group: 'SYNTH-group' })
  m.event({ type: 'alert', title: SECRET })
  assert.ok(seen.length >= 2)
  for (const s of seen) assert.deepStrictEqual(Object.keys(s).sort(), ['state', 'variant'])
  assert.ok(!JSON.stringify(seen).includes('SYNTH'))
})
check('state: onChange only when the state changes', () => {
  const { m, seen } = machine()
  m.tick(); m.tick(); m.tick()
  assert.strictEqual(seen.length, 1)
})
check('music: what HELPER\'s own steps mean', () => {
  assert.strictEqual(musicFromStep({ cmd: 'play', args: { query: 'שיר' } }), true)
  assert.strictEqual(musicFromStep({ cmd: 'media', args: { op: 'play' } }), true)
  assert.strictEqual(musicFromStep({ cmd: 'media', args: { op: 'next' } }), true)
  assert.strictEqual(musicFromStep({ cmd: 'media', args: { op: 'pause' } }), false)
  assert.strictEqual(musicFromStep({ cmd: 'media', args: { op: 'stop' } }), false)
  assert.strictEqual(musicFromStep({ cmd: 'media', args: { op: 'toggle' } }), 'toggle')
  assert.strictEqual(musicFromStep({ cmd: 'open', args: { name: 'ספוטיפיי' } }), null)
  assert.strictEqual(musicFromStep({ cmd: 'volume', args: { op: 'up' } }), null)
  assert.strictEqual(musicFromStep(null), null)
})

// ---- the avatar window shows a state, never content ------------------------------------------------------

check('view: each state is a class and a fixed label', () => {
  for (const s of ['idle', 'dance', 'react', 'alert']) {
    const v = avatarView.view({ state: s })
    assert.ok(v.className.includes('s-' + s))
    assert.strictEqual(v.label, avatarView.LABELS[s])
  }
  assert.ok(avatarView.view({ state: 'react', variant: 'wave' }).className.includes('v-wave'))
  assert.ok(avatarView.view({ state: 'idle', paused: true }).className.includes('paused'))
})
check('view: unknown states and variants fall back; content never appears', () => {
  const msgs = [{ state: SECRET }, { state: 'react', variant: SECRET }, { state: 'alert', text: SECRET, sender: SENDER }, { state: '<img src=x onerror=1>' }, null, 'alert', { state: 'idle', label: SECRET }]
  for (const m of msgs) {
    const v = avatarView.view(m)
    const all = JSON.stringify(v)
    assert.ok(!all.includes('SYNTH') && !all.includes('<img'), all)
    assert.ok(/^avatar s-(idle|dance|react|alert)( v-(wave|work|done))?( paused)?$/.test(v.className), v.className)
    assert.ok(Object.values(avatarView.LABELS).includes(v.label))
  }
})
check('view: avatar.js never writes text or HTML it was sent', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'ui', 'avatar.js'), 'utf8')
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'textContent', 'innerText', 'document.write', 'eval(', 'new Function']) assert.ok(!js.includes(bad), bad)
  assert.ok(/el\.className = v\.className/.test(js) && /setAttribute\('aria-label', v\.label\)/.test(js))
})
check('view: avatar.html is self-contained: strict CSP, no outside fonts, images or scripts, Hebrew rtl', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'avatar.html'), 'utf8')
  assert.ok(html.includes(`content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"`))
  assert.ok(/<html lang="he" dir="rtl">/.test(html))
  assert.ok(!/https?:\/\//.test(html) && !/@import|url\(|<img|<link|@font-face/.test(html))
  assert.ok(/<script src="avatar\.js"><\/script>/.test(html) && (html.match(/<script/g) || []).length === 1)
  for (const s of ['idle', 'dance', 'react', 'alert']) assert.ok(html.includes('.s-' + s), s)
  assert.ok(/\.paused, \.paused \* \{ animation-play-state: paused/.test(html))
})

// ---- the setting --------------------------------------------------------------------------------

check('setting: off by default, persists when turned on, and off again', () => {
  delete require.cache[require.resolve('../src/store')]
  const store = require('../src/store')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-avatar-'))
  store.init(dir)
  const s = store.settings()
  assert.strictEqual(s.avatarEnabled, false)
  assert.strictEqual(s.avatarEvents, false)
  assert.strictEqual(s.avatarCredential, '')
  assert.strictEqual(s.avatarPos, null)
  store.saveSettings({ avatarEnabled: true, avatarPos: { x: 10, y: 20 } })
  delete require.cache[require.resolve('../src/store')]
  const again = require('../src/store')
  again.init(dir)
  assert.strictEqual(again.settings().avatarEnabled, true)
  assert.deepStrictEqual(again.settings().avatarPos, { x: 10, y: 20 })
  assert.strictEqual(again.settings().avatarEvents, false)
  again.saveSettings({ avatarEnabled: false })
  assert.strictEqual(again.settings().avatarEnabled, false)
})

// ---- the app wiring (read from main.js: it needs Electron to run) ----------------------------------------

check('main: the avatar window follows the other windows: frameless, transparent, on top, no taskbar, no focus', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const make = main.slice(main.indexOf('function makeAvatar()'), main.indexOf('function avatarTick()'))
  for (const want of ['frame: false', 'transparent: true', 'skipTaskbar: true', 'alwaysOnTop: true', 'focusable: false', 'contextIsolation: true', 'nodeIntegration: false', "setIgnoreMouseEvents(true, { forward: true })", 'showInactive()', "'avatar.html'"]) assert.ok(make.includes(want), want)
  assert.ok(!/\.focus\(\)|\.show\(\)/.test(make), 'never takes focus')
})
check('main: the avatar starts only when turned on; off destroys it', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const apply = main.slice(main.indexOf('function applyAvatar()'), main.indexOf('// ---- talking'))
  assert.ok(/if \(!s\.avatarEnabled\) \{[\s\S]*avatarWin\.destroy\(\)/.test(apply))
  assert.ok(/const want = s\.avatarEnabled && s\.avatarEvents/.test(apply))
  assert.ok(/onEvent: \(ev\) => avatarEvent\(\{ type: ev\.type \}\)/.test(apply), 'only the type goes on')
  assert.ok(/label: 'להציג את האווטאר', type: 'checkbox', checked: s\.avatarEnabled/.test(main), 'tray toggle')
  assert.ok(/hands\.onStep\(/.test(main), 'music signal from HELPER\'s own steps')
})
check('preload: the avatar channels are named, nothing more', () => {
  const pre = fs.readFileSync(path.join(__dirname, '..', 'ui', 'preload.js'), 'utf8')
  assert.ok(/const IN = new Set\(\[[^\]]*'avatar'[^\]]*\]\)/.test(pre))
  assert.ok(/'avatar-hover', 'avatar-drag'\]\)/.test(pre))
})

// ---- the cloud event client (a scripted fetch: no server) ----------------------------------------------

check('feed: address and code checks', () => {
  assert.strictEqual(cleanUrl('https://panel.example.com/'), 'https://panel.example.com')
  assert.strictEqual(cleanUrl('http://127.0.0.1:3214'), 'http://127.0.0.1:3214')
  assert.strictEqual(cleanUrl('http://panel.example.com'), null, 'no plain http to another host')
  assert.strictEqual(cleanUrl('https://u:p@panel.example.com'), null)
  assert.strictEqual(cleanUrl('https://panel.example.com/?t=1'), null)
  assert.strictEqual(cleanUrl('nonsense'), null)
  assert.ok(validCredential(CRED) && !validCredential('') && !validCredential('abc') && !validCredential('hpn_x_y'))
})

function scripted(responses) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const r = responses.shift()
    if (r instanceof Error) throw r
    return { status: r.status, json: async () => r.body }
  }
  return { calls, fetchImpl }
}

check('feed: not set: never calls anything', async () => {
  const { calls, fetchImpl } = scripted([])
  const f = createAvatarFeed({ url: '', credential: CRED, fetchImpl })
  assert.strictEqual(await f.runOnce(), SLOW_WAIT)
  assert.strictEqual(f.status(), 'not-set')
  const g = createAvatarFeed({ url: 'https://panel.example.com', credential: 'bad', fetchImpl })
  await g.runOnce()
  assert.strictEqual(calls.length, 0)
})
check('feed: first call has no cursor, then follows the server\'s; only type and severity are passed on', async () => {
  const got = []
  const { calls, fetchImpl } = scripted([
    { status: 200, body: { ok: true, events: [], cursor: 7 } },
    { status: 200, body: { ok: true, cursor: 9, events: [
      { id: 8, type: 'message', severity: 'normal', at: '2026-11-15T10:00:00Z', text: SECRET, sender: SENDER },
      { id: 9, type: 'alert', severity: 'weird', at: '2026-11-15T10:00:01Z' },
      { id: 10, type: SECRET, severity: 'high' },
      { id: 11, type: 'music', severity: 'low' },
    ] } },
  ])
  const f = createAvatarFeed({ url: 'https://panel.example.com', credential: CRED, fetchImpl, onEvent: (e) => got.push(e) })
  assert.strictEqual(await f.runOnce(), POLL_GAP)
  assert.strictEqual(calls[0].url, 'https://panel.example.com/panel/api/events')
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer ' + CRED)
  assert.ok(!('Last-Event-ID' in calls[0].headers))
  assert.strictEqual(await f.runOnce(), POLL_GAP)
  assert.strictEqual(calls[1].headers['Last-Event-ID'], '7')
  assert.deepStrictEqual(got, [{ type: 'message', severity: 'normal' }, { type: 'alert', severity: 'normal' }])
  assert.ok(!JSON.stringify(got).includes('SYNTH'))
  assert.strictEqual(f._state().cursor, 9)
  assert.strictEqual(f.status(), 'connected')
})
check('feed: server unreachable: growing waits with jitter, one log line per change of state', async () => {
  const lines = []
  const down = Array.from({ length: 12 }, () => new Error('ECONNREFUSED'))
  const { fetchImpl } = scripted([...down, { status: 200, body: { events: [], cursor: 1 } }])
  const f = createAvatarFeed({ url: 'https://panel.example.com', credential: CRED, fetchImpl, log: (l) => lines.push(l), random: () => 1 })
  const waits = []
  for (let i = 0; i < 12; i++) waits.push(await f.runOnce())
  assert.strictEqual(waits[0], MIN_WAIT)
  for (let i = 1; i < waits.length; i++) assert.ok(waits[i] >= waits[i - 1])
  assert.strictEqual(waits.at(-1), MAX_WAIT)
  assert.strictEqual(lines.filter((l) => /unreachable/.test(l)).length, 1, 'no error spam')
  assert.strictEqual(await f.runOnce(), POLL_GAP)
  assert.strictEqual(f._state().failures, 0)
  assert.strictEqual(lines.filter((l) => /connected/.test(l)).length, 1)
  const half = createAvatarFeed({ url: 'https://panel.example.com', credential: CRED, fetchImpl: scripted([new Error('x')]).fetchImpl, random: () => 0 })
  assert.strictEqual(await half.runOnce(), MIN_WAIT / 2, 'jitter takes up to half off')
})
check('feed: 403 (no scope), 404 (feed off), 429 and a broken body are handled quietly', async () => {
  const { fetchImpl } = scripted([{ status: 403, body: {} }, { status: 404, body: {} }, { status: 429, body: { retryAfter: 12 } }, { status: 200, body: { nope: true } }, { status: 500, body: {} }])
  const statuses = []
  const f = createAvatarFeed({ url: 'https://panel.example.com', credential: CRED, fetchImpl, onStatus: (s) => statuses.push(s), random: () => 1 })
  assert.strictEqual(await f.runOnce(), SLOW_WAIT)
  assert.strictEqual(f.status(), 'denied')
  assert.strictEqual(await f.runOnce(), SLOW_WAIT)
  assert.strictEqual(f.status(), 'off')
  assert.strictEqual(await f.runOnce(), 12000)
  assert.strictEqual(await f.runOnce(), MIN_WAIT)
  assert.strictEqual(f.status(), 'unreachable')
  assert.ok((await f.runOnce()) > MIN_WAIT)
  assert.deepStrictEqual(statuses, ['denied', 'off', 'unreachable'])
})
check('feed: start/stop runs one loop and stops cleanly', async () => {
  let n = 0
  const fetchImpl = async () => { n++; return { status: 200, json: async () => ({ events: [], cursor: n }) } }
  const sleeps = []
  const f = createAvatarFeed({ url: 'https://panel.example.com', credential: CRED, fetchImpl, sleep: (ms) => { sleeps.push(ms); return new Promise((r) => setImmediate(r)) } })
  f.start(); f.start()
  await new Promise((r) => setImmediate(r))
  f.stop()
  const after = n
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(n <= after + 1, 'stopped')
  assert.strictEqual(f.status(), 'stopped')
})

;(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++ } catch (e) { failed++; console.log('FAIL', name, '\n  ', e.message) }
  }
  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
