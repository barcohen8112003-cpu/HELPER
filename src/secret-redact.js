// Keeps saved passwords out of everything that leaves the browser as text: probes, control labels, tool results,
// and every message the browser agent sends to a model.
//
// After the vault (src/vault-tools.js) fills a password into a page, that password is held here, in this process's
// memory only and for a limited time, so any text read from that page can be scrubbed of it even if the page copies
// it somewhere (a "show password" toggle, an echo in the page, a label). It is never written to disk, logged or
// returned. Images are masked separately at capture (errand-browser maskSecrets).
const held = new Map() // secret -> expires at (ms)
export const HOLD_MS = 30 * 60000
export const MARK = '[סיסמה הוסתרה]'
// A run of this many characters that also appears in a held secret is scrubbed too, so a cut or partly copied
// password is caught as well as a whole one.
const MIN_RUN = 8

export function holdForRedaction(secret, { ttlMs = HOLD_MS, now = Date.now() } = {}) {
  const s = String(secret ?? '')
  if (s.length >= 4) held.set(s, now + ttlMs)
}

function live(now = Date.now()) {
  for (const [s, until] of held) if (until <= now) held.delete(s)
  return [...held.keys()]
}
export const heldCount = () => live().length
export const forgetAll = () => held.clear()

export function redact(text, { now = Date.now() } = {}) {
  if (typeof text !== 'string' || !text) return text
  const secrets = live(now)
  if (!secrets.length) return text
  let out = text
  for (const s of secrets) {
    for (const v of new Set([s, s.trim(), s.replace(/\s+/g, ' ').trim()])) if (v) out = out.split(v).join(MARK)
    const k = Math.min(MIN_RUN, s.length)
    let res = ''
    let j = 0
    while (j < out.length) {
      if (j + k <= out.length && s.includes(out.slice(j, j + k))) {
        let end = j + k
        while (end < out.length && s.includes(out.slice(j, end + 1))) end++
        res += MARK
        j = end
      } else {
        res += out[j]
        j++
      }
    }
    out = res
  }
  return out
}

// A copy of a value with every string scrubbed (messages for a model: text parts; image data URLs are left as
// they are, since images are masked when captured).
export function redactDeep(value) {
  if (!heldCount()) return value
  const walk = (v, key) => {
    if (typeof v === 'string') return key === 'url' && v.startsWith('data:image/') ? v : redact(v)
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object' && !Buffer.isBuffer(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    return v
  }
  return walk(value)
}
