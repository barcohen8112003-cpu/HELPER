// The remote panel: one small HTTPS page (behind a reverse proxy) where the owner, or a client he allows, types a
// request and gets HELPER's answer. It is its own listener, on its own port, and it knows exactly nine routes:
//
//   GET  /panel                 static sign-in page, the same for every visitor, no personal data
//   POST /panel/api/login       the credential, in the body only -> short server-side session cookie
//   POST /panel/api/logout      session
//   GET  /panel/api/status      session: connection state only
//   POST /panel/api/ask         session: { text, id } -> reply, or 202 running, or unknown
//   GET  /panel/api/ask/<id>    session: the stored result of that request
//   GET  /panel/api/catalog     session: the device actions this credential may use, their closed schemas and
//                               connection state (connection only, never proof that a device will obey)
//   POST /panel/api/execute     session: { id, action, params } -> 202 running; one catalog action, no model
//   GET  /panel/api/execute/<id> session: succeeded | failed | unknown | running, for that id only
//
// Device actions run only through execute. A device sentence sent to ask ("תדליק את האורות") is refused there and
// runs nothing: one path, one gate, one lock (src/device-lock.js).
//
// Anything else on this port is 404, so a proxy that forwards too much still reaches nothing of the settings site,
// /dash, /face or /bridge/*. Those live on the settings port (src/ui.js) and are never served here.
//
// Credentials are separate from the Android/Discord bridge token. Only a SHA-256 of each secret is kept on disk;
// the secret is shown once, when it is made. Revoking one ends its sessions at once and touches no other client.
// The actor is always taken from the credential, never from a field the client sends.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { cleanKind, cleanScopes, deviceGate, KNOWN_SCOPES, DEVICE_ACTIONS } from './panel-scopes.js'
import { PANEL_ACTIONS, publicSchema, findAction, checkParams } from './panel-actions.js'

export const PANEL_ROUTES = Object.freeze([
  ['GET', '/panel'],
  ['POST', '/panel/api/login'],
  ['POST', '/panel/api/logout'],
  ['GET', '/panel/api/status'],
  ['POST', '/panel/api/ask'],
  ['GET', '/panel/api/ask/<id>'],
  ['GET', '/panel/api/catalog'],
  ['POST', '/panel/api/execute'],
  ['GET', '/panel/api/execute/<id>'],
])

const PAGE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'panel.html')
const SID = 'hpn_sid'
const PRE = 'hpn_pre'
const MAX_BODY = 20000
const MAX_TEXT = 4000
const ID_RE = /^[A-Za-z0-9_-]{8,80}$/
const HISTORY_KEEP = 20
const REQUEST_KEEP = 500
const REQUEST_DAYS = 14

export const DEFAULT_SETTINGS = Object.freeze({ askPerHour: 30, statusPerHour: 120, loginPerMinute: 10, dailyCap: 200 })

const DEVICE_VIA_EXECUTE = 'פעולות מכשיר מהפאנל רק דרך execute (פעולה מהקטלוג עם חדר מפורש)'

const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const token = (n = 32) => randomBytes(n).toString('base64url')

// From the environment. Off unless PANEL_ENABLED=on. It listens on 127.0.0.1 by default: the proxy in front of it
// is what faces the internet, with HTTPS.
export function panelConfig(env = process.env) {
  const port = Number(env.PANEL_PORT) || 3214
  const origin = String(env.PANEL_PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '')
  return {
    enabled: /^(1|on|true|yes)$/i.test(String(env.PANEL_ENABLED || '')),
    port,
    listen: String(env.PANEL_LISTEN || '127.0.0.1').trim(),
    origin,
    trustProxy: /^(1|on|true|yes)$/i.test(String(env.PANEL_TRUST_PROXY || '')),
  }
}

