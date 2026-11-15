// Talking face. Off unless FACE_ENABLED=on.
// When the home PC's face service is up, TTS audio goes over the existing PC bridge and JPEG
// frames come back on the same socket (no new port on the VPS). Otherwise the browser draws
// the HELPER character and lip-syncs to the audio on the TV, phone or settings page.
// A later live-voice session can take attachFaceTrack() and subscribe to the same messages.
// This module does not import a realtime media server.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { bridgeConnected, onBridgeEvent, remoteCall } from './pc-bridge.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE = path.join(HERE, 'face.html')
const VISEME = path.join(HERE, 'face-viseme.js')
const CLIENT = path.join(HERE, 'face-client.js')
const AVATAR = path.join(HERE, 'face-avatar.png')
const AUDIO_MAX = 2 * 1024 * 1024
const TEXT_MAX = 800
const HOLD_MS = 45000

const watchers = new Set()
const sessions = new Map()
let current = null
let lastStatus = null
let ticketKey = null

function ticketSecret() {
  const s = config.pcBridge.secret
  if (s && s.length >= 16) return s
  if (!ticketKey) ticketKey = randomBytes(32).toString('hex')
  return ticketKey
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

export function faceEnabled() {
  return Boolean(config.face?.enabled)
}

export function chooseEngine({ enabled, engine, pcReady }) {
  if (!enabled) return 'off'
  if (engine === 'browser') return 'browser'
  if (pcReady) return 'pc'
  return 'browser'
}

export function pcFaceUp(st = lastStatus) {
  return Boolean(st && st.running && st.engine === 'livetalking' && st.relay !== false)
}

export function mintTicket(sessionId, now = Date.now(), ttlMs = 10 * 60 * 1000) {
  const payload = { v: 1, aud: 'face', sid: String(sessionId || ''), exp: now + ttlMs }
  const body = b64url(JSON.stringify(payload))
  const sig = b64url(createHmac('sha256', ticketSecret()).update(body).digest())
  return `${body}.${sig}`
}

export function readTicket(ticket, now = Date.now()) {
  const [body, sig] = String(ticket || '').split('.')
  if (!body || !sig || body.includes('.') ) return { ok: false, error: 'malformed' }
  let got
  try {
    got = b64urlDecode(sig)
  } catch {
    return { ok: false, error: 'malformed' }
  }
  const expect = createHmac('sha256', ticketSecret()).update(body).digest()
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return { ok: false, error: 'bad signature' }
  let payload
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'))
  } catch {
    return { ok: false, error: 'malformed' }
  }
  if (payload?.aud !== 'face' || payload.v !== 1) return { ok: false, error: 'malformed' }
  if (!(Number(payload.exp) > now)) return { ok: false, error: 'expired' }
  return { ok: true, sessionId: String(payload.sid || ''), exp: Number(payload.exp) }
}

