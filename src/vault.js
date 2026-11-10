// Helper's own credential vault: site passwords kept encrypted on this machine, entered by the owner on a local page
// (never typed into the chat), and used only to fill the login form of the exact site they were saved for.
//
// Status: OFF by default, and the parts that keep or use real passwords stay off until the owner chooses:
//   CREDENTIAL_VAULT=on      lets the vault be created and secrets be stored (through the secure page only).
//   CREDENTIAL_AUTOFILL=on   additionally lets a saved login be filled into the errand browser, after a yes.
// With either off, the tools answer "setup needed" and nothing is stored or filled.
//
// What it does, and what it does not:
// - Secrets reach Helper only through POST /vault/r/<request id> on the settings site: signed-in cookie, a one-time
//   request id with an expiry, a CSRF token bound to that request, the Origin header checked, loopback (or an
//   explicitly listed https host) only. The model never sees a secret: tools return ids, sites and labels.
// - Storage: data/vault/vault.json, mode 0600. Key: scrypt(passphrase) -> HKDF into separate keys for wrapping and
//   for checking the passphrase. Each entry has its own random data key (AES-256-GCM), and both the wrapped key and
//   the secret are bound (AEAD associated data) to the entry id and its origin, so an entry moved to another site
//   does not decrypt. The passphrase is never stored; it must differ from BACKUP_PASSPHRASE.
// - Locked by default; unlocking keeps the wrapping key in memory for VAULT_UNLOCK_MINUTES (default 10), then it is
//   wiped. Five wrong passphrases lock unlocking for 15 minutes.
// - The vault folder is not part of the Drive backup (src/backup.js lists what it takes; vault is not in it), not
//   in the audit log (no tool argument carries a secret) and not in any export.
// - Not a copy of any other product's design, and no third-party vault (1Password and others are not integrated:
//   that needs their CLI/Connect server and an account, which this change does not have or activate).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config, DATA_DIR } from './config.js'

export const vaultEnabled = () => process.env.CREDENTIAL_VAULT === 'on'
export const autofillEnabled = () => vaultEnabled() && process.env.CREDENTIAL_AUTOFILL === 'on'

const DIR = () => path.join(DATA_DIR, 'vault')
const FILE = () => path.join(DIR(), 'vault.json')
const KDF = { name: 'scrypt', N: 2 ** 15, r: 8, p: 1 }
const REQUEST_MS = 10 * 60000
const MAX_FAILS = 5
const LOCKOUT_MS = 15 * 60000
const unlockMs = () => Math.max(1, Number(process.env.VAULT_UNLOCK_MINUTES) || 10) * 60000

const fail = (message, code) => Object.assign(new Error(message), code && { code })

// ---- origins ----

// The one origin an entry belongs to: scheme, host and port, from a full URL. https only, except loopback pages
// (local tools and the tests). No user:pass@ in the URL.
export function originOf(input) {
  let u
  try {
    u = new URL(String(input))
  } catch {
    throw fail(`כתובת לא תקינה: "${String(input).slice(0, 80)}".`)
  }
  if (u.username || u.password) throw fail('כתובת עם שם משתמש או סיסמה בתוכה לא מתקבלת.')
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw fail('רק אתרים ב-https.')
  return u.origin
}

