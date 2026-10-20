// The user's Android phone, reached with ADB over Tailscale. Wireless debugging listens on a random
// port; userspace Tailscale only exposes the tailnet through SOCKS5, so adb dials 127.0.0.1 and a
// local forwarder carries the bytes to the phone. Pairing is once: the ADB key is kept on the data volume.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { config, DATA_DIR } from './config.js'
import { state, save } from './store.js'
import { parseSocksProxy, startTcpForward } from './socks-forward.js'

export const PHONE_DISCONNECT_MS = 12 * 60 * 60 * 1000
export const PHONE_DISCONNECT_TEXT =
  'ניפוי אלחוטי בטלפון כבוי או שהפורט השתנה (קורה אחרי החלפת רשת או אתחול). בטלפון: הגדרות ← אפשרויות למפתחים ← ניפוי אלחוטי, להפעיל, ולשלוח "חבר טלפון <פורט>" עם פורט החיבור. אם מבקשים צימוד מחדש: "צמד טלפון <פורט> <קוד>". אפשר גם מדף הטלפון באתר ההגדרות.'

const KEYS = {
  back: '4',
  home: '3',
  recents: '187',
  enter: '66',
  volume_up: '24',
  volume_down: '25',
  power: '26',
}

const APP_ALIASES = {
  whatsapp: 'com.whatsapp',
  וואטסאפ: 'com.whatsapp',
  chrome: 'com.android.chrome',
  כרום: 'com.android.chrome',
  youtube: 'com.google.android.youtube',
  יוטיוב: 'com.google.android.youtube',
  gmail: 'com.google.android.gm',
  maps: 'com.google.android.apps.maps',
  מפות: 'com.google.android.apps.maps',
  settings: 'com.android.settings',
  הגדרות: 'com.android.settings',
  camera: 'com.sec.android.app.camera',
  מצלמה: 'com.sec.android.app.camera',
  phone: 'com.samsung.android.dialer',
  טלפון: 'com.samsung.android.dialer',
  messages: 'com.samsung.android.messaging',
  הודעות: 'com.samsung.android.messaging',
  gallery: 'com.sec.android.gallery3d',
  גלריה: 'com.sec.android.gallery3d',
  telegram: 'org.telegram.messenger',
  טלגרם: 'org.telegram.messenger',
  instagram: 'com.instagram.android',
  אינסטגרם: 'com.instagram.android',
  spotify: 'com.spotify.music',
  ספוטיפיי: 'com.spotify.music',
  calendar: 'com.google.android.calendar',
  יומן: 'com.google.android.calendar',
}

const tunnels = new Map()

export function phoneBox() {
  state.phone ??= { host: '', port: 0, serial: '', paired: false, disconnectOpen: false, notifiedAt: 0, wasUp: false }
  return state.phone
}

export function phoneEnabled() {
  if (config.phone.mode === 'off') return false
  return Boolean(config.phone.host || phoneBox().host)
}

