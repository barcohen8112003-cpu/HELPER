// Offline checks for the live avatar: the state machine, the cloud event client, the setting, and that the avatar
// window can only show a state, never event content. Synthetic events only: no real server, no real messages.
// Run: node test/avatar-check.js (from desktop/), or npm run check.
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createAvatarState, actionFor, activityFor, musicFromStep, STATES, VARIANTS, EVENT_TYPES, REACT_MS, ALERT_MS, MUSIC_MAX_MS } = require('../src/avatar-state')
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
  const msgs = [{ state: SECRET }, { state: 'react', variant: SECRET }, { state: 'alert', text: SECRET, sender: SENDER }, { state: '<img src=x onerror=1>' }, null, 'alert', { state: 'idle', label: SECRET }, { state: 'react', variant: 'think', design: SECRET }, { state: 'dance', design: '"><script>' }]
  for (const m of msgs) {
    const v = avatarView.view(m)
    const all = JSON.stringify(v)
    assert.ok(!all.includes('SYNTH') && !all.includes('<img'), all)
    assert.ok(/^avatar s-(idle|dance|react|alert)( v-(wave|work|done|listen|think|speak))?( paused)?$/.test(v.className), v.className)
    assert.ok(avatarView.DESIGNS.includes(v.design), v.design)
    assert.ok(Object.values(avatarView.LABELS).includes(v.label) || Object.values(avatarView.VARIANT_LABELS).includes(v.label))
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

// ---- the three designs -----------------------------------------------------------------------------------

const DESIGNS = ['orb', 'chip', 'figure']
const ALL_LOOKS = [['idle', ''], ['dance', ''], ['alert', ''], ...VARIANTS.map((v) => ['react', v])]

check('designs: three, chosen by one attribute, default orb; the window and the app agree on the names', () => {
  assert.deepStrictEqual(avatarView.DESIGNS, DESIGNS)
  assert.deepStrictEqual(avatarView.VARIANTS, VARIANTS)
  assert.strictEqual(avatarView.view({}).design, 'orb')
  for (const d of DESIGNS) assert.strictEqual(avatarView.view({ design: d }).design, d)
  assert.strictEqual(avatarView.view({ design: 'robot' }).design, 'orb')
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'avatar.html'), 'utf8')
  assert.ok(/<body data-design="orb">/.test(html))
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(/const AVATAR_DESIGNS = \['orb', 'chip', 'figure'\]/.test(main))
})
check('designs: every design has its own rule for every state and variant', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'avatar.html'), 'utf8')
  for (const d of DESIGNS) {
    for (const [st, v] of ALL_LOOKS) {
      const sel = v ? `[data-design="${d}"] .v-${v}` : `[data-design="${d}"] .s-${st}`
      assert.ok(html.includes(sel), sel)
    }
  }
})
check('designs: no faces, no pictures, the alert is red in all of them', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'avatar.html'), 'utf8')
  assert.ok(!/class="(eye|mouth)/.test(html) && !/\.eye|\.mouth/.test(html))
  assert.ok(/\.s-alert \{ --accent: #FF5A5F/.test(html))
})

let pw = null
try { pw = require('playwright') } catch { }
check('designs: each design renders every state in a real browser (skipped without Playwright)', async () => {
  if (!pw) { console.log('SKIP designs render: no Playwright here'); return }
  const browser = await pw.chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 140, height: 170 } })
    await page.goto('file://' + path.join(__dirname, '..', 'ui', 'avatar.html').replace(/\\/g, '/'))
    for (const d of DESIGNS) {
      const seen = new Set()
      for (const [st, v] of ALL_LOOKS) {
        const r = await page.evaluate(([d, cls]) => {
          document.body.setAttribute('data-design', d)
          const el = document.getElementById('avatar')
          el.className = cls
          const core = el.querySelector('.core').getBoundingClientRect()
          const cs = getComputedStyle(el)
          return { w: core.width, h: core.height, accent: cs.getPropertyValue('--accent').trim(), anim: cs.animationName, ring: getComputedStyle(el.querySelector('.ring')).animationName, text: document.body.innerText.trim() }
        }, [d, 'avatar s-' + st + (v ? ' v-' + v : '')])
        assert.ok(r.w > 20 && r.h > 20, `${d} ${st}/${v}: the shape is there`)
        assert.ok(r.text === '' || r.text === 'H', `${d}: no text but the chip's H (${r.text})`)
        seen.add(`${r.accent}|${r.anim}|${r.ring}`)
      }
      assert.ok(seen.size >= 7, `${d}: the states look different (${seen.size} distinct)`)
    }
  } finally { await browser.close() }
})

// ---- the app's own state mirrored ----------------------------------------------------------------------

