// Defensive personal-safety helpers: scam detection, password hygiene, "what do I do if hacked" checklists.
// Nothing here scans, probes or attacks. The only network calls: Pwned Passwords range lookup (5 hex chars of a
// SHA-1 prefix leave the machine, never the password) and the redirect follower (assertPublicUrl on every hop).
// Passwords/hashes are never logged, stored or echoed back.
import crypto from 'node:crypto'
import net from 'node:net'
import { str, num, bool, oneOf, obj, lines, clip, need, toNumber, assertPublicUrl, fetchText } from './_kit.js'

export const category = 'safety'
export const blurb = 'בדיקות בטיחות אישית: הונאות, סיסמאות וקישורים חשודים'

const MAX = 20000
function text(value, name) {
  const s = String(need(value, name))
  if (s.length > MAX) throw new Error(`${name} ארוך מדי (מעל ${MAX} תווים)`)
  return s
}

// ---------- password helpers ----------
const COMMON = new Set(
  ['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'abc123', 'letmein', 'welcome', 'admin', 'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'master', 'sunshine', 'princess', 'shadow', 'trustno1', 'login', 'israel', 'shalom', 'ahava', 'jerusalem', 'tel-aviv', 'aa123456', '111111', '123123', '000000', 'zxcvbnm', 'asdfgh', 'asdfghjkl'].map((s) => s.toLowerCase()),
)
const WALKS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'qazwsxedc', '1qaz2wsx', '0987654321']
const EN2HE = { q: '/', w: "'", e: 'ק', r: 'ר', t: 'א', y: 'ט', u: 'ו', i: 'ן', o: 'ם', p: 'פ', a: 'ש', s: 'ד', d: 'ג', f: 'כ', g: 'ע', h: 'י', j: 'ח', k: 'ל', l: 'ך', ';': 'ף', z: 'ז', x: 'ס', c: 'ב', v: 'ה', b: 'נ', n: 'מ', m: 'צ', ',': 'ת', '.': 'ץ' }
const HE_WORDS = ['שלום', 'אהבה', 'ישראל', 'סיסמה', 'סיסמא', 'מלך', 'אבא', 'אמא', 'כלב', 'חתול', 'תודה', 'בית', 'ירושלים', 'מכבי', 'הפועל', 'בלה', 'דני', 'יוסי', 'חיים', 'כוכב', 'שמש', 'לילה']

function englishToHebrew(s) {
  return [...s.toLowerCase()].map((c) => EN2HE[c] ?? '').join('')
}