// direct: no proxy (only when this process can already route to the phone). Otherwise SOCKS5.
// An http Webtop proxy is not reused; ADB needs a TCP proxy.
export function resolvePhoneProxy(phoneProxy = config.phone.proxy, webtopProxy = config.webtop.proxy) {
  const own = String(phoneProxy || '').trim()
  if (own === 'direct') return null
  if (own) return parseSocksProxy(own)
  const web = String(webtopProxy || '').trim()
  if (/^socks5h?:\/\//i.test(web)) return parseSocksProxy(web)
  return parseSocksProxy('socks5://tailscale:1055')
}

export function adbPaths(dir = DATA_DIR) {
  const home = dir
  const android = path.join(dir, '.android')
  fs.mkdirSync(android, { recursive: true })
  return { home, keys: path.join(android, 'adbkey'), android }
}

export function adbEnv(dir = DATA_DIR) {
  const { home, keys } = adbPaths(dir)
  return { ...process.env, HOME: home, ADB_VENDOR_KEYS: keys, ADB_MDNS: '0' }
}

export function parseEndpoint(value, fallbackHost = '') {
  const v = String(value || '').trim()
  if (!v || /\s/.test(v)) return null
  let host = fallbackHost
  let portText = v
  if (v.includes(':')) {
    const i = v.lastIndexOf(':')
    host = v.slice(0, i).replace(/^\[|\]$/g, '') || fallbackHost
    portText = v.slice(i + 1)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(host || '')) return null
  const port = Number(portText)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

export function parsePhoneMessage(text) {
  const t = String(text || '')
    .trim()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
  let m = t.match(/^(?:צמד טלפון|pair phone)\s+(\S+)\s+(\d{6})$/i)
  if (m) return { kind: 'pair', endpoint: m[1], code: m[2] }
  m = t.match(/^(?:חבר טלפון|connect phone)\s+(\S+)$/i)
  if (m) return { kind: 'connect', endpoint: m[1] }
  return null
}

// ask: reads run, writes ask. ask-writes is the same policy under the name from the request.
// ask-all: reads ask too. auto: writes run. Dangerous shell always asks. off: no tools.
export function phoneNeedsApproval(mode, kind) {
  const m = mode || 'ask'
  if (m === 'off') return 'deny'
  if (kind === 'dangerous') return 'ask'
  if (m === 'auto') return 'allow'
  if (m === 'ask-all') return 'ask'
  if (kind === 'read') return 'allow'
  return 'ask'
}

export async function gatePhone(ctx, kind, what) {
  const decision = phoneNeedsApproval(config.phone.mode, kind)
  if (decision === 'deny') throw new Error('שליטה בטלפון כבויה (PHONE_MODE=off).')
  if (decision === 'ask') {
    const ok = await ctx?.confirm?.(what)
    if (!ok) return { allowed: false, text: 'המשתמש לא אישר את הפעולה, ולכן היא לא בוצעה. אל תנסה שוב ואל תעקוף.' }
  }
  return { allowed: true }
}

const META = /[;&|`$<>\n\r\\]|\$\(|\)/
const DANGEROUS = [
  /factory[_\s-]?reset/i,
  /master[_\s-]?clear/i,
  /MASTER_CLEAR/,
  /wipe[-_\s]?data/i,
  /\bpm\s+uninstall\b/i,
  /\bpm\s+clear\b/i,
  /\bsettings\s+put\s+(secure|global|system)\b/i,
  /\brm\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\bfastboot\b/,
  /\breboot\b/,
  /\bsu\b/,
  /\bsetprop\b/,
]

// deny: never run (metacharacters, empty, too long). dangerous: only after an explicit yes. ok: follows PHONE_MODE.
export function classifyShell(command) {
  const cmd = String(command || '').trim()
  if (!cmd || cmd.length > 300) return 'deny'
  if (META.test(cmd)) return 'deny'
  if (DANGEROUS.some((re) => re.test(cmd))) return 'dangerous'
  return 'ok'
}

// `adb shell input text` is ASCII only. Hebrew (and anything else) goes through the clipboard as
// base64, then KEYCODE_PASTE, so the device shell expands UTF-8 and the local process never quotes it.
export function typeTextPlan(text) {
  const value = String(text ?? '')
  if (!value) return { method: 'empty' }
  if (value.length > 500) return { method: 'too-long' }
  // `%` is an escape for `input text` (`%s` is a space). Anything with it, or outside ASCII, uses the clipboard.
  if (/^[\x20-\x7E]+$/.test(value) && !value.includes('%')) return { method: 'input', text: value.replace(/ /g, '%s') }
  return { method: 'clipboard', b64: Buffer.from(value, 'utf8').toString('base64'), pasteKey: '279' }
}

export function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function attr(chunk, name) {
  const m = chunk.match(new RegExp(`\\b${name}="([^"]*)"`))
  if (!m) return ''
  return m[1]
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function parseBounds(s) {
  const m = String(s || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
  if (!m) return null
  const x1 = Number(m[1])
  const y1 = Number(m[2])
  const x2 = Number(m[3])
  const y2 = Number(m[4])
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) }
}

export function summarizeUi(xml, limit = 60) {
  const nodes = []
  const re = /<node\b([^>]*)>/g
  let m
  while ((m = re.exec(String(xml || ''))) && nodes.length < limit) {
    const text = attr(m[1], 'text')
    const desc = attr(m[1], 'content-desc')
    const clickable = attr(m[1], 'clickable') === 'true'
    const box = parseBounds(attr(m[1], 'bounds'))
    if (!box || (!text && !desc && !clickable)) continue
    nodes.push({ text, desc, clickable, ...box })
  }
  return nodes
}

