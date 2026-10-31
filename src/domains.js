// What each message is about, and so which tools and instructions the model gets for it.
//
// Before this, every model call carried every tool Helper has (up to ~135 definitions) and a system prompt that
// described all of them, whatever the message was. The model read ~25K tokens of manual to answer "מה נשמע", got
// slower and costlier, and picked worse among 135 look-alike tools. Now a message gets the base tools every
// conversation needs, plus the areas ("domains") its words point to, each with its own short playbook.
//
// Nothing is out of reach: tool_search opens any domain by name, a tool the model calls by name runs even when it
// was not sent (agent.js), and TOOL_ROUTING=off sends everything as before.
import { config } from './config.js'

// Every conversation needs these, whatever it is about.
export const BASE = new Set([
  'remember', 'add_reminder', 'list_reminders', 'cancel_reminder', 'schedule_task', 'list_tasks', 'cancel_task',
  'start_background_task', 'send_whatsapp', 'react', 'get_news', 'web_search', 'fetch_page', 'get_weather',
  'check_mail', 'get_calendar', 'gmail_search', 'gmail_read', 'calendar_add', 'tasks_list', 'tasks_add',
  'memory_search', 'update_plan', 'open_loop', 'tool_search',
])

const starts = (...prefixes) => (name) => prefixes.some((p) => name.startsWith(p))
const named = (...names) => (name) => names.includes(name)
const either = (...tests) => (name) => tests.some((t) => t(name))

