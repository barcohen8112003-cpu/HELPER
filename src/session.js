// A site that needs a login (Webtop) is read through a browser window that stays open on this computer, signed in.
// webtop-browser.bat opens that window with a debugging port; the person signs in there once. This module attaches
// to it, reads pages from the live session, and reloads the page every few minutes so the school's timeout never hits.
import WebSocket from 'ws'
import { config } from './config.js'
import { remoteActive, remoteCall, bridgeConnected } from './pc-bridge.js'
import { ensureCloudWebtop } from './webtop-browser.js'

const SETTLE_MS = 2500
const LOAD_TIMEOUT = 25000

const base = () => `http://127.0.0.1:${config.webtop.port}`
const siteHost = () => {
  try {
    return new URL(config.webtop.url).hostname
  } catch {
    return ''
  }
}

export const sessionEnabled = () => Boolean(siteHost())

export function isSessionUrl(url) {
  const host = siteHost()
  if (!host) return false
  try {
    const h = new URL(url).hostname
    return h === host || h.endsWith('.' + host)
  } catch {
    return false
  }
}

function fail(message, hint, code) {
  return Object.assign(new Error(message), { hint, code })
}

// One notice per signed-out stretch, and never twice inside this window even if the session flaps.
export const WEBTOP_LOGIN_NOTIFY_MS = 12 * 60 * 60 * 1000

let loginUrl = () => ''
export function setWebtopLoginUrl(fn) {
  loginUrl = typeof fn === 'function' ? fn : () => ''
}
export const webtopLoginUrl = () => loginUrl()

export function isWebtopLoginError(err) {
  return Boolean(err && (err.code === 'webtop-login' || err.message === 'Webtop לא מחובר.'))
}

function signedOut() {
  const link = config.webtop.cloud ? loginUrl() : ''
  const hint = config.webtop.cloud
    ? (link ? `צריך להיכנס שוב. הקישור: ${link}` : 'צריך להיכנס שוב בדף Webtop שבאתר ההגדרות.')
    : 'צריך להיכנס שוב בחלון ה-Webtop.'
  return fail('Webtop לא מחובר.', hint, 'webtop-login')
}

export function planWebtopLoginNotice(box, now = Date.now()) {
  if (box.webtopLoginOpen) return ''
  const last = Number(box.webtopLoginNotifiedAt) || 0
  if (last && now - last < WEBTOP_LOGIN_NOTIFY_MS) return ''
  box.webtopLoginOpen = true
  box.webtopLoginNotifiedAt = now
  const link = loginUrl()
  return link
    ? `Webtop צריך התחברות מחדש. נכנסים מכאן: ${link}`
    : 'Webtop צריך התחברות מחדש. נכנסים מדף Webtop באתר ההגדרות.'
}

export function clearWebtopLoginNotice(box) {
  box.webtopLoginOpen = false
}

// Where a Webtop read runs. Cloud is local Chromium in the container. Home is the bridge, and only a fallback
// when the cloud session itself is sitting on the login page and the home window is connected.
export function sessionTransport(opts = {}) {
  const cloud = opts.cloud ?? config.webtop.cloud
  const remote = opts.remote ?? remoteActive()
  const bridgeUp = opts.bridgeUp ?? bridgeConnected()
  if (cloud) return { primary: 'cloud', fallback: bridgeUp ? 'home' : null }
  if (remote) return { primary: 'home', fallback: null }
  return { primary: 'local', fallback: null }
}

export async function runSessionRead(local, home, route) {
  if (route.primary === 'home') return home()
  if (route.primary === 'local') return local()
  try {
    return await local()
  } catch (e) {
    if (route.fallback === 'home' && isWebtopLoginError(e)) {
      try {
        return await home()
      } catch {
        // The home window is not a signed-in session. The cloud answer stands.
      }
    }
    throw e
  }
}

// The window is dedicated to this site, so its first real tab is the one to use, even while it sits on a login page.
async function pageTarget() {
  let list
  try {
    list = await (await fetch(`${base()}/json`, { signal: AbortSignal.timeout(5000) })).json()
  } catch {
    if (config.webtop.cloud) throw fail('דפדפן ה-Webtop בענן לא זמין.', 'אני ממשיך לנסות. אפשר להיכנס מדף Webtop בהגדרות.')
    throw fail('חלון ה-Webtop לא פתוח.', 'צריך להפעיל את webtop-browser.bat ולהיכנס שם.')
  }
  const page = list.find((t) => t.type === 'page' && /^https?:/.test(t.url))
  if (!page) {
    throw fail(
      'אין לשונית פתוחה בחלון ה-Webtop.',
      config.webtop.cloud ? 'אפשר לפתוח את דף Webtop בהגדרות ולהיכנס.' : 'צריך לפתוח שם את האתר ולהיכנס.',
    )
  }
  return page
}

