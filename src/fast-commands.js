// Commands so plain that no model is needed: "תדליק את האורות", "תכבה את האור בסלון", and a short scene of
// several of them at once ("תכבה את המחשב, תדליק את כל הלדים ותדליק את המקרן"). They run the moment they are
// heard, skip the queue behind any turn that is still thinking, and answer in a word.
//
// Only a whole message of this exact shape counts. Anything with more in it ("תדליק את האורות בעוד שעה", "תדליק
// את האורות ותשים מוזיקה") goes to the model as before, which is the one that can work out what was meant.
import { controlHomeDevice } from './google-home.js'
import { tvPowerOff, tvPowerOn } from './tv-tools.js'
import { power as pcPowerAction, pcEnabled } from './pc.js'
import { withDevice, busyText } from './device-lock.js'

// How long a fast command waits before saying it does not know. The device stays held until the call really ends.
const FAST_WAIT_MS = 60000

const ON = new Set(['תדליק', 'תדליקי', 'הדלק', 'הדליקי', 'להדליק', 'תפעיל'])
const OFF = new Set(['תכבה', 'תכבי', 'כבה', 'כבי', 'לכבות'])
// Politeness and the assistant's name: they change nothing about what is wanted.
const FILLER = new Set(['בבקשה', 'לי', 'נא', 'עכשיו', 'את', 'הלפר', 'helper', 'היי', 'הי', 'אוקיי', 'אוקי', 'תוכל', 'אפשר', 'רגע', 'מהר'])
const ROOMS = new Set(['חדר', 'שלי', 'סלון', 'לאונג', 'מטבח', 'מרפסת', 'שינה', 'ילדים', 'כניסה', 'מסדרון', 'שירותים', 'אמבטיה'])

const normalize = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const isLightWord = (w) => /^(ה?אור(ות)?|ה?לד(ים)?|leds?)$/.test(w)
const isLedWord = (w) => /^(ה?לד(ים)?|leds?)$/.test(w)

// "תדליק את האורות בסלון" -> { action: 'on', query: 'סלון' }; null when it is not exactly that kind of sentence.
export function parseLights(text) {
  const words = normalize(text).split(' ').filter((w) => w && !FILLER.has(w))
  if (words.length < 2 || words.length > 5) return null
  const action = ON.has(words[0]) ? 'on' : OFF.has(words[0]) ? 'off' : null
  if (!action) return null
  let light = false
  let led = false
  let all = false
  const room = []
  for (const w of words.slice(1)) {
    if (isLedWord(w)) {
      light = true
      led = true
    } else if (isLightWord(w)) light = true
    else if (w === 'כל' || w === 'כול') all = true
    else if (ROOMS.has(w)) room.push(w)
    // "בסלון", "בחדר": the preposition is dropped, what is left must be a room.
    else if (/^ב/.test(w) && ROOMS.has(w.slice(1))) room.push(w.slice(1))
    else return null
  }
  if (!light) return null
  // "כל הלדים" is the LED tiles, not every light in the house.
  if (led && !room.length) return { action, query: 'לד' }
  return { action, query: room.length && !all ? room.join(' ') : 'כל האורות' }
}

// "תכבה את הטלוויזיה", "תכבה את המקרן": the TV or the projector, whichever the screen in the living room is.
const SCREENS = new Set(['טלוויזיה', 'טלויזיה', 'טלוויזייה', 'טלויזייה', 'טלביזיה', 'מקרן', 'tv'])
const isScreenWord = (w) => SCREENS.has(w) || SCREENS.has(String(w || '').replace(/^ו?ה?/, ''))

function parseScreen(text, wanted) {
  const words = normalize(text).split(' ').filter((w) => w && !FILLER.has(w))
  if (words.length < 2 || words.length > 4) return null
  const action = ON.has(words[0]) ? 'on' : OFF.has(words[0]) ? 'off' : null
  if (action !== wanted) return null
  const rest = words.slice(1).map((w) => (SCREENS.has(w) ? w : w.replace(/^ו?ה?/, '')))
  return rest.every((w) => SCREENS.has(w) || w === 'בסלון' || w === '' || w === 'גם') && rest.some((w) => SCREENS.has(w)) ? { action } : null
}

export function parseScreenOff(text) {
  return parseScreen(text, 'off')
}

export function parseScreenOn(text) {
  return parseScreen(text, 'on')
}

