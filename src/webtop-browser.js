// Persistent Chromium processes inside the container. Each site has its own profile on the data volume and its
// own debugging port, bound to 127.0.0.1 only. Webtop and Google Home do not share a browser: Webtop navigates
// and reloads its tab, and Google Home has to stay on home.google.com so those clicks are not wiped.
// The person signs in once through the settings page. HELPER does not store the password.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { config, DATA_DIR } from './config.js'

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

// Google Home is headed on its own Xvfb when that exists. A headless window is often rejected by Google's sign-in
// ("this browser may not be secure"). Webtop stays headless until CLOUD_DESKTOP=1, which puts both browsers
// on one shared display so a real mouse and keyboard can sign in. The profiles stay on the data volume.
const SITES = {
  webtop: {
    label: 'Webtop',
    headed: false,
    profile: () => path.join(DATA_DIR, 'webtop-profile'),
    port: () => config.webtop.port,
    url: () => config.webtop.url || 'about:blank',
    enabled: () => config.webtop.cloud,
  },
  'google-home': {
    label: 'Google Home',
    headed: true,
    profile: () => path.join(DATA_DIR, 'google-home-profile'),
    port: () => config.googleHome.port,
    url: () => 'https://home.google.com/',
    enabled: () => config.googleHome.cloud,
    // Keeps the Google sign-in across browser restarts. Debian's Chromium ships an OAuth client, so Desktop
    // Identity Consistency (DICE) is on: a web sign-in makes Chrome ask Gaia for a refresh token, Gaia answers
    // without an authorization code ("Missing authorization code due to OAuth outage in Dice"), and Chrome only
    // locks its AccountReconcilor for that run. On the next launch the reconcilor sees a signed-in web account
    // with no Chrome token and calls Gaia's LogOutAllAccounts, which deletes SID/HSID/SSID/SAPISID/__Secure-*PSID
    // on .google.com. With browser sign-in off, account consistency is disabled and the cookies are left alone.
    extraArgs: ['--allow-browser-signin=false'],
  },
  errand: {
    label: 'קניות',
    headed: true,
    profile: () => path.join(DATA_DIR, 'errand-profile'),
    port: () => config.errand.port,
    url: () => 'about:blank',
    enabled: () => errandCloudOn(),
    // Same DICE sign-out as Google Home: shop logins (including Google) must survive a restart.
    extraArgs: ['--allow-browser-signin=false'],
  },
}

// The cloud container (Webtop, Google Home, or the shared desktop), not the home Windows process.
export function errandCloudOn() {
  if (config.computerMode === 'off') return false
  return Boolean(config.webtop.cloud || config.googleHome.cloud || config.desktop?.enabled)
}

// ERRAND_PROXY wins. Empty falls back to WEBTOP_PROXY. "direct" means no proxy at all.
export function errandProxyValue(proxy = config.errand.proxy, fallback = config.webtop.proxy) {
  const own = String(proxy ?? '').trim()
  if (own.toLowerCase() === 'direct') return ''
  return own || String(fallback ?? '').trim()
}

export const cloudWebtopOn = () => config.webtop.cloud
export const cloudGoogleHomeOn = () => config.googleHome.cloud

// Shared with the session reader so a CloudFront block is recognized in the same words from a live-view frame.
export const PAGE_SNAPSHOT = `JSON.stringify({ href: location.href, login: !!document.querySelector('input[type=password]'), text: document.body ? document.body.innerText : '' })`

let pageTextObserver = () => {}
export function onWebtopPageText(fn) {
  pageTextObserver = typeof fn === 'function' ? fn : () => {}
}

