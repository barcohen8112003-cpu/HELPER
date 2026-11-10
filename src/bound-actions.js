// Bound approvals for tools that change something outside Helper (a Google file, a mail, an event, a GitHub issue).
//
// The old pattern was `if (!(await ctx.confirm(text))) return` inside each tool. That stops a "no", but nothing ties
// the "yes" to what then runs: a tool could re-read its arguments, a file could change between the question and the
// write, and a retry after a timeout could do the same thing twice. Here every mutation goes through one path:
//
//   prepare  -> resolves exact ids (account, file, event, repository...) and takes a fingerprint of what the user
//               will be shown (the current revision, the draft's bytes, the range's values). Read-only.
//   ask      -> the question goes to ctx.confirm, which in production is the owner's own WhatsApp chat (index.js
//               askOnce: only a message or reaction from the paired owner can answer it). Only `true` is a yes.
//               Arguments the model adds (confirmed, approved, force...) are never read.
//   grant    -> a single-use grant bound to the SHA-256 of { tool, account, operation, fingerprint }, with an expiry.
//   recheck  -> after the yes, the fingerprint is taken again. If the file, draft or event changed, nothing is sent.
//   execute  -> runs with the frozen approved operation only, after the grant is consumed against it.
//   ledger   -> what ran is recorded by digest (no content): the same approved operation is not sent twice, and an
//               operation whose outcome is unknown (timeout, no answer) is not retried automatically.
//
// Text the model read (a mail, a web page, a document) cannot answer the question: the answer comes only from
// ctx.confirm. A call with no ctx.confirm is refused. Every production confirm (WhatsApp, background jobs, live
// voice, the bridge, the remote panel) ends in the same askOnce in the owner's chat; a scheduled task started with
// noAsk gets a confirm that always says no.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

export const GRANT_TTL_MS = 10 * 60000
const LEDGER_KEEP_MS = 24 * 3600 * 1000
// WhatsApp shows long messages, but a question nobody can read to the end is not an informed yes.
export const MAX_QUESTION_CHARS = 6000

// The same value always gives the same text: object keys sorted, undefined dropped.
export function canonical(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Buffer.isBuffer(value)) return JSON.stringify(`buffer:${crypto.createHash('sha256').update(value).digest('hex')}`)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

export const digestOf = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex')

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

// A structured result for the model: what happened, in one word it cannot mistake, plus the text.
// status: done | declined | refused | changed | unknown | already_done | setup_needed | unsupported | failed
export const outcome = (status, text, extra = {}) => ({ status, text: `[${status}] ${text}`, ...extra })

// ---- grants ----

const grants = new Map()

export function issueGrant(digest, { now = Date.now(), ttlMs = GRANT_TTL_MS } = {}) {
  const id = crypto.randomBytes(16).toString('hex')
  grants.set(id, { digest, expires: now + ttlMs, used: false })
  return id
}

// Throws unless the grant exists, is unused, has not expired and was issued for exactly this digest.
export function consumeGrant(id, digest, { now = Date.now() } = {}) {
  const g = grants.get(id)
  if (!g) throw Object.assign(new Error('אין אישור תקף לפעולה הזאת'), { code: 'no-grant' })
  if (g.used) throw Object.assign(new Error('האישור כבר נוצל'), { code: 'grant-used' })
  if (now > g.expires) {
    grants.delete(id)
    throw Object.assign(new Error('האישור פג. צריך לשאול שוב'), { code: 'grant-expired' })
  }
  if (g.digest !== digest) throw Object.assign(new Error('הפעולה שונתה אחרי האישור'), { code: 'grant-mismatch' })
  g.used = true
  grants.delete(id)
}

// ---- ledger (digest -> state, no content) ----

const LEDGER = () => path.join(DATA_DIR, 'mutation-ledger.json')

function loadLedger(now = Date.now()) {
  let all = {}
  try {
    all = JSON.parse(fs.readFileSync(LEDGER(), 'utf8'))
  } catch {}
  for (const [k, v] of Object.entries(all)) if (!v || now - v.at > LEDGER_KEEP_MS) delete all[k]
  return all
}

function writeLedger(digest, entry) {
  const all = loadLedger()
  if (entry) all[digest] = entry
  else delete all[digest]
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${LEDGER()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(all))
  fs.renameSync(tmp, LEDGER())
}

export const ledgerEntry = (digest) => loadLedger()[digest] || null
// For the owner, from the settings or a test: lets an operation whose outcome was unknown be asked again.
export const clearLedgerEntry = (digest) => writeLedger(digest, null)

// An error that came with a real answer from the service (4xx/5xx) says the request was refused. Anything else
// (timeout, connection reset, no answer) may or may not have reached it, so the outcome is unknown.
export const isDefinitive = (e) => Number.isInteger(e?.status) && e.status >= 400 && e.status < 500