// ---- file ----

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'))
  } catch {
    return null
  }
}
function store(v) {
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 })
  const tmp = `${FILE()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 })
  fs.renameSync(tmp, FILE())
}

const b64 = (b) => Buffer.from(b).toString('base64')
const unb64 = (s) => Buffer.from(String(s), 'base64')

function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plain), c.final()])
  return { iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()) }
}
function open(key, box, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(box.iv))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(unb64(box.tag))
  return Buffer.concat([d.update(unb64(box.ct)), d.final()])
}

function derive(passphrase, kdf) {
  const salt = unb64(kdf.salt)
  const master = crypto.scryptSync(String(passphrase).normalize('NFC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2 })
  const wrap = Buffer.from(crypto.hkdfSync('sha256', master, salt, 'helper-vault/wrap/v1', 32))
  const check = Buffer.from(crypto.hkdfSync('sha256', master, salt, 'helper-vault/verify/v1', 32))
  master.fill(0)
  const verifier = crypto.createHmac('sha256', check).update('helper-vault-verifier').digest('hex')
  check.fill(0)
  return { wrap, verifier }
}

// ---- lock state ----

const session = { key: null, until: 0, timer: null, fails: 0, lockedOutUntil: 0 }

export function lock() {
  if (session.key) session.key.fill(0)
  session.key = null
  session.until = 0
  clearTimeout(session.timer)
}
const unlocked = (now = Date.now()) => {
  if (session.key && now > session.until) lock()
  return Boolean(session.key)
}

function keepOpen(key, now) {
  lock()
  session.key = key
  session.until = now + unlockMs()
  session.timer = setTimeout(lock, unlockMs())
  session.timer.unref?.()
}

function checkPassphrase(p) {
  const s = String(p || '')
  if (s.length < 12) throw fail('סיסמת הכספת צריכה להיות לפחות 12 תווים.')
  if (config.backup?.passphrase && s === config.backup.passphrase) throw fail('סיסמת הכספת חייבת להיות שונה מסיסמת הגיבוי.')
  return s
}

export function setup(passphrase, now = Date.now()) {
  if (!vaultEnabled()) throw fail('הכספת כבויה (CREDENTIAL_VAULT).', 'setup_needed')
  if (load()) throw fail('כבר יש כספת.')
  const kdf = { ...KDF, salt: b64(crypto.randomBytes(16)) }
  const { wrap, verifier } = derive(checkPassphrase(passphrase), kdf)
  store({ v: 1, kdf, verifier, entries: {} })
  keepOpen(wrap, now)
}

export function unlock(passphrase, now = Date.now()) {
  const v = load()
  if (!v) throw fail('אין עדיין כספת.', 'setup_needed')
  if (now < session.lockedOutUntil) throw fail('יותר מדי ניסיונות. אפשר לנסות שוב מאוחר יותר.')
  const { wrap, verifier } = derive(passphrase, v.kdf)
  const a = Buffer.from(verifier, 'hex')
  const b = Buffer.from(v.verifier, 'hex')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    wrap.fill(0)
    if (++session.fails >= MAX_FAILS) {
      session.fails = 0
      session.lockedOutUntil = now + LOCKOUT_MS
    }
    throw fail('סיסמת כספת שגויה.')
  }
  session.fails = 0
  keepOpen(wrap, now)
}

export function status(now = Date.now()) {
  const v = load()
  return {
    enabled: vaultEnabled(),
    autofill: autofillEnabled(),
    created: Boolean(v),
    unlocked: unlocked(now),
    entries: v ? Object.entries(v.entries).map(([id, e]) => ({ id, origin: e.origin, label: e.label })) : [],
  }
}

export function saveEntry({ origin, label, username, password }, now = Date.now()) {
  if (!vaultEnabled()) throw fail('הכספת כבויה (CREDENTIAL_VAULT).', 'setup_needed')
  if (!unlocked(now)) throw fail('הכספת נעולה.', 'locked')
  const v = load()
  const o = originOf(origin)
  if (!password || String(password).length > 1024 || String(username || '').length > 256) throw fail('פרטי התחברות חסרים או ארוכים מדי.')
  const id = `cred_${crypto.randomBytes(6).toString('hex')}`
  const dek = crypto.randomBytes(32)
  const entry = {
    origin: o,
    label: String(label || o).slice(0, 80),
    created: now,
    key: seal(session.key, dek, `wrap|${id}|${o}`),
    data: seal(dek, Buffer.from(JSON.stringify({ username: String(username || ''), password: String(password) })), `data|${id}|${o}`),
  }
  dek.fill(0)
  v.entries[id] = entry
  store(v)
  return { id, origin: o, label: entry.label }
}

export function deleteEntry(id) {
  const v = load()
  if (!v?.entries[id]) throw fail(`אין רשומה ${id}.`)
  delete v.entries[id]
  store(v)
}

// The only place a secret is decrypted. `use` gets it and must not keep it; the buffers are wiped after.
export async function withSecret(id, expectedOrigin, use, now = Date.now()) {
  if (!autofillEnabled()) throw fail('מילוי אוטומטי כבוי (CREDENTIAL_AUTOFILL).', 'setup_needed')
  if (!unlocked(now)) throw fail('הכספת נעולה.', 'locked')
  const e = load()?.entries[id]
  if (!e) throw fail(`אין רשומה ${id}.`)
  if (e.origin !== expectedOrigin) throw fail(`הרשומה שמורה ל-${e.origin}, לא ל-${expectedOrigin}.`)
  const dek = open(session.key, e.key, `wrap|${id}|${e.origin}`)
  const raw = open(dek, e.data, `data|${id}|${e.origin}`)
  dek.fill(0)
  try {
    const { username, password } = JSON.parse(raw.toString('utf8'))
    return await use({ origin: e.origin, username, password })
  } finally {
    raw.fill(0)
  }
}

// ---- one-time secure input requests ----

// id -> { kind: setup | unlock | store, origin, label, csrf, expires, state: pending | done | cancelled | expired }
const requests = new Map()

export function createRequest(kind, { origin, label } = {}, now = Date.now()) {
  if (!vaultEnabled()) throw fail('הכספת כבויה (CREDENTIAL_VAULT).', 'setup_needed')
  if (!['setup', 'unlock', 'store'].includes(kind)) throw fail('סוג בקשה לא מוכר.')
  const o = kind === 'store' ? originOf(origin) : null
  for (const [k, r] of requests) if (r.state !== 'pending' || now > r.expires) requests.delete(k)
  if (requests.size > 20) throw fail('יותר מדי בקשות פתוחות.')
  const id = crypto.randomBytes(32).toString('base64url')
  requests.set(id, { kind, origin: o, label: String(label || o || '').slice(0, 80), csrf: crypto.randomBytes(32).toString('base64url'), expires: now + REQUEST_MS, state: 'pending' })
  return { id, kind, origin: o, expiresInMin: REQUEST_MS / 60000 }
}

export function requestState(id, now = Date.now()) {
  const r = requests.get(id)
  if (!r) return null
  if (r.state === 'pending' && now > r.expires) r.state = 'expired'
  return r
}

export function cancelRequest(id) {
  const r = requests.get(id)
  if (r && r.state === 'pending') r.state = 'cancelled'
  return Boolean(r)
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}

// ---- the secure input page (mounted on the settings site, src/ui.js) ----

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
}
const page = (body) => `<!doctype html><html dir="rtl" lang="he"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>הכספת של Helper</title><body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px;background:#faf8f5;color:#222">${body}</body></html>`
const field = (name, label, type = 'password', extra = '') => `<label style="display:block;margin:12px 0">${label}<br><input name="${name}" type="${type}" ${extra} style="width:100%;padding:8px;font-size:16px"></label>`

