// Inside-a-window actions, live on this PC: Calculator and Notepad only (nothing else is touched). Opens them, presses
// buttons by their names, writes in a document, reads it back, finds a menu, and closes them without saving.
// Run: node test/inwindow-check.js
'use strict'
const Module = require('module')
const { execFile } = require('child_process')

// The hands outside Electron: the two things they take from it, stood in for (the clipboard is the real one, since
// Ctrl+V pastes from it).
const { execFileSync } = require('child_process')
const ps = (cmd, input) => execFileSync('powershell.exe', ['-NoProfile', '-Command', '[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + cmd], { input, encoding: 'utf8', windowsHide: true })
const realClipboard = {
  readText: () => ps('Get-Clipboard -Raw').replace(/\r?\n$/, ''),
  writeText: (t) => { ps('Set-Clipboard -Value ([Console]::In.ReadToEnd())', String(t) || ' ') },
}
const load = Module._load
Module._load = function (req, ...rest) {
  if (req === 'electron') return { shell: { openExternal: async () => { }, openPath: async () => { } }, clipboard: realClipboard }
  return load.call(this, req, ...rest)
}
const hands = require('../src/hands')
const uia = require('../src/uia')
const w = require('../src/win32')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const find = (re) => w.windows().find((x) => re.test(x.title))
const CALC = /^(מחשבון|Calculator)$/
const notepad = require('./notepad-tab')

let ok = 0, total = 0
async function step(name, fn) {
  total++
  const t0 = Date.now()
  try {
    const out = await fn()
    ok++
    console.log(`PASS ${name} (${Date.now() - t0} ms)${out ? ': ' + String(out).split('\n')[0].slice(0, 90) : ''}`)
  } catch (e) {
    console.log(`FAIL ${name} (${Date.now() - t0} ms): ${e.message}`)
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg) }

async function waitFor(re, ms = 8000) {
  const until = Date.now() + ms
  while (Date.now() < until) { const x = find(re); if (x) return x; await sleep(250) }
  return null
}

;(async () => {
  const t0 = Date.now()
  await uia.warm()
  console.log(`worker up in ${Date.now() - t0} ms`)

  // ---- Calculator: 7 + 8 = 15, by pressing the buttons by name, in Hebrew words.
  if (!find(CALC)) execFile('calc.exe')
  const calc = await waitFor(CALC)
  expect(calc, 'Calculator did not open')
  await sleep(1200)
  await step('look inside Calculator', async () => {
    const out = await hands.run({ cmd: 'look', args: { window: calc.title } })
    expect(/כפתור/.test(out), 'no buttons seen')
    return out.split('\n').length + ' lines'
  })
  await step('press digits and operators by spoken names (7 + 8 =)', async () => {
    await hands.run({ cmd: 'press', args: { window: calc.title, target: 'נקה' } }).catch(() => { })
    const lines = await hands.runAll([
      { cmd: 'press', args: { window: calc.title, target: 'שבע' } },
      { cmd: 'press', args: { window: calc.title, target: 'פלוס' } },
      { cmd: 'press', args: { window: calc.title, target: '8' } },
      { cmd: 'press', args: { window: calc.title, target: 'שווה' } },
    ])
    await sleep(300)
    const shown = (await uia.list(calc.hwnd, { types: ['Text'] })).find((x) => /CalculatorResults/.test(x.id))
    expect(shown, 'no display found')
    expect(/15/.test(shown.name), 'display says: ' + shown.name)
    return lines.join(' · ') + ' → ' + shown.name
  })
  await step('press the same button several times (times: 3)', async () => {
    await hands.run({ cmd: 'press', args: { window: calc.title, target: 'נקה' } })
    await hands.run({ cmd: 'press', args: { window: calc.title, target: '1', times: 3 } })
    await sleep(200)
    const shown = (await uia.list(calc.hwnd, { types: ['Text'] })).find((x) => /CalculatorResults/.test(x.id))
    expect(/111/.test(shown.name), 'display says: ' + shown.name)
    return shown.name
  })
  await step('a name that is not there fails in words the router sends to the brain', async () => {
    try { await hands.run({ cmd: 'press', args: { window: calc.title, target: 'בננה' } }) } catch (e) { expect(/^לא מצאתי/.test(e.message), e.message); return e.message }
    throw new Error('pressed something for "בננה"')
  })

  // ---- Notepad, in a fresh Untitled tab only: write by window name, read it back, open a menu by name.
  await notepad.freshTab()
  const PAD = notepad.PAD
  const marker = 'שלום מ-HELPER ' + Date.now()
  await step('write in Notepad by its name ("תכתוב בפנקס רשימות ...")', async () => {
    const said = await hands.run({ cmd: 'write', args: { phrase: 'פנקס רשימות ' + marker } })
    await sleep(300)
    const text = await uia.read(find(PAD).hwnd)
    expect(text.includes(marker), 'Notepad shows: ' + text.slice(0, 120))
    return said
  })
  await step('a long text goes in by paste, and the clipboard comes back', async () => {
    const saved = realClipboard.readText()
    realClipboard.writeText('before')
    const long = ' ' + 'שורה ארוכה של טקסט '.repeat(8)
    await hands.run({ cmd: 'fill', args: { window: find(PAD).id, text: long } })
    await sleep(400)
    const text = await uia.read(find(PAD).hwnd)
    expect(text.includes('שורה ארוכה של טקסט שורה ארוכה'), 'not pasted')
    const after = realClipboard.readText()
    realClipboard.writeText(saved)
    expect(after === 'before', 'clipboard not restored: ' + after.slice(0, 30))
    return 'pasted ' + long.length + ' chars'
  })
  await step('read what the window shows', async () => {
    const out = await hands.run({ cmd: 'read', args: { window: find(PAD).id } })
    expect(out.includes(marker), 'read missed the text')
    return out.split('\n')[0]
  })
  await step('steps inside one window ("in"): select all, delete', async () => {
    const out = await hands.run({ cmd: 'in', args: { window: find(PAD).id, steps: [{ cmd: 'key', args: { keys: 'ctrl+a' } }, { cmd: 'key', args: { keys: 'delete' } }] } })
    await sleep(300)
    const text = await uia.read(find(PAD).hwnd)
    expect(!text.includes(marker), 'still there')
    return out
  })
  await step('a menu by name (קובץ / File)', async () => {
    const out = await hands.run({ cmd: 'press', args: { window: find(PAD).id, target: 'קובץ' } })
    await sleep(500)
    w.combo('esc')
    return out
  })

  // ---- Clean up: Calculator closes; only our Notepad tab is emptied and closed.
  const c = find(CALC); if (c) w.close(c.hwnd)
  await notepad.closeTab()
  uia.stop()
  console.log(`${ok}/${total}`)
  process.exit(ok === total ? 0 : 1)
})()
