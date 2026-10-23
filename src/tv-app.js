// The TV, driven by the HELPER home screen on it (tv/launcher), not over ADB. The launcher dials out to this
// server over a WebSocket at /bridge/tv with the bridge token, so it keeps working after the TV reboots and
// Wireless debugging switches itself off.
//
//   server -> tv  { id, op, args }     ops: apps, state, open_app, key, volume, buttons, set_button, show
//   tv -> server  { id, ok, result | error }  /  { type: "hello", device, version }
import { WebSocketServer } from 'ws'

const CALL_TIMEOUT_MS = 15000
const PING_MS = 25000

let link = null // { ws, device, version, since, alive }
let nextId = 0
const pending = new Map()

export const tvConnected = () => Boolean(link && link.ws.readyState === 1)
export const tvInfo = () => (link ? { device: link.device, version: link.version, since: link.since } : null)

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
export function handleTvUpgrade(req, socket, head, authorized) {
  if (!authorized(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => adoptTv(ws))
}

// The newest connection wins: a TV that reconnected leaves its old socket behind.
export function adoptTv(ws) {
  if (link?.ws && link.ws !== ws) link.ws.terminate()
  link = { ws, device: '', version: '', since: Date.now(), alive: true }
  const mine = link
  console.log('[tv] connected')
  ws.on('pong', () => (mine.alive = true))
  const ping = setInterval(() => {
    if (!mine.alive) return ws.terminate()
    mine.alive = false
    ws.ping()
  }, PING_MS)
  ws.on('message', (data) => {
    let msg
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (msg.type === 'hello') {
      mine.device = String(msg.device || '').slice(0, 80)
      mine.version = String(msg.version || '').slice(0, 20)
      return
    }
    const wait = pending.get(msg.id)
    if (!wait) return
    pending.delete(msg.id)
    msg.ok ? wait.resolve(msg.result ?? {}) : wait.reject(new Error(String(msg.error || 'הפעולה נכשלה בטלוויזיה')))
  })
  ws.on('close', () => {
    clearInterval(ping)
    if (link === mine) link = null
    for (const [id, wait] of pending) if (wait.ws === ws) (pending.delete(id), wait.reject(new Error('הטלוויזיה התנתקה')))
    console.log('[tv] disconnected')
  })
}

export function tvCall(op, args = {}) {
  if (!tvConnected()) return Promise.reject(new Error('הטלוויזיה לא מחוברת ל-HELPER כרגע (היא כבויה, או שמסך הבית לא הוגדר עם כתובת וקוד)'))
  const ws = link.ws
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (pending.delete(id), reject(new Error(`הטלוויזיה לא ענתה (${op})`))), CALL_TIMEOUT_MS)
    pending.set(id, { ws, resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) })
    ws.send(JSON.stringify({ id, op, args }))
  })
}

// Finds an installed app by package or by a loose name match ("נטפליקס" or "netflix" -> com.netflix.ninja).
const ALIASES = {
  'נטפליקס': 'netflix', 'יוטיוב': 'youtube', 'ספוטיפיי': 'spotify', 'דיסני': 'disney', 'פליי': 'play store',
  'חנות': 'play store', 'גוגל פליי': 'play store', 'הגדרות': 'settings', 'פריים': 'prime video', 'אמזון': 'prime video',
  'יס': 'yes', 'הוט': 'hot', 'סלקום': 'cellcom', 'פרטנר': 'partner', 'כאן': 'kan', 'קשת': 'mako', 'רשת': 'reshet',
}
export function matchApp(apps, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return null
  const exact = apps.find((a) => a.pkg.toLowerCase() === q)
  if (exact) return exact
  const wanted = (ALIASES[q] || q).toLowerCase()
  return (
    apps.find((a) => a.label.toLowerCase() === wanted) ||
    apps.find((a) => a.label.toLowerCase().includes(wanted)) ||
    apps.find((a) => a.pkg.toLowerCase().includes(wanted.replace(/\s+/g, ''))) ||
    null
  )
}
