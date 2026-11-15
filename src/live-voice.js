// Live voice: a LiveKit room the owner joins from the phone, the TV browser, or a WhatsApp link.
// Off unless LIVE_VOICE=on and the LiveKit key pair is set, so a deploy with no new secrets changes nothing.
// The audio worker (voice/agent.py, LiveKit Agents) is a separate container. This module mints join tokens,
// decides Hebrew speech, and keeps the tool turn on the same approval path as WhatsApp.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { AccessToken, RoomAgentDispatch, RoomConfiguration, TokenVerifier } from 'livekit-server-sdk'
import { hebrewVoice, normalizeRate, ttsProvider, voiceFor } from './tts.js'

const ON = new Set(['on', '1', 'true', 'yes'])
const IDENTITIES = new Set(['phone', 'browser'])
const ROOM = 'helper'
const AGENT_IDENTITY = 'helper-voice'

const CALLS = new Set([
  'תתקשר אליי',
  'תתקשר אלי',
  'התקשר אליי',
  'התקשר אלי',
  'תתקשרי אליי',
  'תתקשרי אלי',
  'שיחה חיה',
  'בוא נדבר',
  'בואי נדבר',
  'call me',
])

const trim = (v) => String(v || '').trim()
const digitsOf = (v) => String(v || '').replace(/\D/g, '')
const digitList = (v) => String(v || '').split(',').map(digitsOf).filter(Boolean)

// LiveKit Cloud (wss://….livekit.cloud) is reached directly. The docker server stays behind HELPER's proxy.
export function isCloudUrl(url) {
  try {
    const u = new URL(String(url || ''))
    return u.protocol === 'wss:' && u.hostname.endsWith('.livekit.cloud')
  } catch {
    return false
  }
}

// Who may talk to HELPER on the phone number. Israeli 05x and +9725x are the same number.
export function phoneKey(v) {
  let d = digitsOf(v)
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('0') && d.length === 10) d = '972' + d.slice(1)
  return d
}

export function callerAllowed(caller, ownerDigits, env = process.env) {
  const who = phoneKey(caller)
  if (!who) return false
  const allowed = [ownerDigits, ...liveVoiceFrom(env).phoneAllow].map(phoneKey).filter(Boolean)
  return allowed.includes(who)
}

export function liveVoiceFrom(env = process.env) {
  const enabled = ON.has(trim(env.LIVE_VOICE).toLowerCase())
  const apiKey = trim(env.LIVEKIT_API_KEY)
  const apiSecret = trim(env.LIVEKIT_API_SECRET)
  const ready = enabled && Boolean(apiKey && apiSecret)
  let reason = ''
  if (!enabled) reason = 'LIVE_VOICE כבוי. ב-.env שמים LIVE_VOICE=on, ואז מפעילים את הפרופיל live-voice.'
  else if (!apiKey || !apiSecret) reason = 'חסרים LIVEKIT_API_KEY ו-LIVEKIT_API_SECRET. בלי הזוג הזה אי אפשר להיכנס לשיחה.'
  return {
    enabled,
    ready,
    reason,
    apiKey,
    apiSecret,
    url: trim(env.LIVEKIT_URL) || 'ws://livekit:7880',
    // Set when the worker registers under a name (LiveKit Cloud phone numbers dispatch by name).
    agentName: trim(env.LIVE_VOICE_AGENT_NAME),
    // Extra numbers allowed to call in, besides the owner's WhatsApp number. Digits, comma separated.
    phoneAllow: digitList(env.LIVE_VOICE_PHONE_ALLOW),
    room: trim(env.LIVE_VOICE_ROOM) || ROOM,
    nodeIp: trim(env.LIVEKIT_NODE_IP),
    udpStart: Number(env.LIVEKIT_UDP_START) || 50000,
    udpEnd: Number(env.LIVEKIT_UDP_END) || 50019,
    tcpPort: Number(env.LIVEKIT_TCP_PORT) || 7881,
    edgeVoice: hebrewVoice(env),
    edgeRate: normalizeRate(env.EDGE_TTS_RATE),
    ttsProvider: ttsProvider(env),
    elevenKey: trim(env.ELEVENLABS_API_KEY),
    elevenVoice: trim(env.ELEVENLABS_VOICE_ID),
    elevenModel: trim(env.ELEVENLABS_TTS_MODEL) || 'eleven_v3',
  }
}