export function formatUi(nodes) {
  if (!nodes?.length) return 'לא נמצאו רכיבים על המסך.'
  return nodes
    .map((n) => {
      const label = n.text || n.desc || '(בלי טקסט)'
      return `${n.clickable ? 'לחיץ' : 'טקסט'}: "${label}" מרכז ${n.cx},${n.cy} גבולות ${n.x1},${n.y1}-${n.x2},${n.y2}`
    })
    .join('\n')
}

export function findTapTarget(nodes, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return null
  const labeled = (nodes || []).filter((n) => `${n.text || ''} ${n.desc || ''}`.toLowerCase().includes(q))
  return labeled.find((n) => n.clickable) || labeled[0] || null
}

export function summarizeNotifications(dump) {
  const out = []
  for (const block of String(dump || '').split(/NotificationRecord\b/).slice(1)) {
    const pkg = (block.match(/\bpkg=([\w.]+)/) || [])[1] || ''
    const title = (block.match(/android\.title=String \(([^)]*)\)/) || [])[1] || ''
    const text = (block.match(/android\.text=String \(([^)]*)\)/) || [])[1] || ''
    if (!title && !text) continue
    out.push({ pkg, title, text })
    if (out.length >= 20) break
  }
  return out
}

export function formatNotifications(items) {
  if (!items.length) return 'אין התראות להצגה.'
  return items.map((n) => `• ${n.title || n.pkg}${n.text ? `: ${n.text}` : ''}${n.pkg ? ` (${n.pkg})` : ''}`).join('\n')
}

export function parseBattery(dump) {
  const num = (key) => {
    const m = String(dump || '').match(new RegExp(`^\\s*${key}:\\s*(\\d+)`, 'm'))
    return m ? Number(m[1]) : null
  }
  const status = num('status')
  const labels = { 1: 'לא ידוע', 2: 'בטעינה', 3: 'מתרוקנת', 4: 'לא בטעינה', 5: 'מלאה' }
  const temp = num('temperature')
  return { level: num('level'), status: labels[status] || (status == null ? '' : String(status)), tempC: temp == null ? null : temp / 10 }
}

export function resolveApp(name, packages = []) {
  const q = String(name || '').trim().toLowerCase()
  if (!q) return null
  const list = packages.map((p) => String(p).trim()).filter(Boolean)
  if (list.includes(q)) return q
  const alias = APP_ALIASES[q]
  if (alias && (!list.length || list.includes(alias))) return alias
  const hit = list.find((p) => p.toLowerCase().includes(q))
  return hit || (alias && !list.length ? alias : null)
}

export function phonePrompt(english = false) {
  if (!phoneEnabled()) return ''
  if (english) {
    return '- Android phone (ADB over Tailscale): "תשלוט לי בטלפון" / "מה יש לי בטלפון" use phone_screenshot (you see the image), phone_ui_dump, phone_notifications, phone_battery, phone_list_apps. phone_tap, phone_swipe, phone_type_text, phone_key, phone_open_app and phone_shell change the phone and ask him themselves; do not ask first. Hebrew is typed via the clipboard (adb input text is ASCII-only); the text field must already be focused. "צמד טלפון <port> <code>" and "חבר טלפון <port>" are handled before you. If a tool says the phone is disconnected, tell him to turn Wireless debugging back on and send the new port.\n'
  }
  return '• טלפון Android (ADB דרך Tailscale): "תשלוט לי בטלפון", "מה יש לי בטלפון", "תפתח לי בטלפון", "תצלם את מסך הטלפון". כלים: phone_screenshot (התמונה חוזרת אליך), phone_ui_dump (רכיבים לחיצים עם קואורדינטות), phone_tap, phone_swipe, phone_type_text (עברית דרך לוח ההעתקה, כי input text לא תומך בעברית; השדה צריך להיות בפוקוס), phone_key, phone_open_app, phone_list_apps, phone_notifications, phone_battery, phone_shell. פעולה שמשנה את הטלפון מבקשת אישור בוואטסאפ בעצמה, אל תשאל לפני. "צמד טלפון <פורט> <קוד>" ו"חבר טלפון <פורט>" מטופלים לפנייך. אם הכלי אומר שהטלפון מנותק, תגיד להפעיל מחדש ניפוי אלחוטי ולשלוח את הפורט.\n'
}

export function planPhoneDisconnectNotice(box = phoneBox(), now = Date.now()) {
  if (box.disconnectOpen) return ''
  const last = Number(box.notifiedAt) || 0
  if (last && now - last < PHONE_DISCONNECT_MS) return ''
  box.disconnectOpen = true
  box.notifiedAt = now
  return PHONE_DISCONNECT_TEXT
}

