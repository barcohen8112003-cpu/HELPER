// The avatar's mood: a small state machine with four states, and what moves it between them.
//
//   idle   the rest of the time: a gentle breathing motion
//   dance  while music plays: music HELPER started on this PC (play / media keys), and, when the owner turned it on
//          (avatarSystemMusic), any app Windows lists as playing ("now playing", see audio-watch.js)
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
// Music from any app (when tracked): the dance stops this long after Windows says nothing plays, so the gap between
// two songs doesn't stop it.
const SYSTEM_STOP_MS = 3000
// HELPER's own music, when Windows' list is tracked: if nothing is listed as playing for HELPER_QUIET_MS (and the
// browser had HELPER_GRACE_MS to start the song), the song is over and the dance ends before the 10 minutes.
const HELPER_GRACE_MS = 20000
const HELPER_QUIET_MS = 15000

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
  let musicFrom = 0           // when HELPER's own music started
  let live = null             // listen | think | speak | work | null
  let last = null
  // Windows' "now playing" list, only while the owner turned it on (trackSystem(true)).
  let tracking = false
  let sysNow = false          // the latest report: some app is playing
  let sysDance = false        // dancing for it (stays on SYSTEM_STOP_MS after sysNow went false)
  let sysOffAt = 0
  let sysQuietSince = 0       // since when nothing is listed as playing

  /** When HELPER's own music counts as over because Windows lists nothing playing, or 0. */
  function helperQuietEnd() {
    if (!tracking || sysNow || !musicUntil) return 0
    return Math.max(musicFrom + HELPER_GRACE_MS, sysQuietSince + HELPER_QUIET_MS)
  }

  function settle(t) {
    if (sysOffAt && t >= sysOffAt) { sysDance = false; sysOffAt = 0 }
    if (musicUntil && t >= musicUntil) musicUntil = 0
    const q = helperQuietEnd()
    if (q && t >= q) musicUntil = 0
  }

  function compute() {
    const t = now()
    settle(t)
    if (burst && t < burst.until) return { state: burst.state, variant: burst.variant }
    burst = null
    if (live) return { state: 'react', variant: live }
    if (musicUntil || (tracking && sysDance)) return { state: 'dance', variant: '' }
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
    settle(now())
    const playing = Boolean(musicUntil)
    const want = on === 'toggle' ? !playing : Boolean(on)
    musicUntil = want ? now() + MUSIC_MAX_MS : 0
    if (want && !playing) musicFrom = now()
    return tick()
  }

  /** Follow Windows' "now playing" list (true) or not (false: only HELPER's own music dances, as before). */
  function trackSystem(on) {
    const want = on === true
    if (want === tracking) return tick()
    tracking = want
    sysNow = false; sysDance = false; sysOffAt = 0; sysQuietSince = now()
    return tick()
  }

  /** Windows says some app is playing (true) or nothing is (false). Ignored unless tracking. */
  function systemMusic(on) {
    if (!tracking) return tick()
    const t = now()
    settle(t)
    if (on === true) { sysNow = true; sysDance = true; sysOffAt = 0 }
    else if (sysNow) { sysNow = false; sysQuietSince = t; if (sysDance) sysOffAt = t + SYSTEM_STOP_MS }
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
    const ends = [burst && burst.until, musicUntil, sysOffAt, helperQuietEnd()].filter((x) => x && x > t)
    return ends.length ? Math.min(...ends) - t : null
  }

  return { event, music, activity, trackSystem, systemMusic, tick, nextChangeIn, current: () => compute() }
}

module.exports = { createAvatarState, actionFor, activityFor, musicFromStep, STATES, VARIANTS, ACTIVITIES, EVENT_TYPES, REACT_MS, ALERT_MS, MUSIC_MAX_MS, SYSTEM_STOP_MS, HELPER_GRACE_MS, HELPER_QUIET_MS }
