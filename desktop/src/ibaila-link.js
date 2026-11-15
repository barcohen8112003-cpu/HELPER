// The line to iBaila (Glowbeat) on this PC: its control port on 127.0.0.1, the /helper/ part (helper-link.js there).
//
// What goes out, and only this: a state name (listen, think, speak, work, idle, ...), an event type (message,
// task-start, task-end, alert) and light actions from a fixed list ({ action: 'on', room: 'my-room' }). Never the
// words that were said, never a message, a sender, a group or a task. What comes back is checked the same way: yes/no
// answers and counts (is music playing, is a room on), nothing else is kept.
//
// Quiet when iBaila is closed: the music stream retries with growing waits (2 s up to 1 min, with jitter), and
// app.log gets one line when the state changes (connected / not running / denied / off), never one per try.
'use strict'

const STATES = Object.freeze(['idle', 'listen', 'think', 'speak', 'work', 'dance', 'alert'])
const EVENTS = Object.freeze(['message', 'task-start', 'task-end', 'alert'])
const ROOMS = Object.freeze(['my-room', 'bedroom'])
const COLORS = Object.freeze(['red', 'orange', 'yellow', 'green', 'turquoise', 'blue', 'purple', 'pink', 'white', 'warm'])
const SCENES = Object.freeze(['evening', 'reading', 'movie', 'night'])
const STYLES = Object.freeze(['energy', 'steps', 'bounce', 'hop', 'strike', 'shimmer', 'candy', 'flame', 'blocks', 'blend', 'sparkle', 'split',
  'beat', 'concert', 'party', 'pulse', 'flash', 'cycle', 'rainbow', 'steady', 'strobe'])
const ACTIONS = Object.freeze({ on: [], off: [], restore: [], color: ['color'], bright: ['level'], scene: ['scene'], party: ['on'], sync: ['on'], style: ['style'] })
const REASONS = Object.freeze(['bad', 'no-room', 'no-lamps', 'govee-off'])
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/
const DEFAULT_URL = 'http://127.0.0.1:47622'

const MIN_WAIT = 2000
const MAX_WAIT = 60000
const HEARTBEAT = 20000          // iBaila forgets a state after a minute without hearing it
const REQUEST_TIMEOUT = 4000
const STREAM_SILENCE = 35000     // iBaila says something every 15 s; this long with nothing means the line is dead
const MUSIC_REFRESH = 60000      // see musicNudge in main.js

/** iBaila's address, or null. This PC only: http(s)://127.0.0.1 or localhost, a port, nothing else. */
function cleanUrl(url) {
  let u
  try { u = new URL(String(url || '').trim()) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) return null
  return u.origin
}
const validToken = (t) => TOKEN_RE.test(String(t || ''))

/** A light action with only allowed fields and values, or null. */
function cleanAction(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, a.action)) return null
  const fields = ACTIONS[a.action]
  for (const k of Object.keys(a)) if (k !== 'action' && k !== 'room' && !fields.includes(k)) return null
  const out = { action: a.action }
  if (a.room !== undefined && a.room !== null) { if (!ROOMS.includes(a.room)) return null; out.room = a.room }
  if (a.action === 'color') { if (!COLORS.includes(a.color)) return null; out.color = a.color }
  if (a.action === 'bright') {
    if (a.level === 'up' || a.level === 'down' || (Number.isInteger(a.level) && a.level >= 1 && a.level <= 100)) out.level = a.level
    else return null
  }
  if (a.action === 'scene') { if (!SCENES.includes(a.scene)) return null; out.scene = a.scene }
  if (a.action === 'party' || a.action === 'sync') { if (typeof a.on !== 'boolean') return null; out.on = a.on }
  if (a.action === 'style') { if (!STYLES.includes(a.style)) return null; out.style = a.style }
  return out
}

/** iBaila's /helper/status answer, reduced to the known yes/no fields; anything else in it is dropped. */
function cleanStatus(s) {
  if (!s || typeof s !== 'object') return null
  const rooms = {}
  for (const r of ROOMS) rooms[r] = ['on', 'off', 'none'].includes(s.rooms && s.rooms[r]) ? s.rooms[r] : 'none'
  return { music: s.music === true, playing: s.playing === true, sync: s.sync === true, lamps: Number.isInteger(s.lamps) && s.lamps >= 0 && s.lamps < 1000 ? s.lamps : 0, rooms }
}

