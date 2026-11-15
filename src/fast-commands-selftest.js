// node src/fast-commands-selftest.js
// Offline: no model, no browser, no Google Home. The control call is replaced by a recorder.
import { parseLights, parseScreenOff, parseScreenOn, parsePcPower, parseScene, shortReply, fastCommand } from './fast-commands.js'
import { tvPowerOff, tvPowerOn } from './tv-tools.js'

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
const fiveOff = [['call', 'key', 'sleep'], ['wait', 500], ['call', 'key', 'sleep'], ['wait', 500], ['call', 'key', 'sleep'], ['wait', 500], ['call', 'key', 'sleep'], ['wait', 500], ['call', 'key', 'sleep']]
ok(JSON.stringify(log) === JSON.stringify(fiveOff), 'off is five presses with half a second between them')
let n = 0
const dropsAfterFirst = async () => { if (++n > 1) throw new Error('הטלוויזיה התנתקה') }
await tvPowerOff({ call: dropsAfterFirst, sleep: async () => {} })
ok(n === 5, 'a TV that is already off after the first press is not an error, and the rest are still tried')
let firstFailed = false
try { await tvPowerOff({ call: async () => { throw new Error('הטלוויזיה לא מחוברת') }, sleep: async () => {} }) } catch (e) { firstFailed = e.message === 'הטלוויזיה לא מחוברת' }
ok(firstFailed, 'but a first press that fails is reported')
const timing = []
await tvPowerOff({ call: async () => timing.push(Date.now()), sleep: undefined, gapMs: 120 })
ok(timing.length === 5 && timing[1] - timing[0] >= 110 && timing[4] - timing[3] >= 110, 'the real wait is the gap that was asked for, five times')
const offRuns = []
const done = await fastCommand('תכבה את הטלוויזיה', { screenOff: async () => offRuns.push(1), control: async () => { throw new Error('should not be called') } })
ok(done?.reply === 'כיביתי 📺' && offRuns.length === 1, 'the command is carried out without a model, and not as lights')
const notConnected = await fastCommand('תכבה את המקרן', { screenOff: async () => { throw new Error('הטלוויזיה לא מחוברת ל-HELPER כרגע') } })
ok(notConnected?.reply.includes('לא מחוברת'), 'when the TV is not connected it says so plainly')
ok(parseLights('תכבה את הטלוויזיה') === null, 'the TV is never mistaken for lights')


// ── LEDs, the projector on, the PC, and a spoken scene ───────────────────────
ok(eq(parseLights('תדליק את כל הלדים'), on('לד')), 'all the LEDs')
ok(eq(parseLights('תכבה את הלדים'), off('לד')), 'the LEDs off')
ok(eq(parseLights('להדליק את כל הלדים'), on('לד')), 'infinitive, the LEDs')
ok(eq(parseLights('תדליק led'), on('לד')), 'led in English')
ok(parseLights('תדליק את האורות').query === 'כל האורות', 'ordinary lights are still all the lights')

for (const t of ['תדליק את הטלוויזיה', 'תדליק את המקרן', 'תפעיל את המקרן', 'הלפר תדליקי את המקרן בבקשה', 'להדליק את המקרן']) {
  ok(parseScreenOn(t)?.action === 'on', `"${t}" turns the screen on`)
}
ok(parseScreenOn('תכבה את המקרן') === null && parseScreenOff('תדליק את המקרן') === null, 'on and off are not mixed up')
ok(parsePcPower('תכבה את המחשב')?.action === 'shutdown', 'turn the PC off')
ok(parsePcPower('לכבות את המחשב')?.action === 'shutdown', 'infinitive, the PC')
ok(parsePcPower('הלפר תכבה לי את המחשב בבקשה')?.action === 'shutdown', 'the PC with fillers')
ok(parsePcPower('תדליק את המחשב') === null && parsePcPower('תכבה את האורות') === null, 'other things are not a PC shutdown')

const scenePhrase = 'לכבות מחשב להדליק את כל הלדים ואת המקרן להדליק'
const scene = parseScene(scenePhrase)
ok(scene?.length === 3, 'the spoken scene has three actions')
ok(scene?.some((s) => s.type === 'pc' && s.action === 'shutdown'), 'the scene shuts the PC')
ok(scene?.some((s) => s.type === 'lights' && s.action === 'on' && s.query === 'לד'), 'the scene turns the LEDs on')
ok(scene?.some((s) => s.type === 'tv' && s.action === 'on'), 'the scene turns the projector on')
ok(parseScene('תדליק את האורות ותשים מוזיקה') === null, 'music still goes to the model')
ok(parseScene('תדליק את האורות בעוד שעה') === null, 'a delay still goes to the model')
ok(parseScene('תזכיר לי לכבות את האורות') === null, 'a reminder still goes to the model')
ok(parseScene('תכבה את הטלוויזיה ותדליק אורות')?.length === 2, 'two known actions in one sentence')
ok(eq(parseScene('תדליק את האורות בסלון'), [{ type: 'lights', action: 'on', query: 'סלון' }]), 'a single lights command is a one-step scene')

const sceneCalls = []
const sceneDone = await fastCommand(scenePhrase, {
  control: async (query, action, opts) => (sceneCalls.push(['lights', query, action, opts]), '• *לד* שונה בהצלחה למצב: *דלוק* 🟢 💡'),
  screenOn: async () => sceneCalls.push(['tv:on']),
  screenOff: async () => { throw new Error('should not turn the screen off') },
  pcPower: async (action) => (sceneCalls.push(['pc', action]), 'המחשב ייכבה עכשיו'),
})
ok(sceneDone?.fast === true && /המחשב ייכבה עכשיו/.test(sceneDone.reply) && /דלקו/.test(sceneDone.reply) && /הדלקתי את המקרן/.test(sceneDone.reply), 'the scene is carried out and spoken in one reply')
ok(sceneCalls.some((c) => c[0] === 'lights' && c[1] === 'לד' && c[2] === 'on' && c[3]?.fast === true), 'LEDs were asked for, in fast mode')
ok(sceneCalls.some((c) => c[0] === 'tv:on') && sceneCalls.some((c) => c[0] === 'pc' && c[1] === 'shutdown'), 'the projector and the PC ran too')
const onRuns = []
ok((await fastCommand('תדליק את המקרן', { screenOn: async () => onRuns.push(1), control: async () => { throw new Error('should not be called') } }))?.reply.includes('הדלקתי') && onRuns.length === 1, 'turning the projector on is a fast command')
const pcRuns = []
ok((await fastCommand('תכבה את המחשב', { pcPower: async (a) => (pcRuns.push(a), 'המחשב ייכבה עכשיו') }))?.reply === 'המחשב ייכבה עכשיו' && pcRuns[0] === 'shutdown', 'turning the PC off is a fast command, with no WhatsApp wait')
ok((await fastCommand('תכבה את המחשב', { pcPower: async () => { throw new Error('המחשב לא מחובר להלפר כרגע.') } }))?.reply.includes('לא מחובר'), 'a PC that is already off is said plainly')
const onLog = []
await tvPowerOn({ call: async (op, args) => onLog.push([op, args.key]) })
ok(JSON.stringify(onLog) === JSON.stringify([['key', 'sleep']]), 'on is a single press')

console.log(`${passed} בדיקות עברו, ${failed} נכשלו`)
if (failed) process.exit(1)
console.log('הכול תקין')