export function clearPhoneDisconnectNotice(box = phoneBox()) {
  box.disconnectOpen = false
}

function adbBin() {
  return process.env.ADB_PATH || 'adb'
}

export function runAdb(args, { timeout = 20000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(adbBin(), args, { env: adbEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('adb לא ענה בזמן'))
    }, timeout)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e.code === 'ENOENT' ? new Error('adb לא מותקן בתמונה. צריך לבנות מחדש את הקונטיינר.') : e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out)
      const stderr = Buffer.concat(err).toString('utf8').trim()
      if (code !== 0) reject(new Error(stderr || stdout.toString('utf8').trim() || `adb יצא עם קוד ${code}`))
      else resolve(binary ? stdout : stdout.toString('utf8'))
    })
  })
}

async function tunnel(host, port) {
  const key = `${host}:${port}`
  const existing = tunnels.get(key)
  if (existing) return existing
  const proxy = resolvePhoneProxy()
  if (!proxy) throw new Error('פרוקסי הטלפון צריך להיות socks5:// (או PHONE_PROXY=direct)')
  const fwd = await startTcpForward({ targetHost: host, targetPort: port, proxy })
  const record = { ...fwd, host, port }
  tunnels.set(key, record)
  return record
}

async function closeTunnel(host, port) {
  const key = `${host}:${port}`
  const record = tunnels.get(key)
  if (!record) return
  tunnels.delete(key)
  await record.close().catch(() => {})
}

function serialOf(localPort) {
  return `127.0.0.1:${localPort}`
}

async function deviceUp(serial) {
  try {
    const out = await runAdb(['-s', serial, 'get-state'], { timeout: 8000 })
    return out.trim() === 'device'
  } catch {
    return false
  }
}

function remember(host, port, serial, paired) {
  const box = phoneBox()
  box.host = host
  box.port = port
  box.serial = serial
  if (paired) box.paired = true
  box.wasUp = true
  clearPhoneDisconnectNotice(box)
  save()
}

export async function pairPhone({ host, port, code }) {
  if (config.phone.mode === 'off') throw new Error('שליטה בטלפון כבויה (PHONE_MODE=off).')
  if (!/^\d{6}$/.test(String(code || ''))) throw new Error('קוד הצימוד הוא 6 ספרות.')
  const fwd = await tunnel(host, port)
  try {
    const out = await runAdb(['pair', serialOf(fwd.port), String(code)], { timeout: 30000 })
    const ok = /successfully paired/i.test(out)
    if (!ok) throw new Error(out.trim() || 'הצימוד נכשל')
    phoneBox().paired = true
    phoneBox().host = host
    save()
    return { ok: true, message: 'הטלפון צומד. עכשיו צריך את פורט החיבור (לא פורט הצימוד): "חבר טלפון <פורט>" או כפתור החיבור בדף הטלפון.' }
  } finally {
    await closeTunnel(host, port)
  }
}

export async function connectPhone({ host, port }) {
  if (config.phone.mode === 'off') throw new Error('שליטה בטלפון כבויה (PHONE_MODE=off).')
  const fwd = await tunnel(host, port)
  const serial = serialOf(fwd.port)
  if (!(await deviceUp(serial))) {
    const out = await runAdb(['connect', serial], { timeout: 20000 })
    if (!/connected to/i.test(out) || /failed/i.test(out)) {
      throw new Error(out.trim() || 'החיבור לטלפון נכשל. צריך להפעיל ניפוי אלחוטי ולבדוק את הפורט.')
    }
    if (!(await deviceUp(serial))) throw new Error('adb ראה את הטלפון אבל הוא לא אישר את המפתח. אשר "לאפשר ניפוי" על המסך, או צמד מחדש.')
  }
  remember(host, port, serial, phoneBox().paired)
  const status = await phoneStatus()
  return { ok: true, ...status, message: status.line }
}

export async function reconnectPhone() {
  const box = phoneBox()
  const host = box.host || config.phone.host
  const port = box.port
  if (!host || !port) throw new Error('עוד אין פורט שמור. שולחים "חבר טלפון <פורט>" או מתחברים מדף הטלפון.')
  await closeTunnel(host, port)
  return connectPhone({ host, port })
}

