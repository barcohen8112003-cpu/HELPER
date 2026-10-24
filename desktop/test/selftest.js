// Offline checks: the instant commands understand real sentences, and send everything else to the brain.
// Run: npm run check (from desktop/).
'use strict'
const assert = require('assert')
const { parse, tidy } = require('../src/instant')
const speech = require('../src/speech')

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); passed++ } catch (e) { failed++; console.log('FAIL', name, '\n  ', e.message) }
}
const steps = (t) => (parse(t) || {}).steps || null
const same = (t, want) => check(t, () => assert.deepStrictEqual(steps(t), want))
const brain = (t) => check('brain: ' + t, () => assert.strictEqual(parse(t), null))

// Opening apps
same('תפתח את כרום', [{ cmd: 'open', args: { name: 'כרום' } }])
same('תפתח בבקשה ספוטיפיי!', [{ cmd: 'open', args: { name: 'ספוטיפיי' } }])
same('הלפר, תפעיל את דיסקורד', [{ cmd: 'open', args: { name: 'דיסקורד' } }])
same('open spotify', [{ cmd: 'open', args: { name: 'spotify' } }])
same('תפתח את האפליקציה וואטסאפ', [{ cmd: 'open', args: { name: 'וואטסאפ' } }])
same('תפתח כרום בצד שמאל', [{ cmd: 'open', args: { name: 'כרום' } }, { cmd: 'place', args: { name: 'כרום', where: 'left', screen: undefined } }])

same('תפתחה את פנקס הרשימות', [{ cmd: 'open', args: { name: 'פנקס הרשימות' } }])
same('פתחו את ספוטיפיי', [{ cmd: 'open', args: { name: 'ספוטיפיי' } }])
same('תפתחי לי את דיסקורד', [{ cmd: 'open', args: { name: 'דיסקורד' } }])

// Placing windows
same('תשים את כרום בצד שמאל', [{ cmd: 'place', args: { name: 'כרום', where: 'left', screen: undefined } }])
same('כרום שמאלה', [{ cmd: 'place', args: { name: 'כרום', where: 'left', screen: undefined } }])
same('תעביר את דיסקורד למסך השני', [{ cmd: 'place', args: { name: 'דיסקורד', where: 'max', screen: 'next' } }])
same('תזיז את ספוטיפיי למסך השני בצד ימין', [{ cmd: 'place', args: { name: 'ספוטיפיי', where: 'right', screen: 'next' } }])
same('תשים את כרום בצד ימין של המסך השני', [{ cmd: 'place', args: { name: 'כרום', where: 'right', screen: 'next' } }])
same('תגדיל את כרום', [{ cmd: 'place', args: { name: 'כרום', where: 'max' } }])
same('תמזער את דיסקורד', [{ cmd: 'place', args: { name: 'דיסקורד', where: 'min' } }])
same('תשים את זה בצד שמאל', [{ cmd: 'place', args: { name: 'זה', where: 'left', screen: undefined } }])
same('put chrome on the left', [{ cmd: 'place', args: { name: 'chrome', where: 'left', screen: undefined } }])
same('כרום משמאל ודיסקורד מימין', [
  { cmd: 'place', args: { name: 'כרום', where: 'left', screen: undefined } },
  { cmd: 'place', args: { name: 'דיסקורד', where: 'right', screen: undefined } },
])
same('תפתח את ספוטיפיי ואז תשים אותו בצד ימין', [
  { cmd: 'open', args: { name: 'ספוטיפיי' } },
  { cmd: 'place', args: { name: 'ספוטיפיי', where: 'right', screen: undefined } },
])

same('תפתח את המחשבון ותשים אותו בצד שמאל', [
  { cmd: 'open', args: { name: 'מחשבון' } },
  { cmd: 'place', args: { name: 'מחשבון', where: 'left', screen: undefined } },
])
same('תפתח את כרום ואת ספוטיפיי', [{ cmd: 'open', args: { name: 'כרום' } }, { cmd: 'open', args: { name: 'ספוטיפיי' } }])
same('תסגור את דיסקורד ואת טלגרם', [{ cmd: 'close', args: { name: 'דיסקורד' } }, { cmd: 'close', args: { name: 'טלגרם' } }])
same('תפתח את ספוטיפיי ותעביר אותו למסך השני', [
  { cmd: 'open', args: { name: 'ספוטיפיי' } },
  { cmd: 'place', args: { name: 'ספוטיפיי', where: 'max', screen: 'next' } },
])
brain('תפתח את המייל ותכתוב לדני שאני מאחר')

// Closing
same('תסגור את דיסקורד', [{ cmd: 'close', args: { name: 'דיסקורד' } }])
same('תסגור את זה', [{ cmd: 'close', args: { name: 'זה' } }])
brain('תסגור הכל')

// Volume and media
same('תגביר', [{ cmd: 'volume', args: { op: 'up', value: 5 } }])
same('תגביר את הקול הרבה', [{ cmd: 'volume', args: { op: 'up', value: 12 } }])
same('תנמיך קצת', [{ cmd: 'volume', args: { op: 'down', value: 5 } }])
same('ווליום 30', [{ cmd: 'volume', args: { op: 'set', value: 30 } }])
same('תשים את העוצמה על 40', [{ cmd: 'volume', args: { op: 'set', value: 40 } }])
same('השתק', [{ cmd: 'volume', args: { op: 'mute' } }])
same('השיר הבא', [{ cmd: 'media', args: { op: 'next' } }])
same('תעצור את המוזיקה', [{ cmd: 'media', args: { op: 'pause' } }])
same('תמשיך', [{ cmd: 'media', args: { op: 'play' } }])

