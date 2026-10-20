// Tools the model uses to drive the phone. Reads are allowed under the default PHONE_MODE=ask.
// Anything that changes the phone asks in WhatsApp first. Dangerous shell commands always ask.
import {
  phoneEnabled,
  gatePhone,
  classifyShell,
  phoneScreenshot,
  phoneUiDump,
  phoneTap,
  phoneSwipe,
  phoneTypeText,
  phoneKey,
  phoneOpenApp,
  phoneListApps,
  phoneNotifications,
  phoneBattery,
  phoneShell,
} from './phone.js'

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required })

const DENIED = 'הפקודה נחסמה: אין שרשור פקודות, ואין איפוס, מחיקה, הסרת אפליקציה או שינוי הגדרות מערכת בצורה כזאת.'

export const phoneTools = [
  {
    name: 'phone_screenshot',
    enabled: phoneEnabled,
    description: 'מצלם את מסך הטלפון. התמונה חוזרת אליך כדי שתראה מה על המסך, ונשלחת גם למשתמש. ל"מה יש לי בטלפון", "תצלם את מסך הטלפון", "תשלוט לי בטלפון" מתחילים מכאן או מ-phone_ui_dump.',
    parameters: obj({}, []),
    async run(_args, ctx) {
      const gate = await gatePhone(ctx, 'read', 'לצלם את מסך הטלפון?')
      if (!gate.allowed) return gate.text
      const shot = await phoneScreenshot()
      if (ctx?.sendMedia) await ctx.sendMedia({ buffer: shot.buffer, mime: 'image/png', caption: 'מסך הטלפון' }).catch(() => {})
      const text = `צילום מסך ${shot.width}x${shot.height}. קואורדינטות ל-phone_tap הן בפיקסלים של התמונה הזו.`
      if (shot.buffer.length > 900000) return `${text} התמונה גדולה מדי לצירוף לכאן ונשלחה למשתמש. למיקומי לחיצה השתמש ב-phone_ui_dump.`
      return { text, vision: `data:image/png;base64,${shot.buffer.toString('base64')}` }
    },
  },
  {
    name: 'phone_ui_dump',
    enabled: phoneEnabled,
    description: 'קורא את מסך הטלפון כטקסט: רכיבים לחיצים, הטקסט שלהם, ומרכז הגבולות (x,y) ל-phone_tap. עדיף על ניחוש קואורדינטות מצילום.',
    parameters: obj({}, []),
    async run(_args, ctx) {
      const gate = await gatePhone(ctx, 'read', 'לקרוא את רכיבי המסך בטלפון?')
      if (!gate.allowed) return gate.text
      return phoneUiDump()
    },
  },
  {
    name: 'phone_tap',
    enabled: phoneEnabled,
    description: 'לוחץ על המסך. x,y בפיקסלים של הצילום, או text עם הטקסט של הרכיב (מחפש אותו במסך ולוחץ במרכז).',
    parameters: obj({ x: num('פיקסל אופקי'), y: num('פיקסל אנכי'), text: str('טקסט של הרכיב ללחוץ עליו, במקום קואורדינטות') }, []),
    async run(args, ctx) {
      const gate = await gatePhone(ctx, 'write', args.text ? `ללחוץ בטלפון על "${args.text}"?` : `ללחוץ בטלפון על ${args.x},${args.y}?`)
      if (!gate.allowed) return gate.text
      return phoneTap(args)
    },
  },
  {
    name: 'phone_swipe',
    enabled: phoneEnabled,
    description: 'מחליק על המסך. direction: up, down, left, right (גלילה). או ארבע נקודות x1,y1,x2,y2.',
    parameters: obj(
      {
        direction: str('up, down, left או right'),
        x1: num('התחלה x'),
        y1: num('התחלה y'),
        x2: num('סיום x'),
        y2: num('סיום y'),
      },
      [],
    ),
    async run(args, ctx) {
      const gate = await gatePhone(ctx, 'write', `להחליק על מסך הטלפון${args.direction ? ` (${args.direction})` : ''}?`)
      if (!gate.allowed) return gate.text
      return phoneSwipe(args)
    },
  },
  {
    name: 'phone_type_text',
    enabled: phoneEnabled,
    description: 'מקליד לשדה שבפוקוס. עברית וסימנים נשלחים דרך לוח ההעתקה ואז הדבקה, כי adb input text תומך רק ב-ASCII. השדה חייב להיות בפוקוס (phone_tap עליו קודם).',
    parameters: obj({ text: str('הטקסט להקליד') }),
    async run({ text }, ctx) {
      const gate = await gatePhone(ctx, 'write', `להקליד בטלפון?\n${String(text || '').slice(0, 200)}`)
      if (!gate.allowed) return gate.text
      return phoneTypeText(text)
    },
  },
  {
    name: 'phone_key',
    enabled: phoneEnabled,
    description: 'מקש מערכת: back, home, recents, enter, volume_up, volume_down, power.',
    parameters: obj({ key: { type: 'string', enum: ['back', 'home', 'recents', 'enter', 'volume_up', 'volume_down', 'power'], description: 'המקש' } }),
    async run({ key }, ctx) {
      const gate = await gatePhone(ctx, 'write', `ללחוץ בטלפון על ${key}?`)
      if (!gate.allowed) return gate.text
      return phoneKey(key)
    },
  },
  {
    name: 'phone_open_app',
    enabled: phoneEnabled,
    description: 'פותח אפליקציה לפי שם (וואטסאפ, הגדרות, מצלמה, כרום) או לפי שם חבילה. אם השם לא נמצא, phone_list_apps מראה את החבילות.',
    parameters: obj({ name: str('שם האפליקציה או שם החבילה') }),
    async run({ name }, ctx) {
      const gate = await gatePhone(ctx, 'write', `לפתוח בטלפון את ${name}?`)
      if (!gate.allowed) return gate.text
      return phoneOpenApp(name)
    },
  },
  {
    name: 'phone_list_apps',
    enabled: phoneEnabled,
    description: 'רשימת חבילות מותקנות בטלפון (package names).',
    parameters: obj({}, []),
    async run(_args, ctx) {
      const gate = await gatePhone(ctx, 'read', 'להציג את האפליקציות בטלפון?')
      if (!gate.allowed) return gate.text
      const list = await phoneListApps()
      return list.slice(0, 200).join('\n') || 'לא נמצאו חבילות'
    },
  },
  {
    name: 'phone_notifications',
    enabled: phoneEnabled,
    description: 'סיכום ההתראות שמוצגות עכשיו בטלפון: אפליקציה, כותרת וטקסט.',
    parameters: obj({}, []),
    async run(_args, ctx) {
      const gate = await gatePhone(ctx, 'read', 'לקרוא את ההתראות בטלפון?')
      if (!gate.allowed) return gate.text
      return phoneNotifications()
    },
  },
  {
    name: 'phone_battery',
    enabled: phoneEnabled,
    description: 'אחוז הסוללה בטלפון, אם היא בטעינה, והטמפרטורה.',
    parameters: obj({}, []),
    async run(_args, ctx) {
      const gate = await gatePhone(ctx, 'read', 'לבדוק את סוללת הטלפון?')
      if (!gate.allowed) return gate.text
      return phoneBattery()
    },
  },
  {
    name: 'phone_shell',
    enabled: phoneEnabled,
    description: 'פקודה אחת ב-adb shell, בלי שרשור (; | & ` $). איפוס, rm, pm uninstall, pm clear, settings put ו-reboot חסומים עד אישור מפורש, גם במצב auto. לקריאה עדיף הכלים הייעודיים.',
    parameters: obj({ command: str('פקודה אחת, בלי תווי שרשור') }),
    async run({ command }, ctx) {
      const kind = classifyShell(command)
      if (kind === 'deny') return DENIED
      const gate = await gatePhone(
        ctx,
        kind === 'dangerous' ? 'dangerous' : 'write',
        kind === 'dangerous' ? `פקודה מסוכנת בטלפון, רק אם זה בדיוק מה שהמשתמש ביקש:\n${command}` : `להריץ בטלפון?\n${command}`,
      )
      if (!gate.allowed) return gate.text
      return phoneShell(command, { confirmed: true })
    },
  },
]
