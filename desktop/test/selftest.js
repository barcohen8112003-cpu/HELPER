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


// Human confirmations
const { human } = require('../src/phrase')
const say = (steps, lines) => human(steps, lines || [])
check('say: open and place', () => assert.strictEqual(say([{ cmd: 'open', args: { name: 'מחשבון' } }, { cmd: 'place', args: { name: 'מחשבון', where: 'left' } }]), 'פתחתי את המחשבון ושמתי אותו בצד שמאל'))
check('say: proper name has no article', () => assert.strictEqual(say([{ cmd: 'open', args: { name: 'כרום' } }]), 'פתחתי את כרום'))
check('say: two apps', () => assert.strictEqual(say([{ cmd: 'open', args: { name: 'כרום' } }, { cmd: 'open', args: { name: 'דיסקורד' } }]), 'פתחתי את כרום ופתחתי את דיסקורד'))
check('say: two windows, two sides', () => assert.strictEqual(say([{ cmd: 'place', args: { name: 'כרום', where: 'left' } }, { cmd: 'place', args: { name: 'דיסקורד', where: 'right' } }]), 'שמתי את כרום בצד שמאל ושמתי את דיסקורד בצד ימין'))
check('say: other screen', () => assert.strictEqual(say([{ cmd: 'place', args: { name: 'דיסקורד', where: 'max', screen: 'next' } }]), 'שמתי את דיסקורד על המסך השני'))
check('say: side of the other screen', () => assert.strictEqual(say([{ cmd: 'place', args: { name: 'ספוטיפיי', where: 'right', screen: 'next' } }]), 'שמתי את ספוטיפיי בצד ימין של המסך השני'))
check('say: top of the other screen', () => assert.strictEqual(say([{ cmd: 'place', args: { name: 'כרום', where: 'top', screen: '2' } }]), 'שמתי את כרום למעלה במסך השני'))
check('say: names in English are said in Hebrew', () => assert.strictEqual(say([{ cmd: 'open', args: { name: 'Calculator' } }, { cmd: 'place', args: { name: 'Calculator', where: 'left', screen: '1' } }]), 'פתחתי את המחשבון ושמתי אותו בצד שמאל של המסך הראשון'))
check('say: two apps read app by app', () => assert.strictEqual(say([{ cmd: 'open', args: { name: 'Chrome' } }, { cmd: 'open', args: { name: 'Discord' } }, { cmd: 'place', args: { name: 'Chrome', where: 'left' } }, { cmd: 'place', args: { name: 'Discord', where: 'right' } }]), 'פתחתי את כרום ושמתי אותו בצד שמאל, ופתחתי את דיסקורד ושמתי אותו בצד ימין'))
check('close all goes to the brain', () => assert.strictEqual(parse('תסגור את כל מה שפתחת עכשיו'), null))
check('say: switched to an open one', () => assert.strictEqual(say([{ cmd: 'open', args: { name: 'כרום' } }], ['עברתי לכרום']), 'עברתי לכרום'))
check('say: close two', () => assert.strictEqual(say([{ cmd: 'close', args: { name: 'דיסקורד' } }, { cmd: 'close', args: { name: 'טלגרם' } }]), 'סגרתי את דיסקורד וסגרתי את טלגרם'))
check('say: volume', () => assert.strictEqual(say([{ cmd: 'volume', args: { op: 'set', value: 30 } }]), 'שמתי את העוצמה על 30'))
check('say: play', () => assert.strictEqual(say([{ cmd: 'play', args: { query: 'x' } }], ['מנגן: אופק אדנק - נתתי לך בית']), 'מנגן לך אופק אדנק - נתתי לך בית'))
check('say: this window', () => assert.strictEqual(say([{ cmd: 'place', args: { name: 'זה', where: 'left' } }]), 'שמתי את החלון בצד שמאל'))
check('say: an unknown step keeps the line the hands gave', () => assert.strictEqual(say([{ cmd: 'time', args: {} }], ['השעה 23:25']), 'השעה 23:25'))

