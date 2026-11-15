// Runs wa-toasts.ps1 (Windows' notification list, WhatsApp's notifications only) and hands each new one to the
// announcer. The lines are parsed and passed on; nothing here writes them anywhere, and the worker's stderr is
// dropped. A worker that stops is started again (2 s, then slower, up to a minute) while listening is on.
'use strict'
const path = require('path')
const childProcess = require('child_process')

const SCRIPT = path.join(__dirname, 'wa-toasts.ps1')

/**
 * opts: { onToast({id, at, lines, running}), onAccess(status), onReady(), log(code), spawn? (tests) }
 * log gets codes only ("wa: worker-exit 3"), never notification text.
 */
function createListener(opts) {
  const spawn = opts.spawn || childProcess.spawn
  const log = opts.log || (() => { })
  let child = null, buf = '', on = false, retry = null, wait = 2000

  function line(raw) {
    let msg
    try { msg = JSON.parse(raw.replace(/^﻿/, '')) } catch { return }
    if (!msg || typeof msg !== 'object') return
    if (msg.op === 'toast') {
      wait = 2000
      const lines = Array.isArray(msg.lines) ? msg.lines.map((l) => String(l == null ? '' : l)) : typeof msg.lines === 'string' ? [msg.lines] : []
      try { opts.onToast && opts.onToast({ id: String(msg.id), at: Number(msg.at), lines, running: msg.running !== false }) } catch { log('wa: announce-error') }
    } else if (msg.op === 'access') {
      try { opts.onAccess && opts.onAccess(String(msg.status || 'Error')) } catch { }
    } else if (msg.op === 'ready') {
      try { opts.onReady && opts.onReady() } catch { }
    } else if (msg.op === 'error') {
      log('wa: ' + String(msg.code || 'error').replace(/[^a-z-]/g, '').slice(0, 20))
    }
  }

  function startWorker() {
    buf = ''
    const me = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', SCRIPT], { windowsHide: true })
    child = me
    me.stdout.setEncoding('utf8')
    me.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (l) line(l)
      }
      if (buf.length > 1e6) buf = ''   // a line that never ends is not kept
    })
    if (me.stderr) me.stderr.on('data', () => { })
    me.on('error', () => log('wa: worker-error'))
    me.on('exit', (code) => {
      if (child === me) child = null
      buf = ''
      if (!on) return
      log('wa: worker-exit ' + (Number.isFinite(code) ? code : ''))
      clearTimeout(retry)
      retry = setTimeout(() => { if (on && !child) startWorker() }, wait)
      wait = Math.min(60000, wait * 2)
    })
  }

  return {
    start() { if (on) return; on = true; wait = 2000; startWorker() },
    stop() {
      on = false
      clearTimeout(retry)
      buf = ''
      if (child) { try { child.kill() } catch { } child = null }
    },
    running: () => on,
    _line: line,
  }
}

module.exports = { createListener, SCRIPT }
