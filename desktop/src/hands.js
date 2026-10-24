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

/** What HELPER itself opened lately (app names, newest last), so "close what you opened" means something. */
const opened = []
function noteOpened(name) {
  const i = opened.findIndex((o) => o.name === name)
  if (i >= 0) opened.splice(i, 1)
  opened.push({ name, at: Date.now() })
  if (opened.length > 12) opened.shift()
}
/** The apps opened in the last half hour, oldest first. */
const recentOpened = () => opened.filter((o) => Date.now() - o.at < 30 * 60 * 1000).map((o) => o.name)
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

/** The first real video for a search on YouTube: {id, title}, or null (ads and channels are other renderers). */
async function firstVideo(query) {
  const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=he`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(8000),
  })
  if (!r.ok) throw new Error('יוטיוב לא ענה')
  const html = await r.text()
  const at = html.indexOf('"videoRenderer":{"videoId":"')
  if (at < 0) return null
  const m = html.slice(at, at + 8000).match(/"videoId":"([\w-]{11})"[\s\S]*?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/)
  if (!m) return null
  let title = m[2]
  try { title = JSON.parse('"' + m[2] + '"') } catch { }
  return { id: m[1], title }
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
    const clean = strip(name).toLowerCase().replace(/^(את |ה)(?=\S)/, '')
    if (/^(הורדות|downloads)$/i.test(clean)) {
      await shell.openExternal('shell:Downloads')
      return 'פותח את תיקיית ההורדות'
    }
    if (/^(מסמכים|documents)$/i.test(clean)) {
      await shell.openExternal('shell:Personal')
      return 'פותח את תיקיית המסמכים'
    }
    if (/^(סייר הקבצים|סייר קבצים|קבצים|מחשב שלי|explorer)$/i.test(clean)) {
      await shell.openExternal('shell:MyComputerFolder')
      return 'פותח את סייר הקבצים'
    }
    const app = apps.find(name)
    if (app) {
      apps.launch(app)
      noteOpened(app.name)
      return `פותח את ${app.name}`
    }
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(strip(name))) {
      await shell.openExternal('https://' + strip(name).replace(/^https?:\/\//, ''))
      return `פותח את ${strip(name)}`
    }
    // Web shortcut aliases:
    const SITES = {
      'יוטיוב': 'https://www.youtube.com',
      'גוגל': 'https://www.google.com',
      'וואטסאפ ווב': 'https://web.whatsapp.com',
      'נטפליקס': 'https://www.netflix.com',
      'גיטהאב': 'https://github.com',
      'טוויטר': 'https://x.com',
      'פייסבוק': 'https://facebook.com',
      'אינסטגרם': 'https://instagram.com',
      'רדיט': 'https://reddit.com',
    }
    if (SITES[clean]) {
      await shell.openExternal(SITES[clean])
      return `פותח את ${strip(name)} בדפדפן`
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
    await win.typeSteady(String(text))
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

  /**
   * Plays a video or song: the first real result on YouTube (ads and channels skipped), opened at the watch page,
   * which starts playing. Returns its title. A YouTube link plays as it is.
   */
  async play({ query }) {
    const q = strip(query)
    if (!q) throw new Error('מה לנגן?')
    const link = q.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/)
    let id = link ? link[1] : null
    let title = ''
    if (!id) {
      // The whole query first; when it finds nothing (a misheard word in front), the same without its first words.
      const words = q.split(/\s+/)
      const tries = [q]
      for (let i = 1; words.length - i >= 2 && tries.length < 4; i++) tries.push(words.slice(i).join(' '))
      for (const t of tries) {
        const found = await firstVideo(t)
        if (found) { id = found.id; title = found.title; break }
      }
      if (!id) {
        await shell.openExternal(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`)
        return `לא מצאתי סרטון אחד מתאים, פתחתי את החיפוש: ${q}`
      }
    }
    await shell.openExternal(`https://www.youtube.com/watch?v=${id}`)
    return title ? `מנגן: ${title}` : 'מנגן'
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

  async clipboard({ op = 'read', text = '' }) {
    const { clipboard } = require('electron')
    if (op === 'write' || op === 'set') {
      clipboard.writeText(String(text))
      return 'העתקתי ללוח'
    }
    const content = clipboard.readText()
    return content ? `בלוח העתקות:\n${content.slice(0, 500)}` : 'לוח ההעתקות ריק'
  },

  async system() {
    const os = require('os')
    const totalMem = Math.round(os.totalmem() / (1024 * 1024 * 1024))
    const freeMem = (os.freemem() / (1024 * 1024 * 1024)).toFixed(1)
    const usedMem = (totalMem - Number(freeMem)).toFixed(1)
    const cpus = os.cpus().length
    const uptimeH = Math.round(os.uptime() / 3600)
    return `מעבד: ${cpus} ליבות · זיכרון: ${usedMem}/${totalMem}GB (${freeMem}GB פנוי) · דולק ${uptimeH} שעות`
  },

  async shell({ command }) {
    const { exec } = require('child_process')
    if (!command || !command.trim()) throw new Error('חסרה פקודה להרצה')
    return new Promise((resolve, reject) => {
      exec(command, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error('שגיאה בהרצה: ' + (stderr || err.message)))
        const res = (stdout || stderr || 'בוצע').trim()
        resolve(res.slice(0, 1000))
      })
    })
  },

  async workspace({ mode = 'code' }) {
    if (mode === 'code' || mode === 'work') {
      let codeWin = findWindow('Visual Studio Code') || findWindow('Cursor') || findWindow('Code')
      if (!codeWin) {
        const app = apps.find('Visual Studio Code') || apps.find('Cursor')
        if (app) apps.launch(app)
      }
      let webWin = findWindow('Chrome') || findWindow('Edge') || findWindow('Firefox')
      if (!webWin) {
        const app = apps.find('Chrome') || apps.find('Edge')
        if (app) apps.launch(app)
      }
      await sleep(700)
      codeWin = findWindow('Visual Studio Code') || findWindow('Cursor') || findWindow('Code')
      webWin = findWindow('Chrome') || findWindow('Edge') || findWindow('Firefox')
      const ds = ui.displays()
      const d = ds[0]
      if (d) {
        const a = d.workArea
        const half = Math.round(a.width / 2)
        if (codeWin) win.place(codeWin.hwnd, { x: a.x, y: a.y, width: half, height: a.height })
        if (webWin) win.place(webWin.hwnd, { x: a.x + half, y: a.y, width: half, height: a.height })
      }
      return 'סידרתי מצב עבודה: קוד בצד שמאל ודפדפן בצד ימין'
    }
    if (mode === 'reading' || mode === 'focus') {
      const fg = win.foreground()
      if (fg) {
        const ds = ui.displays()
        const d = ds[0]
        if (d) {
          const a = d.workArea
          win.place(fg.hwnd, { x: a.x + Math.round(a.width * 0.15), y: a.y + Math.round(a.height * 0.05), width: Math.round(a.width * 0.7), height: Math.round(a.height * 0.9) })
        }
      }
      return 'סידרתי מצב קריאה ממוקד'
    }
    if (mode === 'clean') {
      win.combo('win+d')
      return 'ניקיתי את שולחן העבודה'
    }
    return 'סביבת העבודה סודרה'
  },

  async browser_tab({ action = 'new' }) {
    const map = { new: 'ctrl+t', close: 'ctrl+w', reopen: 'ctrl+shift+t', next: 'ctrl+tab', prev: 'ctrl+shift+tab', refresh: 'ctrl+r' }
    win.combo(map[action] || 'ctrl+t')
    const labels = {
      new: 'פתחתי כרטיסייה חדשה', close: 'סגרתי כרטיסייה', reopen: 'פתחתי מחדש את הכרטיסייה האחרונה',
      next: 'עברתי לכרטיסייה הבאה', prev: 'עברתי לכרטיסייה הקודמת', refresh: 'רעננתי את הדף'
    }
    return labels[action] || 'בוצע בדפדפן'
  },

  async latest_download({ open = false } = {}) {
    const home = process.env.USERPROFILE || ''
    const dlDir = path.join(home, 'Downloads')
    if (!fs.existsSync(dlDir)) throw new Error('תיקיית ההורדות לא נמצאה')
    const files = fs.readdirSync(dlDir).map((f) => {
      const p = path.join(dlDir, f)
      try {
        const stat = fs.statSync(p)
        return { name: f, path: p, time: stat.mtimeMs, isFile: stat.isFile() }
      } catch { return null }
    }).filter(f => f && f.isFile).sort((a, b) => b.time - a.time)

    if (!files.length) return 'לא נמצאו קבצים בתיקיית ההורדות'
    const latest = files[0]
    if (open) {
      await shell.openPath(latest.path)
      return `פותח את הקובץ האחרון: ${latest.name}`
    }
    return `הקובץ האחרון שהורד:\n${latest.name}`
  },

  async wait({ ms = 500 }) {
    await sleep(Math.min(10000, Number(ms) || 500))
    return ''
  },
}

/** Steps whose effect is visible and harmless to repeat: only these become learned shortcuts. */
const REPLAYABLE = new Set(['open', 'focus', 'close', 'place', 'desktop', 'volume', 'media', 'web', 'search', 'play', 'key', 'wait', 'clipboard', 'system', 'workspace', 'browser_tab'])

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

module.exports = { actions, run, runAll, setUi, recentOpened, listWindows, findWindow, waitWindow, pickDisplay, REPLAYABLE, strip }