// One short conversation with the tab over the debugging protocol.
async function withTab(run) {
  const { webSocketDebuggerUrl } = await pageTarget()
  const ws = new WebSocket(webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let nextId = 0
  const pending = new Map()
  const listeners = new Map()
  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      return msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
    listeners.get(msg.method)?.forEach((fn) => fn(msg.params))
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  // Resolves when the event fires (or after the timeout: a page that never finishes loading is still readable).
  const once = (event, ms = LOAD_TIMEOUT) =>
    new Promise((resolve) => {
      const done = () => (clearTimeout(timer), listeners.delete(event), resolve())
      const timer = setTimeout(done, ms)
      listeners.set(event, [done])
    })
  try {
    return await run({ call, once })
  } finally {
    ws.close()
  }
}

const SNAPSHOT = `JSON.stringify({ href: location.href, login: !!document.querySelector('input[type=password]'), text: document.body ? document.body.innerText : '' })`

async function snapshot(call) {
  const { result } = await call('Runtime.evaluate', { expression: SNAPSHOT, returnByValue: true })
  const snap = JSON.parse(result.value)
  if (snap.login) throw signedOut()
  return snap
}

async function runLocal(run) {
  if (config.webtop.cloud) await ensureCloudWebtop()
  return withTab(run)
}

const sameAddress = (a, b) => a.split('#')[0].replace(/\/$/, '') === b.split('#')[0].replace(/\/$/, '')

// Text of a page in the signed-in window. Opens the address first when the tab is somewhere else.
function readLocal(url, maxChars) {
  return runLocal(async ({ call, once }) => {
    await call('Page.enable')
    const { result } = await call('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
    if (url && !sameAddress(result.value, url)) {
      const loaded = once('Page.loadEventFired')
      await call('Page.navigate', { url })
      await loaded
      await new Promise((r) => setTimeout(r, SETTLE_MS))
    }
    const { text } = await snapshot(call)
    if (!text.trim()) throw fail('הדף ב-Webtop ריק.', 'אני ממשיך לנסות.')
    return text.slice(0, maxChars)
  })
}

export function readSessionPage(url, maxChars = 12000) {
  return runSessionRead(
    () => readLocal(url, maxChars),
    () => remoteCall('readSessionPage', [url, maxChars]),
    sessionTransport(),
  )
}

// The week's timetable, read from where each entry sits in the grid: days are columns, lessons are rows, and an
// empty slot has no element at all, so the text alone cannot say which lesson an entry is.
// -> [{ day: 0 (Sunday) - 5, lesson, subject, teacher, room, cancelled }]
const GRID = `(async () => {
  const leaves = () => [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && e.innerText && e.offsetParent)
  if (!leaves().some(e => e.innerText.trim() === 'שיעור 1')) {
    const tab = leaves().find(e => e.innerText.trim() === 'מערכת שעות')
    if (tab) { tab.click(); await new Promise(r => setTimeout(r, 4000)) }
  }
  const all = leaves()
  const mid = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
  const lessons = all.filter(e => /^שיעור \\d+$/.test(e.innerText.trim())).map(e => ({ n: Number(e.innerText.trim().split(' ')[1]), ...mid(e.getBoundingClientRect()) }))
  const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי']
  const days = all.filter(e => DAYS.includes(e.innerText.trim())).map(e => ({ d: DAYS.indexOf(e.innerText.trim()), ...mid(e.getBoundingClientRect()) }))
  const nearest = (list, key, v) => list.reduce((best, o) => (!best || Math.abs(o[key] - v) < Math.abs(best[key] - v) ? o : best), null)
  const out = []
  for (const e of all) {
    let t = e.innerText.trim().replace(/\\s+/g, ' ')
    const added = /^תוספת שיעור/.test(t)
    if (!added && !/, חדר /.test(t)) continue
    // The entry's own box is a hidden one-pixel label; the visible cell around it says where it sits.
    let cell = e
    while (cell.parentElement && cell.getBoundingClientRect().width < 120) cell = cell.parentElement
    const at = mid(cell.getBoundingClientRect())
    const lesson = nearest(lessons, 'y', at.y), day = nearest(days, 'x', at.x)
    if (!lesson || !day) continue
    const cancelled = /, בוטל$/.test(t)
    t = t.replace(/, בוטל$/, '')
    const room = (t.match(/חדר:? ?([^,]+)$/) || [])[1] || ''
    const parts = t.split(',').map(s => s.trim())
    const subject = added ? 'תוספת שיעור: ' + ((t.match(/, ([^,]+?), י['׳]/) || [])[1] || '') : parts[0].replace(/ \\(רמה.*$/, '')
    const teacher = added ? '' : parts[1] || ''
    if (!out.some(o => o.day === day.d && o.lesson === lesson.n && o.subject === subject)) out.push({ day: day.d, lesson: lesson.n, subject, teacher, room: room.trim(), cancelled })
  }
  return JSON.stringify(out)
})()`

function timetableLocal() {
  return runLocal(async ({ call, once }) => {
    await call('Page.enable')
    const loaded = once('Page.loadEventFired')
    await call('Page.navigate', { url: new URL('/Timetable_Changes?tabIndex=1&tab=scheduale', config.webtop.url).href })
    await loaded
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    await snapshot(call)
    const { result } = await call('Runtime.evaluate', { expression: GRID, returnByValue: true, awaitPromise: true })
    const entries = JSON.parse(result.value || '[]')
    if (!entries.length) throw fail('לא מצאתי שיעורים בדף מערכת השעות של Webtop.', 'אני ממשיך לנסות.')
    return entries
  })
}

export function readTimetable() {
  return runSessionRead(
    () => timetableLocal(),
    () => remoteCall('readTimetable', []),
    sessionTransport(),
  )
}

async function keepAliveLocal() {
  return runLocal(async ({ call, once }) => {
    await call('Page.enable')
    // On the cloud browser, a login page is left alone so a code being typed is not wiped by the refresh.
    if (config.webtop.cloud) {
      try {
        await snapshot(call)
      } catch (e) {
        if (isWebtopLoginError(e)) throw e
      }
    }
    const loaded = once('Page.loadEventFired')
    await call('Page.reload')
    await loaded
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    await snapshot(call)
  })
}

// Reload so the session stays alive, then confirm it is still signed in. Throws when it is not.
// Cloud mode always talks to the container browser, so a signed-in home window cannot hide a cloud login page.
export function sessionKeepAlive() {
  if (config.webtop.cloud) return keepAliveLocal()
  if (remoteActive()) return remoteCall('sessionKeepAlive', [])
  return keepAliveLocal()
}
