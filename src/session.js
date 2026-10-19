// A site that needs a login (Webtop) is read through a browser window that stays open on this computer, signed in.
// webtop-browser.bat opens that window with a debugging port; the person signs in there once. This module attaches
// to it, reads pages from the live session, and reloads the page every few minutes so the school's timeout never hits.
import WebSocket from 'ws'
import { config } from './config.js'
import { remoteActive, remoteCall } from './pc-bridge.js'

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

function fail(message, hint) {
  return Object.assign(new Error(message), { hint })
}

// The window is dedicated to this site, so its first real tab is the one to use, even while it sits on a login page.
async function pageTarget() {
  let list
  try {
    list = await (await fetch(`${base()}/json`, { signal: AbortSignal.timeout(5000) })).json()
  } catch {
    throw fail('חלון ה-Webtop לא פתוח.', 'צריך להפעיל את webtop-browser.bat ולהיכנס שם.')
  }
  const page = list.find((t) => t.type === 'page' && /^https?:/.test(t.url))
  if (!page) throw fail('אין לשונית פתוחה בחלון ה-Webtop.', 'צריך לפתוח שם את האתר ולהיכנס.')
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
  if (snap.login) throw fail('Webtop לא מחובר.', 'צריך להיכנס שוב בחלון ה-Webtop.')
  return snap
}

const sameAddress = (a, b) => a.split('#')[0].replace(/\/$/, '') === b.split('#')[0].replace(/\/$/, '')

// Text of a page in the signed-in window. Opens the address first when the tab is somewhere else.
export function readSessionPage(url, maxChars = 12000) {
  if (remoteActive()) return remoteCall('readSessionPage', [url, maxChars])
  return withTab(async ({ call, once }) => {
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

export function readTimetable() {
  if (remoteActive()) return remoteCall('readTimetable', [])
  return withTab(async ({ call, once }) => {
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

// Reload so the session stays alive, then confirm it is still signed in. Throws when it is not.
export function sessionKeepAlive() {
  if (remoteActive()) return remoteCall('sessionKeepAlive', [])
  return withTab(async ({ call, once }) => {
    await call('Page.enable')
    const loaded = once('Page.loadEventFired')
    await call('Page.reload')
    await loaded
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    await snapshot(call)
  })
}
