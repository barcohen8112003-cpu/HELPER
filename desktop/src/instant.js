// Instant commands: what is clear from the words alone runs at once, with no AI. A sentence becomes steps for the
// hands (hands.js). Anything not understood here goes to the brain (brain.js). Hebrew first, English too.
'use strict'

const POLITE = /(^|\s)(בבקשה|תודה|אפשר|תוכל|תוכלי|יכול|יכולה|רגע|יאללה|בוא|תעשה לי|תעשי לי|please|can you|could you)(?=\s|$)/gi
const NAME = /^(הלפר|helper|היי הלפר|hey helper)[\s,]+/i

/** "תפתח בבקשה את כרום!" → "תפתח את כרום". */
function tidy(s) {
  return String(s || '')
    .replace(/[‎‏‪-‮]/g, '')
    .trim()
    .replace(NAME, '')
    .trim()
    .replace(/[.!?؟،,]+$/g, '')
    .replace(POLITE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "את כרום" / "האפליקציה כרום" / "כרום" → "כרום". */
function object(s) {
  return String(s || '').trim()
    .replace(/^(לי|לנו)\s+/, '')
    .replace(/^(את|אֶת)\s+/, '')
    .replace(/^(האפליקציה|אפליקציה|התוכנה|תוכנה|החלון של|החלון|האתר|אתר)\s+/, '')
    .replace(/^ה(?=(כרום|ספוטיפיי|דיסקורד|וואטסאפ|טלגרם|מחשבון|טרמינל|סטים)$)/, '')
    .trim()
}

// Where a window goes. Order matters: longer phrases first.
const PLACES = [
  [/(למסך השני|למסך האחר|למסך הבא|למסך השמאלי|למסך הימני|למסך הראשי|למסך הגדול|למסך הקטן|למסך (\d)|to the other screen|to the other monitor|to screen (\d))/i, 'screen'],
  [/(על כל המסך|למסך מלא|מסך מלא|למקסימום|מקסימום|full ?screen|maximi[sz]e)/i, 'max'],
  [/(בחצי השמאלי|לחצי השמאלי|בצד שמאל|לצד שמאל|צד שמאל|משמאל|שמאלה|לשמאל|to the left|on the left|(?<![a-z])left(?![a-z]))/i, 'left'],
  [/(בחצי הימני|לחצי הימני|בצד ימין|לצד ימין|צד ימין|מימין|ימינה|לימין|to the right|on the right|(?<![a-z])right(?![a-z]))/i, 'right'],
  [/(בחצי העליון|למעלה|top half)/i, 'top'],
  [/(בחצי התחתון|למטה|bottom half)/i, 'bottom'],
  [/(באמצע|במרכז|(?<![a-z])(?:center|centre)(?![a-z]))/i, 'center'],
]

/** A window place in a phrase: {where, screen, rest} where rest is the phrase without it. */
function placeIn(phrase) {
  for (const [re, where] of PLACES) {
    const m = phrase.match(re)
    if (!m) continue
    const rest = (phrase.slice(0, m.index) + ' ' + phrase.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim()
    if (where === 'screen') {
      const word = m[0]
      const screen = (word.match(/\d/) || [])[0] || (/שמאלי/.test(word) ? 'שמאלי' : /ימני/.test(word) ? 'ימני' : /ראשי/.test(word) ? 'ראשי' : /גדול/.test(word) ? 'גדול' : 'next')
      // "למסך השני בצד שמאל": a side too.
      const side = placeIn(rest)
      if (side && side.where !== 'screen') return { where: side.where, screen, rest: side.rest }
      return { where: 'max', screen, rest }
    }
    // "בצד שמאל של המסך השני": the screen after the side.
    const scr = rest.match(/(של |ב)?(המסך השני|המסך האחר|המסך הימני|המסך השמאלי|המסך הראשי|המסך הגדול)/)
    if (scr) {
      const s2 = scr[2]
      return { where, screen: /שמאלי/.test(s2) ? 'שמאלי' : /ימני/.test(s2) ? 'ימני' : /ראשי/.test(s2) ? 'ראשי' : /גדול/.test(s2) ? 'גדול' : 'next', rest: rest.replace(scr[0], '').replace(/\s+/g, ' ').trim() }
    }
    return { where, rest }
  }
  return null
}

const OPEN = /^(תפתח|תפתחי|תפתחו|תפתחה|פתח|פתחי|פתחו|לפתוח|תפעיל|תפעילי|תפעילו|הפעל|הפעילי|הפעילו|להפעיל|תריץ|תריצי|הרץ|open|launch|start|run)\s+(.+)$/i
const CLOSE = /^(תסגור|תסגרי|תסגרו|תסגורה|סגור|סגרי|סגרו|לסגור|close|quit|exit)\s+(.+)$/i
const FOCUS = /^(תעבור ל|תעברי ל|תעברו ל|עבור ל|תביא את|תביאי את|תביא לי את|תחזור ל|switch to |go to )\s*(.+)$/i
const MOVE = /^(תשים|תשימי|תשימו|שים|שימי|תזיז|תזיזי|תזיזו|הזז|תעביר|תעבירי|תעבירו|העבר|move|put)\s+(.+)$/i
const MAX = /^(תגדיל|תגדילי|תגדילו|הגדל|maximi[sz]e)\s+(.+)$/i
const MIN = /^(תמזער|תמזערי|תמזערו|מזער|תוריד|minimi[sz]e)\s+(.+)$/i
const SEARCH = /^(תחפש|תחפשי|תחפשו|חפש|חפשי|חפשו|לחפש|גגל|תגגל|search|google)\s+(?:(בגוגל|ביוטיוב|במפות|בגוגל מפות|on youtube|on google|youtube|google)\s+)?(?:על\s+|for\s+)?(.+)$/i

const PLAY_VERB = /^(תפעיל|תפעילי|הפעל|תנגן|תנגני|נגן|תשים|תשימי|שים|תראה לי|play|put on)\s+(.+)$/i
const MEDIA_WORD = /(^|\s)(ביוטיוב|יוטיוב|סרטון|סרטונים|קליפ|שיר|השיר|שירים|פרק|הפרק|on youtube|youtube|video|song|music video)(\s|$)/i

/**
 * What to play, or null: a play verb with a video or song word ("ביוטיוב", "סרטון", "שיר"), "תנגן X", or
 * "יוטיוב X". "תפעיל את ספוטיפיי" (an app) and "תשים את כרום בצד שמאל" (a window) are not plays.
 */
function playQuery(s) {
  let m
  if ((m = s.match(/^(?:יוטיוב|youtube)\s+(.+)$/i))) return clean(m[1])
  if (!(m = s.match(PLAY_VERB))) return null
  const verb = m[1], rest = m[2]
  const sings = /^(תנגן|תנגני|נגן|play)$/i.test(verb)
  if (!sings && !MEDIA_WORD.test(rest)) return null
  if (placeIn(rest) && !MEDIA_WORD.test(rest)) return null
  const q = clean(rest)
  return q && !/^(את )?(ה)?(מוזיקה|שיר|סרטון|וידאו)$/.test(q) ? q : null

  function clean(x) {
    return x
      .replace(/(^|\s)(ביוטיוב|on youtube|in youtube)(?=\s|$)/gi, ' ')
      .replace(/^\s*(לי|לנו)\s+/, ' ')
      .replace(/^\s*(את\s+)?(ה)?(סרטון|קליפ|שיר|פרק)(\s+של)?\s+/, ' ')
      .replace(/^\s*(את\s+)?(ה)?(סרטון|קליפ|שיר|פרק)(\s+של)?\s+/, ' ')
      .replace(/^\s*את\s+/, ' ')
      .replace(/^\s*(the\s+)?(song|video|clip)\s+(of\s+|by\s+)?/i, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
}

/** One instruction → steps, or null when it is not an instant command. */
function parseOne(s) {
  let m

  // Time and date.
  if (/^(מה השעה|כמה השעה|מה התאריך|איזה יום היום|what time is it|what's the time)$/i.test(s)) return [{ cmd: 'time' }]

  // Volume.
  if ((m = s.match(/^(?:תשים |שים |תכוון |כוון )?(?:את )?(?:ה)?(?:ווליום|וולום|עוצמה|עוצמת הקול|עוצמת השמע|הקול|volume)\s+(?:על |ל|ל-|to )?(\d{1,3})\s*%?$/i))) return [{ cmd: 'volume', args: { op: 'set', value: Number(m[1]) } }]
  if (/^(תגביר|תגבירי|הגבר|להגביר|turn (it )?up|volume up|louder)( את)?( ה)?(ווליום|קול|עוצמה|מוזיקה|סאונד)?( קצת| הרבה| עוד)?$/i.test(s)) return [{ cmd: 'volume', args: { op: 'up', value: /הרבה/.test(s) ? 12 : 5 } }]
  if (/^(תנמיך|תנמיכי|הנמך|להנמיך|turn (it )?down|volume down|quieter)( את)?( ה)?(ווליום|קול|עוצמה|מוזיקה|סאונד)?( קצת| הרבה| עוד)?$/i.test(s)) return [{ cmd: 'volume', args: { op: 'down', value: /הרבה/.test(s) ? 12 : 5 } }]
  if (/^(השתק|תשתיק|תשתיקי|להשתיק|mute|unmute|בטל השתקה|תבטל השתקה|תחזיר את הקול)( את)?( ה)?(קול|מחשב|סאונד)?$/i.test(s)) return [{ cmd: 'volume', args: { op: 'mute' } }]

  // Music and video.
  if (/^(השיר הבא|הבא|שיר הבא|תעביר שיר|דלג|תדלג|next( song| track)?|skip)$/i.test(s)) return [{ cmd: 'media', args: { op: 'next' } }]
  if (/^(השיר הקודם|הקודם|שיר קודם|תחזור שיר|previous( song| track)?|back)$/i.test(s)) return [{ cmd: 'media', args: { op: 'prev' } }]
  if (/^(עצור|תעצור|תעצרי|עצרי|השהה|תשהה|פאוז|pause|stop( the)? music)( את)?( ה)?(מוזיקה|שיר|סרטון|וידאו)?$/i.test(s)) return [{ cmd: 'media', args: { op: 'pause' } }]
  if (/^(נגן|תנגן|תנגני|תמשיך|תמשיכי|המשך|play|resume)( את)?( ה)?(מוזיקה|שיר|סרטון|וידאו)?$/i.test(s)) return [{ cmd: 'media', args: { op: 'play' } }]

  // The desktop and the PC.
  if (/^(תמזער הכל|מזער הכל|תמזער את הכל|תראה שולחן עבודה|תראה לי את שולחן העבודה|שולחן עבודה|show( the)? desktop|minimi[sz]e (all|everything))$/i.test(s)) return [{ cmd: 'desktop' }]
  if (/^(תנעל|נעל|לנעול|lock)( את)?( ה)?(מחשב|מסך|pc|computer|screen)?$/i.test(s)) return [{ cmd: 'lock' }]
  if (/^(מצב המחשב|מצב מערכת|ביצועים|מה העומס|כמה זיכרון פנוי|כמה ראם|ביצועי מחשב|system info|specs|pc stats)$/i.test(s)) return [{ cmd: 'system' }]
  if (/^(מה העתקתי|מה יש בלוח|מה בלוח|תקריא את מה שהעתקתי|לוח העתקות|לוח|what did i copy|clipboard)$/i.test(s)) return [{ cmd: 'clipboard', args: { op: 'read' } }]
  if (/^(תנקה את הלוח|נקה לוח|תנקה את מה שהעתקתי|clear clipboard)$/i.test(s)) return [{ cmd: 'clipboard', args: { op: 'write', text: '' } }]

  // Workspaces & Layout presets
  if (/^(מצב עבודה|מצב תכנות|מצב קוד|סדר לי את המסך לעבודה|work mode|coding mode)$/i.test(s)) return [{ cmd: 'workspace', args: { mode: 'code' } }]
  if (/^(מצב קריאה|מצב פוקוס|reading mode|focus mode)$/i.test(s)) return [{ cmd: 'workspace', args: { mode: 'reading' } }]
  if (/^(נקה מסך|שולחן עבודה נקי|clean workspace)$/i.test(s)) return [{ cmd: 'workspace', args: { mode: 'clean' } }]

  // Browser Tabs & Navigation
  if (/^(כרטיסייה חדשה|טאב חדש|תפתח טאב חדש|new tab)$/i.test(s)) return [{ cmd: 'browser_tab', args: { action: 'new' } }]
  if (/^(סגור כרטיסייה|סגור טאב|תסגור את הטאב|תסגור טאב|close tab)$/i.test(s)) return [{ cmd: 'browser_tab', args: { action: 'close' } }]
  if (/^(תפתח מחדש את הטאב|תחזיר את הטאב|שחזר טאב|reopen tab)$/i.test(s)) return [{ cmd: 'browser_tab', args: { action: 'reopen' } }]
  if (/^(כרטיסייה הבאה|טאב הבא|next tab)$/i.test(s)) return [{ cmd: 'browser_tab', args: { action: 'next' } }]
  if (/^(כרטיסייה קודמת|טאב קודם|previous tab|prev tab)$/i.test(s)) return [{ cmd: 'browser_tab', args: { action: 'prev' } }]
  if (/^(רענן|תרענן|רענן דף|רענן את הדף|refresh|reload)$/i.test(s)) return [{ cmd: 'browser_tab', args: { action: 'refresh' } }]

  // Downloads & Files
  if (/^(מה הקובץ האחרון שהורדתי|הקובץ האחרון בהורדות|הורדה אחרונה|latest download)$/i.test(s)) return [{ cmd: 'latest_download', args: { open: false } }]
  if (/^(תפתח את הקובץ האחרון שהורדתי|תפתח את ההורדה האחרונה|open latest download)$/i.test(s)) return [{ cmd: 'latest_download', args: { open: true } }]

  // Search.
  if ((m = s.match(SEARCH))) {
    const where = m[2] || ''
    const site = /יוטיוב|youtube/i.test(where) ? 'youtube' : /מפות/.test(where) ? 'maps' : 'google'
    return [{ cmd: 'search', args: { query: m[3], site } }]
  }
  // Playing a video or a song: "תפעיל ביוטיוב לופי", "תנגן אופק אדנק", "תשים לי את השיר נתתי לך בית".
  const played = playQuery(s)
  if (played) return [{ cmd: 'play', args: { query: played } }]

  // Close.
  if ((m = s.match(CLOSE))) {
    const what = object(m[2])
    if (/^(הכל|את הכל|כל החלונות|everything|all)$/.test(what)) return null   // a big step: the brain asks first
    return [{ cmd: 'close', args: { name: /^(זה|החלון הזה|החלון|this|it|this window)$/i.test(what) ? 'זה' : what } }]
  }

  // Maximize / minimize.
  if ((m = s.match(MAX))) return [{ cmd: 'place', args: { name: object(m[2].replace(/\s+(על כל המסך|למסך מלא)$/, '')) || 'זה', where: 'max' } }]
  if ((m = s.match(MIN)) && !/למטה$/.test(m[2]) ) return [{ cmd: 'place', args: { name: object(m[2]) || 'זה', where: 'min' } }]

  // Move / put: "תשים את כרום בצד שמאל", "תעביר את דיסקורד למסך השני".
  if ((m = s.match(MOVE))) {
    const p = placeIn(m[2])
    if (p) {
      const name = object(p.rest.replace(/^(אותו|אותה|אותם)$/, 'זה')) || 'זה'
      return [{ cmd: 'place', args: { name, where: p.where, screen: p.screen } }]
    }
  }

  // Open: "תפתח את ספוטיפיי", "תפתח כרום בצד שמאל" (open, then place).
  if ((m = s.match(OPEN))) {
    let rest = m[2]
    const p = placeIn(rest)
    if (p) rest = p.rest
    const name = object(rest)
    if (!name || name.split(' ').length > 4) return null
    const steps = [{ cmd: 'open', args: { name } }]
    if (p) steps.push({ cmd: 'place', args: { name, where: p.where, screen: p.screen } })
    return steps
  }

  // Switch to: "תעבור לכרום".
  if ((m = s.match(FOCUS))) {
    const name = object(m[2])
    if (name && name.split(' ').length <= 3) return [{ cmd: 'focus', args: { name } }]
  }

  // A bare "כרום שמאלה" / "chrome left".
  const p = placeIn(s)
  if (p && p.rest && p.rest.split(' ').length <= 2 && !/^(תפתח|תחפש|מה|איך|למה|איפה|כמה|תכתוב|תסביר)/.test(p.rest)) {
    return [{ cmd: 'place', args: { name: object(p.rest), where: p.where, screen: p.screen } }]
  }
  return null
}

/**
 * A whole ask → {steps} for the hands, {teach}, {remember}, {forget}, {unlearn}, or null for the brain.
 * Two instructions joined by "ו" / "ואז" / "and then" run in order when both are instant ("כרום משמאל ודיסקורד מימין").
 */
function parse(text) {
  const s = tidy(text)
  if (!s) return null
  let m

  // Teaching: "כשאני אומר מצב עבודה, תפתח את כרום ואת ספוטיפיי".
  // The phrase runs to a comma or colon ("כשאני אומר מצב עבודה, ..."), or to "תעשה" / "אז" when there is none.
  if ((m = s.match(/^(?:כשאני אומר|כשאני אומרת|כשאגיד|אם אני אומר|when i say)\s+[״"']?(.+?)[״"']?\s*[,:]\s*(?:תעשה\s+|תעשי\s+|אז\s+|then\s+|do\s+)?(.+)$/i))
      || (m = s.match(/^(?:כשאני אומר|כשאני אומרת|כשאגיד|אם אני אומר|when i say)\s+[״"']?(.+?)[״"']?\s+(?:תעשה|תעשי|אז|then|do)\s+(.+)$/i))) {
    return { teach: { phrase: m[1].trim(), does: m[2].trim() } }
  }
  if ((m = s.match(/^(?:תשכח את הקיצור|תמחק את הקיצור|forget the shortcut)\s+[״"']?(.+?)[״"']?$/i))) return { unlearn: m[1] }

  // Memory: "תזכור ש..." / "תשכח ש...".
  if ((m = s.match(/^(?:תזכור|תזכרי|זכור|remember)\s+(?:ש|כי|that\s+)(.+)$/i))) return { remember: m[1].trim() }
  if ((m = s.match(/^(?:תשכח|תשכחי|forget)\s+(?:ש|את זה ש|that\s+)(.+)$/i))) return { forget: m[1].trim() }

  // Two or more instructions are tried first: "תפתח את המחשבון ותשים אותו בצד שמאל" is open + place, not one
  // long app name; when the parts don't all parse, the sentence is tried whole.
  const compound = splitInstructions(s)
  if (compound) return { steps: compound }
  const one = parseOne(s)
  if (one) return { steps: one }
  return null
}

/** "X ו-Y", "X ואז Y", "X and Y" → the steps of each, or null. */
function splitInstructions(s) {
  const parts = s.split(/\s+(?:ואז|ואחר כך|and then|then|and)\s+|\s+ו(?=(?:תפתח|תשים|תסגור|תעביר|תזיז|תגדיל|תמזער|תחפש|תנגן|תעבור)(?=\s|$))|\s+ו-?(?=\S+\s+(?:משמאל|מימין|שמאלה|ימינה|בצד|למסך))|\s+ו(?=את\s)/)
  if (parts.length > 1 && parts.length <= 5) {
    const steps = []
    let verb = null
    for (const part of parts) {
      let got = parseOne(part.trim())
      // "תפתח את כרום ואת ספוטיפיי": the second app takes the first one's verb.
      if (!got && verb && /^את\s/.test(part.trim())) got = parseOne(verb + ' ' + part.trim())
      if (!got) return null
      const first = part.trim().split(/\s+/)[0]
      if (/^(תפתח|תפתחי|פתח|תסגור|סגור|תמזער|תגדיל)$/.test(first)) verb = first
      // "אותו" / "אותה" / "it": the app of the instruction before.
      const before = steps.length ? (steps[steps.length - 1].args || {}).name : null
      for (const st of got) {
        if (before && st.args && st.args.name === 'זה' && /(אותו|אותה|אותם|(?<![a-z])it)(\s|$)/i.test(part)) st.args.name = before
      }
      steps.push(...got)
    }
    return steps
  }
  return null
}

module.exports = { parse, parseOne, tidy, placeIn, object }
