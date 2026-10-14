// The settings site: a local page for connecting accounts, changing preferences and seeing what the assistant
// is doing. It listens on this computer only (127.0.0.1) and needs the token from the address the assistant prints.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { config, saveSettings, mailEnabled, ROOT, DATA_DIR } from './config.js'
import { state, save } from './store.js'
import { googleAccounts, authUrl, connectWithCode, removeAccount } from './google.js'
import { calendarOn } from './calendar.js'
import { canHear, canSpeak } from './media.js'
import { chatModel } from './llm.js'
import { ago } from './status.js'

const PAGE = path.join(ROOT, 'src', 'ui.html')
const SENT_LOG = path.join(DATA_DIR, 'sent.log')
const COOKIE = 'helper_session'
const MAX_BODY = 100000

// Values that are never sent back to the page. The page only learns whether each one is set.
const SECRETS = ['LLM_API_KEY', 'ELEVENLABS_API_KEY', 'GITHUB_TOKEN', 'GOOGLE_CLIENT_SECRET', 'MAIL_PASS', 'TAVILY_API_KEY', 'VOICE_API_KEY', 'EMBEDDING_API_KEY']
const PLAIN = [
  'LLM_BASE_URL', 'LLM_MODEL', 'LLM_CHEAP_MODEL', 'LLM_STRONG_MODEL', 'LLM_FALLBACK_MODEL', 'LLM_LIGHT', 'IMAGE_MODEL',
  'BOT_NAME', 'QUIET_HOURS', 'DAILY_BRIEF_TIME', 'NEWS_BRIEF_TIME', 'NEWS_FEEDS', 'TIMEZONE', 'COMPUTER_MODE',
  'ELEVENLABS_VOICE_ID', 'ELEVENLABS_TTS_MODEL', 'GOOGLE_CLIENT_ID', 'GOOGLE_READONLY_ACCOUNTS',
  'MAIL_HOST', 'MAIL_USER', 'MAIL_POLL_MINUTES', 'CALENDAR_ICS_URL',
  'EMBEDDING_MODEL', 'EMBEDDING_BASE_URL', 'BROWSER_SHOW', 'BROWSER_VISION',
  'CHECK_IN_PER_DAY', 'CHECK_IN_EVERY_MINUTES', 'PREP_TIME', 'WEATHER_LOCATION',
]
// Settings the initiative also takes from chat (src/initiative.js), and the field each is kept under there.
const INITIATIVE_KEYS = { CHECK_IN_PER_DAY: 'perDay', CHECK_IN_EVERY_MINUTES: 'everyMinutes', PREP_TIME: 'prepTime', WEATHER_LOCATION: 'location' }
// Read once at startup, so a change only takes effect after a restart.
const NEEDS_RESTART = ['TIMEZONE', 'LLM_LIGHT', 'MAIL_HOST', 'MAIL_USER', 'MAIL_PASS']
const LISTS = { reminder: 'reminders', task: 'tasks', watcher: 'watchers', memory: 'memory' }

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const time = (iso) => new Date(iso).toLocaleString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })

function snapshot(connectedSince) {
  const health = (label, key) => {
    const h = state.health[key]
    // ok is null until the first check has run: not yet known is different from broken.
    return { label, ok: h ? !h.down : null, checked: h ? ago(h.lastOk) : 'עוד לא נבדק' }
  }
  const google = googleAccounts()
  return {
    botName: config.botName,
    whatsapp: { connected: Boolean(connectedSince), since: connectedSince ? ago(connectedSince).replace('לפני ', '') : '', paired: Boolean(state.owner) },
    model: chatModel(),
    voice: { hear: canHear(), speak: canSpeak() },
    google: { configured: Boolean(config.google.clientId && config.google.clientSecret), accounts: google.map((email) => ({ email, readOnly: config.google.readOnly.includes(email.toLowerCase()) })) },
    settings: Object.fromEntries([...PLAIN.map((k) => [k, process.env[k] || '']), ...SECRETS.map((k) => [k, { set: Boolean(process.env[k]) }])]),
    sources: [
      ...google.flatMap((a) => [health(`Gmail ${a}`, `gmail ${a}`), health(`Classroom ${a}`, `classroom ${a}`)]),
      ...(mailEnabled() ? config.mail.accounts.map((a) => health(`מייל ${a.user}`, `mail ${a.user}`)) : []),
      ...(calendarOn() ? [{ label: 'יומן', ok: true, checked: ago(state.calendar.lastPoll) }] : []),
    ],
    reminders: state.reminders.map((r) => ({ id: r.id, text: r.text, when: time(r.at), repeat: r.repeat })),
    tasks: state.tasks.map((t) => ({ id: t.id, text: t.instruction, when: time(t.at), repeat: t.repeat })),
    watchers: state.watchers.map((w) => ({ id: w.id, text: w.name, value: w.lastValue, url: w.url, ok: (w.fails || 0) < 3, checked: ago(w.lastOk), every: w.intervalMin })),
    memory: state.memory.map((m) => ({ id: m.id, text: m.fact })),
    homework: state.homework.open,
    waiting: state.outbox.length,
    sent: fs.existsSync(SENT_LOG) ? fs.readFileSync(SENT_LOG, 'utf8').trim().split('\n').slice(-40).reverse() : [],
  }
}

