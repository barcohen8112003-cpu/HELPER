// What HELPER says after an instant command, said the way a person would: "פתחתי את המחשבון ושמתי אותו בצד שמאל",
// not "פותח את מחשבון · מחשבון בצד שמאל". The steps are what was done; the lines are what the hands reported.
'use strict'

const SIDES = { left: 'בצד שמאל', right: 'בצד ימין', top: 'למעלה', bottom: 'למטה', center: 'באמצע', max: 'על כל המסך', full: 'על כל המסך' }

/** Everyday app names that take "ה" ("את המחשבון"); proper names do not ("את כרום", "את ספוטיפיי"). */
const COMMON = new Set(['מחשבון', 'דפדפן', 'טרמינל', 'מסוף', 'מצלמה', 'יומן', 'לוח שנה', 'מייל', 'דואר', 'צייר', 'כלי החיתוך'])

/** What an app is called aloud, whatever it was called in the steps (Claude and Windows use English names). */
const SPOKEN = {
  calculator: 'מחשבון', notepad: 'פנקס רשימות', chrome: 'כרום', 'google chrome': 'כרום', spotify: 'ספוטיפיי', discord: 'דיסקורד',
  whatsapp: 'וואטסאפ', telegram: 'טלגרם', stremio: 'סטרימיו', vlc: 'VLC', 'vlc media player': 'VLC', obs: 'OBS', 'obs studio': 'OBS',
  steam: 'סטים', zoom: 'זום', 'zoom workplace': 'זום', claude: 'קלוד', outlook: 'אאוטלוק', paint: 'צייר', explorer: 'סייר הקבצים',
  'file explorer': 'סייר הקבצים', edge: 'אדג׳', 'microsoft edge': 'אדג׳', firefox: 'פיירפוקס', youtube: 'יוטיוב', cursor: 'קרסר',
  'visual studio code': 'וי אס קוד', 'task manager': 'מנהל המשימות', settings: 'הגדרות', terminal: 'מסוף', xbox: 'אקסבוקס',
}
const spoken = (name) => SPOKEN[String(name || '').toLowerCase().trim()] || String(name || '').trim()

/** "את X" with the article where the word takes one. */
function the(name) {
  const n = spoken(String(name || '').replace(/[‎‏‪-‮]/g, '').trim())
  if (!n || n === 'זה') return 'את החלון'
  if (/^(ה|ה-)/.test(n) && n.length > 3) return 'את ' + n
  if (COMMON.has(n)) return 'את ה' + n
  if (/^פנקס רשימות$/.test(n)) return 'את פנקס הרשימות'
  if (/^(סייר הקבצים|מנהל המשימות|לוח הבקרה|שורת הפקודה)$/.test(n)) return 'את ' + n
  return 'את ' + n
}

/** Where, in words: "בצד שמאל", "במסך השני", "בצד ימין של המסך השני". */
function where(step) {
  const side = SIDES[step.where] || SIDES.max
  const s = String(step.screen == null ? '' : step.screen)
  let screen = ''
  if (s === 'next') screen = 'המסך השני'
  else if (/^\d+$/.test(s)) screen = ({ 1: 'המסך הראשון', 2: 'המסך השני', 3: 'המסך השלישי' })[s] || 'מסך ' + s
  else if (s) screen = 'המסך ' + (s === 'ימני' || s === 'שמאלי' || s === 'ראשי' || s === 'גדול' ? s : s)
  if (!screen) return side
  if (step.where === 'max' || step.where === 'full' || !step.where) return 'על ' + screen
  // "בצד ימין של המסך השני", but "למעלה במסך השני" and "באמצע המסך השני".
  if (step.where === 'left' || step.where === 'right') return side + ' של ' + screen
  if (step.where === 'center') return 'באמצע ' + screen
  return side + ' ב' + screen.replace(/^ה/, '')   // "ב" + "המסך" is spoken "במסך": the article's ה drops
}

/** Keys said as what they did: "העתקתי", not "לחצתי ctrl+c". */
const KEY_SAID = {
  'ctrl+c': 'העתקתי', 'ctrl+v': 'הדבקתי', 'ctrl+x': 'גזרתי', 'ctrl+a': 'סימנתי הכל', 'ctrl+z': 'ביטלתי את הפעולה האחרונה', 'ctrl+s': 'שמרתי',
  'alt+left': 'חזרתי לדף הקודם', 'alt+right': 'התקדמתי לדף הבא', 'ctrl+f': 'פתחתי חיפוש בדף', enter: 'לחצתי אנטר', esc: 'לחצתי אסקייפ',
  space: 'לחצתי רווח', backspace: 'מחקתי תו', delete: 'מחקתי', 'alt+f4': 'סגרתי את החלון',
}