function createIbailaLink({ url = DEFAULT_URL, token, onMusic = () => {}, onStatus = () => {}, fetchImpl = (...a) => fetch(...a), log = () => {},
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random } = {}) {
  const origin = cleanUrl(url)
  const ready = Boolean(origin && validToken(token))
  let status = 'stopped'
  let running = false
  let gen = 0
  let ac = null
  let failures = 0
  let music = false
  let lastState = null, lastStateAt = 0, sending = false, pendingState = null

  function setStatus(s) {
    if (s === status) return
    status = s
    log(`ibaila: ${s}`)
    try { onStatus(s) } catch { }
  }
  function setMusic(on) {
    if (on === music) return
    music = on
    try { onMusic(on) } catch { }
  }
  const headers = (extra) => Object.assign({ Authorization: `Bearer ${token}` }, extra)

  /** One request. Never throws: { ok, code, body } or { ok: false, reason }. */
  async function request(method, path, body) {
    if (!ready) return { ok: false, reason: 'not-set' }
    const mine = new AbortController()
    const timer = setTimeout(() => mine.abort(), REQUEST_TIMEOUT)
    try {
      const res = await fetchImpl(origin + path, {
        method, signal: mine.signal, redirect: 'error',
        headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      })
      let j = null
      try { j = await res.json() } catch { }
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'denied' }
      if (res.status === 404) return { ok: false, reason: 'off' }
      if (res.status >= 500) return { ok: false, reason: 'unreachable' }
      return { ok: res.ok, code: res.status, body: j }
    } catch {
      return { ok: false, reason: 'unreachable' }
    } finally { clearTimeout(timer) }
  }

  /** HELPER's state now. Sent when it changes, and again every 20 s so iBaila knows HELPER is still there. */
  function state(name) {
    if (!running || !STATES.includes(name)) return
    if (name === lastState && now() - lastStateAt < HEARTBEAT) return
    if (sending) { pendingState = name; return }
    sending = true
    lastState = name; lastStateAt = now()
    request('POST', '/helper/state', { state: name }).finally(() => {
      sending = false
      const p = pendingState; pendingState = null
      if (p && p !== lastState) state(p)
    })
  }
  function event(type) {
    if (!running || !EVENTS.includes(type)) return
    request('POST', '/helper/event', { type })
  }
  /** A light action. Returns { ok: true, lamps } or { ok: false, reason }. */
  async function light(action) {
    const a = cleanAction(action)
    if (!a) return { ok: false, reason: 'bad' }
    const r = await request('POST', '/helper/light', a)
    if (r.reason) return { ok: false, reason: r.reason }
    const b = r.body || {}
    if (r.ok && b.ok === true) return { ok: true, lamps: Number.isInteger(b.lamps) ? b.lamps : null }
    return { ok: false, reason: REASONS.includes(b.reason) ? b.reason : 'bad' }
  }
  async function getStatus() {
    const r = await request('GET', '/helper/status')
    if (r.reason) return { ok: false, reason: r.reason }
    const s = r.ok ? cleanStatus(r.body) : null
    return s ? { ok: true, status: s } : { ok: false, reason: 'bad' }
  }

  function backoff() {
    const base = Math.min(MAX_WAIT, MIN_WAIT * 2 ** Math.max(0, failures - 1))
    return Math.round(base * (0.5 + random() / 2))
  }

  /** The music stream, once: until it ends. Returns nothing; sets status. */
  async function streamOnce(myGen) {
    const live = () => running && myGen === gen
    const mine = new AbortController()
    ac = mine
    let silence = null
    const quiet = () => { clearTimeout(silence); silence = setTimeout(() => mine.abort(), STREAM_SILENCE) }
    try {
      quiet()
      const res = await fetchImpl(origin + '/helper/events', { signal: mine.signal, redirect: 'error', headers: headers({ Accept: 'text/event-stream' }) })
      if (!live()) return
      if (res.status === 401 || res.status === 403) { failures++; setStatus('denied'); return }
      if (res.status === 404) { failures++; setStatus('off'); return }
      if (!res.ok || !res.body) { failures++; setStatus('not-running'); return }
      setStatus('connected')
      failures = 0
      lastStateAt = 0                      // say the state again now: iBaila may have just started
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        quiet()
        buf += dec.decode(value, { stream: true })
        if (buf.length > 65536) break      // never this much from iBaila: drop the line
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue
            let j = null
            try { j = JSON.parse(line.slice(6)) } catch { }
            if (j && typeof j.music === 'boolean') setMusic(j.music)
          }
        }
      }
      failures = 1
      if (live()) setStatus('not-running')
    } catch {
      failures++
      if (live()) setStatus('not-running')
    } finally {
      clearTimeout(silence)
      setMusic(false)                      // no line, no music: the avatar stops dancing
    }
  }

  async function loop(myGen) {
    while (running && myGen === gen) {
      if (!ready) { setStatus('not-set'); return }
      await streamOnce(myGen)
      if (!running || myGen !== gen) return
      await sleep(backoff())
    }
  }

  function start() {
    if (running) return
    running = true
    gen++
    loop(gen)
  }
  function stop() {
    if (running && lastState && lastState !== 'idle') request('POST', '/helper/state', { state: 'idle' })
    running = false
    gen++
    if (ac) try { ac.abort() } catch { }
    setMusic(false)
    setStatus('stopped')
  }

  return { start, stop, state, event, light, status: getStatus, music: () => music, linkStatus: () => status }
}

module.exports = { createIbailaLink, cleanUrl, cleanAction, cleanStatus, validToken, STATES, EVENTS, ROOMS, COLORS, SCENES, STYLES, MIN_WAIT, MAX_WAIT, HEARTBEAT, STREAM_SILENCE, MUSIC_REFRESH }
