// Everything Helper prints goes through here, for three reasons:
// 1. libsignal (pulled in by Baileys) prints Signal session records, which contain key material. Those lines are dropped.
// 2. Keys and tokens are masked wherever they appear: an error message that quotes a request, a URL with a key in it.
// 3. LOG_FORMAT=json prints one JSON object per line ({ t, level, tag, msg }), for log tools. The default stays
//    plain text, which reads best in `docker logs`.
import { format } from 'node:util'

const SECRET_PREFIXES = [
  'Closing session',
  'Closing open session',
  'Removing old closed session',
  'Opening session',
  'Session already closed',
]

export function isSecretSessionLog(value) {
  if (typeof value !== 'string') return false
  const text = value.trimStart()
  return SECRET_PREFIXES.some((prefix) => text.startsWith(prefix))
}

// Settings whose values must never reach a log, whatever text they turn up in.
const SECRET_ENV = ['LLM_API_KEY', 'LLM_BACKUP_API_KEY', 'ELEVENLABS_API_KEY', 'GITHUB_TOKEN', 'GOOGLE_CLIENT_SECRET', 'MAIL_PASS', 'TAVILY_API_KEY', 'TRAVELPAYOUTS_TOKEN', 'DUFFEL_TOKEN', 'VOICE_API_KEY', 'GEMINI_API_KEY', 'BACKUP_PASSPHRASE', 'PC_UNLOCK_PASSWORD', 'PC_BRIDGE_SECRET', 'CLOUD_DESKTOP_VNC_PASSWORD', 'TWILIO_AUTH_TOKEN', 'VOICE_SECRET', 'WAKE_SECRET', 'CLAUDE_CODE_OAUTH_TOKEN']

// Shapes of keys that are recognisable on their own, and what each is replaced with.
const PATTERNS = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ••••'], // Authorization headers
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '••••'], // OpenAI-style keys
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '••••'], // Google API keys
  [/\bya29\.[0-9A-Za-z._-]{20,}/g, '••••'], // Google access tokens
  [/\b1\/\/[0-9A-Za-z_-]{20,}/g, '••••'], // Google refresh tokens
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '••••'], // GitHub tokens
  [/([?&](?:key|api_key|apikey|access_token|token|password)=)[^&\s"']+/gi, '$1••••'], // secrets in a URL's query
  [/("(?:refresh_token|access_token|client_secret|password|api_key)"\s*:\s*")[^"]+/gi, '$1••••'], // secrets in JSON
]

export function redact(text) {
  let out = String(text)
  for (const name of SECRET_ENV) {
    const value = process.env[name]
    if (value && value.length >= 6) out = out.split(value).join('••••')
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement)
  return out
}

// "[tag] message" -> { tag, msg }
export function toEntry(level, args, now = new Date()) {
  const text = redact(format(...args))
  const m = text.match(/^\[([\w .:@/-]{1,40})\]\s*([\s\S]*)$/)
  return { t: now.toISOString(), level, ...(m ? { tag: m[1], msg: m[2] } : { msg: text }) }
}

const json = () => process.env.LOG_FORMAT === 'json'

for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
  const orig = console[method].bind(console)
  console[method] = (...args) => {
    if (isSecretSessionLog(args[0])) return
    if (json()) return orig(JSON.stringify(toEntry(level, args)))
    orig(redact(format(...args)))
  }
}
