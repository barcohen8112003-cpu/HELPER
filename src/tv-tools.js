// Tools the model uses to run the TV through the HELPER home screen on it. Opening an app, a remote key or the
// volume is what a remote control does, so none of them asks first.
import { tvConnected, tvCall, matchApp } from './tv-app.js'
import { runOnTv } from './tv-agent.js'

const CINEMETA = 'https://v3-cinemeta.strem.io'

// A movie or series in Stremio's own catalog (Cinemeta, which Stremio itself uses): the best match for the English
// title, the year when given. Returns { id, name, year, type } or null.
export async function findTitle(title, { type = 'movie', year, fetchFn = fetch } = {}) {
  const q = String(title || '').trim()
  if (!q) return null
  const url = `${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(q)}.json`
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`הקטלוג של Stremio לא ענה (${res.status})`)
  const metas = ((await res.json()).metas || []).filter((m) => m && /^tt\d+$/.test(m.id || ''))
  if (!metas.length) return null
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const y = (m) => String(m.releaseInfo || m.year || '').slice(0, 4)
  const exact = metas.filter((m) => norm(m.name) === norm(q))
  const pick = (year && metas.find((m) => y(m) === String(year) && norm(m.name) === norm(q))) ||
    (year && metas.find((m) => y(m) === String(year))) ||
    // Same name: the newest (the "Napoleon" people mean today is 2023, not 1927).
    exact.sort((a, b) => Number(y(b) || 0) - Number(y(a) || 0))[0] ||
    metas[0]
  return { id: pick.id, name: pick.name, year: y(pick), type }
}

// The agent's DONE / NEED_USER / FAIL line, as one short Hebrew line for the TV screen and the chat.
export function tvOutcome(result) {
  const m = String(result || '').match(/^(DONE|NEED_USER|FAIL|DENIED|STOPPED): ([^\n]*)/)
  if (!m) return 'סיימתי בטלוויזיה.'
  const [, status, text] = m
  if (status === 'DONE') return text || 'בוצע בטלוויזיה.'
  if (status === 'NEED_USER') return `צריך אותך: ${text}`
  if (status === 'DENIED') return 'לא אישרת, אז לא קניתי ולא שכרתי כלום.'
  return `לא הצלחתי בטלוויזיה: ${text}`
}

export const stremioLink = (t) => `stremio:///detail/${t.type}/${t.id}`

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required })

const KEYS = ['home', 'back', 'up', 'down', 'left', 'right', 'ok', 'play_pause', 'play', 'pause', 'stop', 'next', 'previous', 'rewind', 'fast_forward', 'mute', 'volume_up', 'volume_down', 'sleep']
const BUTTONS = ['youtube', 'netflix', 'assistant', 'bookmark', 'input', 'guide', 'red', 'green', 'yellow', 'blue']

async function appList() {
  const { apps = [] } = await tvCall('apps')
  return apps
}

