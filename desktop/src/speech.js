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
  ready = new Promise(async (resolve, reject) => {
    if (!available(root)) return reject(new Error('speech engine not downloaded'))
    // One already listening (left by a run that crashed, or a second copy of the app): use it.
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(800) })
      if (r.status < 500) return resolve()
    } catch { /* none: start ours */ }
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

/** The format and where the samples start in a WAV (chunks may come in any order), or null unless 16-bit mono PCM. */
function wavInfo(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null
  let at = 12, fmt = null
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4)
    const size = wav.readUInt32LE(at + 4)
    if (id === 'fmt ') fmt = { tag: wav.readUInt16LE(at + 8), channels: wav.readUInt16LE(at + 10), rate: wav.readUInt32LE(at + 12), bits: wav.readUInt16LE(at + 22) }
    if (id === 'data') {
      if (!fmt || fmt.tag !== 1 || fmt.channels !== 1 || fmt.bits !== 16) return null
      return { rate: fmt.rate, dataAt: at + 8, dataLength: Math.min(size, wav.length - at - 8) }
    }
    at += 8 + size + (size % 2)
  }
  return null
}

/**
 * The audio made ready for the model: the DC offset out, low rumble out (a high-pass at about 100 Hz), the level brought
 * to a steady loudness (a quiet microphone or a voice changer's output is often a tenth of full scale, where
 * the model guesses), and the silence around the words trimmed (it invites made-up words). 16 kHz mono 16-bit WAV in
 * and out; anything else is returned as it is.
 */
function prepare(wav) {
  const info = wavInfo(wav)
  if (!info) return wav
  const base = info.dataAt
  const n = Math.floor(info.dataLength / 2)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = wav.readInt16LE(base + i * 2) / 32768
  // DC offset and a one-pole high-pass (about 100 Hz at 16 kHz).
  let mean = 0
  for (let i = 0; i < n; i++) mean += x[i]
  mean /= Math.max(1, n)
  const a = 0.96
  let py = 0, px = 0
  for (let i = 0; i < n; i++) { const v = x[i] - mean; py = a * (py + v - px); px = v; x[i] = py }
  // Where the speech is: 20 ms frames above a threshold set from the loudest frames and the noise floor.
  const frame = 320
  const rms = []
  for (let i = 0; i + frame <= n; i += frame) { let sum = 0; for (let j = i; j < i + frame; j++) sum += x[j] * x[j]; rms.push(Math.sqrt(sum / frame)) }
  if (!rms.length) return wav
  const sorted = rms.slice().sort((p, q) => p - q)
  const floor = sorted[Math.floor(sorted.length * 0.1)]
  const top = sorted[Math.floor(sorted.length * 0.95)]
  if (top < 0.002) return wav   // nothing in it: not made louder (that would only be noise)
  const threshold = Math.max(floor * 3, top * 0.12)
  let first = rms.findIndex((v) => v > threshold)
  let last = rms.length - 1 - rms.slice().reverse().findIndex((v) => v > threshold)
  if (first < 0) return wav
  const pad = 12   // 240 ms kept around the speech
  const from = Math.max(0, first - pad) * frame
  const to = Math.min(rms.length, last + 1 + pad) * frame
  // Level: the 95th percentile of the speech frames to about -14 dBFS, never more than 40x, peak held under 0.95.
  const gain0 = 0.2 / Math.max(top, 1e-4)
  let peak = 0
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(x[i]))
  const gain = Math.max(0.5, Math.min(gain0, 40, 0.95 / Math.max(peak, 1e-4)))
  const out = Buffer.alloc(44 + (to - from) * 2)
  out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(info.rate, 24)
  out.writeUInt32LE(info.rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34)
  out.write('data', 36); out.writeUInt32LE((to - from) * 2, 40)
  for (let i = from; i < to; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * gain * 32767))), 44 + (i - from) * 2)
  return out
}


// ---- words the model almost got -----------------------------------------------------------------------------
// A Hebrew word that is one sound away from a word the commands use ("קרום" for "כרום", "תפתחה" for "תפתח",
// "ביסקורט" for "דיסקורד") is taken to be that word. Only when exactly one word is that close, and never for short
// words, so ordinary speech is left as it was.

