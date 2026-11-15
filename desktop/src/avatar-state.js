// The avatar's mood: a small state machine with four states, and what moves it between them.
//
//   idle   the rest of the time: a gentle breathing motion
//   dance  while music plays (music HELPER started on this PC: play / media keys)
//   react  with a variant. Short bursts from events: a message for the owner went out (wave), a task started (work)
//          or ended (done). And, for as long as it lasts, what HELPER on this PC is doing right now (the app's own
//          state, see activityFor): listening (listen), thinking (think), speaking (speak), running tools (work)
//   alert  a few seconds: an urgent notice. Unmistakable, and stops on its own
//
// Priority: alert > event burst > live activity > dance > idle. A burst never cuts an alert short; an alert replaces
// a burst; when a burst ends the avatar goes back to what HELPER is doing (or dancing, or idle).
// It knows event types only. Whatever else an event object carries (it should carry nothing) is never read, so no
// message text, sender or group name can reach the window through here.
'use strict'

const STATES = Object.freeze(['idle', 'dance', 'react', 'alert'])
const EVENT_TYPES = Object.freeze(['message', 'task-start', 'task-end', 'alert'])
const VARIANT = Object.freeze({ message: 'wave', 'task-start': 'work', 'task-end': 'done' })
const ACTIVITIES = Object.freeze(['listen', 'think', 'speak', 'work'])
const VARIANTS = Object.freeze(['wave', 'work', 'done', 'listen', 'think', 'speak'])
// The app's own modes (main.js `mode`) that mean the user is talking or typing to HELPER.
const LISTEN_MODES = Object.freeze(['listening', 'dictating', 'typing', 'pointing'])

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

/**
 * What HELPER on this PC is doing, from the app's own state: { mode, speaking, working }.
 *   mode      main.js mode: idle | listening | dictating | thinking | typing | pointing
 *   speaking  HELPER's voice is playing in the bubble
 *   working   tool steps are running on this PC right now (hands), from an instant command or the brain
 * Returns listen | speak | work | think, or null for nothing (idle). Talking to HELPER wins, then its voice, then
 * its hands, then thinking.
 */
function activityFor(app) {
  const a = app && typeof app === 'object' ? app : {}
  const mode = typeof a.mode === 'string' ? a.mode : 'idle'
  if (LISTEN_MODES.includes(mode)) return 'listen'
  if (a.speaking === true) return 'speak'
  if (a.working === true) return 'work'
  if (mode === 'thinking') return 'think'
  return null
}

function createAvatarState({ now = () => Date.now(), onChange = () => {} } = {}) {
  let burst = null            // { state, variant, until }
  let musicUntil = 0
  let live = null             // listen | think | speak | work | null
  let last = null

  function compute() {
    const t = now()
    if (burst && t < burst.until) return { state: burst.state, variant: burst.variant }
    burst = null
    if (live) return { state: 'react', variant: live }
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

  /** What HELPER on this PC is doing now (activityFor's answer); anything else means nothing. */
  function activity(name) {
    live = ACTIVITIES.includes(name) ? name : null
    return tick()
  }

  /** Milliseconds until the state can change by itself (a burst or the music running out), or null. */
  function nextChangeIn() {
    const t = now()
    const ends = [burst && burst.until, musicUntil].filter((x) => x && x > t)
    return ends.length ? Math.min(...ends) - t : null
  }

  return { event, music, activity, tick, nextChangeIn, current: () => compute() }
}

module.exports = { createAvatarState, actionFor, activityFor, musicFromStep, STATES, VARIANTS, ACTIVITIES, EVENT_TYPES, REACT_MS, ALERT_MS, MUSIC_MAX_MS }