// Off is two presses half a second apart: the first wakes the TV's own power prompt (or is swallowed by the projector),
// the second does it. If the TV is already asleep after the first, its link to HELPER is gone and the second has nothing
// to land on, which is the expected end, so only a failure of the FIRST press is an error.
export async function tvPowerOff({ presses = 2, gapMs = 500, call = tvCall, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  await call('key', { key: 'sleep' })
  for (let i = 1; i < presses; i++) {
    await sleep(gapMs)
    try {
      await call('key', { key: 'sleep' })
    } catch {
      // Already off.
    }
  }
}

export const tvTools = [
  {
    name: 'tv_power_off',
    enabled: tvConnected,
    description: 'מכבה את הטלוויזיה או המקרן: לוחץ פעמיים על כפתור הכיבוי בהפרש של חצי שנייה. "תכבה את הטלוויזיה", "תכבה את המקרן".',
    parameters: obj({}, []),
    async run() {
      await tvPowerOff()
      return 'כיביתי.'
    },
  },
  {
    name: 'tv_open_app',
    enabled: tvConnected,
    description: 'פותח אפליקציה בטלוויזיה בסלון ("תפתח נטפליקס בטלוויזיה", "תשים יוטיוב"). app: שם האפליקציה בעברית או באנגלית, או שם החבילה.',
    parameters: obj({ app: str('שם האפליקציה, למשל Netflix, יוטיוב, Spotify, Google Play') }),
    async run({ app }) {
      const found = matchApp(await appList(), app)
      if (!found) return `לא מצאתי בטלוויזיה אפליקציה בשם "${app}". אפשר לבדוק עם tv_list_apps, או להתקין אותה מ-Google Play.`
      await tvCall('open_app', { pkg: found.pkg })
      return `פתחתי בטלוויזיה את ${found.label}.`
    },
  },
  {
    name: 'tv_play',
    enabled: tvConnected,
    description: 'פותח בטלוויזיה סרט או סדרה מסוימים ב-Stremio, ישר בדף שלו עם רשימת המקורות ("תפעיל בסטרימיו את נפוליאון", "תשים את הסרט X בטלוויזיה"). title: השם באנגלית, כפי שהוא ב-IMDb (נפוליאון = Napoleon).',
    parameters: obj({ title: str('שם הסרט או הסדרה באנגלית'), year: str('שנת יציאה, אם ידועה או נאמרה'), type: str('movie או series') }, ['title']),
    async run({ title, year, type }) {
      const kind = type === 'series' ? 'series' : 'movie'
      const found = await findTitle(title, { type: kind, year })
      if (!found) return `לא מצאתי ב-Stremio ${kind === 'series' ? 'סדרה' : 'סרט'} בשם "${title}".`
      const app = matchApp(await appList(), 'stremio')
      if (!app) return 'Stremio לא מותקן בטלוויזיה. אפשר להתקין אותו מ-Google Play.'
      try {
        await tvCall('open_url', { url: stremioLink(found), pkg: app.pkg })
      } catch (e) {
        if (/לא מוכרת/.test(e.message)) {
          await tvCall('open_app', { pkg: app.pkg })
          return `פתחתי את Stremio, אבל מסך הבית של HELPER בטלוויזיה ישן ולא יודע לפתוח סרט ישירות. צריך לעדכן אותו (גרסה 2.7). בינתיים לחפש שם "${found.name}".`
        }
        throw e
      }
      return `פתחתי ב-Stremio את ${found.name} (${found.year}). צריך לבחור מקור בשלט ולהפעיל.`
    },
  },
  {
    name: 'tv_do',
    enabled: tvConnected,
    description: 'מבצע כל משימה בטלוויזיה מקצה לקצה: הסוכן רואה מה יש על המסך (רשימה וצילום) ולוחץ כמו בשלט עד שזה קורה. "תפעיל בסטרימיו את נפוליאון ותבחר מקור", "תמצא את הפרק הבא של...", "תדליק כתוביות", "תשים ביוטיוב שיר של...". לכל מה שהשלט הפשוט וה-tv_play לא גומרים לבד. קנייה או השכרה באפליקציה עוצרת לאישור. מחזיר DONE, NEED_USER, DENIED או FAIL.',
    parameters: obj({ goal: str('המטרה במילים של המשתמש, מלאה, עם שם הסרט/סדרה באנגלית אם יש') }),
    async run({ goal }, ctx) {
      // It can take minutes (a torrent buffering), longer than the TV waits for an answer: it runs in the background,
      // and its outcome goes up on the TV screen and comes in the chat.
      if (ctx.background) {
        const job = ctx.background('בטלוויזיה: ' + String(goal).slice(0, 40), goal, async (signal) => {
          const result = await runOnTv(goal, { ...ctx, signal })
          const line = tvOutcome(result)
          await tvCall('show', { text: line }).catch(() => {})
          return line
        })
        return `"${job.title}" רץ ברקע. אמור לו במשפט קצר אחד שאתה עושה את זה עכשיו בטלוויזיה, בלי לחכות.`
      }
      const result = await runOnTv(goal, ctx)
      return `${result}
[Reply in one short spoken Hebrew line, masculine singular. DONE: what is on the TV now. NEED_USER: exactly what he must do with the remote. FAIL: the honest reason.]`
    },
  },
  {
    name: 'tv_restart_app',
    enabled: tvConnected,
    description: 'סוגר אפליקציה בטלוויזיה לגמרי ופותח אותה מחדש. כש-Stremio לא טוען ("Failed to connect to 127.0.0.1:11470", "הסטרימיו לא טוען") או כשאפליקציה נתקעה.',
    parameters: obj({ app: str('שם האפליקציה, למשל Stremio') }),
    async run({ app }) {
      const found = matchApp(await appList(), app)
      if (!found) return `לא מצאתי בטלוויזיה אפליקציה בשם "${app}".`
      try {
        await tvCall('restart_app', { pkg: found.pkg, url: '' })
      } catch (e) {
        if (/לא מוכרת/.test(e.message)) return 'מסך הבית של HELPER בטלוויזיה ישן מדי בשביל זה (צריך גרסה 2.8). בינתיים: לנתק את הטלוויזיה מהחשמל ל-10 שניות.'
        throw e
      }
      return `סגרתי ופתחתי מחדש את ${found.label}. אם זה Stremio, אפשר לבחור מקור שוב בעוד כמה שניות.`
    },
  },
  {
    name: 'tv_key',
    enabled: tvConnected,
    description: `לוחץ על כפתור בשלט של הטלוויזיה. key: ${KEYS.join(', ')}. times: כמה פעמים (ברירת מחדל 1). "תעצור", "תמשיך", "תחזור", "תשתיק" עוברים דרך כאן.`,
    parameters: obj({ key: str(KEYS.join(', ')), times: num('כמה פעמים, 1 עד 20') }, ['key']),
    async run({ key, times }) {
      if (!KEYS.includes(key)) return `אין כפתור "${key}". יש: ${KEYS.join(', ')}`
      await tvCall('key', { key, times: Math.max(1, Math.min(20, Math.round(times || 1))) })
      return 'בוצע בטלוויזיה.'
    },
  },
  {
    name: 'tv_volume',
    enabled: tvConnected,
    description: 'קובע את הווליום בטלוויזיה באחוזים, 0 עד 100 ("תוריד ל-20", "תגביר קצת" = 10 מעל המצב הנוכחי מ-tv_status).',
    parameters: obj({ level: num('0 עד 100') }),
    async run({ level }) {
      const r = await tvCall('volume', { level: Math.max(0, Math.min(100, Math.round(level))) })
      return `הווליום בטלוויזיה עכשיו ${r.level ?? level}%.`
    },
  },
  {
    name: 'tv_status',
    enabled: tvConnected,
    description: 'מה קורה בטלוויזיה עכשיו: איזו אפליקציה פתוחה, הווליום, והאם היא מושתקת.',
    parameters: obj({}, []),
    async run() {
      const s = await tvCall('state')
      return `פתוח: ${s.label || s.pkg || 'מסך הבית'}. ווליום: ${s.volume ?? '?'}%${s.muted ? ' (מושתק)' : ''}.`
    },
  },
  {
    name: 'tv_list_apps',
    enabled: tvConnected,
    description: 'רשימת האפליקציות שמותקנות בטלוויזיה.',
    parameters: obj({}, []),
    async run() {
      const apps = await appList()
      return apps.length ? apps.map((a) => `${a.label} (${a.pkg})`).join('\n') : 'אין אפליקציות ברשימה.'
    },
  },
  {
    name: 'tv_set_button',
    enabled: tvConnected,
    description: `מגדיר מה כפתור בשלט של הטלוויזיה פותח ("שכפתור היוטיוב יפתח ספוטיפיי"). button: ${BUTTONS.join(', ')}. app: אפליקציה, או "default" כדי להחזיר את ברירת המחדל. assistant פותח את HELPER כברירת מחדל.`,
    parameters: obj({ button: str(BUTTONS.join(', ')), app: str('שם האפליקציה, או default') }),
    async run({ button, app }) {
      if (!BUTTONS.includes(button)) return `אין כפתור "${button}". יש: ${BUTTONS.join(', ')}`
      if (String(app).toLowerCase() === 'default') {
        await tvCall('set_button', { button, pkg: '' })
        return `הכפתור ${button} חזר לברירת המחדל.`
      }
      const found = matchApp(await appList(), app)
      if (!found) return `לא מצאתי בטלוויזיה אפליקציה בשם "${app}".`
      await tvCall('set_button', { button, pkg: found.pkg })
      return `מעכשיו הכפתור ${button} בשלט פותח את ${found.label}.`
    },
  },
  {
    name: 'tv_show',
    enabled: tvConnected,
    description: 'מציג הודעה קצרה למעלה במסך הטלוויזיה, בשכבת HELPER (למשל תזכורת לכל מי שבסלון).',
    parameters: obj({ text: str('ההודעה, עד 200 תווים') }),
    async run({ text }) {
      await tvCall('show', { text: String(text).slice(0, 200) })
      return 'ההודעה מוצגת בטלוויזיה.'
    },
  },
]

export const tvPrompt = () =>
  tvConnected()
    ? '- TV in the living room (HELPER home screen on a Chromecast with Google TV): tv_do (any task on the TV: it sees the screen and works the remote until done), tv_open_app, tv_play (a specific movie or series in Stremio), tv_restart_app (Stremio not loading: closes and reopens it), tv_key, tv_volume, tv_status, tv_list_apps, tv_set_button, tv_show. They act at once, like a remote; do not ask first. When a message comes from source "tv" he is talking to you from the TV itself: answer in one or two short spoken sentences.\n'
    : ''
