// Light commands for iBaila's Govee lamps, from the words alone (no AI), in Hebrew. A sentence becomes one action
// from a fixed list ({ action: 'on', room: 'my-room' }); only that action goes to iBaila, never the sentence.
//
// Which sentences are iBaila's (the rest goes on as before, most light words to the house on the cloud):
//   - it names the Govee lamps (גובי, לדים, iBaila, ...), or a party, music sync or a light style: iBaila's for sure
//     ("explicit"); if iBaila can't, HELPER says why
//   - it names a room (בחדר שלי, בחדר השינה): iBaila first; if iBaila is closed or has no lamp there, the house on
//     the cloud gets it, as before
//   - with no room it reaches every lamp linked to iBaila
'use strict'

const pre = '(?:[ובלשמ]?ה?)'
const word = (alts) => new RegExp(`(^|\\s)${pre}(?:${alts})(?=\\s|$)`, 'i')

const GOVEE_ALTS = 'גובי|גאווי|govee|לד|לדים|פס הלד|פסי הלד|פס לד|מנורות הקצב|מנורת הקצב|ibaila|איבאילה|אייבאילה|glowbeat|גלואוביט'
const LIGHT_ALTS = 'אור|אורות|מנורה|מנורות|נורה|נורות|תאורה'
const GOVEE = word(GOVEE_ALTS)
const ANY_LIGHT = `(?:${LIGHT_ALTS}|${GOVEE_ALTS})`
const OBJ = `(?:לי\\s+)?(?:את\\s+)?(?:כל\\s+)?ה?${ANY_LIGHT}`

const ROOM_RES = [
  ['my-room', /(^|\s)(?:[בלש]?ה?חדר שלי|אצלי בחדר)(?=\s|$)/],
  ['bedroom', /(^|\s)[בלש]?ה?חדר ה?שינה(?=\s|$)/],
]

const COLOR_WORDS = [['לבן חם', 'warm'], ['אדום', 'red'], ['כתום', 'orange'], ['צהוב', 'yellow'], ['ירוק', 'green'], ['טורקיז', 'turquoise'],
  ['תכלת', 'turquoise'], ['כחול', 'blue'], ['סגול', 'purple'], ['ורוד', 'pink'], ['לבן', 'white']]
const COLOR_HE = { red: 'אדום', orange: 'כתום', yellow: 'צהוב', green: 'ירוק', turquoise: 'טורקיז', blue: 'כחול', purple: 'סגול', pink: 'ורוד', white: 'לבן', warm: 'לבן חם' }

const SCENE_WORDS = { ערב: 'evening', קריאה: 'reading', סרט: 'movie', לילה: 'night' }
const SCENE_HE = { evening: 'ערב', reading: 'קריאה', movie: 'סרט', night: 'לילה' }

// Hebrew names for iBaila's 21 lamp styles.
const STYLE_WORDS = [
  ['אנרגיה', 'energy'], ['צעדים', 'steps'], ['קפיצה', 'bounce'], ['קפיצות', 'bounce'], ['דילוג', 'hop'], ['דילוגים', 'hop'], ['ברק', 'strike'], ['ברקים', 'strike'],
  ['נצנוץ', 'shimmer'], ['ריצוד', 'shimmer'], ['ממתק', 'candy'], ['סוכריות', 'candy'], ['להבה', 'flame'], ['אש', 'flame'], ['בלוקים', 'blocks'], ['קוביות', 'blocks'],
  ['זרימה', 'blend'], ['מעבר', 'blend'], ['ניצוצות', 'sparkle'], ['נצנצים', 'sparkle'], ['חצי חצי', 'split'], ['ביט', 'beat'], ['קונצרט', 'concert'], ['הופעה', 'concert'],
  ['מסיבה', 'party'], ['פעימה', 'pulse'], ['פולס', 'pulse'], ['הבזק', 'flash'], ['הבזקים', 'flash'], ['פלאש', 'flash'], ['מחזור', 'cycle'], ['סבב', 'cycle'],
  ['קשת', 'rainbow'], ['קשת בענן', 'rainbow'], ['קבוע', 'steady'], ['יציב', 'steady'], ['סטרובו', 'strobe'], ['סטרוב', 'strobe'],
]
const STYLE_MAP = new Map(STYLE_WORDS)
const STYLE_HE = {}
for (const [he, id] of STYLE_WORDS) if (!STYLE_HE[id]) STYLE_HE[id] = he