// Hosts the page may be served on: loopback, plus VAULT_INPUT_HOSTS (meant for an https front such as tailscale
// serve). A password typed over plain http on a network is not something this page accepts.
function hostOk(req) {
  const host = String(req.headers.host || '').toLowerCase()
  const name = host.replace(/:\d+$/, '')
  if (['127.0.0.1', 'localhost', '[::1]'].includes(name)) return true
  const listed = (process.env.VAULT_INPUT_HOSTS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
  return listed.includes(host) && req.headers['x-forwarded-proto'] === 'https'
}

async function readForm(req, max = 8192) {
  if (!/^application\/x-www-form-urlencoded\b/.test(String(req.headers['content-type'] || ''))) throw fail('סוג תוכן לא נתמך.')
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > max) throw fail('גדול מדי.')
  }
  return new URLSearchParams(raw)
}

// Returns true when it answered the request. ctx: { signedIn(req), origins: [allowed Origin values] }.
// Nothing here logs a request body, and no answer repeats what was typed.
export async function handleVaultHttp(req, res, url, { signedIn, origins }) {
  const m = url.pathname.match(/^\/vault\/r\/([A-Za-z0-9_-]{43})(\/cancel)?$/)
  if (!url.pathname.startsWith('/vault/')) return false
  const reply = (code, body) => (res.writeHead(code, PAGE_HEADERS), res.end(page(body)), true)
  if (!vaultEnabled()) return reply(404, '<h2>הכספת כבויה.</h2>')
  if (!hostOk(req)) return reply(403, '<h2>אפשר להזין סיסמאות רק מהמחשב הזה (127.0.0.1) או דרך כתובת https שהוגדרה.</h2>')
  if (!signedIn(req)) return reply(403, '<h2>צריך להיכנס לאתר ההגדרות קודם.</h2>')
  if (!m) return reply(404, '<h2>לא נמצא.</h2>')
  const id = m[1]
  const r = requestState(id)
  if (!r) return reply(404, '<h2>הבקשה לא קיימת.</h2>')
  if (r.state !== 'pending') return reply(410, `<h2>${{ done: 'הבקשה כבר טופלה.', cancelled: 'הבקשה בוטלה.', expired: 'הבקשה פגה. צריך לבקש קישור חדש.' }[r.state]}</h2>`)
  if (req.method === 'GET' && !m[2]) {
    const what = { setup: 'יצירת כספת חדשה', unlock: 'פתיחת הכספת', store: `שמירת פרטי התחברות ל-<b dir="ltr">${esc(r.origin)}</b>` }[r.kind]
    const locked = !unlocked()
    const fields =
      r.kind === 'setup' ? field('passphrase', 'סיסמת כספת חדשה (לפחות 12 תווים)', 'password', 'autocomplete="new-password" required minlength="12"') + field('confirm', 'שוב, לאימות', 'password', 'autocomplete="new-password" required')
      : r.kind === 'unlock' ? field('passphrase', 'סיסמת הכספת', 'password', 'autocomplete="current-password" required')
      : field('username', 'שם משתמש', 'text', 'autocomplete="off" spellcheck="false"') + field('password', 'סיסמה לאתר', 'password', 'autocomplete="off" required') + (locked ? field('passphrase', 'סיסמת הכספת (היא נעולה)', 'password', 'autocomplete="current-password" required') : '')
    return reply(200, `<h2>${what}</h2><p>מה שתקליד כאן נשמר מוצפן במחשב הזה ולא עובר בצ'אט.</p><form method="post" action="/vault/r/${id}"><input type="hidden" name="csrf" value="${r.csrf}">${fields}<button style="padding:10px 18px;font-size:16px">שמירה</button></form><form method="post" action="/vault/r/${id}/cancel" style="margin-top:12px"><input type="hidden" name="csrf" value="${r.csrf}"><button style="padding:6px 12px">ביטול</button></form>`)
  }
  if (req.method !== 'POST') return reply(405, '<h2>לא נתמך.</h2>')
  // A cross-site form post carries the other site's Origin; one with no Origin at all is refused too.
  const listed = (process.env.VAULT_INPUT_HOSTS || '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean).map((h) => `https://${h}`)
  if (![...origins, ...listed].includes(String(req.headers.origin || ''))) return reply(403, '<h2>מקור לא מורשה.</h2>')
  if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return reply(403, '<h2>מקור לא מורשה.</h2>')
  let form
  try {
    form = await readForm(req)
  } catch (e) {
    return reply(400, `<h2>${esc(e.message)}</h2>`)
  }
  if (!sameToken(form.get('csrf'), r.csrf)) return reply(403, '<h2>הטופס לא תקף. פתח את הקישור שוב.</h2>')
  if (m[2]) {
    r.state = 'cancelled'
    return reply(200, '<h2>בוטל. שום דבר לא נשמר.</h2>')
  }
  try {
    if (r.kind === 'setup') {
      if (form.get('passphrase') !== form.get('confirm')) return reply(400, '<h2>הסיסמאות לא זהות.</h2>')
      setup(form.get('passphrase'))
    } else if (r.kind === 'unlock') {
      unlock(form.get('passphrase'))
    } else {
      if (!unlocked()) unlock(form.get('passphrase'))
      const saved = saveEntry({ origin: r.origin, label: r.label, username: form.get('username') || '', password: form.get('password') || '' })
      r.saved = saved.id
    }
  } catch (e) {
    return reply(400, `<h2>${esc(e.message)}</h2>`)
  }
  r.state = 'done'
  return reply(200, `<h2>${r.kind === 'store' ? 'נשמר מוצפן.' : r.kind === 'setup' ? 'הכספת נוצרה ונפתחה.' : 'הכספת פתוחה.'}</h2><p>אפשר לסגור את הדף.</p>`)
}

// Where the page lives, set by the settings site when it starts (src/ui.js).
let inputBase = ''
export const setVaultInputBase = (url) => (inputBase = String(url || '').replace(/\/+$/, ''))
export const vaultInputBase = () => inputBase
