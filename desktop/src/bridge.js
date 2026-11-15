// The bridge to this PC: Claude Code's Remote Control (`claude remote-control`), started together with HELPER so
// the PC can be reached from the Claude app (phone, web) without opening anything by hand. It runs in the HELPER
// folder, hidden, and stops when HELPER quits. Remote Control needs a Claude plan (Pro or Max) signed in to
// Claude Code; without one it exits at once, which is logged and shown in the tray, and HELPER works as usual.
'use strict'
const { spawn } = require('child_process')

const RETRY_MS = 60 * 1000          // it dropped after running a while: start it again after a minute
const QUICK_EXIT_MS = 20 * 1000     // it ended this soon: not signed in / no plan, so no retry until HELPER restarts

let child = null
let state = 'off'                   // off | starting | on | no-plan | missing | stopped
let retry = null
let stopping = false

function start({ exe, cwd, log }) {
  if (child || stopping) return
  if (!exe) { state = 'missing'; log('bridge: Claude Code not found, not started'); return }
  state = 'starting'
  const began = Date.now()
  let out = ''
  try {
    const args = ['remote-control']
    child = /\.m?js$/i.test(exe)
      ? spawn(process.execPath, [exe, ...args], { cwd, windowsHide: true, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) })
      : spawn(exe, args, { cwd, windowsHide: true, env: process.env })
  } catch (e) {
    child = null; state = 'missing'; log('bridge: could not start:', e.message); return
  }
  const keep = (d) => { out = (out + d.toString('utf8')).slice(-2000); if (state === 'starting' && /remote control|session|ready|claude\.ai/i.test(out)) state = 'on' }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  child.on('error', (e) => { log('bridge: error', e.message) })
  child.on('close', (code) => {
    child = null
    if (stopping) { state = 'stopped'; return }
    const quick = Date.now() - began < QUICK_EXIT_MS
    log('bridge: ended, code', code, quick ? '(right away)' : '', out.replace(/\s+/g, ' ').slice(-300))
    if (quick) { state = 'no-plan'; return }
    state = 'starting'
    retry = setTimeout(() => start({ exe, cwd, log }), RETRY_MS)
  })
  setTimeout(() => { if (child && state === 'starting') state = 'on' }, 5000)
  log('bridge: started in', cwd)
}

function stop() {
  stopping = true
  clearTimeout(retry)
  if (child) { try { child.kill() } catch { } child = null }
}

module.exports = { start, stop, state: () => state }
