// Hebrew speech to text on this PC's graphics card: whisper.cpp's server with ivrit.ai's Hebrew model, started once
// and kept loaded, so each request takes a fraction of a second. Audio never leaves the computer.
'use strict'
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const PORT = 8178
let server = null
let ready = null

function paths(root) {
  const bin = path.join(root, 'vendor', 'whisper', 'Release', 'whisper-server.exe')
  const model = path.join(root, 'vendor', 'ggml-ivrit-turbo.bin')
  return { bin, model }
}

function available(root) {
  const { bin, model } = paths(root)
  return fs.existsSync(bin) && fs.existsSync(model)
}

/** Starts the server (once) and resolves when it answers. */
function start(root, log) {
  if (ready) return ready
  const { bin, model } = paths(root)
  ready = new Promise((resolve, reject) => {
    if (!available(root)) return reject(new Error('speech engine not downloaded'))
    server = spawn(bin, ['-m', model, '-l', 'he', '--host', '127.0.0.1', '--port', String(PORT), '-nt', '--no-fallback', '-bs', '5'], {
      cwd: path.dirname(bin), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const onLine = (d) => {
      const s = d.toString()
      if (/listening at|server is listening/i.test(s)) resolve()
    }
    server.stdout.on('data', onLine)
    server.stderr.on('data', onLine)
    server.on('exit', (code) => {
      log && log('speech server exited', code)
      server = null
      ready = null
    })
    // Some builds print nothing on start: ask it directly after a moment.
    const poll = async (n) => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/`)
        if (r.status < 500) return resolve()
      } catch { /* still loading */ }
      if (n > 0) setTimeout(() => poll(n - 1), 500)
      else reject(new Error('speech server did not start'))
    }
    setTimeout(() => poll(60), 1500)
  })
  return ready
}

function stop() {
  if (server) server.kill()
  server = null
  ready = null
}

/** WAV bytes (16 kHz mono) → Hebrew text. The prompt carries names and words it should spell right. */
async function transcribe(root, wav, prompt) {
  await start(root)
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
  form.append('response_format', 'json')
  form.append('temperature', '0')
  if (prompt) form.append('prompt', prompt.slice(0, 400))
  const r = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: 'POST', body: form })
  if (!r.ok) throw new Error('speech ' + r.status)
  const j = await r.json()
  return clean(String(j.text || ''))
}

/** Whisper's habits on silence and noise, and the fillers people say. */
function clean(s) {
  let t = s.replace(/\s+/g, ' ').trim()
  if (/^\[.*\]$|^\(.*\)$/.test(t)) return ''
  if (/^(תודה(\s+רבה)?|thank you\.?|you\.?)$/i.test(t)) return ''   // whisper's "thanks" on a silent clip
  t = t.replace(/(^|\s)(אממ+|אה+|אהמ+|אמ+|כאילו,)(?=\s|$|[,.])/g, ' ').replace(/\s+/g, ' ').trim()
  return t
}

module.exports = { start, stop, transcribe, available, clean }
