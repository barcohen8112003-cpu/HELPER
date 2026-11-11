// Speech synthesis. Edge-TTS is the default (no key, no bill). ElevenLabs stays as an
// optional provider, and as the fallback when Edge fails and a key is configured.
// This file does not import config.js: live-voice.js loads it while config is still starting.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const DEFAULT_HEBREW_VOICE = 'he-IL-HilaNeural'
export const DEFAULT_RATE = '+0%'

// One neural voice per language. Hebrew uses EDGE_TTS_VOICE (Hila or Avri).
export const VOICES = {
  en: 'en-US-AriaNeural',
  fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-KatjaNeural',
  es: 'es-ES-ElviraNeural',
  it: 'it-IT-ElsaNeural',
  pt: 'pt-BR-FranciscaNeural',
  nl: 'nl-NL-ColetteNeural',
  pl: 'pl-PL-ZofiaNeural',
  tr: 'tr-TR-EmelNeural',
  ar: 'ar-EG-SalmaNeural',
  ru: 'ru-RU-SvetlanaNeural',
  uk: 'uk-UA-PolinaNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
  hi: 'hi-IN-SwaraNeural',
}

// Whole words only. A language needs two hits so one shared word does not flip the voice.
const LATIN_WORDS = {
  fr: ['bonjour', 'merci', 'vous', 'est', 'les', 'une', 'des', 'pas', 'avec', 'pour', 'comment', 'ça'],
  de: ['danke', 'nicht', 'ich', 'und', 'der', 'die', 'das', 'ein', 'ist', 'auch'],
  es: ['hola', 'gracias', 'que', 'por', 'una', 'los', 'las', 'como', 'muy', 'está'],
  it: ['ciao', 'grazie', 'che', 'non', 'una', 'per', 'sono', 'con', 'buongiorno'],
  pt: ['olá', 'obrigado', 'você', 'não', 'uma', 'para', 'com', 'bom'],
  nl: ['hallo', 'dank', 'niet', 'het', 'een', 'van', 'voor'],
  pl: ['cześć', 'dzień', 'nie', 'się', 'jest', 'proszę'],
  tr: ['merhaba', 'teşekkür', 'bir', 've', 'için', 'değil'],
}

const count = (text, re) => (String(text).match(re) || []).length

export function ttsProvider(env = process.env) {
  const raw = String(env.TTS_PROVIDER || '').trim().toLowerCase()
  if (raw === 'eleven' || raw === 'elevenlabs' || raw === '11labs') return 'elevenlabs'
  if (raw === 'openai' || raw === 'compatible' || raw === 'voice') return 'openai'
  return 'edge'
}

export function normalizeRate(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return DEFAULT_RATE
  const ready = s.match(/^([+-])(\d{1,3})%$/)
  const loose = s.match(/^([+-]?\d{1,3})%?$/)
  const n = ready ? Number(`${ready[1]}${ready[2]}`) : loose ? Number(loose[1]) : null
  if (n === null || Number.isNaN(n)) return DEFAULT_RATE
  const clamped = Math.max(-50, Math.min(100, n))
  return `${clamped >= 0 ? '+' : ''}${clamped}%`
}

export function hebrewVoice(env = process.env) {
  const v = String(env.EDGE_TTS_VOICE || '').trim()
  if (/^[\w.-]{1,80}$/.test(v)) return v
  return DEFAULT_HEBREW_VOICE
}

function latinLang(text) {
  const words = new Set(String(text).toLowerCase().match(/[a-zà-ÿ]{2,}/g) || [])
  let best = 'en'
  let bestScore = 0
  for (const [lang, list] of Object.entries(LATIN_WORDS)) {
    const score = list.filter((w) => words.has(w)).length
    if (score > bestScore) {
      best = lang
      bestScore = score
    }
  }
  return bestScore >= 2 ? best : 'en'
}

// Hebrew when the Hebrew letters lead. Anything else gets a voice for that script.
export function detectLang(text) {
  const s = String(text || '')
  const he = count(s, /[\u0590-\u05FF]/g)
  const ar = count(s, /[\u0600-\u06FF]/g)
  const cyr = count(s, /[\u0400-\u04FF]/g)
  const cjk = count(s, /[\u4E00-\u9FFF]/g)
  const kana = count(s, /[\u3040-\u30FF]/g)
  const hang = count(s, /[\uAC00-\uD7AF]/g)
  const deva = count(s, /[\u0900-\u097F]/g)
  const lat = count(s, /[A-Za-z\u00C0-\u024F]/g)
  const scripts = [
    ['he', he],
    ['ar', ar],
    ['cyr', cyr],
    ['ja', kana > 0 ? kana + cjk : 0],
    ['zh', kana > 0 ? 0 : cjk],
    ['ko', hang],
    ['hi', deva],
  ].sort((a, b) => b[1] - a[1])
  const [top, topN] = scripts[0]
  if (topN > 0 && topN >= lat) {
    if (top === 'cyr') return /[іїєґІЇЄҐ]/.test(s) ? 'uk' : 'ru'
    return top
  }
  if (lat > 0) return latinLang(s)
  return 'he'
}

