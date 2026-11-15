// node src/panel-events-selftest.js: the desktop avatar's event feed (src/panel-events.js) and its route
// GET /panel/api/events (src/panel.js), offline. A real HTTP listener on a free local port and synthetic events only:
// no WhatsApp, no model, no real messages, no real user data.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

if (!process.env.HELPER_DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-events-'))
  fs.writeFileSync(path.join(dir, '.env'), '')
  Object.assign(process.env, { HELPER_DATA_DIR: dir, HELPER_ENV_FILE: path.join(dir, '.env'), HELPER_OFFLINE: '1' })
}

const { createPanel, panelSummary } = await import('./panel.js')
const { createEventFeed, cleanEvent, eventsConfig, EVENT_TYPES, SEVERITIES, EVENTS_SCOPE } = await import('./panel-events.js')
const { cleanScopes, KNOWN_SCOPES, BASE_SCOPES, toolGate, deviceGate } = await import('./panel-scopes.js')
const { createDelivery } = await import('./monitoring/delivery.js')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}

// Synthetic content that must never come out of the feed.
const SECRET_TEXT = 'SYNTH-SECRET-טקסט-של-הודעה'
const SECRET_SENDER = 'SYNTH-שולח-דני'
const SECRET_GROUP = 'SYNTH-קבוצת-הורים'
const leaks = (s) => [SECRET_TEXT, SECRET_SENDER, SECRET_GROUP, 'text', 'sender', 'group', 'title'].some((w) => String(s).includes(w))

// ── the feed by itself ───────────────────────────────────────────────────────
{
  ok(JSON.stringify(EVENT_TYPES) === JSON.stringify(['message', 'task-start', 'task-end', 'alert']), 'F1. a closed list of four types')
  ok(Object.isFrozen(EVENT_TYPES) && Object.isFrozen(SEVERITIES), 'F2. the lists are frozen')
  ok(cleanEvent('nope') === null && cleanEvent('') === null && cleanEvent({ type: 'message' }) === null && cleanEvent('__proto__') === null, 'F3. anything that is not a known type is dropped')
  ok(JSON.stringify(cleanEvent('alert', 'low')) === JSON.stringify({ type: 'alert', severity: 'high' }), 'F4. an alert is always high')
  ok(cleanEvent('message', 'bogus').severity === 'normal' && cleanEvent('task-start').severity === 'low', 'F5. unknown severity falls back to the type default')
  ok(eventsConfig({}).enabled === false && eventsConfig({ PANEL_EVENTS: 'off' }).enabled === false && eventsConfig({ PANEL_EVENTS: 'on' }).enabled === true, 'F6. PANEL_EVENTS is off unless on')

  let t = Date.parse('2026-11-15T10:00:00Z')
  const feed = createEventFeed({ now: () => t, keep: 5, maxAgeMs: 60000 })
  // Callers that try to pass content get only the type through.
  const e1 = feed.publish('message', 'normal', { text: SECRET_TEXT, sender: SECRET_SENDER })
  const e2 = feed.publish({ type: 'alert', text: SECRET_TEXT })
  const e3 = feed.publish(SECRET_TEXT)
  ok(e1 && JSON.stringify(Object.keys(e1).sort()) === JSON.stringify(['at', 'id', 'severity', 'type']), 'F7. an event has exactly id, type, severity, at')
  ok(e2 === null && e3 === null, 'F8. an object or a free string is not a type: nothing published')
  ok(Object.isFrozen(e1) && !leaks(JSON.stringify(feed.since(0))), 'F9. nothing of the content is stored')
  for (let i = 0; i < 8; i++) feed.publish('task-start')
  ok(feed.since(0).length === 5, 'F10. only the last `keep` events are held')
  ok(feed.since(feed.cursor()).length === 0 && feed.since(feed.cursor() + 5).length === 0 && feed.since(-1).length === 0 && feed.since('x').length === 0, 'F11. a cursor at or past the end, or not a number, gives nothing')
  t += 61000
  ok(feed.since(0).length === 0, 'F12. old events are never handed out (no jump for an alert long over)')

  // wait(): resolves when an event comes, or empty after the wait.
  const feed2 = createEventFeed()
  const w = feed2.wait(0, 5000)
  setTimeout(() => feed2.publish('task-end'), 20)
  const got = await w
  ok(got.length === 1 && got[0].type === 'task-end' && feed2.waiting() === 0, 'F13. a long poll wakes on a new event')
  const empty = await feed2.wait(feed2.cursor(), 30)
  ok(Array.isArray(empty) && empty.length === 0 && feed2.waiting() === 0, 'F14. a long poll with nothing new ends empty')
  const ac = new AbortController()
  const aborted = feed2.wait(feed2.cursor(), 5000, ac.signal)
  ac.abort()
  ok((await aborted).length === 0 && feed2.waiting() === 0, 'F15. a closed connection ends the wait at once')
  const feed3 = createEventFeed({ maxWaiters: 1 })
  const hold = feed3.wait(0, 200)
  const second = await feed3.wait(0, 5000)
  ok(second.length === 0 && feed3.waiting() === 1, 'F16. past the waiter ceiling a poll gets [] at once')
  await hold
}