export function analyzePassword(pw) {
  const issues = []
  const lower = pw.toLowerCase()
  let pool = 0
  if (/[a-z]/.test(pw)) pool += 26
  if (/[A-Z]/.test(pw)) pool += 26
  if (/\d/.test(pw)) pool += 10
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33
  const chars = [...pw]
  const unique = new Set(chars).size
  // Repeated characters add little: weight length by variety.
  const effLen = Math.min(chars.length, unique * 2)
  let bits = pool ? effLen * Math.log2(pool) : 0
  if (chars.length < 8) issues.push('קצרה מ-8 תווים')
  if (chars.length < 12) issues.push('מומלץ לפחות 12 תווים')
  if (unique <= chars.length / 2) issues.push('הרבה תווים חוזרים')
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[0-9!@#$%^&*]+$/, ''))) {
    issues.push('סיסמה נפוצה מאוד')
    bits = Math.min(bits, 10)
  }
  if (/^\d+$/.test(pw)) issues.push('מספרים בלבד')
  if (/^[a-z]+$/i.test(pw) && chars.length < 14) issues.push('אותיות בלבד')
  if (/(19[5-9]\d|20[0-3]\d)/.test(pw)) {
    issues.push('מכילה שנה (קל לנחש)')
    bits -= 8
  }
  const flat = lower.replace(/[^a-z0-9]/g, '')
  for (const w of WALKS) {
    for (let i = 0; i + 4 <= w.length; i++) {
      const seg = w.slice(i, i + 4)
      if (flat.includes(seg) || flat.includes([...seg].reverse().join(''))) {
        issues.push('רצף מקלדת (qwerty / 1234)')
        bits -= 12
        i = w.length
        break
      }
    }
  }
  if (/(.)\1{2,}/.test(pw)) {
    issues.push('תו שחוזר 3 פעמים ומעלה')
    bits -= 6
  }
  const heb = englishToHebrew(pw)
  if (/^[a-z;,.]+$/i.test(pw.replace(/[0-9!@#$%^&*]+$/, '')) && heb.length >= 3) {
    const core = englishToHebrew(pw.replace(/[0-9!@#$%^&*]+$/, ''))
    const hit = HE_WORDS.find((w) => core.includes(w))
    if (hit) {
      issues.push(`מילה בעברית בהקלדה על מקלדת אנגלית ("${hit}")`)
      bits = Math.min(bits, 20)
    }
  }
  bits = Math.max(0, Math.round(bits))
  const rating = bits < 28 ? 'חלשה מאוד' : bits < 40 ? 'חלשה' : bits < 60 ? 'בינונית' : bits < 80 ? 'חזקה' : 'חזקה מאוד'
  return { bits, rating, issues }
}

// Pure helper: SHA-1 of the password, split into the 5-char prefix that may leave the machine and the local suffix.
export function pwnedSplit(pw) {
  const hash = crypto.createHash('sha1').update(pw, 'utf8').digest('hex').toUpperCase()
  return { prefix: hash.slice(0, 5), suffix: hash.slice(5) }
}
// Pure helper: find our suffix in the API's "SUFFIX:COUNT" lines.
export function pwnedMatch(body, suffix) {
  for (const line of String(body).split(/\r?\n/)) {
    const [s, c] = line.trim().split(':')
    if (s && s.toUpperCase() === suffix) return Number(c) || 1
  }
  return 0
}

const WORDS = `able acid also arch area army atom aunt avoid award bacon badge baker basil beach beard begin bench berry bike bird blank blend bloom blue boat bold bone book boot brave bread brick bridge brook brush cabin cable cactus cake calm camel candle canoe carpet castle cedar chair chalk cherry chess chief cider circle clay cliff clock cloud clover coach coast coral cotton crane creek crown daisy dance delta denim desert diary dinner dolphin dragon dream drum eagle earth ember engine fabric falcon farm fern ferry field finch flame flute forest fox frost garden garlic ginger glacier globe goat grape grass gull harbor hazel heron hill honey horizon island ivory jacket jelly jungle kettle kite lake lamp lantern leaf lemon lilac lime lion lotus maple marble meadow melon mint mirror moon moss mountain mule nest north oak ocean olive onion orange orchid otter oven panda paper peach pearl pepper pine planet plum pond poppy puzzle quartz rabbit rain raven reef ribbon river robin rocket rose sable saddle sage sailor salmon sand shadow shell silver sky snow spark spice spring storm stream sugar summer swan tiger timber tulip tunnel turtle valley velvet violet walnut wave willow window winter wolf yacht yellow zebra`.split(/\s+/)

// ---------- scam message heuristics ----------
const SCAM_RULES = [
  [/(דחוף|מיידי|מיד\b|תוך\s*\d+\s*(שעות|דקות|ימים)|אחרת (ה)?חשבון|נחסם|ייחסם|יסגר|פג תוקף|last chance|urgent|immediately|within \d+ (hours|minutes)|suspended|will be (closed|blocked|locked)|expire[sd]?)/i, 2, 'לחץ של דחיפות או איום בחסימה'],
  [/(קוד (אימות|חד.?פעמי|בן 6|שקיבלת)|שלח(ו)? לי את הקוד|verification code|one.?time (code|password)|\botp\b|6.?digit code)/i, 4, 'בקשה לקוד אימות (קוד כזה לעולם לא נמסר)'],
  [/(סיסמ[הא]|password|\bpin\b|cvv|מספר כרטיס|פרטי אשראי|credit card|תעודת זהות|ת\.?ז\b|social security|עדכן(ו)? פרטים|אמת(ו)? פרטים|verify your (account|identity|details))/i, 3, 'מבקש סיסמה / פרטי אשראי / זיהוי'],
  [/(שלם|תשלום|העבר(ו)? (כסף|סכום)|העברה בנקאית|ביט\b|פייבוקס|paybox|bit\b|gift ?card|גיפט ?קארד|ביטקוין|bitcoin|crypto|wire transfer|western union|דמי (משלוח|טיפול|מכס))/i, 3, 'בקשת תשלום / העברת כסף'],
  [/(חבילה|משלוח|דואר ישראל|שירות הדואר|שליח|parcel|package|delivery|shipment|dhl|fedex|ups\b)/i, 1, 'תבנית "חבילה/משלוח" (נפוצה בהונאות)'],
  [/(בנק|חשבונך|חשבון הבנק|כרטיס האשראי שלך|פעילות חשודה|חיוב חריג|bank|suspicious (activity|login|transaction)|unusual (activity|sign.?in))/i, 2, 'תבנית "בנק / פעילות חשודה"'],
  [/(זכית|מזל טוב|פרס|הגרלה|you(\'ve| have)? won|congratulations|prize|lottery|גלגל המזל|מתנה חינם)/i, 3, 'הבטחת פרס / זכייה'],
  [/(הלוואה|השקעה|רווח מובטח|תשואה|guaranteed (profit|return)|investment opportunity|עבודה מהבית|הכנסה (פסיבית|נוספת)|טריידינג)/i, 2, 'הצעת השקעה / הכנסה קלה'],
  [/(אמא|אבא|היי אמא|היי אבא|הטלפון שלי (נשבר|נגנב)|גנבו לי את הטלפון|מספר חדש|this is my new number|החלפתי מספר)/i, 3, 'תבנית "בן משפחה עם מספר חדש"'],
  [/(משטרה|רשות המסים|מס הכנסה|ביטוח לאומי|קנס|דו"ח (חניה|תנועה)|הוצאה לפועל|police|irs|fine\b|tax refund|החזר מס)/i, 2, 'התחזות לרשות / קנס / החזר מס'],
  [/(אל תספר|בסוד|שמור על סודיות|do not tell|keep (this )?secret|don\'t tell)/i, 2, 'מבקש סודיות'],
  [/(לחץ כאן|הקלק|click (here|below|the link)|tap the link|open the link|היכנס לקישור|בקישור)/i, 1, 'קורא ללחיצה על קישור'],
]
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly|is\.gd|rb\.gy|shorturl\.at|ow\.ly|tiny\.cc|rebrand\.ly|s\.id|wa\.link|lnkd\.in|t\.ly)\//i

const SUSPICIOUS_TLDS = new Set(['zip', 'mov', 'xyz', 'top', 'click', 'buzz', 'tk', 'ml', 'ga', 'cf', 'gq', 'icu', 'rest', 'cam', 'work', 'support', 'country', 'gdn', 'loan', 'men', 'monster', 'sbs', 'cyou', 'cfd', 'live', 'site', 'online', 'shop', 'vip'])
const BRANDS = {
  paypal: ['paypal.com'], google: ['google.com', 'google.co.il', 'googleapis.com'], gmail: ['gmail.com'], apple: ['apple.com', 'icloud.com'], microsoft: ['microsoft.com', 'live.com', 'office.com'],
  amazon: ['amazon.com', 'amazon.co.uk', 'amazon.de'], facebook: ['facebook.com', 'fb.com'], instagram: ['instagram.com'], whatsapp: ['whatsapp.com', 'whatsapp.net', 'wa.me'], netflix: ['netflix.com'],
  leumi: ['leumi.co.il', 'bankleumi.co.il'], hapoalim: ['bankhapoalim.co.il', 'hapoalim.co.il'], discount: ['discountbank.co.il'], mizrahi: ['mizrahi-tefahot.co.il'], isracard: ['isracard.co.il'],
  israelpost: ['israelpost.co.il'], doar: ['israelpost.co.il'], paybox: ['payboxapp.com'], bitpay: ['bitpay.com'], dhl: ['dhl.com'], fedex: ['fedex.com'], binance: ['binance.com'], taxes: ['gov.il'], police: ['police.gov.il'],
}
const MULTI_SLD = new Set(['co.il', 'org.il', 'gov.il', 'ac.il', 'muni.il', 'net.il', 'co.uk', 'com.au', 'co.jp'])

function registeredDomain(host) {
  const p = host.split('.')
  if (p.length >= 3 && MULTI_SLD.has(p.slice(-2).join('.'))) return p.slice(-3).join('.')
  return p.slice(-2).join('.')
}

export function analyzeUrl(raw) {
  const flags = []
  let s = String(raw).trim()
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !hadScheme) throw new Error('כתובת לא תקינה')
  if (!hadScheme) s = `http://${s}`
  let url
  try {
    url = new URL(s)
  } catch {
    throw new Error('כתובת לא תקינה')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const authority = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0]
  let score = 0
  const add = (pts, msg) => {
    score += pts
    flags.push(msg)
  }
  if (!['http:', 'https:'].includes(url.protocol)) add(3, `פרוטוקול חריג: ${url.protocol}`)
  else if (url.protocol === 'http:') add(1, 'ללא הצפנה (http ולא https)')
  if (authority.includes('@')) add(4, 'מכיל @ בכתובת: מה שלפני ה-@ הוא לא האתר האמיתי')
  if (net.isIP(host)) add(3, 'האתר הוא כתובת IP ולא שם')
  if (host.includes('xn--')) add(3, 'שם דומיין עם Punycode (אותיות שנראות כמו אחרות)')
  if (/[^\x00-\x7f]/.test(url.hostname) || /[^\x00-\x7f]/.test(authority)) add(3, 'תווים לא לטיניים בשם האתר')
  const labels = host.split('.')
  if (!net.isIP(host)) {
    if (labels.length >= 5) add(2, `הרבה תת-דומיינים (${labels.length - 2})`)
    const tld = labels[labels.length - 1]
    if (SUSPICIOUS_TLDS.has(tld)) add(2, `סיומת נפוצה בהונאות: .${tld}`)
    const reg = registeredDomain(host)
    const hostNoReg = host.slice(0, Math.max(0, host.length - reg.length))
    for (const [brand, officials] of Object.entries(BRANDS)) {
      if (host.includes(brand) && !officials.includes(reg) && !officials.some((o) => host === o || host.endsWith(`.${o}`))) {
        add(4, `שם המותג "${brand}" מופיע, אבל הדומיין האמיתי הוא ${reg}`)
        break
      }
    }
    if ((reg.match(/-/g) || []).length >= 2) add(1, 'הרבה מקפים בשם הדומיין')
    if (/(login|secure|verify|update|account|signin|wallet|support|billing)/.test(host) && hostNoReg) add(1, 'מילות "אבטחה/התחברות" בתוך שם האתר')
  }
  if (SHORTENERS.test(`${host}/`)) add(2, 'קישור מקוצר: היעד האמיתי מוסתר (אפשר לבדוק עם safe_unshorten_url)')
  if (url.port && !['80', '443'].includes(url.port)) add(1, `פורט חריג: ${url.port}`)
  if (url.href.length > 200) add(1, 'כתובת ארוכה מאוד')
  if (/\.(exe|scr|apk|bat|cmd|vbs|js|jar|msi|zip|rar)$/i.test(url.pathname)) add(2, 'הקישור מוביל להורדת קובץ מסוכן')
  return { host, flags, score, level: score >= 5 ? 'חשוד מאוד' : score >= 2 ? 'יש סימנים מחשידים' : 'לא נמצאו סימנים בולטים' }
}

function analyzeMessage(msg) {
  const flags = []
  let score = 0
  for (const [re, pts, label] of SCAM_RULES) {
    if (re.test(msg)) {
      score += pts
      flags.push(label)
    }
  }
  const urls = msg.match(/(?:https?:\/\/|www\.)[^\s<>"')]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|il|co\.il|xyz|top|click|info|me|ly|link|site|online|shop|vip)\b(?:\/[^\s]*)?/gi) || []
  const urlNotes = []
  for (const u of [...new Set(urls)].slice(0, 5)) {
    try {
      const a = analyzeUrl(u)
      if (a.score >= 2) {
        score += Math.min(a.score, 5)
        urlNotes.push(`${u}: ${a.flags.join('; ')}`)
      }
    } catch {
      /* ignore unparsable */
    }
  }
  if (SHORTENERS.test(msg) && !urlNotes.length) {
    score += 2
    flags.push('קישור מקוצר')
  }
  const level = score >= 8 ? 'סיכוי גבוה מאוד להונאה' : score >= 4 ? 'חשוד' : score >= 2 ? 'יש סימנים קלים' : 'לא נמצאו סימנים בולטים'
  return { score, level, flags, urlNotes }
}

// ---------- offline knowledge tables ----------
const WA_SCAMS = [
  { name: 'בקשת קוד אימות', keys: ['קוד', 'אימות', 'verification', 'otp', 'שש ספרות'], what: 'מישהו (לרוב "מכר") מבקש שתשלח לו קוד שהגיע ב-SMS כדי להשתלט על הוואטסאפ שלך.', todo: ['לעולם אל תשלח קוד שהגיע אליך', 'אם שלחת: התחבר מחדש לוואטסאפ עם הקוד שיגיע אליך והפעל אימות דו-שלבי', 'הודע לאנשי הקשר שלך שאם קיבלו ממך הודעה חריגה, זו לא את/ה'] },
  { name: 'חבר בצרה / מספר חדש', keys: ['חבר', 'בצרה', 'מספר חדש', 'אמא', 'אבא', 'טלפון נגנב', 'גנבו'], what: '"היי אמא, זה המספר החדש שלי, הטלפון נשבר, תעבירי לי כסף דחוף".', todo: ['התקשר למספר הישן של האדם או שאל שאלה שרק הוא יודע', 'אל תעביר כסף לפני אימות בשיחה קולית', 'דווח וחסום את המספר'] },
  { name: 'טעות במספר / השקעה', keys: ['טעות', 'מספר שגוי', 'השקעה', 'קריפטו', 'wrong number', 'investment', 'רומנטי'], what: 'הודעה "בטעות" שהופכת לשיחה חברית ואז להצעת השקעה או קריפטו ("רומנטיקה כלכלית").', todo: ['אל תמשיך שיחה עם זר שפנה בטעות', 'אל תשקיע באפליקציה שזר המליץ עליה', 'חסום ודווח'] },
  { name: 'קישור להצטרפות לקבוצה / סקר', keys: ['קבוצה', 'קישור', 'סקר', 'הצטרף', 'group', 'link'], what: 'קישור לקבוצה או סקר שמוביל לאתר פישינג שמבקש פרטים.', todo: ['אל תלחץ על קישורים ממספרים לא מוכרים', 'בדוק את הקישור עם safe_url_check', 'אם הזנת פרטים: החלף סיסמאות'] },
  { name: 'עבודה מהבית / משימות', keys: ['עבודה', 'משרה', 'לייקים', 'משימות', 'job', 'task'], what: 'הצעת עבודה קלה (לייקים, סרטונים) עם תשלום, ואז דרישה להפקיד כסף כדי "לשחרר" רווחים.', todo: ['מעסיק אמיתי לא מבקש כסף ממך', 'אל תפקיד ואל תקנה קריפטו בשביל "המשימה"', 'חסום ודווח'] },
  { name: 'התחזות לתמיכה של וואטסאפ', keys: ['תמיכה', 'וואטסאפ', 'support', 'חשבון ייחסם', 'whatsapp'], what: 'הודעה ש"חשבונך ייחסם" ומבקשת ללחוץ על קישור או לשלוח קוד.', todo: ['וואטסאפ לא פונה אליך בהודעה פרטית', 'התעלם וחסום', 'בדוק הגדרות > חשבון > אימות דו-שלבי'] },
  { name: 'משלוח כרטיס QR / קישור מכשיר', keys: ['qr', 'מכשיר מקושר', 'linked device', 'ברקוד'], what: 'מבקשים לסרוק QR "לקבלת פרס" ובכך מקשרים את החשבון שלך למכשיר שלהם.', todo: ['אל תסרוק QR שקיבלת מאחרים', 'בוואטסאפ: הגדרות > מכשירים מקושרים > התנתק מכל מכשיר לא מוכר'] },
]
const IL_SCAMS = [
  { name: 'שירות הדואר / חבילה ממתינה', keys: ['דואר', 'חבילה', 'משלוח', 'דמי טיפול', 'מכס'], pattern: 'SMS: "חבילתך ממתינה, יש לשלם 3.90 ש"ח דמי טיפול" עם קישור לאתר מזויף שגונב פרטי אשראי.', todo: ['דואר ישראל לא גובה תשלום דרך קישור ב-SMS', 'היכנס ידנית לאתר/אפליקציה הרשמיים ובדוק מספר מעקב', 'אם הזנת אשראי: חסום את הכרטיס מיד מול חברת האשראי'] },
  { name: 'קנס משטרה / דו"ח תנועה', keys: ['משטרה', 'קנס', 'דו"ח', 'דוח', 'תנועה', 'חניה'], pattern: '"נרשם לך קנס, שלם תוך 24 שעות כדי לא לצבור ריבית" + קישור.', todo: ['בדוק דוחות באתר gov.il / מוקד 8888 בלבד', 'אל תלחץ על הקישור', 'דווח למשטרה (100) אם הזנת פרטים'] },
  { name: 'SMS מזויף מהבנק', keys: ['בנק', 'חשבון', 'כרטיס', 'אשראי', 'נחסם', 'פעילות חשודה'], pattern: '"בוצעה פעולה חשודה בחשבונך, היכנס לאימות" עם קישור או בקשה להתקשר למספר.', todo: ['בנק לא שולח קישורים להתחברות', 'פתח את אפליקציית הבנק ישירות או התקשר למספר שמאחורי הכרטיס', 'אם מסרת פרטים: התקשר מיד לבנק לחסימה'] },
  { name: 'גנבו לי את הטלפון', keys: ['גנבו', 'טלפון', 'נגנב', 'מספר חדש', 'אמא', 'אבא', 'סבתא'], pattern: '"היי אמא, גנבו לי את הטלפון זה מספר חדש, תעבירי לי בביט דחוף".', todo: ['התקשר למספר המוכר של הקרוב', 'שאל שאלה אישית', 'אל תעביר כסף בלי אימות קולי'] },
  { name: 'ביט / פייבוקס מזויף', keys: ['ביט', 'bit', 'פייבוקס', 'paybox', 'יד שניה', 'יד2', 'קונה'], pattern: 'קונה ביד2 שולח "קישור לקבלת התשלום" או מבקש קוד; או "העברתי בטעות, תחזיר".', todo: ['תשלום מתקבל בלי קישורים וקודים', 'בדוק את היתרה באפליקציה עצמה', 'אל תחזיר "העברה בטעות" לפני שהבנק אישר'] },
  { name: 'ביטוח לאומי / החזר מס', keys: ['ביטוח לאומי', 'החזר', 'מס הכנסה', 'רשות המסים', 'זכאות'], pattern: '"אתה זכאי להחזר מס, הזן פרטי אשראי לקבלת הכסף".', todo: ['החזר נכנס לחשבון, לא מבקשים אשראי כדי להעביר לך', 'בדוק באתר הרשות הרשמי', 'דווח ב-gov.il'] },
  { name: 'שיחה מ"נציג" / טכנאי מחשב', keys: ['נציג', 'טכנאי', 'מחשב', 'anydesk', 'teamviewer', 'שליטה מרחוק'], pattern: 'מתקשר ומבקש להתקין AnyDesk/TeamViewer כדי "לתקן" או "להחזיר כסף".', todo: ['לעולם אל תתקין שליטה מרחוק לבקשת מתקשר', 'נתק, ואם כבר התקנת: נתק אינטרנט, הסר ושנה סיסמאות מהמכשיר אחר'] },
]
const HACKED = {
  google: ['היכנס ל-myaccount.google.com/security מהמכשיר הנקי ושנה סיסמה', 'בדוק "המכשירים שלך" והתנתק מכל מה שלא מוכר', 'בדוק הפניית דואר, מסננים וחשבונות משוחזרים בהגדרות Gmail', 'הפעל אימות דו-שלבי (עדיף passkey / אפליקציית אימות)', 'עבור ל"בדיקת אבטחה" של גוגל ובטל גישה לאפליקציות חשודות', 'שנה סיסמה בכל אתר שבו השתמשת באותה סיסמה'],
  whatsapp: ['התקן מחדש וואטסאפ וקבל קוד חדש בהודעה: זה מנתק את התוקף', 'הפעל אימות דו-שלבי (הגדרות > חשבון > אימות דו-שלבי)', 'הגדרות > מכשירים מקושרים > התנתק מכל המכשירים', 'הודע לאנשי הקשר והקבוצות שהחשבון נפרץ ושלא יעבירו כסף', 'אם אי אפשר להיכנס: כתוב לתמיכה של וואטסאפ מתוך האפליקציה', 'בדוק שאין העברת שיחות או הפניות אצל חברת הסלולר'],
  bank: ['התקשר מיד לבנק (מספר מגב הכרטיס/האתר הרשמי) וחסום כרטיסים וגישה לחשבון', 'בקש לבטל עסקאות חשודות ולפתוח בירור', 'שנה סיסמת בנק ופרטי כניסה מכלי נקי', 'הגש תלונה במשטרה / באתר "תלונה מקוונת" וצרף צילומי מסך', 'עקוב אחרי דוח האשראי שלך בחודשים הקרובים', 'אם מסרת קוד או התקנת אפליקציה: מחק אותה ונקה את המכשיר'],
  instagram: ['נסה לאפס סיסמה מהקישור במייל, או דרך "קבל עזרה בכניסה"', 'אם שונה המייל: חפש מייל "שונה כתובת האימייל" מ-Instagram ולחץ "בטל"', 'הגדרות > מרכז החשבונות > סיסמה ואבטחה: התנתק מכל המכשירים', 'הפעל אימות דו-שלבי באפליקציית אימות', 'בדוק אפליקציות מחוברות והסר חשודות', 'דווח על החשבון שנפרץ דרך "My account was hacked"'],
  facebook: ['facebook.com/hacked וליווי בהוראות', 'החלף סיסמה והתנתק מכל המכשירים', 'בדוק מייל/טלפון משוחזרים והסר שלא מוכרים', 'הפעל אימות דו-שלבי', 'הסר אפליקציות ועמודים שלא יצרת'],
  email: ['שנה סיסמה מיד ובדוק שאין כללי הפניה/מסנן אוטומטיים', 'התנתק מכל המכשירים הפעילים', 'הפעל אימות דו-שלבי', 'בדוק אילו חשבונות מחוברים לאותו מייל והחלף שם סיסמאות', 'הודע לאנשי הקשר על מיילים חשודים'],
}
const HACKED_ALIASES = { גוגל: 'google', gmail: 'google', 'ג׳ימייל': 'google', וואטסאפ: 'whatsapp', ווטסאפ: 'whatsapp', בנק: 'bank', אשראי: 'bank', אינסטגרם: 'instagram', פייסבוק: 'facebook', מייל: 'email', אימייל: 'email', דואל: 'email' }

function lookup(table, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return `אפשרויות:\n${table.map((e) => `- ${e.name}`).join('\n')}`
  const hits = table.filter((e) => e.name.toLowerCase().includes(q) || e.keys.some((k) => q.includes(k.toLowerCase()) || k.toLowerCase().includes(q)))
  if (!hits.length) return `לא נמצאה תבנית תואמת. אפשרויות:\n${table.map((e) => `- ${e.name}`).join('\n')}`
  return hits
    .slice(0, 3)
    .map((e) => lines(`${e.name}`, e.what ?? e.pattern, 'מה לעשות:', e.todo.map((t, i) => `${i + 1}. ${t}`)))
    .join('\n\n')
}

// ---------- email headers ----------
function parseHeaders(raw) {
  const unfolded = raw.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ')
  const map = {}
  for (const line of unfolded.split('\n')) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const k = m[1].toLowerCase()
    ;(map[k] ??= []).push(m[2])
  }
  return map
}
const addrOf = (v) => {
  const m = /<([^>]+)>/.exec(v ?? '') || /([^\s<>"]+@[^\s<>"]+)/.exec(v ?? '')
  return m ? m[1].trim().toLowerCase() : ''
}
const domOf = (a) => (a.includes('@') ? a.split('@').pop() : '')

// ---------- file risk ----------
const RISKY_EXT = new Set(['exe', 'scr', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'bat', 'cmd', 'com', 'pif', 'msi', 'ps1', 'jar', 'apk', 'lnk', 'hta', 'reg', 'cpl', 'dll', 'iso', 'img', 'dmg', 'appimage', 'sh'])
const MACRO_EXT = new Set(['docm', 'xlsm', 'pptm', 'xlam', 'dotm'])
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'gz', 'tar', 'cab'])
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'jpg', 'jpeg', 'png', 'gif', 'mp3', 'mp4', 'csv', 'rtf'])

function fileRisk(name, source) {
  const flags = []
  let score = 0
  const add = (p, m) => {
    score += p
    flags.push(m)
  }
  const clean = name.trim()
  if (/[‮‭‎‏]/.test(clean)) add(5, 'מכיל תו כיוון נסתר (RTL override) שמסתיר את הסיומת האמיתית')
  const base = clean.replace(/[‮‭‎‏]/g, '').replace(/[ .]+$/, '')
  const parts = base.split('.')
  const ext = parts.length > 1 ? parts.pop().toLowerCase() : ''
  const prev = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
  if (!ext) add(1, 'אין סיומת: לא ברור איזה סוג קובץ זה')
  if (RISKY_EXT.has(ext)) add(4, `סיומת .${ext} היא קובץ הרצה / סקריפט שעלול להיות מסוכן`)
  if (MACRO_EXT.has(ext)) add(3, `.${ext} מכיל פקודות מאקרו: אל תפעיל "Enable content"`)
  if (ARCHIVE_EXT.has(ext)) add(2, `ארכיון .${ext} יכול להסתיר קובץ מסוכן בפנים`)
  if (DOC_EXT.has(prev) && (RISKY_EXT.has(ext) || ARCHIVE_EXT.has(ext) || MACRO_EXT.has(ext))) add(4, `סיומת כפולה .${prev}.${ext}: נראה כמו מסמך אבל זה לא`)
  if (/ {3,}/.test(base)) add(2, 'הרבה רווחים בשם כדי להסתיר את הסיומת')
  const unknown = /לא מוכר|זר|unknown|stranger|email|אימייל|מייל|whatsapp|וואטסאפ|sms|קישור|link/i.test(source ?? '')
  if (unknown && score > 0) add(2, 'המקור לא מהימן / לא צפוי')
  if (unknown && ext === 'apk') add(3, 'התקנת APK מחוץ לחנות רשמית היא דרך נפוצה להדביק נוזקות')
  const level = score >= 5 ? 'מסוכן, אל תפתח' : score >= 2 ? 'חשוד, בדוק לפני פתיחה' : 'נראה רגיל'
  return { ext, score, level, flags }
}

// ---------- tools ----------
export const tools = [
  {
    name: 'safe_password_strength',
    description: 'מעריך חוזק סיסמה (אנטרופיה ודפוסים נפוצים) מקומית; הסיסמה לא נשמרת ולא מוחזרת.',
    parameters: obj({ password: str('הסיסמה לבדיקה') }),
    run({ password }) {
      const a = analyzePassword(text(password, 'סיסמה'))
      return lines(`חוזק: ${a.rating} (כ-${a.bits} ביטים של אנטרופיה)`, a.issues.length ? `בעיות: ${a.issues.join('; ')}` : 'לא נמצאו דפוסים חלשים.', 'טיפ: משפט סיסמה ארוך של 4-5 מילים אקראיות חזק יותר מסיסמה קצרה עם סימנים.')
    },
  },
  {
    name: 'safe_passphrase',
    description: 'מייצר משפט סיסמה אקראי ממילים (בעזרת crypto) וזכיר יותר מסיסמה קצרה.',
    parameters: obj({ words: num('כמה מילים, 4 עד 10 (ברירת מחדל 5)'), separator: str('מפריד, ברירת מחדל -'), add_number: bool('להוסיף ספרה בסוף') }, []),
    run({ words = 5, separator = '-', add_number = false }) {
      const n = Math.floor(toNumber(words, 'מספר מילים'))
      if (n < 4 || n > 10) throw new Error('מספר המילים חייב להיות בין 4 ל-10')
      const sep = String(separator ?? '-').slice(0, 3)
      const pick = Array.from({ length: n }, () => WORDS[crypto.randomInt(WORDS.length)])
      let out = pick.join(sep)
      let bits = n * Math.log2(WORDS.length)
      if (add_number) {
        out += crypto.randomInt(10)
        bits += Math.log2(10)
      }
      return `${out}\nאנטרופיה משוערת: ${Math.round(bits)} ביטים. שמור במנהל סיסמאות ולא בצ'אט.`
    },
  },
  {
    name: 'safe_password_breach_check',
    description: 'בודק אם סיסמה דלפה (Pwned Passwords); רק 5 תווים ראשונים של ה-SHA1 נשלחים.',
    parameters: obj({ password: str('הסיסמה לבדיקה') }),
    network: true,
    async run({ password }) {
      const pw = text(password, 'סיסמה')
      const { prefix, suffix } = pwnedSplit(pw)
      const body = await fetchText(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true' } })
      const count = pwnedMatch(body, suffix)
      return count ? `הסיסמה הזו הופיעה ב-${count.toLocaleString('en-US')} דליפות. אל תשתמש בה, והחלף אותה בכל מקום שבו היא בשימוש.` : 'הסיסמה לא נמצאה במאגר הדליפות הידוע. זה לא מבטיח שהיא חזקה, ראה safe_password_strength.'
    },
  },
  {
    name: 'safe_pwned_prefix',
    description: 'מציג איזה קידומת בת 5 תווים של SHA1 תישלח בבדיקת דליפה (לשקיפות), בלי לשלוח כלום.',
    parameters: obj({ password: str('הסיסמה') }),
    run({ password }) {
      const { prefix, suffix } = pwnedSplit(text(password, 'סיסמה'))
      return `קידומת שנשלחת: ${prefix}; ${suffix.length} התווים הנותרים נשארים מקומיים.`
    },
  },
  {
    name: 'safe_scam_message_check',
    description: 'מנתח הודעה (SMS, וואטסאפ, מייל) לסימני הונאה ומחזיר ציון וסימנים מחשידים.',
    parameters: obj({ message: str('נוסח ההודעה כפי שהתקבלה') }),
    run({ message }) {
      const r = analyzeMessage(text(message, 'הודעה'))
      return lines(`הערכה: ${r.level} (ציון ${r.score})`, r.flags.length ? `סימנים: ${r.flags.map((f) => `\n- ${f}`).join('')}` : 'לא נמצאו דפוסים ידועים.', r.urlNotes.length ? `קישורים חשודים:\n${r.urlNotes.map((u) => `- ${u}`).join('\n')}` : '', 'אל תלחץ, אל תשלח קודים וכסף; אמת דרך ערוץ רשמי שאתה מחפש בעצמך.')
    },
  },
  {
    name: 'safe_url_check',
    description: 'בודק כתובת אתר לסימני פישינג (מבנה הכתובת בלבד) בלי לגלוש אליה.',
    parameters: obj({ url: str('הכתובת לבדיקה') }),
    run({ url }) {
      const r = analyzeUrl(text(url, 'כתובת'))
      return lines(`דומיין: ${r.host}`, `הערכה: ${r.level} (ציון ${r.score})`, r.flags.map((f) => `- ${f}`), 'הבדיקה לא גולשת לאתר ולא מבטיחה שהוא בטוח.')
    },
  },
  {
    name: 'safe_unshorten_url',
    description: 'עוקב אחרי קישור מקוצר עד 5 הפניות ומחזיר רק את היעד הסופי, בלי להוריד תוכן.',
    parameters: obj({ url: str('הקישור המקוצר') }),
    network: true,
    async run({ url }) {
      let current = text(url, 'כתובת').trim()
      if (!/^https?:\/\//i.test(current)) current = `https://${current}`
      const chain = []
      for (let hop = 0; hop <= 5; hop++) {
        const checked = await assertPublicUrl(current)
        let res
        for (const method of ['HEAD', 'GET']) {
          try {
            res = await fetch(checked, { method, redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Helper/1.0' } })
          } catch (e) {
            if (method === 'GET') throw new Error('לא הצלחתי להגיע לקישור')
            continue
          }
          if (method === 'GET' || res.status !== 405) break
          res.body?.cancel().catch(() => {})
        }
        res.body?.cancel().catch(() => {})
        const loc = res.headers.get('location')
        if (res.status >= 300 && res.status < 400 && loc) {
          if (hop === 5) throw new Error('יותר מ-5 הפניות: קישור חשוד')
          chain.push(checked.host)
          current = new URL(loc, checked).href
          continue
        }
        const final = new URL(checked.href)
        const a = analyzeUrl(final.href)
        return lines(`יעד סופי: ${final.origin}${final.pathname.length > 1 ? final.pathname.slice(0, 80) : ''}`, `הפניות: ${chain.length}`, `בדיקת מבנה: ${a.level}`, a.flags.map((f) => `- ${f}`))
      }
      throw new Error('יותר מדי הפניות')
    },
  },
  {
    name: 'safe_email_header_check',
    description: 'מנתח כותרות מייל שהודבקו ומחפש אי-התאמה בין From, Reply-To ו-Return-Path ותוצאות SPF/DKIM.',
    parameters: obj({ headers: str('כותרות המייל (הצג מקור / Show original)') }),
    run({ headers }) {
      const h = parseHeaders(text(headers, 'כותרות'))
      const from = addrOf(h.from?.[0])
      const reply = addrOf(h['reply-to']?.[0])
      const ret = addrOf(h['return-path']?.[0])
      if (!from && !reply && !ret) throw new Error('לא נמצאו שדות From / Reply-To / Return-Path')
      const flags = []
      const fd = domOf(from)
      if (reply && domOf(reply) !== fd) flags.push(`Reply-To (${domOf(reply)}) שונה מהשולח (${fd}): תשובה תגיע למקום אחר`)
      if (ret && fd && domOf(ret) !== fd && !domOf(ret).endsWith(`.${fd}`)) flags.push(`Return-Path (${domOf(ret)}) שונה מהשולח (${fd})`)
      const disp = /^"?([^"<]*)"?\s*</.exec(h.from?.[0] ?? '')?.[1]?.trim() ?? ''
      if (disp.includes('@') && !disp.toLowerCase().includes(from)) flags.push('שם התצוגה מציג כתובת מייל אחרת מהאמיתית')
      const auth = (h['authentication-results'] ?? []).join(' ') + ' ' + (h['received-spf'] ?? []).join(' ')
      for (const k of ['spf', 'dkim', 'dmarc']) {
        const m = new RegExp(`${k}\\s*=\\s*(\\w+)`, 'i').exec(auth)
        if (m && /fail|softfail|none|neutral|temperror|permerror/i.test(m[1])) flags.push(`${k.toUpperCase()} לא עבר (${m[1]})`)
      }
      if (new RegExp('xn--', 'i').test(from)) flags.push('דומיין עם Punycode בשולח')
      const hops = (h.received ?? []).length
      return lines(`From: ${from || '?'}  Reply-To: ${reply || '-'}  Return-Path: ${ret || '-'}`, `מספר שרתים בדרך (Received): ${hops}`, flags.length ? `סימנים מחשידים:\n${flags.map((f) => `- ${f}`).join('\n')}` : 'לא נמצאה אי-התאמה בולטת (עדיין תהיה זהיר מבקשות חריגות).')
    },
  },
  {
    name: 'safe_whatsapp_scams',
    description: 'מחפש תבנית הונאה נפוצה בוואטסאפ (קוד אימות, חבר בצרה, השקעה) ומה לעשות.',
    parameters: obj({ query: str('מילת מפתח או תיאור; ריק = רשימת תבניות') }, []),
    run({ query }) {
      return lookup(WA_SCAMS, query)
    },
  },
  {
    name: 'safe_israel_scams',
    description: 'מחפש הונאות נפוצות בישראל (דואר, משטרה, בנק, "גנבו לי טלפון", ביט) ומה לעשות.',
    parameters: obj({ query: str('מילת מפתח או תיאור; ריק = רשימת תבניות') }, []),
    run({ query }) {
      return lookup(IL_SCAMS, query)
    },
  },
  {
    name: 'safe_if_hacked',
    description: 'רשימת צעדים לפי סוג חשבון שנפרץ: גוגל, וואטסאפ, בנק, אינסטגרם, פייסבוק או מייל.',
    parameters: obj({ account: oneOf(['google', 'whatsapp', 'bank', 'instagram', 'facebook', 'email'], 'סוג החשבון') }),
    run({ account }) {
      const key = HACKED[account] ? account : HACKED_ALIASES[String(account ?? '').trim().toLowerCase()]
      if (!key) throw new Error(`סוג חשבון לא מוכר. אפשרויות: ${Object.keys(HACKED).join(', ')}`)
      return `אם ${key} נפרץ:\n${HACKED[key].map((s, i) => `${i + 1}. ${s}`).join('\n')}\nעשה זאת ממכשיר נקי, ובדוק שאין נוזקה לפני שאתה מחליף סיסמאות.`
    },
  },
  {
    name: 'safe_hash_text',
    description: 'מחשב גיבוב (sha256, sha512 או sha1) של טקסט, מקומית; לבדיקת שלמות ולא לאחסון סיסמאות.',
    parameters: obj({ text: str('הטקסט'), algorithm: oneOf(['sha256', 'sha512', 'sha1'], 'אלגוריתם, ברירת מחדל sha256') }, ['text']),
    run({ text: t, algorithm = 'sha256' }) {
      if (!['sha256', 'sha512', 'sha1'].includes(algorithm)) throw new Error('אלגוריתם לא נתמך')
      return crypto.createHash(algorithm).update(text(t, 'טקסט'), 'utf8').digest('hex')
    },
  },
  {
    name: 'safe_random_token',
    description: 'מייצר מחרוזת אקראית חזקה (hex או base64url) מ-N בייטים בעזרת crypto.',
    parameters: obj({ bytes: num('מספר בייטים, 1 עד 128 (ברירת מחדל 32)'), format: oneOf(['hex', 'base64url'], 'פורמט') }, []),
    run({ bytes = 32, format = 'hex' }) {
      const n = Math.floor(toNumber(bytes, 'בייטים'))
      if (n < 1 || n > 128) throw new Error('מספר הבייטים חייב להיות בין 1 ל-128')
      if (!['hex', 'base64url'].includes(format)) throw new Error('פורמט לא נתמך')
      return crypto.randomBytes(n).toString(format)
    },
  },
  {
    name: 'safe_file_risk',
    description: 'בודק שם קובץ לסיכון: סיומת כפולה (.pdf.exe), סקריפטים, APK, מאקרו וסימנים מוסתרים.',
    parameters: obj({ filename: str('שם הקובץ'), source: str('מאיפה הגיע (מייל, וואטסאפ, אתר...)') }, ['filename']),
    run({ filename, source }) {
      const r = fileRisk(text(filename, 'שם קובץ').slice(0, 300), source ? String(source).slice(0, 300) : '')
      return lines(`הערכה: ${r.level} (ציון ${r.score}${r.ext ? `, סיומת .${r.ext}` : ''})`, r.flags.map((f) => `- ${f}`), 'אם לא ציפית לקובץ הזה, אל תפתח אותו; אפשר לסרוק ב-Windows Defender או לבקש מהשולח לאשר בשיחה.')
    },
  },
]

export const tests = [
  { tool: 'safe_password_strength', args: { password: '123456' }, check: (r) => r.includes('חלשה מאוד') },
  { tool: 'safe_password_strength', args: { password: 'akuo' }, check: (r) => r.includes('שלום') },
  { tool: 'safe_password_strength', args: { password: 'Xk9#mQ2vLp7$wRt4' }, check: (r) => /חזקה/.test(r) && !r.includes('Xk9') },
  { tool: 'safe_passphrase', args: { words: 4, separator: '.' }, check: (r) => r.split('\n')[0].split('.').length === 4 },
  { tool: 'safe_passphrase', args: { words: 2 }, throws: true, check: () => false },
  { tool: 'safe_password_breach_check', args: { password: 'password' }, check: (r) => /דליפות/.test(r) },
  // SHA1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  { tool: 'safe_pwned_prefix', args: { password: 'password' }, check: (r) => r.includes('5BAA6') && r.includes('35 התווים') && !r.includes('1E4C9B93') },
  { tool: 'safe_scam_message_check', args: { message: 'דואר ישראל: החבילה שלך ממתינה. שלם דמי משלוח מיד בקישור http://israelpost-track.xyz/pay אחרת היא תוחזר' }, check: (r) => r.includes('סיכוי גבוה') && r.includes('israelpost') },
  { tool: 'safe_scam_message_check', args: { message: 'נתראה מחר בארוחת צהריים ב-13:00' }, check: (r) => r.includes('לא נמצאו סימנים בולטים') },
  { tool: 'safe_url_check', args: { url: 'http://paypal-login.secure-verify.xyz/a' }, check: (r) => r.includes('paypal') && r.includes('חשוד מאוד') },
  { tool: 'safe_url_check', args: { url: 'https://www.google.com/search?q=a' }, check: (r) => r.includes('לא נמצאו סימנים בולטים') },
  { tool: 'safe_url_check', args: { url: 'http://google.com@evil.example/login' }, check: (r) => r.includes('@') },
  { tool: 'safe_unshorten_url', args: { url: 'http://tinyurl.com/' }, check: (r) => r.includes('יעד סופי') },
  { tool: 'safe_email_header_check', args: { headers: 'Return-Path: <bounce@mailer.evil.test>\nReply-To: scam@other.test\nFrom: "Bank Leumi" <service@leumi.co.il>\nAuthentication-Results: mx.google.com; spf=fail; dkim=none; dmarc=fail\nReceived: from a\nReceived: from b' }, check: (r) => r.includes('Reply-To') && r.includes('SPF') && r.includes('Return-Path') },
  { tool: 'safe_whatsapp_scams', args: { query: 'קוד אימות' }, check: (r) => r.includes('לעולם אל תשלח קוד') },
  { tool: 'safe_israel_scams', args: { query: 'גנבו לי את הטלפון' }, check: (r) => r.includes('התקשר למספר המוכר') },
  { tool: 'safe_israel_scams', args: {}, check: (r) => r.includes('שירות הדואר') },
  { tool: 'safe_if_hacked', args: { account: 'whatsapp' }, check: (r) => r.includes('אימות דו-שלבי') },
  { tool: 'safe_if_hacked', args: { account: 'nothing' }, throws: true, check: () => false },
  { tool: 'safe_hash_text', args: { text: 'abc' }, check: (r) => r === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  { tool: 'safe_hash_text', args: { text: 'abc', algorithm: 'sha1' }, check: (r) => r === 'a9993e364706816aba3e25717850c26c9cd0d89d' },
  { tool: 'safe_random_token', args: { bytes: 16 }, check: (r) => /^[0-9a-f]{32}$/.test(r) },
  { tool: 'safe_random_token', args: { bytes: 16, format: 'base64url' }, check: (r) => /^[A-Za-z0-9_-]{22}$/.test(r) },
  { tool: 'safe_random_token', args: { bytes: 0 }, throws: true, check: () => false },
  { tool: 'safe_file_risk', args: { filename: 'invoice.pdf.exe', source: 'מייל' }, check: (r) => r.includes('אל תפתח') && r.includes('סיומת כפולה') },
  { tool: 'safe_file_risk', args: { filename: 'photo.jpg' }, check: (r) => r.includes('נראה רגיל') },
]
