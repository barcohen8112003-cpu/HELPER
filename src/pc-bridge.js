// Home PC bridge. The assistant runs in the cloud. The Windows machine dials out to it
// (WebSocket) and runs the existing pc.js / errand-browser.js functions there.
// Nothing at home accepts a connection. Payloads are encrypted, signed, and replay-checked,
// the same idea as home-relay/wake-relay.mjs.
// On the PC the usual launch is the hidden logon task (home-relay/install-bridge-service.ps1).
// It runs this same client in the signed-in user's session. The process reconnects on its own.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { config } from './config.js'

export const MAX_AGE_SEC = 90
const MAX_FRAME = 80 * 1024 * 1024
const TIMEOUT_MS = {
  screenshot: 45000,
  webcamSnap: 30000,
  screenRecord: 120000,
  speakOnPc: 130000,
  playAudio: 130000,
  wingetSearch: 100000,
  wingetInstall: 620000,
  findFiles: 100000,
  browserScreenshot: 45000,
  browserAct: 30000,
  browserProbe: 30000,
  inspectAt: 25000,
  focusInfo: 25000,
  focusWindow: 25000,
  runCommand: 70000,
  runAdminCommand: 95000,
  readSessionPage: 90000,
  downloadSessionFile: 120000,
  readTimetable: 90000,
  readWebtopUpdates: 120000,
  sessionKeepAlive: 90000,
  getHomeDevices: 30000,
  controlHomeDevice: 45000,
  controlHomeDeviceResult: 45000,
  googleHomeKeepAlive: 60000,
}

const PC_NAMES = [
  'media', 'screenshot', 'findApps', 'launchApp', 'playSpotify', 'closeApp', 'status', 'lock',
  'sleepMonitors', 'wakeMonitors', 'unlock', 'typeText', 'pressKey', 'setClipboard', 'getClipboard',
  'popup', 'startTimer', 'speakOnPc', 'playAudio', 'power', 'findFiles', 'organizeDownloads', 'wingetSearch',
  'wingetInstall', 'act', 'webcamSnap', 'screenRecord', 'topProcesses', 'killProcess',
  'getBrowserTabs', 'closeBrowserTab', 'openBrowserTab', 'activateBrowserTab',
  'openOnScreen', 'runCommand', 'runAdminCommand', 'readTextFile', 'writeTextFile', 'readUserFile',
  // The desktop agent's checks (src/desktop-body.js): names of controls and windows, never field values.
  'inspectAt', 'focusInfo', 'focusWindow',
]

let server = null
let home = null
const pending = new Map()
const helloSeen = new Map()
const eventListeners = new Set()

// Home can push a face frame without waiting for a call, so video is not stuck behind a screenshot.
export function onBridgeEvent(fn) {
  eventListeners.add(fn)
  return () => eventListeners.delete(fn)
}

const secret = () => config.pcBridge.secret
const keyOf = (s) => createHash('sha256').update(`pc-bridge|${s}`).digest()

function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

function prune(seen) {
  for (const [n, at] of seen) if (Date.now() - at > MAX_AGE_SEC * 2000) seen.delete(n)
}

// Cloud routes computer actions home. The home process sets PC_BRIDGE_EXECUTOR so it runs them locally.
export function remoteActive() {
  return Boolean(secret()) && process.env.PC_BRIDGE_EXECUTOR !== '1' && process.platform !== 'win32'
}

export function bridgeReady() {
  return remoteActive()
}

export function bridgeConnected() {
  return Boolean(home?.ws && home.ws.readyState === WebSocket.OPEN)
}

export function offlineMessage() {
  const wake = config.wake.mac || (config.wake.relayTopic && config.wake.secret)
  const head = 'המחשב הביתי לא מחובר: הגשר בבית לא ענה, אז אי אפשר לשלוט במחשב מכאן. שום פעולה לא בוצעה.'
  if (wake) return `${head} אם המחשב כבוי, רק Wake-on-LAN יכול להדליק אותו, ורק אם משדר ההדלקה הביתי רץ. כתוב "תדליק את המחשב", ואחרי שהמחשב עולה הגשר יתחבר לבד.`
  return `${head} אם המחשב כבוי, צריך להדליק אותו ידנית: Wake-on-LAN לא מוגדר, ובלעדיו הענן לא יכול להדליק מחשב כבוי.`
}

export function offlineError() {
  const err = new Error(offlineMessage())
  err.hint = offlineMessage()
  return err
}