// ── scopes ────────────────────────────────────────────────────────────────────
{
  ok(KNOWN_SCOPES.includes(EVENTS_SCOPE) && !BASE_SCOPES.includes(EVENTS_SCOPE), 'S1. events:avatar is known and never a base scope')
  ok(!cleanScopes([], 'panel').includes(EVENTS_SCOPE), 'S2. a new panel credential does not have it')
  ok(cleanScopes([EVENTS_SCOPE], 'panel').includes(EVENTS_SCOPE), 'S3. the owner can switch it on for a panel credential')
  ok(JSON.stringify(cleanScopes([EVENTS_SCOPE, 'ask:read', 'status', 'device:lights:on'], 'consumer:desktop')) === JSON.stringify([EVENTS_SCOPE]), 'S4. a consumer keeps only events:avatar, never ask:read/status/devices')
  ok(cleanScopes([], 'consumer:desktop').length === 0, 'S5. a new consumer has nothing')
  ok(cleanScopes([EVENTS_SCOPE], 'producer').length === 0, 'S6. a producer never gets it')
  ok(toolGate([EVENTS_SCOPE], 'web_search') !== null && deviceGate([EVENTS_SCOPE], 'lights:on') !== null, 'S7. the events scope opens no tool and no device')
}

// ── the route over real HTTP ──────────────────────────────────────────────────
const freePort = () =>
  new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })

async function serve(events, opts = {}) {
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-events-'))
  const logs = []
  const panel = createPanel({ file: path.join(dir, 'panel.json'), run: async () => ({ reply: 'x' }), port, events, eventsWaitMs: opts.waitMs ?? 200, log: (l) => logs.push(l) })
  const server = http.createServer((req, res) => panel.handle(req, res))
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  const get = (p, headers = {}, method = 'GET') =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(b)
          } catch {}
          resolve({ status: res.statusCode, body: b, json })
        })
      })
      req.on('error', reject)
      req.end()
    })
  return { panel, server, get, logs, port, close: () => new Promise((r) => server.close(r)) }
}
const bearer = (secret) => ({ Authorization: `Bearer ${secret}` })

{
  // Feed off (PANEL_EVENTS unset): the route is not there for anyone.
  const off = await serve(null)
  const c = off.panel.issue({ label: 'synthetic', kind: 'consumer:desktop', scopes: [EVENTS_SCOPE] })
  const r = await off.get('/panel/api/events', bearer(c.secret))
  ok(r.status === 404, 'R1. feed off: 404 even for a credential with the scope')
  ok(panelSummary(off.panel, { enabled: true, port: off.port, origin: '' }).events === false, 'R2. the settings site sees the feed as off')
  await off.close()
}