// id: what tool_search and the menu call it. label: Hebrew, for the menu. has(name): its tools.
// words: what in a message points to it (Hebrew and English, as he writes). Matched on the last messages, not just
// the newest, so "כן" after an offer keeps the domain the offer came from.
export const DOMAINS = [
  {
    id: 'travel',
    label: 'טיסות וחופשות',
    has: named('find_flights', 'find_stays'),
    words: /לינה|ללון|לישון ב|צימר|airbnb|אייר ?בי ?אנ ?בי|בוקינג|booking|הוסטל|hostel|אכסני|דיר(ה|ת) נופש|וילה|טיס|לטוס|טסים|חופש(ה|ות)? ב?חו"?ל|חו"ל|נופש|יעד|מלון|דיל|כרטיס(י)? טיסה|flight|fly|trip|vacation|hotel|airline|נתב"ג|רמון/i,
  },
  {
    id: 'shopping',
    label: 'קניות, הזמנות והשוואת מחירים',
    has: named('compare_prices', 'run_errand'),
    words: /תמצא לי|עד \d+ ?(ש"ח|שקל|₪)|תזמי[ןנ]|להזמין|תקנה|לקנות|קנייה|הכי זול|זול|מחיר|תשווה|השווא|עגלה|משלוח של|תקבע (לי )?תור|תירשם|הרשמה|לרכוש|buy|order|cheap|price|deal/i,
  },
  {
    id: 'services',
    label: 'שירותים: אזעקות, חבילות, אוטובוסים, שבת ומטבע',
    has: named('israel_red_alert', 'track_package', 'israel_transit', 'get_jewish_calendar', 'get_currency_rate'),
    words: /אזעק|צבע אדום|פיקוד|טיל|חבילה|משלוח|מעקב|tracking|עלי ?אקספרס|aliexpress|דואר ישראל|אוטובוס|קו \d|תחנה|רכבת|תחבורה|שבת|נרות|הבדלה|פרשה|חג|תאריך עברי|דולר|יורו|שקל|מטבע|שער|להמיר|המר/i,
  },
  {
    id: 'watch',
    label: 'מעקב שקט אחרי דפים, מחירים ומלאי',
    has: named('add_watcher', 'list_watchers', 'remove_watcher'),
    words: /תעקוב|מעקב|תודיע לי כש|כשי(רד|עלה|גיע|חזור)|מלאי|יחזור למלאי|תבדוק כל|watch/i,
  },
  {
    id: 'school',
    label: 'בית ספר: מטלות, מערכת שעות, מבחנים וקבצים',
    has: named('classroom_assignments', 'get_timetable', 'week_ahead', 'study_plan', 'gemini_spark', 'ask_gemini', 'docs_create', 'drive_search', 'drive_read', 'drive_send_file'),
    words: /בית ספר|ביה"ס|שיעור|מערכת|מטל|הגשה|להגיש|קלאסרום|classroom|וובטופ|webtop|מבחן|בוחן|ציון|ציונים|היעדרו|מורה|כית|ללמוד ל|תלמד אותי|לימוד|שבוע הבא|דרייב|drive|דוקס|docs|מסמך|קובץ|ג'?מיני|gemini|ספארק|spark|עבודה ב|תפתור|תעשה לי את/i,
  },
  {
    id: 'pc',
    label: 'המחשב בבית',
    has: either(starts('pc_'), named('run_command', 'read_file', 'write_file', 'use_computer', 'open', 'play_youtube', 'wake_pc', 'play_spotify')),
    words: /מחשב|מסך|מסכים|ווליום|עוצמ|תנמיך|תגביר|שיר|ספוטיפ|spotify|יוטיוב|youtube|תפתח|תסגור|תכבה|תדליק|לילה טוב|הולך לישון|מצב לילה|נעיל|תנעל|קובץ|קבצים|צילום מסך|מצלמ|טאב|לשונית|התקן|תוכנ|הורדות|תנגן|תשים|טיימר|לוח העתקה|תקליד|pc|windows/i,
  },
  {
    id: 'youtube',
    label: 'יוטיוב: חיפוש סרטונים',
    has: named('youtube_search'),
    words: /יוטיוב|youtube|סרטון|קליפ|הדרכה בווידאו|וידאו של/i,
  },
  {
    id: 'phone',
    label: 'הטלפון',
    has: either(starts('phone_'), named('run_on_phone', 'call_me')),
    words: /טלפון|פלאפון|נייד|אפליקצי|מונית|גט|gett|התראות|שעון מעורר|סוללה|תנווט|וויז|waze|תתקשר|שיחה אליי|תחייג/i,
  },
  {
    id: 'tv',
    label: 'הטלוויזיה',
    has: starts('tv_'),
    words: /טלוויז|טיוי|\btv\b|סטרימיו|stremio|נטפליקס|netflix|כרומקאסט|chromecast|סרט|סדרה|פרק|קודי|kodi/i,
  },
  {
    id: 'home',
    label: 'בית חכם',
    has: starts('google_home_'),
    words: /אור|אורות|מנורה|נורה|בית חכם|רמקול|מזגן|google home|גוגל הום/i,
  },
  {
    id: 'create',
    label: 'יצירה: תמונות, סרטונים, מוזיקה וצלילים',
    has: starts('create_'),
    words: /תמונה|תצייר|ציור|לוגו|איור|סרטון|וידאו|video|מוזיק|שיר על|לחן|צליל|אפקט|תיצור|תעצב|image|draw/i,
  },
  {
    id: 'dev',
    label: 'קוד ובנייה: GitHub, מכונת לינוקס, Claude Code',
    has: named('github_get', 'vm_run', 'vm_send_file', 'claude_code'),
    words: /קוד|github|גיטהאב|ריפו|סקריפט|תבנה|אתר|דף נחיתה|משחק|פייתון|python|javascript|תכנ(ת|ות)|באג|לינוקס|linux|claude/i,
  },
  {
    id: 'people',
    label: 'הודעות לאחרים, דיסקורד, מייל יוצא וקול',
    has: named('send_whatsapp_to', 'send_discord', 'gmail_send', 'voice_mode'),
    words: /תשלח ל|תשלח הודעה|תכתוב ל|תגיד ל|תענה ל|הודעה ל|דיסקורד|discord|מייל ל|תשלח מייל|קולי|בקול|תדבר|הקלטה/i,
  },
  {
    id: 'groups',
    label: 'קבוצות וואטסאפ',
    has: named('whatsapp_groups'),
    words: /קבוצ|פספסתי|הורים|ועד|שכבה|בקבוצה/i,
  },
  {
    id: 'learning',
    label: 'ללמוד דברים חדשים ולבנות כלים',
    has: either(starts('skill_'), named('learn_how', 'build_tool', 'tool_pending', 'tool_install', 'tool_reject', 'tool_learned', 'tool_remove')),
    words: /תלמד (איך|לעשות)|ללמוד איך|לקח|כלי חדש|תבנה כלי|skill|לא יודע איך/i,
  },
  {
    id: 'memory',
    label: 'הזיכרון ויומן הפעולות',
    has: named('forget', 'memory_pending', 'memory_confirm', 'memory_reject', 'audit_search'),
    words: /זיכרון|תזכור|מה אתה יודע עליי|תשכח|תמחק את מה|מה עשית|פעולות|למה עשית/i,
  },
]

const byId = new Map(DOMAINS.map((d) => [d.id, d]))
export const domainOf = (name) => DOMAINS.find((d) => d.has(name))?.id || ''

// The text routing reads: his last few messages and Helper's last answer (an offer he may now be saying yes to).
export function routingText(messages, extra = '') {
  const text = (m) => (typeof m.content === 'string' ? m.content : m.content?.find?.((p) => p.type === 'text')?.text || '')
  const users = messages.filter((m) => m.role === 'user').slice(-3).map(text)
  const lastAnswer = text(messages.findLast((m) => m.role === 'assistant' && m.content) || {}).slice(0, 500)
  return [...users, lastAnswer, extra].filter(Boolean).join('\n')
}

// The domains a text points to.
export function pickDomains(text) {
  const found = new Set()
  for (const d of DOMAINS) if (d.words.test(String(text || ''))) found.add(d.id)
  return found
}

// Is this core tool sent for these domains? A tool in no domain is base, so a new tool is never lost.
export function routed(name, domains, unlocked) {
  if (!config.routing || !domains) return true
  if (BASE.has(name) || unlocked?.has(name)) return true
  const id = domainOf(name)
  return !id || domains.has(id)
}

// tool_search over the domains: a domain's id, its Hebrew label or its words. Returns the domain ids.
export function searchDomains(query) {
  const q = String(query || '').toLowerCase().trim()
  if (!q) return []
  return DOMAINS.filter((d) => d.id === q || q.includes(d.id) || d.label.includes(q) || d.words.test(q)).map((d) => d.id)
}

// One line per domain that is on but not loaded, so the model knows what it can open.
export function menuLine(domains, isOnName, english) {
  const closed = DOMAINS.filter((d) => !domains.has(d.id) && isOnName(d))
  if (!closed.length || !config.routing) return ''
  const list = closed.map((d) => `${d.id} (${d.label})`).join(', ')
  return english
    ? `- More abilities, not loaded for this message: ${list}. If the request needs one, call tool_search with its id first; never say you cannot before that.`
    : `• יכולות נוספות שלא נטענו להודעה הזאת: ${list}. אם הבקשה צריכה אחת מהן, קרא קודם ל-tool_search עם השם שלה; אל תגיד שאתה לא יכול לפני זה.`
}

export const domainLabel = (id) => byId.get(id)?.label || id
