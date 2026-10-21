// The phone, driven by the HELPER Android app itself (an accessibility service), not over ADB. The app dials out to
// this server over a WebSocket at /bridge/phone with the same bridge token as the app's chat, so nothing on the phone
// listens for connections and it works on Wi-Fi and mobile data alike.
//
// The server runs the goal loop (computer-use.js, body "phone"); the app only observes and acts:
//   server -> app  { id, op: "observe", args: { image } }      -> { pkg, width, height, nodes: [...], image? }
//   server -> app  { id, op: "act", args: <action> }           -> { ok, error?, info? }   (after the screen settles)
//   server -> app  { id, op: "capture" }                       -> { image }               (for an approval card)
//   server -> app  { op: "status", text }  / { op: "finish", text }                       (the floating bubble)
//   app -> server  { id, ok, result | error }  /  { type: "hello", device, perms }  /  { type: "stop" }
//
// Like the browser, the phone knows nothing about any app. The model reads a numbered list of what is on the screen
// and picks one action; a screenshot is added only when the list says too little (games, maps, photos).
import { WebSocketServer } from 'ws'
import { state, save } from './store.js'

const CALL_TIMEOUT = { observe: 15000, act: 20000, capture: 15000 }
const PING_MS = 25000
const MAX_NODES_SHOWN = 120
const MAX_APP_NOTES = 6

let link = null // { ws, device, perms, since }
let nextId = 0
const pending = new Map()
const stopListeners = new Set()

export const phoneAppConnected = () => Boolean(link && link.ws.readyState === 1)
export const phoneAppInfo = () => (link ? { device: link.device, perms: link.perms, since: link.since } : null)

// Called from the settings site's server on an upgrade to /bridge/phone. `authorized(req)` checks the bridge token.
const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 })
export function handlePhoneUpgrade(req, socket, head, authorized) {
  if (!authorized(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => adopt(ws))
}

// The newest connection wins: a phone that reconnected leaves its old socket behind.
export function adopt(ws) {
  if (link?.ws && link.ws !== ws) link.ws.terminate()
  link = { ws, device: '', perms: {}, since: Date.now(), alive: true }
  const mine = link
  console.log('[phone-app] connected')
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
      mine.perms = msg.perms && typeof msg.perms === 'object' ? msg.perms : {}
      return
    }
    if (msg.type === 'stop') return stopListeners.forEach((fn) => fn())
    const wait = pending.get(msg.id)
    if (!wait) return
    pending.delete(msg.id)
    msg.ok ? wait.resolve(msg.result ?? {}) : wait.reject(new Error(String(msg.error || 'הפעולה נכשלה בטלפון')))
  })
  ws.on('close', () => {
    clearInterval(ping)
    if (link === mine) link = null
    for (const [id, wait] of pending) if (wait.ws === ws) (pending.delete(id), wait.reject(new Error('הטלפון התנתק')))
    console.log('[phone-app] disconnected')
  })
}

function call(op, args = {}) {
  if (!phoneAppConnected()) return Promise.reject(new Error('אפליקציית HELPER בטלפון לא מחוברת'))
  const ws = link.ws
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (pending.delete(id), reject(new Error(`הטלפון לא ענה (${op})`))), CALL_TIMEOUT[op] || 20000)
    pending.set(id, { ws, resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) })
    ws.send(JSON.stringify({ id, op, args }))
  })
}

const tell = (op, text) => phoneAppConnected() && link.ws.send(JSON.stringify({ op, text: String(text || '').slice(0, 120) }))

// "Stop" in the bubble or the notification. Returns an unsubscribe function.
export function onPhoneStop(fn) {
  stopListeners.add(fn)
  return () => stopListeners.delete(fn)
}

// ---- reading the screen ----

const FLAGS = { clickable: 'tap', editable: 'edit', scrollable: 'scroll', checked: 'on', selected: 'sel', focused: 'focus', password: 'password', disabled: 'disabled' }