{
  const feed = createEventFeed()
  const on = await serve(feed)
  const panelCred = on.panel.issue({ label: 'synthetic-panel' })
  const consumerNo = on.panel.issue({ label: 'synthetic-avatar', kind: 'consumer:desktop' })
  const consumerYes = on.panel.issue({ label: 'synthetic-avatar-2', kind: 'consumer:desktop', scopes: [EVENTS_SCOPE] })
  const producer = on.panel.issue({ label: 'synthetic-producer', kind: 'producer', scopes: [EVENTS_SCOPE] })
  ok(panelSummary(on.panel, { enabled: true, port: on.port, origin: '' }).events === true, 'R3. the settings site sees the feed as on')

  ok((await on.get('/panel/api/events')).status === 403, 'R4. no credential: 403')
  ok((await on.get('/panel/api/events', bearer('hpn_0123456789_' + 'x'.repeat(30)))).status === 403, 'R5. an unknown credential: 403')
  ok((await on.get('/panel/api/events', bearer(panelCred.secret))).status === 403, 'R6. a panel credential without the switch: 403')
  ok((await on.get('/panel/api/events', bearer(consumerNo.secret))).status === 403, 'R7. a consumer without the switch: 403')
  ok((await on.get('/panel/api/events', bearer(producer.secret))).status === 403, 'R8. a producer: 403 (it can never hold the scope)')
  ok((await on.get('/panel/api/events?since=0', bearer(consumerYes.secret))).status === 400, 'R9. no cursor in the address, ever')
  ok((await on.get('/panel/api/events', bearer(consumerYes.secret), 'POST')).status === 404, 'R10. only GET')

  // The consumer with the switch: no cursor = start from now (nothing old replayed).
  feed.publish('alert')
  const first = await on.get('/panel/api/events', bearer(consumerYes.secret))
  ok(first.status === 200 && first.json.events.length === 0 && first.json.cursor === feed.cursor(), 'R11. first connect starts from now, nothing replayed')
  const cursor = first.json.cursor
  ok((await on.get('/panel/api/events', { ...bearer(consumerYes.secret), 'Last-Event-ID': 'abc' })).status === 400, 'R12. a cursor that is not a number: 400')

  // Synthetic events published with content beside them: only types come out.
  const pending = on.get('/panel/api/events', { ...bearer(consumerYes.secret), 'Last-Event-ID': String(cursor) })
  setTimeout(() => {
    feed.publish('message', 'normal', { text: SECRET_TEXT, sender: SECRET_SENDER, group: SECRET_GROUP })
    feed.publish('task-start')
  }, 30)
  const r = await pending
  ok(r.status === 200 && r.json.events.length >= 1 && r.json.events[0].type === 'message', 'R13. a long poll returns the new event')
  ok(r.json.events.every((e) => JSON.stringify(Object.keys(e).sort()) === JSON.stringify(['at', 'id', 'severity', 'type'])), 'R14. every event served has only id, type, severity, at')
  ok(r.json.events.every((e) => EVENT_TYPES.includes(e.type) && SEVERITIES.includes(e.severity)), 'R15. only known types and severities are served')
  ok(!leaks(r.body), 'R16. no text, sender or group name in the response body')
  ok(r.json.cursor === r.json.events.at(-1).id, 'R17. the cursor moves to the last event served')

  const quiet = await on.get('/panel/api/events', { ...bearer(consumerYes.secret), 'Last-Event-ID': String(feed.cursor()) })
  ok(quiet.status === 200 && quiet.json.events.length === 0 && quiet.json.cursor === feed.cursor(), 'R18. nothing new: an empty answer after the wait')
  const restarted = await on.get('/panel/api/events', { ...bearer(consumerYes.secret), 'Last-Event-ID': '999999' })
  ok(restarted.status === 200 && restarted.json.events.length === 0 && restarted.json.cursor === feed.cursor(), 'R19. a cursor from before a restart starts again from now')

  // The owner switches it on for the panel credential: then it works; switched off: 403 again.
  on.panel.setScopes(panelCred.id, ['status', 'ask:read', EVENTS_SCOPE])
  ok((await on.get('/panel/api/events', bearer(panelCred.secret))).status === 200, 'R20. switched on: a panel credential may read it')
  on.panel.setScopes(panelCred.id, ['status', 'ask:read'])
  ok((await on.get('/panel/api/events', bearer(panelCred.secret))).status === 403, 'R21. switched off: 403 at once')
  on.panel.revoke(consumerYes.id)
  ok((await on.get('/panel/api/events', bearer(consumerYes.secret))).status === 403, 'R22. revoked: 403 at once')

  // The consumer reaches nothing else.
  const c2 = on.panel.issue({ label: 'synthetic-avatar-3', kind: 'consumer:desktop', scopes: [EVENTS_SCOPE] })
  ok((await on.get('/panel/api/status', bearer(c2.secret))).status === 403 && (await on.get('/panel/api/catalog', bearer(c2.secret))).status === 403, 'R23. the avatar credential gets no status and no catalog')

  ok(!on.logs.some(leaks), 'R24. the log lines carry no content')
  await on.close()
}

