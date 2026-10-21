import fs from 'node:fs'
import path from 'node:path'
import { config, mailEnabled } from './config.js'
import { state, save, newId } from './store.js'
import { webSearch, fetchPage } from './web.js'
import { recentMail } from './mail.js'
import { upcomingEvents, calendarOn } from './calendar.js'
import * as google from './google.js'
import * as create from './create.js'
import { getNews, formatNews } from './news.js'
import { canSpeak } from './media.js'
import { vmEnabled, vmRun, vmFetch } from './vm.js'
import { checkWatcher } from './watchers.js'
import { voiceEnabled, callOwner } from './voice.js'
import { sessionEnabled } from './session.js'
import { parseTimetableDay, timetableText } from './lessons.js'
import { wakeEnabled, wakePc } from './wake.js'
import * as pc from './pc.js'
import * as services from './services.js'
import * as googleHome from './google-home.js'
import { useComputer, runErrand, runOnPhone } from './computer-use.js'
import { phoneAppConnected } from './phone-app.js'
import { errandBrowserEnabled } from './errand-browser.js'
import { extendedTools, categories, searchTools } from './toolkit/registry.js'
import { addFact, removeFact, CATEGORIES } from './memory.js'
import { memoryTools } from './memory-tools.js'
import { askGemini, geminiApiEnabled } from './gemini-api.js'
import { phoneTools } from './phone-tools.js'
import { planStudy, planText, localStamp, weekAhead } from './study.js'

// The computer tools drive the user's own Windows machine. Locally that is this process. In the cloud
// (see src/pc-bridge.js) the same calls are forwarded to the home bridge, and only when COMPUTER_MODE is on.
// The Discord bot counts as linked once it has called the bridge within the last day.
const discordLinked = () => Date.now() - (state.bridgeSeenAt || 0) < 24 * 3600000

const computerEnabled = () => config.computerMode !== 'off' && pc.pcEnabled()
// Each scheduled task is a full model run, so the list is kept short.
const MAX_TASKS = 20

async function approved(ctx, what) {
  if (config.computerMode === 'auto') return true
  return ctx.confirm(what)
}

// What "open" may launch besides a web address: sites by name, and a few built-in Windows apps by their URI.
const APPS = {
  youtube: 'https://www.youtube.com',
  יוטיוב: 'https://www.youtube.com',
  google: 'https://www.google.com',
  גוגל: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  classroom: 'https://classroom.google.com',
  calendar: 'https://calendar.google.com',
  יומן: 'https://calendar.google.com',
  drive: 'https://drive.google.com',
  whatsapp: 'https://web.whatsapp.com',
  spotify: 'spotify:',
  ספוטיפיי: 'spotify:',
  calculator: 'calculator:',
  מחשבון: 'calculator:',
  settings: 'ms-settings:',
  הגדרות: 'ms-settings:',
}

