import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// HELPER_DATA_DIR lets tests run against a throwaway folder instead of the real state.
export const DATA_DIR = process.env.HELPER_DATA_DIR || path.join(ROOT, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

// HELPER_ENV_FILE, like HELPER_DATA_DIR, points tests at a throwaway copy.
export const ENV_FILE = process.env.HELPER_ENV_FILE || path.join(ROOT, '.env')
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)

// An empty line in .env ("KEY=") counts as unset, so the default applies.
const env = (k, d = '') => (process.env[k] || d).trim()

// Every time the assistant reads or prints is in this zone, whatever the computer's own clock is set to.
process.env.TZ = env('TIMEZONE', 'Asia/Jerusalem')

// Up to five mailboxes: MAIL_*, MAIL2_*, ... MAIL5_*
const mailAccounts = () =>
  ['MAIL', 'MAIL2', 'MAIL3', 'MAIL4', 'MAIL5']
    .map((p) => ({ host: env(`${p}_HOST`), user: env(`${p}_USER`), pass: env(`${p}_PASS`) }))
    .filter((a) => a.host && a.user && a.pass)

// "23:00-07:00" -> minutes since midnight, or null when unset or malformed.
function parseQuiet(value) {
  const m = value.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/)
  return m ? { from: m[1] * 60 + Number(m[2]), to: m[3] * 60 + Number(m[4]) } : null
}

const DEFAULT_FEEDS = [
  'https://www.ynet.co.il/Integration/StoryRss1854.xml',
  'https://www.maariv.co.il/Rss/RssFeedsMivzakiChadashot',
  'https://www.israelhayom.co.il/rss.xml',
].join(',')

const build = () => ({
  uiPort: Number(env('UI_PORT', '3210')) || 3210,
  quiet: parseQuiet(env('QUIET_HOURS')),
  llm: {
    baseUrl: env('LLM_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: env('LLM_API_KEY'),
    model: env('LLM_MODEL'),
    cheapModel: env('LLM_CHEAP_MODEL'),
    strongModel: env('LLM_STRONG_MODEL'),
    // One model or several, comma-separated, tried in this order when the main one is out of budget or failing.
    fallbackModels: env('LLM_FALLBACK_MODEL').split(',').map((s) => s.trim()).filter(Boolean),
    // Light mode: for providers with a small tokens-per-minute budget (free tiers). Short persona, short history, short tool results.
    light: env('LLM_LIGHT') === 'true',
  },
  botName: env('BOT_NAME', 'Helper'),
  briefTime: env('DAILY_BRIEF_TIME'),
  briefAlways: env('DAILY_BRIEF_ALWAYS') === 'true',
  // Quiet monitoring (src/monitoring). Every default works with nothing set.
  watch: {
    statePath: env('WATCH_STATE_PATH') ? path.resolve(ROOT, env('WATCH_STATE_PATH')) : path.join(DATA_DIR, 'watch-state.json'),
    maxToolRounds: Number(env('WATCH_MAX_TOOL_ROUNDS', '4')) || 4,
    maxTokens: Number(env('WATCH_MAX_TOKENS', '2000')) || 2000,
    timeoutMs: Number(env('WATCH_CHECK_TIMEOUT_MS', '30000')) || 30000,
    seenCap: Number(env('WATCH_SEEN_IDS_CAP', '500')) || 500,
    // A placeholder left as "<...>" counts as unset.
    filterModel: env('WATCH_MODEL_FILTER').startsWith('<') ? '' : env('WATCH_MODEL_FILTER'),
    urgencyModel: env('WATCH_MODEL_URGENCY').startsWith('<') ? '' : env('WATCH_MODEL_URGENCY'),
    urgentDeadlineHours: Number(env('URGENT_DEADLINE_HOURS', '12')) || 12,
    overrideSource: env('WATCH_OVERRIDE_SOURCE'),
    overrideTopic: env('WATCH_OVERRIDE_TOPIC'),
  },
  // Listen to Google mailboxes live (IMAP IDLE) so new mail is reported the second it lands. false = poll every two minutes.
  liveMail: env('LIVE_MAIL', 'true') !== 'false',
  newsTime: env('NEWS_BRIEF_TIME'),
  // Self-initiated messages: how many a day at most (0 = never), and the least time between two.
  proactive: { maxPerDay: Math.max(0, Number(env('CHECK_IN_PER_DAY', '0')) || 0), everyMinutes: Math.max(30, Number(env('CHECK_IN_EVERY_MINUTES', '180')) || 180) },
  newsFeeds: env('NEWS_FEEDS', DEFAULT_FEEDS).split(',').map((s) => s.trim()).filter(Boolean),
  tavilyKey: env('TAVILY_API_KEY'),
  // Speech can live on a different provider than the chat model; it defaults to the same one.
  voice: {
    baseUrl: (env('VOICE_BASE_URL') || env('LLM_BASE_URL', 'https://api.openai.com/v1')).replace(/\/+$/, ''),
    apiKey: env('VOICE_API_KEY') || env('LLM_API_KEY'),
    sttModel: env('STT_MODEL'),
    ttsModel: env('TTS_MODEL'),
    ttsVoice: env('TTS_VOICE', 'alloy'),
  },
  // When a key is set, ElevenLabs handles both directions of voice and the settings above are ignored.
  elevenlabs: {
    apiKey: env('ELEVENLABS_API_KEY'),
    voiceId: env('ELEVENLABS_VOICE_ID'),
    ttsModel: env('ELEVENLABS_TTS_MODEL', 'eleven_v3'),
    sttModel: env('ELEVENLABS_STT_MODEL', 'scribe_v1'),
    imageModel: env('ELEVENLABS_IMAGE_MODEL', 'gemini-2.5-flash-image'),
    videoModel: env('ELEVENLABS_VIDEO_MODEL', 'bytedance-seedance-v2-mini'),
  },
  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    // Accounts the assistant may read but never send from or write to (school).
    readOnly: env('GOOGLE_READONLY_ACCOUNTS').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
  },
  githubToken: env('GITHUB_TOKEN'),
  imageModel: env('IMAGE_MODEL'),
  mail: {
    accounts: mailAccounts(),
    pollMinutes: Math.max(2, Number(env('MAIL_POLL_MINUTES', '10')) || 10),
  },
  calendarUrl: env('CALENDAR_ICS_URL'),
  computerMode: ['off', 'ask', 'auto'].includes(env('COMPUTER_MODE', 'ask')) ? env('COMPUTER_MODE', 'ask') : 'ask',
})

export const config = build()

// Writes settings to .env (replacing a key's line, or appending it) and applies them to the running assistant.
// Every module reads `config.x` at the moment of use, so most changes take effect at once; the few values that
// are read only at startup (time zone, light mode, IMAP listeners, the settings port) need a restart.
export function saveSettings(updates) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : []
  for (const [key, raw] of Object.entries(updates)) {
    const value = String(raw).replace(/[\r\n]/g, ' ').trim()
    const i = lines.findIndex((l) => l.startsWith(key + '='))
    if (i >= 0) lines[i] = `${key}=${value}`
    else lines.push(`${key}=${value}`)
    process.env[key] = value
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n'))
  Object.assign(config, build())
}

export const mailEnabled = () => config.mail.accounts.length > 0
export const calendarEnabled = () => Boolean(config.calendarUrl)
