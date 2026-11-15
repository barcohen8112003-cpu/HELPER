// Offline checks for the link with iBaila (Glowbeat) on this PC: the client (src/ibaila-link.js) against a fake
// iBaila on 127.0.0.1, the Hebrew light commands (src/lights.js), and that only state names, event types and fixed
// light actions ever leave HELPER. Synthetic data only: no real iBaila, no lamps, no real messages.
// Run: node test/ibaila-check.js (from desktop/), or npm run check.
'use strict'
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const link = require('../src/ibaila-link')
const { createIbailaLink, cleanUrl, cleanAction, cleanStatus, validToken, HEARTBEAT } = link
const lights = require('../src/lights')
const instant = require('../src/instant')

let passed = 0, failed = 0
const queue = []
const check = (name, fn) => queue.push([name, fn])
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

const TOKEN = 'synthetic_link_code_' + 'A'.repeat(24)
const SECRET = 'SYNTH-SECRET-תוכן-ההודעה'
const SENDER = 'SYNTH-שולח'
const GROUP = 'SYNTH-קבוצה'

// ---- a fake iBaila --------------------------------------------------------------------------------------

async function fakeIbaila({ status = 200, lightReply = { ok: true, lamps: 1 }, statusBody = null, stream = null } = {}) {
  const reqs = []
  const streams = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      reqs.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (status !== 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end('{}'); return }
      if (req.url === '/helper/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        streams.push(res)
        if (stream) stream(res)
        return
      }
      if (req.url === '/helper/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(statusBody || { music: false, playing: false, sync: true, lamps: 2, rooms: { 'my-room': 'on', bedroom: 'off' } })); return }
      if (req.url === '/helper/light') { res.writeHead(lightReply.ok ? 200 : 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(lightReply)); return }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = 'http://127.0.0.1:' + server.address().port
  return {
    url, reqs, streams,
    posts: (p) => reqs.filter((r) => r.method === 'POST' && (!p || r.url === p)),
    close: () => new Promise((r) => { for (const s of streams) try { s.destroy() } catch { } server.closeAllConnections && server.closeAllConnections(); server.close(() => r()) }),
  }
}
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await tick(10) } return false }

// ---- settings and addresses ----------------------------------------------------------------------------

check('settings: the link is off by default, with no code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibaila-check-'))
  const store = require('../src/store')
  store.init(dir)
  const s = store.settings()
  assert.strictEqual(s.ibailaEnabled, false)
  assert.strictEqual(s.ibailaToken, '')
  assert.strictEqual(s.ibailaUrl, 'http://127.0.0.1:47622')
  assert.strictEqual(s.ibailaLights, true)
  assert.strictEqual(s.ibailaDance, true)
})
check('address: this PC only, no path, no user, no query', () => {
  assert.strictEqual(cleanUrl('http://127.0.0.1:47622'), 'http://127.0.0.1:47622')
  assert.strictEqual(cleanUrl('http://localhost:47622/'), 'http://localhost:47622')
  for (const bad of ['', 'nope', 'https://example.com', 'http://192.168.1.5:47622', 'http://0.0.0.0:47622', 'http://127.0.0.2:47622', 'http://user:pw@127.0.0.1:47622',
    'http://127.0.0.1:47622/?x=1', 'http://127.0.0.1:47622/helper', 'http://127.0.0.1:47622/#a', 'file:///c:/x', 'ws://127.0.0.1:47622', 'http://127.0.0.1.evil.com', null]) assert.strictEqual(cleanUrl(bad), null, String(bad))
})
check('code: 32 to 128 letters, digits, - and _', () => {
  assert.ok(validToken(TOKEN))
  for (const bad of ['', 'short', 'x'.repeat(31), 'x'.repeat(129), 'a b'.padEnd(40, 'c'), 'א'.repeat(40), null]) assert.ok(!validToken(bad))
})
check('actions: only the fixed list, with nothing extra', () => {
  assert.deepStrictEqual(cleanAction({ action: 'on', room: 'my-room' }), { action: 'on', room: 'my-room' })
  assert.deepStrictEqual(cleanAction({ action: 'color', color: 'warm' }), { action: 'color', color: 'warm' })
  assert.deepStrictEqual(cleanAction({ action: 'bright', level: 30 }), { action: 'bright', level: 30 })
  for (const bad of [null, [], 'on', {}, { action: 'nope' }, { action: '__proto__' }, { action: 'constructor' }, { action: 'on', text: SECRET }, { action: 'on', room: 'החדר שלי' },
    { action: 'color', color: SECRET }, { action: 'bright', level: 0 }, { action: 'bright', level: 101 }, { action: 'bright', level: '5' }, { action: 'scene', scene: 'disco' },
    { action: 'party', on: 1 }, { action: 'style', style: 'nope' }, { action: 'off', from: SENDER }]) assert.strictEqual(cleanAction(bad), null, JSON.stringify(bad))
})
check('status: only the yes/no fields are kept', () => {
  const s = cleanStatus({ music: true, playing: 'yes', sync: true, lamps: 2, rooms: { 'my-room': 'on', bedroom: SECRET, kitchen: 'on' }, title: SECRET, artist: SENDER })
  assert.deepStrictEqual(s, { music: true, playing: false, sync: true, lamps: 2, rooms: { 'my-room': 'on', bedroom: 'none' } })
  assert.strictEqual(cleanStatus(null), null)
})

