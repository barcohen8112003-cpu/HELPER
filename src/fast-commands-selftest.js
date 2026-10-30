// node src/fast-commands-selftest.js
// Offline: no model, no browser, no Google Home. The control call is replaced by a recorder.
import { parseLights, parseScreenOff, shortReply, fastCommand } from './fast-commands.js'
import { tvPowerOff } from './tv-tools.js'

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL  ${name}`)
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── what counts ──────────────────────────────────────────────────────────────
const on = (q) => ({ action: 'on', query: q })
const off = (q) => ({ action: 'off', query: q })
ok(eq(parseLights('תדליק את האורות'), on('כל האורות')), 'turn on the lights')
ok(eq(parseLights('תדליק את האור'), on('כל האורות')), 'singular light')
ok(eq(parseLights('תכבה את כל האורות'), off('כל האורות')), 'turn off all the lights')
ok(eq(parseLights('תדליק אורות'), on('כל האורות')), 'without "את"')
ok(eq(parseLights('תדליק את האורות בסלון'), on('סלון')), 'a room, with the preposition')
ok(eq(parseLights('תכבה את האור בחדר שלי'), off('חדר שלי')), 'two-word room')
ok(eq(parseLights('תדליק את האורות בבקשה!'), on('כל האורות')), 'please and punctuation')
ok(eq(parseLights('הלפר תדליק לי את האורות עכשיו'), on('כל האורות')), 'his name and fillers around it')
ok(eq(parseLights('  תכבה   את האורות. '), off('כל האורות')), 'spaces and a full stop')
ok(eq(parseLights('להדליק את האורות'), on('כל האורות')), 'the infinitive')
ok(eq(parseLights('תכבה את כל האורות בסלון'), off('כל האורות')), '"all" wins over a room')

// ── what is left to the model ────────────────────────────────────────────────
for (const t of [
  '',
  'תדליק',
  'תדליק את הטלוויזיה',
  'תדליק את האורות בעוד שעה',
  'תדליק את האורות ותשים מוזיקה',
  'תדליק את האורות אם יורד גשם',
  'מה מצב האורות',
  'תזכיר לי לכבות את האורות',
  'האורות דלוקים',
  'תדליק את האורות בגינה של השכנים ובחדר של אחי',
  'תכבה את המחשב',
  'turn on the lights',
]) ok(parseLights(t) === null, `"${t}" is left to the model`)

// ── the reply is a word ──────────────────────────────────────────────────────
ok(shortReply('• *סלון* שונה בהצלחה למצב: *דלוק* 🟢 💡', 'on') === 'דלקו 💡', 'lit')
ok(shortReply('• *סלון* שונה בהצלחה למצב: *כבוי* ⚪ 🔌', 'off') === 'כבו ⚪', 'off')
ok(shortReply('• *סלון* כבר דלוק 🟢', 'on') === 'כבר דלוק', 'already on')
ok(shortReply('• *סלון* כבר כבוי ⚪', 'off') === 'כבר כבוי', 'already off')
ok(shortReply('לא נמצא מכשיר מתאים עבור "x".\nמכשירים זמינים:\n• a\n• b', 'on').split('\n').length === 2, 'anything else is passed on, shortened')

// ── running it ───────────────────────────────────────────────────────────────
const calls = []
const control = async (query, action, opts) => (calls.push({ query, action, opts }), '• *סלון* שונה בהצלחה למצב: *דלוק* 🟢 💡')
const r = await fastCommand('תדליק את האורות בסלון', { control })
ok(r?.reply === 'דלקו 💡' && r.fast === true, 'a command is carried out and answered in a word')
ok(eq(calls[0], { query: 'סלון', action: 'on', opts: { fast: true } }), 'the control call got the room, the action and fast mode')
ok((await fastCommand('מה השעה', { control })) === null && calls.length === 1, 'something else is not carried out')
const failing = await fastCommand('תכבה את האורות', { control: async () => { throw Object.assign(new Error('Google Home לא מחובר.'), { hint: 'צריך להיכנס שוב ל-Google Home.' }) } })
ok(failing?.reply === 'צריך להיכנס שוב ל-Google Home.', 'a failure is said plainly, with its hint')
const crash = await fastCommand('תכבה את האורות', { control: async () => { throw new Error('דפדפן הבית לא פועל.') } })
ok(crash?.reply === 'דפדפן הבית לא פועל.', 'and without one, with its message')

// ── the TV and the projector ─────────────────────────────────────────────────
for (const t of ['תכבה את הטלוויזיה', 'תכבה את הטלויזיה', 'כבה את המקרן', 'תכבה את הטלוויזיה בבקשה', 'הלפר תכבה את המקרן', 'תכבה את הטלוויזיה והמקרן', 'לכבות את הטלויזיה בסלון', 'תכבה tv']) {
  ok(parseScreenOff(t)?.action === 'off', `"${t}" turns the screen off`)
}
for (const t of ['תדליק את הטלוויזיה', 'תכבה את האורות', 'תכבה את הטלוויזיה בעוד שעה', 'תכבה את הטלוויזיה ותדליק אורות', 'מה בטלוויזיה', 'תכבה', 'תכבה את המחשב', 'תפעיל את המקרן']) {
  ok(parseScreenOff(t) === null, `"${t}" is not that`)
}
const log = []
const fakeCall = async (op, args) => log.push(['call', op, args.key])
const fakeSleep = async (ms) => log.push(['wait', ms])
await tvPowerOff({ call: fakeCall, sleep: fakeSleep })
ok(JSON.stringify(log) === JSON.stringify([['call', 'key', 'sleep'], ['wait', 500], ['call', 'key', 'sleep']]), 'off is two presses with half a second between them')
let n = 0
const dropsAfterFirst = async () => { if (++n > 1) throw new Error('הטלוויזיה התנתקה') }
await tvPowerOff({ call: dropsAfterFirst, sleep: async () => {} })
ok(n === 2, 'a TV that is already off after the first press is not an error')
let firstFailed = false
try { await tvPowerOff({ call: async () => { throw new Error('הטלוויזיה לא מחוברת') }, sleep: async () => {} }) } catch (e) { firstFailed = e.message === 'הטלוויזיה לא מחוברת' }
ok(firstFailed, 'but a first press that fails is reported')
const timing = []
await tvPowerOff({ call: async () => timing.push(Date.now()), sleep: undefined, gapMs: 120 })
ok(timing.length === 2 && timing[1] - timing[0] >= 110, 'the real wait is the gap that was asked for')
const offRuns = []
const done = await fastCommand('תכבה את הטלוויזיה', { screenOff: async () => offRuns.push(1), control: async () => { throw new Error('should not be called') } })
ok(done?.reply === 'כיביתי 📺' && offRuns.length === 1, 'the command is carried out without a model, and not as lights')
const notConnected = await fastCommand('תכבה את המקרן', { screenOff: async () => { throw new Error('הטלוויזיה לא מחוברת ל-HELPER כרגע') } })
ok(notConnected?.reply.includes('לא מחוברת'), 'when the TV is not connected it says so plainly')
ok(parseLights('תכבה את הטלוויזיה') === null, 'the TV is never mistaken for lights')

console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
if (failed) process.exit(1)
console.log('הכול תקין')
