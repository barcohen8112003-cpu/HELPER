// With HELPER running: presses its keys the way a keyboard would (system-wide input) and reads what it did.
//   1. a tap of Ctrl+Alt+Space opens the typing box; typing an ask and Enter runs it
//   2. holding Ctrl+Alt+Space records (silence here) and gives up quietly
//   3. holding Right Ctrl starts dictation and lets go quietly on silence
// Run: node test/hotkey-check.js
'use strict'
const fs = require('fs')
const path = require('path')
const w = require('../src/win32')
// What a real keyboard sends: left Ctrl and left Alt specifically (the hook does not see the generic codes).
const VK = { ctrl: 0xA2, alt: 0xA4, space: 0x20, rctrl: 0xA3, enter: 0x0D }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = path.join(process.env.APPDATA, 'helper-desktop')
const lastAsk = () => {
  try {
    const lines = fs.readFileSync(path.join(dir, 'asks.jsonl'), 'utf8').trim().split('\n')
    return JSON.parse(lines[lines.length - 1])
  } catch { return null }
}
const appLog = () => fs.readFileSync(path.join(dir, 'app.log'), 'utf8')

;(async () => {
  let ok = true
  const before = appLog().length

  // 1. Tap → type → Enter.
  w.keys([{ vk: VK.ctrl }, { vk: VK.alt }, { vk: VK.space }])
  await sleep(120)
  w.keys([{ vk: VK.space, up: true }, { vk: VK.alt, up: true }, { vk: VK.ctrl, up: true }])
  await sleep(600)
  const fg = w.foreground()
  console.log('after tap, in front:', fg && fg.app)
  // Type only into HELPER's own box: anything else in front would receive the keys.
  if (!fg || !(/electron|helper/i.test(fg.app || '') || (fg.title || '') === 'HELPER')) {
    console.log('FAIL: the typing box did not open; nothing typed')
    process.exit(1)
  }
  w.type('מה השעה')
  await sleep(150)
  w.keys([{ vk: VK.enter }, { vk: VK.enter, up: true }])
  await sleep(800)
  const a = lastAsk()
  console.log('1. typed ask:', a && a.heard, '→', a && a.answer)
  if (!a || a.heard !== 'מה השעה' || !/השעה/.test(a.answer || '')) ok = false

  // 2. Hold to talk (silence).
  await sleep(1500)
  w.keys([{ vk: VK.ctrl }, { vk: VK.alt }, { vk: VK.space }])
  await sleep(1400)
  w.keys([{ vk: VK.space, up: true }, { vk: VK.alt, up: true }, { vk: VK.ctrl, up: true }])
  await sleep(2500)
  const b = lastAsk()
  console.log('2. hold to talk, last ask now:', b && b.heard)

  // 3. Hold Right Ctrl (silence).
  w.keys([{ vk: VK.rctrl }])
  await sleep(1200)
  w.keys([{ vk: VK.rctrl, up: true }])
  await sleep(2000)

  const errors = appLog().slice(before).split('\n').filter((l) => /\[(bubble|pill)\]|failed|error/i.test(l))
  console.log('errors in the log:', errors.length ? '\n' + errors.join('\n') : 'none')
  if (errors.length) ok = false
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})()