/** Letters that sound alike: swapping within a group costs nothing. */
const LIKE = [['כ', 'ק'], ['ת', 'ט', 'ד'], ['א', 'ע'], ['ס', 'ש', 'ז'], ['ח', 'כ'], ['ב', 'ו'], ['פ', 'ב']].map((g) => new Set(g))
const alike = (a, b) => a === b || LIKE.some((g) => g.has(a) && g.has(b))

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (alike(a[i - 1], b[j - 1]) ? 0 : 1))
  return d[a.length][b.length]
}

/** What the commands are made of; the app adds the names of the apps on this PC. */
const BASE_WORDS = ['תפתח', 'תפתחי', 'תסגור', 'תפעיל', 'תנגן', 'תשים', 'תעביר', 'תזיז', 'תגדיל', 'תמזער', 'תחפש', 'תגביר', 'תנמיך', 'תעצור', 'תמשיך', 'תנעל', 'השתק', 'חפש', 'פתח', 'סגור', 'נגן',
  'ווליום', 'ביוטיוב', 'יוטיוב', 'בגוגל', 'במפות', 'שמאל', 'ימין', 'למסך', 'המסך', 'השני', 'הראשון', 'הימני', 'השמאלי', 'השיר', 'סרטון', 'מוזיקה', 'קצת', 'בצד', 'למעלה', 'למטה', 'באמצע', 'הכל', 'המחשב', 'ספוטיפיי', 'דיסקורד', 'וואטסאפ', 'סטרימיו', 'טלגרם', 'כרום', 'מחשבון', 'הגדרות', 'שלושים', 'עשרים', 'ארבעים', 'חמישים']
let vocabulary = new Set(BASE_WORDS)
function setVocabulary(words) { vocabulary = new Set([...BASE_WORDS, ...words.filter((w) => /^[א-ת]{4,}$/.test(w))]) }
const PREFIXES = ['ו', 'ה', 'ב', 'ל', 'מ', 'כ', 'ש', 'וה', 'וב', 'ול']

function snap(text) {
  const words = [...vocabulary]
  return String(text).split(/(\s+)/).map((tok) => {
    const m = tok.match(/^([^א-ת]*)([א-ת]+)(.*)$/)
    if (!m) return tok
    const [, lead, word, tail] = m
    if (word.length < 4 || vocabulary.has(word)) return tok
    let best = null, bestD = 99
    for (const prefix of ['', ...PREFIXES]) {
      if (prefix && !word.startsWith(prefix)) continue
      const rest = word.slice(prefix.length)
      if (rest.length < 4) continue
      for (const v of words) {
        if (Math.abs(v.length - rest.length) > 1) continue
        const dist = distance(rest, v)
        if (dist > (v.length >= 8 ? 2 : 1)) continue
        // The closest wins; among equals, the first (a command word before an app, no prefix before a prefix).
        if (dist < bestD) { best = prefix + v; bestD = dist }
      }
    }
    return best ? lead + best + tail : tok
  }).join('')
}

/** WAV bytes (16 kHz mono) → Hebrew text. The prompt carries names and words it should spell right. */
async function transcribe(root, wav, prompt, { snapWords = true } = {}) {
  await start(root)
  const form = new FormData()
  form.append('file', new Blob([process.env.HELPER_RAW_AUDIO ? wav : prepare(wav)], { type: 'audio/wav' }), 'speech.wav')
  form.append('response_format', 'json')
  form.append('temperature', '0')
  if (prompt) form.append('prompt', prompt.slice(0, 400))
  const r = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: 'POST', body: form })
  if (!r.ok) throw new Error('speech ' + r.status)
  const j = await r.json()
  return clean(snapWords && !process.env.HELPER_NO_SNAP ? snap(String(j.text || '')) : String(j.text || ''))
}

/**
 * Was anything said? 20 ms frames of a 16-bit mono WAV, louder than quiet room noise, for at least 0.2 s in all.
 * Whisper never returns nothing: on silence it makes up a sentence, so silence must not reach it.
 */
