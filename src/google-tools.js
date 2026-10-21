// Google tools: mail, calendar, tasks, Classroom, Drive, and the study plan that writes to the calendar.
// Read tools cover every connected account; write tools refuse read-only accounts in code (writable()).
import { config, mailEnabled } from './config.js'
import { recentMail } from './mail.js'
import { upcomingEvents, calendarOn } from './calendar.js'
import * as google from './google.js'
import { planStudy, planText, localStamp, weekAhead } from './study.js'
import { str, obj, ACCOUNT, one, writable, perAccount } from './tool-helpers.js'

export const googleTools = [
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
]