// Search
same('תחפש מתכון לשקשוקה', [{ cmd: 'search', args: { query: 'מתכון לשקשוקה', site: 'google' } }])
same('חפש ביוטיוב שירים של עומר אדם', [{ cmd: 'search', args: { query: 'שירים של עומר אדם', site: 'youtube' } }])
// Playing videos and songs
same('תפעיל ביוטיוב לופי', [{ cmd: 'play', args: { query: 'לופי' } }])
same('תנגן אופק אדנק', [{ cmd: 'play', args: { query: 'אופק אדנק' } }])
same('תפעיל לי את השיר נתתי לך בית', [{ cmd: 'play', args: { query: 'נתתי לך בית' } }])
same('תשים לי סרטון של מסטר בין', [{ cmd: 'play', args: { query: 'מסטר בין' } }])
same('תפעיל סרטון של חתולים מצחיקים ביוטיוב', [{ cmd: 'play', args: { query: 'חתולים מצחיקים' } }])
same('יוטיוב עומר אדם', [{ cmd: 'play', args: { query: 'עומר אדם' } }])
same('play despacito on youtube', [{ cmd: 'play', args: { query: 'despacito' } }])
same('תפעיל את ספוטיפיי', [{ cmd: 'open', args: { name: 'ספוטיפיי' } }])
same('תנגן', [{ cmd: 'media', args: { op: 'play' } }])
same('תנגן את השיר', [{ cmd: 'media', args: { op: 'play' } }])
same('חפש ביוטיוב לופי', [{ cmd: 'search', args: { query: 'לופי', site: 'youtube' } }])
same('תחפש במפות פיצה בחיפה', [{ cmd: 'search', args: { query: 'פיצה בחיפה', site: 'maps' } }])

// PC
same('תמזער הכל', [{ cmd: 'desktop' }])
same('תנעל את המחשב', [{ cmd: 'lock' }])
same('מה השעה', [{ cmd: 'time' }])

// Memory and teaching
check('remember', () => assert.deepStrictEqual(parse('תזכור שאני אוהב קפה בלי סוכר'), { remember: 'אני אוהב קפה בלי סוכר' }))
check('teach', () => assert.deepStrictEqual(parse('כשאני אומר מצב עבודה, תפתח את כרום ואת ספוטיפיי'), { teach: { phrase: 'מצב עבודה', does: 'תפתח את כרום ואת ספוטיפיי' } }))
check('unlearn', () => assert.deepStrictEqual(parse('תשכח את הקיצור מצב עבודה'), { unlearn: 'מצב עבודה' }))

// The brain's
brain('מה כתוב על המסך')
brain('איפה מדליקים את מצב הלילה')
brain('תכתוב לי מייל לבעל הבית שאני מאחר בתשלום')
brain('מה מזג האוויר מחר בחיפה')
brain('תסביר לי מה הקוד הזה עושה')
brain('תמצא לי את הקובץ של החשבונית מאתמול')
brain('למה המחשב איטי')
brain('what is on my screen')

// Tidy and speech cleanup
check('tidy', () => assert.strictEqual(tidy('  הלפר, תפתח   בבקשה את כרום!! '), 'תפתח את כרום'))
check('fillers', () => assert.strictEqual(speech.clean('אממ תפתח אה את כרום'), 'תפתח את כרום'))
check('silence', () => assert.strictEqual(speech.clean('תודה רבה'), ''))
check('misheard youtube', () => assert.strictEqual(speech.clean('תפעיל בי עוד טיוב את השיר נתתי לך בית'), 'תפעיל ביוטיוב את השיר נתתי לך בית'))
check('misheard spotify', () => assert.strictEqual(speech.clean('תפתח את ספוטי פיי'), 'תפתח את ספוטיפיי'))
check('made up on silence', () => assert.strictEqual(speech.clean('אדוני היושב-ראש, חברות וחברי הכנסת'), ''))
check('subtitles on silence', () => assert.strictEqual(speech.clean('תרגום: כתוביות'), ''))
check('real thanks inside a sentence', () => assert.strictEqual(speech.clean('תודה רבה על העזרה עם הקוד'), 'תודה רבה על העזרה עם הקוד'))

// Speech detection on WAVs: silence, faint hiss, and a voice-like tone.
function wavOf(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2)
  buf.write('RIFF', 0); buf.write('WAVE', 8)
  samples.forEach((v, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), 44 + i * 2))
  return buf
}
const sec = 16000
check('silence is not speech', () => assert.strictEqual(speech.hasSpeech(wavOf(new Array(sec * 2).fill(0))), false))
check('hiss is not speech', () => assert.strictEqual(speech.hasSpeech(wavOf(Array.from({ length: sec * 2 }, () => (Math.random() - 0.5) * 300))), false))
check('a voice is speech', () => assert.strictEqual(speech.hasSpeech(wavOf(Array.from({ length: sec * 2 }, (_, i) => Math.sin(i / 8) * 6000 * (i > sec / 2 && i < sec * 1.5 ? 1 : 0.02)))), true))

console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