// ---- the client against a fake iBaila ------------------------------------------------------------------

check('off or not set up: no request at all', async () => {
  const f = await fakeIbaila()
  try {
    for (const opts of [{ url: f.url, token: '' }, { url: f.url, token: 'short' }, { url: 'http://192.168.1.5:1', token: TOKEN }]) {
      const statuses = []
      const l = createIbailaLink({ ...opts, onStatus: (s) => statuses.push(s), sleep: () => tick(5) })
      l.start(); l.state('listen'); l.event('alert')
      assert.deepStrictEqual(await l.light({ action: 'on' }), { ok: false, reason: 'not-set' })
      await tick(30); l.stop()
      assert.ok(statuses.includes('not-set'))
    }
    assert.strictEqual(f.reqs.length, 0)
  } finally { await f.close() }
})
check('state: sent once when it changes, again only as a heartbeat; unknown names never', async () => {
  const f = await fakeIbaila()
  let t = 1000000
  const l = createIbailaLink({ url: f.url, token: TOKEN, now: () => t, sleep: () => tick(1000) })
  try {
    l.start()
    await until(() => f.reqs.some((r) => r.url === '/helper/events'))
    l.state('listen'); await until(() => f.posts('/helper/state').length === 1)
    l.state('listen'); l.state('listen'); await tick(30)
    assert.strictEqual(f.posts('/helper/state').length, 1)
    for (const bad of [SECRET, '', 'nope', null, { state: 'listen' }]) l.state(bad)
    await tick(30)
    assert.strictEqual(f.posts('/helper/state').length, 1)
    t += HEARTBEAT + 1; l.state('listen'); await until(() => f.posts('/helper/state').length === 2)
    l.state('think'); await until(() => f.posts('/helper/state').length === 3)
    assert.deepStrictEqual(f.posts('/helper/state').map((r) => JSON.parse(r.body)), [{ state: 'listen' }, { state: 'listen' }, { state: 'think' }])
  } finally { l.stop(); await f.close() }
})
check('requests: the code in the header, no Origin, JSON with the allowed keys only', async () => {
  const f = await fakeIbaila()
  const l = createIbailaLink({ url: f.url, token: TOKEN, sleep: () => tick(1000) })
  try {
    l.start()
    l.state('work'); l.event('task-start'); await l.light({ action: 'color', color: 'red', room: 'bedroom' })
    await until(() => f.posts().length === 3)
    for (const r of f.reqs) {
      assert.strictEqual(r.headers.authorization, 'Bearer ' + TOKEN)
      assert.strictEqual(r.headers.origin, undefined)
      assert.strictEqual(r.headers.cookie, undefined)
    }
    const bodies = Object.fromEntries(f.posts().map((r) => [r.url, JSON.parse(r.body)]))
    assert.deepStrictEqual(bodies, { '/helper/state': { state: 'work' }, '/helper/event': { type: 'task-start' }, '/helper/light': { action: 'color', color: 'red', room: 'bedroom' } })
  } finally { l.stop(); await f.close() }
})
check('events: the four types only', async () => {
  const f = await fakeIbaila()
  const l = createIbailaLink({ url: f.url, token: TOKEN, sleep: () => tick(1000) })
  try {
    l.start()
    for (const t of ['message', 'task-start', 'task-end', 'alert', SECRET, 'nope', '__proto__', null]) l.event(t)
    await until(() => f.posts('/helper/event').length === 4); await tick(30)
    assert.deepStrictEqual(f.posts('/helper/event').map((r) => JSON.parse(r.body).type), ['message', 'task-start', 'task-end', 'alert'])
  } finally { l.stop(); await f.close() }
})
check('light answers: ok, a known reason, or "bad"; off / denied / closed are told apart', async () => {
  let f = await fakeIbaila({ lightReply: { ok: true, lamps: 2 } })
  let l = createIbailaLink({ url: f.url, token: TOKEN, sleep: () => tick(1000) })
  assert.deepStrictEqual(await l.light({ action: 'on' }), { ok: true, lamps: 2 })
  assert.deepStrictEqual(await l.light({ action: 'on', text: SECRET }), { ok: false, reason: 'bad' })
  await f.close()
  f = await fakeIbaila({ lightReply: { ok: false, reason: 'no-room' } })
  l = createIbailaLink({ url: f.url, token: TOKEN })
  assert.deepStrictEqual(await l.light({ action: 'on', room: 'bedroom' }), { ok: false, reason: 'no-room' })
  await f.close()
  f = await fakeIbaila({ lightReply: { ok: false, reason: SECRET } })
  l = createIbailaLink({ url: f.url, token: TOKEN })
  assert.deepStrictEqual(await l.light({ action: 'on' }), { ok: false, reason: 'bad' })
  await f.close()
  for (const [code, reason] of [[404, 'off'], [401, 'denied'], [403, 'denied'], [500, 'unreachable']]) {
    f = await fakeIbaila({ status: code })
    l = createIbailaLink({ url: f.url, token: TOKEN })
    assert.deepStrictEqual(await l.light({ action: 'off' }), { ok: false, reason }, String(code))
    await f.close()
  }
  l = createIbailaLink({ url: f.url, token: TOKEN })     // closed now
  assert.deepStrictEqual(await l.light({ action: 'off' }), { ok: false, reason: 'unreachable' })
})
check('status: read and cleaned', async () => {
  const f = await fakeIbaila({ statusBody: { music: true, playing: true, sync: false, lamps: 3, rooms: { 'my-room': 'off', bedroom: 'on' }, title: SECRET } })
  try {
    const r = await createIbailaLink({ url: f.url, token: TOKEN }).status()
    assert.deepStrictEqual(r, { ok: true, status: { music: true, playing: true, sync: false, lamps: 3, rooms: { 'my-room': 'off', bedroom: 'on' } } })
    assert.ok(!JSON.stringify(r).includes('SYNTH'))
  } finally { await f.close() }
})
check('music: the stream turns the dance on and off; a dropped line stops it and retries with a wait', async () => {
  const f = await fakeIbaila({ stream: (res) => res.write('data: {"music":false,"playing":false}\n\n') })
  const music = [], statuses = [], waits = []
  const l = createIbailaLink({ url: f.url, token: TOKEN, onMusic: (m) => music.push(m), onStatus: (s) => statuses.push(s), sleep: (ms) => { waits.push(ms); return tick(20) } })
  try {
    l.start()
    await until(() => f.streams.length === 1)
    await until(() => statuses.includes('connected'))
    f.streams[0].write('data: {"music":true,"playing":true,"title":"' + SECRET + '"}\n\n')
    await until(() => music.length === 1)
    assert.deepStrictEqual(music, [true]); assert.strictEqual(l.music(), true)
    f.streams[0].write(': k\n\n')
    f.streams[0].write('data: not json\n\n')
    f.streams[0].write('data: {"music":false}\n\n')
    await until(() => music.length === 2)
    f.streams[0].write('data: {"music":true}\n\n')
    await until(() => music.length === 3)
    f.streams[0].destroy()                        // iBaila closed
    await until(() => music.length === 4)
    assert.deepStrictEqual(music, [true, false, true, false])
    assert.ok(statuses.includes('not-running'))
    await until(() => f.streams.length === 2)      // back after a wait
    assert.ok(waits.length >= 1 && waits[0] >= 1000)
  } finally { l.stop(); await f.close() }
})
check('music: denied (401) and off (404) are reported; waits grow and stay under a minute', async () => {
  for (const [code, want] of [[401, 'denied'], [404, 'off']]) {
    const f = await fakeIbaila({ status: code })
    const statuses = [], waits = []
    const l = createIbailaLink({ url: f.url, token: TOKEN, onStatus: (s) => statuses.push(s), sleep: (ms) => { waits.push(ms); return tick(1) }, random: () => 1 })
    l.start()
    await until(() => waits.length >= 8)
    l.stop(); await f.close()
    assert.ok(statuses.includes(want), statuses.join())
    assert.strictEqual(statuses.filter((s) => s === want).length, 1)   // one change, not one per try
    for (let i = 1; i < waits.length; i++) assert.ok(waits[i] >= waits[i - 1])
    assert.ok(Math.max(...waits) <= link.MAX_WAIT)
  }
})
check('stop: says idle once, stops the stream and the dance', async () => {
  const f = await fakeIbaila({ stream: (res) => res.write('data: {"music":true,"playing":true}\n\n') })
  const music = []
  const l = createIbailaLink({ url: f.url, token: TOKEN, onMusic: (m) => music.push(m), sleep: () => tick(1000) })
  try {
    l.start(); await until(() => music.length === 1)
    l.state('think'); await until(() => f.posts('/helper/state').length === 1)
    l.stop()
    await until(() => f.posts('/helper/state').length === 2)
    assert.deepStrictEqual(JSON.parse(f.posts('/helper/state')[1].body), { state: 'idle' })
    assert.deepStrictEqual(music, [true, false])
    assert.strictEqual(l.linkStatus(), 'stopped')
  } finally { await f.close() }
})