export function bridgeLabel() {
  if (!secret() || process.env.PC_BRIDGE_EXECUTOR === '1' || process.platform === 'win32') return ''
  return bridgeConnected() ? ' | גשר: מחובר' : ' | גשר: מנותק'
}

export function signHello(s, now = Date.now(), nonce = randomBytes(8).toString('hex')) {
  const ts = Math.floor(now / 1000)
  const sig = createHmac('sha256', s).update(`hello|${ts}|${nonce}`).digest('hex')
  return `${ts} ${nonce} ${sig}`
}

export function verifyHello(s, header, now = Date.now(), seen = helloSeen) {
  const [ts, nonce, sig] = String(header || '').trim().split(/\s+/)
  if (!/^\d+$/.test(ts || '') || !/^[0-9a-f]{8,32}$/.test(nonce || '') || !/^[0-9a-f]{64}$/.test(sig || '')) return 'malformed'
  if (Math.abs(now / 1000 - Number(ts)) > MAX_AGE_SEC) return 'too old'
  const want = createHmac('sha256', s).update(`hello|${ts}|${nonce}`).digest('hex')
  if (!safeEqual(want, sig)) return 'bad signature'
  if (seen.has(nonce)) return 'repeat'
  seen.set(nonce, Date.now())
  prune(seen)
  return null
}

export function seal(s, payload, now = Date.now(), nonce = randomBytes(8).toString('hex')) {
  const ts = Math.floor(now / 1000)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyOf(s), iv)
  cipher.setAAD(Buffer.from(`pc|${ts}|${nonce}`))
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const blob = Buffer.concat([iv, tag, ct])
  const sig = createHmac('sha256', s).update(`pc|${ts}|${nonce}|${createHash('sha256').update(blob).digest('hex')}`).digest('hex')
  return JSON.stringify({ v: 1, ts, nonce, sig, box: blob.toString('base64') })
}

// Returns { ok, payload } or { ok:false, error }. `seen` stops a captured frame from being accepted twice.
export function openFrame(s, text, seen, now = Date.now()) {
  let msg
  try {
    msg = JSON.parse(String(text))
  } catch {
    return { ok: false, error: 'malformed' }
  }
  const { ts, nonce, sig, box } = msg || {}
  if (!/^\d+$/.test(String(ts ?? '')) || !/^[0-9a-f]{8,32}$/.test(nonce || '') || !/^[0-9a-f]{64}$/.test(sig || '') || typeof box !== 'string') {
    return { ok: false, error: 'malformed' }
  }
  if (Math.abs(now / 1000 - Number(ts)) > MAX_AGE_SEC) return { ok: false, error: 'too old' }
  let blob
  try {
    blob = Buffer.from(box, 'base64')
  } catch {
    return { ok: false, error: 'malformed' }
  }
  if (blob.length < 28) return { ok: false, error: 'malformed' }
  const want = createHmac('sha256', s).update(`pc|${ts}|${nonce}|${createHash('sha256').update(blob).digest('hex')}`).digest('hex')
  if (!safeEqual(want, sig)) return { ok: false, error: 'bad signature' }
  if (seen.has(nonce)) return { ok: false, error: 'repeat' }
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyOf(s), blob.subarray(0, 12))
    decipher.setAAD(Buffer.from(`pc|${ts}|${nonce}`))
    decipher.setAuthTag(blob.subarray(12, 28))
    const plain = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8')
    seen.set(nonce, Date.now())
    prune(seen)
    return { ok: true, payload: JSON.parse(plain) }
  } catch {
    return { ok: false, error: 'bad signature' }
  }
}

function isTmpFile(file) {
  try {
    const base = path.resolve(os.tmpdir()) + path.sep
    const full = path.resolve(file)
    return full.startsWith(base) && fs.existsSync(full) && fs.statSync(full).isFile()
  } catch {
    return false
  }
}

// `files` is only for results that carry a temp screenshot. Call arguments are never read off disk.
export function pack(value, files = false, seen = new WeakSet()) {
  if (Buffer.isBuffer(value)) return { __buf: value.toString('base64') }
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return null
  seen.add(value)
  if (Array.isArray(value)) return value.map((v) => pack(v, files, seen))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'buffer' && Buffer.isBuffer(v)) continue
    if (files && k === 'file' && typeof v === 'string' && isTmpFile(v)) {
      out.__file = { name: path.basename(v), data: fs.readFileSync(v).toString('base64') }
      fs.rmSync(v, { force: true })
      continue
    }
    out[k] = pack(v, files, seen)
  }
  return out
}

