// HELPER's hands on this PC: every action the instant commands and Claude Code can take, in one place. Each one is
// a plain step {cmd, args}, so a run that worked can be saved as a learned shortcut and replayed with no AI.
'use strict'
const { shell } = require('electron')
const win = require('./win32')
const apps = require('./apps')
const store = require('./store')

/** Set by main.js: the screens, and the parts that need windows (screenshot, pointer, bubble, confirm). */
let ui = {
  displays: () => [],             // [{id, bounds, workArea, scaleFactor}] in physical screen pixels
  screenshot: async () => null,   // (displayIndex) → {path, display}
  point: () => {},                // (x, y, label) in physical pixels
  say: () => {},                  // (text)
  step: () => {},                 // (text): a line under the answer while it works
  confirm: async () => false,     // (question) → true when the user said yes
  askHelper: async () => '',      // (question) → HELPER's answer from the cloud (its memory, WhatsApp, mail…)
}
const setUi = (u) => { ui = Object.assign(ui, u) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strip = (s) => String(s || '').replace(/[‎‏‪-‮]/g, '').trim()

// ---- finding things -------------------------------------------------------------------------------

function listWindows() {
  const displays = ui.displays()
  return win.windows().map((w) => ({
    id: win.handleId(w.hwnd), app: w.app, title: strip(w.title), minimized: w.minimized, maximized: w.maximized,
    screen: displayIndexOf(w.bounds, displays), bounds: w.bounds, hwnd: w.hwnd,
  }))
}

/** The window for a spoken app name or a window id: the one in front first, then the most recent. */
function findWindow(name) {
  const list = listWindows()
  if (/^\d+$/.test(String(name))) return list.find((w) => w.id === String(name)) || null
  const n = strip(name)
  if (/^(זה|הזה|החלון הזה|החלון|this|it|current)$/i.test(n)) {
    const fg = win.foreground()
    return fg ? list.find((w) => w.id === win.handleId(fg.hwnd)) || null : null
  }
  return list.find((w) => apps.windowMatches(w, n)) || null
}

/** The same, waiting up to ms for a window that is still opening (an app launched a moment ago). */
async function waitWindow(name, ms = 5000) {
  const until = Date.now() + ms
  for (;;) {
    const w = findWindow(name)
    if (w || Date.now() > until) return w
    await sleep(250)
  }
}

function displayIndexOf(b, displays) {
  if (!b || !displays.length) return 0
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2
  let best = 0, bestD = Infinity
  displays.forEach((d, i) => {
    const r = d.bounds
    if (cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height) { best = i; bestD = -1 }
    else if (bestD >= 0) {
      const dx = Math.max(r.x - cx, 0, cx - (r.x + r.width)), dy = Math.max(r.y - cy, 0, cy - (r.y + r.height))
      if (dx + dy < bestD) { bestD = dx + dy; best = i }
    }
  })
  return best
}

/** A screen by words: "השני", "הימני", "הגדול", a number, or relative to the window's current one. */
function pickDisplay(which, current) {
  const ds = ui.displays()
  if (ds.length <= 1) return 0
  const w = strip(which)
  if (/^\d+$/.test(w)) return Math.min(ds.length - 1, Math.max(0, Number(w) - 1))
  if (/ימני|right/.test(w)) return ds.reduce((bi, d, i) => (d.bounds.x > ds[bi].bounds.x ? i : bi), 0)
  if (/שמאלי|left/.test(w)) return ds.reduce((bi, d, i) => (d.bounds.x < ds[bi].bounds.x ? i : bi), 0)
  if (/גדול|big|large/.test(w)) return ds.reduce((bi, d, i) => (d.bounds.width * d.bounds.height > ds[bi].bounds.width * ds[bi].bounds.height ? i : bi), 0)
  if (/ראשי|main|primary/.test(w)) return Math.max(0, ds.findIndex((d) => d.primary))
  return (current + 1) % ds.length   // "the other one" / "the next one"
}

// ---- the actions --------------------------------------------------------------------------------

/** Each takes args and returns a short Hebrew line for the bubble. Throws with a Hebrew message on failure. */
const actions = {
  async windows() {
    return listWindows().map((w) => `${w.id}\t${w.app}\tמסך ${w.screen + 1}${w.minimized ? '\tממוזער' : ''}${w.maximized ? '\tמוגדל' : ''}\t${w.title}`).join('\n') || 'אין חלונות פתוחים'
  },

  async apps(args) {
    const q = strip(args.query || '')
    const list = apps.list().filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()))
    return list.slice(0, 60).map((a) => a.name).join('\n')
  },

  /** Opens an app (brings its window forward when it is already open), or a website when no app has that name. */
  async open({ name }) {
    const w = findWindow(name)
    if (w) {
      win.focus(w.hwnd)
      return `עברתי ל${strip(name)}`
    }
    const app = apps.find(name)
    if (app) {
      apps.launch(app)
      return `פותח את ${app.name}`
    }
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(strip(name))) {
      await shell.openExternal('https://' + strip(name).replace(/^https?:\/\//, ''))
      return `פותח את ${strip(name)}`
    }
    throw new Error(`לא מצאתי אפליקציה בשם ${strip(name)}`)
  },

  async focus({ name }) {
    const w = await waitWindow(name)
    if (!w) throw new Error(`אין חלון פתוח של ${strip(name)}`)
    win.focus(w.hwnd)
    return `עברתי ל${strip(name)}`
  },

  async close({ name }) {
    const w = findWindow(name)
    if (!w) throw new Error(`אין חלון פתוח של ${strip(name)}`)
    win.close(w.hwnd)
    return `סגרתי את ${strip(name) === 'זה' ? 'החלון' : strip(name)}`
  },

  /**
   * Places a window: where = left | right | top | bottom | max | min | restore | center | full, on a screen
   * ("השני", "הימני", a number) or the one it is on.
   */
  async place({ name, where = 'max', screen }) {
    const w = await waitWindow(name)
    if (!w) throw new Error(`אין חלון פתוח של ${strip(name)}`)
    const ds = ui.displays()
    const index = screen != null && screen !== '' ? pickDisplay(screen, w.screen) : w.screen
    const d = ds[index] || ds[0]
    if (where === 'min') { win.minimize(w.hwnd); return `מזערתי את ${strip(name)}` }
    if (where === 'restore') { win.restore(w.hwnd); return `החזרתי את ${strip(name)}` }
    if (!d) { win.maximize(w.hwnd); return 'הגדלתי' }
    const a = d.workArea
    const half = Math.round(a.width / 2), halfH = Math.round(a.height / 2)
    const rects = {
      left: { x: a.x, y: a.y, width: half, height: a.height },
      right: { x: a.x + a.width - half, y: a.y, width: half, height: a.height },
      top: { x: a.x, y: a.y, width: a.width, height: halfH },
      bottom: { x: a.x, y: a.y + a.height - halfH, width: a.width, height: halfH },
      center: { x: a.x + Math.round(a.width * 0.15), y: a.y + Math.round(a.height * 0.1), width: Math.round(a.width * 0.7), height: Math.round(a.height * 0.8) },
    }
    if (where === 'max' || where === 'full' || !rects[where]) {
      // Maximizing on another screen: move it there first, then maximize.
      if (index !== w.screen) win.place(w.hwnd, rects.center)
      win.maximize(w.hwnd)
    } else {
      win.place(w.hwnd, rects[where])
    }
    win.focus(w.hwnd)
    const words = { left: 'בצד שמאל', right: 'בצד ימין', top: 'למעלה', bottom: 'למטה', center: 'באמצע', max: 'על כל המסך', full: 'על כל המסך' }
    return `${strip(name) === 'זה' ? 'החלון' : strip(name)} ${words[where] || ''}${ds.length > 1 && index !== w.screen ? ` במסך ${index + 1}` : ''}`.replace(/\s+/g, ' ').trim()
  },

  async desktop() {
    win.combo('win+d')
    return 'הצגתי את שולחן העבודה'
  },

  async type({ text }) {
    win.type(String(text))
    return 'הקלדתי'
  },

  async key({ keys }) {
    win.combo(keys)
    return 'לחצתי ' + keys
  },

  async click({ x, y, button = 'left', count = 1 }) {
    win.click(Number(x), Number(y), button, Number(count) || 1)
    return 'לחצתי'
  },

  async scroll({ amount = -3 }) {
    win.scroll(Number(amount))
    return 'גללתי'
  },

  /** op: up | down | mute | set; value 0-100 for set, or a number of steps for up and down. */
  async volume({ op, value }) {
    const steps = Math.max(1, Math.min(50, Number(value) || 5))
    if (op === 'mute') { win.combo('mute'); return 'השתקתי' }
    if (op === 'set') {
      const target = Math.max(0, Math.min(100, Number(value) || 0))
      win.keys(Array.from({ length: 50 }, () => [{ vk: win.VK.volumedown }, { vk: win.VK.volumedown, up: true }]).flat())
      const n = Math.round(target / 2)
      if (n) win.keys(Array.from({ length: n }, () => [{ vk: win.VK.volumeup }, { vk: win.VK.volumeup, up: true }]).flat())
      return `העוצמה על ${target}`
    }
    const vk = op === 'down' ? win.VK.volumedown : win.VK.volumeup
    win.keys(Array.from({ length: steps }, () => [{ vk }, { vk, up: true }]).flat())
    return op === 'down' ? 'הנמכתי' : 'הגברתי'
  },

  async media({ op }) {
    const map = { play: 'playpause', pause: 'playpause', toggle: 'playpause', next: 'next', prev: 'prev', stop: 'stop' }
    win.combo(map[op] || 'playpause')
    return { next: 'הבא', prev: 'הקודם', stop: 'עצרתי' }[op] || (op === 'play' ? 'ממשיך' : 'עצרתי')
  },

  async web({ url }) {
    await shell.openExternal(/^https?:/.test(url) ? url : 'https://' + url)
    return 'פתחתי'
  },

  async search({ query, site }) {
    const q = encodeURIComponent(strip(query))
    const url = site === 'youtube' ? `https://www.youtube.com/results?search_query=${q}`
      : site === 'maps' ? `https://www.google.com/maps/search/${q}`
      : site === 'lucky' ? `https://www.google.com/search?btnI=1&q=${q}`
      : `https://www.google.com/search?q=${q}`
    await shell.openExternal(url)
    return site === 'youtube' ? `מחפש ביוטיוב: ${strip(query)}` : `מחפש: ${strip(query)}`
  },

  async lock() {
    win.lock()
    return 'נעלתי'
  },

  async time() {
    const now = new Date()
    return `השעה ${now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}, ${now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}`
  },

  /** A picture of a screen (the one with the mouse by default): its file path, for Claude to read. */
  async screenshot({ screen } = {}) {
    const shot = await ui.screenshot(screen == null || screen === '' ? null : Number(screen) - 1)
    if (!shot) throw new Error('לא הצלחתי לצלם את המסך')
    const d = shot.display
    return `${shot.path}\nמסך ${shot.index + 1}: ${d.bounds.width}x${d.bounds.height} פיקסלים, מתחיל ב-(${d.bounds.x},${d.bounds.y}). מיקום בתמונה (px,py) הוא נקודה (${d.bounds.x}+px, ${d.bounds.y}+py) במסך.`
  },

  /** A ring and a label on the screen at (x, y), in screen pixels: "this is where to click". */
  async point({ x, y, label = '' }) {
    ui.point(Number(x), Number(y), strip(label))
    return 'סימנתי'
  },

  async say({ text }) {
    ui.say(strip(text))
    return ''
  },

  async confirm({ question }) {
    return (await ui.confirm(strip(question))) ? 'כן' : 'לא'
  },

  async remember({ fact }) {
    store.remember(strip(fact))
    return 'אזכור'
  },

  async forget({ words }) {
    const n = store.forget(strip(words))
    return n ? 'שכחתי' : 'לא היה לי את זה'
  },

  /** A question for HELPER on the cloud, which knows the WhatsApp chats, mail, calendar and the user's memory. */
  async helper({ question }) {
    return await ui.askHelper(strip(question))
  },

  async wait({ ms = 500 }) {
    await sleep(Math.min(10000, Number(ms) || 500))
    return ''
  },
}

/** Steps whose effect is visible and harmless to repeat: only these become learned shortcuts. */
const REPLAYABLE = new Set(['open', 'focus', 'close', 'place', 'desktop', 'volume', 'media', 'web', 'search', 'key', 'wait'])

async function run(step) {
  const fn = actions[step.cmd]
  if (!fn) throw new Error('פעולה לא מוכרת: ' + step.cmd)
  return await fn(step.args || {})
}

/** Runs steps in order; returns their lines. A step that fails stops the rest. */
async function runAll(steps) {
  const lines = []
  for (const s of steps) {
    const line = await run(s)
    if (line) lines.push(line)
    if (s.cmd === 'open') await sleep(350)   // let a new window appear before the next step looks for it
  }
  return lines
}

module.exports = { actions, run, runAll, setUi, listWindows, findWindow, waitWindow, pickDisplay, REPLAYABLE, strip }