// ── the store: data/panel.json, written to a temp file and renamed, so a crash never leaves half a file ─────────
function loadStore(file) {
  let data = {}
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  const store = {
    credentials: Array.isArray(data.credentials) ? data.credentials : [],
    requests: data.requests && typeof data.requests === 'object' ? data.requests : {},
    // execute's records, apart from ask's: the same id in both never meets. Key: exec:<credential>:<id>.
    executions: data.executions && typeof data.executions === 'object' ? data.executions : {},
    histories: data.histories && typeof data.histories === 'object' ? data.histories : {},
    daily: data.daily && typeof data.daily === 'object' ? data.daily : { date: '', count: 0, alerted: false },
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
  }
  // Credentials saved before kinds existed are panel credentials, unchanged. A non-panel kind never keeps a scope.
  for (const c of store.credentials) {
    if (c.kind === undefined) c.kind = 'panel'
    else if (cleanKind(c.kind) && cleanKind(c.kind) !== 'panel') c.scopes = []
  }
  // A request that was running when the process stopped has an unknown outcome. It is never run again by itself.
  for (const r of Object.values(store.requests)) if (r.state === 'running') Object.assign(r, { state: 'unknown', note: 'check audit' })
  // The same for a device action: it may have reached the device. Unknown, and never run again by itself.
  for (const r of Object.values(store.executions)) if (r.state === 'running') Object.assign(r, { state: 'unknown', reason: 'restart', detail: 'השרת הופעל מחדש באמצע הפעולה. לא ידוע אם התבצעה. לבדוק את מצב המכשיר לפני כל ניסיון נוסף.' })
  return store
}

function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, file)
}

// Sliding-window counters, in memory: { key -> [times] }.
function limiter(now) {
  const hits = new Map()
  return {
    take(key, max, windowMs) {
      const t = now()
      const list = (hits.get(key) || []).filter((x) => t - x < windowMs)
      if (list.length >= max) {
        hits.set(key, list)
        return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) }
      }
      list.push(t)
      hits.set(key, list)
      return { ok: true }
    },
  }
}

const parseCookies = (header) =>
  Object.fromEntries(
    String(header || '')
      .split(/;\s*/)
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf('=')
        return i < 0 ? [c, ''] : [c.slice(0, i), c.slice(i + 1)]
      })
  )

