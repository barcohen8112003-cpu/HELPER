// Gemini, driven in its own signed-in browser window (gemini-browser.bat), the same way session.js drives Webtop:
// over the window's debugging port, with the ws package, no Playwright or Puppeteer.
//
// One job: open a fresh chat, attach the assignment's files, send the prompt, wait for the whole answer, and bring
// the Word file it produced into the assignment folder. When anything on the way is not as expected (window closed,
// signed out, a CAPTCHA, a button that moved) it stops, saves a screenshot, and says why. It never types a password
// and never tries to get past a login or a CAPTCHA.
//
// The page's selectors live in gemini-selectors.js. `node src/gemini.js probe` lists what is on the page now.
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { config } from './config.js'
import { SELECTORS, BLOCKERS, DOWNLOAD_WORDS, SPARK_WORDS, DOC_LINK } from './gemini-selectors.js'
import { ensureCloudBrowser } from './webtop-browser.js'

const SETTLE_MS = 3000
const POLL_MS = 1500
const STABLE_POLLS = 3
const UPLOAD_WAIT_MS = 120000
const DOWNLOAD_WAIT_MS = 60000

export const geminiEnabled = () => Boolean(config.gemini.url && (config.gemini.cloud || process.env.GEMINI_URL))
const base = () => `http://127.0.0.1:${config.gemini.port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// code: closed | login | captcha | selector | timeout | upload | nofile
export class GeminiError extends Error {
  constructor(code, message, screenshot) {
    super(message)
    this.name = 'GeminiError'
    this.code = code
    this.screenshot = screenshot
  }
}

// ── the debugging connection ────────────────────────────────────────────────

async function targets() {
  // In the cloud the window is one of the desktop's browsers: started here when it is not up.
  if (config.gemini.cloud) await ensureCloudBrowser('gemini').catch(() => {})
  try {
    return await (await fetch(`${base()}/json`, { signal: AbortSignal.timeout(5000) })).json()
  } catch {
    throw new GeminiError('closed', config.gemini.cloud ? 'הדפדפן של Gemini בענן לא עלה.' : 'חלון ה-Gemini לא פתוח. צריך להפעיל את gemini-browser.bat ולהשאיר אותו פתוח.')
  }
}

function open(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    let nextId = 0
    const pending = new Map()
    const listeners = new Map()
    ws.on('message', (data) => {
      const msg = JSON.parse(data)
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: bad } = pending.get(msg.id)
        pending.delete(msg.id)
        return msg.error ? bad(new Error(msg.error.message)) : ok(msg.result)
      }
      for (const fn of listeners.get(msg.method) || []) fn(msg.params)
    })
    const call = (method, params = {}) =>
      new Promise((ok, bad) => {
        const id = ++nextId
        pending.set(id, { resolve: ok, reject: bad })
        ws.send(JSON.stringify({ id, method, params }))
      })
    const on = (event, fn) => listeners.set(event, [...(listeners.get(event) || []), fn])
    const off = (event) => listeners.delete(event)
    ws.once('open', () => resolve({ call, on, off, close: () => ws.close() }))
    ws.once('error', () => reject(new GeminiError('closed', 'אין חיבור לחלון ה-Gemini.')))
  })
}

// The Gemini tab: the first page on the Gemini host, or else the first page in the window.
async function pageConnection() {
  const list = await targets()
  const host = (() => {
    try {
      return new URL(config.gemini.url).hostname
    } catch {
      return ''
    }
  })()
  const pages = list.filter((t) => t.type === 'page' && /^https?:/.test(t.url))
  const page = pages.find((t) => host && new URL(t.url).hostname === host) || pages[0]
  if (!page) throw new GeminiError('closed', 'אין לשונית פתוחה בחלון ה-Gemini.')
  return open(page.webSocketDebuggerUrl)
}

// The browser itself, for the download folder (a page cannot choose where files are saved).
async function browserConnection() {
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`${base()}/json/version`, { signal: AbortSignal.timeout(5000) })).json()
    return await open(webSocketDebuggerUrl)
  } catch {
    throw new GeminiError('closed', 'אין חיבור לחלון ה-Gemini.')
  }
}

// ── small page helpers ──────────────────────────────────────────────────────

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) throw new Error(exceptionDetails.text || 'שגיאה בדף')
  return result.value
}

// In-page: the first visible element for a list of selectors, optionally inside the last element of another list.
const FIND = `(function find(list, within) {
  const visible = (e) => e && (e.offsetParent !== null || e.getClientRects().length > 0)
  for (const sel of list) {
    let scope = document
    if (within) {
      let last = null
      for (const w of within) { const all = document.querySelectorAll(w); if (all.length) { last = all[all.length - 1]; break } }
      if (!last) return null
      scope = last
    }
    const hit = [...scope.querySelectorAll(sel)].find(visible)
    if (hit) return hit
  }
  return null
})`

const js = (v) => JSON.stringify(v)
const exists = (cdp, list, within) => evaluate(cdp, `!!${FIND}(${js(list)}, ${js(within || null)})`)
const click = (cdp, list, within) => evaluate(cdp, `(() => { const e = ${FIND}(${js(list)}, ${js(within || null)}); if (!e) return false; e.click(); return true })()`)
// A real mouse click at the element's middle. A file chooser opens only from a real click (user activation),
// never from element.click() run by a script.
async function mouseClick(cdp, list) {
  const at = await evaluate(cdp, `(() => { const e = ${FIND}(${js(list)}, null); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (!at) return false
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return true
}
const count = (cdp, list) => evaluate(cdp, `(() => { for (const s of ${js(list)}) { const n = document.querySelectorAll(s).length; if (n) return n } return 0 })()`)

async function waitFor(cdp, list, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await exists(cdp, list)) return true
    await sleep(500)
  }
  return false
}