function hasSpeech(wav) {
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, Math.floor((wav.length - 44) / 2))
  const frame = 320
  let loud = 0
  let peak = 0
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let sum = 0
    for (let j = i; j < i + frame; j++) sum += pcm[j] * pcm[j]
    const rms = Math.sqrt(sum / frame) / 32768
    if (rms > peak) peak = rms
    if (rms > 0.010) loud++
  }
  return loud >= 8 && peak > 0.022
}

// What whisper (and this Hebrew model, trained on Knesset sessions and subtitles) says over silence or noise.
const MADE_UP = [
  /^(תודה(\s+רבה)?(\s+לכם)?|thank you\.?|thanks for watching\.?|you\.?)$/i,
  /אדוני היושב[\s-]?ראש|חברות וחברי הכנסת|חברי הכנסת|הישיבה נעולה|אני פותח את הישיבה/,
  /כתוביות|תרגום:|תורגם על ידי|subtitles by|transcribed by/i,
  /^(אה+|אמ+|הממ+|\.+|…+)$/,
]

/** Whisper's habits on silence and noise, and the fillers people say. */
function clean(s) {
  let t = s.replace(/\s+/g, ' ').trim()
  if (/^\[.*\]$|^\(.*\)$/.test(t)) return ''
  if (MADE_UP.some((re) => re.test(t))) return ''
  t = t.replace(/(^|\s)(אממ+|אה+|אהמ+|אמ+|כאילו,)(?=\s|$|[,.])/g, ' ').replace(/\s+/g, ' ').trim()
  // Names it often splits: "בי עוד טיוב" / "ביו טיוב" is ביוטיוב, "ספוטי פיי" is ספוטיפיי.
  t = t.replace(/(^|\s)(בי עוד טיוב|בי ו טיוב|ביו טיוב|בי יו טיוב|בי-יוטיוב|ביוטוב|בייוטיוב)(?=\s|$|[,.])/g, '$1ביוטיוב')
    .replace(/(^|\s)(יו טיוב|יוטוב|יו-טיוב)(?=\s|$|[,.])/g, '$1יוטיוב')
    .replace(/(^|\s)(ספוטי פיי|ספוטי-פיי|ספוטיפי)(?=\s|$|[,.])/g, '$1ספוטיפיי')
  return t
}

/** The loudest 20 ms of a WAV, 0..1 (for the log). */
function level(wav) {
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, Math.floor((wav.length - 44) / 2))
  let peak = 0
  for (let i = 0; i + 320 <= pcm.length; i += 320) {
    let sum = 0
    for (let j = i; j < i + 320; j++) sum += pcm[j] * pcm[j]
    peak = Math.max(peak, Math.sqrt(sum / 320) / 32768)
  }
  return peak
}

/**
 * The same recording heard under several hints, and the reading that makes the most sense as a command: one that the
 * instant commands understand first, then the one with the most of the commands' words, then the first. Each pass
 * takes about 0.15 s on the graphics card, and they run together.
 * hints: the hint texts to try, the first being the app's own. isCommand(text) says whether text is one.
 */
async function transcribeBest(root, wav, hints, isCommand) {
  const readings = await Promise.all(hints.map((h) => transcribe(root, wav, h).catch(() => '')))
  const score = (t) => (isCommand(t) ? 1000 : 0) + t.split(/\s+/).filter((w) => vocabulary.has(w.replace(/[^א-ת]/g, ''))).length
  let best = readings[0] || ''
  for (const t of readings) if (t && score(t) > score(best)) best = t
  return best
}

/** The words the commands are made of, as a model hint (the app's own words, as they are said). */
const HINTS = 'פקודות למחשב. תפעיל את כרום ואת דיסקורד. תזיז את ספוטיפיי למסך הימני. תמזער את וואטסאפ. תנמיך את הווליום ותעצור את השיר. תנגן ביוטיוב סרטון. תחפש בגוגל. תסגור את סטרימיו וטלגרם.'

module.exports = { transcribeBest, HINTS, snap, setVocabulary, start, stop, transcribe, available, clean, hasSpeech, level, prepare }
