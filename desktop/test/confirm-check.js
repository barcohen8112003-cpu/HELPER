// With HELPER running: the "are you sure?" card that Claude must show before any send, delete or purchase.
//   Enter on it → "כן"; Esc → "לא"; and the keyboard goes back to the window that had it.
// Keys go only to HELPER's own card (checked before each press). Run: node test/confirm-check.js
'use strict'
const path = require('path')
const { spawn } = require('child_process')
const w = require('../src/win32')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hands = path.join(__dirname, '..', 'bin', 'hands.mjs')

function ask(question) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [hands, 'confirm', JSON.stringify({ question })])
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('close', () => resolve(out.trim()))
  })
}

async function answerWith(vk) {
  await sleep(500)   // the card takes a moment to come up and take the keyboard
  for (let i = 0; i < 20; i++) {
    const f = w.foreground()
    if (f && f.title === 'HELPER') { w.keys([{ vk }, { vk, up: true }]); return true }
    await sleep(150)
  }
  return false
}

;(async () => {
  // A known window in front to come back to: Notepad.
  spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref()
  let pad = null
  for (let i = 0; i < 30 && !pad; i++) { await sleep(200); pad = w.windows().find((x) => x.app.toLowerCase() === 'notepad') }
  if (!pad) { console.log('STOP: Notepad did not open'); process.exit(1) }
  w.focus(pad.hwnd)
  await sleep(400)
  const before = w.foreground()
  const yes = ask('בדיקה: לאשר?')
  if (!(await answerWith(0x0D))) { console.log('STOP: the card did not come up; no key pressed'); process.exit(1) }
  const a = await yes
  await sleep(600)
  const no = ask('בדיקה: לבטל?')
  if (!(await answerWith(0x1B))) { console.log('STOP: the card did not come up'); process.exit(1) }
  const b = await no
  await sleep(600)
  const after = w.foreground()
  const back = before && after && w.handleId(before.hwnd) === w.handleId(after.hwnd)
  console.log('Enter →', a, '| Esc →', b, '| before:', before && before.app + ' "' + before.title + '"', '| after:', after && after.app + ' "' + after.title + '"', back ? '(same)' : '(changed!)')
  w.close(pad.hwnd)
  const ok = a === 'כן' && b === 'לא' && back
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})()