// Inside a window: instant phrases
same('תלחץ על שמור', [{ cmd: 'press', args: { target: 'שמור' } }])
same('תלחץ על הכפתור הבא', [{ cmd: 'press', args: { target: 'הכפתור הבא' } }])
same('תלחץ על פלוס 3 פעמים', [{ cmd: 'press', args: { target: 'פלוס', times: 3 } }])
same('click send', [{ cmd: 'press', args: { target: 'send' } }])
same('תלחץ אנטר', [{ cmd: 'key', args: { keys: 'enter' } }])
same('תלחץ על אסקייפ', [{ cmd: 'key', args: { keys: 'esc' } }])
same('תכתוב בפנקס רשימות תודה רבה על הכל', [{ cmd: 'write', args: { phrase: 'פנקס רשימות תודה רבה על הכל' } }])
same('תכתוב בוואטסאפ בבקשה תביא חלב ואז תבוא', [{ cmd: 'write', args: { phrase: 'וואטסאפ בבקשה תביא חלב ואז תבוא' } }])
same('תכתוב בשדה החיפוש חתולים חמודים', [{ cmd: 'fill', args: { field: 'חיפוש', text: 'חתולים חמודים' } }])
same('תכתוב פה שלום לכולם', [{ cmd: 'type', args: { text: 'שלום לכולם' } }])
brain('תכתוב לדני שאני מאחר')
brain('תכתוב באנגלית מכתב לבוס')
brain('תכתוב בפנקס רשימות את התוצאה שמופיעה עכשיו במחשבון')
brain('תכתוב בשדה החיפוש את מה שכתוב בלוח')
same('תעבור לטאב של יוטיוב', [{ cmd: 'tab', args: { title: 'יוטיוב' } }])
same('תעבור לכרטיסייה של ג׳ימייל', [{ cmd: 'tab', args: { title: 'ג׳ימייל' } }])
same('תעבור לטאב הבא', [{ cmd: 'browser_tab', args: { action: 'next' } }])
same('תסגור את הטאב של קיק', [{ cmd: 'tab', args: { title: 'קיק', close: true } }])
same('סגור טאב', [{ cmd: 'browser_tab', args: { action: 'close' } }])
same('תיכנס ל-ynet.co.il', [{ cmd: 'goto', args: { url: 'ynet.co.il', newtab: false } }])
same('תכנס ליוטיוב בטאב חדש', [{ cmd: 'goto', args: { url: 'יוטיוב', newtab: true } }])
same('תפתח את גיטהאב בטאב חדש', [{ cmd: 'goto', args: { url: 'גיטהאב', newtab: true } }])
brain('תכנס למייל של דני')
same('תגלול למטה', [{ cmd: 'scroll', args: { amount: -6 } }])
same('תגלול למעלה הרבה', [{ cmd: 'scroll', args: { amount: 15 } }])
same('תעתיק', [{ cmd: 'key', args: { keys: 'ctrl+c' } }])
same('תדביק פה', [{ cmd: 'key', args: { keys: 'ctrl+v' } }])
same('תשמור את הקובץ', [{ cmd: 'key', args: { keys: 'ctrl+s' } }])
same('תחזור אחורה', [{ cmd: 'key', args: { keys: 'alt+left' } }])
same('תבחר הכל ותעתיק', [{ cmd: 'key', args: { keys: 'ctrl+a' } }, { cmd: 'key', args: { keys: 'ctrl+c' } }])
same('תלחץ על שמור ואז תסגור את זה', [{ cmd: 'press', args: { target: 'שמור' } }, { cmd: 'close', args: { name: 'זה' } }])
check('say: keys said as what they did', () => assert.strictEqual(require('../src/phrase').human([{ cmd: 'key', args: { keys: 'ctrl+c' } }], ['לחצתי ctrl+c']), 'העתקתי'))

// Finding a control by what the user called it
const uia = require('../src/uia')
const CTRLS = [
  { i: 0, type: 'Button', name: 'Minimize', enabled: true },
  { i: 1, type: 'Button', name: 'Save (Ctrl+S)', enabled: true },
  { i: 2, type: 'Button', name: 'Send', enabled: false },
  { i: 3, type: 'Edit', name: 'Search', value: '', enabled: true },
  { i: 4, type: 'Button', name: 'שבע', enabled: true },
  { i: 5, type: 'Button', name: 'Plus', id: 'plusButton', enabled: true },
  { i: 6, type: 'TabItem', name: 'YouTube - Google Chrome', enabled: true },
  { i: 7, type: 'Hyperlink', name: 'התחברות לחשבון', enabled: true },
  { i: 8, type: 'Button', name: 'Send message', enabled: true },
  { i: 9, type: 'Document', name: 'Text editor', enabled: true },
]
const pick = (q, kind) => { const m = uia.match(CTRLS, q, kind); return m ? m.i : null }
check('ui: Hebrew word finds the English button', () => assert.strictEqual(pick('שמור'), 1))
check('ui: words around the name drop', () => assert.strictEqual(pick('על הכפתור שמור'), 1))
check('ui: a number word finds the digit or its Hebrew', () => assert.strictEqual(pick('7'), 4))
check('ui: plus by Hebrew', () => assert.strictEqual(pick('פלוס'), 5))
check('ui: enabled wins over disabled', () => assert.strictEqual(pick('שלח'), 8))
check('ui: field kind finds the search box', () => assert.strictEqual(pick('חיפוש', 'field'), 3))
check('ui: tab by part of its title', () => assert.strictEqual(pick('youtube', 'tab'), 6))
const TABS = [{ i: 0, type: 'TabItem', name: 'Napoleon edit - YouTube - אודיו מופעל' }, { i: 1, type: 'TabItem', name: 'YouTube Music' }, { i: 2, type: 'TabItem', name: 'TikTok Search' }]
check('ui: a site said in Hebrew finds its tab, the site itself before one that starts the same', () => assert.strictEqual(uia.match(TABS, 'יוטיוב', 'tab').i, 0))
check('ui: טיקטוק finds TikTok', () => assert.strictEqual(uia.match(TABS, 'טיקטוק', 'tab').i, 2))
check('ui: a link by one of its words', () => assert.strictEqual(pick('התחברות'), 7))
check('ui: one letter off still finds it', () => assert.strictEqual(pick('התחברויות לחשבון'), 7))
check('ui: nothing like it is nothing', () => assert.strictEqual(pick('בננה'), null))
check('ui: main field is the search box', () => assert.strictEqual(uia.defaultField(CTRLS).i, 3))
check('ui: described for the brain', () => assert.ok(/כפתור: Save/.test(uia.describe(CTRLS)) && /שדה: Search = \(ריק\)/.test(uia.describe(CTRLS)) && /\(לא פעיל\)/.test(uia.describe(CTRLS))))
const { siteUrl } = require('../src/sites')
check('sites: names and addresses', () => assert.deepStrictEqual([siteUrl('ynet.co.il'), siteUrl('יוטיוב'), siteUrl('ג׳ימייל'), siteUrl('בננה'), siteUrl('מייל של דני')], ['https://ynet.co.il', 'https://youtube.com', 'https://mail.google.com', null, null]))

console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
