// HELPER for Windows. Hold Ctrl+Alt+Space and talk (a tap opens a typing box); hold Right Ctrl to dictate into any
// field; Ctrl+Alt+P to point at something on the screen and then ask about it. Instant commands run with no AI;
// the rest goes to Claude Code on this PC with HELPER's hands, or to HELPER on the cloud.
'use strict'
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, desktopCapturer, ipcMain, session, shell, Notification } = require('electron')
const path = require('path')
const fs = require('fs')

// The second start hands its own arguments over as-is (Chromium reorders the argv it passes on).
if (!app.requestSingleInstanceLock({ argv: process.argv })) { app.quit(); process.exit(0) }
app.setAppUserModelId('il.helper.desktop')
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling')   // our media keys must reach the player

const ROOT = __dirname
let store, apps, speech, instant, hands, handsServer, brain, win32, hook

let bubble = null, pill = null, tray = null
const overlays = new Map()          // display id → transparent window for rings and marks
let mode = 'idle'                   // idle | listening | dictating | thinking | typing | pointing
let voiceAsk = false
let pendingConfirm = null           // resolve(bool) while a confirm card is up
let mark = null                     // what the user pointed at: {x, y, width, height, crop, shot}
let askSeq = 0
let hideTimer = null

const log = (...a) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), new Date().toISOString() + ' ' + a.join(' ') + '\n') } catch { } }

// ---- screens --------------------------------------------------------------------------------------

/** The screens in physical pixels (what Windows' window and mouse functions use). */
function physicalDisplays() {
  return screen.getAllDisplays().map((d) => ({
    id: d.id, scaleFactor: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id,
    bounds: screen.dipToScreenRect(null, d.bounds), workArea: screen.dipToScreenRect(null, d.workArea), dip: d,
  })).sort((a, b) => a.bounds.x - b.bounds.x)
}

const cursorDisplay = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint())

/** A picture of one screen (index into physicalDisplays, or the one with the mouse), saved as PNG. */
/**
 * The screen the user is working on: the one with the window in front (HELPER's own aside), else the mouse's.
 * "מה כתוב על המסך" is about what they are looking at, which is where their window is, not where the mouse rests.
 */
function workingDisplayIndex(ds) {
  const fg = win32.foreground()
  const own = !fg || fg.title === 'HELPER'
  const mine = returnTo || lastOutside
  const target = own ? (mine ? win32.windows().find((w) => win32.handleId(w.hwnd) === win32.handleId(mine)) : null) : fg
  if (target && target.bounds && !target.minimized) {
    const b = target.bounds
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2
    const i = ds.findIndex((d) => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height)
    if (i >= 0) return i
  }
  return Math.max(0, ds.findIndex((x) => x.id === cursorDisplay().id))
}

async function screenshot(index) {
  const ds = physicalDisplays()
  const d = index == null ? ds[workingDisplayIndex(ds)] || ds[0] : ds[Math.max(0, Math.min(ds.length - 1, index))]
  // HELPER's own bubble is not part of what the user asks about.
  const hidden = []
  for (const w of [bubble, pill]) if (w && w.isVisible() && w.getOpacity() > 0) { w.setOpacity(0); hidden.push(w) }
  await new Promise((r) => setTimeout(r, 60))
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.bounds.width, height: d.bounds.height } })
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0]
    if (!src) return null
    const file = path.join(store.workDir(), `screen-${Date.now()}.png`)
    fs.writeFileSync(file, src.thumbnail.toPNG())
    tidyShots()
    return { path: file, display: d, index: ds.indexOf(d), image: src.thumbnail }
  } finally {
    for (const w of hidden) w.setOpacity(1)
  }
}

function tidyShots() {
  const dir = store.workDir()
  const shots = fs.readdirSync(dir).filter((f) => /^(screen|mark)-\d+\.png$/.test(f)).sort()
  for (const f of shots.slice(0, Math.max(0, shots.length - 8))) { try { fs.unlinkSync(path.join(dir, f)) } catch { } }
}

// ---- windows --------------------------------------------------------------------------------------

const PRELOAD = path.join(ROOT, 'ui', 'preload.js')

