// Google Home via a signed-in Chrome tab. At home that tab lives in the Webtop window (port 9223).
// In the cloud, GOOGLE_HOME_CLOUD=1 uses a separate Chromium profile (data/google-home-profile) so the
// school Webtop tab is never navigated away. If that session is on Google's sign-in page and the home
// bridge is up, the call runs on the home window instead.
// Clicks are native CDP mouse events: Angular Material tiles ignore synthetic DOM clicks.
import WebSocket from 'ws'
import { config } from './config.js'
import { bridgeConnected, remoteActive, remoteCall } from './pc-bridge.js'
import { withCloudPage } from './webtop-browser.js'

const HOME_URL = 'https://home.google.com/'
const CDP_PORT = 9223
const LOGIN_NOTIFY_MS = 12 * 60 * 60 * 1000

let loginUrl = () => ''
export function setGoogleHomeLoginUrl(fn) {
  loginUrl = typeof fn === 'function' ? fn : () => ''
}
export const googleHomeLoginUrl = () => loginUrl()

export function googleHomeSignedOut(url, hasPassword = false) {
  const u = String(url || '')
  if (hasPassword) return true
  if (/accounts\.google\.com|ServiceLogin|\/signin/i.test(u)) return true
  // Signed out, home.google.com/ and /home redirect to the marketing page, which has no sign-in field.
  if (/home\.google\.com\/welcome/i.test(u)) return true
  return false
}

export function isGoogleHomeLoginError(err) {
  return Boolean(err && (err.code === 'google-home-login' || err.message === 'Google Home לא מחובר.'))
}

function signedOutError() {
  const link = loginUrl()
  const hint = link
    ? `צריך להיכנס שוב ל-Google Home. הקישור: ${link}`
    : 'צריך להיכנס שוב ל-Google Home בדף ההתחברות שבהגדרות.'
  return Object.assign(new Error('Google Home לא מחובר.'), { hint, code: 'google-home-login' })
}

// One notice per signed-out stretch, and never twice inside 12 hours even if the session flaps.
export function planGoogleHomeLoginNotice(box, now = Date.now()) {
  if (box.googleHomeLoginOpen) return ''
  const last = Number(box.googleHomeLoginNotifiedAt) || 0
  if (last && now - last < LOGIN_NOTIFY_MS) return ''
  box.googleHomeLoginOpen = true
  box.googleHomeLoginNotifiedAt = now
  const link = loginUrl()
  return link
    ? `Google Home צריך התחברות מחדש. נכנסים מכאן: ${link}`
    : 'Google Home צריך התחברות מחדש. נכנסים מדף Google Home באתר ההגדרות.'
}

export function clearGoogleHomeLoginNotice(box) {
  box.googleHomeLoginOpen = false
}

export const GOOGLE_HOME_LOGIN_NOTIFY_MS = LOGIN_NOTIFY_MS

// Cloud Chromium first. Home is only the fallback when that session is on the sign-in page and the bridge is up.
// With the cloud flag off, a server that has no local window uses the bridge directly.
export function googleHomeTransport(opts = {}) {
  const cloud = opts.cloud ?? config.googleHome.cloud
  const remote = opts.remote ?? remoteActive()
  const bridgeUp = opts.bridgeUp ?? bridgeConnected()
  if (cloud) return { primary: 'cloud', fallback: bridgeUp ? 'home' : null }
  if (remote) return { primary: 'home', fallback: null }
  return { primary: 'local', fallback: null }
}

export async function runGoogleHome(local, home, route) {
  if (route.primary === 'home') return home()
  if (route.primary === 'local') return local()
  try {
    return await local()
  } catch (e) {
    if (route.fallback === 'home' && isGoogleHomeLoginError(e)) {
      try {
        return await home()
      } catch {
        // The home window is not a usable signed-in session. The cloud answer stands.
      }
    }
    throw e
  }
}

async function getHomeTab() {
  let list
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(3000) })
    list = await res.json()
  } catch {
    throw new Error('דפדפן הבית לא פועל. יש לוודא שחלון Webtop פתוח עם Google Home.')
  }
  const tab = list.find((t) => t.type === 'page' && t.url && t.url.includes('home.google.com'))
  if (!tab) {
    throw new Error('לשונית Google Home לא נמצאה פתוחה בחלון הדפדפן (פורט 9223).')
  }
  return tab
}

async function hrefOf(send) {
  const res = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
  return String(res?.result?.value || '')
}

async function passwordOnPage(send) {
  const res = await send('Runtime.evaluate', { expression: '!!document.querySelector("input[type=password]")', returnByValue: true })
  return Boolean(res?.result?.value)
}

async function assertHome(send) {
  const href = await hrefOf(send)
  if (googleHomeSignedOut(href, await passwordOnPage(send)) || !/home\.google\.com/i.test(href)) throw signedOutError()
}

