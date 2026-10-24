// With HELPER running and Claude Code signed in: reading the screen and pointing, for real.
// Notepad is opened with known text and maximized on the screen with the mouse, so the screenshot shows only it.
//   1. "מה כתוב על המסך?" → the answer has the text
//   2. "איפה כתובה המילה בננה?" → a ring is put on the screen
// Keys go only to Notepad (checked before each). Run: node test/screen-check.js
'use strict'
const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const w = require('../src/win32')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const root = path.join(__dirname, '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const dir = path.join(process.env.APPDATA, 'helper-desktop')
const lastAsk = () => { try { const l = fs.readFileSync(path.join(dir, 'asks.jsonl'), 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]) } catch { return null } }
const logText = () => fs.readFileSync(path.join(dir, 'app.log'), 'utf8')

async function ask(text, waitMs = 60000) {
  execFileSync(electron, [root, '--ask', text])
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    await sleep(500)
    const a = lastAsk()
    if (a && a.heard === text && Date.parse(a.at) > Date.now() - waitMs) return a
  }
  return null
}

;(async () => {
  spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref()
  let pad = null
  for (let i = 0; i < 30 && !pad; i++) { await sleep(200); pad = w.windows().find((x) => x.app.toLowerCase() === 'notepad') }
  if (!pad) { console.log('STOP: no Notepad'); process.exit(1) }
  const inFront = () => { const f = w.foreground(); return f && w.handleId(f.hwnd) === w.handleId(pad.hwnd) }
  for (let i = 0; i < 10 && !inFront(); i++) { w.focus(pad.hwnd); await sleep(300) }
  if (!inFront()) { console.log('STOP: Notepad not in front; nothing typed'); process.exit(1) }
  w.maximize(pad.hwnd)
  await sleep(400)
  if (!inFront()) process.exit(1)
  w.combo('ctrl+a'); w.combo('delete')
  await w.typeSteady('רשימת קניות: חלב, לחם, בננה, ותפוחים')
  await sleep(500)

  let ok = true
  const a = await ask('מה כתוב על המסך?')
  console.log('1. route:', a && a.route, `(${a && a.ms} ms) →`, a && a.answer)
  if (!a || a.route !== 'claude' || !/חלב|לחם|בננה|קניות/.test(a.answer || '')) ok = false

  const before = logText().length
  const b = await ask('איפה כתובה המילה בננה?')
  const pointed = logText().slice(before).match(/point (\{.*\})/)
  console.log('2. route:', b && b.route, `(${b && b.ms} ms) →`, b && b.answer, '| ring:', pointed ? pointed[1] : 'none')
  if (!b || !pointed) ok = false

  for (let i = 0; i < 10 && !inFront(); i++) { w.focus(pad.hwnd); await sleep(300) }
  if (inFront()) { w.combo('ctrl+a'); w.combo('delete'); await sleep(150); w.close(pad.hwnd) }
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})()
