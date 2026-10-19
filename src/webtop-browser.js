// The cloud Webtop browser. One persistent Chromium inside the container, with its own profile on the data
// volume, debugging only on 127.0.0.1. The person signs in once through the settings page; the profile keeps the
// cookies. HELPER does not store the password. Home webtop-browser.bat is unchanged and is used when this is off.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { config, DATA_DIR } from './config.js'

const PROFILE = path.join(DATA_DIR, 'webtop-profile')
const VIEW = { width: 1280, height: 900 }
const START_WAIT = 20000
const CALL_TIMEOUT = 20000

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
]

export const cloudWebtopOn = () => config.webtop.cloud
export const webtopProfileDir = () => PROFILE
export const webtopCdpBase = () => `http://127.0.0.1:${config.webtop.port}`

export function chromiumPath() {
  return CANDIDATES.filter(Boolean).find((p) => fs.existsSync(p)) || ''
}

let launching = null

async function portOpen() {
  try {
    const res = await fetch(`${webtopCdpBase()}/json/version`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

function launch() {
  const exe = chromiumPath()
  if (!exe) throw new Error('לא מצאתי Chromium בקונטיינר. הדפדפן של Webtop לא עלה.')
  fs.mkdirSync(PROFILE, { recursive: true })
  // A previous crash leaves the profile locked, and the next Chromium would exit at once.
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(PROFILE, name), { force: true })
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--mute-audio',
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${config.webtop.port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`,
    `--window-size=${VIEW.width},${VIEW.height}`,
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    config.webtop.url || 'about:blank',
  ]
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
  child.unref()
  child.on('error', () => {})
}

// Starts the browser if the debugging port is down. Safe to call often: one launch at a time.
export function ensureCloudWebtop() {
  if (!config.webtop.cloud) return Promise.resolve(false)
  if (!launching) {
    launching = (async () => {
      if (await portOpen()) return true
      launch()
      const deadline = Date.now() + START_WAIT
      while (Date.now() < deadline) {
        if (await portOpen()) return true
        await new Promise((r) => setTimeout(r, 400))
      }
      throw new Error('דפדפן ה-Webtop בענן לא עלה.')
    })().finally(() => {
      launching = null
    })
  }
  return launching
}

async function targets() {
  const res = await fetch(`${webtopCdpBase()}/json`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error('דפדפן ה-Webtop בענן לא ענה.')
  return res.json()
}

async function pageTarget() {
  await ensureCloudWebtop()
  let list = await targets()
  let page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) {
    const url = config.webtop.url || 'about:blank'
    await fetch(`${webtopCdpBase()}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(5000) })
    list = await targets()
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  }
  if (!page) throw new Error('אין לשונית בדפדפן ה-Webtop בענן.')
  return page
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 })
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
    ws.once('close', () => pending.forEach(({ bad }) => bad(new Error('החיבור לדפדפן ה-Webtop נסגר'))))
    ws.once('open', () =>
      resolve({
        call: (method, params = {}) =>
          new Promise((ok, bad) => {
            const id = ++nextId
            const timer = setTimeout(() => (pending.delete(id), bad(new Error(`הדפדפן לא ענה (${method})`))), CALL_TIMEOUT)
            pending.set(id, { ok: (v) => (clearTimeout(timer), ok(v)), bad: (e) => (clearTimeout(timer), bad(e)) })
            ws.send(JSON.stringify({ id, method, params }))
          }),
        close: () => ws.close(),
      })
    )
  })
}

async function withPage(run) {
  if (!config.webtop.cloud) throw new Error('Webtop בענן כבוי.')
  const page = await pageTarget()
  const cdp = await connect(page.webSocketDebuggerUrl)
  try {
    return await run(cdp.call)
  } finally {
    cdp.close()
  }
}

// Live JPEG of the tab the person is signing in to. Nothing here is written to disk.
export function captureFrame() {
  return withPage(async (call) => {
    await call('Page.bringToFront').catch(() => {})
    const layout = await call('Page.getLayoutMetrics').catch(() => ({}))
    const vv = layout.cssVisualViewport || {}
    const width = Math.max(1, Math.round(vv.clientWidth || VIEW.width))
    const height = Math.max(1, Math.round(vv.clientHeight || VIEW.height))
    const shot = await call('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 55,
      clip: { x: vv.pageX || 0, y: vv.pageY || 0, width, height, scale: 1 },
    })
    return { jpeg: Buffer.from(shot.data, 'base64'), width, height }
  })
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
}

function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

// Clicks, typing, scrolling and Enter/Tab/Backspace. The text is forwarded to the browser and not logged.
export function webtopInput(action) {
  const type = String(action?.type || '')
  return withPage(async (call) => {
    if (type === 'click') {
      const x = num(action.x), y = num(action.y)
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      return { ok: true }
    }
    if (type === 'scroll') {
      const x = num(action.x, VIEW.width / 2), y = num(action.y, VIEW.height / 2)
      const deltaY = Math.max(-2000, Math.min(2000, num(action.deltaY, 120)))
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
      return { ok: true }
    }
    if (type === 'type') {
      const text = String(action.text ?? '').slice(0, 500)
      if (!text) return { ok: true }
      await call('Input.insertText', { text })
      return { ok: true }
    }
    if (type === 'key') {
      const spec = KEYS[action.key]
      if (!spec) throw new Error('מקש לא נתמך')
      await call('Input.dispatchKeyEvent', { type: spec.text ? 'keyDown' : 'rawKeyDown', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, text: spec.text })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk })
      return { ok: true }
    }
    throw new Error('פעולה לא מוכרת')
  })
}
