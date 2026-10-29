// The model's handle on the WhatsApp groups (src/groups.js): "מה פספסתי?", adding to the calendar or tasks,
// and teaching it what matters. Reading a group never needs approval; writing to the calendar or tasks does.
import * as groups from './groups.js'
import * as google from './google.js'
import { str, obj, writable } from './tool-helpers.js'

// An item with a date and no time is an all-day event; with a time it is an hour.
export const groupAdders = (account) => ({
  calendar: (i) => google.calendarAdd(writable(account), { title: i.title, start: i.time ? `${i.date}T${i.time}` : i.date, description: 'מקבוצת וואטסאפ, דרך Helper' }),
  tasks: (i) => google.tasksAdd(writable(account), { title: i.title, ...(i.date && { due: i.date }), notes: 'מקבוצת וואטסאפ, דרך Helper' }),
})

const ids = (list) => [].concat(list || []).map(Number).filter(Number.isInteger)

export const groupTools = [
  {
    name: 'whatsapp_groups',
    description:
      'קבוצות הוואטסאפ של המשתמש (כיתה, שכבה, חוגים, פרויקטים): מה חשוב שם בלי לקרוא הכל. ' +
      'missed = "מה פספסתי?" / "מה היה בקבוצות?" (אפשר group לקבוצה אחת, hours לטווח). ' +
      'add = להוסיף פריטים לפי מספר ליומן או למשימות (המשתמש מאשר). dismiss = להוריד פריטים. ' +
      'feedback = ללמוד מה חשוב לו: kind group/sender/topic, how more/less/mute/unmute (למשל "הקבוצה של הכדורגל לא מעניינת" = group less, "תשתיק את..." = mute, "מה שהמחנכת כותבת חשוב" = sender more). ' +
      'on/off = להתחיל או להפסיק לעקוב (רק כשהוא מבקש). status = מה פעיל ומה נלמד. forget = למחוק את כל מה שנשמר מהקבוצות.',
    parameters: obj(
      {
        action: { type: 'string', enum: ['missed', 'add', 'dismiss', 'feedback', 'status', 'on', 'off', 'forget'] },
        group: str('שם קבוצה או חלק ממנו, לסינון ב-missed'),
        hours: { type: 'number', description: 'missed: כמה שעות אחורה (ברירת מחדל: מאז הפעם הקודמת שהוא שאל)' },
        items: { type: 'array', items: { type: 'number' }, description: 'add/dismiss: מספרי הפריטים מהרשימה' },
        to: { type: 'string', enum: ['auto', 'calendar', 'tasks'], description: 'add: לאן (auto = מבחנים ואירועים ליומן, שיעורי בית למשימות)' },
        kind: { type: 'string', enum: ['group', 'sender', 'topic'], description: 'feedback: על מה' },
        name: str('feedback: שם הקבוצה, השולח או הנושא'),
        how: { type: 'string', enum: ['more', 'less', 'mute', 'unmute'], description: 'feedback: יותר חשוב, פחות, השתקה מלאה, ביטול השתקה' },
        account: str('add: חשבון Google לכתיבה; ריק = הראשי'),
      },
      ['action']
    ),
    async run({ action, group, hours, items, to = 'auto', kind = 'group', name, how = 'less', account }, ctx) {
      if (action === 'missed') return groups.missed({ hours: Number(hours) || 0, group })
      if (action === 'status') return groups.statusText()
      if (action === 'on') return groups.setEnabled(true)
      if (action === 'off') return groups.setEnabled(false)
      if (action === 'forget') return groups.forgetAll()
      if (action === 'dismiss') return groups.dismiss(ids(items))
      if (action === 'feedback') return groups.feedback({ kind, name, how })
      if (action === 'add') {
        if (!google.googleEnabled()) return 'אין חשבון Google מחובר, אז אין לאן להוסיף. אפשר לקבוע תזכורת במקום (add_reminder).'
        // Group text was written by other people: what goes into his calendar is shown to him first, every time.
        return groups.addItems(ids(items), { to, adders: groupAdders(account), confirm: ctx.confirm })
      }
      return 'פעולה לא מוכרת'
    },
  },
]