// { connectedSince(): number, restart(): void }
export function startUi({ connectedSince, restart }) {
  const token = (state.uiToken ||= randomBytes(24).toString('hex'))
  save()
  const port = config.uiPort
  const origin = `http://127.0.0.1:${port}`
  const oauthStates = new Set()

  const send = (res, status, body, headers = {}) => {
    const json = typeof body !== 'string'
    res.writeHead(status, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', ...headers })
    res.end(json ? JSON.stringify(body) : body)
  }
  const note = (text) => `<body dir="rtl" style="font-family:system-ui;padding:48px;background:#faf8f5;color:#222"><h2>${text}</h2></body>`
  const signedIn = (req) => (req.headers.cookie || '').split(/;\s*/).some((c) => c.startsWith(COOKIE + '=') && same(c.slice(COOKIE.length + 1), token))

  async function readJson(req) {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > MAX_BODY) throw new Error('גוף הבקשה גדול מדי')
    }
    return JSON.parse(raw || '{}')
  }

  async function api(route, body) {
    if (route === 'settings') {
      const updates = {}
      for (const [key, value] of Object.entries(body.set || {})) {
        if (!PLAIN.includes(key) && !SECRETS.includes(key)) throw new Error(`הגדרה לא מוכרת: ${key}`)
        // An empty secret field means "leave it as it is"; removing one is the explicit `clear` below.
        if (SECRETS.includes(key) && !String(value).trim()) continue
        updates[key] = value
      }
      for (const key of body.clear || []) if (SECRETS.includes(key)) updates[key] = ''
      saveSettings(updates)
      // The same settings can be changed in chat, and a chat change wins; a change made here replaces it.
      for (const [key, field] of Object.entries(INITIATIVE_KEYS)) if (key in updates && state.initiative) delete state.initiative[field]
      save()
      return { saved: Object.keys(updates), restart: Object.keys(updates).some((k) => NEEDS_RESTART.includes(k)) }
    }
    if (route === 'google/remove') return await removeAccount(String(body.email)), {}
    if (route === 'google/readonly') {
      const email = String(body.email).toLowerCase()
      const list = new Set(config.google.readOnly)
      body.readOnly ? list.add(email) : list.delete(email)
      saveSettings({ GOOGLE_READONLY_ACCOUNTS: [...list].join(',') })
      return {}
    }
    if (route === 'delete') {
      const list = LISTS[body.kind]
      if (!list) throw new Error('סוג לא מוכר')
      state[list] = state[list].filter((x) => x.id !== Number(body.id))
      save()
      return {}
    }
    if (route === 'restart') return setTimeout(restart, 300), {}
    throw Object.assign(new Error('לא נמצא'), { status: 404 })
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Only requests addressed to this machine by its loopback name: closes the door on DNS-rebinding tricks.
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(res, 403, note('גישה נדחתה'))
      const url = new URL(req.url, origin)

      if (url.pathname === '/google/callback') {
        const oauthState = url.searchParams.get('state') || ''
        if (!oauthStates.delete(oauthState)) return send(res, 403, note('הבקשה פגה. חזור לאתר ההגדרות ונסה שוב.'))
        if (url.searchParams.has('error')) return send(res, 200, note(`החיבור בוטל: ${url.searchParams.get('error')}`))
        try {
          const email = await connectWithCode(url.searchParams.get('code'), `${origin}/google/callback`)
          console.log(`[ui] חשבון Google חובר: ${email}`)
          return send(res, 302, '', { Location: '/?connected=' + encodeURIComponent(email) })
        } catch (e) {
          return send(res, 200, note(`החיבור נכשל: ${e.message}`))
        }
      }

      // First visit carries the token in the address; it is swapped for a cookie and dropped from the URL.
      if (url.pathname === '/' && url.searchParams.has('t')) {
        if (!same(url.searchParams.get('t'), token)) return send(res, 403, note('הקישור לא תקף. העתק את הכתובת מחלון העוזר.'))
        return send(res, 302, '', { Location: '/', 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` })
      }
      if (!signedIn(req)) return send(res, 403, note('כדי להיכנס, פתח את הכתובת שמופיעה בחלון של העוזר.'))

      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(PAGE, 'utf8'))
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshot(connectedSince()))
      if (req.method === 'GET' && url.pathname === '/google/connect') {
        if (!config.google.clientId || !config.google.clientSecret) return send(res, 200, note('קודם צריך לשמור Client ID ו-Client secret.'))
        const oauthState = randomBytes(16).toString('hex')
        oauthStates.add(oauthState)
        return send(res, 302, '', { Location: authUrl(`${origin}/google/callback`, oauthState) })
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        // Changes are accepted only from this page itself, never from another site open in the same browser.
        if (req.headers.origin && ![origin, `http://localhost:${port}`].includes(req.headers.origin)) return send(res, 403, { error: 'מקור לא מורשה' })
        return send(res, 200, await api(url.pathname.slice(5), await readJson(req)))
      }
      send(res, 404, note('לא נמצא'))
    } catch (e) {
      send(res, e.status || 400, { error: e.message })
    }
  })

  server.on('error', (e) => console.log(`[ui] אתר ההגדרות לא עלה: ${e.code === 'EADDRINUSE' ? `הפורט ${port} תפוס. אפשר לשנות UI_PORT בקובץ .env` : e.message}`))
  server.listen(port, '127.0.0.1')
  return `${origin}/?t=${token}`
}
