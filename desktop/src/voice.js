// Spoken answers. The cloud HELPER speaks with Edge-TTS. ElevenLabs is used here only when
// TTS_PROVIDER=elevenlabs. Otherwise: the cloud voice, then a local edge-tts if it is installed,
// then Windows' Hebrew voice.
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile, execFileSync } = require('child_process')
const config = require('./config')
const brain = require('./brain')

const MODEL = 'eleven_v3'
const cacheDir = path.join(os.tmpdir(), 'helper-voice-cache')
try { fs.mkdirSync(cacheDir, { recursive: true }) } catch {}

/** What is said: Hebrew text optimized for crystal-clear pronunciation. */
function speakable(text) {
  return String(text || '')
    .replace(/[⁦-⁩‎‏‪-‮]/g, '')
    .replace(/https?:\/\/\S+/g, 'קישור')
    .replace(/[A-Z]:\\\S+/g, '')
    .replace(/[`*_#>|~]/g, '')
    .replace(/\bVS\s*Code\b/gi, 'וי אס קוד')
    .replace(/\bChrome\b/gi, 'כרום')
    .replace(/\bSpotify\b/gi, 'ספוטיפיי')
    .replace(/\bDiscord\b/gi, 'דיסקורד')
    .replace(/\bGPU\b/gi, 'ג\'י פי יו')
    .replace(/\bCPU\b/gi, 'סי פי יו')
    .replace(/\bRAM\b/gi, 'ראם')
    .replace(/\bGB\b/gi, 'ג\'יגה')
    .replace(/\s·\s/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)
}

/** Direct ElevenLabs text-to-speech with local disk caching. */
async function elevenLabs(text) {
  const apiKey = config.elevenLabsApiKey
  const voiceId = config.elevenLabsVoiceId || 'JIxTgeeS5w0UQyBxEnrl'
  if (!apiKey) return null

  // Check disk cache first for 0ms instant playback:
  const hash = crypto.createHash('md5').update(`${MODEL}:${voiceId}:${text}`).digest('hex')
  const cachePath = path.join(cacheDir, `${hash}.mp3`)
  if (fs.existsSync(cachePath)) {
    try {
      const cached = fs.readFileSync(cachePath)
      if (cached.length > 500) return cached
    } catch {}
  }

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        // eleven_v3 with language_code he is the one that speaks Hebrew as Hebrew: the multilingual v2 model
        // let the voice drift into Arabic-sounding speech (Whisper heard it as garbled words).
        language_code: 'he',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      }),
      signal: AbortSignal.timeout(9000)
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > 500) {
      try { fs.writeFileSync(cachePath, buf) } catch {}
      return buf
    }
    return null
  } catch {
    return null
  }
}

/** Windows' Hebrew voice → WAV bytes, or null when it has none. */
function local(text) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `helper-voice-${Date.now()}.wav`)
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'say.ps1'), '-Text', text, '-Out', out],
      { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        if (err || !/OK/.test(stdout || '')) return resolve(null)
        try {
          const wav = fs.readFileSync(out)
          fs.unlinkSync(out)
          resolve(wav)
        } catch { resolve(null) }
      })
  })
}

function wantsEleven() {
  return ['eleven', 'elevenlabs', '11labs'].includes(config.ttsProvider)
}

function hasEdge() {
  if (hasEdge.yes !== undefined) return hasEdge.yes
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    execFileSync(cmd, ['edge-tts'], { stdio: 'ignore', timeout: 3000 })
    hasEdge.yes = true
  } catch {
    hasEdge.yes = false
  }
  return hasEdge.yes
}

// Local edge-tts, only when the cloud is unreachable. Hebrew uses EDGE_TTS_VOICE; other letters use an English neural voice.
function localEdge(text) {
  if (!hasEdge()) return Promise.resolve(null)
  const voice = /[\u0590-\u05FF]/.test(text) ? (config.edgeVoice || 'he-IL-HilaNeural') : 'en-US-AriaNeural'
  const rate = config.edgeRate || '+0%'
  const hash = crypto.createHash('md5').update(`edge:${voice}:${rate}:${text}`).digest('hex')
  const file = path.join(cacheDir, `${hash}.mp3`)
  if (fs.existsSync(file)) {
    try {
      const cached = fs.readFileSync(file)
      if (cached.length > 500) return Promise.resolve(cached)
    } catch {}
  }
  return new Promise((resolve) => {
    execFile('edge-tts', ['--voice', voice, '--rate', rate, '--text', text, '--write-media', file],
      { timeout: 20000, windowsHide: true }, (err) => {
        if (err) return resolve(null)
        try {
          const buf = fs.readFileSync(file)
          resolve(buf.length > 500 ? buf : null)
        } catch { resolve(null) }
      })
  })
}

/**
 * The answer as audio: {b64, mime}.
 * Cloud Edge-TTS first. ElevenLabs only when TTS_PROVIDER=elevenlabs. Windows SAPI is the last resort.
 */
async function of(text, ready = null) {
  const say = speakable(text)
  if (!say) return null
  if (ready) return { b64: ready, mime: 'audio/mpeg' }

  if (wantsEleven()) {
    try {
      const mp3 = await elevenLabs(say)
      if (mp3) return { b64: mp3.toString('base64'), mime: 'audio/mpeg' }
    } catch {}
  }

  try {
    const mp3 = await Promise.race([brain.voiceOf(say), new Promise((r) => setTimeout(() => r(null), 8000))])
    if (mp3 && mp3.length > 500) return { b64: mp3.toString('base64'), mime: 'audio/mpeg' }
  } catch {}

  if (!wantsEleven()) {
    try {
      const mp3 = await localEdge(say)
      if (mp3) return { b64: mp3.toString('base64'), mime: 'audio/mpeg' }
    } catch {}
  }

  const wav = await local(say)
  return wav ? { b64: wav.toString('base64'), mime: 'audio/wav' } : null
}

module.exports = { of, speakable, local, elevenLabs, localEdge }
