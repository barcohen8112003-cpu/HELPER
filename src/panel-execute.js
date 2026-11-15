// The remote panel's execute: from a catalog action (src/panel-actions.js) to the existing device function, with
// checked values only. No model, no free text: a room is looked up in a closed map, and nothing the client sent is
// ever passed on as a command.
//
// Every run ends in one of three states, decided by the handler from data, never by matching the words of a reply:
//   succeeded  the device reports the state that was asked for (or was already in it)
//   failed     certain that nothing ran: refused before sending, the device was busy, nothing matched, or the
//              device itself answered that it failed
//   unknown    anything else: an error after the command left, or no answer in time. A stop, not a retry: it is
//              never run again by itself, and the way forward is to check the device first.
import { controlHomeDeviceResult } from './google-home.js'
import { tvPowerOff } from './tv-tools.js'
import { withDevice, busyText } from './device-lock.js'
import { findAction, checkParams, LIGHT_ROOMS } from './panel-actions.js'

// Room -> the query the Google Home layer understands, in strict mode (no "any room means all lights").
export const ROOM_QUERY = Object.freeze({
  all: 'all',
  'סלון': 'סלון',
  'מטבח': 'מטבח',
  'חדר שינה': 'חדר שינה',
  'חדר ילדים': 'חדר ילדים',
  'החדר שלי': 'mine',
  'מרפסת': 'מרפסת',
  'כניסה': 'כניסה',
  'מסדרון': 'מסדרון',
  'שירותים': 'שירותים',
  'אמבטיה': 'אמבטיה',
  'לאונג': 'לאונג',
})

const UNKNOWN_NOTE = 'לא ידוע אם הפעולה התבצעה. לבדוק את מצב המכשיר לפני כל ניסיון נוסף.'
const done = (state, detail, reason = '') => ({ state, detail: String(detail || '').slice(0, 300), ...(reason ? { reason } : {}) })

// The Google Home result as an outcome.
export function lightsOutcome(r, act) {
  if (!r || typeof r !== 'object') return done('unknown', UNKNOWN_NOTE, 'no_result')
  if (!r.found) return done('failed', 'לא זוהו מכשירים בעמוד Google Home', 'no_devices')
  if (!r.matched) return done('failed', 'אין אור שמתאים לחדר הזה', 'no_match')
  const want = act === 'on' ? 'דלוק' : 'כבוי'
  const clicked = Array.isArray(r.clicked) ? r.clicked : []
  const offline = Array.isArray(r.offline) ? r.offline : []
  if (!clicked.length) {
    if (!offline.length) return done('succeeded', act === 'on' ? 'כבר דלוק' : 'כבר כבוי', 'already')
    return done('failed', `אופליין: ${offline.join(', ')}`, 'offline')
  }
  const wrong = clicked.filter((c) => c.status !== want)
  if (!wrong.length && !offline.length) return done('succeeded', clicked.map((c) => `${c.name}: ${c.status}`).join(', '))
  const parts = [...wrong.map((c) => `${c.name}: ${c.status || '?'}`), ...offline.map((n) => `${n}: אופליין`)]
  return done('unknown', `${UNKNOWN_NOTE} (${parts.join(', ')})`, offline.length && !wrong.length ? 'partial' : 'not_confirmed')
}

// An error from a handler. notSent / reported come from the layers below (pc-bridge, tv-app, google-home).
export function errorOutcome(e) {
  const msg = String(e?.hint || e?.message || e || '').slice(0, 200)
  if (e?.notSent) return done('failed', msg || 'לא נשלח', 'not_sent')
  if (e?.reported) return done('failed', msg || 'המכשיר דיווח על כישלון', 'device_failed')
  return done('unknown', `${UNKNOWN_NOTE}${msg ? ` (${msg})` : ''}`, 'error_after_send')
}

export function createExecutor({ lights = controlHomeDeviceResult, tvOff = tvPowerOff, lock = withDevice, timeoutMs = 60000 } = {}) {
  const handlers = {
    'lights:on': async ({ room }) => lightsOutcome(await lights(ROOM_QUERY[room], 'on', { fast: true, strict: true }), 'on'),
    'lights:off': async ({ room }) => lightsOutcome(await lights(ROOM_QUERY[room], 'off', { fast: true, strict: true }), 'off'),
    'tv:off': async () => {
      await tvOff()
      return done('succeeded', 'הטלוויזיה אישרה את לחיצת הכיבוי')
    },
  }

  // -> { state, detail, reason? }. Validation repeats here so a handler never sees an unchecked value.
  return async function execute(actionId, params, { actor = '' } = {}) {
    const action = findAction(actionId)
    if (!action || !handlers[action.id]) return done('failed', 'פעולה לא בקטלוג', 'invalid')
    const chk = checkParams(action.id, params)
    if (!chk.ok) return done('failed', chk.error, 'invalid')
    if (chk.params.room !== undefined && !Object.hasOwn(ROOM_QUERY, chk.params.room)) return done('failed', 'חדר לא מוכר', 'invalid')
    const r = await lock(action.device, () => handlers[action.id](chk.params), { timeoutMs, label: `${actor}:${action.id}` })
    if (r.busy) return done('failed', busyText(r), r.quarantined ? 'quarantined' : 'busy')
    if (r.timedOut) return done('unknown', `${UNKNOWN_NOTE} (אין תשובה בזמן)`, 'timeout')
    if (!r.ok) return errorOutcome(r.error)
    return r.value
  }
}

// Every room in the catalog has a query: checked by the self-test.
export const ROOMS_COVERED = () => LIGHT_ROOMS.every((r) => Object.hasOwn(ROOM_QUERY, r))