export async function phoneStatus() {
  const box = phoneBox()
  const serial = box.serial
  const base = { host: box.host || config.phone.host, port: box.port || null, connected: false, model: '', battery: '', line: 'הטלפון לא מחובר' }
  if (!serial || !(await deviceUp(serial))) return base
  const [model, batteryDump] = await Promise.all([
    runAdb(['-s', serial, 'shell', 'getprop', 'ro.product.model']).catch(() => ''),
    runAdb(['-s', serial, 'shell', 'dumpsys', 'battery']).catch(() => ''),
  ])
  const battery = parseBattery(batteryDump)
  const modelName = model.trim()
  const batteryText = battery.level == null ? '' : `${battery.level}%${battery.status ? ` ${battery.status}` : ''}`
  return {
    ...base,
    connected: true,
    model: modelName,
    battery: batteryText,
    line: ['מחובר', modelName, batteryText && `סוללה ${batteryText}`].filter(Boolean).join(' · '),
  }
}

async function shell(args, { timeout = 20000, binary = false } = {}) {
  const serial = phoneBox().serial
  if (!serial || !(await deviceUp(serial))) throw new Error('הטלפון לא מחובר. מפעילים ניפוי אלחוטי ושולחים "חבר טלפון <פורט>".')
  return runAdb(['-s', serial, ...args], { timeout, binary })
}

export async function phoneScreenshot() {
  const buf = await shell(['exec-out', 'screencap', '-p'], { timeout: 20000, binary: true })
  const size = pngSize(buf) || { width: 0, height: 0 }
  return { buffer: buf, ...size }
}

export async function phoneUiDump() {
  await shell(['shell', 'uiautomator', 'dump', '/data/local/tmp/helper-ui.xml'], { timeout: 20000 })
  const xml = await shell(['exec-out', 'cat', '/data/local/tmp/helper-ui.xml'], { timeout: 15000 })
  const nodes = summarizeUi(xml)
  return formatUi(nodes)
}

export async function phoneTap({ x, y, text }) {
  if (text) {
    const xml = await shell(['shell', 'uiautomator', 'dump', '/data/local/tmp/helper-ui.xml']).then(() =>
      shell(['exec-out', 'cat', '/data/local/tmp/helper-ui.xml']),
    )
    const node = findTapTarget(summarizeUi(xml, 200), text)
    if (!node) throw new Error(`לא מצאתי על המסך את "${text}"`)
    x = node.cx
    y = node.cy
  }
  const px = Math.round(Number(x))
  const py = Math.round(Number(y))
  if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('חסרות קואורדינטות או טקסט של רכיב')
  await shell(['shell', 'input', 'tap', String(px), String(py)])
  return `נלחץ ${px},${py}`
}

export async function phoneSwipe({ x1, y1, x2, y2, direction }) {
  let a = Number(x1)
  let b = Number(y1)
  let c = Number(x2)
  let d = Number(y2)
  if (direction) {
    const size = await shell(['shell', 'wm', 'size'])
    const m = String(size).match(/(\d+)x(\d+)/)
    const w = m ? Number(m[1]) : 1080
    const h = m ? Number(m[2]) : 2400
    const cx = Math.round(w / 2)
    const cy = Math.round(h / 2)
    const map = {
      up: [cx, Math.round(h * 0.75), cx, Math.round(h * 0.3)],
      down: [cx, Math.round(h * 0.3), cx, Math.round(h * 0.75)],
      left: [Math.round(w * 0.8), cy, Math.round(w * 0.2), cy],
      right: [Math.round(w * 0.2), cy, Math.round(w * 0.8), cy],
    }
    const picked = map[String(direction).toLowerCase()]
    if (!picked) throw new Error('כיוון לא מוכר. up, down, left או right.')
    ;[a, b, c, d] = picked
  }
  if (![a, b, c, d].every((n) => Number.isFinite(n))) throw new Error('חסרות נקודות להחלקה')
  await shell(['shell', 'input', 'swipe', String(Math.round(a)), String(Math.round(b)), String(Math.round(c)), String(Math.round(d)), '300'])
  return 'הוחלק'
}

export async function phoneTypeText(text) {
  const plan = typeTextPlan(text)
  if (plan.method === 'empty') return 'אין טקסט להקליד'
  if (plan.method === 'too-long') throw new Error('הטקסט ארוך מדי (עד 500 תווים)')
  if (plan.method === 'input') {
    await shell(['shell', 'input', 'text', plan.text])
    return 'הוקלד'
  }
  // adb passes arguments straight to the program, so the device shell has to expand the base64 itself.
  await shell(['shell', 'sh', '-c', `cmd clipboard set-text "$(echo ${plan.b64} | base64 -d)"`])
  await shell(['shell', 'input', 'keyevent', plan.pasteKey])
  return 'הטקסט הודבק מהלוח (עברית וסימנים עוברים ככה, לא דרך input text). השדה צריך להיות בפוקוס.'
}