export function unpack(value) {
  if (!value || typeof value !== 'object') return value
  if (typeof value.__buf === 'string' && Object.keys(value).length === 1) return Buffer.from(value.__buf, 'base64')
  if (Array.isArray(value)) return value.map(unpack)
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === '__file' && v && typeof v.data === 'string') {
      const file = path.join(os.tmpdir(), `helper-${Date.now()}-${randomBytes(4).toString('hex')}-${path.basename(v.name || 'file')}`)
      fs.writeFileSync(file, Buffer.from(v.data, 'base64'))
      out.file = file
      continue
    }
    if (k === '__buf') continue
    out[k] = unpack(v)
  }
  if (typeof out.image === 'string' && out.image.startsWith('data:') && !out.buffer) {
    const i = out.image.indexOf(',')
    if (i >= 0) out.buffer = Buffer.from(out.image.slice(i + 1), 'base64')
  }
  return out
}

function failPending(err) {
  const error = err instanceof Error ? err : new Error(err)
  for (const [, p] of pending) {
    clearTimeout(p.timer)
    p.reject(error)
  }
  pending.clear()
}

function dropHome(ws) {
  if (home?.ws !== ws) return
  home = null
  failPending(offlineError())
  console.log('[pc-bridge] הגשר הביתי התנתק')
}

export function remoteCall(name, args = [], opts = {}) {
  // notSent: refused before anything left for the PC, so nothing can have run there. Device actions rely on it.
  if (!bridgeConnected()) return Promise.reject(Object.assign(offlineError(), { notSent: true }))
  const id = randomBytes(8).toString('hex')
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS[name] || 60000
  const frame = seal(secret(), { t: 'call', id, name, args: pack(args, false) })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('הגשר הביתי מחובר, אבל הפעולה לא הסתיימה בזמן. נסה שוב.'))
    }, timeoutMs)
    pending.set(id, {
      timer,
      resolve: (value) => resolve(unpack(value)),
      reject,
    })
    try {
      home.ws.send(frame)
    } catch {
      clearTimeout(timer)
      pending.delete(id)
      reject(Object.assign(offlineError(), { notSent: true }))
    }
  })
}

function onCloudFrame(text) {
  if (!home) return
  const opened = openFrame(secret(), text, home.seen)
  if (!opened.ok) return
  const body = opened.payload
  if (body?.t === 'event') {
    for (const fn of eventListeners) {
      try {
        fn(body)
      } catch (e) {
        console.log(`[pc-bridge] ${e.message}`)
      }
    }
    return
  }
  if (body?.t !== 'result' || !pending.has(body.id)) return
  const waiter = pending.get(body.id)
  pending.delete(body.id)
  clearTimeout(waiter.timer)
  if (body.ok) waiter.resolve(body.value)
  else {
    const err = new Error(body.error || 'הפעולה במחשב הביתי נכשלה')
    if (body.hint) err.hint = body.hint
    waiter.reject(err)
  }
}

function listenPort() {
  // The home PC never listens. Only the cloud process does, and only when asked.
  if (process.env.PC_BRIDGE_EXECUTOR === '1') return 0
  if (process.env.PC_BRIDGE_ON_PORT === '1' && process.env.PORT) return Number(process.env.PORT) || 0
  if (process.env.PC_BRIDGE_LISTEN === '1') return config.pcBridge.port || 3212
  return 0
}

// Listens for the home PC. Also answers /pc/health so a platform health check has something to hit.
// With no secret the socket is refused; the assistant itself still runs.
export function startPcBridgeServer({ port, host = '0.0.0.0' } = {}) {
  if (server) return server
  if (port === undefined && !listenPort()) return null
  const chosen = port ?? listenPort()
  const httpServer = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0]
    if (req.method === 'GET' && pathname === '/pc/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, home: bridgeConnected() }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false })
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0]
    if (pathname !== '/pc') return socket.destroy()
    const problem = secret() ? verifyHello(secret(), req.headers['x-helper-pc']) : 'no secret'
    if (problem) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (home?.ws) {
        const old = home.ws
        home = null
        failPending(offlineError())
        try { old.close(4000, 'replaced') } catch {}
      }
      home = { ws, seen: new Map() }
      ws.on('message', (data) => onCloudFrame(data.toString()))
      ws.on('close', () => dropHome(ws))
      ws.on('error', () => dropHome(ws))
      ws.send(seal(secret(), { t: 'welcome' }))
      console.log('[pc-bridge] הגשר הביתי התחבר')
    })
  })
  httpServer.on('error', (e) => console.log(`[pc-bridge] לא עלה: ${e.message}`))
  const ready = new Promise((resolve) => httpServer.listen(chosen, host, () => resolve(httpServer.address())))
  server = {
    httpServer,
    wss,
    ready,
    async close() {
      failPending(offlineError())
      home?.ws?.close()
      home = null
      await new Promise((resolve) => wss.close(() => resolve()))
      await new Promise((resolve) => httpServer.close(() => resolve()))
      server = null
    },
  }
  return server
}

