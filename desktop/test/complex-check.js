// Complex asks, end to end through the running app and the real Claude Code, each checked on the windows themselves
// (Calculator and Notepad only; nothing else is touched). Reports the answer, how long it took and whether the
// windows ended up where asked. Run: node test/complex-check.js [--only=N]
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const w = require('../src/win32')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const root = path.join(__dirname, '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const dir = path.join(process.env.APPDATA, 'helper-desktop')
const lastAsk = () => { try { const l = fs.readFileSync(path.join(dir, 'asks.jsonl'), 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]) } catch { return null } }
const find = (re) => w.windows().find((x) => re.test(x.title))
const closeAll = async () => { for (const re of [/מחשבון|Calculator/, /פנקס רשימות|Notepad/]) { for (let i = 0; i < 3; i++) { const x = find(re); if (x) { w.close(x.hwnd); await sleep(400) } } } }

// The first screen is at x 0..1920 (the primary). A window is "on the other screen" when it is not there.
const calc = () => find(/מחשבון|Calculator/)
const pad = () => find(/פנקס רשימות|Notepad/)
const primary = (x) => x.bounds.x + x.bounds.width / 2 >= 0 && x.bounds.x + x.bounds.width / 2 < 1920
const isLeft = (x) => x.bounds.width < 1100 && x.bounds.height > 800 && x.bounds.x % 1920 === 0
const isRight = (x) => x.bounds.width < 1100 && x.bounds.height > 800 && x.bounds.x % 1920 > 800
const isTop = (x) => x.bounds.height < 700 && x.bounds.width > 1500 && x.bounds.y < 50
const isBottom = (x) => x.bounds.height < 700 && x.bounds.width > 1500 && x.bounds.y > 400

const CASES = [
  ['two windows, two sides', 'תפתח את המחשבון ופנקס רשימות, המחשבון בצד שמאל ופנקס הרשימות בצד ימין', async () => calc() && pad() && isLeft(calc()) && isRight(pad())],
  ['to the other screen', 'תעביר את המחשבון למסך השני', async () => calc() && !primary(calc())],
  ['three steps, one sentence', 'תחזיר את המחשבון למסך הראשון ותשים אותו למעלה, ופנקס רשימות למטה', async () => calc() && pad() && primary(calc()) && isTop(calc()) && isBottom(pad())],
  ['close what was opened', 'תסגור את כל מה שפתחת עכשיו', async () => !calc() && !pad()],
]

;(async () => {
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7)
  let ok = 0, total = 0
  for (let i = 0; i < CASES.length; i++) {
    if (only && String(i + 1) !== only) continue
    const [name, ask, verify] = CASES[i]
    if (i === 0) await closeAll()
    const before = fs.readFileSync(path.join(dir, 'asks.jsonl'), 'utf8').trim().split('\n').length
    const t0 = Date.now()
    execFileSync(electron, [root, '--ask', ask])
    let a = null
    for (let k = 0; k < 120 && !a; k++) { await sleep(500); const l = lastAsk(); if (l && l.heard === ask && fs.readFileSync(path.join(dir, 'asks.jsonl'), 'utf8').trim().split('\n').length > before) a = l }
    const ms = Date.now() - t0
    await sleep(800)
    let good = false
    try { good = a ? await verify() : false } catch (e) { console.log('verify error', e.message) }
    total++; if (good) ok++
    console.log(`${good ? 'PASS' : 'FAIL'} ${String(i + 1)}. ${name}: ${ms} ms, route ${a && a.route} → ${a && a.answer}`)
  }
  await closeAll()
  console.log(`${ok}/${total}`)
  process.exit(ok === total ? 0 : 1)
})()
