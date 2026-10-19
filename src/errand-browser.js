// The assistant's own browser for errands: a Chrome/Edge window with its own profile (data/errand-profile), separate
// from the user's browser, driven over its debugging port the same way session.js drives Webtop. Screenshots and input
// go through the debugging protocol, so the user's real mouse and keyboard are never touched while he works.
// Sites the user wants the assistant to use are signed in to once, by hand, in this window; the profile keeps them.
//
// It knows nothing about any particular site. The one thing it reads from the page is what control sits under a click
// or has the focus, so the loop can stop before a payment, an order, a send or a delete (see commitGuard).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { config, DATA_DIR } from './config.js'
import { bridgeReady, remoteActive, remoteCall } from './pc-bridge.js'

const PROFILE = path.join(DATA_DIR, 'errand-profile')
const VIEW = { width: 1280, height: 860 }
const START_WAIT = 20000
const CALL_TIMEOUT = 20000
const base = () => `http://127.0.0.1:${config.errand.port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BROWSERS = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
]

export const errandBrowserEnabled = () => config.computerMode !== 'off' && (process.platform === 'win32' || bridgeReady())

async function targets() {
  return (await fetch(`${base()}/json`, { signal: AbortSignal.timeout(3000) })).json()
}

// Opens the window if it is not running. It stays open afterwards, like the Webtop window.
async function ensureWindow() {
  try {
    return await targets()
  } catch {}
  const exe = BROWSERS.find((p) => p && fs.existsSync(p))
  if (!exe) throw new Error('לא מצאתי Chrome או Edge במחשב')
  fs.mkdirSync(PROFILE, { recursive: true })
  spawn(exe, [
    `--remote-debugging-port=${config.errand.port}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    `--window-size=${VIEW.width},${VIEW.height + 140}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  const deadline = Date.now() + START_WAIT
  while (Date.now() < deadline) {
    await sleep(700)
    try {
      return await targets()
    } catch {}
  }
  throw new Error('חלון הסוכן לא נפתח')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
    let nextId = 0
    const pending = new Map()
    ws.on('message', (data) => {
      const msg = JSON.parse(data)
      if (!msg.id || !pending.has(msg.id)) return
      const { ok, bad } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? bad(new Error(msg.error.message)) : ok(msg.result)
    })
    ws.once('error', reject)
    ws.once('close', () => pending.forEach(({ bad }) => bad(new Error('החיבור לחלון הסוכן נסגר'))))
    ws.once('open', () =>
      resolve({
        // A call that gets no answer (a page stuck mid-navigation) fails instead of holding the errand forever.
        call: (method, params = {}) =>
          new Promise((ok, bad) => {
            const id = ++nextId
            const timer = setTimeout(() => (pending.delete(id), bad(new Error(`חלון הסוכן לא ענה (${method})`))), CALL_TIMEOUT)
            pending.set(id, { ok: (v) => (clearTimeout(timer), ok(v)), bad: (e) => (clearTimeout(timer), bad(e)) })
            ws.send(JSON.stringify({ id, method, params }))
          }),
        close: () => ws.close(),
      })
    )
  })
}

// The tab the errand works in: the frontmost ordinary page. A tab opened by the site (a payment pop-up) becomes the
// frontmost one, so it is picked up on the next step.
async function tab() {
  const list = await ensureWindow()
  let page = list.find((t) => t.type === 'page')
  if (!page) {
    await fetch(`${base()}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) })
    page = (await targets()).find((t) => t.type === 'page')
  }
  return page
}

const KEYS = {
  enter: ['Enter', 13, '\r'], tab: ['Tab', 9], esc: ['Escape', 27], escape: ['Escape', 27], backspace: ['Backspace', 8], delete: ['Delete', 46],
  space: [' ', 32, ' '], up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39],
  home: ['Home', 36], end: ['End', 35], pageup: ['PageUp', 33], pagedown: ['PageDown', 34],
}
const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 }

async function pressKeys(call, combo) {
  const parts = String(combo || '').toLowerCase().split('+').map((k) => k.trim()).filter(Boolean)
  const main = parts.pop()
  const modifiers = parts.reduce((m, k) => m | (MODS[k] ?? 0), 0)
  const known = KEYS[main]
  if (!known && !/^[a-z0-9]$/.test(main || '')) throw new Error(`מקש לא מוכר: ${combo}`)
  const [key, code, text] = known ?? [main, main.toUpperCase().charCodeAt(0), modifiers ? undefined : main]
  await call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, windowsVirtualKeyCode: code, modifiers, text })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, modifiers })
}

