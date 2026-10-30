// Commands so plain that no model is needed: "תדליק את האורות", "תכבה את האור בסלון". They run the moment they are
// heard, skip the queue behind any turn that is still thinking, and answer in a word. That is the difference between
// the light coming on while you are still saying it and after a few seconds of the model deciding what "lights" means.
//
// Only a whole message of this exact shape counts. Anything with more in it ("תדליק את האורות בעוד שעה", "תדליק
// את האורות ותשים מוזיקה") goes to the model as before, which is the one that can work out what was meant.
import { controlHomeDevice } from './google-home.js'
import { tvPowerOff } from './tv-tools.js'

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

// "תדליק את האורות בסלון" -> { action: 'on', query: 'סלון' }; null when it is not exactly that kind of sentence.
export function parseLights(text) {
  const words = normalize(text).split(' ').filter((w) => w && !FILLER.has(w))
  if (words.length < 2 || words.length > 5) return null
  const action = ON.has(words[0]) ? 'on' : OFF.has(words[0]) ? 'off' : null
  if (!action) return null
  let light = false
  let all = false
  const room = []
  for (const w of words.slice(1)) {
    if (/^ה?אור(ות)?$/.test(w)) light = true
    else if (w === 'כל' || w === 'כול') all = true
    else if (ROOMS.has(w)) room.push(w)
    // "בסלון", "בחדר": the preposition is dropped, what is left must be a room.
    else if (/^ב/.test(w) && ROOMS.has(w.slice(1))) room.push(w.slice(1))
    else return null
  }
  if (!light) return null
  return { action, query: room.length && !all ? room.join(' ') : 'כל האורות' }
}

// "תכבה את הטלוויזיה", "תכבה את המקרן": the TV or the projector, whichever the screen in the living room is.
const SCREENS = new Set(['טלוויזיה', 'טלויזיה', 'טלוויזייה', 'טלויזייה', 'טלביזיה', 'מקרן', 'tv'])
export function parseScreenOff(text) {
  const words = normalize(text).split(' ').filter((w) => w && !FILLER.has(w))
  if (words.length < 2 || words.length > 4 || !OFF.has(words[0])) return null
  const rest = words.slice(1).map((w) => (SCREENS.has(w) ? w : w.replace(/^ו?ה?/, '')))
  return rest.every((w) => SCREENS.has(w) || w === 'בסלון' || w === '' || w === 'גם') && rest.some((w) => SCREENS.has(w)) ? { action: 'off' } : null
}

// A word for the person listening, not a report. Anything unexpected is passed on as it came.
export function shortReply(out, action) {
  const text = String(out || '')
  if (/שונה בהצלחה/.test(text)) return action === 'on' ? 'דלקו 💡' : 'כבו ⚪'
  if (/כבר (דלוק|כבוי)/.test(text)) return action === 'on' ? 'כבר דלוק' : 'כבר כבוי'
  return text.split('\n').slice(0, 2).join('\n') || 'בוצע'
}

// -> { reply } when the message was one of these commands and has been carried out (or failed, plainly), else null.
export async function fastCommand(text, { control = controlHomeDevice, screenOff = tvPowerOff } = {}) {
  if (parseScreenOff(text)) {
    try {
      await screenOff()
      return { reply: 'כיביתי 📺', fast: true }
    } catch (e) {
      return { reply: e.message || 'לא הצלחתי להגיע לטלוויזיה', fast: true }
    }
  }
  const lights = parseLights(text)
  if (!lights) return null
  try {
    return { reply: shortReply(await control(lights.query, lights.action, { fast: true }), lights.action), fast: true }
  } catch (e) {
    return { reply: e.hint || e.message || 'לא הצלחתי להגיע לבית החכם', fast: true }
  }
}