async function screenshot(cdp, dir) {
  try {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    const file = path.join(dir, 'fail.png')
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  } catch {
    return null
  }
}

// Signed out, or stopped by a CAPTCHA: Helper stops here and tells Naor.
async function checkBlocked(cdp) {
  const page = await evaluate(cdp, `({ url: location.href, text: (document.body && document.body.innerText || '').slice(0, 4000) })`)
  if (BLOCKERS.captcha.some((re) => re.test(page.url) || re.test(page.text))) {
    throw new GeminiError('captcha', 'Gemini מבקש אימות (CAPTCHA). צריך לעבור אותו בעצמך בחלון ה-Gemini.')
  }
  const hasInput = await exists(cdp, SELECTORS.input)
  if (/accounts\.google\.com/i.test(page.url) || (!hasInput && BLOCKERS.login.some((re) => re.test(page.text)))) {
    throw new GeminiError('login', config.gemini.cloud ? 'Gemini לא מחובר. צריך להיכנס לחשבון Google פעם אחת בחלון Gemini בשולחן העבודה בענן (אתר ההגדרות, שולחן העבודה, תפריט Gemini).' : 'Gemini לא מחובר. צריך להיכנס לחשבון בחלון ה-Gemini (gemini-browser.bat).')
  }
}

// ── the conversation ────────────────────────────────────────────────────────

async function newChat(cdp) {
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Page.navigate', { url: config.gemini.url })
  await sleep(SETTLE_MS)
  await checkBlocked(cdp)
  if (!(await waitFor(cdp, SELECTORS.input, 30000))) throw new GeminiError('selector', 'לא מצאתי את תיבת הכתיבה של Gemini.')
}

