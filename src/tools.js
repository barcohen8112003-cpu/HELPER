import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { state, save, newId } from './store.js'
import { webSearch, fetchPage } from './web.js'
import * as google from './google.js'
import * as create from './create.js'
import { getNews, formatNews } from './news.js'
import { canSpeak } from './media.js'
import { vmEnabled, vmRun, vmFetch } from './vm.js'
import { checkWatcher } from './watchers.js'
import { voiceEnabled, callOwner } from './voice.js'
import { sessionEnabled } from './session.js'
import { parseTimetableDay, timetableText } from './lessons.js'
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
import { googleTools } from './google-tools.js'
import { pcTools, firstYouTubeVideo } from './pc-tools.js'
import { str, obj, computerEnabled, approved } from './tool-helpers.js'
import { claudeCodeEnabled, runClaudeCode, zipFiles, projectSlug } from './claude-code.js'

// The Discord bot counts as linked once it has called the bridge within the last day.
const discordLinked = () => Date.now() - (state.bridgeSeenAt || 0) < 24 * 3600000

// Each scheduled task is a full model run, so the list is kept short.
const MAX_TASKS = 20

// Google tools live in google-tools.js and the computer's in pc-tools.js; both join this list below.
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
    name: 'claude_code',
    enabled: () => true,
    description: 'מעביר ל-Claude Code (במנוי Claude של המשתמש) משימת בנייה: אתר, דף נחיתה, משחק בדפדפן, סקריפט. רץ ברקע, והקבצים מגיעים בוואטסאפ כ-zip (ו-index.html בנפרד לאתר). לשינוי בפרויקט קיים, אותו project. כשהמשתמש מבקש "ש-Claude יבנה" או אתר/אפליקציה שלמים.',
    parameters: obj(
      {
        title: str('שם קצר בעברית, למשל "אתר לחנות פרחים"'),
        task: str('הבקשה המלאה עם כל הפרטים מהשיחה: מה לבנות, תוכן, צבעים, שפה. Claude Code לא רואה את השיחה.'),
        project: str('שם הפרויקט, כדי להמשיך לעבוד על אותם קבצים. ריק = לפי title'),
      },
      ['title', 'task']
    ),
    async run({ title, task, project }, ctx) {
      if (!claudeCodeEnabled()) return 'Claude Code עוד לא מחובר. הסבר למשתמש: להריץ פעם אחת במחשב כלשהו "claude setup-token" (אחרי התקנה: npm i -g @anthropic-ai/claude-code), ולהדביק את הטוקן באתר ההגדרות בכרטיס Claude Code.'
      if (!ctx.background) return 'אי אפשר להתחיל את זה מכאן.'
      const name = project || title
      if (!(await ctx.confirm(`להעביר ל-Claude Code (על חשבון המנוי שלך) את "${title}"?\n${task}`))) return 'המשתמש לא אישר. שום דבר לא נשלח ל-Claude Code.'
      const job = ctx.background(title, task, async (signal, setStep) => {
        const done = await runClaudeCode(task, { project: name, signal, setStep })
        if (done.files.length) {
          await ctx.sendMedia({ buffer: zipFiles(done.dir, done.files), mime: 'application/zip', name: `${projectSlug(name)}.zip`, caption: `${done.files.length} קבצים` })
          if (done.files.includes('index.html')) await ctx.sendMedia({ buffer: fs.readFileSync(path.join(done.dir, 'index.html')), mime: 'text/html', name: 'index.html', caption: 'לפתוח בדפדפן' })
        }
        return done.summary || 'סיימתי.'
      })
      return `"${job.title}" עבר ל-Claude Code ורץ ברקע. אמור למשתמש בשורה אחת שהתחיל ושהקבצים יגיעו כאן.`
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

export { firstYouTubeVideo }

const isOn = (t) => !t.enabled || t.enabled()

tools.push(...googleTools)
tools.push(...pcTools)
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
  claude_code: 'Hand a build job (website, landing page, browser game, script) to Claude Code on the user\'s Claude plan. Runs in the background; files arrive as a zip.',
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
