// The avatar's line to HELPER on the cloud: a long poll of GET /panel/api/events (src/panel.js on the server), with
// this PC's own avatar credential. The server sends only { id, type, severity, at }; here only type and severity
// are passed on, and only when the type is a known one.
//
// Quiet when the server is not there: retries with growing waits (2 s up to 5 min, with jitter), and app.log gets
// one line when the state changes (connected / unreachable / denied / off), never one per failed try.
'use strict'

const { EVENT_TYPES } = require('./avatar-state')

const SEVERITIES = ['low', 'normal', 'high']
const CRED_RE = /^hpn_[0-9a-f]{10}_[A-Za-z0-9_-]{20,}$/
const MIN_WAIT = 2000
const MAX_WAIT = 5 * 60000
const SLOW_WAIT = 10 * 60000      // the server said no (403) or the feed is off there (404): ask again rarely
const REQUEST_TIMEOUT = 45000     // a little over the server's 25 s long poll
const POLL_GAP = 250              // between two answered polls: a server that answers at once is never hammered

/** The panel origin, or null. HTTPS only, except this PC itself (a local test server). */
function cleanUrl(url) {
  let u
  try { u = new URL(String(url || '').trim()) } catch { return null }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
  if (u.username || u.password || u.search || u.hash) return null
  return u.origin
}

const validCredential = (c) => CRED_RE.test(String(c || ''))

function createAvatarFeed({ url, credential, onEvent = () => {}, onStatus = () => {}, fetchImpl = (...a) => fetch(...a), log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random } = {}) {
  const origin = cleanUrl(url)
  let cursor = null
  let failures = 0
  let status = 'stopped'
  let running = false
  let gen = 0                     // a stop and a new start never leave two loops running
  let ac = null

  function setStatus(s) {
    if (s === status) return
    status = s
    log(`avatar feed: ${s}`)
    try { onStatus(s) } catch { }
  }

  function backoff() {
    const base = Math.min(MAX_WAIT, MIN_WAIT * 2 ** Math.max(0, failures - 1))
    return Math.round(base * (0.5 + random() / 2))
  }

  /** One request. Returns how long to wait before the next one (ms). Never throws. */
  async function runOnce() {
    if (!origin || !validCredential(credential)) { setStatus('not-set'); return SLOW_WAIT }
    const mine = new AbortController()
    ac = mine
    const timer = setTimeout(() => mine.abort(), REQUEST_TIMEOUT)
    try {
      const headers = { Authorization: `Bearer ${credential}`, Accept: 'application/json' }
      if (cursor !== null) headers['Last-Event-ID'] = String(cursor)
      const res = await fetchImpl(origin + '/panel/api/events', { headers, signal: mine.signal, redirect: 'error' })
      if (res.status === 200) {
        let body = null
        try { body = await res.json() } catch { body = null }
        if (!body || !Array.isArray(body.events) || !Number.isInteger(body.cursor)) { failures++; setStatus('unreachable'); return backoff() }
        failures = 0
        setStatus('connected')
        cursor = body.cursor
        for (const e of body.events) {
          const type = e && typeof e.type === 'string' && EVENT_TYPES.includes(e.type) ? e.type : null
          if (!type) continue
          const severity = SEVERITIES.includes(e.severity) ? e.severity : 'normal'
          try { onEvent({ type, severity }) } catch { }
        }
        return POLL_GAP
      }
      if (res.status === 403) { cursor = null; setStatus('denied'); return SLOW_WAIT }
      if (res.status === 404) { cursor = null; setStatus('off'); return SLOW_WAIT }
      if (res.status === 429) {
        let after = 30
        try { after = Number((await res.json()).retryAfter) || 30 } catch { }
        return Math.min(MAX_WAIT, Math.max(MIN_WAIT, after * 1000))
      }
      failures++
      setStatus('unreachable')
      return backoff()
    } catch {
      if (!running && mine.signal.aborted) return 0     // stopped on purpose: not a failure
      failures++
      setStatus('unreachable')
      return backoff()
    } finally {
      clearTimeout(timer)
      if (ac === mine) ac = null
    }
  }

  async function loop(mine) {
    while (running && mine === gen) {
      const wait = await runOnce()
      if (!running || mine !== gen) break
      if (wait > 0) await sleep(wait)
    }
  }

  return {
    start() {
      if (running) return
      running = true
      status = 'starting'
      loop(++gen)
    },
    stop() {
      running = false
      gen++
      try { ac && ac.abort() } catch { }
      setStatus('stopped')
    },
    status: () => status,
    runOnce,
    _state: () => ({ cursor, failures }),
  }
}

module.exports = { createAvatarFeed, cleanUrl, validCredential, MIN_WAIT, MAX_WAIT, SLOW_WAIT, POLL_GAP }