const join = (parts) => (parts.length <= 1 ? parts[0] || '' : parts.slice(0, -1).join(', ') + ' ו' + parts[parts.length - 1])

/**
 * One sentence for the steps, or '' when they are not ones it knows (the caller then uses the hands' own lines).
 * Consecutive steps on the same app read as one thing: "פתחתי את X ושמתי אותו בצד שמאל".
 */
function human(steps, lines = [], flat = false) {
  const grouped = flat ? null : group(steps, lines)
  if (grouped) return grouped
  const clauses = []
  let last = null   // the name of the app the last clause was about, for "אותו"
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const a = s.args || {}
    const raw = String(lines[i] || '')
    switch (s.cmd) {
      case 'open':
        clauses.push((/^עברתי/.test(raw) ? 'עברתי ' + the(a.name).replace(/^את /, 'ל') : 'פתחתי ' + the(a.name)))
        last = a.name
        break
      case 'focus':
        clauses.push('עברתי ' + the(a.name).replace(/^את /, 'ל'))
        last = a.name
        break
      case 'close':
        clauses.push('סגרתי ' + the(a.name))
        last = a.name
        break
      case 'place': {
        const same = last && String(last) === String(a.name)
        const who = same ? 'אותו' : the(a.name)
        if (a.where === 'min') clauses.push('מזערתי ' + who)
        else if (a.where === 'restore') clauses.push('החזרתי ' + who + ' לגודל רגיל')
        else if (a.where === 'max' && !a.screen) clauses.push('הגדלתי ' + who + ' על כל המסך')
        else clauses.push('שמתי ' + who + ' ' + where(a))
        last = a.name
        break
      }
      case 'volume':
        clauses.push(a.op === 'up' ? 'הגברתי' : a.op === 'down' ? 'הנמכתי' : a.op === 'mute' ? 'השתקתי' : 'שמתי את העוצמה על ' + a.value)
        break
      case 'media':
        clauses.push({ next: 'עברתי לשיר הבא', prev: 'חזרתי לשיר הקודם', pause: 'עצרתי', stop: 'עצרתי', play: 'המשכתי' }[a.op] || 'בוצע')
        break
      case 'desktop': clauses.push('הצגתי את שולחן העבודה'); break
      case 'lock': clauses.push('נעלתי את המחשב'); break
      case 'search':
        clauses.push(a.site === 'youtube' ? 'חיפשתי ביוטיוב ' + a.query : a.site === 'maps' ? 'חיפשתי במפות ' + a.query : 'חיפשתי בגוגל ' + a.query)
        break
      case 'play': {
        const title = raw.replace(/^מנגן:\s*/, '')
        clauses.push(/^לא מצאתי/.test(raw) ? raw : title && title !== raw ? 'מנגן לך ' + title : 'מנגן')
        break
      }
      case 'key':
        clauses.push(KEY_SAID[String(a.keys || '').toLowerCase()] || raw)
        break
      default:
        if (raw) clauses.push(raw)
    }
  }
  if (!clauses.length) return ''
  // Several things done: "פתחתי את X, שמתי אותו בצד שמאל ופתחתי את Y".
  return join(clauses)
}

/**
 * When the steps are only about windows (open, focus, place, close), one clause per app, in the order the apps
 * came up: "פתחתי את המחשבון ושמתי אותו בצד שמאל, ופתחתי את כרום ושמתי אותו בצד ימין". Null for anything else.
 */
function group(steps, lines) {
  if (!steps.length || !steps.every((s) => ['open', 'focus', 'place', 'close'].includes(s.cmd))) return null
  const order = []
  const byApp = new Map()
  steps.forEach((s, i) => {
    const key = spoken((s.args || {}).name).toLowerCase()
    if (!byApp.has(key)) { byApp.set(key, []); order.push(key) }
    byApp.get(key).push({ step: s, line: String(lines[i] || '') })
  })
  if (order.length === steps.length) return null   // one step per app: the plain way reads fine
  const clauses = order.map((key) => human(byApp.get(key).map((x) => x.step), byApp.get(key).map((x) => x.line), true))
  return clauses.length > 1 ? clauses.join(', ו') : clauses[0]
}

module.exports = { human, the, where, spoken }
