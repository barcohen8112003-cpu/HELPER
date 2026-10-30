// How the real Claude answers aloud: short, plain, nothing that cannot be read out loud (no markdown, links,
// brackets, arrows, emoji, bullet lists), and not stiff. Run: node test/style-check.js (Claude Code signed in).
'use strict'
const os = require('os')
const path = require('path')
const store = require('../src/store')
store.init(path.join(process.env.APPDATA, 'helper-desktop'))
const brain = require('../src/brain')

const ASKS = [
  'מה ההבדל בין RAM לזיכרון של כרטיס מסך?',
  'אני מרגיש שאני לא מספיק לעשות כלום היום',
  'כמה זה ארבע מאות שבעים ושלוש חלקי שבע?',
  'תסביר לי במשפט מה זה API',
  'מה החלונות שפתוחים אצלי עכשיו?',
  'למה השמיים כחולים?',
]
const BAD = [
  [/[*#`_]/, 'markdown'], [/https?:\/\//, 'link'], [/[\[\]{}<>→←⇒•·]/, 'symbols'], [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'emoji'],
  [/^\s*[-•\d]+[.)]\s/m, 'list'], [/(^|\s)(בטח|כמובן|אשמח לעזור|בוצע)(\s|[,.!]|$)/, 'stiff opener'], [/[A-Za-z]:\\/, 'path'],
]
;(async () => {
  let bad = 0
  for (const q of ASKS) {
    const t = Date.now()
    const r = await brain.askClaude(q, { windows: '1\tchrome\tמסך 1\tYouTube\n2\tdiscord\tמסך 2\tFriends' }, () => {})
    const a = r.text || ''
    const problems = BAD.filter(([re]) => re.test(a)).map(([, n]) => n)
    const words = a.split(/\s+/).filter(Boolean).length
    if (words > 60) problems.push('long (' + words + ' words)')
    if (problems.length) bad++
    console.log(`${problems.length ? 'BAD ' : 'ok  '} ${Date.now() - t} ms | ${q}\n      → ${a.replace(/\n/g, ' / ')}${problems.length ? '\n      !! ' + problems.join(', ') : ''}`)
  }
  console.log(bad ? `${bad} answers read like text, not like speech` : 'all answers are fit to be said aloud')
  process.exit(bad ? 1 : 0)
})()