// Inline script and style are allowed by their hash, so the page's CSP needs no 'unsafe-inline'.
function pageWithCsp(html) {
  const hashes = (tag) => [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ')
  const csp = `default-src 'none'; script-src ${hashes('script')}; style-src ${hashes('style')}; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`
  return { html, csp }
}

// deps:
//   file                 path of panel.json
//   run(text, ctx)       the model turn, in HELPER's queue: ctx { actor, scopes, history, onWaiting } -> { reply, denied, history }
//   status()             { queueBusy, computerMode, pcBridgeConnected, pendingApprovals }
//   devices()            { lights, tv } -> 'connected' | 'disconnected' | 'unknown' (connection state only)
//   notify(text)         a WhatsApp message to the owner
//   fast                 { action(text) -> id|null } (src/fast-commands.js): only to recognise a device sentence in ask
//   execute(action, params, { actor }) -> { state, detail, reason } (src/panel-execute.js)
//   audit(entry)         src/audit.js record
//   origin               the public https origin, e.g. https://panel.example.com; local loopback is allowed besides
//   port, trustProxy, now, waitMs, runTimeoutMs, log
export function createPanel(deps) {
  const {
    file,
    run,
    status = () => ({}),
    devices = () => ({}),
    notify = () => {},
    fast = { action: () => null, run: async () => null },
    audit = () => {},
    execute = async () => ({ state: 'failed', detail: 'ביצוע לא מוגדר', reason: 'not_configured' }),
    origin = '',
    port = 3214,
    trustProxy = false,
    now = () => Date.now(),
    waitMs = 25000,
    runTimeoutMs = 10 * 60000,
    log = console.log,
    sessionIdleMs = 15 * 60000,
    sessionMaxMs = 12 * 3600000,
  } = deps
  const store = loadStore(file)
  const save = () => writeStore(file, store)
  const sessions = new Map() // sid -> { credId, csrf, created, seen }
  const rate = limiter(now)
  const running = new Map() // key -> Promise
  const page = pageWithCsp(fs.existsSync(PAGE) ? fs.readFileSync(PAGE, 'utf8') : '<!doctype html><title>HELPER</title>')

  const origins = [origin, `http://127.0.0.1:${port}`, `http://localhost:${port}`].filter(Boolean)
  const hosts = origins.map((o) => o.replace(/^https?:\/\//, ''))

  // ── credentials ───────────────────────────────────────────────────────────
  function issue({ label = '', scopes = [], kind = 'panel' } = {}) {
    const k = cleanKind(kind)
    if (!k) throw new Error('סוג credential לא מוכר')
    const id = randomBytes(5).toString('hex')
    const secret = `hpn_${id}_${token(32)}`
    const cred = { id, label: String(label || 'פאנל').slice(0, 40), kind: k, hash: sha(secret), scopes: cleanScopes(scopes, k), createdAt: new Date(now()).toISOString(), revokedAt: null }
    store.credentials.push(cred)
    save()
    log(`[panel] credential issued id=${id} kind=${k}`)
    return { id, secret, kind: k, scopes: cred.scopes }
  }
  function revoke(id) {
    const cred = store.credentials.find((c) => c.id === String(id))
    if (!cred) return false
    cred.revokedAt ||= new Date(now()).toISOString()
    for (const [sid, s] of sessions) if (s.credId === cred.id) sessions.delete(sid)
    save()
    log(`[panel] credential revoked id=${cred.id}`)
    return true
  }
  // The owner turns device actions on and off here (settings site only). Base scopes are always kept.
  function setScopes(id, scopes) {
    const cred = store.credentials.find((c) => c.id === String(id) && !c.revokedAt)
    if (!cred) return null
    cred.scopes = cleanScopes(scopes, cred.kind)
    save()
    return cred.scopes
  }
  function setSettings(patch = {}) {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      const n = Number(patch[k])
      if (Number.isFinite(n) && n >= 0 && n <= 100000) store.settings[k] = Math.round(n)
    }
    save()
    return { ...store.settings }
  }
  const list = () => store.credentials.map(({ id, label, kind, scopes, createdAt, revokedAt }) => ({ id, label, kind, scopes, createdAt, revokedAt, active: !revokedAt }))
  const today = () => new Date(now()).toISOString().slice(0, 10)
  const usage = () => ({ date: store.daily.date, count: store.daily.date === today() ? store.daily.count : 0, cap: store.settings.dailyCap })

  function verify(secret) {
    const m = /^hpn_([0-9a-f]{10})_[A-Za-z0-9_-]{20,}$/.exec(String(secret || ''))
    if (!m) return null
    const cred = store.credentials.find((c) => c.id === m[1])
    if (!cred || cred.revokedAt || !cleanKind(cred.kind) || !sameHex(cred.hash, sha(secret))) return null
    return cred
  }
  const activeCred = (id) => store.credentials.find((c) => c.id === id && !c.revokedAt) || null

  // ── one request ───────────────────────────────────────────────────────────
  const send = (res, code, body, headers = {}) => {
    const isHtml = typeof body === 'string'
    res.writeHead(code, {
      'Content-Type': isHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...(origin.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
      ...headers,
    })
    res.end(isHtml ? body : JSON.stringify(body))
  }
  const clientIp = (req) => {
    if (trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean)
      if (fwd.length) return fwd.at(-1)
    }
    return req.socket?.remoteAddress || '-'
  }
  // A POST that rides on a cookie must come from the panel page itself: Origin (or Referer) is checked.
  const fromOurPage = (req) => {
    const o = req.headers.origin
    if (o) return origins.includes(o)
    const ref = req.headers.referer
    if (!ref) return false
    try {
      return origins.includes(new URL(ref).origin)
    } catch {
      return false
    }
  }
  async function readJson(req) {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 })
    }
    try {
      const v = JSON.parse(raw || '{}')
      return v && typeof v === 'object' ? v : {}
    } catch {
      throw Object.assign(new Error('bad json'), { status: 400 })
    }
  }

  // -> { cred, session } or null. A cookie session slides forward with use, up to sessionMaxMs from sign-in.
  function who(req) {
    const auth = String(req.headers.authorization || '')
    if (/^Bearer /i.test(auth)) {
      const cred = verify(auth.slice(7).trim())
      return cred ? { cred, session: null } : null
    }
    const sid = parseCookies(req.headers.cookie)[SID]
    const s = sid && sessions.get(sid)
    if (!s) return null
    const t = now()
    const cred = activeCred(s.credId)
    if (!cred || t - s.seen > sessionIdleMs || t - s.created > sessionMaxMs) {
      sessions.delete(sid)
      return null
    }
    s.seen = t
    return { cred, session: s, sid }
  }

  const view = (r) => {
    if (r.state === 'done') return [200, { reply: r.reply, id: r.id }]
    if (r.state === 'running') return [202, { state: 'running', id: r.id, ...(r.waiting ? { note: 'מחכה לאישור בוואטסאפ' } : {}) }]
    if (r.state === 'denied') return [403, { error: r.reason === 'device_via_execute' ? DEVICE_VIA_EXECUTE : 'לא מורשה', id: r.id }]
    return [200, { state: 'unknown', note: 'check audit', id: r.id }]
  }
  const execView = (r) => {
    const body = { id: r.id, action: r.action, state: r.state, ...(r.detail ? { detail: r.detail } : {}), ...(r.reason ? { reason: r.reason } : {}) }
    return [r.state === 'running' ? 202 : 200, body]
  }

  function trim(box = store.requests) {
    const keys = Object.keys(box)
    const old = now() - REQUEST_DAYS * 86400000
    for (const k of keys) if (box[k].state !== 'running' && Date.parse(box[k].at) < old) delete box[k]
    const left = Object.entries(box).sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at))
    while (left.length > REQUEST_KEEP) {
      const [k, r] = left.shift()
      if (r.state !== 'running') delete box[k]
    }
  }

  // Runs the request once. Its outcome is stored under its key whether or not anyone is still waiting for it.
  function start(key, rec, cred, text) {
    const actor = cred.id
    const finish = (patch) => {
      Object.assign(rec, patch, { doneAt: new Date(now()).toISOString(), waiting: false })
      save()
    }
    const action = fast.action(text)
    let work
    if (action) {
      // A device sentence. From the panel, devices move only through execute (a catalog action, a closed room, the
      // device lock). Here nothing runs, not the device and not the model.
      audit({ tool: `fast:${action}`, args: {}, source: `panel:${actor}`, approval: 'denied', ok: false, error: 'device actions only through execute' })
      work = Promise.resolve({ denied: [action], reason: 'device_via_execute' })
    } else {
      const history = Array.isArray(store.histories[actor]) ? store.histories[actor] : []
      work = Promise.resolve(
        run(text, {
          actor,
          scopes: [...cred.scopes],
          history: history.map((m) => ({ ...m })),
          onWaiting: (on) => {
            rec.waiting = Boolean(on)
          },
        })
      )
    }
    let timer
    const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve({ timedOut: true }), runTimeoutMs)))
    const p = Promise.race([work, timeout])
      .then((out) => {
        if (out?.timedOut) return finish({ state: 'unknown', note: 'check audit' })
        if (out?.denied?.length) return finish({ state: 'denied', reply: '', ...(out.reason ? { reason: out.reason } : {}) })
        if (out?.history) {
          // Only what was said is kept for next time: his text and the final answers, not tool output.
          store.histories[actor] = out.history.filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls && m.content)).map((m) => ({ role: m.role, content: String(typeof m.content === 'string' ? m.content : '').slice(0, 4000) })).slice(-HISTORY_KEEP)
        }
        finish({ state: 'done', reply: String(out?.reply || '') })
      })
      .catch((e) => {
        // A failure in the middle: some tool may already have run. Unknown, never retried by itself.
        log(`[panel] ask failed cred=${actor} ${String(e?.message || e).slice(0, 80)}`)
        finish({ state: 'unknown', note: 'check audit' })
      })
      .finally(() => {
        clearTimeout(timer)
        running.delete(key)
      })
    running.set(key, p)
    return p
  }

  // POST /panel/api/execute: one catalog action, no model at any step. Order: catalog -> schema -> switch ->
  // same id? -> limits -> record saved (running) -> the device, in the background. The answer is 202 at once.
  async function executeRoute(req, cred) {
    const body = await readJson(req)
    if (body.source !== undefined && body.source !== 'panel') {
      log(`[panel] rejected source label cred=${cred.id}`)
      audit({ tool: 'panel_execute', args: {}, source: `panel:${cred.id}`, approval: 'denied', ok: false, error: 'source label of another client' })
      return [403, { error: 'source לא מורשה' }, {}, cred.id]
    }
    for (const k of Object.keys(body)) if (!['id', 'action', 'params', 'source'].includes(k)) return [400, { state: 'failed', reason: 'invalid', error: `שדה לא מוכר: ${String(k).slice(0, 40)}` }, {}, cred.id]
    const id = String(body.id || '')
    if (!ID_RE.test(id)) return [400, { state: 'failed', reason: 'invalid', error: 'צריך id (8-80 תווים: אותיות, ספרות, - או _)' }, {}, cred.id]
    const action = findAction(body.action)
    if (!action) return [400, { state: 'failed', reason: 'invalid', error: 'פעולה לא בקטלוג', id }, {}, cred.id]
    const chk = checkParams(action.id, body.params)
    if (!chk.ok) return [400, { state: 'failed', reason: 'invalid', error: chk.error, id }, {}, cred.id]
    const why = deviceGate(cred.scopes, action.id)
    if (why) {
      audit({ tool: `panel:${action.id}`, args: chk.params, source: `panel:${cred.id}`, approval: 'denied', ok: false, error: why })
      return [403, { state: 'failed', reason: 'denied', error: why, id }, {}, cred.id]
    }
    const key = `exec:${cred.id}:${id}`
    const payloadHash = sha(JSON.stringify([action.id, Object.keys(chk.params).sort().map((k) => [k, chk.params[k]])]))
    const known = store.executions[key]
    if (known) {
      // The same request again (or twice at once): its record, never a second run. Other content: 409.
      if (known.payloadHash !== payloadHash) return [409, { error: 'אותו id עם תוכן אחר', id }, {}, cred.id]
      const [code, out] = execView(known)
      return [code, out, {}, cred.id]
    }
    const lim = rate.take(`ask:${cred.id}`, store.settings.askPerHour, 3600000)
    if (!lim.ok) return [429, { error: 'יותר מדי בקשות', retryAfter: lim.retryAfter }, {}, cred.id]
    if (store.daily.date !== today()) store.daily = { date: today(), count: 0, alerted: false }
    if (store.daily.count >= store.settings.dailyCap) {
      const midnight = new Date(today() + 'T00:00:00Z').getTime() + 86400000
      return [429, { error: 'הפאנל הגיע לתקרה היומית', retryAfter: Math.max(1, Math.ceil((midnight - now()) / 1000)) }, {}, cred.id]
    }
    store.daily.count++
    // Saved before anything is sent. From here on a crash leaves "unknown", never a silent second run.
    const rec = { actor: cred.id, id, action: action.id, params: chk.params, payloadHash, state: 'running', detail: '', at: new Date(now()).toISOString() }
    store.executions[key] = rec
    trim(store.executions)
    save()
    const job = Promise.resolve()
      .then(() => execute(action.id, chk.params, { actor: cred.id }))
      .then(
        (out) => (['succeeded', 'failed', 'unknown'].includes(out?.state) ? out : { state: 'unknown', detail: 'תוצאה לא תקינה', reason: 'bad_result' }),
        (e) => {
          log(`[panel] execute failed cred=${cred.id} ${String(e?.message || e).slice(0, 80)}`)
          return { state: 'unknown', detail: 'לא ידוע אם הפעולה התבצעה. לבדוק את מצב המכשיר לפני כל ניסיון נוסף.', reason: 'error' }
        }
      )
      .then((out) => {
        Object.assign(rec, { state: out.state, detail: String(out.detail || '').slice(0, 300), reason: out.reason || '', doneAt: new Date(now()).toISOString() })
        save()
        audit({ tool: `panel:${action.id}`, args: chk.params, source: `panel:${cred.id}`, approval: 'none', ok: out.state === 'succeeded', error: out.state === 'succeeded' ? '' : `${out.state}${out.reason ? `:${out.reason}` : ''}` })
      })
      .finally(() => running.delete(key))
    running.set(key, job)
    return [202, { state: 'running', id, action: action.id }, {}, cred.id]
  }

  async function route(req, res, url) {
    const method = req.method
    const p = url.pathname
    if (method === 'GET' && p === '/panel') {
      // A fresh value for the sign-in form's CSRF check (double submit: cookie and header must match).
      return send(res, 200, page.html, { 'Content-Security-Policy': page.csp, 'Set-Cookie': `${PRE}=${token(18)}; Secure; SameSite=Strict; Path=/panel; Max-Age=3600` })
    }
    if (method === 'POST' && p === '/panel/api/login') {
      const ip = clientIp(req)
      const lim = rate.take(`login:${ip}`, store.settings.loginPerMinute, 60000)
      if (!lim.ok) return [429, { error: 'יותר מדי ניסיונות', retryAfter: lim.retryAfter }]
      const pre = parseCookies(req.headers.cookie)[PRE]
      if (!fromOurPage(req) || !pre || !sameHex(pre, String(req.headers['x-csrf-token'] || ''))) return [403, { error: 'בקשה לא מהפאנל' }]
      const body = await readJson(req)
      const cred = verify(body.credential)
      if (!cred) return [403, { error: 'credential לא תקף' }]
      // A browser session is for panel credentials only. Producers and device consumers are programs.
      if (cred.kind !== 'panel') return [403, { error: 'credential לא מסוג פאנל' }, {}, cred.id]
      const sid = token(32)
      const csrf = token(24)
      sessions.set(sid, { credId: cred.id, csrf, created: now(), seen: now() })
      return [200, { ok: true, csrf }, { 'Set-Cookie': `${SID}=${sid}; Secure; HttpOnly; SameSite=Strict; Path=/panel; Max-Age=${Math.round(sessionMaxMs / 1000)}` }, cred.id]
    }

    const isApi =
      (method === 'POST' && (p === '/panel/api/logout' || p === '/panel/api/ask' || p === '/panel/api/execute')) ||
      (method === 'GET' && (p === '/panel/api/status' || p === '/panel/api/catalog' || /^\/panel\/api\/(ask|execute)\/[^/]+$/.test(p)))
    if (!isApi) return [404, { error: 'not found' }]

    const me = who(req)
    if (!me) return [403, { error: 'צריך להתחבר' }]
    const { cred, session } = me
    if (method === 'POST') {
      // Cookie: the page's CSRF token and Origin. Bearer (a program): no cookie to ride on, but a browser Origin
      // that is not ours is still refused.
      if (session && (!fromOurPage(req) || !sameHex(session.csrf, String(req.headers['x-csrf-token'] || '')))) return [403, { error: 'בקשה לא מהפאנל' }, {}, cred.id]
      if (!session && req.headers.origin && !origins.includes(req.headers.origin)) return [403, { error: 'מקור לא מורשה' }, {}, cred.id]
    }

    if (p === '/panel/api/logout') {
      if (me.sid) sessions.delete(me.sid)
      return [200, { ok: true }, { 'Set-Cookie': `${SID}=; Secure; HttpOnly; SameSite=Strict; Path=/panel; Max-Age=0` }, cred.id]
    }
    // Every other route here is for panel credentials. A producer or a device consumer gets nothing from them.
    if (cred.kind !== 'panel') return [403, { error: 'לא מורשה' }, {}, cred.id]
    if (p === '/panel/api/catalog') {
      if (!cred.scopes.includes('status')) return [403, { error: 'לא מורשה' }, {}, cred.id]
      const lim = rate.take(`status:${cred.id}`, store.settings.statusPerHour, 3600000)
      if (!lim.ok) return [429, { error: 'יותר מדי בקשות', retryAfter: lim.retryAfter }, {}, cred.id]
      let conn = {}
      try {
        conn = devices() || {}
      } catch {}
      const state = (d) => (['connected', 'disconnected'].includes(conn[d]) ? conn[d] : 'unknown')
      // Only the actions this credential's switches allow. Nothing here runs anything.
      const actions = PANEL_ACTIONS.filter((a) => !deviceGate(cred.scopes, a.id)).map((a) => ({ id: a.id, label: a.label, device: a.device, kind: a.kind, params: publicSchema(a), connection: state(a.device) }))
      return [200, { ok: true, actions, note: 'מחובר = חיבור בלבד, לא הוכחה שהפעולה תתבצע' }, {}, cred.id]
    }
    if (p === '/panel/api/status') {
      if (!cred.scopes.includes('status')) return [403, { error: 'לא מורשה' }, {}, cred.id]
      const lim = rate.take(`status:${cred.id}`, store.settings.statusPerHour, 3600000)
      if (!lim.ok) return [429, { error: 'יותר מדי בקשות', retryAfter: lim.retryAfter }, {}, cred.id]
      const s = status() || {}
      // Connection state only. pcBridgeConnected says the home bridge is up, not that any device will obey.
      const out = {
        ok: true,
        queueBusy: Boolean(s.queueBusy),
        computerMode: ['off', 'ask', 'auto'].includes(s.computerMode) ? s.computerMode : 'off',
        pcBridgeConnected: Boolean(s.pcBridgeConnected),
        pendingApprovals: Number(s.pendingApprovals) || 0,
      }
      if (session) out.csrf = session.csrf
      return [200, out, {}, cred.id]
    }
    if (method === 'GET' && p.startsWith('/panel/api/execute/')) {
      const id = decodeURIComponent(p.slice('/panel/api/execute/'.length))
      // Only the credential that sent it: anyone else's id is simply not there.
      const rec = ID_RE.test(id) && store.executions[`exec:${cred.id}:${id}`]
      if (!rec) return [404, { error: 'לא נמצא' }, {}, cred.id]
      const [code, body] = execView(rec)
      return [code, body, {}, cred.id]
    }
    if (p === '/panel/api/execute') return executeRoute(req, cred)
    if (method === 'GET') {
      const id = decodeURIComponent(p.slice('/panel/api/ask/'.length))
      const rec = ID_RE.test(id) && store.requests[`${cred.id}:${id}`]
      if (!rec) return [404, { error: 'לא נמצא' }, {}, cred.id]
      const [code, body] = view(rec)
      return [code, body, {}, cred.id]
    }

    // POST /panel/api/ask
    const body = await readJson(req)
    if (body.source !== undefined && body.source !== 'panel') {
      // The client cannot speak as another client. Logged, and nothing runs.
      log(`[panel] rejected source label cred=${cred.id}`)
      audit({ tool: 'panel_ask', args: {}, source: `panel:${cred.id}`, approval: 'denied', ok: false, error: 'source label of another client' })
      return [403, { error: 'source לא מורשה' }, {}, cred.id]
    }
    const id = String(body.id || '')
    const text = String(body.text || '').trim()
    if (!ID_RE.test(id)) return [400, { error: 'צריך id (8-80 תווים: אותיות, ספרות, - או _)' }, {}, cred.id]
    if (!text) return [400, { error: 'טקסט ריק' }, {}, cred.id]
    if (text.length > MAX_TEXT) return [400, { error: 'טקסט ארוך מדי' }, {}, cred.id]
    const key = `${cred.id}:${id}`
    const payloadHash = sha(text)
    const known = store.requests[key]
    if (known) {
      if (known.payloadHash !== payloadHash) return [409, { error: 'אותו id עם תוכן אחר', id }, {}, cred.id]
      const [code, out] = view(known)
      return [code, out, {}, cred.id]
    }
    if (!cred.scopes.includes('ask:read')) return [403, { error: 'לא מורשה' }, {}, cred.id]
    const lim = rate.take(`ask:${cred.id}`, store.settings.askPerHour, 3600000)
    if (!lim.ok) return [429, { error: 'יותר מדי בקשות', retryAfter: lim.retryAfter }, {}, cred.id]
    if (store.daily.date !== today()) store.daily = { date: today(), count: 0, alerted: false }
    if (store.daily.count >= store.settings.dailyCap) {
      if (!store.daily.alerted) {
        store.daily.alerted = true
        save()
        Promise.resolve()
          .then(() => notify(`⚠️ הפאנל המרוחק הגיע לתקרה היומית (${store.settings.dailyCap} בקשות). בקשות נוספות נדחות עד מחר. אפשר לשנות באתר ההגדרות.`))
          .catch(() => {})
      }
      const midnight = new Date(today() + 'T00:00:00Z').getTime() + 86400000
      return [429, { error: 'הפאנל הגיע לתקרה היומית', retryAfter: Math.max(1, Math.ceil((midnight - now()) / 1000)) }, {}, cred.id]
    }
    store.daily.count++
    const rec = { actor: cred.id, id, payloadHash, state: 'running', reply: '', at: new Date(now()).toISOString() }
    store.requests[key] = rec
    trim()
    save()
    const job = start(key, rec, cred, text)
    // Wait a while for the answer; a long queue answers 202 and the page asks again by id.
    await Promise.race([job, new Promise((r) => setTimeout(r, waitMs))])
    const [code, out] = view(rec)
    return [code, out, {}, cred.id]
  }

  async function handle(req, res) {
    const started = now()
    let code = 500
    let actor = '-'
    let name = '-'
    try {
      const url = new URL(req.url || '/', 'http://panel.invalid')
      name = /^\/panel\/api\/ask\/[^/]+$/.test(url.pathname) ? '/panel/api/ask/:id' : /^\/panel\/api\/execute\/[^/]+$/.test(url.pathname) ? '/panel/api/execute/:id' : url.pathname.slice(0, 40)
      // Nothing in the address, ever: no ?t=, no credential, no query of any kind.
      if (url.search) {
        code = 400
        return send(res, 400, { error: 'אין פרמטרים בכתובת' })
      }
      if (!hosts.includes(String(req.headers.host || ''))) {
        code = 403
        return send(res, 403, { error: 'מארח לא מוכר' })
      }
      const out = await route(req, res, url)
      if (!out) return (code = 200)
      const [c, body, headers = {}, who] = out
      code = c
      if (who) actor = who
      return send(res, c, body, headers)
    } catch (e) {
      code = e.status || 400
      return send(res, code, { error: code === 413 ? 'גוף גדול מדי' : 'בקשה לא תקינה' })
    } finally {
      // Credential id, route, status and time only. Never the text, the reply or a secret.
      log(`[panel] cred=${actor} route=${req.method} ${name} status=${code} ms=${Math.max(0, now() - started)}`)
    }
  }

  return {
    handle,
    issue,
    revoke,
    setScopes,
    setSettings,
    list,
    usage,
    settings: () => ({ ...store.settings }),
    // For the self-tests: wait for every running request.
    idle: () => Promise.all([...running.values()]),
    _sessions: sessions,
  }
}

