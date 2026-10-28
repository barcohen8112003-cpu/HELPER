// The style check set: replies written the way models tend to write, and what Naor should actually get.
// Every change to src/style.js or persona.md is checked against it. Offline, no model.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { polish, styleTells, humanError } from './style.js'

const CASES = [
  // [model wrote, sent]
  ['בטח! מחר 24°, בלי גשם ☀️', 'מחר 24°, בלי גשם ☀️'],
  ['כמובן! הנה הרשימה:\n• חלב\n• ביצים', 'הנה הרשימה:\n• חלב\n• ביצים'],
  ['שאלה מצוינת! התשובה היא 42.', 'התשובה היא 42.'],
  ['אשמח לעזור! המבחן ביום רביעי.', 'המבחן ביום רביעי.'],
  ['בשמחה 😊 קבעתי תזכורת ל-18:00.', 'קבעתי תזכורת ל-18:00.'],
  ['Sure! The build passed.', 'The build passed.'],
  ['המבחן זז ליום ד׳.\n\nעוד משהו?', 'המבחן זז ליום ד׳.'],
  ['שלחתי את המייל.\nתגיד אם צריך עוד משהו 🙂', 'שלחתי את המייל.'],
  ['389 ₪, ירד מ-430.\n\nאם תצטרך עוד משהו, אני כאן!', '389 ₪, ירד מ-430.'],
  ['סגרתי את התזכורת. במה עוד אוכל לעזור?', 'סגרתי את התזכורת.'],
  ['הנה הסיכום.\nמקווה שזה עוזר!', 'הנה הסיכום.'],
  ['בטח! הנה.\n\nיש עוד משהו שאוכל לעזור בו?', 'הנה.'],
  ['**שיעורי בית**\n- מתמטיקה: עמ׳ 12', '*שיעורי בית*\n• מתמטיקה: עמ׳ 12'],
  ['## שינויי מערכת\n- שיעור 1 מבוטל', '*שינויי מערכת*\n• שיעור 1 מבוטל'],
  ['ראה [האתר](https://example.com)', 'ראה האתר: https://example.com'],
  ['[https://a.co](https://a.co)', 'https://a.co'],
  ['זה עולה 50 ₪ — כולל משלוח.', 'זה עולה 50 ₪, כולל משלוח.'],
  ['שורה\n\n\n\nשורה', 'שורה\n\nשורה'],
  ['---\nתוצאה', 'תוצאה'],
  ['__חשוב__: הגשה מחר', '_חשוב_: הגשה מחר'],
  // Left alone
  ['מחר 24°, בלי גשם ☀️', 'מחר 24°, בלי גשם ☀️'],
  ['בטח שאני זוכר, אמרת שאתה שונא כוסברה 😂', 'בטח שאני זוכר, אמרת שאתה שונא כוסברה 😂'],
  ['שיעורים 1–2: כימיה מבוטל', 'שיעורים 1–2: כימיה מבוטל'],
  ['*כבר מודגש* וטוב', '*כבר מודגש* וטוב'],
  ['```js\n// **not bold** — keep\nconst a = 1\n```', '```js\n// **not bold** — keep\nconst a = 1\n```'],
  ['הנה הקוד:\n```\n- item\n```\nעוד משהו?', 'הנה הקוד:\n```\n- item\n```'],
  ['SKIP', 'SKIP'],
  ['בטח!', 'בטח!'],
  ['עוד משהו?', 'עוד משהו?'],
  ['בהצלחה במבחן! 🍀', 'בהצלחה במבחן! 🍀'],
]

let passed = 0
for (const [input, expected] of CASES) {
  assert.equal(polish(input), expected, `polish(${JSON.stringify(input)})`)
  passed++
}
for (const [, expected] of CASES.slice(0, 20)) {
  assert.deepEqual(styleTells(expected), [], `still reads like a bot: ${expected}`)
  passed++
}
assert.ok(styleTells('כמודל שפה אני לא יכול').length > 0)
passed++
for (const [err, want] of [
  [new Error('LLM HTTP 503: upstream'), /עמוס/],
  [new Error('LLM HTTP 401: bad key'), /המפתח/],
  [new Error('fetch failed'), /שירות חיצוני/],
  [new Error('Google HTTP 500: x'), /שירות חיצוני/],
  [new Error('החשבון לא מחובר'), /^החשבון לא מחובר$/],
  [new Error('Cannot read properties of undefined'), /משהו השתבש/],
]) {
  assert.match(humanError(err), want)
  passed++
}
// The voice card (persona.voice.md, last in the system prompt): every "good" example must pass the same checks,
// and at least half the "bad" ones must be caught, so the card and the checks keep agreeing.
const card = fs.readFileSync(new URL('../persona.voice.md', import.meta.url), 'utf8')
const pairs = [...card.matchAll(/^- "(.+?)" → "(.+?)"/gm)]
assert.ok(pairs.length >= 5, 'the voice card has its bad/good examples')
for (const [, , good] of pairs) {
  assert.deepEqual(styleTells(good), [], `voice card example reads like a bot: ${good}`)
  assert.equal(polish(good), good, `polish changes a good example: ${good}`)
  passed += 2
}
assert.ok(pairs.filter(([, bad]) => styleTells(bad).length).length * 2 >= pairs.length, 'most bad examples are caught')
passed++
console.log(`${passed} בדיקות עברו, 0 נכשלו (${CASES.length} הודעות בסט)`)
