// HELPER's spoken answers: direct ElevenLabs high-quality Hebrew voice (Amit),
// with persistent disk cache for 0ms replay and fast fallback to Windows' Hebrew voice (Microsoft Asaf).
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
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

/**
 * The answer as audio: {b64, mime}.
 * Uses ElevenLabs with instant cache, falls back to Windows SAPI if offline or timed out.
 */
async function of(text, ready = null) {
  const say = speakable(text)
  if (!say) return null
  if (ready) return { b64: ready, mime: 'audio/mpeg' }

  // 1. Direct ElevenLabs with cache:
  try {
    const mp3 = await elevenLabs(say)
    if (mp3) return { b64: mp3.toString('base64'), mime: 'audio/mpeg' }
  } catch {}

  // 2. Cloud bridge if connected:
  try {
    const mp3 = await Promise.race([brain.voiceOf(say), new Promise((r) => setTimeout(() => r(null), 2000))])
    if (mp3 && mp3.length > 500) return { b64: mp3.toString('base64'), mime: 'audio/mpeg' }
  } catch {}

  // 3. Fallback to Windows SAPI (Asaf):
  const wav = await local(say)
  return wav ? { b64: wav.toString('base64'), mime: 'audio/wav' } : null
}

module.exports = { of, speakable, local, elevenLabs }