// What the settings site shows about the panel.
export function panelSummary(panel, cfg = panelConfig()) {
  return {
    enabled: cfg.enabled,
    port: cfg.port,
    origin: cfg.origin,
    routes: PANEL_ROUTES.map(([m, p]) => `${m} ${p}`),
    scopes: KNOWN_SCOPES,
    devices: DEVICE_ACTIONS,
    credentials: panel ? panel.list() : [],
    settings: panel ? panel.settings() : { ...DEFAULT_SETTINGS },
    usage: panel ? panel.usage() : { count: 0 },
  }
}

export function startPanelServer(panel, cfg = panelConfig()) {
  const server = http.createServer((req, res) => panel.handle(req, res))
  // No websockets here.
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
  })
  server.on('error', (e) => console.log(`[panel] לא עלה: ${e.code === 'EADDRINUSE' ? `הפורט ${cfg.port} תפוס (PANEL_PORT)` : e.message}`))
  server.listen(cfg.port, cfg.listen)
  console.log(`[panel] פאנל מרחוק מאזין ב-${cfg.listen}:${cfg.port}${cfg.origin ? ` (כתובת ציבורית: ${cfg.origin}/panel)` : ' (בלי PANEL_PUBLIC_ORIGIN: רק מקומי)'}`)
  return server
}
