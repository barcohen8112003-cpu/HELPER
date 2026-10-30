// Tasks inside windows that are already open, end to end through the running app (instant commands and the real
// Claude Code), each checked on the windows themselves. Calculator and Notepad only; both are closed at the end
// without saving. Run (with HELPER running): node test/inwindow-flow-check.js [--only=N]
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync, execFile } = require('child_process')
const w = require('../src/win32')
const uia = require('../src/uia')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const root = path.join(__dirname, '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const dir = path.join(process.env.APPDATA, 'helper-desktop')
const asks = () => { try { return fs.readFileSync(path.join(dir, 'asks.jsonl'), 'utf8').trim().split('\n') } catch { return [] } }
const find = (re) => w.windows().find((x) => re.test(x.title))
const CALC = /^(מחשבון|Calculator)$/
const notepad = require('./notepad-tab')
const PAD = notepad.PAD
const display = async () => {
  const c = find(CALC)
  if (!c) return ''
  const d = (await uia.list(c.hwnd, { types: ['Text'] })).find((x) => /CalculatorResults/.test(x.id))
  return d ? d.name : ''
}
let seen = ''
const padText = async () => { const p = find(PAD); return p ? uia.read(p.hwnd) : '' }

async function closeAll() {
  const c = find(CALC); if (c) w.close(c.hwnd)
  await notepad.closeTab(['קניות לשבת'])
}

const CASES = [
  ['instant: write in Notepad by its name', () => notepad.freshTab(),
    'תכתוב בפנקס רשימות קניות לשבת', async () => (await padText()).includes('קניות לשבת')],
  ['brain: open Calculator and work it out in it', null,
    'תפתח את המחשבון ותחשב בו שבע כפול שש', async () => /42/.test(await display())],
  ['brain: from one window into another', null,
    'תכתוב בפנקס רשימות את התוצאה שמופיעה עכשיו במחשבון', async () => { const t = await padText(); seen = t; return t.split('\n').some((l) => l.trim() === '42') }],
  ['brain: a question about a window only reads it', null,
    'מה כתוב בפנקס רשימות?', async (a) => /קניות/.test(a.answer || '') && (await padText()) === seen],
]

;(async () => {
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7)
  const c0 = find(CALC); if (c0) w.close(c0.hwnd)
  let ok = 0, total = 0
  for (let i = 0; i < CASES.length; i++) {
    if (only && String(i + 1) !== only) continue
    const [name, before, ask, verify] = CASES[i]
    if (before) await before()
    const n0 = asks().length
    const t0 = Date.now()
    execFileSync(electron, [root, '--ask', ask])
    let a = null
    for (let k = 0; k < 360 && !a; k++) {
      await sleep(500)
      const l = asks()
      if (l.length > n0) { try { const last = JSON.parse(l[l.length - 1]); if (last.heard === ask) a = last } catch { } }
    }
    const ms = Date.now() - t0
    await sleep(800)
    let good = false
    try { good = a ? await verify(a) : false } catch (e) { console.log('verify error', e.message) }
    total++; if (good) ok++
    console.log(`${good ? 'PASS' : 'FAIL'} ${i + 1}. ${name}: ${ms} ms, route ${a && a.route} → ${a && a.answer}`)
  }
  await closeAll()
  uia.stop()
  console.log(`${ok}/${total}`)
  process.exit(ok === total ? 0 : 1)
})()