async function mouse(call, x, y, button, clickCount) {
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (let n = 1; n <= clickCount; n++) {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: n })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: n })
  }
}

async function withTab(run) {
  const page = await tab()
  const cdp = await connect(page.webSocketDebuggerUrl)
  try {
    return await run(cdp.call, page)
  } finally {
    cdp.close()
  }
}

// -> { image: data URL, width, height, scale: 1, left: 0, top: 0, url, title }
export function browserScreenshot() {
  if (remoteActive()) return remoteCall('browserScreenshot', [])
  return withTab(async (call, page) => {
    // A hidden tab may produce no frame to capture, so it is made the visible one first (inside its own window).
    await call('Page.bringToFront').catch(() => {})
    // The visible part of the page at one image pixel per CSS pixel, so the model's coordinates are click coordinates.
    const { cssVisualViewport: vv } = await call('Page.getLayoutMetrics')
    const width = Math.round(vv.clientWidth), height = Math.round(vv.clientHeight)
    const { data } = await call('Page.captureScreenshot', { format: 'jpeg', quality: 70, clip: { x: vv.pageX, y: vv.pageY, width, height, scale: 1 } })
    const { result } = await call('Runtime.evaluate', { expression: 'location.href', returnByValue: true }).catch(() => ({ result: {} }))
    return { image: `data:image/jpeg;base64,${data}`, buffer: Buffer.from(data, 'base64'), mime: 'image/jpeg', width, height, scale: 1, left: 0, top: 0, url: result.value || page.url }
  })
}

export function browserAct(a) {
  if (remoteActive()) return remoteCall('browserAct', [a])
  return withTab(async (call) => {
    const x = Math.round(a.x), y = Math.round(a.y)
    if (a.type === 'click') return mouse(call, x, y, 'left', 1)
    if (a.type === 'double_click') return mouse(call, x, y, 'left', 2)
    if (a.type === 'right_click') return mouse(call, x, y, 'right', 1)
    if (a.type === 'scroll') {
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number.isFinite(x) ? x : VIEW.width / 2, y: Number.isFinite(y) ? y : VIEW.height / 2, deltaX: 0, deltaY: (Number(a.amount) || 3) * 120 })
      return
    }
    if (a.type === 'type') return call('Input.insertText', { text: String(a.text ?? '') })
    if (a.type === 'key') return pressKeys(call, a.keys)
    if (a.type === 'navigate') {
      const url = /^https?:\/\//i.test(a.url) ? a.url : `https://${a.url}`
      return call('Page.navigate', { url })
    }
    // The page goes away under the call, so the protocol reports it as closed. That is the expected outcome.
    if (a.type === 'back') return call('Runtime.evaluate', { expression: 'history.back()' }).catch((e) => { if (!/navigated or closed/.test(e.message)) throw e })
    throw new Error(`פעולה לא מוכרת: ${a.type}`)
  })
}

// What a click at (x, y), or a key press on the focused element, would set off: the label of the nearest control and
// whether the focused field asks for a secret. Read from the page, never from the model.
const PROBE = (x, y) => `(() => {
  const pick = (el) => el && (el.closest('button, a, [role=button], [role=link], [role=menuitem], input[type=submit], input[type=button], input[type=image], label, summary') || el)
  const label = (el) => !el ? '' : [el.innerText, el.value, el.getAttribute && el.getAttribute('aria-label'), el.title, el.alt].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 120)
  const target = ${Number.isFinite(x) ? `pick(document.elementFromPoint(${x}, ${y}))` : 'pick(document.activeElement)'}
  const f = document.activeElement
  const secret = !!f && f.tagName === 'INPUT' && (f.type === 'password' || /cc-|one-time-code|current-password|new-password/.test(f.autocomplete || '') || /card|cvv|cvc|otp|passw|pin|סיסמ|אשראי/i.test((f.name || '') + ' ' + (f.id || '') + ' ' + (f.placeholder || '')))
  return JSON.stringify({ label: target && target !== document.body ? label(target) : '', secret })
})()`

export function browserProbe(a) {
  if (remoteActive()) return remoteCall('browserProbe', [a])
  return withTab(async (call) => {
    const pos = ['click', 'double_click'].includes(a.type) ? [Math.round(a.x), Math.round(a.y)] : [NaN, NaN]
    const { result } = await call('Runtime.evaluate', { expression: PROBE(...pos), returnByValue: true })
    return JSON.parse(result.value || '{}')
  })
}