export async function phoneKey(name) {
  const code = KEYS[String(name || '').toLowerCase()]
  if (!code) throw new Error('מקש לא מוכר. back, home, recents, enter, volume_up, volume_down, power.')
  await shell(['shell', 'input', 'keyevent', code])
  return `נלחץ ${name}`
}

export async function phoneListApps() {
  const out = await shell(['shell', 'pm', 'list', 'packages'])
  return [...out.matchAll(/^package:(\S+)/gm)].map((m) => m[1])
}

export async function phoneOpenApp(name) {
  const packages = await phoneListApps()
  const pkg = resolveApp(name, packages)
  if (!pkg) throw new Error(`לא מצאתי אפליקציה בשם "${name}". phone_list_apps מראה את שמות החבילות.`)
  await shell(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'])
  return `נפתח ${pkg}`
}

export async function phoneNotifications() {
  const dump = await shell(['shell', 'dumpsys', 'notification', '--noredact'], { timeout: 20000 })
  return formatNotifications(summarizeNotifications(dump))
}

export async function phoneBattery() {
  const dump = await shell(['shell', 'dumpsys', 'battery'])
  const b = parseBattery(dump)
  if (b.level == null) return 'לא הצלחתי לקרוא את הסוללה'
  return `סוללה ${b.level}%${b.status ? `, ${b.status}` : ''}${b.tempC == null ? '' : `, ${b.tempC.toFixed(1)}°`}`
}

export async function phoneShell(command, { confirmed = false } = {}) {
  const kind = classifyShell(command)
  if (kind === 'deny') throw new Error('הפקודה נחסמה: אין שרשור פקודות, ואין איפוס, מחיקה, הסרת אפליקציה או שינוי הגדרות מערכת בצורה כזאת.')
  if (kind === 'dangerous' && !confirmed) throw new Error('פקודה מסוכנת רצה רק אחרי אישור מפורש בוואטסאפ.')
  const out = await shell(['shell', ...String(command).trim().split(/\s+/)], { timeout: 20000 })
  return out.trim().slice(0, 4000) || 'בוצע'
}

export async function handlePhoneCommand(cmd) {
  if (config.phone.mode === 'off') return 'שליטה בטלפון כבויה (PHONE_MODE=off).'
  const fallback = phoneBox().host || config.phone.host
  try {
    if (cmd.kind === 'pair') {
      const ep = parseEndpoint(cmd.endpoint, fallback)
      if (!ep) return fallback ? 'לא הבנתי את פורט הצימוד. לדוגמה: צמד טלפון 37123 123456' : 'חסרה כתובת הטלפון. קובעים PHONE_ADB_HOST, או שולחים צמד טלפון 100.x.x.x:37123 123456'
      const r = await pairPhone({ ...ep, code: cmd.code })
      return r.message
    }
    const ep = parseEndpoint(cmd.endpoint, fallback)
    if (!ep) return fallback ? 'לא הבנתי את פורט החיבור. לדוגמה: חבר טלפון 41234' : 'חסרה כתובת הטלפון. קובעים PHONE_ADB_HOST, או שולחים חבר טלפון 100.x.x.x:41234'
    const r = await connectPhone(ep)
    return r.message
  } catch (e) {
    return `לא הצלחתי: ${e.message}`
  }
}

// One try a minute, and only after a port was saved. A drop sends at most one WhatsApp note per 12 hours.
export async function phoneKeepAlive() {
  if (!phoneEnabled()) return ''
  const box = phoneBox()
  if (!box.port || !box.host && !config.phone.host) return ''
  const host = box.host || config.phone.host
  try {
    if (box.serial && (await deviceUp(box.serial))) {
      box.wasUp = true
      clearPhoneDisconnectNotice(box)
      save()
      return ''
    }
    await connectPhone({ host, port: box.port })
    return ''
  } catch (e) {
    console.log(`[phone] ${e.message}`)
    if (!box.wasUp) return ''
    const text = planPhoneDisconnectNotice(box)
    if (text) save()
    return text
  }
}