// What the signed-in settings page may show. No keys.
export function liveVoiceStatus(env = process.env) {
  const cfg = liveVoiceFrom(env)
  return {
    enabled: cfg.enabled,
    ready: cfg.ready,
    reason: cfg.ready ? '' : cfg.reason,
    path: '/live',
    udp: `${cfg.udpStart}-${cfg.udpEnd}`,
    tcp: cfg.tcpPort,
    nodeIp: cfg.nodeIp,
    eleven: Boolean(cfg.elevenKey && cfg.elevenVoice),
    provider: cfg.ttsProvider,
    edgeVoice: cfg.edgeVoice,
    edgeRate: cfg.edgeRate,
  }
}

export const LIVE_NOTE = '[שיחה חיה. התשובה תוקרא בקול: משפט או שניים, בלי עיצוב, בלי אימוג\'י, בלי קישורים ובלי רשימות. פעולה ששולחת הודעה, משלמת, מתקשרת או מוחקת מחכה לאישור בוואטסאפ כמו תמיד. אם אתה מחכה לאישור, אמור את זה במשפט אחד ואל תבצע את הפעולה.]'

// Whole message only. "תתקשר לאמא" and "תתקשר אליי מחר" stay with the model.
export function parseLiveCall(text) {
  let t = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+$/u, '')
    .replace(/\s+/g, ' ')
  let prev = ''
  while (t && t !== prev) {
    prev = t
    t = t.replace(/^(?:היי|הי|הלפר|helper|בבקשה)\s+/u, '').replace(/\s+בבקשה$/u, '').trim()
  }
  return CALLS.has(t)
}

export function liveLink(settingsUrl) {
  const u = new URL(settingsUrl)
  const t = u.searchParams.get('t') || ''
  u.pathname = '/live'
  u.search = ''
  if (t) u.searchParams.set('t', t)
  return u.toString()
}

export function liveCallReply(settingsUrl, env = process.env) {
  const cfg = liveVoiceFrom(env)
  const link = settingsUrl ? liveLink(settingsUrl) : ''
  if (!cfg.ready) {
    return `שיחה חיה כבויה כרגע. ${cfg.reason}${link ? `\n${link}` : ''}`
  }
  return `הנה השיחה החיה. פותחים מהטלפון או מהטלוויזיה, ואפשר לקטוע אותי באמצע:\n${link}`
}

export function signalingUrl(host, proto = 'http') {
  const name = trim(host)
  if (!name) throw new Error('missing host')
  const ws = String(proto).toLowerCase() === 'https' ? 'wss' : 'ws'
  return `${ws}://${name}/livekit`
}

// Only the WebRTC signal path is proxied. The LiveKit admin API stays inside the docker network.
export function livekitSignalPath(url = '/') {
  const q = String(url).indexOf('?')
  const pathPart = q >= 0 ? url.slice(0, q) : url
  const query = q >= 0 ? url.slice(q) : ''
  if (pathPart !== '/livekit/rtc' && !pathPart.startsWith('/livekit/rtc/')) return null
  return pathPart.slice('/livekit'.length) + query
}

export function livekitUpstream(url) {
  const parsed = new URL(String(url || 'ws://livekit:7880').replace(/^ws/, 'http'))
  return { hostname: parsed.hostname, port: Number(parsed.port) || 7880 }
}

export async function mintJoinToken(cfg, identity) {
  if (!IDENTITIES.has(identity)) throw new Error('identity')
  if (!cfg.ready) throw new Error('live voice is off')
  const token = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity, ttl: '2h', name: identity })
  token.addGrant({
    roomJoin: true,
    room: cfg.room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })
  // A named worker only joins when asked. The token asks for it when the browser or the app opens the room.
  if (cfg.agentName) token.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: cfg.agentName })] })
  return token.toJwt()
}