// Keeps the cloud Google session warm. A sign-in page is left as it is, so a code being typed is not reloaded away.
export function googleHomeKeepAlive() {
  if (!config.googleHome.cloud) return Promise.resolve(null)
  return withCloudPage('google-home', async (send) => {
    await send('Page.enable').catch(() => {})
    let href = await hrefOf(send)
    if (googleHomeSignedOut(href, await passwordOnPage(send))) throw signedOutError()
    if (!/home\.google\.com/i.test(href)) {
      await send('Page.navigate', { url: HOME_URL })
      await new Promise((r) => setTimeout(r, 2500))
      await assertHome(send)
      return
    }
    await send('Page.reload').catch(() => {})
    await new Promise((r) => setTimeout(r, 2500))
    await assertHome(send)
  })
}

async function withHomeSession(fn) {
  const tab = await getHomeTab()
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  let reqId = 1
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const curId = reqId++
      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.id === curId) {
            ws.off('message', handler)
            if (msg.error) reject(new Error(msg.error.message))
            else resolve(msg.result)
          }
        } catch (e) {
          reject(e)
        }
      }
      ws.on('message', handler)
      ws.send(JSON.stringify({ id: curId, method, params }))
    })

  try {
    return await runOnTab(send, fn)
  } finally {
    ws.close()
  }
}

async function runOnTab(send, fn) {
  // If any group is collapsed, expand it so all individual device tiles are exposed and clickable
    const expandRes = await send('Runtime.evaluate', {
      expression: `
        (() => {
          const btn = document.querySelector('button.expand-button');
          if (btn && (btn.innerText.includes('keyboard_arrow_down') || btn.getAttribute('title') === 'הרחבה')) {
            const r = btn.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
          return null;
        })()
      `,
      returnByValue: true,
    })
    if (expandRes?.result?.value) {
      const pos = expandRes.result.value
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      await new Promise((r) => setTimeout(r, 60))
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
      await new Promise((r) => setTimeout(r, 600))
    }

  return await fn(send)
}

async function cloudSession(fn) {
  return withCloudPage('google-home', async (send) => {
    await send('Page.enable').catch(() => {})
    let href = await hrefOf(send)
    if (!/home\.google\.com/i.test(href) && !googleHomeSignedOut(href, await passwordOnPage(send))) {
      await send('Page.navigate', { url: HOME_URL })
      await new Promise((r) => setTimeout(r, 2500))
      href = await hrefOf(send)
    }
    if (googleHomeSignedOut(href, await passwordOnPage(send)) || !/home\.google\.com/i.test(href)) throw signedOutError()
    return runOnTab(send, fn)
  })
}

function localCall(fn) {
  if (config.googleHome.cloud) return cloudSession(fn)
  return withHomeSession(fn)
}

const PARSE_EXPR = `
  (() => {
    const buttons = Array.from(document.querySelectorAll('button.on-off-tile'));
    return buttons.map((b, idx) => {
      const lines = (b.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
      const title = b.getAttribute('title') || '';
      const isOffline = b.classList.contains('offline') || lines.some(l => l.includes('אופליין'));
      const isActive = b.classList.contains('active') || title === 'השבתה' || lines.some(l => l.includes('מופעל') || l.includes('פועלים'));
      const isGroup = b.classList.contains('group') || lines.includes('light_group');
      
      let name = lines.find(l => !['light_group', 'speaker', 'lightbulb'].includes(l) && !l.includes('מכשירים') && !l.includes('כבויה') && !l.includes('דלוק') && !l.includes('מושבתים') && !l.includes('פועלים') && !l.includes('מופעל') && !l.includes('אופליין')) || lines.join(' ');
      let type = b.className.includes('LIGHT') ? 'אורות' : b.className.includes('SPEAKER') ? 'רמקול' : 'מכשיר';
      const r = b.getBoundingClientRect();
      return {
        index: idx,
        name,
        type,
        title,
        isGroup,
        isOffline,
        status: isOffline ? 'אופליין' : isActive ? 'דלוק' : 'כבוי',
        x: r.left + r.width / 2,
        y: r.top + r.height / 2
      };
    });
  })()
`

async function getParsedDevices(send) {
  const res = await send('Runtime.evaluate', { expression: PARSE_EXPR, returnByValue: true })
  return res?.result?.value || []
}

export function getHomeDevices() {
  const read = async (send) => {
    const all = await getParsedDevices(send)
    // Exclude redundant meta group tiles when individual items exist
    const hasIndividuals = all.some((d) => !d.isGroup && d.type === 'אורות')
    const devices = hasIndividuals ? all.filter((d) => !d.isGroup) : all
    if (!devices.length) return 'לא זוהו מכשירים פעילים בעמוד Google Home'

    const lines = ['🏠 *מכשירי בית חכם (Google Home):*']
    for (const d of devices) {
      const icon = d.type === 'אורות' ? '💡' : d.type === 'רמקול' ? '🔊' : '🔌'
      const stIcon = d.status === 'דלוק' ? '🟢' : d.status === 'אופליין' ? '⚠️' : '⚪'
      lines.push(`• ${icon} *${d.name}* (${d.type}): ${stIcon} ${d.status}`)
    }
    return lines.join('\n')
  }
  return runGoogleHome(
    () => localCall(read),
    () => remoteCall('getHomeDevices', []),
    googleHomeTransport(),
  )
}

