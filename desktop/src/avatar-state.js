// The avatar's mood: a small state machine with four states, and what moves it between them.
//
//   idle   the rest of the time: a gentle breathing bob
//   dance  while music plays (music HELPER started on this PC: play / media keys)
//   react  a few seconds: a message for the owner went out (wave), a task started (busy) or ended (done)
//   alert  a few seconds: an urgent notice. Jumps, harder to miss, and stops on its own
//
// Priority: alert > react > dance > idle. A react never cuts an alert short; an alert replaces a react.
// It knows event types only. Whatever else an event object carries (it should carry nothing) is never read, so no
// message text, sender or group name can reach the window through here.
'use strict'

const STATES = Object.freeze(['idle', 'dance', 'react', 'alert'])
const EVENT_TYPES = Object.freeze(['message', 'task-start', 'task-end', 'alert'])
const VARIANT = Object.freeze({ message: 'wave', 'task-start': 'work', 'task-end': 'done' })

const REACT_MS = 3500
const ALERT_MS = 4500
// HELPER opens music in the browser and cannot see when the song ends, so a dance stops by itself after this long
// unless the music is paused or stopped first (media keys, "תעצור").
const MUSIC_MAX_MS = 10 * 60000

/** The animation for one event type, or null for anything that is not a known type. */
function actionFor(type) {
  const t = typeof type === 'string' ? type : ''
  if (!EVENT_TYPES.includes(t)) return null
  return t === 'alert' ? { state: 'alert', variant: '' } : { state: 'react', variant: VARIANT[t] }
}

/**
 * What one of HELPER's own steps on this PC means for music: true (started), false (stopped), 'toggle' (play/pause
 * key), or null (nothing to do with music). step: { cmd, args } as in hands.js.
 */
function musicFromStep(step) {
  if (!step || typeof step !== 'object') return null
  const args = step.args || {}
  if (step.cmd === 'play') return true
  if (step.cmd === 'media') {
    if (args.op === 'stop' || args.op === 'pause') return false
    if (args.op === 'play') return true
    if (args.op === 'next' || args.op === 'prev') return true
    return 'toggle'
  }
  return null
}

function createAvatarState({ now = () => Date.now(), onChange = () => {} } = {}) {
  let burst = null            // { state, variant, until }
  let musicUntil = 0
  let last = null

  function compute() {
    const t = now()
    if (burst && t < burst.until) return { state: burst.state, variant: burst.variant }
    burst = null
    if (musicUntil && t < musicUntil) return { state: 'dance', variant: '' }
    musicUntil = 0
    return { state: 'idle', variant: '' }
  }

  /** Recomputes, tells onChange when the state changed, returns { state, variant }. */
  function tick() {
    const s = compute()
    if (!last || last.state !== s.state || last.variant !== s.variant) {
      last = s
      try { onChange({ state: s.state, variant: s.variant }) } catch { /* the window may be gone */ }
    }
    return { state: s.state, variant: s.variant }
  }

  /** One event: only its type is read. Returns the state after it. */
  function event(ev) {
    const type = ev && typeof ev === 'object' ? ev.type : ev
    const a = actionFor(type)
    if (!a) return tick()
    const t = now()
    if (a.state === 'alert') burst = { state: 'alert', variant: '', until: t + ALERT_MS }
    else if (!(burst && burst.state === 'alert' && t < burst.until)) burst = { state: 'react', variant: a.variant, until: t + REACT_MS }
    return tick()
  }

  /** on: true, false or 'toggle'. */
  function music(on) {
    const playing = Boolean(musicUntil && now() < musicUntil)
    const want = on === 'toggle' ? !playing : Boolean(on)
    musicUntil = want ? now() + MUSIC_MAX_MS : 0
    return tick()
  }

  /** Milliseconds until the state can change by itself (a burst or the music running out), or null. */
  function nextChangeIn() {
    const t = now()
    const ends = [burst && burst.until, musicUntil].filter((x) => x && x > t)
    return ends.length ? Math.min(...ends) - t : null
  }

  return { event, music, tick, nextChangeIn, current: () => compute() }
}

module.exports = { createAvatarState, actionFor, musicFromStep, STATES, EVENT_TYPES, REACT_MS, ALERT_MS, MUSIC_MAX_MS }
