// With HELPER running: the whole voice path in the app, with a recording in place of the microphone.
//   1. a spoken ask ("תפתח את פנקס הרשימות") is heard, runs as an instant command, and Notepad opens
//   2. dictation types the spoken words into Notepad (read back through the clipboard)
// Speech is made with Windows' Hebrew voice when it has one, else the test says so. Needs ffmpeg.
// Run: node test/voice-check.js
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const w = require('../src/win32')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
const dir = path.join(process.env.APPDATA, 'helper-desktop')
const lastAsk = () => { try { const l = fs.readFileSync(path.join(dir, 'asks.jsonl'), 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]) } catch { return null } }

/** Hebrew speech as a 16 kHz WAV, from Windows' own Hebrew voice (test/say.ps1), through ffmpeg. */
function say(text, name) {
  const raw = path.join(os.tmpdir(), name + '-raw.wav')
  const out = path.join(os.tmpdir(), name + '.wav')
  const r = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'say.ps1'), '-Text', text, '-Out', raw], { encoding: 'utf8' }).trim()
  if (r !== 'OK') return null
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-af', 'apad=pad_dur=0.4', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out])
  return out
}

;(async () => {
  const open = say('תפתח את פנקס הרשימות', 'helper-ask')
  if (!open) { console.log('SKIP: Windows has no Hebrew voice to make test speech with'); process.exit(0) }
  let ok = true

  // 1. A spoken ask.
  execFileSync(electron, [path.join(__dirname, '..'), '--ask-wav=' + open])
  await sleep(3500)
  const a = lastAsk()
  console.log('1. heard:', a && a.heard, '→', a && a.answer, `(${a && a.ms} ms after hearing)`)
  const pad = w.windows().find((x) => x.app.toLowerCase() === 'notepad')
  if (!pad) { console.log('   Notepad did not open'); ok = false }

  // 2. Dictation into it.
  // Keys go only to Notepad: before each one, Notepad must be the window in front, or the test stops.
  const notepadInFront = () => { const f = w.foreground(); return f && w.handleId(f.hwnd) === w.handleId(pad.hwnd) }
  const front = () => { const f = w.foreground(); return f ? `${f.app || '?'} "${f.title || ''}"` : 'nothing' }
  if (pad) {
    const dict = say('שלום לכולם, זה מבחן של הכתבה', 'helper-dict')
    for (let i = 0; i < 10 && !notepadInFront(); i++) { w.focus(pad.hwnd); await sleep(300) }
    if (!notepadInFront()) { console.log('STOP: Notepad is not in front (', front(), '), nothing dictated'); process.exit(1) }
    execFileSync(electron, [path.join(__dirname, '..'), '--dictate-wav=' + dict])
    await sleep(2500)
    console.log('   in front after dictating:', front())
    if (!notepadInFront()) { console.log('STOP: focus left Notepad; no keys pressed'); process.exit(1) }
    w.combo('ctrl+a'); await sleep(100)
    if (!notepadInFront()) process.exit(1)
    w.combo('ctrl+c'); await sleep(300)
    const typed = execFileSync('powershell.exe', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard'], { encoding: 'utf8' }).trim()
    console.log('2. dictated into Notepad:', typed)
    if (!/מבחן/.test(typed)) ok = false
    if (notepadInFront()) { w.combo('delete'); await sleep(100); w.close(pad.hwnd) }
  }
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})()
