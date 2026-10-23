// Tools the model uses to run the TV through the HELPER home screen on it. Opening an app, a remote key or the
// volume is what a remote control does, so none of them asks first.
import { tvConnected, tvCall, matchApp } from './tv-app.js'

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required })

const KEYS = ['home', 'back', 'up', 'down', 'left', 'right', 'ok', 'play_pause', 'play', 'pause', 'stop', 'next', 'previous', 'rewind', 'fast_forward', 'mute', 'volume_up', 'volume_down', 'sleep']
const BUTTONS = ['youtube', 'netflix', 'assistant', 'bookmark', 'input', 'guide', 'red', 'green', 'yellow', 'blue']

async function appList() {
  const { apps = [] } = await tvCall('apps')
  return apps
}

export const tvTools = [
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
    ? '- TV in the living room (HELPER home screen on a Chromecast with Google TV): tv_open_app, tv_key, tv_volume, tv_status, tv_list_apps, tv_set_button, tv_show. They act at once, like a remote; do not ask first. When a message comes from source "tv" he is talking to you from the TV itself: answer in one or two short spoken sentences.\n'
    : ''