// The first ordinary video for a search, read from YouTube's own results page: { id, title } or null.
// Only "videoRenderer" entries count, which leaves out ads, Shorts shelves, channels and playlists.
export async function firstYouTubeVideo(query) {
  const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=he`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept-Language': 'he,en;q=0.8' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return null
  const html = await res.text()
  const m = html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,1500}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/)
  if (m) return { id: m[1], title: JSON.parse(`"${m[2]}"`) }
  const id = html.match(/"videoId":"([\w-]{11})"/)
  return id ? { id: id[1], title: '' } : null
}

// Read tools cover every connected Google account unless one is named; write tools default to the first (primary) one.
const one = (account) => google.resolveAccounts(account)[0]
// For tools that change something. Read-only accounts (school) are refused here, in code, whatever the model was told.
function writable(account) {
  const email = account ? one(account) : google.googleAccounts().find((a) => !config.google.readOnly.includes(a.toLowerCase()))
  if (!email) throw new Error('אין חשבון Google שמותר לכתוב בו')
  if (config.google.readOnly.includes(email.toLowerCase())) throw new Error(`החשבון ${email} מוגדר לקריאה בלבד. אפשר לנסח טיוטה והמשתמש ישלח בעצמו.`)
  return email
}
const perAccount = async (account, fn) => (await Promise.all(google.resolveAccounts(account).map((a) => fn(a).catch((e) => [{ account: a, error: e.message }])))).flat()

const str = (description) => ({ type: 'string', description })
const ACCOUNT = str('כתובת חשבון Google מסוים; ריק = כל החשבונות בקריאה, החשבון הראשי בכתיבה')
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required })

export const tools = [
  {
    name: 'remember',
    description: 'שומר עובדה על המשתמש לזיכרון קבוע (העדפות, פרטים, דברים שהוא מחכה להם).',
    parameters: obj(
      {
        fact: str('העובדה לשמירה, משפט קצר אחד'),
        category: { type: 'string', enum: CATEGORIES, description: 'סוג העובדה' },
        importance: { type: 'number', description: '1-5; 5 רק לדברים קריטיים כמו שם ואלרגיות. ברירת מחדל 3' },
      },
      ['fact']
    ),
    run({ fact, category, importance }) {
      // Duplicates are dropped and a changed fact replaces the old one; secrets are refused (see memory.js).
      const r = addFact(fact, { category, importance })
      if (r.status === 'duplicate') return `כבר ידוע (#${r.id})`
      if (r.status === 'updated') return `עודכן (#${r.id}), במקום: ${r.previous}`
      return `נשמר (#${r.id})`
    },
  },
  {
    name: 'forget',
    description: 'מוחק עובדה מהזיכרון לפי מזהה.',
    parameters: obj({ id: { type: 'number' } }),
    run({ id }) {
      return removeFact(id) ? 'נמחק' : 'לא נמצא'
    },
  },
  {
    name: 'add_reminder',
    description: 'קובע תזכורת שתישלח למשתמש בוואטסאפ בזמן שנקבע.',
    parameters: obj(
      {
        text: str('מה להזכיר'),
        when: str('זמן מקומי בפורמט YYYY-MM-DDTHH:MM'),
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly'] },
      },
      ['text', 'when']
    ),
    run({ text, when, repeat = 'none' }) {
      const at = new Date(when)
      if (isNaN(at)) return 'זמן לא תקין, נדרש YYYY-MM-DDTHH:MM'
      if (repeat === 'none' && at < new Date()) return 'הזמן הזה כבר עבר'
      const id = newId()
      state.reminders.push({ id, text, at: at.toISOString(), repeat })
      save()
      return `תזכורת #${id} נקבעה ל-${at.toLocaleString('he-IL')}`
    },
  },
  {
    name: 'list_reminders',
    description: 'מציג את כל התזכורות הפעילות.',
    parameters: obj({}),
    run() {
      return JSON.stringify(state.reminders.map((r) => ({ ...r, at: new Date(r.at).toLocaleString('he-IL') })))
    },
  },
  {
    name: 'cancel_reminder',
    description: 'מבטל תזכורת לפי מזהה.',
    parameters: obj({ id: { type: 'number' } }),
    run({ id }) {
      const before = state.reminders.length
      state.reminders = state.reminders.filter((r) => r.id !== id)
      save()
      return before === state.reminders.length ? 'לא נמצא' : 'בוטל'
    },
  },
  {
    name: 'schedule_task',
    description:
      'קובע משימה שתרוץ בזמן מסוים: אתה תופעל אז עם ההוראה, תבצע אותה עם הכלים, ותשלח הודעה רק אם יש מה לומר. לבדיקות חוזרות ("כל בוקר ב-8 תבדוק...") ולחזרה לדבר שנשאר פתוח.',
    parameters: obj(
      {
        instruction: str('מה לעשות כשהמשימה רצה, מנוסח כהוראה מלאה שמובנת גם בלי השיחה הנוכחית'),
        when: str('זמן מקומי בפורמט YYYY-MM-DDTHH:MM'),
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly'] },
      },
      ['instruction', 'when']
    ),
    run({ instruction, when, repeat = 'none' }) {
      const at = new Date(when)
      if (isNaN(at)) return 'זמן לא תקין, נדרש YYYY-MM-DDTHH:MM'
      if (repeat === 'none' && at < new Date()) return 'הזמן הזה כבר עבר'
      if (state.tasks.length >= MAX_TASKS) return `יש כבר ${MAX_TASKS} משימות מתוזמנות. צריך לבטל אחת קודם.`
      const id = newId()
      state.tasks.push({ id, instruction, at: at.toISOString(), repeat })
      save()
      return `משימה #${id} נקבעה ל-${at.toLocaleString('he-IL')}${repeat !== 'none' ? ` (${repeat})` : ''}`
    },
  },
  {
    name: 'list_tasks',
    description: 'מציג את המשימות המתוזמנות.',
    parameters: obj({}),
    run() {
      return JSON.stringify(state.tasks.map((t) => ({ ...t, at: new Date(t.at).toLocaleString('he-IL') })))
    },
  },
  {
    name: 'cancel_task',
    description: 'מבטל משימה מתוזמנת לפי מזהה.',
    parameters: obj({ id: { type: 'number' } }),
    run({ id }) {
      const before = state.tasks.length
      state.tasks = state.tasks.filter((t) => t.id !== id)
      save()
      return before === state.tasks.length ? 'לא נמצא' : 'בוטל'
    },
  },
  {
    name: 'start_background_task',
    enabled: () => true,
    description: 'מעביר משימה ארוכה לסוכן ברקע, כדי שהמשתמש יוכל להמשיך לדבר איתך בזמן שהיא רצה: שליטה במחשב או בטלפון, דפדפן קניות, מחקר בהרבה אתרים, כתיבת קוד והרצתו במכונה שלך. התוצאה תגיע בהודעה נפרדת כשהיא מוכנה. לא לשאלה שעונים עליה בכלי אחד או שניים.',
    parameters: obj({
      title: str('שם קצר בעברית שהמשתמש יזהה, 2-4 מילים, למשל "השוואת מחירי אוזניות"'),
      instruction: str('המשימה המלאה לסוכן, עם כל הפרטים מהשיחה שהוא צריך: מה בדיוק, מגבלות, תקציב, מה להחזיר. הוא לא רואה את השיחה.'),
    }),
    async run({ title, instruction }, ctx) {
      if (!ctx.background) return 'אי אפשר להתחיל משימת רקע מכאן. בצע אותה בעצמך עכשיו.'
      const job = ctx.background(title, instruction)
      return `המשימה "${job.title}" רצה ברקע. אמור למשתמש בשורה אחת שהתחלת ושהתוצאה תגיע, בלי לחכות לה.`
    },
  },
  {
    name: 'send_whatsapp',
    description: 'שולח עכשיו הודעה למשתמש בוואטסאפ שלו. לשימוש כשהוא מדבר איתך ממקום אחר (דיסקורד) ומבקש לקבל משהו בוואטסאפ: סיכום, קישור, רשימה. לתזכורת בזמן עתידי יש add_reminder, שגם היא מגיעה לוואטסאפ.',
    parameters: obj({ text: str('נוסח ההודעה') }),
    async run({ text }, ctx) {
      if (!ctx.say) return 'אין חיבור לוואטסאפ מהשיחה הזאת'
      await ctx.say(text)
      return 'נשלח לוואטסאפ'
    },
  },
  {
    name: 'get_timetable',
    enabled: () => sessionEnabled(),
    description: 'מערכת השעות של המשתמש מ-Webtop ליום מסוים: שעה, מספר שיעור, מקצוע, חדר ומורה, ומה בוטל. ל"מה יש לי מחר", "באיזה חדר אני עכשיו". תזכורת לפני כל שיעור כבר נשלחת אוטומטית, אין צורך לקבוע אותה.',
    parameters: obj({ day: str('today, tomorrow, מחר, היום, מחרתיים, Hebrew or English weekday (יום רביעי, Wednesday), or YYYY-MM-DD') }, ['day']),
    run({ day }) {
      const parsed = parseTimetableDay(day)
      if (parsed.error) return parsed.error
      return timetableText(parsed.day)
    },
  },
  {
    name: 'send_whatsapp_to',
    description:
      'שולח הודעת וואטסאפ בשם המשתמש לאדם אחר (לא אליו עצמו). רק כשהמשתמש ביקש במפורש לשלוח, עם נמען ונוסח ברורים. "תנסח" או "מה לכתוב" זה טיוטה בלבד: אל תקרא לכלי. המשתמש רואה את הנמען והנוסח המדויקים ומאשר לפני כל שליחה.',
    parameters: obj({ to: str('שם איש הקשר כמו שהמשתמש אמר, או מספר טלפון'), text: str('הנוסח המדויק שיישלח') }, ['to', 'text']),
    async run({ to, text }, ctx) {
      if (!ctx.sendAs || !ctx.findContact) return 'אפשר לשלוח בשמו רק כשהוא מבקש בצ\'אט בוואטסאפ'
      const found = await ctx.findContact(to)
      if (found.error) return found.error
      if (found.matches) return `כמה אנשי קשר מתאימים: ${found.matches.join(', ')}. שאל את המשתמש למי מהם.`
      const ok = await ctx.confirm(`לשלוח בשמך ל-*${found.name}* (${found.number}):\n\n${text}`)
      if (!ok) return 'המשתמש לא אישר, לא נשלח כלום'
      await ctx.sendAs(found.jid, text)
      return `נשלח ל-${found.name}`
    },
  },
  {
    name: 'send_discord',
    enabled: discordLinked,
    description: 'שולח למשתמש הודעה פרטית בדיסקורד, דרך בוט הדיסקורד שלו. עם speak=true הבוט גם אומר אותה בקול בחדר הקולי, אם הוא מחובר אליו. לשימוש כשהמשתמש מדבר איתך בוואטסאפ ומבקש לקבל משהו בדיסקורד.',
    parameters: obj({ text: str('נוסח ההודעה'), speak: { type: 'boolean', description: 'לומר גם בקול בחדר הקולי' } }, ['text']),
    run({ text, speak = false }) {
      state.discordOutbox = [...state.discordOutbox, { text: String(text).slice(0, 3500), speak: Boolean(speak), at: Date.now() }].slice(-20)
      save()
      return 'ההודעה ממתינה לבוט של דיסקורד והוא ישלח אותה תוך כמה שניות. אם הבוט כבוי, היא תישלח כשיעלה.'
    },
  },
  {
    name: 'voice_mode',
    enabled: canSpeak,
    description: 'קובע אם התשובות שלך נשלחות כהודעות קוליות. always = קול על כל הודעה (כשהמשתמש מבקש "תדבר איתי", "תענה בקול"). match = קול רק כשהוא שולח הודעה קולית ("תפסיק לדבר", "תכתוב").',
    parameters: obj({ mode: { type: 'string', enum: ['always', 'match'] } }),
    run({ mode }) {
      state.voiceMode = mode === 'always' ? 'always' : 'match'
      save()
      return mode === 'always' ? 'מצב קול הופעל. התשובה הנוכחית שלך כבר תישלח בקול.' : 'מצב קול כובה.'
    },
  },
  {
    name: 'react',
    description: 'שם אימוג\'י כתגובה על ההודעה האחרונה של המשתמש. אפשר להשתמש בזה במקום תשובה בטקסט כשאישור קצר מספיק.',
    parameters: obj({ emoji: str('אימוג\'י אחד, למשל 👍') }),
    async run({ emoji }, ctx) {
      if (!ctx.react) return 'אין הודעה להגיב עליה'
      await ctx.react(emoji)
      return 'בוצע. אם אין מה להוסיף, סיים בלי טקסט.'
    },
  },
  {
    name: 'get_news',
    description: 'כותרות חדשות מהשעות האחרונות מאתרי חדשות (ישראל ועולם), עם שעה ומקור. לשאלות כמו "מה קרה היום" או "מה חדש".',
    parameters: obj({ hours: { type: 'number', description: 'כמה שעות אחורה (ברירת מחדל 12)' } }, []),
    async run({ hours = 12 }) {
      const items = await getNews(Math.min(72, Math.max(1, hours)))
      return items.length ? formatNews(items) : 'לא נמצאו כותרות בטווח הזה'
    },
  },
  {
    name: 'web_search',
    description: 'חיפוש באינטרנט. מחזיר כותרות, קישורים ותקצירים.',
    parameters: obj({ query: str('שאילתת החיפוש') }),
    async run({ query }) {
      return JSON.stringify(await webSearch(query))
    },
  },
  {
    name: 'ask_gemini',
    enabled: geminiApiEnabled,
    description: "שולח שאלה ל-Gemini של Google ומחזיר את התשובה שלו. רק כשהמשתמש ביקש במפורש לשאול את ג'מיני. מסור לו את התשובה כמו שהיא, וציין שזה מה ש-Gemini ענה.",
    parameters: obj({ question: str('השאלה, מנוסחת במלואה') }),
    async run({ question }) {
      return `Gemini ענה:
${await askGemini(question)}`
    },
  },
  {
    name: 'fetch_page',
    description: 'מוריד דף אינטרנט ומחזיר את הטקסט שלו (למשל כדי לקרוא מחיר או פרטים).',
    parameters: obj({ url: str('כתובת מלאה') }),
    async run({ url }) {
      return fetchPage(url)
    },
  },
  {
    name: 'add_watcher',
    description:
      'מעקב שקט אחרי דף אינטרנט: בודק אותו כל כמה זמן ומעדכן את המשתמש רק כשמשהו משתנה או כשתנאי מתקיים (מחיר, מלאי, פרסום תוצאות וכו׳).',
    parameters: obj(
      {
        name: str('שם קצר למעקב'),
        url: str('הדף לבדיקה'),
        instruction: str('מה לבדוק ומתי להתריע, למשל "המחיר של הבקר; להתריע אם יורד מתחת ל-200 ש"ח"'),
        interval_minutes: { type: 'number', description: 'כל כמה דקות לבדוק (מינימום 15, ברירת מחדל 60)' },
        days: { type: 'number', description: 'אחרי כמה ימים לסגור את המעקב לבד (ברירת מחדל 30)' },
      },
      ['name', 'url', 'instruction']
    ),
    async run({ name, url, instruction, interval_minutes = 60, days = 30 }) {
      const w = { id: newId(), name, url, instruction, intervalMin: Math.max(15, interval_minutes), expiresAt: Date.now() + Math.min(365, Math.max(1, days)) * 86400000, lastValue: null, lastRun: 0, fails: 0 }
      let first
      try {
        first = await checkWatcher(w)
      } catch (e) {
        return `לא הצלחתי לקרוא את הדף (${e.message}). המעקב לא נוצר - ייתכן שהאתר חוסם בוטים או נטען ב-JavaScript.`
      }
      w.lastValue = first.value
      w.history = [{ at: Date.now(), value: first.value }]
      w.lastRun = Date.now()
      state.watchers.push(w)
      save()
      return `מעקב #${w.id} נוצר. ערך נוכחי: ${first.value}. בדיקה כל ${w.intervalMin} דקות, עד ${new Date(w.expiresAt).toLocaleDateString('he-IL')}. אמור למשתמש את התדירות ואת תאריך הסיום.`
    },
  },
  {
    name: 'list_watchers',
    description: 'מציג את המעקבים הפעילים, הערך האחרון של כל אחד והיסטוריית השינויים שלו.',
    parameters: obj({}),
    run() {
      return JSON.stringify(
        state.watchers.map(({ id, name, url, instruction, intervalMin, lastValue, history = [], fails = 0, lastRun, expiresAt }) => ({
          status: fails >= 3 ? 'לא עובד' : 'עובד',
          lastChecked: lastRun ? new Date(lastRun).toLocaleString('he-IL') : 'עוד לא',
          until: expiresAt ? new Date(expiresAt).toLocaleDateString('he-IL') : 'בלי תאריך סיום',
          id,
          name,
          url,
          instruction,
          intervalMin,
          lastValue,
          changes: history.slice(-8).map((h) => ({ at: new Date(h.at).toLocaleString('he-IL'), value: h.value })),
        }))
      )
    },
  },
  {
    name: 'remove_watcher',
    description: 'מפסיק מעקב לפי מזהה.',
    parameters: obj({ id: { type: 'number' } }),
    run({ id }) {
      const before = state.watchers.length
      state.watchers = state.watchers.filter((w) => w.id !== id)
      save()
      return before === state.watchers.length ? 'לא נמצא' : 'הוסר'
    },
  },
  {
    name: 'check_mail',
    enabled: mailEnabled,
    description: 'מחזיר את המיילים האחרונים (שולח, נושא, תחילת התוכן) מכל התיבות המחוברות, או מתיבה אחת.',
    parameters: obj({ limit: { type: 'number', description: 'כמה מיילים מכל תיבה (ברירת מחדל 5, מקסימום 15)' }, account: str('כתובת של תיבה מסוימת; ריק = כל התיבות') }, []),
    async run({ limit = 5, account }) {
      const accounts = config.mail.accounts.filter((a) => !account || a.user === account)
      if (!accounts.length) return `אין תיבה מחוברת בשם ${account}`
      const n = Math.min(15, Math.max(1, limit))
      const boxes = await Promise.all(accounts.map((a) => recentMail(a, n).catch((e) => [{ account: a.user, error: e.message }])))
      return JSON.stringify(boxes.flat())
    },
  },
  {
    name: 'get_calendar',
    enabled: calendarOn,
    description: 'מחזיר אירועים קרובים מכל היומנים המחוברים של המשתמש.',
    parameters: obj({ days: { type: 'number', description: 'כמה ימים קדימה (ברירת מחדל 7)' } }, []),
    async run({ days = 7 }) {
      return JSON.stringify(await upcomingEvents(Math.min(60, Math.max(1, days))))
    },
  },
  {
    name: 'gmail_search',
    enabled: google.googleEnabled,
    description: 'מחפש מיילים ב-Gmail עם תחביר החיפוש של Gmail (למשל "from:teacher is:unread", "newer_than:3d"). שאילתה ריקה = המיילים האחרונים. מחזיר id לקריאה עם gmail_read.',
    parameters: obj({ query: str('שאילתת Gmail'), account: ACCOUNT, limit: { type: 'number', description: 'כמה תוצאות מכל חשבון (ברירת מחדל 5, מקסימום 15)' } }, []),
    async run({ query = '', account, limit = 5 }) {
      return JSON.stringify(await perAccount(account, (a) => google.gmailSearch(a, query, Math.min(15, Math.max(1, limit)))))
    },
  },
  {
    name: 'gmail_read',
    enabled: google.googleEnabled,
    description: 'קורא מייל מלא לפי id שהתקבל מ-gmail_search.',
    parameters: obj({ account: str('החשבון שבו נמצא המייל'), id: str('מזהה המייל') }),
    async run({ account, id }) {
      return JSON.stringify(await google.gmailRead(one(account), id))
    },
  },
  {
    name: 'gmail_send',
    enabled: google.googleEnabled,
    description: 'שולח מייל מחשבון Gmail של המשתמש. המשתמש מקבל בקשת אישור עם הנוסח המלא לפני השליחה.',
    parameters: obj({ account: ACCOUNT, to: str('כתובת הנמען'), subject: str('נושא'), body: str('גוף המייל, טקסט רגיל') }, ['to', 'subject', 'body']),
    async run({ account, to, subject, body }, ctx) {
      const from = writable(account)
      if (!/^[^\s,;<>]+@[^\s,;<>]+\.[^\s,;<>]+$/.test(to)) return 'כתובת הנמען לא תקינה. נדרשת כתובת מייל אחת.'
      // Sending in the user's name always needs their yes, whatever COMPUTER_MODE says.
      if (!(await ctx.confirm(`לשלוח את המייל הזה?\n*מאת:* ${from}\n*אל:* ${to}\n*נושא:* ${subject}\n\n${body}`))) return 'המשתמש לא אישר את השליחה'
      await google.gmailSend(from, { to, subject, body })
      return 'נשלח'
    },
  },
  {
    name: 'calendar_add',
    enabled: google.googleEnabled,
    description: 'מוסיף אירוע ליומן Google של המשתמש.',
    parameters: obj(
      { account: ACCOUNT, title: str('כותרת'), start: str('התחלה, זמן מקומי YYYY-MM-DDTHH:MM'), end: str('סיום (ברירת מחדל: שעה אחרי ההתחלה)'), description: str('פירוט') },
      ['title', 'start']
    ),
    async run({ account, ...event }) {
      return `האירוע נוסף: ${await google.calendarAdd(writable(account), event)}`
    },
  },
  {
    name: 'study_plan',
    description: 'בונה תוכנית למידה למבחן: מפזר את הנושאים על הימים שנשארו, יום אחרון לחזרה כללית. בלי add_to_calendar מחזיר טיוטה להראות למשתמש. עם add_to_calendar=true מוסיף את כל המפגשים ליומן אחרי אישור שלו.',
    parameters: obj(
      {
        exam: str('שם המבחן, למשל "מבחן בהיסטוריה"'),
        date: str('תאריך המבחן YYYY-MM-DD'),
        topics: { type: 'array', items: { type: 'string' }, description: 'הנושאים, הקשה ביותר קודם. ריק = מפגש כללי בכל יום' },
        minutes: { type: 'number', description: 'אורך מפגש בדקות (ברירת מחדל 60)' },
        start: str('שעת התחלה HH:MM (ברירת מחדל 17:00)'),
        skip: { type: 'array', items: { type: 'string' }, description: 'ימים בלי למידה, למשל ["שבת"] (ברירת מחדל)' },
        add_to_calendar: { type: 'boolean', description: 'true רק אחרי שהמשתמש ראה את הטיוטה וביקש להוסיף' },
        account: ACCOUNT,
      },
      ['exam', 'date']
    ),
    async run({ add_to_calendar, account, ...args }, ctx) {
      const sessions = planStudy({ ...args, skip: args.skip ?? ['שבת'] })
      const text = planText(sessions)
      if (!add_to_calendar) return `טיוטה (${sessions.length} מפגשים, עוד לא ביומן):\n${text}`
      if (!google.googleEnabled()) return `אין יומן Google מחובר. הנה התוכנית להעתקה:\n${text}`
      const email = writable(account)
      if (!(await ctx.confirm(`להוסיף ליומן ${email} את ${sessions.length} מפגשי הלמידה?\n${text}`))) return 'המשתמש לא אישר. שום דבר לא נוסף ליומן.'
      let added = 0
      for (const s of sessions) {
        await google.calendarAdd(email, { title: s.title, start: localStamp(s.start), end: localStamp(s.end), description: 'תוכנית למידה מ-Helper' })
        added++
      }
      return `נוספו ליומן ${added} מפגשים.`
    },
  },
  {
    name: 'week_ahead',
    enabled: () => google.googleEnabled() || calendarOn(),
    description: 'מה מחכה בשבוע הבא (ראשון עד שבת): מבחנים שמורים, הגשות מ-Classroom ואירועים ביומן. נשלח גם אוטומטית בשבת בערב.',
    parameters: obj({}, []),
    async run() {
      return (await weekAhead()) || 'אין מבחנים, הגשות או אירועים בשבוע הבא.'
    },
  },
  {
    name: 'tasks_list',
    enabled: google.googleEnabled,
    description: 'מציג את המשימות הפתוחות ב-Google Tasks.',
    parameters: obj({ account: ACCOUNT }, []),
    async run({ account }) {
      return JSON.stringify(await perAccount(account, google.tasksList))
    },
  },
  {
    name: 'tasks_add',
    enabled: google.googleEnabled,
    description: 'מוסיף משימה ל-Google Tasks.',
    parameters: obj({ account: ACCOUNT, title: str('המשימה'), due: str('תאריך יעד YYYY-MM-DD'), notes: str('הערות') }, ['title']),
    async run({ account, ...task }) {
      await google.tasksAdd(writable(account), task)
      return 'המשימה נוספה'
    },
  },
  {
    name: 'classroom_assignments',
    enabled: google.googleEnabled,
    description: 'מטלות מ-Google Classroom: קורס, כותרת, תאריך הגשה והאם כבר הוגשה. זה המקור המדויק לשיעורי בית.',
    parameters: obj({ account: ACCOUNT, days: { type: 'number', description: 'כמה ימים קדימה (ברירת מחדל 14)' } }, []),
    async run({ account, days = 14 }) {
      const work = await perAccount(account, (a) => google.classroomWork(a, Math.min(120, Math.max(1, days))))
      return JSON.stringify(work.map((w) => (w.error ? w : { account: w.account, course: w.course, title: w.title, due: w.due ? w.due.toLocaleString('he-IL') : 'בלי תאריך', submitted: w.submitted, link: w.link })))
    },
  },
  {
    name: 'drive_search',
    enabled: google.googleEnabled,
    description: 'מחפש קבצים ב-Google Drive לפי תוכן או שם. מחזיר id לקריאה עם drive_read.',
    parameters: obj({ query: str('מה לחפש'), account: ACCOUNT }, ['query']),
    async run({ query, account }) {
      return JSON.stringify(await perAccount(account, (a) => google.driveSearch(a, query)))
    },
  },
  {
    name: 'drive_read',
    enabled: google.googleEnabled,
    description: 'קורא את התוכן של מסמך Docs, גיליון Sheets, מצגת Slides או קובץ טקסט מ-Drive.',
    parameters: obj({ account: str('החשבון שבו נמצא הקובץ'), id: str('מזהה הקובץ') }),
    async run({ account, id }) {
      return google.driveRead(one(account), id)
    },
  },
  {
    name: 'create_image',
    enabled: create.imageEnabled,
    description: 'יוצר תמונה מתיאור ושולח אותה למשתמש בוואטסאפ. כתוב את התיאור באנגלית ובפירוט (נושא, סגנון, תאורה, זווית).',
    parameters: obj({ prompt: str('תיאור התמונה, באנגלית'), aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'] } }, ['prompt']),
    async run(args, ctx) {
      await ctx.sendMedia(await create.createImage(args))
      return 'התמונה נשלחה למשתמש'
    },
  },
  {
    name: 'create_video',
    enabled: create.createEnabled,
    description: 'יוצר סרטון קצר (כמה שניות) מתיאור. לוקח כמה דקות ועולה הרבה קרדיטים, לכן המשתמש מתבקש לאשר, והסרטון נשלח אליו לבד כשהוא מוכן. כתוב את התיאור באנגלית.',
    parameters: obj({ prompt: str('תיאור הסרטון, באנגלית'), aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'] } }, ['prompt']),
    async run(args, ctx) {
      if (!(await ctx.confirm(`ליצור סרטון? זה צורך קרדיטים מחשבון ElevenLabs.\n_${args.prompt}_`))) return 'המשתמש לא אישר'
      // Not awaited: a video outlasts the turn, so it is delivered on its own when done.
      create.createVideo(args).then(
        (video) => ctx.sendMedia(video),
        (e) => ctx.say(`⚠️ יצירת הסרטון נכשלה: ${e.message}`)
      ).catch((e) => console.log(`[video] ${e.message}`))
      return 'הסרטון בהכנה ויישלח למשתמש לבד בעוד כמה דקות. אמור לו את זה ואל תחכה.'
    },
  },
  {
    name: 'create_music',
    enabled: create.createEnabled,
    description: 'יוצר קטע מוזיקה מתיאור (סגנון, מצב רוח, כלים) ושולח אותו למשתמש. צורך קרדיטים, לכן המשתמש מתבקש לאשר.',
    parameters: obj({ prompt: str('תיאור המוזיקה, באנגלית'), seconds: { type: 'number', description: 'אורך בשניות, 10 עד 120 (ברירת מחדל 30)' } }, ['prompt']),
    async run(args, ctx) {
      if (!(await ctx.confirm(`ליצור קטע מוזיקה? זה צורך קרדיטים מחשבון ElevenLabs.\n_${args.prompt}_`))) return 'המשתמש לא אישר'
      await ctx.sendMedia(await create.createMusic(args))
      return 'המוזיקה נשלחה למשתמש'
    },
  },
  {
    name: 'create_sound',
    enabled: create.createEnabled,
    description: 'יוצר אפקט קולי קצר מתיאור (למשל "door creaking open", "crowd cheering") ושולח אותו למשתמש.',
    parameters: obj({ prompt: str('תיאור האפקט, באנגלית'), seconds: { type: 'number', description: 'אורך בשניות, עד 30' } }, ['prompt']),
    async run(args, ctx) {
      await ctx.sendMedia(await create.createSound(args))
      return 'האפקט נשלח למשתמש'
    },
  },
  {
    name: 'call_me',
    enabled: () => voiceEnabled(),
    description: 'מתקשר לטלפון של המשתמש ומחבר אותו לעוזר הקולי. רק כשהוא ביקש במפורש שתתקשר אליו עכשיו.',
    parameters: obj({}),
    async run() {
      await callOwner()
      return 'מחייג אליו עכשיו'
    },
  },
  {
    name: 'github_get',
    enabled: () => Boolean(config.githubToken),
    description: 'קריאה בלבד מה-API של GitHub בחשבון של המשתמש. path לדוגמה: /user/repos, /repos/OWNER/REPO/issues, /repos/OWNER/REPO/contents/PATH, /search/code?q=...',
    parameters: obj({ path: str('נתיב ב-api.github.com, מתחיל ב-/') }),
    async run({ path: p }) {
      if (!p.startsWith('/')) return 'path חייב להתחיל ב-/'
      const res = await fetch('https://api.github.com' + p, {
        headers: { Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'helper' },
        signal: AbortSignal.timeout(30000),
      })
      const text = await res.text()
      return res.ok ? text.slice(0, 12000) : `GitHub HTTP ${res.status}: ${text.slice(0, 200)}`
    },
  },
  {
    name: 'vm_run',
    enabled: vmEnabled,
    description:
      'מריץ פקודת bash במחשב הלינוקס שלך: מכונה וירטואלית (Ubuntu 24.04) שהיא כולה שלך, עם sudo, אינטרנט ודיסק שנשמר בין הפעלות. בלי אישור. מתאים לכתיבה והרצה של קוד, סקריפטים, הורדות, התקנות (apt, pip) וניסויים. תיקיית העבודה שלך: ~/work. אין לה גישה לקבצים של המשתמש; כדי לשלוח לו קובץ שיצרת שם יש vm_send_file.',
    parameters: obj({ command: str('פקודת bash'), timeout_seconds: { type: 'number', description: 'מגבלת זמן בשניות (ברירת מחדל 120, מקסימום 900)' } }, ['command']),
    async run({ command, timeout_seconds }) {
      return vmRun(command, timeout_seconds)
    },
  },
  {
    name: 'vm_send_file',
    enabled: vmEnabled,
    description: 'שולח למשתמש בוואטסאפ קובץ ממחשב הלינוקס שלך (תמונה, PDF, קובץ טקסט וכו׳, עד 15MB).',
    parameters: obj({ path: str('נתיב מלא לקובץ במכונה'), caption: str('כיתוב קצר') }, ['path']),
    async run({ path: file, caption }, ctx) {
      await ctx.sendMedia({ ...(await vmFetch(file)), caption })
      return 'הקובץ נשלח למשתמש'
    },
  },
  {
    name: 'wake_pc',
    enabled: wakeEnabled,
    description: 'מדליק את המחשב של המשתמש מרחוק (Wake-on-LAN), בלי אישור. ל"תדליק את המחשב", "תעיר את המחשב". המחשב עולה בתוך כדקה.',
    parameters: obj({}),
    async run() {
      return wakePc()
    },
  },
  {
    name: 'open',
    enabled: () => pc.pcEnabled(),
    description: 'פותח משהו על המסך במחשב של המשתמש, מיד ובלי לבקש אישור: כתובת אינטרנט (https://...) או אחת מהאפליקציות: ' + Object.keys(APPS).join(', ') + '. ל"תפתח יוטיוב" / "תפתח לי את האתר של...". לחיפוש ביוטיוב בלי להפעיל: https://www.youtube.com/results?search_query=... כדי להפעיל שיר או סרטון יש play_youtube.',
    parameters: obj({ target: str('כתובת https מלאה, או שם אפליקציה מהרשימה') }),
    async run({ target }) {
      const what = APPS[String(target).trim().toLowerCase()] || String(target).trim()
      // Only a web address or a name from the fixed list gets through. Nothing here can run a command.
      const isUrl = /^https?:\/\/[^\s"'<>|&^]+$/i.test(what)
      if (!isUrl && !Object.values(APPS).includes(what)) return `אפשר לפתוח רק כתובת אינטרנט או אחת מאלה: ${Object.keys(APPS).join(', ')}. לכל דבר אחר יש run_command.`
      await pc.openOnScreen(what)
      return `נפתח: ${what}`
    },
  },
  {
    name: 'play_youtube',
    enabled: () => pc.pcEnabled(),
    description: 'מחפש ביוטיוב ומפעיל מיד את הסרטון הראשון בתוצאות, על המסך של המשתמש, בלי לבקש אישור. ל"תפעיל/תשים לי ביוטיוב X", "תפתח יוטיוב ותחפש X ותפעיל", שיר, זמר, קליפ. אם הוא רק רוצה לראות תוצאות בלי להפעיל, יש open עם כתובת חיפוש.',
    parameters: obj({ query: str('מה לחפש: שם שיר, זמר, סרטון') }),
    async run({ query }) {
      const found = await firstYouTubeVideo(query)
      // No video found: the results page is still better than nothing.
      const url = found ? `https://www.youtube.com/watch?v=${found.id}` : `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
      await pc.openOnScreen(url)
      return found ? `מתנגן: ${found.title || query} (${url})` : `לא מצאתי סרטון להפעלה, פתחתי את תוצאות החיפוש: ${url}`
    },
  },
  {
    name: 'run_command',
    enabled: computerEnabled,
    description: 'מריץ פקודת PowerShell על המחשב של המשתמש ומחזיר את הפלט. מוגבל ל-60 שניות.',
    parameters: obj({ command: str('פקודת PowerShell') }),
    async run({ command }, ctx) {
      if (!(await approved(ctx, `להריץ את הפקודה?\n\`\`\`${command}\`\`\``))) return 'המשתמש לא אישר את הפקודה'
      return pc.runCommand(command)
    },
  },
  {
    name: 'read_file',
    enabled: computerEnabled,
    description: 'קורא קובץ טקסט מהמחשב של המשתמש.',
    parameters: obj({ path: str('נתיב מלא לקובץ') }),
    async run({ path: p }, ctx) {
      const shown = process.platform === 'win32' ? path.resolve(p) : p
      if (!(await approved(ctx, `לקרוא את הקובץ ${shown}?`))) return 'המשתמש לא אישר'
      return pc.readTextFile(p)
    },
  },
  {
    name: 'write_file',
    enabled: computerEnabled,
    description: 'כותב קובץ טקסט במחשב של המשתמש (דורס קובץ קיים).',
    parameters: obj({ path: str('נתיב מלא לקובץ'), content: str('תוכן הקובץ') }),
    async run({ path: p, content }, ctx) {
      const where = pc.pcEnabled() && process.platform !== 'win32' ? p : path.resolve(p)
      const exists = process.platform === 'win32' && fs.existsSync(where)
      if (!(await approved(ctx, `${exists ? 'לדרוס' : 'ליצור'} את הקובץ ${where}? (${content.length} תווים)`))) return 'המשתמש לא אישר'
      return pc.writeTextFile(p, content)
    },
  },
  {
    name: 'pc_media',
    enabled: () => pc.pcEnabled(),
    description: 'שליטה במדיה ובווליום במחשב: ניגון/עצירה, שיר הבא, שיר קודם, השתקה, הגברה/הנמכה, או קביעת ווליום באחוזים (0-100). ל"תעצור", "שיר הבא", "תגביר", "ווליום 30", "השתק".',
    parameters: obj(
      {
        action: { type: 'string', enum: ['play_pause', 'next', 'previous', 'mute', 'volume_up', 'volume_down', 'set_volume'], description: 'הפעולה לביצוע' },
        level: { type: 'number', description: 'רמת ווליום באחוזים (0-100, רלוונטי רק עבור set_volume)' },
      },
      ['action']
    ),
    async run({ action, level }) {
      return pc.media(action, level)
    },
  },
  {
    name: 'pc_screenshot',
    enabled: () => pc.pcEnabled(),
    description: 'מצלם את מסך המחשב ושולח את התמונה למשתמש בוואטסאפ. ל"מה פתוח לי על המסך?", "תצלם את המסך".',
    parameters: obj({ caption: str('כיתוב שיופיע עם התמונה בוואטסאפ (אופציונלי)') }, []),
    async run({ caption = 'צילום מסך מהמחשב' }, ctx) {
      if (!ctx.sendMedia) return 'אין יכולת לשלוח מדיה בשיחה הזאת'
      const shot = await pc.screenshot(0)
      try {
        const buffer = fs.readFileSync(shot.file)
        await ctx.sendMedia({ buffer, mime: 'image/png', caption })
        return 'צילום המסך נשלח למשתמש בוואטסאפ'
      } finally {
        fs.rmSync(shot.file, { force: true })
      }
    },
  },
  {
    name: 'play_spotify',
    enabled: () => pc.pcEnabled(),
    description: 'מחפש ומפעיל שיר, אמן או פלייליסט בספוטיפיי במחשב. ל"תשים בספוטיפיי X", "תנגן בספוטיפיי עומר אדם".',
    parameters: obj({ query: str('שם השיר, האמן או הפלייליסט') }),
    async run({ query }) {
      return pc.playSpotify(query)
    },
  },
  {
    name: 'pc_launch_app',
    enabled: () => pc.pcEnabled(),
    description: 'פותח כל אפליקציה או תוכנה המותקנת במחשב לפי שם. ל"תפתח דיסקורד", "תפתח VS Code", "תפתח כרום".',
    parameters: obj({ name: str('שם האפליקציה או התוכנה') }),
    async run({ name }) {
      const launched = await pc.launchApp(name)
      return launched ? `האפליקציה "${launched}" נפתחה` : `לא נמצאה אפליקציה מותקנת בשם "${name}"`
    },
  },
  {
    name: 'pc_close_app',
    enabled: computerEnabled,
    description: 'סוגר אפליקציה או תוכנה שרצה במחשב. דורש אישור המשתמש בוואטסאפ. ל"תסגור את כרום".',
    parameters: obj({ name: str('שם התוכנה או התהליך לסגירה (למשל chrome, spotify, discord)') }),
    async run({ name }, ctx) {
      if (!(await approved(ctx, `לסגור את התוכנה ${name} במחשב?`))) return 'המשתמש לא אישר את סגירת התוכנה'
      return pc.closeApp(name)
    },
  },
  {
    name: 'pc_lock',
    enabled: () => pc.pcEnabled(),
    description: 'נועל את מסך המחשב מיד (Lock Workstation). ל"תנעל את המחשב".',
    parameters: obj({}),
    async run() {
      await pc.lock()
      return 'המחשב ננעל'
    },
  },
  {
    name: 'pc_unlock',
    enabled: () => pc.pcEnabled(),
    description: 'מבטל את נעילת המחשב: מדליק/מעיר את המסך, מעלה את מסך הנעילה לחלון הזנת הסיסמה ומקליד את הסיסמה השמורה בהגדרות (PC_UNLOCK_PASSWORD) עם Enter. אל תבקש את הסיסמה ואל תכתוב אותה. ל"תבטל נעילה", "תבטל את הנעילה", "תפתח את המחשב", "תפתח את הנעילה".',
    parameters: obj({ password: str('ריק = הסיסמה השמורה בהגדרות. "none" = רק להעלות את מסך ההתחברות בלי להקליד') }, []),
    async run({ password } = {}) {
      return pc.unlock(password || undefined)
    },
  },
  {
    name: 'pc_display_off',
    enabled: () => pc.pcEnabled(),
    description: 'מכבה את מסכי המחשב מיד (שולח את המסכים למצב שינה / Standby מבלי לכבות או להרדים את המחשב עצמו). מתבצע מיד ללא שום בקשת אישור! ל"תכבה מסכים", "תכבה את המסך", "כיבוי מסכים", "לילה טוב".',
    parameters: obj({
      lock: { type: 'boolean', description: 'האם לנעול את מסך המחשב במקביל לכיבוי המסך (ברירת מחדל: false)' },
    }),
    async run({ lock = false } = {}) {
      if (lock) await pc.lock()
      return pc.sleepMonitors()
    },
  },
  {
    name: 'pc_display_on',
    enabled: () => pc.pcEnabled(),
    description: 'מדליק/מעיר את מסכי המחשב ממצב כיבוי או שינה. ל"תדליק מסכים", "תדליק את המסך", "הדלקת מסכים".',
    parameters: obj({}),
    async run() {
      return pc.wakeMonitors()
    },
  },
  {
    name: 'pc_type',
    enabled: () => pc.pcEnabled(),
    description: 'מקליד טקסט, קוד PIN או סיסמה במחשב (בשדה הפעיל, במסך הנעילה, במסמך או בחיפוש). ל"תקליד 1234", "תקליד במחשב ...", "תקליד את הקוד ...".',
    parameters: obj(
      {
        text: str('הטקסט, קוד ה-PIN או הסיסמה להקלדה'),
        press_enter: { type: 'boolean', description: 'האם ללחוץ Enter בסיום ההקלדה (למשל לאישור קוד PIN או טופס)' },
      },
      ['text']
    ),
    async run({ text, press_enter = false }) {
      return pc.typeText(text, press_enter)
    },
  },
  {
    name: 'pc_press_key',
    enabled: () => pc.pcEnabled(),
    description: 'לוחץ על מקש או צירוף מקשים במקלדת של המחשב. מקשים אפשריים: enter, esc, tab, space, backspace, up, down, left, right, f1-f12, ctrl+c, ctrl+v, alt+f4. ל"תלחץ אנטר", "תלחץ Enter", "תלחץ esc".',
    parameters: obj({ key: str('שם המקש או הצירוף (למשל enter, esc, tab, space)') }),
    async run({ key }) {
      return pc.pressKey(key)
    },
  },
  {
    name: 'pc_status',
    enabled: () => pc.pcEnabled(),
    description: 'מציג את נתוני המחשב: אחוז שימוש במעבד, זיכרון RAM, סוללה, מקום פנוי בכוננים, והתוכנות שצורכות הכי הרבה משאבים. ל"מה מצב המחשב?", "למה המחשב איטי?".',
    parameters: obj({}),
    async run() {
      return pc.status()
    },
  },
  {
    name: 'pc_speak',
    enabled: () => pc.pcEnabled(),
    description: 'מקריא טקסט בקול ברמקולים של המחשב (בקול של ElevenLabs אם מוגדר, או בקול של Windows). ל"תגיד במחשב שהאוכל מוכן".',
    parameters: obj({ text: str('הטקסט להקראה ברמקולים') }),
    async run({ text }) {
      return pc.speakOnPc(text)
    },
  },
  {
    name: 'pc_timer',
    enabled: () => pc.pcEnabled(),
    description: 'מציג חלון טיימר ספירה לאחור מרחף על מסך המחשב שמשמיע צליל ומתריע בסיום. ל"טיימר 25 דקות ללמידה".',
    parameters: obj(
      {
        minutes: { type: 'number', description: 'משך הטיימר בדקות' },
        label: str('כותרת או נושא הטיימר (ברירת מחדל: טיימר)'),
      },
      ['minutes']
    ),
    run({ minutes, label = 'טיימר' }) {
      return pc.startTimer(minutes, label)
    },
  },
  {
    name: 'pc_clipboard_get',
    enabled: () => pc.pcEnabled(),
    description: 'קורא את הטקסט שנמצא כרגע בלוח ההעתקה (Clipboard) של המחשב.',
    parameters: obj({}),
    async run() {
      const text = await pc.getClipboard()
      return text ? `תוכן לוח ההעתקה:\n${text.slice(0, 4000)}` : 'לוח ההעתקה ריק'
    },
  },
  {
    name: 'pc_clipboard_set',
    enabled: () => pc.pcEnabled(),
    description: 'מעתיק טקסט ללוח ההעתקה (Clipboard) של המחשב. ל"תעתיק לי את הקישור הזה".',
    parameters: obj({ text: str('הטקסט להעתקה ללוח') }),
    async run({ text }) {
      await pc.setClipboard(text)
      return 'הטקסט הועתק ללוח ההעתקה במחשב'
    },
  },
  {
    name: 'pc_power',
    enabled: computerEnabled,
    description: 'כיבוי, הפעלה מחדש, מעבר למצב שינה, או ביטול כיבוי של המחשב כולו. דורש אישור בוואטסאפ (למעט ביטול). ל"תכבה את המחשב בעוד חצי שעה", "מצב שינה למחשב". שים לב: לכיבוי מסכים בלבד אל תשתמש בכלי זה, אלא ב-pc_display_off הפועל מיד ללא אישור.',
    parameters: obj(
      {
        action: { type: 'string', enum: ['shutdown', 'restart', 'sleep', 'cancel'], description: 'הפעולה: shutdown (כיבוי), restart (הפעלה מחדש), sleep (שינה), cancel (ביטול כיבוי)' },
        minutes: { type: 'number', description: 'בעוד כמה דקות לבצע (ברירת מחדל 0 = מיד)' },
      },
      ['action']
    ),
    async run({ action, minutes = 0 }, ctx) {
      if (action !== 'cancel') {
        const labels = { shutdown: 'כיבוי', restart: 'הפעלה מחדש של', sleep: 'העברת' }
        const prompt = `${labels[action] || action} המחשב ${minutes > 0 ? `בעוד ${minutes} דקות` : 'עכשיו'}?`
        if (!(await approved(ctx, prompt))) return 'המשתמש לא אישר את הפעולה'
      }
      return pc.power(action, minutes)
    },
  },
  {
    name: 'pc_find_files',
    enabled: () => pc.pcEnabled(),
    description: 'מחפש קבצים במחשב (שולחן עבודה, הורדות, מסמכים, תמונות וכו\') לפי שם או סיומת.',
    parameters: obj({ query: str('שם הקובץ או חלק ממנו'), folder: str('נתיב תיקייה ספציפית לחיפוש (אופציונלי)') }, ['query']),
    async run({ query, folder }) {
      return pc.findFiles(query, folder)
    },
  },
  {
    name: 'pc_organize_downloads',
    enabled: computerEnabled,
    description: 'מסדר אוטומטית את תיקיית ההורדות במחשב (Downloads) וממיין קבצים לתיקיות לפי סוג. דורש אישור המשתמש בוואטסאפ.',
    parameters: obj({}),
    async run(_args, ctx) {
      if (!(await approved(ctx, 'לסדר את תיקיית ההורדות במחשב לפי סוגי קבצים?'))) return 'המשתמש לא אישר'
      return pc.organizeDownloads()
    },
  },
  {
    name: 'pc_winget_search',
    enabled: computerEnabled,
    description: 'מחפש תוכנות זמינות להתקנה במחשב דרך מנהל החבילות של Windows (winget).',
    parameters: obj({ query: str('שם התוכנה לחיפוש') }),
    async run({ query }) {
      return pc.wingetSearch(query)
    },
  },
  {
    name: 'pc_winget_install',
    enabled: computerEnabled,
    description: 'מתקין תוכנה במחשב דרך מנהל החבילות של Windows (winget) לפי מזהה החבילה (Id). דורש אישור המשתמש בוואטסאפ.',
    parameters: obj({ id: str('מזהה החבילה המדויק מתוך pc_winget_search, למשל "VideoLAN.VLC"') }),
    async run({ id }, ctx) {
      if (!(await approved(ctx, `להתקין במחשב את "${id}" דרך winget?`))) return 'המשתמש לא אישר את ההתקנה'
      return pc.wingetInstall(id)
    },
  },
  {
    name: 'get_weather',
    description: 'מזג אוויר נוכחי ותחזית לימים הקרובים לעיר או אזור (בישראל ובעולם). ל"מה מזג האוויר בתל אביב?", "ירד גשם מחר?".',
    parameters: obj({ city: str('שם העיר או היישוב (בעברית או באנגלית)') }),
    async run({ city }) {
      return services.getWeather(city)
    },
  },
  {
    name: 'get_jewish_calendar',
    description: 'לוח שנה עברי, זמני כניסת ויציאת שבת, פרשת השבוע, חגים ותאריכים עבריים לפי עיר (ברירת מחדל ירושלים). ל"מתי נכנסת שבת?", "מה פרשת השבוע?", "מה התאריך העברי היום?".',
    parameters: obj({ city: str('שם העיר בישראל (ברירת מחדל: ירושלים)') }, []),
    async run({ city = 'ירושלים' }) {
      return services.getJewishCalendar(city)
    },
  },
  {
    name: 'get_currency_rate',
    description: 'שערי חליפין והמרת מטבעות (USD, EUR, ILS, GBP ועוד). ל"כמה זה 100 דולר בשקלים?", "מה שער היורו היום?".',
    parameters: obj(
      {
        from: str('מטבע מקור (למשל USD, EUR, ILS)'),
        to: str('מטבע יעד (למשל ILS, USD, EUR)'),
        amount: { type: 'number', description: 'הסכום להמרה (ברירת מחדל 1)' },
      },
      ['from', 'to']
    ),
    async run({ from, to, amount = 1 }) {
      return services.getCurrencyRate(from, to, amount)
    },
  },
  {
    name: 'pc_send_file',
    enabled: () => pc.pcEnabled(),
    description: 'שולח קובץ מהמחשב (מתיקיית Downloads, Desktop, Documents או נתיב ספציפי) ישירות אל המשתמש בוואטסאפ (מסמכי PDF, תמונות, שירים, סרטונים, קבצי טקסט או ארכיונים). ל"שלח לי את הקובץ X", "תשלח לי לווצאפ את ה-PDF שהורדתי".',
    parameters: obj({ path: str('נתיב מלא לקובץ או שם הקובץ לחיפוש במחשב'), caption: str('כיתוב שיופיע עם הקובץ בוואטסאפ (אופציונלי)') }, ['path']),
    async run({ path: filePath, caption }, ctx) {
      if (!ctx.sendMedia) return 'אין יכולת לשלוח מדיה בשיחה הזאת'
      const got = await pc.readUserFile(filePath)
      if (!got || got.error === 'missing') return `לא נמצא קובץ מתאים בשם "${filePath}" בתיקיות המשתמש`
      if (got.error === 'notfile') return `הנתיב "${got.path}" אינו קובץ`
      if (got.error === 'toobig') return `הקובץ גדול מדי לשליחה בוואטסאפ (${(got.size / (1024 * 1024)).toFixed(1)} MB, מקסימום 50MB)`
      await ctx.sendMedia({ buffer: got.data, mime: got.mime, caption: caption || got.name, name: got.name })
      return `הקובץ "${got.name}" (${(got.size / (1024 * 1024)).toFixed(2)} MB) נשלח בהצלחה לווצאפ!`
    },
  },
  {
    name: 'pc_webcam_snap',
    enabled: () => pc.pcEnabled(),
    description: 'מצלם תמונה בזמן אמת ממצלמת הרשת של המחשב (Webcam) ושולח אותה למשתמש בוואטסאפ. מאפשר בדיקת אבטחה בחדר כשהמשתמש רחוק מהמחשב. ל"תצלם מהמצלמת רשת", "צלם לי את החדר מהמחשב".',
    parameters: obj({ caption: str('כיתוב שיופיע עם התמונה (אופציונלי)'), device: str('שם מצלמה ספציפי אם יש יותר מאחת (אופציונלי)') }, []),
    async run({ caption = 'תמונה ממצלמת הרשת במחשב', device }, ctx) {
      if (!ctx.sendMedia) return 'אין יכולת לשלוח מדיה בשיחה הזאת'
      const snap = await pc.webcamSnap(device)
      try {
        const buffer = fs.readFileSync(snap.file)
        await ctx.sendMedia({ buffer, mime: 'image/jpeg', caption })
        return 'התמונה ממצלמת הרשת נשלחה למשתמש בוואטסאפ'
      } finally {
        fs.rmSync(snap.file, { force: true })
      }
    },
  },
  {
    name: 'pc_screen_record',
    enabled: () => pc.pcEnabled(),
    description: 'מקליט סרטון קצר מהמסך (2 עד 6 שניות) ושולח אותו כקובץ וידאו MP4 למשתמש בוואטסאפ. ל"תקליט לי את המסך לכמה שניות", "תראה לי מה קורה במסך בווידאו".',
    parameters: obj({ seconds: { type: 'number', description: 'מספר שניות להקלטה (2 עד 6, ברירת מחדל 3)' }, caption: str('כיתוב לווידאו (אופציונלי)') }, []),
    async run({ seconds = 3, caption = 'הקלטת מסך מהמחשב' }, ctx) {
      if (!ctx.sendMedia) return 'אין יכולת לשלוח מדיה בשיחה הזאת'
      const rec = await pc.screenRecord(seconds)
      try {
        const buffer = fs.readFileSync(rec.file)
        await ctx.sendMedia({ buffer, mime: 'video/mp4', caption, name: 'screen-recording.mp4' })
        return 'סרטון הקלטת המסך נשלח למשתמש בוואטסאפ'
      } finally {
        fs.rmSync(rec.file, { force: true })
      }
    },
  },
  {
    name: 'pc_top_processes',
    enabled: () => pc.pcEnabled(),
    description: 'מציג את התהליכים והתוכנות שצורכים הכי הרבה זיכרון (RAM) ומעבד (CPU) במחשב, עם אפשרות לסגור תהליך סורר. ל"מי טוחן לי את המחשב?", "אילו תוכנות לוקחות הכי הרבה RAM?", "תסגור את תהליך מספר X".',
    parameters: obj(
      {
        action: { type: 'string', enum: ['list', 'kill'], description: 'הפעולה: list (הצגת תהליכים מובילים) או kill (סגירת תהליך בכוח)' },
        target: str('מזהה תהליך (PID) או שם התוכנה לסגירה במקרה של action=kill'),
        count: { type: 'number', description: 'כמות התהליכים להצגה (ברירת מחדל 10)' },
      },
      ['action']
    ),
    async run({ action, target, count = 10 }, ctx) {
      if (action === 'kill') {
        if (!target) return 'נא לציין PID או שם תהליך לסגירה'
        if (!(await approved(ctx, `לסגור בכוח את התהליך ${target}?`))) return 'המשתמש לא אישר'
        return pc.killProcess(target)
      }
      const list = await pc.topProcesses(count)
      if (!list.length) return 'לא נמצאו תהליכים'
      const lines = ['*התוכנות והתהליכים המובילים בצריכת משאבים:*']
      for (const p of list) {
        const title = p.MainWindowTitle ? ` ("${p.MainWindowTitle.slice(0, 35)}")` : ''
        lines.push(`• *PID ${p.Id}* | ${p.ProcessName}${title}: ${p.MemoryMB} MB RAM | ${p.CpuSeconds}s CPU`)
      }
      return lines.join('\n')
    },
  },
  {
    name: 'israel_red_alert',
    description: 'בדיקת התרעות צבע אדום ואזעקות בזמן אמת והיסטוריה לפיקוד העורף בישראל (אפשרות לסינון לפי יישוב, עיר או אזור). ל"היו אזעקות היום?", "יש צבע אדום עכשיו?", "היה צבע אדום בחיפה?".',
    parameters: obj({ city: str('שם עיר או יישוב לסינון (למשל חיפה, קריית שמונה, גליל). ריק = כל הארץ'), days: { type: 'number', description: 'כמה ימים אחורה לבדוק (1 = היום, עד 3 ימים)' } }, []),
    async run({ city, days = 1 }) {
      return services.getRedAlerts(city, days)
    },
  },
  {
    name: 'track_package',
    description: 'מעקב אחר חבילות ומשלוחים לפי מספר מעקב (דואר ישראל, AliExpress / Cainiao, DHL, FedEx, UPS ועוד). ל"איפה החבילה שלי X?", "תבדוק מספר מעקב RR123456789IL".',
    parameters: obj({ tracking_number: str('מספר המעקב של החבילה') }, ['tracking_number']),
    async run({ tracking_number }) {
      return services.trackPackage(tracking_number)
    },
  },
  {
    name: 'israel_transit',
    description: 'מידע על קווי אוטובוס ומסלולי תחבורה ציבורית בישראל לפי מספר קו ועיר (אגד, דן, מטרופולין, אלקטרה אפיקים וכו\'). ל"איפה עובר קו 16 בפתח תקווה?", "מסלול קו 1".',
    parameters: obj({ line: str('מספר הקו (למשל 16, 1, 480)'), city: str('עיר או אזור לסינון (אופציונלי)') }, ['line']),
    async run({ line, city }) {
      return services.getTransitInfo(line, city)
    },
  },
  {
    name: 'pc_browser_tabs',
    enabled: () => pc.pcEnabled(),
    description: 'ניהול לשוניות בדפדפן (Chrome, Edge וכו\'): הצגת רשימת הלשוניות הפתוחות עם קישורים ישירים לטלפון, פתיחת לשונית חדשה, סגירת לשונית (או הלשונית הפעילה), מעבר בין לשוניות ושחזור לשונית שנסגרה. ל"איזה טאבים פתוחים לי במחשב?", "תסגור את הלשונית של יוטיוב", "פתח לשונית חדשה".',
    parameters: obj(
      {
        action: {
          type: 'string',
          enum: ['list', 'close', 'open', 'activate', 'reopen', 'next', 'prev'],
          description: 'הפעולה: list (רשימת לשוניות), close (סגירת לשונית או הלשונית הפעילה), open (פתיחת לשונית חדשה), activate (מעבר ללשונית), reopen (שחזור לשונית אחרונה שנסגרה), next (לשונית הבאה), prev (לשונית קודמת)',
        },
        target: str('כותרת, כתובת URL או מזהה לשונית לסגירה או מעבר (עבור close/activate)'),
        url: str('כתובת אתר לפתיחה (עבור action=open)'),
      },
      ['action']
    ),
    async run({ action, target, url }) {
      if (action === 'list') {
        const tabs = await pc.getBrowserTabs()
        if (!tabs.length) return 'לא זוהו לשוניות בדפדפן מחובר. ניתן לפתוח לשונית חדשה (open) או לסגור את הנוכחית (close).'
        const lines = [`🌐 *לשוניות פתוחות בדפדפן (סה"כ ${tabs.length}):*`]
        for (const t of tabs) {
          lines.push(`• *${t.title}*\n  ${t.url}`)
        }
        return lines.join('\n')
      }
      if (action === 'close') return pc.closeBrowserTab(target)
      if (action === 'open') return pc.openBrowserTab(url)
      if (action === 'activate') return pc.activateBrowserTab(target)
      if (action === 'reopen') {
        await pc.act({ type: 'key', keys: 'ctrl+shift+t' })
        return 'נשלחה פקודה לשחזור הלשונית האחרונה שנסגרה (Ctrl+Shift+T)'
      }
      if (action === 'next') {
        await pc.act({ type: 'key', keys: 'ctrl+tab' })
        return 'מעבר ללשונית הבאה (Ctrl+Tab)'
      }
      if (action === 'prev') {
        await pc.act({ type: 'key', keys: 'ctrl+shift+tab' })
        return 'מעבר ללשונית הקודמת (Ctrl+Shift+Tab)'
      }
      throw new Error(`פעולה לא מוכרת: ${action}`)
    },
  },
  {
    name: 'google_home_devices',
    description: 'מציג את רשימת מכשירי הבית החכם המחוברים ב-Google Home ואת מצבם הנוכחי (דלוק/כבוי) עבור אורות, רמקולים וכו\'. ל"מה מצב המכשירים בבית?", "איזה אורות דלוקים?", "מה מחובר בגוגל הום?".',
    parameters: obj({}),
    async run() {
      return googleHome.getHomeDevices()
    },
  },
  {
    name: 'google_home_control',
    description: 'שליטה במכשירי בית חכם דרך Google Home: הדלקה, כיבוי או החלפת מצב (toggle) של אורות, רמקולים ומכשירים חכמים. ל"תדליק את האור בחדר", "תכבה את כל האורות", "תפעיל את הרמקול בסלון".',
    parameters: obj(
      {
        device: str('שם המכשיר, סוגו או החדר (למשל: "חדר שלי", "אורות", "סלון", "Living Room", "Lounge", "כל האורות")'),
        action: {
          type: 'string',
          enum: ['on', 'off', 'toggle'],
          description: 'פעולה לביצוע: on (הדלקה), off (כיבוי), toggle (החלפת מצב)',
        },
      },
      ['device', 'action']
    ),
    async run({ device, action }) {
      return googleHome.controlHomeDevice(device, action)
    },
  },
  {
    name: 'use_computer',
    enabled: computerEnabled,
    description: 'אוטומציה מלאה של עכבר ומקלדת (Computer Use): מפעיל סוכן שמסתכל על צילומי מסך של המחשב ומבצע סדרת פעולות בעכבר ובמקלדת כדי להשיג מטרה שהוגדרה. דורש אישור המשתמש בוואטסאפ.',
    parameters: obj({ goal: str('הוראה ברורה ומפורטת של מה לבצע על המחשב') }),
    async run({ goal }, ctx) {
      if (!(await approved(ctx, `להפעיל שליטה אוטונומית בעכבר ובמקלדת לביצוע:\n"${goal}"?`))) return 'המשתמש לא אישר'
      return useComputer(goal, ctx)
    },
  },
  {
    name: 'run_errand',
    enabled: errandBrowserEnabled,
    description: 'מבצע כל משימה פתוחה באינטרנט בדפדפן הסוכן שלך (חלון נפרד עם פרופיל משלו, לא המחשב של המשתמש): להזמין, לקנות, לקבוע תור, להירשם, למלא טופס, למצוא ולהשוות עד עגלה. הסוכן רואה את המסך ומחליט כל צעד בעצמו. לפני תשלום, הזמנה, שליחה בשם המשתמש או מחיקה הוא עוצר ושולח בקשת אישור עם צילום מסך בעצמו, אל תשאל לפני. מחזיר DONE, NEED_USER (חסר משהו: התחברות, CAPTCHA, פרט חסר), DENIED או FAIL. אחרי NEED_USER ותשובה של המשתמש, קרא שוב עם אותה מטרה והפרט החדש.',
    parameters: obj(
      {
        goal: str('המטרה במילים של המשתמש, מלאה וברורה. בלי הוראות צעד-צעד ובלי לבחור אתר אם הוא לא ביקש.'),
        budget: str('תקציב מקסימלי עם מטבע, אם נאמר'),
        deadline: str('עד מתי / מועד מסירה או תור, אם נאמר'),
        location: str('כתובת משלוח / עיר: מה שהמשתמש כתב בהודעה, ואם לא כתב - המיקום השמור שלו'),
        details: str('פרטים שמותר להזין בטופס (שם, כתובת, טלפון, נמען) כפי שהמשתמש מסר או שמורים בזיכרון. אף פעם לא סיסמה, קוד או כרטיס.'),
      },
      ['goal']
    ),
    async run({ goal, budget, deadline, location, details }, ctx) {
      const constraints = [budget && `budget: ${budget}`, deadline && `deadline: ${deadline}`, location && `location: ${location}`, details && `details the user allowed: ${details}`].filter(Boolean).join('; ')
      const result = await runErrand(goal, constraints, ctx)
      return `${result}\n[Reply in one short Hebrew line, addressing him in masculine singular (no "/י"). DONE: what happened; "הזמנתי"/"שילמתי" only if the summary says the site showed success. NEED_USER: exactly what he must do (sign in or solve it in the agent window on the PC, or send the missing detail), then wait. DENIED: nothing was paid or sent. FAIL: the honest reason and what he can do next.]`
    },
  },
  {
    name: 'run_on_phone',
    enabled: phoneAppConnected,
    description: 'מבצע כל משימה בטלפון של המשתמש מקצה לקצה, דרך אפליקציית HELPER (שירות נגישות): "תזמין לי מונית ב-Gett הביתה", "תשלח לאבא בוואטסאפ שאני בדרך", "תדליק שעון מעורר ל-7", "תנווט הביתה", "מה ההתראות שלי". הסוכן קורא את המסך ובוחר כל צעד בעצמו, ומשתמש בקיצורים ישירים (שעון מעורר, טיימר, יומן, ניווט, חיוג) כשיש. שעון מעורר, פתיחת אפליקציה וקריאת המסך רצים בלי אישור בוואטסאפ. לפני תשלום, הזמנה, שליחה בשמו, שיחה או מחיקה הוא שולח בעצמו בקשת אישור עם צילום מסך, אל תשאל לפני. מחזיר DONE, NEED_USER, DENIED, STOPPED או FAIL. כשהאפליקציה מחוברת זה הכלי היחיד לטלפון; כלי ה-phone_* של ADB כבויים.',
    parameters: obj(
      {
        goal: str('המטרה במילים של המשתמש, מלאה. בלי הוראות צעד-צעד.'),
        details: str('פרטים שמותר להשתמש בהם: נמען ומספר, כתובת, שעה. אף פעם לא סיסמה, קוד או כרטיס.'),
      },
      ['goal']
    ),
    async run({ goal, details }, ctx) {
      const result = await runOnPhone(goal, details ? `details the user allowed: ${details}` : '', ctx)
      return `${result}\n[Reply in one short Hebrew line, masculine singular. DONE: what happened, "שלחתי"/"הזמנתי" only if the summary says the screen showed it. NEED_USER: exactly what he must do on the phone. DENIED or STOPPED: nothing was sent or paid. FAIL: the honest reason and what he can do next.]`
    },
  },
  {
    name: 'compare_prices',
    enabled: errandBrowserEnabled,
    description: 'סקר שוק בלבד, בלי סל ובלי קופה: מוצא את האפשרות הזולה ביותר לאותו דגם. מתחיל באתר השוואת מחירים (זאפ לישראל, וגם Google Shopping), בודק 3-5 חנויות, ומשווה מחיר סופי כולל משלוח, אמינות מוכר וזמן אספקה. מחזיר רשימה מדורגת בעברית עם מחירים וקישורים. אם המשתמש ביקש גם להזמין, אחרי הרשימה קוראים ל-run_errand.',
    parameters: obj(
      {
        goal: str('מה להשוות, במילים של המשתמש, כולל הדגם אם נאמר'),
        budget: str('תקציב מקסימלי עם מטבע, אם נאמר'),
        location: str('עיר או כתובת למשלוח, אם רלוונטי'),
      },
      ['goal']
    ),
    async run({ goal, budget, location }, ctx) {
      const constraints = [budget && `budget: ${budget}`, location && `location: ${location}`, 'survey only: compare prices, do not add to cart or check out'].filter(Boolean).join('; ')
      const result = await runErrand(goal, constraints, ctx, { survey: true })
      return `${result}\n[Reply in Hebrew with the ranked list: shop, total including shipping, delivery, link. Do not say you ordered or paid.]`
    },
  },
]

const isOn = (t) => !t.enabled || t.enabled()

tools.push(...memoryTools)
tools.push(...phoneTools)

// The extended toolkit is not sent to the model on every request: that would cost thousands of tokens and make the
// model choose worse. It sees one tool, tool_search, and unlocks the few tools it needs for the turn.
tools.push({
  name: 'tool_search',
  get description() {
    return `מחפש כלים נוספים (${extendedTools.length}) ופותח אותם לשימוש. תחומים: ${categories.map((c) => `${c.category} (${c.blurb})`).join(', ')}. קרא לזה כשאין כלי מתאים, ואז השתמש בכלי שנפתח.`
  },
  parameters: obj({ query: str('מה צריך לעשות, או שם תחום') }),
  run({ query }, ctx) {
    const found = searchTools(query, extendedTools.filter(isOn))
    if (!found.length) return 'לא נמצא כלי מתאים'
    if (ctx) {
      ctx.unlocked ??= new Set()
      for (const t of found) ctx.unlocked.add(t.name)
    }
    return `נפתחו ${found.length} כלים, אפשר להשתמש בהם עכשיו:\n${found.map((t) => `- ${t.name}: ${t.description}`).join('\n')}`
  },
})

// `unlocked` is the set of extended tool names opened by tool_search in the current turn.
export const activeTools = (unlocked) => [
  ...tools.filter(isOn),
  ...(unlocked ? extendedTools.filter((t) => unlocked.has(t.name) && isOn(t)) : []),
]
export const allTools = () => [...tools.filter(isOn), ...extendedTools.filter(isOn)]

// Light mode: the same tools described in a few English words. Every request carries all the tool definitions,
// and Hebrew costs two to three times the tokens of English, so on a small per-minute budget this is what makes
// a second and third model call fit in the same minute.
const BRIEF = {
  remember: 'Save a lasting fact about the user.',
  forget: 'Delete a remembered fact by id.',
  add_reminder: 'Send the user a fixed text at a set time.',
  list_reminders: 'List reminders.',
  cancel_reminder: 'Cancel a reminder by id.',
  schedule_task: 'Run yourself later with an instruction (a real check, not a fixed text). For recurring checks and following up on open things.',
  list_tasks: 'List scheduled tasks.',
  cancel_task: 'Cancel a scheduled task by id.',
  send_whatsapp: 'Send the user a WhatsApp message right now. For when he is talking to you from elsewhere (Discord) and wants something on WhatsApp. A future reminder is add_reminder, which also arrives on WhatsApp.',
  study_plan: 'Build a study plan for an exam (topics over the days left, last day review). Show the draft; add_to_calendar=true adds it after his approval.',
  week_ahead: 'Next week (Sun-Sat): saved exams, Classroom deadlines, calendar. Also sent on its own Saturday evening.',
  get_timetable: 'The user\'s school timetable for a day from Webtop: time, lesson, subject, room, teacher, cancellations. day = today, tomorrow, Hebrew/English weekday or YYYY-MM-DD (this week only). A reminder before each lesson is already sent automatically.',
  send_whatsapp_to: 'Send a WhatsApp message in the user\'s name to someone else (a contact name or a number). Only when he explicitly asked to send it; "draft" means draft only. He approves the exact recipient and text first.',
  send_discord: 'Send the user a private Discord message through his Discord bot; speak=true also says it aloud in the voice room. For when he is on WhatsApp and wants something on Discord.',
  voice_mode: 'always = reply as voice notes to everything ("talk to me"); match = voice only when the user sends voice.',
  react: 'Put one emoji on the user\'s last message; can replace a text reply.',
  get_news: 'Recent news headlines (Israel and world) with time and source.',
  web_search: 'Search the web: titles, links, snippets.',
  ask_gemini: 'Ask Google Gemini a question and return its answer. Only when the user asked to ask Gemini.',
  fetch_page: 'Read the text of a web page.',
  add_watcher: 'Quietly watch a web page and notify only on a change or when a condition is met (price, stock, results).',
  list_watchers: 'List watches with status and value history.',
  remove_watcher: 'Stop a watch by id.',
  check_mail: 'Latest emails from the connected IMAP mailboxes.',
  get_calendar: 'Upcoming calendar events.',
  gmail_search: 'Search Gmail with Gmail query syntax; empty query = latest. Returns ids for gmail_read.',
  gmail_read: 'Read one full email by id.',
  gmail_send: 'Send an email as the user. The user is shown the full text and must approve.',
  calendar_add: 'Add an event to Google Calendar.',
  tasks_list: 'Open Google Tasks.',
  tasks_add: 'Add a Google Task.',
  classroom_assignments: 'Google Classroom assignments: course, title, due date, submitted or not.',
  drive_search: 'Search Google Drive by content or name; returns ids for drive_read.',
  drive_read: 'Read a Docs, Sheets, Slides or text file from Drive.',
  create_image: 'Generate an image from an English description and send it to the user.',
  create_video: 'Generate a short video (minutes, costly; user must approve). Sent when ready.',
  create_music: 'Generate a music clip (user must approve) and send it.',
  create_sound: 'Generate a short sound effect and send it.',
  call_me: 'Phone the user now and connect him to the voice assistant. Only when he explicitly asked you to call him.',
  github_get: 'Read-only GitHub API call, e.g. /user/repos, /repos/OWNER/REPO/issues.',
  vm_run: 'Run a bash command on YOUR OWN Linux machine (Ubuntu 24.04 VM, sudo, internet, persistent disk, work dir ~/work). No approval needed. For writing and running code, scripts, downloads, installs. It cannot see the user\'s files.',
  vm_send_file: 'Send the user a file from your Linux machine (image, PDF, text; up to 15MB).',
  play_youtube: 'Search YouTube and start playing the first video right away on the user\'s screen, no approval needed. For "play X", "put on X on YouTube", "open YouTube, search X and play".',
  wake_pc: 'Turn on the user\'s PC remotely (Wake-on-LAN), no approval needed. It boots within about a minute.',
  open: 'Open a web address (https://...) or a named app on the user\'s screen, at once, no approval needed. Names: youtube, google, gmail, classroom, calendar, drive, whatsapp, spotify, calculator, settings. YouTube search: https://www.youtube.com/results?search_query=...',
  run_command: 'Run a PowerShell command on the user\'s computer (60s limit).',
  read_file: 'Read a text file from the user\'s computer.',
  write_file: 'Write a text file on the user\'s computer (overwrites).',
  pc_media: 'Control PC media and volume: play_pause, next, previous, mute, volume_up, volume_down, set_volume 0-100.',
  pc_screenshot: 'Take a screenshot of the PC screen and send the image to WhatsApp.',
  play_spotify: 'Search and play song, artist, or playlist on Spotify.',
  pc_launch_app: 'Launch any installed PC application by name.',
  pc_close_app: 'Close a running application on the PC (requires user approval).',
  pc_lock: 'Lock the PC workstation screen.',
  pc_unlock: 'Wake the screen, lift the lock screen, and enter the saved password (PC_UNLOCK_PASSWORD).',
  pc_display_off: 'Turn off PC monitors/screens immediately into standby without sleeping the PC.',
  pc_display_on: 'Turn on / wake PC monitors/screens immediately.',
  pc_type: 'Type text or a PIN into the active window or lock screen; press_enter optionally presses Enter.',
  pc_press_key: 'Press a keyboard key or combination (e.g. enter, esc, tab, space).',
  pc_status: 'PC system status: CPU, RAM, battery, disks, and top processes.',
  pc_speak: 'Speak text aloud on the PC speakers.',
  pc_timer: 'Display a floating countdown timer on the screen with sound alert on completion.',
  pc_clipboard_get: 'Read text currently copied in PC clipboard.',
  pc_clipboard_set: 'Copy text to the PC clipboard.',
  pc_power: 'Shutdown, restart, sleep, or cancel shutdown for the PC (requires user approval).',
  pc_find_files: 'Search for files across Desktop, Documents, Downloads, etc. by name.',
  pc_organize_downloads: 'Organize loose files in Downloads into subfolders by type (requires user approval).',
  pc_winget_search: 'Search software in Windows Package Manager (winget).',
  pc_winget_install: 'Install software via winget by package ID (requires user approval).',
  pc_send_file: 'Send a file from the user PC (Downloads, Documents, Desktop) to WhatsApp.',
  pc_webcam_snap: 'Take a snapshot from the PC webcam and send the photo to WhatsApp.',
  pc_screen_record: 'Record a short screen video clip (2-6s) and send it to WhatsApp.',
  pc_top_processes: 'List top CPU/RAM consuming processes or kill a specific process.',
  israel_red_alert: 'Real-time and recent Pikud HaOref Red Alert siren notifications for Israel / city.',
  track_package: 'Track package/shipment status across carriers (Israel Post, Cainiao, DHL, FedEx, UPS).',
  israel_transit: 'Information on Israeli bus lines and routes by line number and city.',
  pc_browser_tabs: 'Manage browser tabs (list, open, close, activate, reopen, next, prev) on Chrome/Edge.',
  get_weather: 'Current weather and forecast for any city (Israel and global).',
  get_jewish_calendar: 'Hebrew calendar date, Shabbat candle lighting and Havdalah times, Parasha, holidays.',
  get_currency_rate: 'Currency conversion and live exchange rates (USD, EUR, ILS, etc.).',
  phone_screenshot: 'Photograph the Android phone screen. The image comes back so you can see it.',
  phone_ui_dump: 'Read the phone screen as text with tappable element centers.',
  phone_tap: 'Tap the phone at x,y or on an element by its text. Asks for approval.',
  phone_swipe: 'Swipe the phone screen (up/down/left/right or two points). Asks for approval.',
  phone_type_text: 'Type into the focused phone field. Hebrew goes through the clipboard. Asks for approval.',
  phone_key: 'Press back, home, recents, enter, volume or power on the phone. Asks for approval.',
  phone_open_app: 'Open a phone app by name or package. Asks for approval.',
  phone_list_apps: 'List installed phone package names.',
  phone_notifications: 'Summarize notifications currently shown on the phone.',
  phone_battery: 'Phone battery level and charging state.',
  phone_shell: 'One adb shell command. No chaining. Factory reset, rm, uninstall and settings put need an explicit yes.',
  google_home_devices: 'List smart home devices and their state (on/off) from Google Home.',
  google_home_control: 'Turn on, turn off, or toggle smart home devices (lights, speakers) via Google Home.',
  use_computer: 'Autonomous mouse and keyboard agent to operate the PC step by step (requires user approval).',
  run_on_phone: 'Do any task on the user\'s phone end to end through the HELPER app: order a ride, send a WhatsApp, set an alarm, navigate, read notifications. It picks every step itself. Setting an alarm, opening an app or reading the screen does not ask. It asks him with a screenshot only before paying, ordering, sending, calling or deleting; do not ask first. When the app is connected this is the only phone tool. Returns DONE, NEED_USER, DENIED, STOPPED or FAIL.',
  run_errand: 'Order, book or buy in your own browser. For the cheapest product, compare_prices first unless he already asked to order. Before paying or ordering it asks him with a screenshot. Prefer PayPal; he has a debit/prepaid card only, no credit card. Returns DONE, NEED_USER, DENIED or FAIL.',
  compare_prices: 'Market survey only: cheapest exact model. Start at zap.co.il (Israel) and Google Shopping, then 3-5 shops. Compare total INCLUDING shipping, seller and delivery. Ranked Hebrew list with prices and links. Never a cart or checkout.',
}

// Parameter notes are dropped too, except the ones that fix a format the model could not guess.
function briefParameters(parameters) {
  const properties = Object.fromEntries(
    Object.entries(parameters.properties).map(([name, p]) => {
      const { description, ...rest } = p
      if (name === 'day' && /tomorrow|weekday|יום/.test(description || '')) {
        return [name, { ...rest, description: 'today, tomorrow, Hebrew/English weekday or YYYY-MM-DD' }]
      }
      if (/YYYY-MM-DDTHH:MM/.test(description || '')) return [name, { ...rest, description: 'local time, YYYY-MM-DDTHH:MM' }]
      if (/YYYY-MM-DD/.test(description || '')) return [name, { ...rest, description: 'YYYY-MM-DD' }]
      return [name, rest]
    })
  )
  return { ...parameters, properties }
}

// The tool list in the shape the model API takes.
export const toolDefs = (list = activeTools()) =>
  list.map((t) => ({
    type: 'function',
    function: config.llm.light && BRIEF[t.name] ? { name: t.name, description: BRIEF[t.name], parameters: briefParameters(t.parameters) } : { name: t.name, description: t.description, parameters: t.parameters },
  }))