// "תכבה את המחשב", "לכבות את המחשב": a whole message, nothing else in it.
export function parsePcPower(text) {
  const words = normalize(text).split(' ').filter((w) => w && !FILLER.has(w))
  if (words.length < 2 || words.length > 4) return null
  if (!OFF.has(words[0])) return null
  const rest = words.slice(1).map((w) => w.replace(/^ו?ה?/, ''))
  const pc = new Set(['מחשב', 'pc', 'computer'])
  return rest.every((w) => pc.has(w) || w === '') && rest.some((w) => pc.has(w)) ? { action: 'shutdown' } : null
}

const VERB_ON = 'תדליק(?:י)?|הדלק(?:י)?|להדליק|תפעיל'
const VERB_OFF = 'תכבה|תכבי|כבה|כבי|לכבות'
const VERB = `(?:${VERB_ON}|${VERB_OFF})`
const ET = '(?:את\\s+)?'
const SCREEN_RE = '(?:טלוויזיה|טלויזיה|טלוויזייה|טלויזייה|טלביזיה|מקרן|tv)'
const LIGHT_RE = '(?:אורות|אור|לדים|לד|leds?)'
const PC_RE = '(?:מחשב|pc|computer)'
const ROOM_RE = '(?:חדר\\s+שלי|חדר|סלון|לאונג|מטבח|מרפסת|שינה|ילדים|כניסה|מסדרון|שירותים|אמבטיה)'

function verbIsOn(v) {
  return new RegExp(`^(?:${VERB_ON})$`).test(v)
}

function lightsFrom(verb, light, room, all) {
  const action = verbIsOn(verb) ? 'on' : 'off'
  if (isLedWord(light) && !room) return { type: 'lights', action, query: 'לד' }
  return { type: 'lights', action, query: room && !all ? room.replace(/^ב/, '') : 'כל האורות' }
}

