// Keeps saved passwords out of everything that leaves the browser as text: probes, control labels, tool results,
// and every message the browser agent sends to a model.
//
// After the vault (src/vault-tools.js) fills a password into a page, that password is held here, in this process's
// memory only and until Helper restarts, so any text read from that page can be scrubbed of it even if the page copies
// it somewhere (a "show password" toggle, an echo in the page, a label). It is never written to disk, logged or
// returned.
//
// Images cannot be scrubbed that way: a page can draw the password anywhere (a button that echoes the field, a
// same-origin frame, a canvas), and nothing here can prove a picture is clean. So after a fill the images fail
// closed: imagesBlocked() stays true until this process restarts, and while it is true no screenshot of the browser
// or of this machine's screen is taken for a model or a chat (errand-browser captureOn, pc.screenshot, the agent
// loop in computer-use.js), and redactDeep drops any image part from a model request.
// A fill holds the password for as long as that lasts (memory only), so text read from the page later is still
// scrubbed. Restarting Helper clears both.
const held = new Map() // secret -> expires at (ms)
export const HOLD_MS = Infinity
let tainted = false
export const MARK = '[סיסמה הוסתרה]'
// A run of this many characters that also appears in a held secret is scrubbed too, so a cut or partly copied
// password is caught as well as a whole one.
const MIN_RUN = 8

export function holdForRedaction(secret, { ttlMs = HOLD_MS, now = Date.now() } = {}) {
  const s = String(secret ?? '')
  if (s.length < 4) return
  held.set(s, now + ttlMs)
  tainted = true
}

function live(now = Date.now()) {
  for (const [s, until] of held) if (until <= now) held.delete(s)
  return [...held.keys()]
}
export const heldCount = () => live().length
// True from the first fill until restart, even if a hold given a shorter time has expired.
export const imagesBlocked = () => tainted || heldCount() > 0
// Self-tests only.
export const forgetAll = () => {
  held.clear()
  tainted = false
}
export const IMAGE_WITHHELD = 'No screenshot: a saved password was filled in the browser since Helper started, and a page can show it anywhere, so no picture is sent. Work from the address, the probe answers and what the user tells you, or reply "need_user".'

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

// A copy of a value with every string scrubbed. While images are blocked, every image part (and any image data URL)
// is replaced by a text note, so no picture reaches the model even if a caller attached one. keepImages is only for a
// body whose pictures cannot show this machine's browser or screen (the phone, the TV); its text is still scrubbed.
export function redactDeep(value, { keepImages = false } = {}) {
  if (!imagesBlocked()) return value
  const image = (v) => v && typeof v === 'object' && !Array.isArray(v) && (v.type === 'image_url' || v.type === 'image' || v.type === 'input_image')
  const walk = (v) => {
    if (typeof v === 'string') return /^data:image\//i.test(v) ? (keepImages ? v : IMAGE_WITHHELD) : redact(v)
    if (Array.isArray(v)) return v.map((x) => (image(x) && !keepImages ? { type: 'text', text: IMAGE_WITHHELD } : walk(x)))
    if (v && typeof v === 'object' && !Buffer.isBuffer(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value)
}
