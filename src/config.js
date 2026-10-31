import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// HELPER_DATA_DIR lets tests run against a throwaway folder instead of the real state.
export const DATA_DIR = process.env.HELPER_DATA_DIR || path.join(ROOT, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

// HELPER_ENV_FILE, like HELPER_DATA_DIR, points tests at a throwaway copy.
// Resolved before the file is applied, so a test can point at its own file.
export const ENV_FILE = process.env.HELPER_ENV_FILE || path.join(ROOT, '.env')

// File values win over process env. Docker injects env_file once, when the container is created, and a later
// `docker restart` keeps those stale values. The settings page writes the mounted .env, so the file is the copy
// that must be read on every start. Keys absent from the file are left as the process set them.
export function applyEnvFile(file = ENV_FILE) {
  if (!file || !fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = raw.replace(/\r$/, '').trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = body.slice(eq + 1).trim()
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)
    process.env[key] = value
  }
}
applyEnvFile()

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
    // A second provider, used only when every model of the first is out of quota or failing.
    backup: { baseUrl: env('LLM_BACKUP_BASE_URL').replace(/\/+$/, ''), apiKey: env('LLM_BACKUP_API_KEY'), model: env('LLM_BACKUP_MODEL') },
    // Light mode: for providers with a small tokens-per-minute budget (free tiers). Short persona, short history, short tool results.
    light: env('LLM_LIGHT') === 'true',
  },
  botName: env('BOT_NAME', 'Helper'),
  briefTime: env('DAILY_BRIEF_TIME'),
  briefAlways: env('DAILY_BRIEF_ALWAYS') === 'true',
  // The morning message holds only today: calendar events, tasks and lessons. Night alerts go out separately.
  briefOnlyToday: env('DAILY_BRIEF_ONLY_TODAY', 'true') !== 'false',
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
  // Helper writing first (src/proactive.js): check-ins a few times a day, and coming back to what he left open.
  // Both skip quiet hours, wait while he is mid-conversation, and stop after MAX_UNANSWERED unanswered messages.
  proactive: {
    maxPerDay: Math.max(0, Number(env('CHECK_IN_PER_DAY', '2')) || 0),
    everyMinutes: Math.max(30, Number(env('CHECK_IN_EVERY_MINUTES', '180')) || 180),
    followUpsPerDay: Math.max(0, Number(env('FOLLOW_UPS_PER_DAY', '3')) || 0),
  },
  newsFeeds: env('NEWS_FEEDS', DEFAULT_FEEDS).split(',').map((s) => s.trim()).filter(Boolean),
  tavilyKey: env('TAVILY_API_KEY'),
  // Real flight data (src/flights.js). Travelpayouts: cheapest dates across a month or two, free token from
  // travelpayouts.com. Duffel: live offers with times, stops and layovers for exact dates, token from duffel.com.
  flights: {
    travelpayoutsToken: env('TRAVELPAYOUTS_TOKEN'),
    duffelToken: env('DUFFEL_TOKEN'),
    currency: env('FLIGHTS_CURRENCY', 'usd').toLowerCase(),
    home: env('FLIGHTS_HOME', 'TLV').toUpperCase(),
  },
  // Places to stay (src/stays.js): SerpApi's Google Hotels API, hotels and vacation rentals. 250 free searches a
  // month at serpapi.com.
  stays: {
    serpapiKey: env('SERPAPI_KEY'),
    currency: env('STAYS_CURRENCY', 'ILS').toUpperCase(),
  },
  // YouTube search through the official Data API (src/youtube.js). Empty = read the results page as before.
  youtubeKey: env('YOUTUBE_API_KEY'),
  // Each message gets only the tools and instructions of the areas it is about (src/domains.js). off = every tool, always.
  routing: env('TOOL_ROUTING', 'on') !== 'off',
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
  // Phone calls: the ElevenLabs voice agent, the secret its tool calls carry, and the local port its server listens on.
  phone: {
    agentId: env('ELEVENLABS_AGENT_ID'),
    secret: env('VOICE_SECRET'),
    port: Number(env('VOICE_PORT', '3211')) || 3211,
  },
  // A reminder before each lesson, from the Webtop timetable. LESSON_TIMES: when each lesson starts. At this school
  // lessons come in pairs that are one unit (1-2: 8:10-9:30 ...), so both lessons of a pair share its start time.
  lessons: {
    enabled: env('LESSON_REMINDERS', 'true') !== 'false',
    beforeMinutes: Number(env('LESSON_REMIND_MINUTES', '10')) || 10,
    times: env('LESSON_TIMES', '1=08:10,2=08:10,3=09:45,4=09:45,5=11:20,6=11:20,7=13:10,8=13:10,9=14:40,10=14:40,11=16:10,12=16:10'),
    // When each lesson ends. The reminder for a lesson goes out when the one before it ends; the first lesson of the
    // day, which has nothing before it, is reminded beforeMinutes ahead.
    ends: env('LESSON_END_TIMES', '1=09:30,2=09:30,3=11:05,4=11:05,5=12:40,6=12:40,7=14:30,8=14:30,9=16:00,10=16:00,11=17:30,12=17:30'),
  },
  // Twilio, used only to place the call out to the owner. TWILIO_FROM is the number the call comes from.
  twilio: { sid: env('TWILIO_ACCOUNT_SID'), token: env('TWILIO_AUTH_TOKEN'), from: env('TWILIO_FROM', '+17372508034') },
  // A signed-in browser window kept open on this computer (webtop-browser.bat), for sites that need a login.
  webtop: {
    url: env('WEBTOP_URL'),
    port: Number(env('WEBTOP_DEBUG_PORT', '9223')) || 9223,
    keepAliveMinutes: Math.max(1, Number(env('WEBTOP_KEEPALIVE_MINUTES', '10')) || 10),
    // 1: Chromium inside this process (the container), profile on the data volume. Unset: the home window, via the bridge when this is the cloud.
    cloud: ['1', 'true', 'yes'].includes(env('WEBTOP_CLOUD').toLowerCase()),
    // Optional proxy for that Chromium only (http:// or socks5://). A server outside Israel is blocked by Webtop's CloudFront.
    proxy: env('WEBTOP_PROXY'),
  },
  // fetch_page through Scrapling (Python, py/scrapling_worker.py): public HTTPS pages only, with DNS and redirect
  // checks. Off unless SCRAPLING_ENABLED=true. SCRAPLING_PYTHON is the interpreter inside its own venv.
  scrapling: {
    enabled: env('SCRAPLING_ENABLED') === 'true',
    python: env('SCRAPLING_PYTHON', path.join(ROOT, '.venv-scrapling', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')),
    timeoutMs: Math.min(60000, Math.max(5000, Number(env('SCRAPLING_TIMEOUT_MS', '30000')) || 30000)),
    maxBytes: Math.min(10 * 1024 * 1024, Math.max(64 * 1024, Number(env('SCRAPLING_MAX_BYTES', String(2 * 1024 * 1024))) || 2 * 1024 * 1024)),
    maxChars: Math.min(100000, Math.max(1000, Number(env('SCRAPLING_MAX_CHARS', '30000')) || 30000)),
    concurrency: Math.min(4, Math.max(1, Number(env('SCRAPLING_CONCURRENCY', '2')) || 2)),
    // A controlled egress proxy (http://host:port). Only then may a name that has no local DNS answer be read,
    // because the proxy resolves it. Leave empty on a normal server.
    proxy: env('SCRAPLING_EGRESS_PROXY'),
  },
  // A second Chromium in the container, signed in to the personal Google account, for Google Home tiles.
  // Separate from Webtop so a school login and a home login do not share a profile.
  googleHome: {
    cloud: ['1', 'true', 'yes'].includes(env('GOOGLE_HOME_CLOUD').toLowerCase()),
    port: Number(env('GOOGLE_HOME_DEBUG_PORT', '9226')) || 9226,
    keepAliveMinutes: Math.max(1, Number(env('GOOGLE_HOME_KEEPALIVE_MINUTES', '10')) || 10),
  },
  // One shared X display for the cloud browsers, reached as a remote desktop.
  // noVNC listens inside the container only. The settings site proxies it, and Tailscale Serve can too.
  desktop: {
    enabled: ['1', 'true', 'yes'].includes(env('CLOUD_DESKTOP').toLowerCase()),
    display: env('CLOUD_DESKTOP_DISPLAY', ':99') || ':99',
    geometry: env('CLOUD_DESKTOP_GEOMETRY', '1280x800') || '1280x800',
    vncPort: Number(env('CLOUD_DESKTOP_VNC_PORT', '5900')) || 5900,
    webPort: Number(env('CLOUD_DESKTOP_WEB_PORT', '6080')) || 6080,
    upstream: env('CLOUD_DESKTOP_UPSTREAM', 'http://127.0.0.1:6080') || 'http://127.0.0.1:6080',
    vncPassword: env('CLOUD_DESKTOP_VNC_PASSWORD'),
  },
  // Self-teaching (lessons, tools it writes for itself, the night study). Off unless SELF_LEARNING=on: while it is off
  // none of its tools exist for the model, nothing is added to the prompt, and nothing runs at night.
  learning: ['on', '1', 'true', 'yes'].includes(env('SELF_LEARNING').toLowerCase()),
  // One Hebrew WhatsApp note after a deploy. UPDATE_NOTES=off skips it; anything else (including unset) sends.
  updateNotes: !['off', '0', 'false', 'no'].includes(env('UPDATE_NOTES', 'on').toLowerCase()),
  // Agent mode (src/planner.js): a goal of several stages gets a plan, steps and a check against "done" before the
  // answer. The plan stays to itself by default: a card before the answer splits one reply into two messages.
  // AGENT_SHOW_PLAN=on sends it once in the chat.
  // AGENT_MAX_STEPS: how many model steps a turn with a plan may take (one without a plan keeps the short limit).
  agent: {
    showPlan: ['on', '1', 'true', 'yes'].includes(env('AGENT_SHOW_PLAN').toLowerCase()),
    maxSteps: Number(env('AGENT_MAX_STEPS')) > 0 ? Math.max(6, Math.min(40, Number(env('AGENT_MAX_STEPS')))) : 0,
  },
  // New Classroom assignments prepared by Gemini in its own signed-in browser window (gemini-browser.bat).
  // autowork: auto = start as soon as one arrives, ask = ask in WhatsApp first, off = only when asked.
  // GEMINI_CLOUD: Gemini as one more Chromium on the cloud desktop (signed in there once). On by default when the
  // cloud desktop is on; GEMINI_CLOUD=off turns it off.
  gemini: {
    url: env('GEMINI_URL') || 'https://gemini.google.com/app',
    cloud: env('GEMINI_CLOUD').toLowerCase() !== 'off' && (['1', 'true', 'yes', 'on'].includes(env('GEMINI_CLOUD').toLowerCase()) || ['1', 'true', 'yes', 'on'].includes(env('CLOUD_DESKTOP').toLowerCase())),
    port: Number(env('GEMINI_DEBUG_PORT', '9224')) || 9224,
    timeoutMinutes: Math.max(2, Number(env('GEMINI_TIMEOUT_MINUTES', '15')) || 15),
  },
  // The assistant's own browser for errands (run_errand). In the cloud it is a third Chromium on the
  // shared desktop, profile data/errand-profile, debugging port on 127.0.0.1 only. ERRAND_PROXY
  // defaults to WEBTOP_PROXY; "direct" sends the errand browser out with no proxy.
  errand: {
    port: Number(env('ERRAND_DEBUG_PORT', '9227')) || 9227,
    proxy: env('ERRAND_PROXY'),
  },
  // "תשאל את ג'מיני": Google's Gemini through its official API (key from aistudio.google.com/apikey).
  // Daily encrypted backup to the owner's Google Drive (src/backup.js).
  backup: { passphrase: process.env.BACKUP_PASSPHRASE || '', account: env('BACKUP_GOOGLE_ACCOUNT').toLowerCase() },
  geminiApi: { key: env('GEMINI_API_KEY'), model: env('GEMINI_MODEL', 'gemini-2.5-flash') },
  // Bird (bird.com): an extra WhatsApp Business send path (src/bird.js). Off unless BIRD_ENABLED=true.
  // The personal WhatsApp link stays on Baileys. A key without the flag does not turn this on.
  // BIRD_WHATSAPP_FROM is the connected business number; it may stay empty for a Bird-managed template.
  bird: { enabled: env('BIRD_ENABLED') === 'true', key: env('BIRD_API_KEY'), from: env('BIRD_WHATSAPP_FROM'), webhookSecret: env('BIRD_WEBHOOK_SECRET'), owner: env('BIRD_OWNER_NUMBER') },
  classroomWork: {
    mode: ['auto', 'ask', 'off'].includes(env('CLASSROOM_AUTOWORK', 'auto')) ? env('CLASSROOM_AUTOWORK', 'auto') : 'auto',
    maxMb: Math.max(1, Number(env('CLASSROOM_MAX_MB', '50')) || 50),
  },
  // The assistant's own Linux machine in VirtualBox (see src/vm.js).
  vm: { name: env('VM_NAME', 'helper-box'), port: Number(env('VM_SSH_PORT', '2222')) || 2222, user: env('VM_USER', 'helper') },
  // Tools that always wait for the user's "yes" in the chat before they run, however they were called.
  // Typing, key presses and unlocking amount to running commands; the clipboard may hold a password.
  confirmAlways: env('CONFIRM_ALWAYS', 'pc_type,pc_press_key,pc_unlock,pc_clipboard_get,pc_clipboard_set').split(',').map((s) => s.trim()).filter(Boolean),
  // Turning the PC on (src/wake.js). mac is the PC's network card; relayTopic and secret pair this program with
  // home-relay/wake-relay.mjs when it runs somewhere that cannot reach the home network directly.
  wake: {
    mac: env('WAKE_MAC'),
    broadcast: env('WAKE_BROADCAST'),
    relayTopic: env('WAKE_RELAY_TOPIC'),
    secret: env('WAKE_SECRET'),
    relayBase: env('WAKE_RELAY_BASE', 'https://ntfy.sh').replace(/\/+$/, ''),
  },
  imageModel: env('IMAGE_MODEL'),
  mail: {
    accounts: mailAccounts(),
    pollMinutes: Math.max(2, Number(env('MAIL_POLL_MINUTES', '10')) || 10),
  },
  calendarUrl: env('CALENDAR_ICS_URL'),
  computerMode: ['off', 'ask', 'auto'].includes(env('COMPUTER_MODE', 'ask')) ? env('COMPUTER_MODE', 'ask') : 'ask',
  // Android phone over ADB. The tailnet is reached through PHONE_PROXY (SOCKS5). ask: reads run, writes need כן.
  // ask-writes is the same. ask-all also asks before a screenshot. auto runs writes; dangerous shell still asks. off hides the tools.
  phone: {
    host: env('PHONE_ADB_HOST'),
    proxy: env('PHONE_PROXY'),
    mode: ['off', 'ask', 'ask-writes', 'ask-all', 'auto'].includes(env('PHONE_MODE', 'ask')) ? env('PHONE_MODE', 'ask') : 'ask',
  },
  // Home PC bridge (src/pc-bridge.js). The cloud listens; the Windows PC dials out. Empty secret = computer tools stay local-only.
  pcBridge: {
    secret: env('PC_BRIDGE_SECRET'),
    port: Number(env('PC_BRIDGE_PORT', '0')) || 0,
    url: env('PC_BRIDGE_URL'),
  },
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