export function publicFaceBase() {
  const pub = String(process.env.UI_PUBLIC_HOST || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (pub) return `http://${pub}`
  const port = Number(process.env.UI_PORT || config.uiPort || 3210) || 3210
  return `http://127.0.0.1:${port}`
}

export function faceSnapshot() {
  return { enabled: faceEnabled(), engine: config.face.engine, tv: config.face.tv, path: '/face', pc: pcFaceUp() }
}

function cookieValue(req, name) {
  const all = String(req.headers?.cookie || '')
  for (const part of all.split(/;\s*/)) {
    if (part.startsWith(name + '=')) return part.slice(name.length + 1)
  }
  return ''
}

export function faceCookieOk(req, now = Date.now()) {
  const raw = cookieValue(req, 'helper_face')
  if (!raw) return false
  return readTicket(raw, now).ok
}

function helloMessage() {
  return {
    t: 'hello',
    enabled: faceEnabled(),
    engine: config.face.engine,
    pc: pcFaceUp(),
    webrtc: Boolean(config.face.webrtc),
    lipDelayMs: config.face.lipDelayMs,
  }
}

function speechMessage(rec) {
  return {
    t: 'speech',
    sessionId: rec.id,
    engine: 'browser',
    text: rec.text,
    mime: rec.mime || '',
    audio: rec.audioB64 || '',
    lipDelayMs: config.face.lipDelayMs,
    source: rec.source || '',
    // A live call already plays this audio in the room. The face still lip-syncs, without a second speaker.
    silent: rec.source === 'live',
  }
}

function broadcast(msg) {
  for (const w of [...watchers]) {
    try {
      w.send(msg)
    } catch {
      watchers.delete(w)
    }
  }
}

export function addWatcher(send) {
  const w = { send }
  watchers.add(w)
  if (current && Date.now() - current.at < HOLD_MS) {
    try {
      send(speechMessage(current))
    } catch {
      watchers.delete(w)
    }
  }
  return () => watchers.delete(w)
}

export function ingestFaceEvent(data) {
  if (!faceEnabled() || !data || typeof data !== 'object') return
  if (data.t === 'status') {
    lastStatus = {
      at: Date.now(),
      running: Boolean(data.running),
      engine: String(data.engine || 'unavailable'),
      relay: data.relay !== false,
    }
    broadcast({ t: 'status', pc: pcFaceUp(), webrtc: Boolean(config.face.webrtc) })
    return
  }
  if (data.t === 'frame' && data.jpeg && String(data.jpeg).length <= 200000) {
    broadcast({
      t: 'frame',
      sessionId: String(data.sid || current?.id || ''),
      seq: Number(data.seq) || 0,
      jpeg: String(data.jpeg),
    })
  }
}

onBridgeEvent((body) => {
  if (body?.name === 'face') ingestFaceEvent(body.data)
})

async function pcReady() {
  if (!faceEnabled() || config.face.engine === 'browser') return false
  if (lastStatus && Date.now() - lastStatus.at < 15000) return pcFaceUp(lastStatus)
  if (!bridgeConnected()) return false
  try {
    const st = await remoteCall('faceStatus', [], { timeoutMs: 2500 })
    lastStatus = {
      at: Date.now(),
      running: Boolean(st?.running),
      engine: st?.engine || 'unavailable',
      relay: st?.relay !== false,
    }
    return pcFaceUp(lastStatus)
  } catch {
    return false
  }
}

async function resolveAudio(opts, text) {
  if (Buffer.isBuffer(opts.audio) && opts.audio.length && opts.audio.length <= AUDIO_MAX) {
    return { audio: opts.audio, mime: String(opts.mime || 'audio/mpeg') }
  }
  if (typeof opts.speak === 'function') {
    try {
      const audio = await opts.speak(text)
      if (Buffer.isBuffer(audio) && audio.length && audio.length <= AUDIO_MAX) return { audio, mime: String(opts.mime || 'audio/mpeg') }
    } catch (e) {
      console.log(`[face] ${e.message}`)
    }
  }
  if (opts.synthesize === false) return { audio: null, mime: '' }
  try {
    const { canSpeak, speakMp3 } = await import('./media.js')
    if (!canSpeak()) return { audio: null, mime: '' }
    const audio = await speakMp3(text)
    if (Buffer.isBuffer(audio) && audio.length <= AUDIO_MAX) return { audio, mime: 'audio/mpeg' }
  } catch (e) {
    console.log(`[face] ${e.message}`)
  }
  return { audio: null, mime: '' }
}

async function upgradeToPc(rec) {
  if (!rec.audioB64 && !rec.text) return
  if (!(await pcReady())) return
  try {
    const result = await remoteCall('faceAudio', [{
      id: rec.id,
      audio: rec.audioB64 || '',
      mime: rec.mime || '',
      text: rec.text || '',
    }], { timeoutMs: 20000 })
    if (!result?.ok) return
    rec.mode = 'pc'
    broadcast({ t: 'engine', sessionId: rec.id, engine: 'pc', lipDelayMs: config.face.lipDelayMs })
  } catch (e) {
    console.log(`[face] ${e.message}`)
  }
}

async function maybeOpenTv(rec, source) {
  const tv = config.face.tv
  // The live page embeds the face itself. Opening /face on the TV would leave the call.
  if (source === 'live' || tv === 'off') return
  if (tv !== 'on' && source !== 'brief') return
  if (!process.env.UI_PUBLIC_HOST) {
    console.log('[face] אין UI_PUBLIC_HOST, אז סיכום הבוקר לא נפתח לבד בטלוויזיה. /face בדפדפן עדיין עובד.')
    return
  }
  try {
    const { tvConnected, tvCall } = await import('./tv-app.js')
    if (!tvConnected()) return
    await tvCall('open_url', { url: `${publicFaceBase()}/face?ticket=${rec.ticket}` })
  } catch (e) {
    console.log(`[face] ${e.message}`)
  }
}

// text, audio (Buffer), mime, source ('whatsapp' | 'brief' | 'tv' | 'tts' | ...), speak(text)=>Buffer optional.
// Returns quickly. The PC render, if it is up, is started in the background; watchers already have the audio.
export async function presentSpeech(opts = {}) {
  if (!faceEnabled()) return { mode: 'off' }
  const text = String(opts.text || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX)
  const { audio, mime } = await resolveAudio(opts, text)
  const id = randomBytes(8).toString('hex')
  const ticket = mintTicket(id)
  const rec = {
    id,
    text,
    mime,
    audioB64: audio ? audio.toString('base64') : '',
    source: String(opts.source || '').slice(0, 24),
    ticket,
    mode: 'browser',
    at: Date.now(),
  }
  sessions.set(id, rec)
  current = rec
  broadcast(speechMessage(rec))
  console.log(`[face] ${rec.source || 'speech'} browser${audio ? '' : ' (בלי שמע מוכן)'}`)
  void upgradeToPc(rec)
  void maybeOpenTv(rec, rec.source)
  return { mode: 'browser', sessionId: id, ticket, track: attachFaceTrack(id) }
}

// A video source a later live-voice publisher can subscribe to. No media server is imported here.
export function attachFaceTrack(sessionId) {
  const id = String(sessionId || '')
  return {
    kind: 'video',
    id: `helper-face-${id}`,
    label: 'HELPER',
    sessionId: id,
    get mode() {
      return sessions.get(id)?.mode || (faceEnabled() ? 'browser' : 'off')
    },
    subscribe(sink) {
      if (typeof sink !== 'function') throw new Error('sink must be a function')
      return addWatcher((msg) => {
        if (!msg.sessionId || msg.sessionId === id || msg.t === 'hello' || msg.t === 'status') sink(msg)
      })
    },
  }
}

export async function onViewerMessage(text, send) {
  if (!faceEnabled() || !config.face.webrtc) return
  let msg
  try {
    msg = JSON.parse(String(text || ''))
  } catch {
    return
  }
  if (msg?.t !== 'offer') return
  const sdp = String(msg.sdp || '')
  if (sdp.length < 20 || sdp.length > 100000 || !sdp.includes('v=0')) return
  let answer
  try {
    answer = await remoteCall('faceSignal', [{ sdp, type: 'offer' }], { timeoutMs: 15000 })
  } catch {
    return
  }
  if (!answer?.sdp) return
  send({ t: 'answer', sdp: String(answer.sdp), type: String(answer.type || 'answer'), sessionId: String(answer.sessionid || answer.sessionId || '') })
}

function write(res, status, body, headers) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN', ...headers })
  res.end(body)
}

