// The private voice, for spoken WhatsApp messages (src/wa-announce.js). Unlike voice.js (HELPER's answers, which
// tries the cloud voice first and keeps a cache of mp3 files), this:
// - never calls the cloud (no HELPER server, no ElevenLabs),
// - never caches and never writes a file,
// - never puts the text on a command line (other programs and Windows' process auditing can read command lines):
//   the text goes in on stdin and the audio comes back on stdout.
// 'windows' (the default): Microsoft Asaf, Windows' own Hebrew voice, on this PC only (say-stdin.ps1).
// 'edge': edge-tts, which sends the text to Microsoft's online speech service. The owner's choice in the tray; nothing
// goes to HELPER's server either way.
'use strict'
const path = require('path')
const childProcess = require('child_process')
const config = require('./config')

const MAX = 400
const TIMEOUT_MS = 20000
const SCRIPT = path.join(__dirname, 'say-stdin.ps1')

function runPiped(spawn, cmd, args, input, ms) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }) } catch { return resolve(null) }
    const chunks = []
    let size = 0, done = false
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); chunks.length = 0; resolve(v) }
    const timer = setTimeout(() => { try { child.kill() } catch { } finish(null) }, ms)
    child.stdout.on('data', (d) => {
      size += d.length
      if (size > 20e6) { try { child.kill() } catch { } return finish(null) }
      chunks.push(d)
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks) : null))
    try { child.stdin.on('error', () => { }); child.stdin.end(Buffer.from(input, 'utf8')) } catch { finish(null) }
  })
}

/**
 * One spoken line → {b64, mime} or null. opts: { voice: 'windows'|'edge', spawn (tests) }.
 * Fails quiet: null, and the caller says nothing (no fallback to the cloud).
 */
async function privateOf(text, opts = {}) {
  const say = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX)
  if (!say) return null
  const spawn = opts.spawn || childProcess.spawn
  if (opts.voice === 'edge') {
    const voice = /[֐-׿]/.test(say) ? (config.edgeVoice || 'he-IL-HilaNeural') : 'en-US-AriaNeural'
    // No --write-media: the mp3 comes back on stdout. "--file -": the text is read from stdin.
    const mp3 = await runPiped(spawn, 'edge-tts', ['--voice', voice, '--rate', config.edgeRate || '+0%', '--file', '-'], say, TIMEOUT_MS)
    return mp3 && mp3.length > 500 ? { b64: mp3.toString('base64'), mime: 'audio/mpeg' } : null
  }
  const out = await runPiped(spawn, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], say, TIMEOUT_MS)
  const b64 = out ? out.toString('utf8').trim() : ''
  if (!b64 || b64 === 'NOVOICE' || b64.length < 600 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null
  return { b64, mime: 'audio/wav' }
}

module.exports = { privateOf, SCRIPT }