check('local state: the app\'s modes map to the avatar', () => {
  const table = [
    [{ mode: 'idle' }, null],
    [{ mode: 'listening' }, 'listen'],
    [{ mode: 'dictating' }, 'listen'],
    [{ mode: 'typing' }, 'listen'],
    [{ mode: 'pointing' }, 'listen'],
    [{ mode: 'thinking' }, 'think'],
    [{ mode: 'thinking', working: true }, 'work'],
    [{ mode: 'idle', working: true }, 'work'],
    [{ mode: 'idle', speaking: true }, 'speak'],
    [{ mode: 'thinking', speaking: true, working: true }, 'speak'],
    [{ mode: 'listening', speaking: true }, 'listen'],
    [{ mode: 'nonsense' }, null],
    [null, null],
    [{ mode: 'idle', speaking: 'yes', working: 1 }, null],
  ]
  for (const [app, want] of table) assert.strictEqual(activityFor(app), want, JSON.stringify(app))
})
check('local state: shown as react variants, back to idle (or dancing) when HELPER is done', () => {
  const { m } = machine()
  assert.deepStrictEqual(m.activity('listen'), { state: 'react', variant: 'listen' })
  assert.deepStrictEqual(m.activity('think'), { state: 'react', variant: 'think' })
  assert.deepStrictEqual(m.activity('work'), { state: 'react', variant: 'work' })
  assert.deepStrictEqual(m.activity('speak'), { state: 'react', variant: 'speak' })
  assert.deepStrictEqual(m.activity(null), { state: 'idle', variant: '' })
  m.music(true)
  assert.strictEqual(m.activity('think').variant, 'think', 'talking to HELPER wins over the dance')
  assert.strictEqual(m.activity(null).state, 'dance')
  assert.strictEqual(m.activity(SECRET).state, 'dance', 'an unknown activity is nothing')
})
check('local state: an event burst and an alert sit on top, then it goes back to what HELPER is doing', () => {
  const { m, go } = machine()
  m.activity('think')
  assert.strictEqual(m.event({ type: 'message' }).variant, 'wave')
  assert.strictEqual(go(REACT_MS + 1).variant, 'think')
  assert.strictEqual(m.event({ type: 'alert' }).state, 'alert')
  assert.strictEqual(m.activity('work').state, 'alert', 'the alert is not cut short')
  assert.strictEqual(go(ALERT_MS + 1).variant, 'work')
})
check('main: mirrors mode, voice and hands; click talks through the bubble; right-click menu; design sent by name', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(/activityFor\(\{ mode, speaking: avatarSpeaking, working: avatarSteps > 0 \}\)/.test(main))
  assert.ok(/setAvatarSpeaking\(\/\^playing\/\.test\(String\(s\)\)\)/.test(main), 'voice from the bubble')
  assert.ok(/if \(ev\.phase === 'start'\) avatarSteps\+\+/.test(main), 'hands steps counted')
  assert.ok(/function avatarClick\(\) \{\s*if \(mode === 'idle'\) return startTyping\(\)/.test(main), 'click = the bubble\'s own typing box')
  assert.ok(/ipcMain\.on\('avatar-click'/.test(main) && /ipcMain\.on\('avatar-menu'/.test(main))
  for (const item of ['לדבר עם HELPER', 'להקליד ל-HELPER', 'להסתיר את האווטאר', 'כל ההגדרות של HELPER…', 'עיצוב']) assert.ok(main.includes(item), item)
  assert.ok(/const msg = \{ state: s\.state, variant: s\.variant \|\| '', design: avatarDesign\(\) \}/.test(main), 'the window gets names only')
  const hands = fs.readFileSync(path.join(__dirname, '..', 'src', 'hands.js'), 'utf8')
  assert.ok(/tell\(\{ phase: 'start', cmd: step\.cmd, args \}\)/.test(hands) && /finally \{\s*tell\(\{ phase: 'end', cmd: step\.cmd, args, ok \}\)/.test(hands), 'every step tells start and end, failed ones too')
  const bubble = fs.readFileSync(path.join(__dirname, '..', 'ui', 'bubble.js'), 'utf8')
  assert.ok(/addEventListener\('ended', \(\) => helper\.send\('voice-state', 'ended'\)\)/.test(bubble))
})
check('music: a step event from hands (phase, ok) still reads as music', () => {
  assert.strictEqual(musicFromStep({ phase: 'end', ok: true, cmd: 'play', args: { query: 'x' } }), true)
  assert.strictEqual(musicFromStep({ phase: 'end', ok: true, cmd: 'media', args: { op: 'pause' } }), false)
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
  assert.strictEqual(s.avatarDesign, 'orb')
  store.saveSettings({ avatarEnabled: true, avatarPos: { x: 10, y: 20 }, avatarDesign: 'figure' })
  delete require.cache[require.resolve('../src/store')]
  const again = require('../src/store')
  again.init(dir)
  assert.strictEqual(again.settings().avatarEnabled, true)
  assert.deepStrictEqual(again.settings().avatarPos, { x: 10, y: 20 })
  assert.strictEqual(again.settings().avatarDesign, 'figure')
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
  assert.ok(/onEvent: \(ev\) => \{? ?avatarEvent\(\{ type: ev\.type \}\)(; ibailaEvent\(ev\.type\) \})?,/.test(apply), 'only the type goes on')
  assert.ok(/label: 'להציג את האווטאר', type: 'checkbox', checked: s\.avatarEnabled/.test(main), 'tray toggle')
  assert.ok(/hands\.onStep\(/.test(main), 'music signal from HELPER\'s own steps')
})
check('preload: the avatar channels are named, nothing more', () => {
  const pre = fs.readFileSync(path.join(__dirname, '..', 'ui', 'preload.js'), 'utf8')
  assert.ok(/const IN = new Set\(\[[^\]]*'avatar'[^\]]*\]\)/.test(pre))
  assert.ok(/'avatar-hover', 'avatar-drag', 'avatar-click', 'avatar-menu'\]\)/.test(pre))
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