const ON = /^(?:תדליק|תדליקי|תדליקו|הדלק|תפעיל|תפעילי|הפעל)\s+/
const OFF = /^(?:תכבה|תכבי|תכבו|כבה)\s+/
const STATUS = new RegExp(`^(?:מה|איך)\\s+(?:ה?מצב\\s+|עם\\s+)?(?:של\\s+)?ה?${ANY_LIGHT}$`)
const PARTY_OFF = /^(?:(?:תפסיק|תפסיקי|תעצור|תעצרי|תכבה|תכבי|בטל|תבטל|תבטלי|תסיים|תסיימי|די)\s+(?:את\s+)?(?:ה?מצב\s+)?ה?מסיבה|סוף (?:ה)?מסיבה|בלי מסיבה|די עם המסיבה)$/
const PARTY_ON = /^(?:(?:תעשה|תעשי|תדליק|תדליקי|תפעיל|תפעילי|תעבור|תעברי|תשים|תשימי|תתחיל|תתחילי)\s+(?:את\s+|ל)?)?(?:ה?מצב\s+)?ה?מסיבה$|^party( mode)?$/i
const SYNC_ON = new RegExp(`^(?:(?:תסנכרן|תסנכרני|סנכרן|תחבר|תחברי)\\s+(?:את\\s+)?(?:ה?${ANY_LIGHT}\\s+)?(?:ל|עם\\s+)ה?מוזיקה|(?:תדליק|תדליקי|תפעיל|תפעילי)\\s+(?:את\\s+)?ה?סנכרון(?:\\s+(?:ל|עם\\s+)ה?מוזיקה)?)$`)
const SYNC_OFF = /^(?:תפסיק|תפסיקי|תעצור|תעצרי|תכבה|תכבי|בטל|תבטל|תבטלי)\s+(?:את\s+)?(?:לסנכרן|ה?סנכרון)(?:\s+.*)?$/
const STYLE = new RegExp(`^(?:(?:תשים|תשימי|תחליף|תחליפי|תעבור|תעברי)\\s+(?:ל|את\\s+)?)?ה?(?:סגנון|אפקט)\\s+(?:(?:של\\s+)?ה?${ANY_LIGHT}\\s+)?(.+)$`)
const RESTORE = new RegExp(`^(?:תחזיר|תחזירי|החזר|תחזור|תחזרי)\\s+${OBJ}\\s+(?:כמו שהיה|כמו שהיו|למצב הקודם|לקודם|למה שהיה)$`)
const SCENE = /^(?:(?:תשים|תשימי|תעשה|תעשי|תעבור|תעברי|תדליק|תדליקי)\s+(?:ל|את\s+)?)?(?:ה?מצב|תאורת|אור(?:ות)? של|ה?אור|ה?אורות)\s+(ערב|קריאה|סרט|לילה)$/
const DIM = new RegExp(`^(?:תעמעם|תעמעמי|עמעם|תחליש|תחלישי|תנמיך|תנמיכי|תוריד|תורידי)(?:\\s+${OBJ})?$`)
const BRIGHT_UP = new RegExp(`^(?:תגביר|תגבירי|תבהיר|תבהירי|תעלה|תעלי)\\s+${OBJ}$`)
const LEVEL = new RegExp(`^(?:(?:תשים|תשימי)\\s+)?(?:(?:${OBJ})\\s+)?(?:ה?בהירות|ה?עוצמה)?\\s*(?:של\\s+${OBJ}\\s+)?(?:על|ל|ב)?\\s*(\\d{1,3})\\s*(?:%|אחוז)?$`)
// The whole sentence is a colour: "תשים אדום", "תצבע את האור בכחול", "תעשה את הגובי ורוד", "אור סגול".
const COLOR_FULL = new RegExp(`^(?:(?:תשים|תשימי|תצבע|תצבעי|תעשה|תעשי|תהפוך|תהפכי|תחליף|תחליפי|תדליק|תדליקי|צבע)\\s+)?(?:(?:את\\s+)?ה?${ANY_LIGHT}\\s+)?(?:(?:ל|ב)?צבע\\s+)?(?:[בל]?ה?)(${COLOR_WORDS.map((c) => c[0]).join('|')})(?:\\s+(?:על\\s+)?[בל]?ה?${ANY_LIGHT})?$`)

