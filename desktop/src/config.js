// Configuration loader for HELPER Desktop. Reads root .env and local settings.
'use strict'
const fs = require('fs')
const path = require('path')

let cachedEnv = null

function loadEnv() {
  if (cachedEnv) return cachedEnv
  const envPaths = [
    path.join(__dirname, '..', '..', '.env'),
    path.join(__dirname, '..', '.env'),
  ]
  const env = {}
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      try {
        const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          const eq = trimmed.indexOf('=')
          if (eq > 0) {
            const key = trimmed.slice(0, eq).trim()
            let val = trimmed.slice(eq + 1).trim()
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1)
            }
            if (!env[key]) env[key] = val
          }
        }
      } catch {}
    }
  }
  cachedEnv = env
  return env
}

function get(key, fallback = '') {
  const env = loadEnv()
  return process.env[key] || env[key] || fallback
}

module.exports = {
  loadEnv,
  get,
  get llmApiKey() { return get('LLM_API_KEY') },
  get llmBaseUrl() { return get('LLM_BASE_URL', 'https://openrouter.ai/api/v1') },
  get llmModel() { return get('LLM_MODEL', 'openai/gpt-4o-mini') },
  get elevenLabsApiKey() { return get('ELEVENLABS_API_KEY') },
  get elevenLabsVoiceId() { return get('ELEVENLABS_VOICE_ID', 'JIxTgeeS5w0UQyBxEnrl') },
  get elevenLabsModel() { return get('ELEVENLABS_TTS_MODEL', 'eleven_multilingual_v2') },
}