// The file chooser is intercepted, so no system dialog opens: the files are handed straight to the page.
async function attach(cdp, files) {
  if (!files.length) return
  await cdp.call('Page.setInterceptFileChooserDialog', { enabled: true })
  const before = await count(cdp, SELECTORS.attachment)
  try {
    const chooser = new Promise((resolve) => cdp.on('Page.fileChooserOpened', resolve))
    if (!(await mouseClick(cdp, SELECTORS.uploadMenu))) throw new GeminiError('selector', 'לא מצאתי את כפתור העלאת הקבצים ב-Gemini.')
    await sleep(800)
    // Some versions open the chooser from the button itself, others from an item in a menu.
    const opened = await Promise.race([chooser, sleep(1500).then(() => null)])
    let params = opened
    if (!params) {
      if (!(await mouseClick(cdp, SELECTORS.uploadItem))) throw new GeminiError('selector', 'לא מצאתי בתפריט את האפשרות להעלות קבצים.')
      params = await Promise.race([chooser, sleep(10000).then(() => null)])
    }
    if (!params) throw new GeminiError('upload', 'חלון בחירת הקבצים של Gemini לא נפתח.')
    await cdp.call('DOM.setFileInputFiles', { files: files.map((f) => path.resolve(f)), backendNodeId: params.backendNodeId })
  } finally {
    cdp.off('Page.fileChooserOpened')
    await cdp.call('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
  }
  // Uploaded files show up as previews under the box. Without a known preview element, give the upload time.
  const started = Date.now()
  while (Date.now() - started < UPLOAD_WAIT_MS) {
    const n = await count(cdp, SELECTORS.attachment)
    if (n >= before + files.length) break
    // No preview element recognised at all after a while: the selector is out of date, so stop waiting on it.
    if (!n && Date.now() - started > 15000) break
    await sleep(1000)
  }
  // Still uploading (the send button is disabled until it is done): a last pause before sending.
  await sleep(2000)
}

async function send(cdp, text) {
  const focused = await evaluate(cdp, `(() => { const e = ${FIND}(${js(SELECTORS.input)}); if (!e) return false; e.focus(); return true })()`)
  if (!focused) throw new GeminiError('selector', 'לא מצאתי את תיבת הכתיבה של Gemini.')
  await cdp.call('Input.insertText', { text })
  await sleep(600)
  const responsesBefore = await count(cdp, SELECTORS.response)
  if (!(await click(cdp, SELECTORS.send))) {
    // No button found: Enter sends in Gemini's editor.
    for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  return responsesBefore
}

// Done = a new answer exists, nothing is being generated, and its text stopped changing.
async function waitForAnswer(cdp, responsesBefore, timeoutMs) {
  const end = Date.now() + timeoutMs
  let last = ''
  let stable = 0
  while (Date.now() < end) {
    await sleep(POLL_MS)
    const n = await count(cdp, SELECTORS.response)
    if (n <= responsesBefore) continue
    const busy = await exists(cdp, SELECTORS.generating)
    const text = await lastAnswerText(cdp)
    if (!busy && text && text === last) {
      if (++stable >= STABLE_POLLS) return text
    } else stable = 0
    last = text
  }
  throw new GeminiError('timeout', `Gemini לא סיים לענות תוך ${Math.round(timeoutMs / 60000)} דקות.`)
}

// The last answer's text, from whichever response selector matches.
const lastAnswerText = (cdp) =>
  evaluate(cdp, `(() => { for (const s of ${js(SELECTORS.response)}) { const all = document.querySelectorAll(s); if (all.length) return all[all.length - 1].innerText } return '' })()`).catch(() => '')

const docxIn = (dir) => fs.readdirSync(dir).filter((f) => /\.docx$/i.test(f))

// Clicks what looks like a Word download in the last answer and waits for the file to land in `dir`.
async function download(cdp, browser, dir) {
  await browser.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(dir) })
  const before = new Set(docxIn(dir))
  let clicked = await click(cdp, SELECTORS.download, SELECTORS.response)
  if (!clicked) {
    // No known download element: any button or link in the answer whose label or text speaks of a Word download.
    clicked = await evaluate(
      cdp,
      `(() => {
        let last = null
        for (const s of ${js(SELECTORS.response)}) { const all = document.querySelectorAll(s); if (all.length) { last = all[all.length - 1]; break } }
        if (!last) return false
        const re = new RegExp(${js(DOWNLOAD_WORDS.source)}, 'i')
        const hit = [...last.querySelectorAll('a, button')].find((e) => re.test((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '') + ' ' + (e.getAttribute('href') || '')))
        if (!hit) return false
        hit.click()
        return true
      })()`
    )
  }
  if (!clicked) return null
  const end = Date.now() + DOWNLOAD_WAIT_MS
  while (Date.now() < end) {
    await sleep(1000)
    const fresh = docxIn(dir).filter((f) => !before.has(f))
    // A download in progress is named *.crdownload until it is complete.
    if (fresh.length && !fs.readdirSync(dir).some((f) => f.endsWith('.crdownload'))) return path.join(dir, fresh[0])
  }
  return null
}