// The one path every mutation takes. Returns an outcome(); never throws for a refusal.
//   tool:     the tool's name (part of what is approved)
//   account:  which identity acts (an email, "github:<login>", "local") — part of what is approved
//   prepare:  async () => ({ op, fingerprint, question, account? }) | outcome(...) to stop early. Read-only.
//   recheck:  async (op) => fingerprint now. Must equal the one approved.
//   execute:  async (op) => ({ ref, text, confirmed }) — `confirmed` is true only when the service returned the
//             created/changed object. Without it the result says the change is not confirmed.
export async function boundMutation(ctx, { tool, account, prepare, recheck, execute, now = () => Date.now() }) {
  if (typeof ctx?.confirm !== 'function') return outcome('refused', 'אין כאן משתמש מאומת שיכול לאשר את הפעולה, אז היא לא בוצעה.')
  let prepared
  try {
    prepared = await prepare()
  } catch (e) {
    return outcome(e.status === 'setup_needed' || e.code === 'setup_needed' ? 'setup_needed' : e.code === 'unsupported' ? 'unsupported' : 'refused', e.message)
  }
  if (prepared?.status) return prepared
  const { op, fingerprint = null, question } = prepared
  // The account is often known only once prepare has resolved it.
  account = prepared.account ?? account
  deepFreeze(op)
  const digest = digestOf({ tool, account, op, fingerprint })
  const seen = ledgerEntry(digest)
  if (seen?.state === 'done') return outcome('already_done', `הפעולה הזאת כבר בוצעה${seen.ref ? ` (${seen.ref})` : ''}. לא שולח שוב.`, { ref: seen.ref })
  if (seen?.state === 'unknown') return outcome('unknown', 'ניסיון קודם של אותה פעולה בדיוק נגמר בלי תשובה ברורה, אז ייתכן שהיא כבר בוצעה. לא מנסה שוב אוטומטית: צריך לבדוק ידנית.')
  if (typeof question !== 'string' || !question.trim()) return outcome('refused', 'אין נוסח מלא להציג לאישור, אז הפעולה לא בוצעה.')
  if (question.length > MAX_QUESTION_CHARS) return outcome('refused', `השינוי ארוך מכדי להציג אותו במלואו לאישור (${question.length} תווים, מקסימום ${MAX_QUESTION_CHARS}). צריך לחלק אותו לחלקים קטנים יותר.`)
  // Only a strict true is a yes. A truthy string ("no") from a broken confirm is not.
  const yes = (await ctx.confirm(question)) === true
  if (!yes) return outcome('declined', 'המשתמש לא אישר, ולכן שום דבר לא שונה. אל תנסה שוב ואל תעקוף.')
  const grant = issueGrant(digest, { now: now() })
  if (recheck) {
    let current
    try {
      current = await recheck(op)
    } catch (e) {
      return outcome('refused', `לא הצלחתי לוודא שהמצב לא השתנה מאז האישור (${e.message}). לא שיניתי כלום.`)
    }
    if (canonical(current) !== canonical(fingerprint)) return outcome('changed', 'היעד השתנה מאז שאישרת (גרסה, תוכן או טיוטה אחרים). לא שיניתי כלום; צריך להציג ולאשר מחדש.')
  }
  try {
    consumeGrant(grant, digestOf({ tool, account, op, fingerprint }), { now: now() })
  } catch (e) {
    return outcome('refused', e.message)
  }
  writeLedger(digest, { tool, state: 'unknown', at: now() })
  let done
  try {
    done = await execute(op)
  } catch (e) {
    if (isDefinitive(e)) {
      writeLedger(digest, null)
      if (e.status === 412 || e.code === 'revision-changed') return outcome('changed', `השירות סירב כי היעד השתנה מאז האישור: ${e.message}`)
      return outcome('failed', `השירות סירב: ${e.message}`)
    }
    return outcome('unknown', `אין תשובה ברורה מהשירות (${e.message}). ייתכן שהפעולה בוצעה; לא מנסה שוב אוטומטית.`)
  }
  if (!done?.confirmed) return outcome('unknown', `${done?.text || 'השירות לא החזיר אישור'}. לא ידוע בוודאות שהשינוי בוצע.`)
  writeLedger(digest, { tool, state: 'done', at: now(), ref: String(done.ref || '').slice(0, 200) })
  return outcome('done', done.text, { ref: done.ref })
}

// ---- Google accounts for writing ----

// The account a Google write acts as. Never a guess: the named account must be connected and writable, and with no
// name there must be exactly one writable account. `scopesAny`: the call needs at least one of these scopes in the
// grant Google actually returned at the last token exchange (not the list Helper asked for).
export async function googleWriteAccount(account, { scopesAny = [], google, readOnly = [] } = {}) {
  const all = google.googleAccounts()
  if (!all.length) throw Object.assign(new Error('אין חשבון Google מחובר.'), { code: 'setup_needed' })
  const writable = all.filter((a) => !readOnly.includes(a.toLowerCase()))
  let email
  if (account) {
    email = all.find((a) => a.toLowerCase() === String(account).trim().toLowerCase())
    if (!email) throw new Error(`החשבון ${account} לא מחובר. מחוברים: ${all.join(', ')}`)
    if (!writable.includes(email)) throw new Error(`החשבון ${email} מוגדר לקריאה בלבד.`)
  } else if (writable.length === 1) {
    email = writable[0]
  } else {
    throw new Error(`לא ברור מאיזה חשבון לפעול (${writable.join(', ') || 'אין חשבון לכתיבה'}). צריך לציין account.`)
  }
  if (scopesAny.length) {
    const granted = await google.grantedScopes(email)
    if (!granted) throw Object.assign(new Error(`לא הצלחתי לוודא אילו הרשאות גוגל נתן לחשבון ${email}. לא מבצע.`), { code: 'setup_needed' })
    if (!scopesAny.some((s) => granted.includes(s))) {
      throw Object.assign(new Error(`לחשבון ${email} אין את ההרשאה שהפעולה צריכה (אחת מאלה: ${scopesAny.join(', ')}). צריך להוסיף אותה ל-SCOPES ולחבר את החשבון מחדש; זה לא נעשה אוטומטית.`), { code: 'setup_needed' })
    }
  }
  return email
}