function deny(res, ctx) {
  if (typeof ctx.deny === 'function') return ctx.deny(res)
  write(res, 403, 'forbidden', { 'Content-Type': 'text/plain; charset=utf-8' })
}

export function isFacePath(pathname) {
  return pathname === '/face' || pathname === '/face/' || pathname === '/face/viseme.js' || pathname === '/face/client.js'
    || pathname === '/face/avatar.png' || pathname === '/api/face/status' || pathname === '/face/watch'
}

// ctx.signedIn(req), ctx.bearerOk(req). A face ticket cookie is not the settings cookie.
export async function handleFaceHttp(req, res, ctx) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = url.pathname
  if (!isFacePath(pathname) || pathname === '/face/watch') return false
  if ((pathname === '/face' || pathname === '/face/') && url.searchParams.has('ticket')) {
    const ticket = readTicket(url.searchParams.get('ticket') || '')
    if (!ticket.ok) {
      deny(res, ctx)
      return true
    }
    const maxAge = Math.max(1, Math.round((ticket.exp - Date.now()) / 1000))
    write(res, 302, '', {
      Location: '/face',
      'Set-Cookie': `helper_face=${url.searchParams.get('ticket')}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
      'Content-Type': 'text/plain; charset=utf-8',
    })
    return true
  }
  const allowed = (ctx.signedIn && ctx.signedIn(req)) || (ctx.bearerOk && ctx.bearerOk(req)) || faceCookieOk(req)
  if (!allowed) {
    deny(res, ctx)
    return true
  }
  if (req.method === 'GET' && (pathname === '/face' || pathname === '/face/')) {
    write(res, 200, fs.readFileSync(PAGE), { 'Content-Type': 'text/html; charset=utf-8' })
    return true
  }
  if (req.method === 'GET' && pathname === '/face/viseme.js') {
    write(res, 200, fs.readFileSync(VISEME), { 'Content-Type': 'text/javascript; charset=utf-8' })
    return true
  }
  if (req.method === 'GET' && pathname === '/face/client.js') {
    write(res, 200, fs.readFileSync(CLIENT), { 'Content-Type': 'text/javascript; charset=utf-8' })
    return true
  }
  if (req.method === 'GET' && pathname === '/face/avatar.png') {
    const png = fs.readFileSync(AVATAR)
    write(res, 200, png, { 'Content-Type': 'image/png', 'Content-Length': png.length })
    return true
  }
  if (req.method === 'GET' && pathname === '/api/face/status') {
    write(res, 200, JSON.stringify(faceSnapshot()), { 'Content-Type': 'application/json; charset=utf-8' })
    return true
  }
  write(res, 405, 'method', { 'Content-Type': 'text/plain; charset=utf-8' })
  return true
}

// ctx.upgrade(req, socket, head, (ws) => {}) performs the WebSocket handshake on the settings server.
export function handleFaceUpgrade(req, socket, head, ctx) {
  const allowed = (ctx.signedIn && ctx.signedIn(req)) || (ctx.bearerOk && ctx.bearerOk(req)) || faceCookieOk(req)
  if (!allowed || typeof ctx.upgrade !== 'function') {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
    return
  }
  ctx.upgrade(req, socket, head, (ws) => {
    const drop = addWatcher((msg) => {
      if (ws.readyState !== 1) return
      if (msg.t === 'frame' && ws.bufferedAmount > 2_000_000) return
      try {
        ws.send(JSON.stringify(msg))
      } catch {
        /* a slow TV drops frames; the next one still lands */
      }
    })
    try {
      ws.send(JSON.stringify(helloMessage()))
    } catch {
      /* already gone */
    }
    ws.on('message', (data) => {
      onViewerMessage(data.toString(), (msg) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(msg))
      }).catch(() => {})
    })
    ws.on('close', drop)
  })
}

export function _resetFace() {
  watchers.clear()
  sessions.clear()
  current = null
  lastStatus = null
}