function makeBubble() {
  bubble = new BrowserWindow({
    width: 680, height: 460, show: false, frame: false, transparent: true, resizable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  bubble.setAlwaysOnTop(true, 'screen-saver')
  bubble.setIgnoreMouseEvents(true, { forward: true })
  bubble.loadFile(path.join(ROOT, 'ui', 'bubble.html'))
  watchConsole(bubble, 'bubble')
}

/** Errors inside HELPER's windows go to app.log. */
function watchConsole(w, name) {
  w.webContents.on('console-message', (e, level, message, line, source) => {
    if (level >= 2) log(`[${name}] ${message} (${path.basename(source || '')}:${line})`)
  })
  w.webContents.on('render-process-gone', (e, d) => log(`[${name}] renderer gone: ${d.reason}`))
}

function makePill() {
  pill = new BrowserWindow({
    width: 260, height: 64, show: false, frame: false, transparent: true, resizable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  pill.setAlwaysOnTop(true, 'screen-saver')
  pill.setIgnoreMouseEvents(true)
  pill.loadFile(path.join(ROOT, 'ui', 'pill.html'))
  watchConsole(pill, 'pill')
}

/** A message for an overlay, held until its page has loaded (a new one is still loading). */
function toOverlay(o, msg) {
  if (o.webContents.isLoading()) o.webContents.once('did-finish-load', () => o.webContents.send('overlay', msg))
  else o.webContents.send('overlay', msg)
}

function overlayFor(display) {
  let o = overlays.get(display.id)
  if (o && !o.isDestroyed()) {
    o.setBounds(display.bounds)
    return o
  }
  o = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
    show: false, frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: true,
    alwaysOnTop: true, focusable: false, hasShadow: false, backgroundColor: '#00000000', enableLargerThanScreen: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  })
  o.setAlwaysOnTop(true, 'screen-saver')
  o.setIgnoreMouseEvents(true)
  o.loadFile(path.join(ROOT, 'ui', 'overlay.html'))
  watchConsole(o, 'overlay')
  o.displayId = display.id
  overlays.set(display.id, o)
  return o
}

/** Puts the bubble at the top centre of the screen with the mouse, and shows it without taking focus. */
function placeBubble() {
  const d = cursorDisplay()
  const [w] = bubble.getSize()
  bubble.setPosition(Math.round(d.workArea.x + (d.workArea.width - w) / 2), d.workArea.y + 14)
  if (!bubble.isVisible()) bubble.showInactive()
}

function bubbleState(state) {
  clearTimeout(hideTimer)
  if (state.mode === 'hidden') {
    bubble.webContents.send('state', state)
    hideTimer = setTimeout(() => { if (mode === 'idle') bubble.hide() }, 260)
    return
  }
  placeBubble()
  bubble.webContents.send('state', state)
}

/** The answer stays a while (longer when long), then goes; the mouse over it keeps it. */
function answer(text, extra = {}) {
  mode = 'idle'
  bubbleState(Object.assign({ mode: 'answer', text }, extra))
  const ms = Math.min(20000, 5000 + text.length * 70)
  hideTimer = setTimeout(() => { if (mode === 'idle' && !bubbleHovered) bubbleState({ mode: 'hidden' }) }, ms)
}
let bubbleHovered = false

// ---- talking --------------------------------------------------------------------------------------

function startListening() {
  noteOutside()
  if (mode === 'thinking') brain.cancel()
  mode = 'listening'
  voiceAsk = true
  bubbleState({ mode: 'listening', mark: Boolean(mark) })
  bubble.webContents.send('record', { action: 'start', purpose: 'ask' })
}

function stopListening(cancel) {
  if (mode !== 'listening') return
  bubble.webContents.send('record', { action: cancel ? 'cancel' : 'stop', purpose: 'ask' })
  if (cancel) { mode = 'idle'; bubbleState({ mode: 'hidden' }) } else { mode = 'thinking'; bubbleState({ mode: 'thinking', text: 'מתמלל…' }) }
}

/** The window that was in front before HELPER took the keyboard: it gets it back, so "זה" and typing mean it. */
let returnTo = null
/** The last window outside HELPER that had the keyboard: the way back when HELPER's cards follow each other. */
let lastOutside = null

/** Gives the keyboard to one of HELPER's windows (Windows lets only the app in front do that, so it is attached). */
function takeKeyboard(w) {
  if (!returnTo) {
    const fg = win32.foreground()
    if (fg && fg.title !== 'HELPER') { returnTo = fg.hwnd; lastOutside = fg.hwnd }
    else returnTo = lastOutside
  }
  w.setFocusable(true)
  w.setIgnoreMouseEvents(false)
  // Windows sometimes refuses the first time (another app just took the foreground): try again a few times.
  const own = w.getNativeWindowHandle()
  const tryFocus = (n) => {
    if (w.isDestroyed() || !w.isFocusable()) return
    win32.focusOwn(own)
    w.focus()
    setTimeout(() => {
      const fg = win32.foreground()
      if ((!fg || fg.title !== 'HELPER') && n > 0) tryFocus(n - 1)
    }, 60)
  }
  tryFocus(4)
}

/** Notes the user's window in front (not HELPER's): the screen they work on, and where the keyboard goes back. */
function noteOutside() {
  const fg = win32.foreground()
  if (fg && fg.title !== 'HELPER') lastOutside = fg.hwnd
}

function giveKeyboardBack() {
  const h = returnTo
  returnTo = null
  if (!h) return
  // Checked and tried again: while HELPER's window lets go, Windows can leave the keyboard with no one for a moment.
  const id = win32.handleId(h)
  const attempt = (n) => {
    try { win32.focus(h) } catch (e) { log('give back failed', e.message); return }
    setTimeout(() => {
      const fg = win32.foreground()
      if (fg && win32.handleId(fg.hwnd) === id) return
      if (n > 0) return attempt(n - 1)
      log('keyboard not back; in front:', fg ? `${fg.app} "${fg.title}"` : 'nothing')
    }, 80)
  }
  attempt(4)
}

function startTyping() {
  mode = 'typing'
  voiceAsk = false
  bubbleState({ mode: 'typing', mark: Boolean(mark) })
  takeKeyboard(bubble)
}

function endTyping() {
  // Back first, while HELPER still has the keyboard (Windows lets only the app in front hand it on); then the box
  // stops taking it. The other way round, Windows takes it from the box and gives it to no one.
  giveKeyboardBack()
  bubble.setFocusable(false)
  bubble.setIgnoreMouseEvents(true, { forward: true })
}

function startDictation() {
  mode = 'dictating'
  const d = cursorDisplay()
  const [w, h] = pill.getSize()
  pill.setPosition(Math.round(d.workArea.x + (d.workArea.width - w) / 2), Math.round(d.workArea.y + d.workArea.height - h - 28))
  pill.showInactive()
  pill.webContents.send('state', { mode: 'listening' })
  pill.webContents.send('record', { action: 'start', purpose: 'dictate' })
}

function stopDictation(cancel) {
  if (mode !== 'dictating') return
  mode = 'idle'
  pill.webContents.send('record', { action: cancel ? 'cancel' : 'stop', purpose: 'dictate' })
  if (cancel) pill.hide()
  else pill.webContents.send('state', { mode: 'working' })
}

/** Names and words the speech model should spell right: the apps, and words from memory. */
function speechHints() {
  const names = ['HELPER', 'כרום', 'ספוטיפיי', 'דיסקורד', 'וואטסאפ', 'יוטיוב', 'סטרימיו', 'נטפליקס']
  return names.join(', ')
}

async function onAudio({ wav, purpose }) {
  const bytes = Buffer.from(wav)
  // Under half a second, or no speech in it: nothing was said (whisper would make something up).
  if (bytes.length < 16000 || !speech.hasSpeech(bytes)) {
    if (purpose === 'dictate') { pill.hide(); return }
    mode = 'idle'
    return bubbleState({ mode: 'hidden' })
  }
  let text = ''
  try {
    text = await speech.transcribe(ROOT, bytes, speechHints())
  } catch (e) {
    log('speech failed', e.message)
    if (purpose === 'dictate') { pill.webContents.send('state', { mode: 'error', text: 'הדיבור לא עבד' }); setTimeout(() => pill.hide(), 1800); return }
    return answer('לא הצלחתי לשמוע: ' + e.message, { error: true })
  }
  if (purpose === 'dictate') return dictate(text)
  if (!text) { mode = 'idle'; return bubbleState({ mode: 'hidden' }) }
  handleAsk(text, { voice: true })
}

/** Dictation: the words go into whatever field has focus, then the pill shows a check. */
async function dictate(text) {
  if (!text) { pill.hide(); return }
  const fg = win32.foreground()
  if (!fg || fg.title === 'HELPER' || /^(electron|helper)/i.test(fg.app || '')) {
    pill.webContents.send('state', { mode: 'error', text: 'אין שדה פתוח להקליד בו' })
    setTimeout(() => pill.hide(), 2200)
    return
  }
  // Steadily, a character at a time: many fields drop a burst. A sentence takes a fraction of a second.
  await win32.typeSteady(text + (/[.?!:]$/.test(text) ? ' ' : ''))
  pill.webContents.send('state', { mode: 'done', text })
  setTimeout(() => pill.hide(), 1100)
  store.log({ kind: 'dictation', chars: text.length })
}

// ---- asks -----------------------------------------------------------------------------------------

const SCREEN_WORDS = /(מסך|כתוב|רואה|רואים|תסתכל|הזה|הזאת|הזו|איפה|לוחצים|ללחוץ|מדליקים|לכבות|השגיאה|שגיאה|הקוד|התמונה|הסרטון|המייל הזה|ההודעה הזאת|הטבלה|הגרף|screen|this|error|where|click)/i
const YES = /^(כן|כן כן|יאללה|סבבה|בטח|אוקיי|אוקי|תעשה|תשלח|מאשר|yes|yeah|ok|okay|sure)$/i
const NO = /^(לא|לא לא|עזוב|בטל|תבטל|אל תשלח|no|nope|cancel)$/i

async function handleAsk(raw, { voice = false } = {}) {
  noteOutside()
  const seq = ++askSeq
  const text = instant.tidy(raw)
  const started = Date.now()
  mode = 'thinking'

  // An open "are you sure?": the answer to it.
  if (pendingConfirm) {
    if (YES.test(text)) { const r = pendingConfirm; pendingConfirm = null; r(true); return bubbleState({ mode: 'thinking', heard: raw, text: 'ממשיך…' }) }
    if (NO.test(text)) { const r = pendingConfirm; pendingConfirm = null; r(false); return answer('ביטלתי') }
  }

  bubbleState({ mode: 'thinking', heard: raw })

  // 1. Instant commands: no AI.
  const parsed = mark ? null : instant.parse(text)
  if (parsed) {
    try {
      if (parsed.remember) { store.remember(parsed.remember); return finish(seq, raw, 'אזכור 👍', 'instant', started) }
      if (parsed.forget) { const n = store.forget(parsed.forget); return finish(seq, raw, n ? 'שכחתי' : 'לא היה לי את זה בזיכרון', 'instant', started) }
      if (parsed.unlearn) { return finish(seq, raw, store.unlearn(parsed.unlearn) ? `מחקתי את "${parsed.unlearn}"` : `אין לי קיצור בשם "${parsed.unlearn}"`, 'instant', started) }
      if (parsed.teach) {
        const does = instant.parse(parsed.teach.does)
        store.learn(parsed.teach.phrase, does && does.steps ? does.steps : [{ say: parsed.teach.does }], 'taught')
        return finish(seq, raw, `סגור. כשתגיד "${parsed.teach.phrase}" אני ${does && does.steps ? 'עושה את זה מיד' : 'אדע מה לעשות'}`, 'instant', started)
      }
      const lines = await hands.runAll(parsed.steps)
      return finish(seq, raw, lines.join(' · ') || 'בוצע', 'instant', started)
    } catch (e) {
      return finish(seq, raw, e.message, 'instant', started, true)
    }
  }

  // 2. A shortcut learned before.
  const known = mark ? null : store.lookup(text)
  if (known) {
    try {
      if (known.steps.length === 1 && known.steps[0].say) return handleAsk(known.steps[0].say, { voice })
      const lines = await hands.runAll(known.steps)
      return finish(seq, raw, lines.join(' · ') || 'בוצע', 'learned', started)
    } catch (e) {
      store.unlearn(text)   // it no longer works: next time the brain works it out again
      log('learned shortcut failed, forgotten:', text, e.message)
    }
  }

  // 3. The brain. The screen comes along when the ask is about it, or when the user pointed at something.
  const extra = { screens: physicalDisplays().map((d, i) => `${i + 1}: ${d.bounds.width}x${d.bounds.height} ב-(${d.bounds.x},${d.bounds.y})`).join(', ') }
  const fg = win32.foreground()
  if (fg) extra.foreground = `${fg.app} — ${hands.strip(fg.title)}`
  // The open windows come with the ask, so Claude acts at once instead of spending a round on asking for them.
  try { extra.windows = (await hands.run({ cmd: 'windows' })).split('\n').slice(0, 25).join('\n') } catch { }
  if (mark) {
    extra.mark = mark
    extra.screenshot = { path: mark.shot, note: 'צילום של כל המסך שבו הוא סימן' }
  } else if (SCREEN_WORDS.test(text)) {
    const shot = await screenshot(null)
    if (shot) extra.screenshot = { path: shot.path, note: `מסך ${shot.index + 1}, ${shot.display.bounds.width}x${shot.display.bounds.height}; נקודה (px,py) בתמונה היא (${shot.display.bounds.x}+px, ${shot.display.bounds.y}+py) במסך` }
  }
  const usedMark = Boolean(mark)
  mark = null
  clearMarks()

  handsServer.startRecording()
  const steps = []
  let lookedAtScreen = false
  const res = await brain.askClaude(raw, extra, (ev) => {
    if (seq !== askSeq) return
    if (ev.type === 'tool' && ev.name === 'Read' && /.png$/i.test((ev.input || {}).file_path || '')) lookedAtScreen = true
    if (ev.type === 'tool' && ev.name !== 'Bash') steps.push(stepLabel(ev))
    if (ev.type === 'tool' || ev.type === 'text') bubbleState({ mode: 'thinking', heard: raw, steps: steps.slice(-3) })
  })
  const record = handsServer.stopRecording()
  if (seq !== askSeq) return

  if (res.ok && res.text) {
    // Learn it when every step was a plain, repeatable action that worked, and nothing depended on what was on
    // the screen (Claude did not look at it, the user pointed at nothing).
    if (!usedMark && !lookedAtScreen && record.length && record.every((s) => s.ok && hands.REPLAYABLE.has(s.cmd))) {
      store.learn(text, record.map((s) => ({ cmd: s.cmd, args: s.args })), 'claude')
    }
    return finish(seq, raw, res.text, 'claude', started, false, voice)
  }

  log('claude gave no answer:', JSON.stringify(res).slice(0, 400))
  // 4. HELPER on the cloud, when Claude Code can't run (or gave no answer).
  // English words sit in direction isolates (LRI…PDI) so "/login" and paths read right inside Hebrew.
  const iso = (s) => '⁦' + s + '⁩'
  const claudeHow = res.signedOut ? `צריך לחבר את Claude Code במחשב: בטרמינל מריצים ${iso('claude')} ואז ${iso('/login')}.`
    : res.missing ? `Claude Code לא מותקן במחשב (${iso('npm i -g @anthropic-ai/claude-code')}).`
    : res.text ? '' : 'Claude Code לא הצליח לענות הפעם.'
  try {
    const h = await brain.askHelper(raw, { voice: voice && store.settings().speakAnswers })
    if (seq !== askSeq) return
    return finish(seq, raw, h.reply || 'אין תשובה', 'cloud', started, false, voice, h.audio, claudeHow ? 'ענה HELPER מהענן. ' + claudeHow : '')
  } catch (e) {
    const cloudHow = /חסר קוד חיבור/.test(e.message) ? `HELPER בענן עוד לא מחובר: מריצים פעם אחת את ${iso('desktop\\connect.ps1')}.` : e.message
    return finish(seq, raw, claudeHow || cloudHow, 'none', started, true, false, null, claudeHow ? cloudHow : '')
  }
}

function stepLabel(ev) {
  const i = ev.input || {}
  if (ev.name === 'Read') return /\.png$/i.test(i.file_path || '') ? 'מסתכל על המסך' : 'קורא קובץ'
  if (ev.name === 'WebSearch') return 'מחפש ברשת: ' + String(i.query || '').slice(0, 40)
  if (ev.name === 'WebFetch') return 'קורא דף'
  if (ev.name === 'Glob' || ev.name === 'Grep') return 'מחפש קבצים'
  return ev.name
}

async function finish(seq, heard, text, route, started, error = false, voice = false, audio = null, note = '') {
  if (seq !== askSeq) return
  store.log({ heard, route, ms: Date.now() - started, error, answer: String(text).slice(0, 200) })
  answer(text, { heard, route, error, note })
  if (voice && store.settings().speakAnswers && !error) {
    try {
      const mp3 = audio ? Buffer.from(audio, 'base64') : await brain.voiceOf(text)
      if (mp3 && seq === askSeq) bubble.webContents.send('play', mp3.toString('base64'))
    } catch { /* the text is there */ }
  }
}

// ---- the user pointing ---------------------------------------------------------------------------

function startPointing() {
  noteOutside()
  mode = 'pointing'
  const d = cursorDisplay()
  const o = overlayFor(d)
  o.showInactive()
  takeKeyboard(o)
  toOverlay(o, { mode: 'pick' })
  bubbleState({ mode: 'hint', text: 'סמן במסך: לחיצה, או גרירה סביב מה שמעניין אותך. Esc לביטול.' })
}

async function onMark({ x, y, width, height }, sender) {
  const o = BrowserWindow.fromWebContents(sender)
  if (!o) return
  giveKeyboardBack()
  o.setIgnoreMouseEvents(true)
  o.setFocusable(false)
  const dip = screen.getAllDisplays().find((d) => d.id === o.displayId)
  const ds = physicalDisplays()
  const pd = ds.find((d) => d.id === o.displayId)
  const shot = await screenshot(ds.indexOf(pd))
  if (!shot || !dip) { mode = 'idle'; return }
  // The overlay reports DIPs inside its screen; the screenshot is in physical pixels.
  const s = dip.scaleFactor
  const rect = { x: Math.round(x * s), y: Math.round(y * s), width: Math.max(8, Math.round(width * s)), height: Math.max(8, Math.round(height * s)) }
  const pad = Math.round(80 * s)
  const crop = { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad) }
  crop.width = Math.min(shot.image.getSize().width - crop.x, rect.width + 2 * pad)
  crop.height = Math.min(shot.image.getSize().height - crop.y, rect.height + 2 * pad)
  const cropFile = path.join(store.workDir(), `mark-${Date.now()}.png`)
  fs.writeFileSync(cropFile, shot.image.crop(crop).toPNG())
  mark = { x: pd.bounds.x + rect.x, y: pd.bounds.y + rect.y, width: rect.width, height: rect.height, crop: cropFile, shot: shot.path }
  log('mark', JSON.stringify({ x: mark.x, y: mark.y, width: mark.width, height: mark.height }))
  mode = 'idle'
  bubbleState({ mode: 'hint', text: 'סימנתי 🎯 עכשיו תשאל: החזק Ctrl+Alt+Space ודבר, או לחיצה קצרה להקלדה.', mark: true })
}

function clearMarks() {
  for (const o of overlays.values()) if (!o.isDestroyed()) toOverlay(o, { mode: 'clear' })
}

/** A ring and label on the screen at physical pixel (x, y): "click here". */
function pointAt(x, y, label) {
  const dipPt = screen.screenToDipPoint({ x, y })
  const d = screen.getDisplayNearestPoint(dipPt)
  const o = overlayFor(d)
  o.showInactive()
  toOverlay(o, { mode: 'ring', x: dipPt.x - d.bounds.x, y: dipPt.y - d.bounds.y, label })
  log('point', JSON.stringify({ x, y, label }))
}

// ---- confirm ------------------------------------------------------------------------------------

function confirm(question) {
  return new Promise((resolve) => {
    if (pendingConfirm) pendingConfirm(false)
    pendingConfirm = resolve
    bubbleState({ mode: 'confirm', text: question })
    takeKeyboard(bubble)
    // No answer in two minutes means no.
    setTimeout(() => { if (pendingConfirm === resolve) { pendingConfirm = null; resolve(false); answer('לא אישרת, אז לא עשיתי') } }, 120000)
  })
}

// ---- hotkeys ------------------------------------------------------------------------------------

function startHotkeys() {
  const { uIOhook, UiohookKey: K } = hook
  const down = new Set()
  let talkAt = 0
  let dictTimer = null
  let dictClean = true

  uIOhook.on('keydown', (e) => {
    const k = e.keycode
    const first = !down.has(k)
    down.add(k)
    const ctrl = down.has(K.Ctrl) || down.has(K.CtrlRight)
    const alt = down.has(K.Alt) || down.has(K.AltRight)

    if (k === K.Escape && first) {
      if (mode === 'listening') return stopListening(true)
      if (mode === 'dictating') return stopDictation(true)
      if (mode === 'pointing') { mode = 'idle'; clearMarks(); giveKeyboardBack(); for (const o of overlays.values()) { o.setIgnoreMouseEvents(true); o.setFocusable(false) } return bubbleState({ mode: 'hidden' }) }
      if (pendingConfirm) { const r = pendingConfirm; pendingConfirm = null; r(false); endTyping(); return answer('ביטלתי') }
      if (mode === 'thinking') { brain.cancel(); askSeq++; mode = 'idle'; return bubbleState({ mode: 'hidden' }) }
      if (mark) { mark = null; clearMarks() }
      if (bubble.isVisible() && mode !== 'typing') { mode = 'idle'; return bubbleState({ mode: 'hidden' }) }
    }

    // Ctrl+Alt+Space: hold to talk.
    if (k === K.Space && first && ctrl && alt && mode !== 'listening' && mode !== 'typing') {
      talkAt = Date.now()
      return startListening()
    }
    // Ctrl+Alt+P: point.
    if (k === K.P && first && ctrl && alt) return startPointing()

    // Right Ctrl alone, held: dictation. Any other key with it makes it a shortcut, not dictation.
    if (k === K.CtrlRight && first && down.size === 1) {
      dictClean = true
      clearTimeout(dictTimer)
      dictTimer = setTimeout(() => { if (dictClean && down.has(K.CtrlRight) && down.size === 1 && mode === 'idle') startDictation() }, 280)
    } else if (k !== K.CtrlRight) {
      dictClean = false
    }
  })

  uIOhook.on('keyup', (e) => {
    const k = e.keycode
    down.delete(k)
    if (mode === 'listening' && (k === K.Space || k === K.Ctrl || k === K.CtrlRight || k === K.Alt || k === K.AltRight)) {
      if (Date.now() - talkAt < 350) {
        // A tap: type instead of talking.
        bubble.webContents.send('record', { action: 'cancel', purpose: 'ask' })
        return startTyping()
      }
      return stopListening(false)
    }
    if (k === K.CtrlRight) {
      clearTimeout(dictTimer)
      if (mode === 'dictating') stopDictation(false)
    }
  })
  uIOhook.start()
  log('hotkeys on')
}

// ---- tray ---------------------------------------------------------------------------------------

function trayMenu() {
  const s = store.settings()
  const claude = brain.state()
  return Menu.buildFromTemplate([
    { label: 'HELPER למחשב', enabled: false },
    { type: 'separator' },
    { label: 'לדבר: להחזיק Ctrl+Alt+Space', click: () => startTyping() },
    { label: 'להקליד: לחיצה קצרה על Ctrl+Alt+Space', click: () => startTyping() },
    { label: 'הכתבה: להחזיק Ctrl ימני', enabled: false },
    { label: 'להצביע על המסך: Ctrl+Alt+P', click: () => startPointing() },
    { type: 'separator' },
    { label: 'מודל', submenu: [
      { label: 'מהיר (Haiku)', type: 'radio', checked: s.model === 'haiku', click: () => { store.saveSettings({ model: 'haiku' }); refreshTray() } },
      { label: 'חכם (Sonnet)', type: 'radio', checked: s.model === 'sonnet', click: () => { store.saveSettings({ model: 'sonnet' }); refreshTray() } },
    ] },
    { label: 'תשובות בקול של HELPER', type: 'checkbox', checked: s.speakAnswers, click: (i) => { store.saveSettings({ speakAnswers: i.checked }) } },
    { label: 'להפעיל עם Windows', type: 'checkbox', checked: s.startAtLogin, click: (i) => { store.saveSettings({ startAtLogin: i.checked }); applyLogin() } },
    { type: 'separator' },
    { label: s.helperToken ? 'HELPER בענן: מחובר' : 'HELPER בענן: לא מחובר (connect.ps1)', enabled: false },
    { label: claude === 'signed-out' ? 'Claude Code: צריך ‎/login' : claude === 'missing' ? 'Claude Code: לא מותקן' : claude === 'ok' ? 'Claude Code: מחובר' : 'Claude Code: עוד לא נבדק', enabled: false },
    { label: 'הקיצורים שלמדתי…', click: () => shell.openPath(path.join(app.getPath('userData'), 'learned.json')) },
    { label: 'התיקייה של HELPER…', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'יציאה', click: () => app.quit() },
  ])
}

function refreshTray() { if (tray) tray.setContextMenu(trayMenu()) }

function applyLogin() {
  if (!app.isPackaged) {
    // Running from the source folder: start with the same electron and folder.
    app.setLoginItemSettings({ openAtLogin: store.settings().startAtLogin, path: process.execPath, args: [ROOT] })
  } else {
    app.setLoginItemSettings({ openAtLogin: store.settings().startAtLogin })
  }
}

// ---- start --------------------------------------------------------------------------------------

app.whenReady().then(async () => {
  store = require('./src/store')
  store.init(app.getPath('userData'))
  apps = require('./src/apps')
  apps.init(app.getPath('userData'))
  speech = require('./src/speech')
  instant = require('./src/instant')
  hands = require('./src/hands')
  handsServer = require('./src/hands-server')
  brain = require('./src/brain')
  win32 = require('./src/win32')
  hook = require('uiohook-napi')

  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media'))
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media')

  makeBubble()
  makePill()
  // The layers for rings and marks, one per screen, made now so they are ready the moment they are needed.
  for (const d of screen.getAllDisplays()) overlayFor(d)
  screen.on('display-added', (e, d) => overlayFor(d))

  hands.setUi({
    displays: physicalDisplays,
    screenshot,
    point: pointAt,
    say: (t) => bubbleState({ mode: 'thinking', text: t }),
    confirm,
    askHelper: async (q) => (await brain.askHelper(q)).reply,
  })
  await handsServer.start(app.getPath('userData'), () => {})

  ipcMain.on('audio', (e, data) => onAudio(data))
  ipcMain.on('typed', (e, text) => { endTyping(); if (String(text).trim()) handleAsk(String(text), { voice: false }); else { mode = 'idle'; bubbleState({ mode: 'hidden' }) } })
  ipcMain.on('confirm', (e, yes) => { endTyping(); if (pendingConfirm) { const r = pendingConfirm; pendingConfirm = null; r(Boolean(yes)); if (!yes) answer('ביטלתי'); else bubbleState({ mode: 'thinking', text: 'ממשיך…' }) } })
  ipcMain.on('hover', (e, on) => {
    bubbleHovered = Boolean(on)
    if (mode !== 'typing' && !pendingConfirm) bubble.setIgnoreMouseEvents(!on, { forward: true })
    if (!on && mode === 'idle' && bubble.isVisible()) { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!bubbleHovered && mode === 'idle') bubbleState({ mode: 'hidden' }) }, 4000) }
  })
  ipcMain.on('dismiss', () => { endTyping(); mode = 'idle'; bubbleState({ mode: 'hidden' }) })
  ipcMain.on('mark', (e, rect) => onMark(rect, e.sender))
  ipcMain.on('mark-cancel', (e) => { const o = BrowserWindow.fromWebContents(e.sender); giveKeyboardBack(); if (o) { o.setIgnoreMouseEvents(true); o.setFocusable(false) } mode = 'idle'; bubbleState({ mode: 'hidden' }) })
  ipcMain.on('pill-audio', (e, data) => onAudio(data))

  const icon = nativeImage.createFromPath(path.join(ROOT, 'ui', 'icon.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('HELPER — להחזיק Ctrl+Alt+Space ולדבר')
  tray.setContextMenu(trayMenu())
  tray.on('click', () => startTyping())
  tray.on('right-click', () => refreshTray())

  applyLogin()
  startHotkeys()

  // The speech model loads onto the graphics card in the background (a few seconds), so the first ask is quick.
  speech.start(ROOT, log).then(() => log('speech ready')).catch((e) => log('speech not started:', e.message))
  if (!speech.available(ROOT)) new Notification({ title: 'HELPER', body: 'מנוע הדיבור לא הורד: desktop\\vendor חסר. הכתיבה עובדת.' }).show()

  log('started')
  askFromArgs(process.argv)
})