export function stopPcBridgeServer() {
  return server ? server.close() : Promise.resolve()
}

function sendResult(ws, s, id, body) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(seal(s, { t: 'result', id, ...body }))
  } catch {}
}

// One computer, one action at a time. A second call waits; it is not dropped.
export function createHomeSession({ secret: s, handlers }) {
  const seen = new Map()
  let chain = Promise.resolve()
  let ws = null
  return {
    seen,
    attach(socket) {
      ws = socket
    },
    handle(text) {
      const opened = openFrame(s, text, seen)
      if (!opened.ok) return Promise.resolve(opened)
      const body = opened.payload
      if (body?.t !== 'call') return Promise.resolve(opened)
      const job = chain.then(async () => {
        const name = String(body.name || '')
        const args = unpack(body.args)
        const list = Array.isArray(args) ? args : []
        if (!Object.hasOwn(handlers, name) || typeof handlers[name] !== 'function') {
          sendResult(ws, s, body.id, { ok: false, error: `פעולה לא מוכרת: ${name}` })
          return
        }
        try {
          const value = await handlers[name](...list)
          sendResult(ws, s, body.id, { ok: true, value: pack(value, true) })
        } catch (e) {
          sendResult(ws, s, body.id, { ok: false, error: e.message || String(e), hint: e.hint || '' })
        }
      })
      chain = job.then(() => {}, () => {})
      return job.then(() => opened)
    },
  }
}

export function connectHome({ url, secret: s, handlers }) {
  const session = createHomeSession({ secret: s, handlers })
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { 'x-helper-pc': signHello(s) },
      handshakeTimeout: 15000,
      maxPayload: MAX_FRAME,
      perMessageDeflate: false,
    })
    session.attach(ws)
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const timer = setTimeout(() => fail(new Error('הענן לא ענה לברכת החיבור')), 15000)
    ws.on('error', (e) => fail(e))
    ws.on('unexpected-response', (_req, res) => fail(new Error(`הענן דחה את החיבור (${res.statusCode})`)))
    ws.on('close', () => {
      clearTimeout(timer)
      if (!settled) fail(new Error('החיבור נסגר לפני שהענן אימת את עצמו'))
    })
    ws.on('message', (data) => {
      const text = data.toString()
      if (!settled) {
        const opened = openFrame(s, text, session.seen)
        clearTimeout(timer)
        if (!opened.ok || opened.payload?.t !== 'welcome') {
          ws.close()
          return fail(new Error(opened.ok ? 'תשובת חיבור לא צפויה' : `הענן לא אומת (${opened.error})`))
        }
        settled = true
        let stopPump = () => {}
        let stopBeat = () => {}
        let stopped = false
        const stopAll = () => {
          if (stopped) return
          stopped = true
          try { stopPump() } catch { /* already stopped */ }
          try { stopBeat() } catch { /* already stopped */ }
        }
        // Only the home process. A missed pong means the server vanished without a close
        // (a docker kill). Terminate so runBridgeLoop dials again. Tests that call
        // connectHome directly are not the executor, so they are left alone.
        if (process.env.PC_BRIDGE_EXECUTOR === '1') {
          stopBeat = watchBridgeSocket(ws)
          import('./face-pc.js').then((m) => {
            if (stopped || ws.readyState !== WebSocket.OPEN) return
            stopPump = m.startFacePump(ws, s) || (() => {})
          }).catch((e) => console.log(`[face] ${e.message}`))
        }
        ws.on('close', stopAll)
        resolve({
          ws,
          sendEvent(data) {
            if (ws.readyState === WebSocket.OPEN) ws.send(seal(s, { t: 'event', name: 'face', data }))
          },
          close: () => {
            stopAll()
            try { ws.close() } catch { /* already closed */ }
          },
          get connected() {
            return ws.readyState === WebSocket.OPEN
          },
        })
        return
      }
      session.handle(text).catch((e) => console.log(`[pc-bridge] ${e.message}`))
    })
  })
}

