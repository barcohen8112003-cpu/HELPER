// Repeated use, without touching the screen or keyboard: the real Claude Code answers several questions in a row,
// the speech engine transcribes the same Hebrew several times, and HELPER on the cloud answers. Needs HELPER running
// (its speech server), Claude Code signed in and connect.ps1 done. Run: node test/repeat-check.js
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const store = require('../src/store')
store.init(path.join(process.env.APPDATA, 'helper-desktop'))
const brain = require('../src/brain')
const speech = require('../src/speech')

;(async () => {
  let ok = true
  const qs = [['מה בירת צרפת? מילה אחת', /פריז/], ['כמה זה 17 כפול 3? רק המספר', /51/], ['באיזו שפה מדברים בברזיל? מילה אחת', /פורטוגזית/], ['מה הצבע של השמיים ביום בהיר? מילה אחת', /כחול/]]
  for (const [q, want] of qs) {
    const t = Date.now()
    const r = await brain.askClaude(q, {}, () => {})
    const good = r.ok && want.test(r.text)
    if (!good) ok = false
    console.log(`claude ${good ? 'ok ' : 'BAD'} ${Date.now() - t} ms: ${q} → ${r.text}`)
  }
  const wav = path.join(os.tmpdir(), 'helper-repeat.wav')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(__dirname, '..', '..', 'voice-v4-turbo-sample.mp3'), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
  const bytes = fs.readFileSync(wav)
  const times = []
  for (let i = 0; i < 5; i++) {
    const t = Date.now()
    const text = await speech.transcribe(path.join(__dirname, '..'), bytes, 'HELPER')
    times.push(Date.now() - t)
    if (!/התכוונת/.test(text)) { ok = false; console.log('speech BAD:', text) }
  }
  console.log('speech 5/5 same text, ms:', times.join(', '))
  for (let i = 0; i < 2; i++) {
    const t = Date.now()
    try {
      const h = await brain.askHelper('בדיקה מהמחשב: תענה רק במילה מחובר')
      console.log(`cloud ok ${Date.now() - t} ms → ${h.reply}`)
      if (!h.reply) ok = false
    } catch (e) { ok = false; console.log('cloud BAD:', e.message) }
  }
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})()