// ---- Hebrew light commands ------------------------------------------------------------------------------

const R = (s) => lights.route(instant.tidy(s))
const YES = [
  ['תדליק את הגובי', { action: { action: 'on' }, explicit: true }],
  ['הלפר תדליק בבקשה את הגובי!', { action: { action: 'on' }, explicit: true }],
  ['תכבה את הלדים', { action: { action: 'off' }, explicit: true }],
  ['תכבי את פס הלד', { action: { action: 'off' }, explicit: true }],
  ['תדליק את האור בחדר שלי', { action: { action: 'on', room: 'my-room' }, explicit: false }],
  ['תדליק את המנורה בחדר שלי', { action: { action: 'on', room: 'my-room' }, explicit: false }],
  ['תכבה את האור בחדר השינה', { action: { action: 'off', room: 'bedroom' }, explicit: false }],
  ['תכבה את האורות בחדר שינה', { action: { action: 'off', room: 'bedroom' }, explicit: false }],
  ['תדליק את הגובי בחדר שינה', { action: { action: 'on', room: 'bedroom' }, explicit: true }],
  ['תשים אדום בחדר שלי', { action: { action: 'color', color: 'red', room: 'my-room' }, explicit: false }],
  ['תצבע את האור בכחול בחדר שלי', { action: { action: 'color', color: 'blue', room: 'my-room' }, explicit: false }],
  ['תשים לבן חם בגובי', { action: { action: 'color', color: 'warm' }, explicit: true }],
  ['תשים סגול בלדים', { action: { action: 'color', color: 'purple' }, explicit: true }],
  ['תעשה את הגובי ורוד', { action: { action: 'color', color: 'pink' }, explicit: true }],
  ['תשים תכלת בחדר שינה', { action: { action: 'color', color: 'turquoise', room: 'bedroom' }, explicit: false }],
  ['תעמעם בחדר שלי', { action: { action: 'bright', level: 'down', room: 'my-room' }, explicit: false }],
  ['תעמעם את הגובי', { action: { action: 'bright', level: 'down' }, explicit: true }],
  ['תגביר את האור בחדר שלי', { action: { action: 'bright', level: 'up', room: 'my-room' }, explicit: false }],
  ['בהירות 30 בחדר שלי', { action: { action: 'bright', level: 30, room: 'my-room' }, explicit: false }],
  ['תשים את הגובי על 50', { action: { action: 'bright', level: 50 }, explicit: true }],
  ['מצב ערב', { action: { action: 'scene', scene: 'evening' }, explicit: false }],
  ['מצב קריאה בחדר שלי', { action: { action: 'scene', scene: 'reading', room: 'my-room' }, explicit: false }],
  ['תאורת סרט', { action: { action: 'scene', scene: 'movie' }, explicit: false }],
  ['מצב לילה בחדר שינה', { action: { action: 'scene', scene: 'night', room: 'bedroom' }, explicit: false }],
  ['מצב מסיבה', { action: { action: 'party', on: true }, explicit: true }],
  ['תעשה מסיבה בחדר שלי', { action: { action: 'party', on: true, room: 'my-room' }, explicit: true }],
  ['תעבור למצב מסיבה', { action: { action: 'party', on: true }, explicit: true }],
  ['תפסיק את המסיבה', { action: { action: 'party', on: false }, explicit: true }],
  ['סוף מסיבה', { action: { action: 'party', on: false }, explicit: true }],
  ['תסנכרן את האור למוזיקה', { action: { action: 'sync', on: true }, explicit: true }],
  ['תסנכרן את הגובי עם המוזיקה', { action: { action: 'sync', on: true }, explicit: true }],
  ['תפסיק לסנכרן', { action: { action: 'sync', on: false }, explicit: true }],
  ['סגנון קונצרט', { action: { action: 'style', style: 'concert' }, explicit: true }],
  ['סגנון אור להבה', { action: { action: 'style', style: 'flame' }, explicit: true }],
  ['תשים סגנון ניצוצות', { action: { action: 'style', style: 'sparkle' }, explicit: true }],
  ['תעבור לסגנון קשת', { action: { action: 'style', style: 'rainbow' }, explicit: true }],
  ['תשים אפקט סטרובו', { action: { action: 'style', style: 'strobe' }, explicit: true }],
  ['תחזיר את האור כמו שהיה בחדר שלי', { action: { action: 'restore', room: 'my-room' }, explicit: false }],
  ['תחזיר את הגובי כמו שהיה', { action: { action: 'restore' }, explicit: true }],
  ['מה מצב הגובי', { status: true, room: null, explicit: true }],
  ['מה מצב האורות בחדר שלי', { status: true, room: 'my-room', explicit: false }],
]
const NO = ['תדליק את האור', 'תכבה את האורות', 'תשים אדום', 'מצב לילה', 'מה מצב האורות', 'תגביר את הווליום', 'תגביר', 'תזכיר לי על המסיבה מחר',
  'תנגן שיר', 'תדליק את המזגן', 'תכבה את המזגן בחדר שלי', 'תפתח את כרום בחדר שלי', 'אורח', 'ילד', 'סגנון כלשהו', 'תכתוב לדני שאני בחדר שלי',
  'מה מצב המערכת', 'תדליק את הטלוויזיה', 'תשלח לאמא שהאור דולק', 'בהירות המסך 30', 'תעשה לי קפה', SECRET, '', 'מסיבה מחר בערב אצל דני']

