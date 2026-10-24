// With HELPER running: Ctrl+Alt+P opens the pointing layer, a click on it marks the spot (the click never reaches
// the app underneath), the next ask carries the mark, and Esc clears it. Clicks only when HELPER's layer is in front.
// Run: node test/point-check.js
'use strict'
const fs = require('fs')
const path = require('path')
const w = require('../src/win32')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = path.join(process.env.APPDATA, 'helper-desktop')
const logText = () => fs.readFileSync(path.join(dir, 'app.log'), 'utf8')
const VK = { ctrl: 0xA2, alt: 0xA4, p: 0x50, esc: 0x1B }

;(async () => {
  const before = logText().length
  w.keys([{ vk: VK.ctrl }, { vk: VK.alt }, { vk: VK.p }, { vk: VK.p, up: true }, { vk: VK.alt, up: true }, { vk: VK.ctrl, up: true }])
  await sleep(800)
  const f = w.foreground()
  console.log('in front:', f && `${f.app || '?'} "${f.title}"`)
  if (!f || f.title !== 'HELPER') { console.log('STOP: the pointing layer is not in front; no click'); process.exit(1) }
  const c = w.cursor()
  w.click(c.x, c.y)
  await sleep(1500)
  const after = logText().slice(before)
  const m = after.match(/mark (\{.*\})/)
  console.log('mark:', m ? m[1] : 'none')
  // Esc clears it.
  w.keys([{ vk: VK.esc }, { vk: VK.esc, up: true }])
  await sleep(400)
  console.log(m ? 'PASS' : 'FAIL')
  process.exit(m ? 0 : 1)
})()
