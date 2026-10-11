// LocalFilter: decides, with no model call, whether an event can match a watch at all, and what kind of
// message it is. Most events end here.

const has = (text, list) => list.some((w) => text.includes(String(w).toLowerCase()))

// 'drop'  - cannot match this watch
// 'pass'  - matches; go on to the urgency decision
// 'judge' - the cheap checks passed, but the trigger also needs meaning understood (one small model call)
export function localFilter(watch, event) {
  const m = watch.match || {}
  if (m.always) return 'pass'
  const from = String(event.metadata?.from || '').toLowerCase()
  const text = `${event.title}\n${event.body}`.toLowerCase()
  if (m.from?.length && !has(from, m.from)) return 'drop'
  if (m.keywords?.length && !has(text, m.keywords)) return 'drop'
  return m.judge ? 'judge' : 'pass'
}

const MARKETING = /מבצע|הנחה|קופון|1\+1|sale\b|% ?off|discount|newsletter|ניוזלטר|unsubscribe|להסרה מרשימת|הסר(ה)? מרשימת התפוצה|דיוור|black friday|מחירים מיוחדים|הטבה בלעדית/i
const AUTO = /הוגש(ה)? בהצלחה|התקבל(ה)? בהצלחה|קיבלנו את|ההזמנה (בדרך|נשלחה|התקבלה)|אישור (הזמנה|תשלום|קבלה)|order (confirmed|shipped|received)|your receipt|קבלה מס|no-?reply|do not reply|אין להשיב להודעה/i
const SOCIAL = /facebook|instagram|tiktok|linkedin|twitter|x\.com|youtube|discord|snapchat|עוקב חדש|תייג(ה)? אותך|הגיב(ה)? על|liked your|mentioned you|new follower|עדכון גרסה|update available/i

// Requests no real sender makes by mail: credentials, codes, "verify your account", payment under pressure.
const PHISHING = [
  /(שלח|שלחי|שלחו|הזן|הזיני|הקלד|מסור|העבר).{0,40}(קוד|סיסמ|פרטי (האשראי|הכרטיס|ההתחברות)|מספר (הכרטיס|תעודת))/i,
  /(לחץ|לחצי|לחצו|היכנס|כנס|כנסי).{0,50}(לאמת|אימות|לעדכן את פרטי|לשחרר את החשבון)/i,
  /(send|enter|share|confirm|provide).{0,40}(password|verification code|one-time code|otp|card number|login details)/i,
  /verify your (account|identity)|account (will be|has been) (suspended|locked|closed)|החשבון (ייחסם|יושעה|ננעל|נחסם)/i,
  /(זכית|זכייה|פרס)\b.{0,40}(לחץ|קישור|לקבלת)|you('ve| have) won/i,
]
// Text addressed to the assistant itself: an attempt to steer it from inside the content it reads.
const INJECTION = [
  /ignore (all |any )?(previous|prior|above) (instructions|rules)|system prompt|you are now|new instructions:/i,
  /התעלם מ(כל )?(ה)?(הוראות|ההנחיות)|הוראות חדשות:|אתה עכשיו/i,
  /(צור|הוסף|מחק|בטל|שנה).{0,20}(מעקב|טריגר|שעות (ה)?שקט)|COMPUTER_MODE|\/watch\b/i,
]

// What kind of message this is, judged from its text alone.
// 'phishing' and 'injection' are never acted on; the other three may never interrupt.
export function classify(event) {
  const text = `${event.metadata?.from || ''}\n${event.title}\n${event.body}`
  const hit = (list) => list.find((re) => re.test(text))
  if (hit(INJECTION)) return { category: 'injection', why: 'התוכן מנסה לתת הוראות לעוזר' }
  if (hit(PHISHING)) return { category: 'phishing', why: 'בקשה לקוד, סיסמה, אימות חשבון או פרס' }
  if (MARKETING.test(text)) return { category: 'marketing' }
  if (AUTO.test(text)) return { category: 'auto' }
  if (SOCIAL.test(text)) return { category: 'social' }
  return { category: null }
}

export const NEVER_INTERRUPT = ['marketing', 'auto', 'social', 'phishing', 'injection']