check('commands: each phrase becomes its action', () => {
  for (const [s, want] of YES) assert.deepStrictEqual(R(s), want, s)
})
check('commands: everything else is not iBaila\'s (it goes on exactly as before)', () => {
  for (const s of NO) assert.strictEqual(R(s), null, s)
})
check('commands: every action made from words passes the client\'s own check', () => {
  for (const [s] of YES) { const r = R(s); if (r.action) assert.deepStrictEqual(cleanAction(r.action), r.action, s) }
})
check('commands: every one of the 21 styles has a Hebrew name', () => {
  const named = new Set(lights.STYLE_MAP.values())
  for (const st of link.STYLES) assert.ok(named.has(st), st)
})

check('handle: done -> a short Hebrew answer; an action never carries the sentence', async () => {
  const sent = []
  const fake = { light: async (a) => { sent.push(a); return { ok: true, lamps: 1 } }, status: async () => ({ ok: true, status: { music: true, playing: true, sync: true, lamps: 2, rooms: { 'my-room': 'on', bedroom: 'off' } } }) }
  assert.deepStrictEqual(await lights.handle(R('תדליק את האור בחדר שלי'), fake), { reply: 'הדלקתי בחדר שלי', error: false })
  assert.deepStrictEqual(await lights.handle(R('מצב מסיבה'), fake), { reply: 'מצב מסיבה, עם המוזיקה 🎉', error: false })
  assert.deepStrictEqual(await lights.handle(R('תשים אדום בחדר שינה'), fake), { reply: 'שמתי אדום בחדר השינה', error: false })
  const st = await lights.handle(R('מה מצב הגובי'), fake)
  assert.strictEqual(st.reply, 'בחדר שלי דולק, בחדר השינה כבוי, הסנכרון למוזיקה פועל, יש מוזיקה עכשיו')
  assert.ok(!JSON.stringify(sent).includes('חדר'))   // room ids, not words
})
check('handle: a room-only sentence goes on to the house when iBaila can\'t; a Govee one gets an answer', async () => {
  for (const reason of ['unreachable', 'off', 'denied', 'no-room', 'no-lamps', 'govee-off']) {
    const fake = { light: async () => ({ ok: false, reason }), status: async () => ({ ok: false, reason }) }
    assert.strictEqual(await lights.handle(R('תדליק את האור בחדר שלי'), fake), null, reason)
    assert.strictEqual(await lights.handle(R('מה מצב האורות בחדר שלי'), fake), null, reason)
    const r = await lights.handle(R('תדליק את הגובי'), fake)
    assert.strictEqual(r.error, true); assert.strictEqual(r.reply, lights.failed(reason))
  }
  assert.strictEqual(await lights.handle(R('תדליק את האור בחדר שלי'), null), null)
  assert.strictEqual((await lights.handle(R('מצב מסיבה'), null)).error, true)
  assert.strictEqual(await lights.handle(null, null), null)
})
check('privacy: synthetic message text, senders and groups never reach iBaila', async () => {
  const f = await fakeIbaila()
  const l = createIbailaLink({ url: f.url, token: TOKEN, sleep: () => tick(1000) })
  try {
    l.start()
    for (const s of [`תדליק את הגובי ${SECRET}`, `תכתוב ל${SENDER} בקבוצה ${GROUP} שהאור דולק`, `תשים אדום בחדר שלי ${SECRET}`, 'תשים אדום בחדר שלי']) {
      const cmd = R(s)
      if (cmd) await lights.handle(cmd, l)
    }
    for (const x of [SECRET, SENDER, GROUP, { state: SECRET }, { text: SECRET }]) { l.state(x); l.event(x); await l.light(x) }
    l.state('speak'); l.event('message')
    await until(() => f.posts('/helper/event').length === 1)
    const wire = JSON.stringify(f.reqs.map((r) => [r.url, r.body, r.headers]))
    for (const bad of [SECRET, SENDER, GROUP, 'SYNTH']) assert.ok(!wire.includes(bad), bad)
    assert.deepStrictEqual(f.posts('/helper/light').map((r) => JSON.parse(r.body)), [{ action: 'color', color: 'red', room: 'my-room' }])
  } finally { l.stop(); await f.close() }
})