export const FOLLOW_UP = 'תחזיר את העבודה כקובץ DOCX להורדה, ולא כטקסט בצ\'אט.'

// Sends one assignment and returns { kind: 'docx', path } or, when no Word file came back even after asking for one,
// { kind: 'text', path, text } with the answer saved as Markdown. Throws GeminiError (with a screenshot when it can).
export async function runGemini({ prompt, files = [], dir, timeoutMs = config.gemini.timeoutMinutes * 60000 }) {
  if (!geminiEnabled()) throw new GeminiError('closed', 'Gemini לא מוגדר (GEMINI_URL ריק).')
  fs.mkdirSync(dir, { recursive: true })
  const cdp = await pageConnection()
  let browser
  try {
    browser = await browserConnection()
    await newChat(cdp)
    await attach(cdp, files)
    let before = await send(cdp, prompt)
    await waitForAnswer(cdp, before, timeoutMs)
    let file = await download(cdp, browser, dir)
    if (!file) {
      before = await send(cdp, FOLLOW_UP)
      await waitForAnswer(cdp, before, timeoutMs)
      file = await download(cdp, browser, dir)
    }
    if (file) return { kind: 'docx', path: file }
    const text = (await lastAnswerText(cdp)).trim()
    if (!text) throw new GeminiError('nofile', 'Gemini לא החזיר קובץ וגם לא טקסט.')
    const md = path.join(dir, 'answer.md')
    fs.writeFileSync(md, text)
    return { kind: 'text', path: md, text }
  } catch (e) {
    const err = e instanceof GeminiError ? e : new GeminiError('selector', e.message)
    if (err.code !== 'closed') err.screenshot = await screenshot(cdp, dir)
    throw err
  } finally {
    cdp.close()
    browser?.close()
  }
}

// ── Spark: Gemini's agent, which makes the Google Docs file itself ─────────────

// Picks Spark in the mode/tool picker: an element named Spark, after opening the picker if it is not in sight.
async function selectSpark(cdp) {
  const pick = () =>
    evaluate(
      cdp,
      `(() => {
        const visible = (e) => e.offsetParent !== null || e.getClientRects().length > 0
        const re = new RegExp(${js(SPARK_WORDS.source)}, 'i')
        const all = [...document.querySelectorAll('button, a, [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"], mat-chip, [role="button"]')].filter(visible)
        const hit = all.find((e) => re.test((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '').slice(0, 60)))
        if (!hit) return false
        hit.click()
        return true
      })()`
    )
  if (await pick()) return true
  for (const opener of [SELECTORS.modePicker, SELECTORS.toolsMenu]) {
    if (!(await click(cdp, opener))) continue
    await sleep(900)
    if (await pick()) return true
    for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(300)
  }
  return false
}

// Google Docs (or Sheets/Slides) links anywhere in the conversation, newest last.
const docLinks = (cdp) =>
  evaluate(
    cdp,
    `(() => {
      const re = new RegExp(${js(DOC_LINK.source)}, 'g')
      const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.href)
      const text = document.body ? document.body.innerText : ''
      return [...new Set([...hrefs.filter((h) => new RegExp(${js(DOC_LINK.source)}).test(h)), ...(text.match(re) || [])])]
    })()`
  ).catch(() => [])

export const SPARK_FOLLOW_UP = 'שלח לי בבקשה את הקישור למסמך Google Docs שיצרת.'