export function voiceFor(text, env = process.env) {
  const lang = detectLang(text)
  const rate = normalizeRate(env.EDGE_TTS_RATE)
  const voice = lang === 'he' ? hebrewVoice(env) : VOICES[lang] || VOICES.en
  return { lang, voice, rate }
}

// WhatsApp voice notes are Ogg Opus 48 kHz mono 32 kbps (what ElevenLabs called opus_48000_32).
// LiveKit plays 16 kHz mono s16le.
export function ffmpegArgs(input, format) {
  const base = ['-hide_banner', '-loglevel', 'error', '-i', input]
  if (format === 'opus') return [...base, '-c:a', 'libopus', '-ar', '48000', '-ac', '1', '-b:a', '32k', '-f', 'ogg', 'pipe:1']
  if (format === 'pcm') return [...base, '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', 'pipe:1']
  throw new Error(`unknown audio format ${format}`)
}

function defaultExec(cmd, args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(reject, new Error(`${cmd} timed out`))
    }, timeoutMs)
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('error', (e) => finish(reject, e))
    child.on('close', (code) => {
      if (code !== 0) finish(reject, new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 300)}`))
      else finish(resolve, Buffer.concat(out))
    })
  })
}

let edgeExec = defaultExec
let edgeBin = null

export function setEdgeExec(fn) {
  edgeExec = typeof fn === 'function' ? fn : defaultExec
  if (typeof fn !== 'function') edgeBin = null
}

export function edgeInstalled() {
  if (edgeExec !== defaultExec) return true
  if (edgeBin !== null) return edgeBin
  try {
    const r = spawnSync('edge-tts', ['--help'], { stdio: 'ignore', timeout: 8000 })
    edgeBin = !(r.error && r.error.code === 'ENOENT')
  } catch {
    edgeBin = false
  }
  return edgeBin
}

export async function edgeAudio(text, { format = 'mp3', voice = DEFAULT_HEBREW_VOICE, rate = DEFAULT_RATE, exec } = {}) {
  const line = String(text || '').slice(0, 1500)
  if (!line.trim()) throw new Error('empty')
  const run = exec || edgeExec
  const dir = await mkdtemp(path.join(tmpdir(), 'helper-tts-'))
  const mp3 = path.join(dir, 'speech.mp3')
  try {
    const produced = await run('edge-tts', ['--voice', voice, '--rate', rate, '--text', line, '--write-media', mp3])
    if (format === 'mp3') {
      if (produced?.length >= 64) return Buffer.from(produced)
      const buf = await readFile(mp3)
      if (buf.length < 64) throw new Error('edge-tts returned no audio')
      return buf
    }
    const out = Buffer.from(await run('ffmpeg', ffmpegArgs(mp3, format), 20000))
    if (out.length < 8) throw new Error('ffmpeg returned no audio')
    if (format === 'opus' && out.subarray(0, 4).toString() !== 'OggS') throw new Error('ffmpeg did not return Ogg Opus')
    return out
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Edge first (two tries). ElevenLabs only when it is configured. Otherwise the caller sends text.
export async function synthesizeSpeech(text, opts = {}) {
  const provider = opts.provider || ttsProvider(opts.env)
  const choice = opts.voice || voiceFor(text, opts.env || process.env)
  const format = opts.format || 'mp3'
  const attempts = opts.attempts ?? 2
  const delayMs = opts.delayMs ?? 350

  const runEdge = async () => {
    if (opts.edgeInstalled === false) throw new Error('edge-tts לא מותקן')
    let last
    for (let i = 0; i < attempts; i++) {
      try {
        return await edgeAudio(text, { format, voice: choice.voice, rate: choice.rate, exec: opts.exec })
      } catch (e) {
        last = e
        if (i + 1 < attempts && delayMs) await wait(delayMs * (i + 1))
      }
    }
    throw last
  }

  if (provider === 'openai') {
    if (typeof opts.openai !== 'function') throw new Error('TTS_MODEL לא מוגדר')
    return opts.openai()
  }

  if (provider === 'elevenlabs') {
    if (opts.elevenConfigured === false || typeof opts.eleven !== 'function') return runEdge()
    try {
      return await opts.eleven()
    } catch (e) {
      try {
        return await runEdge()
      } catch {
        throw e
      }
    }
  }

  try {
    return await runEdge()
  } catch (e) {
    if (opts.elevenConfigured && typeof opts.eleven === 'function') {
      try {
        console.error(`[tts] edge-tts failed (${String(e.message || e).slice(0, 180)}); using ElevenLabs`)
        return await opts.eleven()
      } catch (e2) {
        throw new Error(`edge-tts failed (${e.message}); ElevenLabs failed (${e2.message})`)
      }
    }
    throw e
  }
}