// One line per element: [3] Button "Order" desc:"..." id:order_btn {tap} @540,1820
export function formatNodes(nodes = []) {
  return nodes.slice(0, MAX_NODES_SHOWN).map((n) => {
    const flags = Object.keys(FLAGS).filter((k) => n[k]).map((k) => FLAGS[k])
    const text = n.text ? ` "${String(n.text).replace(/\s+/g, ' ').slice(0, 80)}"` : ''
    const desc = n.desc && n.desc !== n.text ? ` desc:"${String(n.desc).replace(/\s+/g, ' ').slice(0, 60)}"` : ''
    const hint = n.hint ? ` hint:"${String(n.hint).slice(0, 40)}"` : ''
    const id = n.id ? ` id:${n.id}` : ''
    return `[${n.i}] ${n.role || 'View'}${text}${desc}${hint}${id}${flags.length ? ` {${flags.join(',')}}` : ''} @${n.x},${n.y}`
  }).join('\n')
}

const label = (n) => [n?.text, n?.desc].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()

// The element an action lands on: by its number, or the smallest tappable box around a point.
export function nodeFor(nodes, a) {
  if (Number.isFinite(a.index)) return nodes.find((n) => n.i === a.index) || null
  if (Number.isFinite(a.x) && Number.isFinite(a.y)) {
    const hits = nodes.filter((n) => n.b && a.x >= n.b[0] && a.x <= n.b[2] && a.y >= n.b[1] && a.y <= n.b[3])
    const area = (n) => (n.b[2] - n.b[0]) * (n.b[3] - n.b[1])
    return hits.filter((n) => n.clickable).sort((p, q) => area(p) - area(q))[0] || hits.sort((p, q) => area(p) - area(q))[0] || null
  }
  return nodes.find((n) => n.focused && n.editable) || null
}

// On a phone the committing buttons are short and bare: the call button, "order" in a ride or food app. Matched only
// as the whole label (plus a few words), so a list item that merely mentions calls is not blocked.
const PHONE_COMMIT = /^(?:call|voice call|video call|שיחה|שיחה קולית|שיחת וידאו|שיחת וידיאו|חייג|התקשר|הזמן|הזמנה|הזמן נסיעה|הזמנת נסיעה|הזמן מונית|order|order ride|book|book ride|request|request ride|send|שלח)(?:\s.{0,20})?$/i

const SECRET_HINT = /passw|סיסמ|otp|one.?time|קוד אימות|קוד חד|verification code|cvv|cvc|card.?number|cc.?num|מספר כרטיס|אשראי|\bpin\b/i

// ---- what the app learned about each app, so the next run is quicker ----

export function appNotes(pkg) {
  return (state.phoneAppNotes?.[pkg] || []).slice(-MAX_APP_NOTES)
}

export function learnAppNote(pkg, note) {
  const text = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  if (!pkg || !text) return
  state.phoneAppNotes ??= {}
  const list = (state.phoneAppNotes[pkg] ||= [])
  if (list.includes(text)) return
  list.push(text)
  if (list.length > MAX_APP_NOTES) list.shift()
  save()
}

// ---- the body the goal loop drives ----