// `fast`: a voice command wants the light now, not a verified report. The press is quicker and the check afterwards
// waits a third of a second instead of a full one.
export function controlHomeDevice(deviceQuery, action = 'toggle', { fast = false } = {}) {
  const q = String(deviceQuery || '').trim().toLowerCase()
  let act = String(action || 'toggle').toLowerCase()
  if (['on', 'הדלק', 'להדליק', 'דלוק', 'הדלקה'].includes(act)) act = 'on'
  else if (['off', 'כבה', 'לכבות', 'כבוי', 'כיבוי'].includes(act)) act = 'off'
  else act = 'toggle'

  const run = async (send) => {
    const all = await getParsedDevices(send)
    if (!all.length) return 'לא זוהו מכשירים בעמוד Google Home.'

    const hasIndividuals = all.some((d) => !d.isGroup && d.type === 'אורות')
    const parsed = hasIndividuals ? all.filter((d) => !d.isGroup) : all

    const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9א-ת]/g, '')
    const qNorm = normalize(q)

    // Checks for room/all lights
    const isAllRoomLights =
      q.includes('חדר שלי') ||
      q.includes('חדר') ||
      q.includes('אור') ||
      q.includes('אורות') ||
      q.includes('lights')
    const isAllLights = q.includes('כל האורות') || (q.includes('אורות') && (q.includes('כל') || q.length <= 6))
    const isAll = q.includes('הכל') || q === 'all'

    let targets = []
    if (isAllLights || isAll) {
      targets = parsed.filter((p) => (isAll ? true : p.type === 'אורות'))
    } else {
      // Check if user specifically requested a named sub-device (e.g. "mine light", "led", "floor lamp")
      const specificMatches = parsed.filter((p) => {
        const nNorm = normalize(p.name)
        if (q.includes('mine') && p.name.toLowerCase().includes('mine')) return true
        if (q.includes('led') || q.includes('לד')) return p.name.toLowerCase().includes('led')
        if (q.includes('floor') || q.includes('מנורת רצפה') || (q.includes('מנורה') && !q.includes('אור'))) return p.name.toLowerCase().includes('floor')
        if (q.includes('סלון') || q.includes('living')) return p.name.toLowerCase().includes('living') || p.name.toLowerCase().includes('lounge')
        if (q.includes('לאונג') || q.includes('lounge')) return p.name.toLowerCase().includes('lounge')
        return nNorm.includes(qNorm) || (qNorm.length >= 3 && qNorm.includes(nNorm))
      })

      if (specificMatches.length > 0) {
        targets = specificMatches
      } else if (isAllRoomLights) {
        // Default when asking for "אור בחדר" or "חדר שלי Lights" -> all individual room lights!
        targets = parsed.filter((p) => p.type === 'אורות')
      }
    }

    if (!targets.length) {
      return `לא נמצא מכשיר מתאים עבור "${deviceQuery}".\nמכשירים זמינים:\n${parsed.map((p) => `• *${p.name}* (${p.type}): ${p.status}`).join('\n')}`
    }

    const clicked = []
    const unchanged = []
    const offline = []

    for (const t of targets) {
      if (t.isOffline) {
        offline.push(`• *${t.name}*: ⚠️ המכשיר אופליין ולא ניתן לשליטה כרגע`)
        continue
      }

      const currentlyOn = t.status === 'דלוק'
      if (act === 'on' && currentlyOn) {
        unchanged.push(`• *${t.name}* כבר דלוק 🟢`)
        continue
      }
      if (act === 'off' && !currentlyOn) {
        unchanged.push(`• *${t.name}* כבר כבוי ⚪`)
        continue
      }

      // Dispatch native CDP mouse events to trigger Angular Material
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: t.x,
        y: t.y,
        button: 'left',
        clickCount: 1,
      })
      await new Promise((r) => setTimeout(r, fast ? 25 : 60))
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: t.x,
        y: t.y,
        button: 'left',
        clickCount: 1,
      })
      clicked.push(t)
      if (!fast) await new Promise((r) => setTimeout(r, 150))
    }

    if (clicked.length > 0) {
      // Wait for Google Home to update DOM
      await new Promise((r) => setTimeout(r, fast ? 350 : 1000))
    }

    const afterDevices = await getParsedDevices(send)
    const lines = []

    for (const c of clicked) {
      const updated = afterDevices.find((p) => p.index === c.index) || c
      const icon = updated.status === 'דלוק' ? '🟢 💡' : '⚪ 🔌'
      lines.push(`• *${updated.name}* שונה בהצלחה למצב: *${updated.status}* ${icon}`)
    }

    lines.push(...unchanged)
    lines.push(...offline)
    return lines.join('\n')
  }
  return runGoogleHome(
    () => localCall(run),
    () => remoteCall('controlHomeDevice', [deviceQuery, action, { fast }]),
    googleHomeTransport(),
  )
}