// ---- wiring in main.js ----------------------------------------------------------------------------------

check('main.js: the link starts only when turned on, the command step only runs with a live link', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(/const want = s\.ibailaEnabled === true/.test(src))
  assert.ok(/if \(!mark && ibaila\) \{/.test(src))
  assert.ok(src.indexOf("L.handle(L.route(text), ibaila)") < src.indexOf('home.route(text)'))
  assert.ok(/onEvent: \(ev\) => \{ avatarEvent\(\{ type: ev\.type \}\); ibailaEvent\(ev\.type\) \}/.test(src))
  // the lamps get a state name computed from the app's own state, never text
  assert.ok(/ibaila\.state\(a \|\| 'idle'\)/.test(src))
  assert.ok(!/ibaila\.(state|event|light)\([^)]*(text|raw|heard)/.test(src))
})
check('ibaila-link.ps1: ASCII only, never prints the code, turns nothing on', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'ibaila-link.ps1'))
  assert.ok(ps.every((b) => b < 128))
  const t = ps.toString()
  assert.ok(!/Write-Host[^\n]*\$code/.test(t))
  assert.ok(!/ibailaEnabled|helperLink/.test(t.replace(/^#.*$/gm, '')))
  assert.ok(/127\.0\.0\.1:47622/.test(t))
})

;(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++ } catch (e) { failed++; console.log('FAIL', name, '\n  ', e.message) }
  }
  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