export function verifyJoinToken(cfg, jwt) {
  return new TokenVerifier(cfg.apiKey, cfg.apiSecret).verify(jwt)
}

export async function liveJoin({ identity, host, proto, env = process.env } = {}) {
  const cfg = liveVoiceFrom(env)
  if (!cfg.ready) return { ok: false, reason: cfg.reason }
  if (!IDENTITIES.has(identity)) return { ok: false, reason: 'בקשת הצטרפות לא מוכרת' }
  try {
    const token = await mintJoinToken(cfg, identity)
    const url = isCloudUrl(cfg.url) ? cfg.url : signalingUrl(host, proto)
    return { ok: true, url, token, room: cfg.room, identity }
  } catch (e) {
    return { ok: false, reason: e.message || 'לא הצלחתי לפתוח שיחה' }
  }
}

export function secretOk(given, secret) {
  const a = Buffer.from(String(given || ''))
  const b = Buffer.from(String(secret || ''))
  if (!b.length || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function bearer(header) {
  const m = String(header || '').match(/^Bearer\s+(\S+)$/i)
  return m ? m[1] : ''
}

// What is worth saying. Links and markup are not spoken. Kept here so this file does not import the chat stack.
export function spokenLine(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, 'קישור')
    .replace(/[*_~`]/g, '')
    .replace(/^[•\-]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500)
}

export async function elevenPcm(text, { apiKey, voiceId, model, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_16000`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey, Accept: 'application/octet-stream' },
    body: JSON.stringify({ text, model_id: model || 'eleven_v3' }),
    signal: AbortSignal.timeout(45000),
  })
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length < 2) throw new Error('ElevenLabs returned no audio')
  return bytes
}

// Edge-TTS unless TTS_PROVIDER=elevenlabs. The voice worker speaks Edge itself (lower latency).
// This returns ElevenLabs PCM only when that provider is selected and the call succeeds.
export async function synthesize(text, env = process.env, deps = {}) {
  const line = spokenLine(text)
  const cfg = liveVoiceFrom(env)
  if (!line) return { engine: 'empty' }
  const choice = voiceFor(line, env)
  const edge = { engine: 'edge', voice: choice.voice, rate: choice.rate, lang: choice.lang }
  if (cfg.ttsProvider === 'elevenlabs' && cfg.elevenKey && cfg.elevenVoice) {
    try {
      const pcm = deps.eleven
        ? await deps.eleven(line, cfg)
        : await elevenPcm(line, { apiKey: cfg.elevenKey, voiceId: cfg.elevenVoice, model: cfg.elevenModel, fetchImpl: deps.fetchImpl })
      return { engine: 'eleven', pcm }
    } catch (e) {
      return { ...edge, fellBack: true, error: e.message }
    }
  }
  return edge
}

export function wavFromPcm(pcm, sampleRate = 16000) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

// Energy gate on 16 kHz mono s16le. WebRTC already cancelled the speaker echo, so a rise is the owner talking.
export function createVad({ threshold = 0.02, startFrames = 3, endFrames = 25 } = {}) {
  let voiced = 0
  let silent = 0
  let speech = false
  let buf = []
  const levelOf = (frame) => {
    const n = Math.floor(frame.length / 2)
    if (!n) return 0
    let sum = 0
    for (let i = 0; i < n; i++) {
      const v = frame.readInt16LE(i * 2) / 32768
      sum += v * v
    }
    return Math.sqrt(sum / n)
  }
  return {
    get speaking() {
      return speech
    },
    reset() {
      voiced = 0
      silent = 0
      speech = false
      buf = []
    },
    push(frame) {
      const level = levelOf(frame)
      const hot = level >= threshold
      if (!speech) {
        if (hot) voiced++
        else voiced = 0
        buf.push(frame)
        if (buf.length > startFrames) buf.shift()
        if (voiced >= startFrames) {
          speech = true
          silent = 0
          return { event: 'start', level, audio: Buffer.concat(buf) }
        }
        return { event: 'quiet', level }
      }
      buf.push(frame)
      if (hot) silent = 0
      else silent++
      if (silent >= endFrames) {
        const audio = Buffer.concat(buf)
        speech = false
        voiced = 0
        silent = 0
        buf = []
        return { event: 'end', level, audio }
      }
      return { event: 'speech', level }
    },
  }
}