/** `--ask "תפתח את ספוטיפיי"` on the command line: that ask, as if typed (Stream Deck buttons, shortcuts, tests). */
function askFromArgs(argv) {
  // A second instance's argv has Chromium's own switches slipped in (--allow-file-access-from-files…), so the text
  // is the first argument after --ask that is not a switch; --ask="..." works too.
  let text = null
  const eq = argv.find((a) => a.startsWith('--ask='))
  if (eq) text = eq.slice(6)
  const i = argv.indexOf('--ask')
  if (!text && i >= 0) text = argv.slice(i + 1).find((a) => !a.startsWith('--')) || null
  // --shot=<file.png>: a picture of HELPER's own bubble (only its window, nothing behind it), for checking its look.
  const shot = argv.find((a) => a.startsWith('--shot='))
  if (shot) {
    const file = shot.slice(7)
    setTimeout(() => {
      log('shot: bubble visible', bubble.isVisible(), 'bounds', JSON.stringify(bubble.getBounds()), 'mode', mode)
      bubble.webContents.capturePage().then((img) => fs.writeFileSync(file, img.toPNG()))
    }, text ? 2500 : 0)
  }
  // --ask-wav=<file> / --dictate-wav=<file>: a recording in place of the microphone (checking the voice path).
  const askWav = argv.find((a) => a.startsWith('--ask-wav='))
  const dictWav = argv.find((a) => a.startsWith('--dictate-wav='))
  if (askWav || dictWav) {
    const file = (askWav || dictWav).replace(/^--[a-z-]+=/, '')
    const purpose = askWav ? 'ask' : 'dictate'
    if (purpose === 'dictate') { mode = 'dictating'; pill.showInactive() } else { voiceAsk = true; bubbleState({ mode: 'thinking', text: 'מתמלל…' }) }
    onAudio({ wav: fs.readFileSync(file), purpose })
    return true
  }
  if (!text || !text.trim()) return Boolean(shot)
  handleAsk(text.trim(), { voice: false })
  return true
}

app.on('second-instance', (e, argv, cwd, extra) => {
  log('second instance', JSON.stringify(argv), JSON.stringify(extra))
  if (!askFromArgs(extra && Array.isArray(extra.argv) ? extra.argv : argv)) startTyping()
})
app.on('window-all-closed', (e) => e.preventDefault())
app.on('before-quit', () => {
  try { hook && hook.uIOhook.stop() } catch { }
  speech && speech.stop()
  brain && brain.cancel()
})