/** The room named in the sentence and the sentence without it. */
function roomIn(t) {
  for (const [id, re] of ROOM_RES) {
    const m = t.match(re)
    if (m) return { room: id, rest: (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() }
  }
  return { room: null, rest: t }
}

/** The action in a sentence without its room, or null. kind tells whether it is iBaila's alone. */
function parseCommand(t) {
  if (!t) return null
  if (STATUS.test(t)) return { status: true }
  if (PARTY_OFF.test(t)) return { action: { action: 'party', on: false }, only: true }
  if (PARTY_ON.test(t)) return { action: { action: 'party', on: true }, only: true }
  if (SYNC_OFF.test(t)) return { action: { action: 'sync', on: false }, only: true }
  if (SYNC_ON.test(t)) return { action: { action: 'sync', on: true }, only: true }
  let m = t.match(STYLE)
  if (m) {
    const raw = m[1].trim()
    const id = [raw, raw.replace(/^ה(?=\S)/, ''), raw.replace(/^ל(?=\S)/, ''), raw.replace(/^לה?(?=\S)/, '')].map((n) => STYLE_MAP.get(n)).find(Boolean)
    return id ? { action: { action: 'style', style: id }, only: true } : null
  }
  if (RESTORE.test(t)) return { action: { action: 'restore' } }
  m = t.match(SCENE)
  if (m) return { action: { action: 'scene', scene: SCENE_WORDS[m[1]] }, plainScene: /^תאורת\s/.test(t) || (/^ה?מצב\s/.test(t) && m[1] !== 'לילה') }
  if (DIM.test(t)) return { action: { action: 'bright', level: 'down' } }
  if (BRIGHT_UP.test(t)) return { action: { action: 'bright', level: 'up' } }
  m = t.match(LEVEL)
  if (m && /בהירות|עוצמה|%|אחוז/.test(t) || (m && new RegExp(ANY_LIGHT).test(t))) { const n = +m[1]; if (n >= 1 && n <= 100) return { action: { action: 'bright', level: n } } }
  const c = t.match(COLOR_FULL)
  if (c) return { action: { action: 'color', color: COLOR_WORDS.find((x) => x[0] === c[1])[1] } }
  if (ON.test(t) && new RegExp(`^\\S+\\s+${OBJ}$`).test(t)) return { action: { action: 'on' } }
  if (OFF.test(t) && new RegExp(`^\\S+\\s+${OBJ}$`).test(t)) return { action: { action: 'off' } }
  return null
}

/**
 * A tidied sentence (instant.tidy) -> { action, explicit } or { status: true, explicit } when it is iBaila's, else
 * null. explicit: iBaila's alone (HELPER answers even when iBaila can't); otherwise the house on the cloud may take it.
 */
function route(text) {
  const t0 = String(text || '').trim().replace(/[?!.]+$/, '').replace(/\s+/g, ' ').trim()
  if (!t0) return null
  const govee = GOVEE.test(t0)
  const { room, rest } = roomIn(t0)
  const cmd = parseCommand(rest)
  if (!cmd) return null
  const explicit = Boolean(govee || cmd.only)
  if (!explicit && !room && !cmd.plainScene) return null
  if (cmd.status) return { status: true, room, explicit }
  const action = Object.assign({}, cmd.action)
  if (room && !['party', 'sync', 'style'].includes(action.action)) action.room = room
  if (room && action.action === 'party' && action.on) action.room = room
  return { action, explicit }
}

const ROOM_HE = { 'my-room': 'בחדר שלי', bedroom: 'בחדר השינה' }
const where = (a) => (a.room ? ' ' + ROOM_HE[a.room] : '')

/** A short answer for an action iBaila did. */
function reply(a) {
  switch (a.action) {
    case 'on': return 'הדלקתי' + where(a)
    case 'off': return 'כיביתי' + where(a)
    case 'restore': return 'החזרתי את האור כמו שהיה' + where(a)
    case 'color': return `שמתי ${COLOR_HE[a.color]}` + where(a)
    case 'bright': return (a.level === 'up' ? 'הגברתי את האור' : a.level === 'down' ? 'עמעמתי את האור' : `בהירות ${a.level}%`) + where(a)
    case 'scene': return `מצב ${SCENE_HE[a.scene]}` + where(a)
    case 'party': return a.on ? 'מצב מסיבה' + where(a) + ', עם המוזיקה 🎉' : 'סיימתי את המסיבה'
    case 'sync': return a.on ? 'האורות זזים עם המוזיקה' : 'האורות כבר לא זזים עם המוזיקה'
    case 'style': return `סגנון ${STYLE_HE[a.style] || a.style}`
    default: return 'בוצע'
  }
}

const FAILED = {
  unreachable: 'iBaila לא פתוח במחשב',
  'not-set': 'iBaila לא מחובר ל-HELPER (צריך להריץ את ibaila-link.ps1)',
  off: 'החיבור ל-HELPER כבוי ב-iBaila (בתפריט שלו: HELPER)',
  denied: 'קוד החיבור ל-iBaila לא מתאים (צריך להריץ שוב את ibaila-link.ps1)',
  'no-room': 'אין עדיין מנורה בחדר הזה. אפשר לשייך אותה בתפריט של iBaila, "Rooms"',
  'no-lamps': 'iBaila לא מצא מנורות Govee ברשת',
  'govee-off': 'Govee כבוי ב-iBaila',
  bad: 'iBaila לא הבין את הבקשה',
}
const failed = (reason) => FAILED[reason] || FAILED.bad

/** One spoken line for "מה מצב הגובי". */
function statusLine(s, room) {
  if (!s.lamps) return 'iBaila לא מצא מנורות Govee ברשת'
  const parts = []
  for (const r of room ? [room] : ['my-room', 'bedroom']) {
    const v = s.rooms[r]
    if (v === 'on') parts.push(`${ROOM_HE[r]} דולק`)
    else if (v === 'off') parts.push(`${ROOM_HE[r]} כבוי`)
    else if (room) parts.push(`אין מנורה ${ROOM_HE[r]}`)
  }
  if (!parts.length) parts.push(`${s.lamps} מנורות, עוד בלי חדרים`)
  parts.push(s.sync ? 'הסנכרון למוזיקה פועל' : 'הסנכרון למוזיקה כבוי')
  if (s.music) parts.push('יש מוזיקה עכשיו')
  return parts.join(', ')
}

// Room-only sentences go back to the house on the cloud when iBaila can't do them.
const FALL_BACK = ['unreachable', 'not-set', 'off', 'denied', 'no-room', 'no-lamps', 'govee-off']

/**
 * Runs a routed command on the link (ibaila-link.js). Returns { reply, error } or null when the sentence should go on
 * to the house on the cloud instead.
 */
async function handle(cmd, link) {
  if (!cmd) return null
  if (!link) return cmd.explicit ? { reply: failed('not-set'), error: true } : null
  if (cmd.status) {
    const r = await link.status()
    if (r.ok) return { reply: statusLine(r.status, cmd.room), error: false }
    return cmd.explicit ? { reply: failed(r.reason), error: true } : null
  }
  const r = await link.light(cmd.action)
  if (r.ok) return { reply: reply(cmd.action), error: false }
  if (!cmd.explicit && FALL_BACK.includes(r.reason)) return null
  return { reply: failed(r.reason), error: true }
}

module.exports = { route, parseCommand, roomIn, reply, failed, statusLine, handle, STYLE_MAP, COLOR_WORDS }