export async function homeHandlers() {
  if (process.env.PC_BRIDGE_EXECUTOR !== '1') throw new Error('המטפלים המקומיים רצים רק בתהליך הגשר הביתי')
  const pc = await import('./pc.js')
  const errand = await import('./errand-browser.js')
  const handlers = {}
  for (const name of PC_NAMES) {
    if (typeof pc[name] === 'function') handlers[name] = (...args) => pc[name](...args)
  }
  const admin = await import('./pc-admin.js')
  handlers.runAdminCommand = (command) => admin.runAdminCommand(command)
  handlers.browserScreenshot = () => errand.browserScreenshot()
  handlers.browserAct = (action) => errand.browserAct(action)
  handlers.browserProbe = (action) => errand.browserProbe(action)
  // Webtop's Chrome listens on 127.0.0.1 only. These run here, next to that window.
  const session = await import('./session.js')
  handlers.readSessionPage = (url, maxChars) => session.readSessionPage(url, maxChars)
  handlers.downloadSessionFile = (url, name) => session.downloadSessionFile(url, name)
  handlers.readTimetable = () => session.readTimetable()
  handlers.readWebtopUpdates = (opts) => session.readWebtopUpdates({ homework: Boolean(opts?.homework) })
  handlers.sessionKeepAlive = () => session.sessionKeepAlive()
  const home = await import('./google-home.js')
  handlers.getHomeDevices = () => home.getHomeDevices()
  handlers.controlHomeDevice = (query, action) => home.controlHomeDevice(query, action)
  handlers.controlHomeDeviceResult = (query, action, opts) => home.controlHomeDeviceResult(query, action, { fast: Boolean(opts?.fast), strict: true })
  handlers.googleHomeKeepAlive = () => home.googleHomeKeepAlive()
  // Face render on this PC. Not a model tool: only the cloud calls these, and only when FACE_ENABLED is on.
  const facePc = await import('./face-pc.js')
  handlers.faceStatus = () => facePc.faceStatus()
  handlers.faceAudio = (body) => facePc.faceAudio(body || {})
  handlers.faceSignal = (body) => facePc.faceSignal(body || {})
  handlers.faceClose = (body) => facePc.faceClose(body || {})
  return handlers
}

// import.meta.url on Windows is file:///C:/Users/.../src/pc-bridge.js.
// URL.pathname keeps a leading slash ("/C:/Users/..."), and path.win32 then
// joins a root folder literally named "C:" — so the config next to home-relay
// is never found. fileURLToPath returns "C:\Users\..." on Windows. On any other
// platform Node leaves a Windows file URL as "/C:/..." (the drive rule is
// win32-only), so a leftover "/X:" prefix is removed here. A real POSIX path
// never matches that shape.
function moduleFilePath(moduleUrl) {
  const fromUrl = fileURLToPath(moduleUrl)
  return /^\/[A-Za-z]:[\\/]/.test(fromUrl) ? fromUrl.slice(1) : fromUrl
}

export function homeRelayDir(moduleUrl = import.meta.url, pathImpl = path) {
  return pathImpl.normalize(pathImpl.join(pathImpl.dirname(moduleFilePath(moduleUrl)), '..', 'home-relay'))
}

export function bridgeConfig(env = process.env, moduleUrl = import.meta.url, pathImpl = path) {
  const file = env.PC_BRIDGE_CONFIG || pathImpl.join(homeRelayDir(moduleUrl, pathImpl), 'pc-bridge.config.json')
  let fromFile = {}
  if (fs.existsSync(file)) fromFile = JSON.parse(fs.readFileSync(file, 'utf8'))
  return {
    url: env.PC_BRIDGE_URL || fromFile.url || '',
    secret: env.PC_BRIDGE_SECRET || fromFile.secret || '',
  }
}

// Same shape as the wake relay: 2s, 4s, 8s, 16s, 32s, then a minute, and it stays there.
// A live session resets the wait, so a short docker restart is retried quickly, and a long
// outage is not hammered. The loop does not stop.
export const BRIDGE_BACKOFF_START_MS = 2000
export const BRIDGE_BACKOFF_MAX_MS = 60000
// One missed pong at this interval closes a half-open socket. Long enough that a busy
// desktop (a long winget install, a screenshot) is not treated as a dead server.
export const BRIDGE_PING_MS = 45000