// Chromium's --proxy-server. Only a proxy URL is accepted, so the value cannot smuggle extra flags.
export function webtopProxySwitch(proxy = config.webtop.proxy) {
  const v = String(proxy ?? '').trim()
  if (!v || /[\s"'`]/.test(v) || v.startsWith('-')) return ''
  if (/^(https?|socks5h?|socks4):\/\//i.test(v)) return `--proxy-server=${v}`
  if (/^[A-Za-z0-9.-]+:\d{1,5}$/.test(v)) return `--proxy-server=${v}`
  return ''
}
export const webtopProfileDir = () => SITES.webtop.profile()
export const googleHomeProfileDir = () => SITES['google-home'].profile()
export const webtopCdpBase = () => `http://127.0.0.1:${config.webtop.port}`

export function browserSite(name) {
  const site = SITES[name] ? name : 'webtop'
  return site
}

export function chromiumPath() {
  return CANDIDATES.filter(Boolean).find((p) => fs.existsSync(p)) || ''
}

export function xvfbPath() {
  return fs.existsSync('/usr/bin/xvfb-run') ? '/usr/bin/xvfb-run' : ''
}

const launching = new Map()

function base(site) {
  return `http://127.0.0.1:${SITES[site].port()}`
}

async function portOpen(site) {
  try {
    const res = await fetch(`${base(site)}/json/version`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

export function usesSharedDesktop() {
  return Boolean(config.desktop?.enabled)
}

function desktopView() {
  const m = String(config.desktop?.geometry || '1280x800').match(/^(\d+)x(\d+)$/)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 800 }
}

export function browserLaunchArgs(site = 'webtop') {
  site = browserSite(site)
  const spec = SITES[site]
  const onDesktop = usesSharedDesktop()
  const headed = onDesktop || Boolean(spec.headed && xvfbPath())
  const view = onDesktop ? desktopView() : VIEW
  const args = [
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--mute-audio',
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${spec.port()}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${spec.profile()}`,
    `--window-size=${view.width},${view.height}`,
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ...(spec.headed || onDesktop ? ['--disable-blink-features=AutomationControlled'] : []),
    ...(onDesktop ? [`--class=helper-${site}`, '--window-position=0,0'] : []),
    ...(headed ? [] : ['--headless=new']),
    ...(spec.extraArgs || []),
  ]
  // The proxy is for Webtop only. Google Home signs in directly and must not inherit an Israeli school proxy.
  if (site === 'webtop') {
    const proxy = webtopProxySwitch()
    if (proxy) args.push(proxy)
  }
  // Israeli shops should see an Israeli exit (usually the phone). Google Home stays direct.
  if (site === 'errand') {
    const proxy = webtopProxySwitch(errandProxyValue())
    if (proxy) args.push(proxy)
  }
  args.push(spec.url())
  return args
}

// How this site's Chromium is started. The shared desktop does not wrap a private xvfb-run:
// that would hide the window from the remote desktop.
export function browserProcessPlan(site = 'webtop') {
  site = browserSite(site)
  const spec = SITES[site]
  const exe = chromiumPath() || 'chromium'
  const args = browserLaunchArgs(site)
  if (usesSharedDesktop()) {
    const display = config.desktop.display || ':99'
    return { command: exe, args, env: { ...process.env, DISPLAY: display }, display }
  }
  if (spec.headed && xvfbPath()) {
    return {
      command: xvfbPath(),
      args: ['-a', '-s', `-screen 0 ${VIEW.width}x${VIEW.height}x24`, exe, ...args],
      env: process.env,
      display: '',
    }
  }
  return { command: exe, args, env: process.env, display: '' }
}

function launch(site) {
  const spec = SITES[site]
  const exe = chromiumPath()
  if (!exe) throw new Error(`לא מצאתי Chromium בקונטיינר. הדפדפן של ${spec.label} לא עלה.`)
  const profile = spec.profile()
  fs.mkdirSync(profile, { recursive: true })
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(profile, name), { force: true })
  const plan = browserProcessPlan(site)
  const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', env: plan.env })
  child.unref()
  child.on('error', () => {})
}

// Closes every enabled cloud browser (Webtop, Google Home, errands) through the debugging port so Chromium
// writes its cookies to the profile. Killed outright (the container stopping), it loses Google's rotated
// session cookies and Google signs the profile out.
export async function closeCloudBrowsers(ms = 4000) {
  await Promise.all(
    Object.keys(SITES).map(async (site) => {
      if (!SITES[site].enabled()) return
      try {
        const v = await (await fetch(`${base(site)}/json/version`, { signal: AbortSignal.timeout(1500) })).json()
        const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false })
        await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)))
        ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
        const deadline = Date.now() + ms
        while (Date.now() < deadline && (await portOpen(site))) await new Promise((r) => setTimeout(r, 200))
      } catch {
        // Already down, or not answering: nothing to save.
      }
    }),
  )
}

// Starts one site's browser if its debugging port is down. One launch per site at a time.
export function ensureCloudBrowser(site = 'webtop') {
  site = browserSite(site)
  const spec = SITES[site]
  if (!spec.enabled()) return Promise.resolve(false)
  if (!launching.has(site)) {
    const job = (async () => {
      if (await portOpen(site)) return true
      launch(site)
      const deadline = Date.now() + START_WAIT
      while (Date.now() < deadline) {
        if (await portOpen(site)) return true
        await new Promise((r) => setTimeout(r, 400))
      }
      throw new Error(`דפדפן ${spec.label} בענן לא עלה.`)
    })().finally(() => launching.delete(site))
    launching.set(site, job)
  }
  return launching.get(site)
}

export const ensureCloudWebtop = () => ensureCloudBrowser('webtop')

async function targets(site) {
  const res = await fetch(`${base(site)}/json`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`דפדפן ${SITES[site].label} בענן לא ענה.`)
  return res.json()
}

async function pageTarget(site) {
  await ensureCloudBrowser(site)
  let list = await targets(site)
  let page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (site === 'google-home') {
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /home\.google\.com|accounts\.google\.com/.test(t.url || '')) || page
  }
  if (!page) {
    await fetch(`${base(site)}/json/new?${encodeURIComponent(SITES[site].url())}`, { method: 'PUT', signal: AbortSignal.timeout(5000) })
    list = await targets(site)
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  }
  if (!page) throw new Error(`אין לשונית בדפדפן ${SITES[site].label} בענן.`)
  return page
}

function connect(wsUrl, label) {
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
    ws.once('close', () => pending.forEach(({ bad }) => bad(new Error(`החיבור לדפדפן ${label} נסגר`))))
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

export async function withCloudPage(site, run) {
  site = browserSite(site)
  if (!SITES[site].enabled()) throw new Error(`${SITES[site].label} בענן כבוי.`)
  const page = await pageTarget(site)
  const cdp = await connect(page.webSocketDebuggerUrl, SITES[site].label)
  try {
    return await run(cdp.call)
  } finally {
    cdp.close()
  }
}

async function shot(call) {
  await call('Page.bringToFront').catch(() => {})
  const layout = await call('Page.getLayoutMetrics').catch(() => ({}))
  const vv = layout.cssVisualViewport || {}
  const width = Math.max(1, Math.round(vv.clientWidth || VIEW.width))
  const height = Math.max(1, Math.round(vv.clientHeight || VIEW.height))
  const frame = await call('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 55,
    clip: { x: vv.pageX || 0, y: vv.pageY || 0, width, height, scale: 1 },
  })
  return { jpeg: Buffer.from(frame.data, 'base64'), width, height }
}

// Live JPEG of the tab the person is signing in to. Nothing here is written to disk.
export function captureFrame(site = 'webtop') {
  return withCloudPage(site, async (call) => {
    if (browserSite(site) === 'webtop') {
      try {
        const { result } = await call('Runtime.evaluate', { expression: PAGE_SNAPSHOT, returnByValue: true })
        if (result?.value) pageTextObserver(JSON.parse(result.value))
      } catch {
        // A screenshot is still useful when the page text cannot be read.
      }
    }
    return shot(call)
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
// action.site is "webtop" (default) or "google-home".
export function webtopInput(action) {
  const type = String(action?.type || '')
  const site = browserSite(action?.site)
  return withCloudPage(site, async (call) => {
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
