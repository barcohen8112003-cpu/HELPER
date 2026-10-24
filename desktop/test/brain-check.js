// HELPER's brain path with a stand-in for Claude Code (test/fake-claude.js): starts HELPER with it, sends an ask the
// instant commands don't cover, and checks that it went to the brain, the hands ran (Calculator on the left), the
// answer came back, and the steps were learned so the same ask runs with no AI next time.
// Stops any running HELPER first. Run: node test/brain-check.js
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
const kill = () => { try { execFileSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }) } catch { } }
const ASK = 'תסדר לי את המחשבון בצד של המסך'

;(async () => {
  let ok = true
  kill()
  await sleep(800)
  const app = spawn(electron, [root], { env: Object.assign({}, process.env, { HELPER_CLAUDE_EXE: path.join(__dirname, 'fake-claude.js') }), detached: true, stdio: 'ignore' })
  app.unref()
  await sleep(6000)

  // Forget an earlier run's lesson, so this run goes to the brain.
  execFileSync(electron, [root, '--ask', 'תשכח את הקיצור ' + ASK])
  await sleep(800)

  execFileSync(electron, [root, '--ask', ASK])
  await sleep(6000)
  const a = lastAsk()
  console.log('1. route:', a && a.route, '| answer:', a && a.answer)
  if (!a || a.route !== 'claude' || !/סידרתי/.test(a.answer || '')) ok = false
  const calc = w.windows().find((x) => /מחשבון/.test(x.title))
  console.log('   Calculator:', calc ? JSON.stringify(calc.bounds) : 'not open')
  if (!calc) ok = false

  const learned = JSON.parse(fs.readFileSync(path.join(dir, 'learned.json'), 'utf8'))
  const lesson = Object.values(learned).find((l) => l.phrase === ASK)
  console.log('2. learned:', lesson ? JSON.stringify(lesson.steps) : 'no')
  if (!lesson || lesson.source !== 'claude') ok = false
  if (calc) w.close(calc.hwnd)
  await sleep(800)

  execFileSync(electron, [root, '--ask', ASK])
  await sleep(4000)
  const b = lastAsk()
  console.log('3. again: route', b && b.route, `(${b && b.ms} ms)`, '|', b && b.answer)
  if (!b || b.route !== 'learned') ok = false
  const calc2 = w.windows().find((x) => /מחשבון/.test(x.title))
  if (calc2) w.close(calc2.hwnd)

  // Back to the real Claude Code.
  kill()
  await sleep(800)
  spawn(electron, [root], { detached: true, stdio: 'ignore' }).unref()
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})()
