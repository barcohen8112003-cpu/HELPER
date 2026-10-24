// HELPER's spoken answers: its own voice from the cloud (ElevenLabs, /bridge/tts), and Windows' Hebrew voice
// (Microsoft Asaf) on this PC when the cloud does not answer in time, so a spoken ask always gets a spoken answer.
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const brain = require('./brain')

/** What is said: the answer without what does not read aloud (links, file paths, ids, symbols). */
function speakable(text) {
  return String(text || '')
    .replace(/[⁦-⁩‎‏‪-‮]/g, '')
    .replace(/https?:\/\/\S+/g, 'קישור')
    .replace(/[A-Z]:\\\S+/g, '')
    .replace(/[`*_#>|~]/g, '')
    .replace(/\s·\s/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)
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
 * The answer as audio: {b64, mime}. The cloud's voice when it comes within 4 s (or audio the cloud already sent with
 * its answer), else the local voice.
 */
async function of(text, ready = null) {
  const say = speakable(text)
  if (!say) return null
  if (ready) return { b64: ready, mime: 'audio/mpeg' }
  try {
    const mp3 = await Promise.race([brain.voiceOf(say), new Promise((r) => setTimeout(() => r(null), 4000))])
    if (mp3 && mp3.length > 500) return { b64: mp3.toString('base64'), mime: 'audio/mpeg' }
  } catch { /* the local voice instead */ }
  const wav = await local(say)
  return wav ? { b64: wav.toString('base64'), mime: 'audio/wav' } : null
}

module.exports = { of, speakable, local }