{
  // Restart: a consumer's stored events:avatar survives loading; anything else stored on it is dropped.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-events-'))
  const file = path.join(dir, 'panel.json')
  fs.writeFileSync(file, JSON.stringify({ credentials: [{ id: 'aaaaaaaaaa', label: 'synthetic', kind: 'consumer:desktop', hash: 'x', scopes: [EVENTS_SCOPE, 'ask:read', 'device:tv:off'], createdAt: '2026-11-15T00:00:00Z', revokedAt: null }] }))
  const p = createPanel({ file, run: async () => ({}), events: createEventFeed() })
  ok(JSON.stringify(p.list()[0].scopes) === JSON.stringify([EVENTS_SCOPE]), 'R25. on load a consumer keeps only events:avatar')
}

// ── the monitoring hook: a type only, and only after the message went out ─────
{
  const seen = []
  let sendOk = true
  const d = createDelivery({ send: async () => (sendOk ? 'mid' : Promise.reject(new Error('offline'))), now: () => new Date('2026-11-15T12:00:00+02:00'), onSent: (...args) => seen.push(args) })
  const watch = { id: 'w1', pending_batch: [], stats: { interrupts: 0 } }
  const event = { id: 'e1', source: 'gmail', title: SECRET_TEXT, occurred_at: '2026-11-15T10:00:00Z' }
  try {
    await d.deliver(event, watch, { decision: 'interrupt', summary: SECRET_TEXT }, 'general')
    await d.deliver({ ...event, id: 'e2' }, watch, { decision: 'batch', summary: SECRET_SENDER }, 'general')
    sendOk = false
    await d.deliver({ ...event, id: 'e3' }, watch, { decision: 'interrupt', summary: SECRET_GROUP }, 'general')
    ok(seen.length >= 1 && seen.every((a) => a.length === 1 && ['alert', 'message'].includes(a[0])), 'M1. the hook gets one type name and nothing else')
    ok(seen[0][0] === 'alert', 'M2. an interrupt is an alert')
    ok(!leaks(JSON.stringify(seen)), 'M3. no content reaches the hook')
    ok(seen.length <= 2, 'M4. a send that failed is not signalled')
  } catch (e) {
    ok(false, `M0. monitoring delivery ran: ${e.message}`)
  }
}

// ── the wiring in src/index.js: literal type names only ───────────────────────
{
  const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const calls = [...src.matchAll(/avatarEvent\(([^)]*)\)/g)].map((m) => m[1].trim()).filter((a) => a !== 'type')
  const literal = /^'([a-z-]+)'$|^[\w.=' ]+ \? '([a-z-]+)' : '([a-z-]+)'$/
  ok(calls.length >= 4, `W1. index.js signals messages, alerts and tasks (${calls.length} calls)`)
  ok(calls.every((a) => literal.test(a) && [...a.matchAll(/'([a-z-]+)'/g)].every((m) => EVENT_TYPES.includes(m[1]))), 'W2. every call passes a literal known type, never a variable that could carry text')
  ok(/if \(panelCfg\.enabled && eventsConfig\(\)\.enabled\) avatarFeed = createEventFeed\(\)/.test(src), 'W3. the feed exists only with the panel and PANEL_EVENTS both on')
}

console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