// Barge-in: speech that starts while HELPER is talking drops the rest of that reply.
export function createCall({ vad = createVad(), onUtterance, onInterrupt } = {}) {
  let playing = false
  let generation = 0
  return {
    get generation() {
      return generation
    },
    get playing() {
      return playing
    },
    setPlaying(value) {
      playing = Boolean(value)
    },
    push(frame) {
      const ev = vad.push(frame)
      if (playing && ev.event === 'start') {
        playing = false
        generation += 1
        onInterrupt?.(generation)
      }
      if (ev.event === 'end') onUtterance?.(ev.audio, generation)
      return ev
    },
  }
}

const slots = new Map()
export function takeSlot(name, limit, now = Date.now()) {
  const minute = Math.floor(now / 60000)
  const cur = slots.get(name)
  if (!cur || cur.minute !== minute) {
    slots.set(name, { minute, count: 1 })
    return true
  }
  if (cur.count >= limit) return false
  cur.count += 1
  return true
}
export function resetSlots() {
  slots.clear()
}

export function liveKitBrowserFile(root) {
  const file = path.join(root, 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js')
  return fs.existsSync(file) ? file : ''
}

// Pipes the browser's LiveKit signal websocket to the server on the docker network. Media stays on UDP.
export function proxyLiveKit(req, socket, head, upstreamUrl) {
  const fail = (status, text) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }
  const pathAndQuery = livekitSignalPath(req.url || '/')
  if (!pathAndQuery) return fail(404, 'Not Found')
  const target = livekitUpstream(upstreamUrl)
  const headers = { ...req.headers, host: `${target.hostname}:${target.port}` }
  const preq = http.request({ hostname: target.hostname, port: target.port, path: pathAndQuery, method: 'GET', headers })
  preq.on('upgrade', (up, usock, uhead) => {
    let raw = 'HTTP/1.1 101 Switching Protocols\r\n'
    for (const [key, value] of Object.entries(up.headers)) {
      for (const item of Array.isArray(value) ? value : [value]) raw += `${key}: ${item}\r\n`
    }
    socket.write(`${raw}\r\n`)
    if (uhead?.length) socket.write(uhead)
    if (head?.length) usock.write(head)
    usock.pipe(socket)
    socket.pipe(usock)
    const drop = (other) => () => other.destroy()
    usock.on('error', drop(socket))
    socket.on('error', drop(usock))
  })
  preq.on('response', (up) => {
    fail(up.statusCode || 502, 'Bad Gateway')
    up.resume()
  })
  preq.on('error', () => fail(502, 'Bad Gateway'))
  preq.end()
}

export const AGENT_IDENTITY_NAME = AGENT_IDENTITY

// Rough published rates, for the setup page. Confirm them before a long call; they move.
export const COST_NOTE = {
  stt: 'Groq Whisper large-v3-turbo: בערך $0.04 לשעת שמע (פחות מעשירית סנט לדקה). לאשר בקונסול של Groq.',
  eleven: 'ElevenLabs: לפי קרדיטים בחשבון. תשובה קצרה היא בדרך כלל כמה סנט או פחות. שתיקה לא עולה.',
  edge: 'edge-tts (he-IL-HilaNeural / AvriNeural): 0$. זה קול של Microsoft Edge, בלי מפתח, והשירות יכול להשתנות.',
  livekit: 'LiveKit על השרת: 0$ לתוכנה. בערך 200MB לשרת ו-500MB לסוכן, על המעבד, בלי GPU. ענן LiveKit הוא חלופה עם מכסה חינמית; לא חובה.',
  llm: 'המודל: אותו מחיר כמו הודעת וואטסאפ (OpenRouter, Claude Haiku, ו-Groq כגיבוי).',
  wake: 'Picovoice Porcupine: חשבון חינם (כמה מכשירים). בלי מפתח, הזיהוי המקומי של הטלפון, בלי לשלוח שמע.',
}
