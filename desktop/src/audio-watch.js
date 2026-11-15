// Is music playing on this PC, and how loud is it right now? For the avatar only (off by default: tray "אווטאר על
// המסך" → "לרקוד לכל מוזיקה במחשב"). One PowerShell worker (audio-watch.ps1) kept running while the setting is on:
//   - Windows' "now playing" list (GSMTC): only whether some app is playing. Never the song, artist or picture.
//   - Windows' own peak meter on the speakers: one number 0..1, the one the volume mixer shows. No audio is captured.
// The worker prints two kinds of line and nothing else: {"p":0|1} when playing changes, {"l":0.42} while asked for
// levels. Anything else it prints is dropped unread. Levels are never logged or kept; app.log only hears
// started / stopped / restarted. No Electron here: tests run it in Node with a fake worker.
'use strict'
const path = require('path')

const SCRIPT = path.join(__dirname, 'audio-watch.ps1')
const MIN_WAIT = 2000
const MAX_WAIT = 5 * 60000
const STEADY_MS = 60000          // a worker that ran this long resets the backoff
const MAX_LINE = 32
const RATES = Object.freeze([0, 30])
// The only two shapes a line may have: {"p":0|1} and {"l":<0..1, up to 3 decimals>}.
const LINE = /^\{"p":[01]\}$|^\{"l":[01](\.\d{1,3})?\}$/

/** One line from the worker: { playing } or { level }, or null for anything else. */
function parseLine(line) {
  if (typeof line !== 'string') return null
  const s = line.replace(/^﻿/, '').trim()
  if (!s || s.length > MAX_LINE || !LINE.test(s)) return null
  let o
  try { o = JSON.parse(s) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const keys = Object.keys(o)
  if (keys.length !== 1) return null
  if (keys[0] === 'p') return o.p === 0 || o.p === 1 ? { playing: o.p === 1 } : null
  if (keys[0] === 'l') return typeof o.l === 'number' && Number.isFinite(o.l) && o.l >= 0 && o.l <= 1 ? { level: o.l } : null
  return null
}

/** The ignore list as one stdin line: app ids, lowercase, letters/digits/._- only, comma separated. */
function ignoreLine(list) {
  const ids = (Array.isArray(list) ? list : [])
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim().toLowerCase().replace(/[^a-z0-9._-]/g, ''))
    .filter((x) => x.length >= 2 && x.length <= 64)
    .slice(0, 20)
  return 'ignore ' + ids.join(',')
}

function defaultSpawn() {
  const { spawn } = require('child_process')
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true })
}

/**
 * onPlaying(bool): some app started / stopped playing. onLevel(number): one peak reading, only while rate(30).
 * spawnImpl / setTimer / now are for the tests.
 */
function createAudioWatch({ onPlaying = () => {}, onLevel = () => {}, log = () => {}, ignore = [], spawnImpl = defaultSpawn, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() } = {}) {
  let child = null, buf = '', wanted = false, hz = 0, wait = MIN_WAIT, startedAt = null, retry = null, restarts = 0
  let ignoreIds = ignore
  let playing = false

  function tell(line) {
    if (!child || !child.stdin) return
    try { child.stdin.write(line + '\n', 'utf8') } catch { /* gone; exit handles it */ }
  }

  function setPlaying(on) {
    if (on === playing) return
    playing = on
    try { onPlaying(on) } catch { }
  }

  function onData(d) {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = parseLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (!msg) continue
      if ('playing' in msg) setPlaying(msg.playing)
      else if (hz > 0) { try { onLevel(msg.level) } catch { } }
    }
    if (buf.length > MAX_LINE * 4) buf = ''   // a worker gone wrong can't make us hold its output
  }

  function launch() {
    retry = null
    if (!wanted || child) return
    let me
    try { me = spawnImpl() } catch { me = null }
    if (!me) { schedule(); return }
    child = me
    buf = ''
    startedAt = now()
    if (me.stdout) { if (me.stdout.setEncoding) me.stdout.setEncoding('utf8'); me.stdout.on('data', onData) }
    if (me.stderr) me.stderr.on('data', () => { })   // never read: it could only hold an error from Windows
    if (me.stdin && me.stdin.on) me.stdin.on('error', () => { })
    me.on('exit', () => {
      if (child !== me) return
      child = null
      setPlaying(false)
      if (!wanted) return
      restarts++
      log('audio watch stopped, restarting (' + restarts + ')')
      schedule()
    })
    me.on('error', () => { })
    tell(ignoreLine(ignoreIds))
    tell('rate ' + hz)
    log('audio watch started')
  }

  function schedule() {
    if (!wanted || retry) return
    if (startedAt != null && now() - startedAt >= STEADY_MS) wait = MIN_WAIT
    const ms = wait
    wait = Math.min(MAX_WAIT, wait * 2)
    retry = setTimer(launch, ms)
  }

  function start() { wanted = true; if (!child && !retry) launch() }

  function stop() {
    wanted = false
    if (retry) { clearTimer(retry); retry = null }
    const c = child
    if (c) tell('quit')
    child = null
    if (c) {
      try { c.stdin && c.stdin.end() } catch { }
      try { c.kill() } catch { }
      log('audio watch stopped')
    }
    wait = MIN_WAIT
    setPlaying(false)
  }

  /** 30: levels about 30 times a second (only while the avatar dances), 0: no levels at all. */
  function rate(n) {
    const want = RATES.includes(n) ? n : 0
    if (want === hz) return
    hz = want
    tell('rate ' + hz)
  }

  function setIgnore(list) { ignoreIds = list; tell(ignoreLine(list)) }

  return { start, stop, rate, setIgnore, running: () => Boolean(child), playing: () => playing, _state: () => ({ wait, restarts, hz }) }
}

module.exports = { createAudioWatch, parseLine, ignoreLine, SCRIPT, MIN_WAIT, MAX_WAIT, STEADY_MS, MAX_LINE }
