// One lock per device ('lights', 'tv'), shared by every path that switches one: the remote panel's execute, the
// WhatsApp fast commands, and the model's own device tools. Two actions never run on the same device at once.
//
// A busy device is refused at once, never queued in silence: the caller gets { busy: true } and nothing runs.
//
// The lock is held until the call underneath has really ended. When the caller stops waiting (timeoutMs) the call
// may still be running, so the device stays held and is marked quarantined: every further action on it is refused,
// with that reason, until the call settles.

const held = new Map() // device -> { since, label, quarantined }

export const deviceState = (device) => {
  const h = held.get(String(device))
  return h ? { busy: true, since: h.since, label: h.label, quarantined: h.quarantined } : { busy: false }
}

// -> { busy: true, quarantined } | { timedOut: true } | { ok: true, value } | { ok: false, error }
export function withDevice(device, fn, { timeoutMs = 0, label = '', now = () => Date.now() } = {}) {
  const key = String(device)
  const h = held.get(key)
  if (h) return Promise.resolve({ busy: true, quarantined: h.quarantined })
  const entry = { since: now(), label: String(label).slice(0, 40), quarantined: false }
  held.set(key, entry)
  let work
  try {
    work = Promise.resolve(fn())
  } catch (e) {
    work = Promise.reject(e)
  }
  const settled = work.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  )
  // Released only when the call itself is over, whoever is still waiting for it.
  settled.then(() => {
    if (held.get(key) === entry) held.delete(key)
  })
  if (!timeoutMs) return settled
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      entry.quarantined = true
      resolve({ timedOut: true })
    }, timeoutMs)
  })
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer))
}

// Words for a person when the device is held.
export const busyText = (r) => (r?.quarantined ? 'פעולה קודמת על המכשיר עוד לא הסתיימה ומצבה לא ידוע. לא שולחים עוד פקודה עד שתסתיים.' : 'המכשיר באמצע פעולה אחרת.')

// For the self-tests only.
export const _resetDeviceLocks = () => held.clear()
