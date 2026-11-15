// The avatar's event feed: what HELPER on the cloud tells the desktop avatar (desktop/ui/avatar.html) so it can wave
// when a message for the owner went out, notice a background task starting or ending, and jump on an urgent alert.
//
// Content-free by construction. An event is exactly { id, type, severity, at }: a closed type, a closed severity, a
// time and a sequence number. publish() takes a type name and nothing else, so a message's text, a sender, a group
// name or a task title has no field to travel in, whatever the caller passes. The same privacy bar as the ephemeral
// message work: content never crosses into a new channel.
//
// Off by default twice: the feed exists only with PANEL_ENABLED=on and PANEL_EVENTS=on, and the route
// (GET /panel/api/events in src/panel.js) answers only a credential that holds the events:avatar scope, which no
// credential has until the owner switches it on in the settings site.

export const EVENT_TYPES = Object.freeze(['message', 'task-start', 'task-end', 'alert'])
export const SEVERITIES = Object.freeze(['low', 'normal', 'high'])
export const EVENTS_SCOPE = 'events:avatar'

const DEFAULT_SEVERITY = Object.freeze({ message: 'normal', 'task-start': 'low', 'task-end': 'low', alert: 'high' })

export function eventsConfig(env = process.env) {
  return { enabled: /^(1|on|true|yes)$/i.test(String(env.PANEL_EVENTS || '')) }
}

// The one event shape. Anything that is not a known type is dropped; anything besides type and severity is ignored.
export function cleanEvent(type, severity) {
  const t = String(type || '')
  if (!EVENT_TYPES.includes(t)) return null
  const s = SEVERITIES.includes(severity) ? severity : DEFAULT_SEVERITY[t]
  return { type: t, severity: t === 'alert' ? 'high' : s }
}

// keep: how many recent events are held. maxAgeMs: older ones are never handed out (a desktop that reconnects after
// an hour does not jump for an alert that is long over).
export function createEventFeed({ now = () => Date.now(), keep = 50, maxAgeMs = 2 * 60000, maxWaiters = 20 } = {}) {
  let seq = 0
  let list = []
  const waiters = new Set()

  const fresh = () => list.filter((e) => now() - Date.parse(e.at) <= maxAgeMs)

  // -> the event as stored, or null when the type is not one. Never throws: a feed problem must not break a send.
  function publish(type, severity) {
    const clean = cleanEvent(type, severity)
    if (!clean) return null
    const ev = Object.freeze({ id: ++seq, type: clean.type, severity: clean.severity, at: new Date(now()).toISOString() })
    list.push(ev)
    if (list.length > keep) list = list.slice(-keep)
    for (const w of [...waiters]) w()
    return ev
  }

  // Events after `cursor`, still fresh. A cursor from before a restart (bigger than what exists) means "from now".
  function since(cursor) {
    const c = Number(cursor)
    if (!Number.isInteger(c) || c < 0 || c > seq) return []
    return fresh().filter((e) => e.id > c)
  }

  // Long poll: resolves with events after `cursor` as soon as there are any, or [] after waitMs. Too many waiters
  // at once (a misbehaving client) get [] at once rather than another open timer.
  function wait(cursor, waitMs, signal) {
    const ready = since(cursor)
    if (ready.length || waitMs <= 0 || waiters.size >= maxWaiters) return Promise.resolve(ready)
    return new Promise((resolve) => {
      let timer
      const done = () => {
        clearTimeout(timer)
        waiters.delete(wake)
        signal?.removeEventListener?.('abort', done)
        resolve(since(cursor))
      }
      const wake = () => done()
      waiters.add(wake)
      timer = setTimeout(done, waitMs)
      signal?.addEventListener?.('abort', done, { once: true })
    })
  }

  return { publish, since, wait, cursor: () => seq, waiting: () => waiters.size }
}
