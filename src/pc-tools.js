// The user's own computer: open, media, files, apps, screen, power. Locally these run in this process; in the cloud
// they go through the home bridge (src/pc-bridge.js), and only while COMPUTER_MODE is on.
import { firstYouTubeVideo } from './youtube.js'
import fs from 'node:fs'
import path from 'node:path'
import { wakeEnabled, wakePc } from './wake.js'
import * as pc from './pc.js'
import { str, obj, computerEnabled, approved } from './tool-helpers.js'

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

// Kept here for older imports; the search itself lives in src/youtube.js (Data API first, results page after).
export { firstYouTubeVideo }

export const pcTools = [
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
]