export function phoneBody({ io = { call, tell } } = {}) {
  let last = { nodes: [], pkg: '' }
  let wantImage = false
  return {
    name: 'phone',
    intro: `You operate the user's Android phone (Samsung Galaxy, Android 15) through the HELPER app's accessibility
service, to carry out a task he gave you. Each turn you get a numbered list of what is on the screen, and sometimes a
screenshot. Choose exactly ONE next action.`,
    actions: `Action types:
- {"type": "tap", "index": <n>}                     tap element [n] from the list (preferred), or {"type": "tap", "x": <int>, "y": <int>}
- {"type": "long_press", "index": <n>}              or with x, y
- {"type": "type", "text": "<text>", "index": <n>}  sets the text of an editable field (index optional: the focused field)
- {"type": "scroll", "direction": "down|up|left|right", "index": <n>}   scrolls a list (index optional)
- {"type": "swipe", "direction": "up|down|left|right"}
- {"type": "key", "keys": "back|home|recents|enter|notifications|quick_settings"}
- {"type": "open_app", "package": "<package name>"}  or {"type": "open_app", "name": "<app name>"}
- {"type": "intent", "kind": "alarm", "hour": 7, "minute": 0, "label": "בוקר"}   direct shortcut (numbers, not strings). The phone sets it with AlarmClock and skips the clock UI. Also:
    timer {seconds, label?}   calendar {title, begin: "YYYY-MM-DDTHH:MM", end?, location?}
    contact {name, phone?}   dial {phone} (opens the dialer, does not call)   sms {phone, text} (opens the composer)
    whatsapp {phone: "9725...", text} (opens the chat with the text, does not send)   navigate {query} (Waze, else Maps)
    url {url}   camera {}   settings {panel: "wifi|bluetooth|internet|volume|display|app|battery"}
- {"type": "device", "setting": "flashlight", "value": "on|off"}  or "volume" with 0-100
- {"type": "copy", "text": "<text>"}   {"type": "paste", "index": <n>}
- {"type": "notifications"}                         the current notifications come back as text
- {"type": "look"}                                  your next observation includes a screenshot (only when the list is not enough)
- {"type": "wait", "amount": <seconds 1-10>}`,
    tips: `Use an intent or open_app when one fits, before tapping through screens. An alarm is one intent
{"type":"intent","kind":"alarm","hour":7,"minute":0}; do not open the clock app and do not gate it.
Tap by index, not coordinates, unless the
element is missing from the list. After typing in a search field, use key "enter" or tap the search suggestion.
Setting an alarm or timer, opening an app, and reading the screen or notifications do not need a gate.
Pressing the call button, sending a message or an email, ordering a ride or food, paying and deleting are commits: gate them.
Add "step": 2-4 Hebrew words of what you are doing now ("פותח את Gett", "מחפש כתובת"), shown to the user on the phone.
When you found out where something lives in an app that would save time next run ("Wolt: search is the magnifier at
the top, cart at the bottom"), add "learned": "<that, one line>".`,
    maxSteps: 40,
    finalShot: false,
    settled: true,
    commit: PHONE_COMMIT,
    async screenshot() {
      const image = wantImage
      wantImage = false
      const r = await io.call('observe', { image })
      last = { nodes: Array.isArray(r.nodes) ? r.nodes : [], pkg: String(r.pkg || '') }
      // An empty or near-empty tree (a game, a map, a camera view) says nothing; the picture is needed then.
      let shot = r.image ? r : null
      if (!shot && last.nodes.length < 3) shot = await io.call('capture').catch(() => null)
      const notes = appNotes(last.pkg)
      const text = `App: ${last.pkg || '?'}  Screen ${r.width}x${r.height}\n${formatNodes(last.nodes) || '(no readable elements)'}${notes.length ? `\nWhat you learned about this app before:\n${notes.map((n) => `- ${n}`).join('\n')}` : ''}`
      const out = { text, width: r.width, height: r.height, scale: 1, left: 0, top: 0, pkg: last.pkg, url: '' }
      if (shot?.image) Object.assign(out, { image: `data:image/jpeg;base64,${shot.image}`, buffer: Buffer.from(shot.image, 'base64'), mime: 'image/jpeg' })
      return out
    },
    // The picture for an approval card, whether or not this step had one.
    async capture() {
      const r = await io.call('capture')
      return r.image ? { buffer: Buffer.from(r.image, 'base64'), mime: 'image/jpeg' } : null
    },
    async act(a) {
      if (a.type === 'look') return void (wantImage = true)
      const r = await io.call('act', a)
      if (r.ok === false) throw new Error(r.error || 'הפעולה נכשלה')
      return r.info ? String(r.info).slice(0, 3000) : ''
    },
    // Read from the last screen list, never from the model: what the action lands on, and whether it is a secret field.
    async probe(a) {
      const n = nodeFor(last.nodes, a)
      if (!n) return null
      return { label: label(n).slice(0, 120), secret: Boolean(n.password || (n.editable && SECRET_HINT.test(`${n.hint || ''} ${n.id || ''} ${n.desc || ''}`))) }
    },
    status: (text) => io.tell('status', text),
    finish: (text) => io.tell('finish', text),
    learn: (note) => learnAppNote(last.pkg, note),
  }
}