// Sends a task to Gemini Spark with files attached, waits until a Google Docs link shows up, and returns
// { url, text, spark } (url null when Spark answered without one: its text says why). Throws GeminiError.
export async function runSpark({ prompt, files = [], dir, timeoutMs = config.gemini.timeoutMinutes * 60000, onStep = () => {} }) {
  if (!geminiEnabled()) throw new GeminiError('closed', 'Gemini לא מוגדר.')
  fs.mkdirSync(dir, { recursive: true })
  const cdp = await pageConnection()
  const end = Date.now() + timeoutMs
  try {
    onStep("פותח צ'אט חדש ב-Gemini")
    await newChat(cdp)
    const known = new Set(await docLinks(cdp))
    const spark = await selectSpark(cdp)
    if (files.length) onStep('מעלה את הקבצים ל-Gemini')
    await attach(cdp, files)
    const ask = spark ? prompt : `${prompt}

(תשתמש ב-Spark כדי ליצור את מסמך ה-Google Docs, ותחזיר לי את הקישור אליו.)`
    let before = await send(cdp, ask)
    onStep(spark ? 'Spark עובד על המסמך' : 'Gemini עובד על המסמך')
    let asked = false
    while (Date.now() < end) {
      let text = ''
      try {
        text = await waitForAnswer(cdp, before, Math.max(30000, end - Date.now()))
      } catch (e) {
        if (!(e instanceof GeminiError && e.code === 'timeout')) throw e
      }
      // Spark keeps working after its first reply: the link can appear minutes later, in the same answer.
      const waitUntil = Math.min(end, Date.now() + 4 * 60000)
      while (Date.now() < waitUntil) {
        const fresh = (await docLinks(cdp)).filter((u) => !known.has(u))
        if (fresh.length) return { url: fresh[fresh.length - 1], text: (await lastAnswerText(cdp)).trim(), spark }
        if (await exists(cdp, SELECTORS.generating)) { await sleep(POLL_MS); continue }
        await sleep(5000)
        if (!asked) break
      }
      if (asked) return { url: null, text: (text || (await lastAnswerText(cdp))).trim(), spark }
      asked = true
      before = await send(cdp, SPARK_FOLLOW_UP)
    }
    throw new GeminiError('timeout', `Gemini לא סיים תוך ${Math.round(timeoutMs / 60000)} דקות.`)
  } catch (e) {
    const err = e instanceof GeminiError ? e : new GeminiError('selector', e.message)
    if (err.code !== 'closed') err.screenshot = await screenshot(cdp, dir)
    throw err
  } finally {
    cdp.close()
  }
}

// What is on the Gemini page right now: visible buttons, links, inputs and editable boxes with their labels.
// For updating gemini-selectors.js after the page changed. Reads only; clicks nothing.
export async function probe() {
  const cdp = await pageConnection()
  try {
    await cdp.call('Runtime.enable')
    return await evaluate(
      cdp,
      `(() => {
        const visible = (e) => e.offsetParent !== null || e.getClientRects().length > 0
        const describe = (e) => {
          const attrs = ['aria-label', 'data-test-id', 'role', 'type', 'mattooltip', 'class'].map((a) => e.getAttribute(a) ? a + '="' + String(e.getAttribute(a)).slice(0, 60) + '"' : '').filter(Boolean).join(' ')
          return e.tagName.toLowerCase() + ' ' + attrs + ' | ' + (e.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
        }
        const els = [...document.querySelectorAll('button, a, input, textarea, [contenteditable="true"], [role="button"], [role="menuitem"]')].filter(visible)
        const custom = [...new Set([...document.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()).filter((t) => t.includes('-')))]
        return { url: location.href, elements: els.slice(0, 120).map(describe), customTags: custom.slice(0, 80) }
      })()`
    )
  } finally {
    cdp.close()
  }
}

// node src/gemini.js probe
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) && process.argv[2] === 'probe') {
  probe()
    .then((p) => {
      console.log(`url: ${p.url}\n\n${p.elements.join('\n')}\n\ncustom tags: ${p.customTags.join(', ')}`)
    })
    .catch((e) => {
      console.log(e.message)
      process.exitCode = 1
    })
}
