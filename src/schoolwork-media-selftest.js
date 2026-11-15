import { preferHomeworkTitle, homeworkSnippets } from './schoolwork-media.js'
import assert from 'node:assert/strict'

const written = 'שיעורי בית ליום ראשון! ספר יסודות, עמודים 45–46, שאלות 1, 2 סעיף א'
const generic = 'שיעורי בית במתמטיקה ליום ראשון'
const t1 = preferHomeworkTitle(written, generic)
assert.match(t1, /ספר יסודות/)
assert.match(t1, /עמודים 45/)
assert.match(t1, /שאלות 1/)
assert.match(t1, /סעיף א/)
assert.ok(!t1.includes('!'))

const fromPhoto = 'ספר יסודות עמוד 12 שאלות 3–5 סעיף ב'
assert.match(preferHomeworkTitle('שיעורי בית ליום שלישי', fromPhoto), /ספר יסודות/)
assert.match(preferHomeworkTitle('שיעורי בית ליום שלישי', fromPhoto), /עמוד 12/)
assert.match(preferHomeworkTitle('שיעורי בית ליום שלישי', fromPhoto), /שאלות 3/)
assert.match(preferHomeworkTitle('שיעורי בית ליום שלישי', fromPhoto), /סעיף ב/)

assert.equal(preferHomeworkTitle('שיעורי בית ליום ראשון!', generic), generic)

const raw = 'חוברת תרגול, עמוד 8, תרגילים 4 ו-5'
assert.match(preferHomeworkTitle(raw, ''), /חוברת תרגול/)
assert.match(preferHomeworkTitle(raw, ''), /עמוד 8/)
assert.match(preferHomeworkTitle(raw, ''), /תרגילים 4/)

// Full classroom-style message: keep the details, drop the warning.
const long = 'להגיש עד יום רביעי את התרגילים 1-5 בעמוד 40 במתמטיקה, מי שלא מגיש מקבל אפס ופרטים אישיים כאן'
const enriched = preferHomeworkTitle(long, 'עבודת חקר על פונקציות במתמטיקה')
assert.match(enriched, /עבודת חקר על פונקציות/)
assert.match(enriched, /עמוד 40/)
assert.match(enriched, /תרגילים 1-5/)
assert.ok(!enriched.includes('פרטים אישיים'))
assert.ok(!homeworkSnippets(long).includes('פרטים'))

const huge = `ספר א ${'שאלה 1, '.repeat(80)}עמוד 9`
assert.ok(preferHomeworkTitle(huge, generic).length <= 400)
assert.match(preferHomeworkTitle(huge, generic), /ספר א/)

console.log('schoolwork-media-selftest: ok')
