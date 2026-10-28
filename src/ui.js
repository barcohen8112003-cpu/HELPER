// The settings site: a local page for connecting accounts, changing preferences and seeing what the assistant
// is doing. It listens on this computer only (127.0.0.1) and needs the token from the address the assistant prints.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import QRCode from 'qrcode'
import { config, saveSettings, mailEnabled, ROOT, DATA_DIR } from './config.js'
import { state, save } from './store.js'
import { setWebtopLoginUrl, webtopCloudBlockedNow, WEBTOP_BLOCKED_STATUS } from './session.js'
import { setGoogleHomeLoginUrl } from './google-home.js'
import { captureFrame, ensureCloudBrowser, errandCloudOn, webtopInput } from './webtop-browser.js'
import { desktopShellHtml, isDesktopPath, proxyDesktopHttp, proxyDesktopUpgrade } from './cloud-desktop.js'
import { phoneEnabled, phoneStatus, pairPhone, connectPhone, reconnectPhone, phoneScreenshot, phoneTap, phoneSwipe, phoneTypeText, phoneKey, parseEndpoint, phoneBox } from './phone.js'
import { googleAccounts, authUrl, connectWithCode, removeAccount, checkGoogleAccounts, googleAccountStatus } from './google.js'
import { calendarOn } from './calendar.js'
import { canHear, canSpeak, elevenSpeakMp3, transcribeAudio } from './media.js'
import { chatModel, llmHealth } from './llm.js'
import { ago } from './status.js'
import { handleDashboard } from './dashboard/api.js'
import { handlePhoneUpgrade, phoneAppConnected, phoneAppInfo } from './phone-app.js'
import { bridgeReady, bridgeConnected } from './pc-bridge.js'
import { backupEnabled, backupAccount, runBackup } from './backup.js'
import { metricsSummary } from './metrics.js'
import { handleTvUpgrade } from './tv-app.js'
import { handleBirdWebhook } from './bird.js'
import { fastCommand } from './fast-commands.js'

const PAGE = path.join(ROOT, 'src', 'ui.html')
const WEBTOP_PAGE = path.join(ROOT, 'src', 'webtop.html')
const PHONE_PAGE = path.join(ROOT, 'src', 'phone.html')
const SENT_LOG = path.join(DATA_DIR, 'sent.log')
const COOKIE = 'helper_session'
const MAX_BODY = 100000
// /bridge/ask can carry up to about 20 seconds of 16 kHz speech from the TV.
const MAX_SPEECH_BODY = 1_500_000

// Values that are never sent back to the page. The page only learns whether each one is set.
const SECRETS = ['LLM_API_KEY', 'LLM_BACKUP_API_KEY', 'ELEVENLABS_API_KEY', 'GITHUB_TOKEN', 'GOOGLE_CLIENT_SECRET', 'MAIL_PASS', 'TAVILY_API_KEY', 'VOICE_API_KEY', 'GEMINI_API_KEY', 'BACKUP_PASSPHRASE', 'CLAUDE_CODE_OAUTH_TOKEN', 'BIRD_API_KEY', 'BIRD_WEBHOOK_SECRET']
const PLAIN = [
  'LLM_BASE_URL', 'LLM_MODEL', 'LLM_BACKUP_BASE_URL', 'LLM_BACKUP_MODEL', 'LLM_CHEAP_MODEL', 'LLM_STRONG_MODEL', 'LLM_FALLBACK_MODEL', 'LLM_LIGHT', 'IMAGE_MODEL',
  'GEMINI_MODEL', 'BIRD_WHATSAPP_FROM', 'BIRD_OWNER_NUMBER', 'BACKUP_GOOGLE_ACCOUNT', 'BOT_NAME', 'QUIET_HOURS', 'DAILY_BRIEF_TIME', 'NEWS_BRIEF_TIME', 'NEWS_FEEDS', 'TIMEZONE', 'COMPUTER_MODE',
  'ELEVENLABS_VOICE_ID', 'ELEVENLABS_TTS_MODEL', 'GOOGLE_CLIENT_ID', 'GOOGLE_READONLY_ACCOUNTS',
  'MAIL_HOST', 'MAIL_USER', 'MAIL_POLL_MINUTES', 'CALENDAR_ICS_URL', 'WEEKLY_REVIEW_TIME', 'MESSAGE_BUDGET', 'LLM_PRICES', 'MONTHLY_COST_LIMIT',
]
// Read once at startup, so a change only takes effect after a restart.
const NEEDS_RESTART = ['TIMEZONE', 'LLM_LIGHT', 'MAIL_HOST', 'MAIL_USER', 'MAIL_PASS']
const LISTS = { reminder: 'reminders', task: 'tasks', watcher: 'watchers', memory: 'memory' }

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const time = (iso) => new Date(iso).toLocaleString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })

function getNetworkIp() {
  const interfaces = os.networkInterfaces();
  let tailscaleIp = null;
  let localIp = null;

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
      if (isIPv4 && !iface.internal) {
        if (name.toLowerCase().includes('tailscale') || iface.address.startsWith('100.')) {
          tailscaleIp = iface.address;
        } else if (!localIp) {
          localIp = iface.address;
        }
      }
    }
  }

  return { ip: tailscaleIp || localIp, isTailscale: Boolean(tailscaleIp) };
}

// Address the Android app should dial. Inside Docker, getNetworkIp() is the bridge (172.18.0.2), which a phone
// cannot reach. APP_PUBLIC_URL wins. A set UI_PUBLIC_HOST (host:port, as on the VPS) is next. At home, the LAN or
// Tailscale address on port 3210 is used, the same as before.
export function appConnectTarget({ appPublicUrl = '', uiPublicHost = '', networkIp = '', port = 3210 } = {}) {
  const explicit = String(appPublicUrl || '').trim()
  if (explicit) return explicit
  const host = String(uiPublicHost || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (host) return `http://${host}`
  if (networkIp) return `http://${networkIp}:${port}`
  return ''
}

// One line for a /bridge/ask attempt. Source, status and duration only: never the token or the message text.
export function bridgeAskLog({ source = '-', status = 0, ms = 0 } = {}) {
  const safe = /^[A-Za-z0-9_.-]{1,30}$/.test(String(source)) ? String(source) : '-'
  const code = Number.isFinite(Number(status)) ? Number(status) : 0
  const took = Number.isFinite(Number(ms)) ? Math.max(0, Math.round(Number(ms))) : 0
  return `[bridge] ask source=${safe} status=${code} ms=${took}`
}

// Everything else Helper depends on, each from its own live signal rather than from a stored setting.
// ok: true works, false broken, null not known yet. `note` says what to do when it is broken.
function liveSources(googleLive) {
  const out = []
  const model = llmHealth()
  const modelBroken = model.errorAt > model.okAt && Date.now() - model.errorAt < 30 * 60000
  out.push({
    label: 'מודל AI',
    ok: model.okAt || model.errorAt ? !modelBroken : null,
    checked: model.okAt ? ago(model.okAt) : 'עוד לא נבדק',
    note: modelBroken ? model.error : model.limited.length ? `במכסה כרגע: ${model.limited.join(', ')}` : '',
  })
  for (const [email, live] of Object.entries(googleLive))
    if (live) out.push({ label: `Google ${email}`, ok: live.ok, checked: ago(live.at), note: live.ok ? '' : 'צריך לחבר מחדש (Google Workspace, "חבר מחדש")' })
  if (state.health.webtop) {
    const w = state.health.webtop
    out.push({ label: 'Webtop', ok: !w.down, checked: ago(w.lastOk), note: w.down ? 'צריך להיכנס שוב בחלון ה-Webtop' : '' })
  }
  if (backupEnabled()) {
    const b = state.backup || {}
    const stale = !b.lastOk || Date.now() - b.lastOk > 36 * 3600 * 1000
    out.push({ label: `גיבוי ל-Drive (${backupAccount()})`, ok: b.lastOk || b.fails ? !(b.fails && stale) : null, checked: b.lastOk ? ago(b.lastOk) : 'עוד לא גובה', note: b.lastError || '' })
  }
  if (bridgeReady()) out.push({ label: 'המחשב הביתי', ok: bridgeConnected(), checked: 'עכשיו', note: bridgeConnected() ? '' : 'הגשר בבית לא מחובר. המחשב כבוי, או ש-pc-bridge לא רץ' })
  if (phoneEnabled() || phoneAppInfo()) out.push({ label: 'הטלפון', ok: phoneAppConnected(), checked: 'עכשיו', note: phoneAppConnected() ? '' : 'אפליקציית HELPER בטלפון לא מחוברת' })
  return out
}

async function snapshot(connectedSince) {
  const health = (label, key) => {
    const h = state.health[key]
    // ok is null until the first check has run: not yet known is different from broken.
    return { label, ok: h ? !h.down : null, checked: h ? ago(h.lastOk) : 'עוד לא נבדק' }
  }
  const google = googleAccounts()
  // Tested against Google itself (cached for a few minutes), so the page never shows "connected" for an expired key.
  if (config.google.clientId && config.google.clientSecret) await Promise.race([checkGoogleAccounts(), new Promise((r) => setTimeout(r, 8000))])
  const googleLive = Object.fromEntries(google.map((email) => [email, googleAccountStatus(email)]))
  const { ip, isTailscale } = getNetworkIp()
  const appUrl = appConnectTarget({
    appPublicUrl: process.env.APP_PUBLIC_URL,
    uiPublicHost: process.env.UI_PUBLIC_HOST,
    networkIp: ip,
  })
  let appQrDataUrl = ''
  if (appUrl && state.bridgeToken) {
    try {
      const qrData = JSON.stringify({ url: appUrl, token: state.bridgeToken })
      appQrDataUrl = await QRCode.toDataURL(qrData)
    } catch (e) {
      console.error('[ui] QR generation failed:', e.message)
    }
  }

  return {
    botName: config.botName,
    whatsapp: { connected: Boolean(connectedSince), since: connectedSince ? ago(connectedSince).replace('לפני ', '') : '', paired: Boolean(state.owner) },
    model: chatModel(),
    voice: { hear: canHear(), speak: canSpeak() },
    google: { configured: Boolean(config.google.clientId && config.google.clientSecret), accounts: google.map((email) => ({ email, readOnly: config.google.readOnly.includes(email.toLowerCase()), live: googleLive[email] ? { ok: googleLive[email].ok, error: googleLive[email].error || '', checked: ago(googleLive[email].at) } : null })) },
    settings: Object.fromEntries([...PLAIN.map((k) => [k, process.env[k] || '']), ...SECRETS.map((k) => [k, { set: Boolean(process.env[k]) }])]),
    sources: [
      ...google.flatMap((a) => [health(`Gmail ${a}`, `gmail ${a}`), health(`Classroom ${a}`, `classroom ${a}`)]),
      ...(mailEnabled() ? config.mail.accounts.map((a) => health(`מייל ${a.user}`, `mail ${a.user}`)) : []),
      ...(calendarOn() ? [{ label: 'יומן', ok: true, checked: ago(state.calendar.lastPoll) }] : []),
      ...liveSources(googleLive),
    ],
    reminders: state.reminders.map((r) => ({ id: r.id, text: r.text, when: time(r.at), repeat: r.repeat })),
    tasks: state.tasks.map((t) => ({ id: t.id, text: t.instruction, when: time(t.at), repeat: t.repeat })),
    watchers: state.watchers.map((w) => ({ id: w.id, text: w.name, value: w.lastValue, url: w.url, ok: (w.fails || 0) < 3, checked: ago(w.lastOk), every: w.intervalMin })),
    memory: state.memory.map((m) => ({ id: m.id, text: m.fact })),
    homework: state.homework.open,
    waiting: state.outbox.length,
    metrics: metricsSummary(),
    sent: fs.existsSync(SENT_LOG) ? fs.readFileSync(SENT_LOG, 'utf8').trim().split('\n').slice(-40).reverse() : [],
    appQrDataUrl,
    appUrl,
    appIp: ip,
    isTailscale,
    // The bridge token is returned only with the signed-in settings state. The page masks it until "הצג".
    bridgeToken: state.bridgeToken || '',
    webtop: {
      enabled: Boolean(config.webtop.url),
      cloud: config.webtop.cloud,
      url: config.webtop.url,
      loginPath: '/webtop',
      blocked: webtopCloudBlockedNow(),
      blockedStatus: WEBTOP_BLOCKED_STATUS,
    },
    googleHome: { cloud: config.googleHome.cloud, loginPath: '/google-home' },
    phone: { enabled: phoneEnabled(), host: phoneBox().host || config.phone.host, mode: config.phone.mode, loginPath: '/phone' },
    desktop: { enabled: config.desktop.enabled, path: '/desktop/' },
    errand: { enabled: errandCloudOn(), path: '/errand' },
  }
}

// Host and Origin allow-lists. UI_PUBLIC_HOST (for example "37.60.240.231:3210") is added only when set.
// Loopback stays allowed either way. extraHosts is the machine's own LAN address, same as before.
export function uiPolicy(port = config.uiPort, env = process.env, extraHosts = []) {
  const pub = String(env.UI_PUBLIC_HOST || '').trim()
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...extraHosts.filter(Boolean)]
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
  if (pub) {
    hosts.push(pub)
    origins.push(`http://${pub}`)
  }
  return { hosts, origins, publicBase: pub ? `http://${pub}` : `http://127.0.0.1:${port}` }
}