function eatAll(s, re, fn) {
  const r = new RegExp(re, 'u')
  const actions = []
  for (;;) {
    const m = r.exec(s)
    if (!m) break
    const a = fn(m)
    if (a) actions.push(a)
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`
  }
  return { s, actions }
}

// Several home actions in one spoken sentence. Null if anything in the message is not a known action —
// that goes to the model, so "תדליק את האורות ותשים מוזיקה" is not half-run.
export function parseScene(text) {
  const single =
    (parseLights(text) && [{ type: 'lights', ...parseLights(text) }]) ||
    (parseScreenOff(text) && [{ type: 'tv', action: 'off' }]) ||
    (parseScreenOn(text) && [{ type: 'tv', action: 'on' }]) ||
    (parsePcPower(text) && [{ type: 'pc', action: 'shutdown' }]) ||
    null
  if (single) return single

  // "ואת המקרן להדליק": the leading vav is just "and", drop it so each clause is the same shape.
  let s = ` ${normalize(text).replace(/(^|\s)ו(?=\S)/g, '$1')} `
  const actions = []
  const pass = [
    [`(?:${VERB_OFF})\\s+${ET}(?:ה)?(?:${PC_RE})`, () => ({ type: 'pc', action: 'shutdown' })],
    [`(?:ה)?(?:${PC_RE})\\s+(?:${VERB_OFF})`, () => ({ type: 'pc', action: 'shutdown' })],
    [`(${VERB})\\s+${ET}(?:ה)?(${SCREEN_RE})(?:\\s+בסלון)?`, (m) => ({ type: 'tv', action: verbIsOn(m[1]) ? 'on' : 'off' })],
    [`(?:ה)?(${SCREEN_RE})\\s+(${VERB})`, (m) => ({ type: 'tv', action: verbIsOn(m[2]) ? 'on' : 'off' })],
    [
      `(${VERB})\\s+${ET}(כל\\s+)?(?:ה)?(${LIGHT_RE})(?:\\s+ב?(${ROOM_RE}))?`,
      (m) => lightsFrom(m[1], m[3], m[4], Boolean(m[2])),
    ],
    [
      `(כל\\s+)?(?:ה)?(${LIGHT_RE})(?:\\s+ב?(${ROOM_RE}))?\\s+(${VERB})`,
      (m) => lightsFrom(m[4], m[2], m[3], Boolean(m[1])),
    ],
  ]
  for (let n = 0; n < 4; n++) {
    for (const [re, fn] of pass) {
      const out = eatAll(s, re, fn)
      s = out.s
      actions.push(...out.actions)
    }
  }

  const leftover = s
    .trim()
    .split(/\s+/)
    .filter((w) => {
      if (!w || FILLER.has(w)) return false
      if (['ו', 'גם', 'כל', 'כול', 'הכל'].includes(w)) return false
      if (ROOMS.has(w) || (/^ב/.test(w) && ROOMS.has(w.slice(1)))) return false
      return true
    })
  if (!actions.length || leftover.length) return null
  return actions
}

// A word for the person listening, not a report. Anything unexpected is passed on as it came.
export function shortReply(out, action) {
  const text = String(out || '')
  if (/שונה בהצלחה/.test(text)) return action === 'on' ? 'דלקו 💡' : 'כבו ⚪'
  if (/כבר (דלוק|כבוי)/.test(text)) return action === 'on' ? 'כבר דלוק' : 'כבר כבוי'
  return text.split('\n').slice(0, 2).join('\n') || 'בוצע'
}

function labelOf(step) {
  if (step.type === 'tv') return `tv:${step.action}`
  if (step.type === 'pc') return `pc:${step.action}`
  if (step.type === 'lights') return `lights:${step.action}`
  return null
}

// Which device action a message is, without carrying it out: 'tv:off', 'lights:on', 'lights:off', or null.
// The remote panel checks this against its scopes before fastCommand is ever called.
export function fastAction(text) {
  const scene = parseScene(text)
  if (!scene) return null
  if (scene.length === 1) return labelOf(scene[0])
  return scene.map(labelOf).join(',')
}

async function defaultPcPower(action) {
  if (!pcEnabled()) throw new Error('המחשב לא מחובר להלפר כרגע.')
  return pcPowerAction(action, 0)
}

async function runStep(step, { control, screenOff, screenOn, pcPower, waitMs }) {
  if (step.type === 'tv') {
    const fn = step.action === 'on' ? screenOn : screenOff
    const r = await withDevice('tv', () => fn(), { timeoutMs: waitMs, label: `fast:tv:${step.action}` })
    if (r.busy) return { reply: busyText(r), busy: true }
    if (r.timedOut) return { reply: step.action === 'on' ? 'המקרן לא ענה בזמן. לא ידוע אם נדלק.' : 'הטלוויזיה לא ענתה בזמן. לא ידוע אם כבתה.' }
    if (!r.ok) return { reply: r.error?.message || 'לא הצלחתי להגיע לטלוויזיה' }
    return { reply: step.action === 'on' ? 'הדלקתי את המקרן 📺' : 'כיביתי 📺' }
  }
  if (step.type === 'pc') {
    const r = await withDevice('pc', () => pcPower(step.action), { timeoutMs: waitMs, label: `fast:pc:${step.action}` })
    if (r.busy) return { reply: busyText(r), busy: true }
    if (r.timedOut) return { reply: 'המחשב לא ענה בזמן. לא ידוע אם כבה.' }
    if (!r.ok) return { reply: r.error?.hint || r.error?.message || 'לא הצלחתי לכבות את המחשב' }
    return { reply: String(r.value || 'המחשב ייכבה עכשיו') }
  }
  const r = await withDevice('lights', () => control(step.query, step.action, { fast: true }), {
    timeoutMs: waitMs,
    label: `fast:lights:${step.action}`,
  })
  if (r.busy) return { reply: busyText(r), busy: true }
  if (r.timedOut) return { reply: 'הבית החכם לא ענה בזמן. לא ידוע אם האור השתנה.' }
  if (!r.ok) return { reply: r.error?.hint || r.error?.message || 'לא הצלחתי להגיע לבית החכם' }
  return { reply: shortReply(r.value, step.action) }
}

// -> { reply } when the message was one of these commands and has been carried out (or failed, plainly), else null.
// Every press goes through the device lock (src/device-lock.js), the same one the panel and the model's tools use:
// a device that is busy answers so at once, and nothing runs on it.
// A scene of several devices runs them together, not one after the other.
export async function fastCommand(
  text,
  { control = controlHomeDevice, screenOff = tvPowerOff, screenOn = tvPowerOn, pcPower = defaultPcPower, waitMs = FAST_WAIT_MS } = {},
) {
  const scene = parseScene(text)
  if (!scene) return null
  const results = await Promise.all(scene.map((step) => runStep(step, { control, screenOff, screenOn, pcPower, waitMs })))
  const reply = results
    .map((r) => r.reply)
    .filter(Boolean)
    .join('. ')
  return { reply, fast: true, busy: results.some((r) => r.busy) }
}