export function nextBridgeDelay(wait, max = BRIDGE_BACKOFF_MAX_MS) {
  const n = Number(wait)
  const base = Number.isFinite(n) && n > 0 ? n : BRIDGE_BACKOFF_START_MS
  return Math.min(max, base * 2)
}

// The secret never belongs in a log line. Short strings are left alone so a test stub
// cannot wipe ordinary words.
export function scrubSecret(text, secret) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  const s = String(secret ?? '')
  if (s.length < 8) return raw
  return raw.split(s).join('[secret]')
}

// `maxCycles` is for tests. The home process leaves it infinite.
// `connect` resolves with `{ closed }` once the socket is up. `closed` settles when it drops.
export async function runBridgeLoop({
  connect,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onRetry = () => {},
  onWait = () => {},
  startMs = BRIDGE_BACKOFF_START_MS,
  maxMs = BRIDGE_BACKOFF_MAX_MS,
  maxCycles = Infinity,
} = {}) {
  if (typeof connect !== 'function') throw new Error('connect is required')
  const delays = []
  let wait = startMs
  let cycles = 0
  let connected = false
  for (;;) {
    let failure = null
    connected = false
    try {
      const link = await connect()
      connected = true
      wait = startMs
      if (link && link.closed) await link.closed
    } catch (e) {
      failure = e instanceof Error ? e : new Error(String(e))
    }
    cycles += 1
    if (cycles >= maxCycles) return { delays, wait, cycles, connected }
    if (failure) onRetry(failure, wait)
    else onWait(wait)
    delays.push(wait)
    await sleep(wait)
    wait = nextBridgeDelay(wait, maxMs)
  }
}

// Closes the socket when a ping is not answered, so the retry loop can dial again.
// Returns a stop function. The timer does not keep the process alive by itself.
export function watchBridgeSocket(ws, { pingMs = BRIDGE_PING_MS, onDead } = {}) {
  if (!ws || typeof ws.ping !== 'function') return () => {}
  let alive = true
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    if (typeof ws.off === 'function') {
      try { ws.off('pong', mark) } catch { /* already gone */ }
    }
  }
  const mark = () => { alive = true }
  const timer = setInterval(() => {
    if (stopped || ws.readyState !== WebSocket.OPEN) return
    if (!alive) {
      stop()
      try { onDead?.() } catch { /* the close is what matters */ }
      try { ws.terminate() } catch { /* already closed */ }
      return
    }
    alive = false
    try { ws.ping() } catch { alive = true }
  }, pingMs)
  if (typeof timer.unref === 'function') timer.unref()
  if (typeof ws.on === 'function') ws.on('pong', mark)
  if (typeof ws.once === 'function') ws.once('close', stop)
  else if (typeof ws.on === 'function') ws.on('close', stop)
  return stop
}

// Outbound only. Reconnects until the server is back. Does not return.
export async function runHomeBridge() {
  const cfg = bridgeConfig()
  if (!cfg.url || !cfg.secret) throw new Error('חסרים url ו-secret (pc-bridge.config.json או PC_BRIDGE_URL ו-PC_BRIDGE_SECRET)')
  if (cfg.url.includes('YOUR_SERVER') || cfg.secret.includes('paste-the-same')) throw new Error('צריך למלא את כתובת הענן ואת אותו סוד כמו PC_BRIDGE_SECRET')
  const handlers = await homeHandlers()
  const log = (line) => console.log(`${new Date().toLocaleString('sv-SE')} ${scrubSecret(line, cfg.secret)}`)
  await runBridgeLoop({
    connect: async () => {
      log(`מתחבר אל ${cfg.url}`)
      const link = await connectHome({ url: cfg.url, secret: cfg.secret, handlers })
      log('מחובר. פעולות המחשב ירוצו כאן.')
      return {
        closed: new Promise((resolve) => link.ws.once('close', () => {
          log('החיבור נסגר')
          resolve()
        })),
      }
    },
    onRetry: (e, waitMs) => log(`החיבור נכשל (${e.message}), נסיון חוזר בעוד ${waitMs / 1000} שניות`),
    onWait: (waitMs) => log(`נסיון חוזר בעוד ${waitMs / 1000} שניות`),
  })
}