// The startup banner must not print the sign-in token. The full address stays in the return value and in the prompt.
export function maskSettingsUrl(url) {
  return String(url || '').replace(/([?&]t=)([^&\s#]+)/g, (_, key, token) => `${key}…${token.slice(-4)}`)
}

// { connectedSince(): number, restart(): void }
// agent(text, { voice, source }) => Promise<string>: optional; enables the bridge for other local programs.
export function startUi({ connectedSince, restart, agent }) {
  const token = (state.uiToken ||= randomBytes(24).toString('hex'))
  const bridgeToken = (state.bridgeToken ||= randomBytes(24).toString('hex'))
  save()
  const port = config.uiPort
  const policy = () => {
    const { ip: networkIp } = getNetworkIp()
    return uiPolicy(port, process.env, networkIp ? [`${networkIp}:${port}`] : [])
  }
  const origin = `http://127.0.0.1:${port}`
  const oauthStates = new Set()
  setWebtopLoginUrl(() => `${policy().publicBase}/webtop?t=${token}`)
  setGoogleHomeLoginUrl(() => `${policy().publicBase}/google-home?t=${token}`)

  const send = (res, status, body, headers = {}) => {
    const json = typeof body !== 'string'
    res.writeHead(status, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', ...headers })
    res.end(json ? JSON.stringify(body) : body)
  }
  const note = (text) => `<body dir="rtl" style="font-family:system-ui;padding:48px;background:#faf8f5;color:#222"><h2>${text}</h2></body>`
  const signedIn = (req) => (req.headers.cookie || '').split(/;\s*/).some((c) => c.startsWith(COOKIE + '=') && same(c.slice(COOKIE.length + 1), token))

  async function readJson(req, max = MAX_BODY) {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > max) throw new Error('גוף הבקשה גדול מדי')
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
    if (route === 'backup/now') return { message: await runBackup() }
    if (route === 'restart') return setTimeout(restart, 300), {}
    if (route === 'webtop/input') return await webtopInput(body)
    if (route === 'phone/pair') {
      const ep = parseEndpoint(body.endpoint, phoneBox().host || config.phone.host)
      if (!ep) throw new Error('צריך פורט צימוד, למשל 100.110.143.89:37123')
      return pairPhone({ ...ep, code: String(body.code || '').trim() })
    }
    if (route === 'phone/connect') {
      const ep = parseEndpoint(body.endpoint, phoneBox().host || config.phone.host)
      if (!ep) throw new Error('צריך פורט חיבור, למשל 100.110.143.89:41234')
      return connectPhone(ep)
    }
    if (route === 'phone/reconnect') return reconnectPhone()
    if (route === 'phone/tap') {
      await phoneTap(body)
      return { ok: true }
    }
    if (route === 'phone/swipe') {
      await phoneSwipe(body)
      return { ok: true }
    }
    if (route === 'phone/type') {
      await phoneTypeText(body.text)
      return { ok: true }
    }
    if (route === 'phone/key') {
      await phoneKey(body.key)
      return { ok: true }
    }
    throw Object.assign(new Error('לא נמצא'), { status: 404 })
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin)

      // Bird (WhatsApp business number): signed deliveries, no token. The signature is the authentication.
      if (req.method === 'POST' && url.pathname === '/bird/webhook') {
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 200_000) return send(res, 413, { error: 'too large' })
        }
        const out = await handleBirdWebhook(raw, req.headers, { agent })
        return send(res, out.status, out.body)
      }
      // Bridge endpoints use bearer token authentication and can be accessed from network interfaces (Tailscale/LAN).
      if (req.method === 'POST' && url.pathname === '/bridge/pull') {
        const given = (req.headers.authorization || '').replace(/^Bearer /, '')
        if (!same(given, bridgeToken)) return send(res, 403, { error: 'bridge token missing or wrong' })
        const items = state.discordOutbox
        const firstContact = !state.bridgeSeenAt
        state.bridgeSeenAt = Date.now()
        if (items.length || firstContact) {
          state.discordOutbox = []
          save()
        }
        return send(res, 200, { items })
      }
      if (req.method === 'POST' && url.pathname === '/bridge/ask') {
        const started = Date.now()
        let status = 500
        let source = '-'
        try {
          state.bridgeSeenAt = Date.now()
          const given = (req.headers.authorization || '').replace(/^Bearer /, '')
          if (!agent || !same(given, bridgeToken)) {
            status = 403
            return send(res, 403, { error: 'bridge token missing or wrong' })
          }
          const body = await readJson(req, MAX_SPEECH_BODY)
          source = String(body.source || 'discord').slice(0, 30)
          // The TV sends its microphone recording instead of text: HELPER transcribes it, like a WhatsApp voice note.
          let heard = null
          if (body.speech && typeof body.speech === 'string') {
            if (!canHear()) {
              status = 400
              return send(res, 400, { error: 'תמלול לא מוגדר ב-HELPER (STT_MODEL או ElevenLabs בקובץ .env)' })
            }
            const audioIn = Buffer.from(body.speech.slice(0, 8_000_000), 'base64')
            heard = await transcribeAudio(audioIn, String(body.speechMime || 'audio/wav'))
          }
          const text = String(heard ?? body.text ?? '').trim().slice(0, 4000)
          if (!text) {
            status = 400
            return send(res, 400, { error: 'empty text' })
          }
          // A plain "turn on the lights" is carried out at once, with no model and no wait behind a running turn.
          const quick = await fastCommand(text)
          const reply = quick ? quick.reply : await agent(text, { voice: Boolean(body.voice), source })
          // Speech costs ElevenLabs credits, so a client that only shows text (the app's chat) asks for none: "audio": false.
          let audio = null
          if (body.audio !== false) {
            try {
              const audioBuffer = await elevenSpeakMp3(reply)
              if (audioBuffer) audio = audioBuffer.toString('base64')
            } catch (e) {
              console.error('[ui] ElevenLabs audio generation failed:', e.message)
            }
          }
          status = 200
          return send(res, 200, { reply, audio, heard })
        } catch (e) {
          status = e.status || 400
          throw e
        } finally {
          console.log(bridgeAskLog({ source, status, ms: Date.now() - started }))
        }
      }
      if (req.method === 'POST' && url.pathname === '/bridge/tts') {
        state.bridgeSeenAt = Date.now()
        const given = (req.headers.authorization || '').replace(/^Bearer /, '')
        if (!same(given, bridgeToken)) return send(res, 403, { error: 'bridge token missing or wrong' })
        const body = await readJson(req)
        const text = String(body.text || '').trim().slice(0, 2000)
        if (!text) return send(res, 400, { error: 'empty text' })
        try {
          const mp3 = await elevenSpeakMp3(text)
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3.length })
          return res.end(mp3)
        } catch (e) {
          return send(res, 500, { error: e.message })
        }
      }

      // Web settings UI is loopback, this machine's own address, or UI_PUBLIC_HOST. Anything else is rejected
      // so a DNS-rebinding page cannot call the API.
      const access = policy()
      const host = req.headers.host || ''
      if (!access.hosts.includes(host)) return send(res, 403, note('גישה נדחתה'))

      // Google sends the browser back here after the account was approved. It comes before the sign-in check on
      // purpose: the one-time `state` was issued only to a signed-in page, so it is what proves the request is ours.
      if (url.pathname === '/google/callback') {
        const oauthState = url.searchParams.get('state') || ''
        if (!oauthStates.delete(oauthState)) return send(res, 403, note('הבקשה פגה. חזור לאתר ההגדרות ונסה שוב.'))
        if (url.searchParams.has('error')) return send(res, 200, note(`החיבור בוטל: ${url.searchParams.get('error')}`))
        try {
          const email = await connectWithCode(url.searchParams.get('code'), `${access.publicBase}/google/callback`)
          console.log(`[ui] חשבון Google חובר: ${email}`)
          return send(res, 302, '', { Location: '/?connected=' + encodeURIComponent(email) })
        } catch (e) {
          return send(res, 200, note(`החיבור נכשל: ${e.message}`))
        }
      }

      // First visit carries the token in the address; it is swapped for a cookie and dropped from the URL.
      // WhatsApp and other apps open that link as a cross-site top-level navigation. SameSite=Strict is
      // not sent on the 302 follow to dest, so the next GET looks signed out. Lax is sent on that GET.
      // Cross-site POSTs still omit the cookie, and the Origin allow-list rejects a foreign page anyway.
      const desktopEntry = isDesktopPath(url.pathname)
      if ((url.pathname === '/' || url.pathname === '/webtop' || url.pathname === '/google-home' || url.pathname === '/phone' || url.pathname === '/errand' || desktopEntry) && url.searchParams.has('t')) {
        if (!same(url.searchParams.get('t'), token)) return send(res, 403, note('הקישור לא תקף. העתק את הכתובת מחלון העוזר.'))
        const dest = desktopEntry ? '/desktop/' : (url.pathname === '/' ? '/' : url.pathname)
        return send(res, 302, '', { Location: dest, 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000` })
      }
      if (!signedIn(req)) return send(res, 403, note('כדי להיכנס, פתח את הכתובת שמופיעה בחלון של העוזר.'))
      if (desktopEntry) {
        if (!config.desktop.enabled) return send(res, 503, note('שולחן העבודה בענן כבוי.'))
        const mappedShell = url.pathname === '/desktop' || url.pathname === '/desktop/'
        if (mappedShell) return send(res, 200, desktopShellHtml())
        return proxyDesktopHttp(req, res, config.desktop.upstream)
      }
      // The dashboard (/dash) is read-only and uses the same sign-in as everything below.
      if (await handleDashboard(req, res, url, signedIn)) return

      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(PAGE, 'utf8'))
      if (req.method === 'GET' && (url.pathname === '/webtop' || url.pathname === '/google-home' || url.pathname === '/errand')) {
        if (url.pathname === '/errand') ensureCloudBrowser('errand').catch(() => {})
        return send(res, 200, fs.readFileSync(WEBTOP_PAGE, 'utf8'))
      }
      if (req.method === 'GET' && url.pathname === '/phone') return send(res, 200, fs.readFileSync(PHONE_PAGE, 'utf8'))
      if (req.method === 'GET' && url.pathname === '/api/phone/status') return send(res, 200, await phoneStatus())
      if (req.method === 'GET' && url.pathname === '/api/phone/frame') {
        try {
          const shot = await phoneScreenshot()
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': shot.buffer.length })
          return res.end(shot.buffer)
        } catch (e) {
          return send(res, 503, { error: e.message })
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/webtop/frame') {
        try {
          const asked = url.searchParams.get('site')
          const frame = await captureFrame(asked === 'google-home' || asked === 'errand' ? asked : 'webtop')
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': frame.jpeg.length })
          return res.end(frame.jpeg)
        } catch (e) {
          return send(res, 503, { error: e.message })
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, await snapshot(connectedSince()))
      if (req.method === 'GET' && url.pathname === '/google/connect') {
        if (!config.google.clientId || !config.google.clientSecret) return send(res, 200, note('קודם צריך לשמור Client ID ו-Client secret.'))
        const oauthState = randomBytes(16).toString('hex')
        oauthStates.add(oauthState)
        return send(res, 302, '', { Location: authUrl(`${access.publicBase}/google/callback`, oauthState) })
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        // Changes are accepted only from this page itself, never from another site open in the same browser.
        if (req.headers.origin && !access.origins.includes(req.headers.origin)) return send(res, 403, { error: 'מקור לא מורשה' })
        return send(res, 200, await api(url.pathname.slice(5), await readJson(req)))
      }
      send(res, 404, note('לא נמצא'))
    } catch (e) {
      send(res, e.status || 400, { error: e.message })
    }
  })

  server.on('upgrade', (req, socket, head) => {
    // The HELPER app's phone link, like the other bridge endpoints: any interface, bridge token only.
    if ((req.url || '').split('?')[0] === '/bridge/phone') {
      return handlePhoneUpgrade(req, socket, head, (r) => same((r.headers.authorization || '').replace(/^Bearer /, ''), bridgeToken))
    }
    // The HELPER home screen on the TV (tv/launcher), the same way.
    if ((req.url || '').split('?')[0] === '/bridge/tv') {
      return handleTvUpgrade(req, socket, head, (r) => same((r.headers.authorization || '').replace(/^Bearer /, ''), bridgeToken))
    }
    const host = req.headers.host || ''
    const access = policy()
    const fail = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
    }
    if (!access.hosts.includes(host)) return fail(403, 'Forbidden')
    let pathname = '/'
    try { pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname } catch { /* keep / */ }
    if (!isDesktopPath(pathname)) return fail(404, 'Not Found')
    if (!config.desktop.enabled || !signedIn(req)) return fail(403, 'Forbidden')
    proxyDesktopUpgrade(req, socket, head, config.desktop.upstream)
  })
  server.on('error', (e) => console.log(`[ui] אתר ההגדרות לא עלה: ${e.code === 'EADDRINUSE' ? `הפורט ${port} תפוס. אפשר לשנות UI_PORT בקובץ .env` : e.message}`))
  server.listen(port, '0.0.0.0')
  return `${policy().publicBase}/?t=${token}`
}
