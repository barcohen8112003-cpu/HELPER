// Personal tracking: lists, notes, habits, expenses, mood, water, workouts, sleep, journal, goals.
// Everything lives in Helper's own state (bucket/persist). Nothing here leaves Helper or moves money.
import { str, num, bool, oneOf, obj, need, toNumber, bucket, persist, nextId } from './_kit.js'

export const category = 'life'
export const blurb = 'מעקב אישי: רשימות, הרגלים, הוצאות ויומן'

const MAX = 2000
const TZ = 'Asia/Jerusalem'

const clean = (v, name = 'טקסט', max = 500) => {
  const s = String(need(v, name)).trim().slice(0, max)
  if (!s) throw new Error(`חסר ${name}`)
  return s
}
const opt = (v, max = 500) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max))

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
function dateOf(v) {
  if (v === undefined || v === null || v === '') return today()
  const s = String(v).trim()
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error('תאריך לא תקין, צריך YYYY-MM-DD')
  return s
}
const addDays = (date, n) => new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10)
// the 7 days ending at `date`, inclusive
const weekDays = (date) => Array.from({ length: 7 }, (_, i) => addDays(date, i - 6))
const inWeek = (date, d) => weekDays(date).includes(d)
const round = (n, p = 1) => Math.round(n * 10 ** p) / 10 ** p
const avg = (xs) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0)

async function addRecord(arr, rec) {
  if (arr.length >= MAX) throw new Error(`האוסף מלא (${MAX} רשומות), צריך למחוק משהו קודם`)
  const full = { id: await nextId(), ...rec }
  arr.push(full)
  await persist()
  return full
}
function byId(arr, id, what = 'רשומה') {
  const i = arr.findIndex((x) => String(x.id) === String(need(id, 'מזהה')) || (x.dates && x.name === String(id)) || (x.target !== undefined && x.name === String(id)))
  if (i < 0) throw new Error(`${what} לא נמצאה`)
  return i
}
const needConfirm = (confirm) => {
  if (confirm !== true) throw new Error('צריך confirm:true כדי לנקות')
}
const idArg = str('מזהה הרשומה (להרגל או יעד אפשר גם שם)')
const dateArg = str('תאריך YYYY-MM-DD, ברירת מחדל היום')

const shop = () => bucket('life_shopping', [])
const lists = () => bucket('life_lists', [])
const notes = () => bucket('life_notes', [])
const habits = () => bucket('life_habits', [])
const expenses = () => bucket('life_expenses', [])
const moods = () => bucket('life_moods', [])
const water = () => bucket('life_water', { goal: 2000, days: {} })
const workouts = () => bucket('life_workouts', [])
const sleeps = () => bucket('life_sleep', [])
const journal = () => bucket('life_journal', [])
const goals = () => bucket('life_goals', [])

function streak(h, date) {
  const set = new Set(h.dates)
  let d = set.has(date) ? date : addDays(date, -1)
  let n = 0
  while (set.has(d)) {
    n++
    d = addDays(d, -1)
  }
  return n
}

function timeMin(v, name) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(need(v, name)).trim())
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`${name} לא תקין, צריך HH:MM`)
  return Number(m[1]) * 60 + Number(m[2])
}

async function weekStats(kind, date) {
  const wk = weekDays(date)
  if (kind === 'mood') {
    const xs = (await moods()).filter((m) => inWeek(date, m.date))
    const e = xs.filter((m) => m.energy)
    return `מצב רוח, 7 ימים עד ${date}: ${xs.length} רישומים, ממוצע ${avg(xs.map((m) => m.mood))}${e.length ? `, אנרגיה ממוצעת ${avg(e.map((m) => m.energy))}` : ''}`
  }
  if (kind === 'water') {
    const w = await water()
    const total = wk.reduce((s, d) => s + (w.days[d] ?? 0), 0)
    const hit = wk.filter((d) => (w.days[d] ?? 0) >= w.goal).length
    return `מים, 7 ימים עד ${date}: סה"כ ${total} מ"ל, ממוצע יומי ${round(total / 7, 0)}, יעד (${w.goal}) הושג ב-${hit} ימים`
  }
  if (kind === 'workout') {
    const xs = (await workouts()).filter((x) => inWeek(date, x.date))
    return `אימונים, 7 ימים עד ${date}: ${xs.length} אימונים, ${xs.reduce((s, x) => s + x.minutes, 0)} דקות${xs.length ? ` (${xs.map((x) => x.type).join(', ')})` : ''}`
  }
  if (kind === 'sleep') {
    const xs = (await sleeps()).filter((x) => inWeek(date, x.date))
    return `שינה, 7 ימים עד ${date}: ${xs.length} לילות, ממוצע ${avg(xs.map((x) => x.hours))} שעות`
  }
  throw new Error('סוג לא מוכר')
}

export const tools = [
  // ---- shopping list
  {
    name: 'life_shopping_add',
    description: 'מוסיף פריט (או כמה, מופרדים בפסיק) לרשימת הקניות.',
    parameters: obj({ items: str('פריט או כמה פריטים מופרדים בפסיק'), quantity: str('כמות, אופציונלי') }, ['items']),
    async run({ items, quantity }) {
      const arr = await shop()
      const names = clean(items, 'פריטים').split(/[,،\n]/).map((s) => s.trim()).filter(Boolean)
      if (arr.length + names.length > MAX) throw new Error('רשימת הקניות מלאה')
      const out = []
      for (const name of names) out.push(await addRecord(arr, { name: name.slice(0, 200), quantity: opt(quantity, 50), checked: false }))
      return `נוספו ${out.length} פריטים: ${out.map((o) => `${o.name} (#${o.id})`).join(', ')}`
    },
  },
  {
    name: 'life_shopping_list',
    description: 'מציג את רשימת הקניות, מה שעוד לא סומן ומה שסומן.',
    parameters: obj({}),
    async run() {
      const arr = await shop()
      if (!arr.length) return 'רשימת הקניות ריקה'
      const f = (x) => `#${x.id} ${x.name}${x.quantity ? ` x${x.quantity}` : ''}`
      const open = arr.filter((x) => !x.checked)
      const done = arr.filter((x) => x.checked)
      return `לקנות (${open.length}):\n${open.map(f).join('\n') || '-'}\nסומנו (${done.length}):\n${done.map(f).join('\n') || '-'}`
    },
  },
  {
    name: 'life_shopping_check',
    description: 'מסמן פריט ברשימת הקניות כנקנה (או מבטל סימון), לפי מזהה או שם.',
    parameters: obj({ id: idArg, name: str('שם הפריט אם אין מזהה'), checked: bool('ברירת מחדל true') }, []),
    async run({ id, name, checked = true }) {
      const arr = await shop()
      const i = id !== undefined && id !== '' ? byId(arr, id, 'פריט') : arr.findIndex((x) => x.name === clean(name, 'מזהה או שם'))
      if (i < 0) throw new Error('פריט לא נמצא')
      arr[i].checked = checked !== false
      await persist()
      return `${arr[i].name}: ${arr[i].checked ? 'סומן' : 'סימון בוטל'}`
    },
  },
  {
    name: 'life_shopping_remove',
    description: 'מוחק פריט מרשימת הקניות לפי מזהה.',
    parameters: obj({ id: idArg }),
    async run({ id }) {
      const arr = await shop()
      const [gone] = arr.splice(byId(arr, id, 'פריט'), 1)
      await persist()
      return `נמחק: ${gone.name}`
    },
  },
  {
    name: 'life_shopping_clear_checked',
    description: 'מנקה מרשימת הקניות את כל הפריטים שסומנו. דורש confirm:true.',
    parameters: obj({ confirm: bool('חייב להיות true') }),
    async run({ confirm }) {
      needConfirm(confirm)
      const arr = await shop()
      const before = arr.length
      const keep = arr.filter((x) => !x.checked)
      arr.splice(0, arr.length, ...keep)
      await persist()
      return `נוקו ${before - keep.length} פריטים`
    },
  },

  // ---- generic named lists
  {
    name: 'life_list_add',
    description: 'מוסיף פריט לרשימה בשם (למשל "סרטים לראות"); הרשימה נוצרת אם אין.',
    parameters: obj({ list: str('שם הרשימה'), item: str('הפריט') }),
    async run({ list, item }) {
      const arr = await lists()
      const name = clean(list, 'שם רשימה', 100)
      const rec = await addRecord(arr, { list: name, text: clean(item, 'פריט'), done: false })
      return `נוסף לרשימה "${name}": ${rec.text} (#${rec.id})`
    },
  },
  {
    name: 'life_list_show',
    description: 'מציג רשימה בשם, או את שמות כל הרשימות אם לא ניתן שם.',
    parameters: obj({ list: str('שם הרשימה, אופציונלי') }, []),
    async run({ list }) {
      const arr = await lists()
      if (!list) {
        const names = [...new Set(arr.map((x) => x.list))]
        return names.length ? names.map((n) => `${n} (${arr.filter((x) => x.list === n).length})`).join('\n') : 'אין רשימות'
      }
      const xs = arr.filter((x) => x.list === String(list).trim())
      return xs.length ? xs.map((x) => `#${x.id} ${x.done ? '[x]' : '[ ]'} ${x.text}`).join('\n') : 'הרשימה ריקה או לא קיימת'
    },
  },
  {
    name: 'life_list_update',
    description: 'מסמן פריט ברשימה בשם כבוצע/לא בוצע, או מוחק אותו לפי מזהה.',
    parameters: obj({ id: idArg, done: bool('בוצע?'), remove: bool('true כדי למחוק את הפריט') }, ['id']),
    async run({ id, done = true, remove = false }) {
      const arr = await lists()
      const i = byId(arr, id, 'פריט')
      if (remove === true) {
        const [g] = arr.splice(i, 1)
        await persist()
        return `נמחק: ${g.text}`
      }
      arr[i].done = done !== false
      await persist()
      return `${arr[i].text}: ${arr[i].done ? 'בוצע' : 'לא בוצע'}`
    },
  },
  {
    name: 'life_list_delete',
    description: 'מוחק רשימה בשם על כל פריטיה. דורש confirm:true.',
    parameters: obj({ list: str('שם הרשימה'), confirm: bool('חייב להיות true') }),
    async run({ list, confirm }) {
      needConfirm(confirm)
      const arr = await lists()
      const name = clean(list, 'שם רשימה', 100)
      const keep = arr.filter((x) => x.list !== name)
      if (keep.length === arr.length) throw new Error('רשימה לא נמצאה')
      const n = arr.length - keep.length
      arr.splice(0, arr.length, ...keep)
      await persist()
      return `הרשימה "${name}" נמחקה (${n} פריטים)`
    },
  },

  // ---- notes
  {
    name: 'life_note_add',
    description: 'שומר פתק אישי עם תגיות אופציונליות.',
    parameters: obj({ text: str('תוכן הפתק'), tags: str('תגיות מופרדות בפסיק'), date: dateArg }, ['text']),
    async run({ text, tags, date }) {
      const t = opt(tags).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 10)
      const rec = await addRecord(await notes(), { text: clean(text), tags: t, date: dateOf(date) })
      return `הפתק נשמר (#${rec.id})${t.length ? ` בתגיות: ${t.join(', ')}` : ''}`
    },
  },
  {
    name: 'life_note_search',
    description: 'מחפש בפתקים לפי טקסט או תגית; בלי חיפוש מציג את האחרונים.',
    parameters: obj({ query: str('טקסט לחיפוש'), tag: str('תגית') }, []),
    async run({ query, tag }) {
      let xs = await notes()
      if (query) xs = xs.filter((n) => n.text.toLowerCase().includes(String(query).toLowerCase()))
      if (tag) xs = xs.filter((n) => n.tags.includes(String(tag).trim().toLowerCase()))
      if (!xs.length) return 'לא נמצאו פתקים'
      return xs.slice(-15).map((n) => `#${n.id} [${n.date}] ${n.text}${n.tags.length ? ` {${n.tags.join(',')}}` : ''}`).join('\n')
    },
  },
  {
    name: 'life_note_delete',
    description: 'מוחק פתק לפי מזהה.',
    parameters: obj({ id: idArg }),
    async run({ id }) {
      const arr = await notes()
      arr.splice(byId(arr, id, 'פתק'), 1)
      await persist()
      return 'הפתק נמחק'
    },
  },

  // ---- habits
  {
    name: 'life_habit_create',
    description: 'יוצר הרגל חדש למעקב יומי.',
    parameters: obj({ name: str('שם ההרגל') }),
    async run({ name }) {
      const arr = await habits()
      const n = clean(name, 'שם', 100)
      if (arr.some((h) => h.name === n)) throw new Error('הרגל בשם הזה כבר קיים')
      const rec = await addRecord(arr, { name: n, dates: [] })
      return `ההרגל "${n}" נוצר (#${rec.id})`
    },
  },
  {
    name: 'life_habit_checkin',
    description: 'מסמן שההרגל בוצע בתאריך (או מבטל סימון עם done:false).',
    parameters: obj({ id: idArg, date: dateArg, done: bool('ברירת מחדל true') }, ['id']),
    async run({ id, date, done = true }) {
      const arr = await habits()
      const h = arr[byId(arr, id, 'הרגל')]
      const d = dateOf(date)
      h.dates = h.dates.filter((x) => x !== d)
      if (done !== false) {
        if (h.dates.length >= MAX) throw new Error('יותר מדי רישומים להרגל הזה')
        h.dates.push(d)
        h.dates.sort()
      }
      await persist()
      return `${h.name}: ${done !== false ? 'סומן' : 'בוטל'} ב-${d}, רצף נוכחי ${streak(h, d)}`
    },
  },
  {
    name: 'life_habit_stats',
    description: 'מציג רצף וסטטיסטיקה שבועית להרגל אחד או לכל ההרגלים.',
    parameters: obj({ id: idArg, date: dateArg }, []),
    async run({ id, date }) {
      const arr = await habits()
      const d = dateOf(date)
      const xs = id ? [arr[byId(arr, id, 'הרגל')]] : arr
      if (!xs.length) return 'אין הרגלים'
      return xs.map((h) => `#${h.id} ${h.name}: רצף ${streak(h, d)}, השבוע ${weekDays(d).filter((x) => h.dates.includes(x)).length}/7, סה"כ ${h.dates.length}`).join('\n')
    },
  },

  // ---- expenses (record keeping only)
  {
    name: 'life_expense_add',
    description: 'רושם הוצאה ביומן ההוצאות (רישום בלבד, לא מעביר כסף).',
    parameters: obj({ amount: num('סכום'), category: str('קטגוריה'), note: str('הערה'), date: dateArg }, ['amount']),
    async run({ amount, category: cat, note, date }) {
      const a = toNumber(amount, 'סכום')
      if (a < 0) throw new Error('סכום לא יכול להיות שלילי')
      const rec = await addRecord(await expenses(), { amount: round(a, 2), category: opt(cat, 50) || 'כללי', note: opt(note), date: dateOf(date) })
      return `נרשמה הוצאה #${rec.id}: ${rec.amount} ב${rec.category} ב-${rec.date}`
    },
  },
  {
    name: 'life_expense_list',
    description: 'מציג הוצאות אחרונות, אפשר לסנן לפי חודש YYYY-MM או קטגוריה.',
    parameters: obj({ month: str('חודש YYYY-MM'), category: str('קטגוריה') }, []),
    async run({ month, category: cat }) {
      let xs = await expenses()
      if (month) xs = xs.filter((x) => x.date.startsWith(String(month).trim()))
      if (cat) xs = xs.filter((x) => x.category === String(cat).trim())
      if (!xs.length) return 'אין הוצאות'
      return xs.slice(-25).map((x) => `#${x.id} ${x.date} ${x.amount} ${x.category}${x.note ? ` - ${x.note}` : ''}`).join('\n')
    },
  },
  {
    name: 'life_expense_summary',
    description: 'סיכום הוצאות חודשי לפי קטגוריה.',
    parameters: obj({ month: str('חודש YYYY-MM, ברירת מחדל החודש הנוכחי') }, []),
    async run({ month }) {
      const m = month ? String(month).trim() : today().slice(0, 7)
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error('חודש לא תקין, צריך YYYY-MM')
      const xs = (await expenses()).filter((x) => x.date.startsWith(m))
      if (!xs.length) return `אין הוצאות ב-${m}`
      const by = {}
      for (const x of xs) by[x.category] = (by[x.category] ?? 0) + x.amount
      const total = round(xs.reduce((s, x) => s + x.amount, 0), 2)
      return `${m}: סה"כ ${total} ב-${xs.length} הוצאות\n${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${round(v, 2)}`).join('\n')}`
    },
  },
  {
    name: 'life_expense_delete',
    description: 'מוחק הוצאה מהיומן לפי מזהה.',
    parameters: obj({ id: idArg }),
    async run({ id }) {
      const arr = await expenses()
      arr.splice(byId(arr, id, 'הוצאה'), 1)
      await persist()
      return 'ההוצאה נמחקה'
    },
  },

  // ---- mood / water / workout / sleep
  {
    name: 'life_mood_log',
    description: 'רושם מצב רוח 1-5 (ואנרגיה 1-5 אופציונלית) עם הערה, ומחזיר ממוצע שבועי.',
    parameters: obj({ mood: num('מצב רוח 1-5'), energy: num('אנרגיה 1-5'), note: str('הערה'), date: dateArg }, ['mood']),
    async run({ mood, energy, note, date }) {
      const m = toNumber(mood, 'מצב רוח')
      if (m < 1 || m > 5) throw new Error('מצב רוח חייב להיות בין 1 ל-5')
      let e
      if (energy !== undefined && energy !== null && energy !== '') {
        e = toNumber(energy, 'אנרגיה')
        if (e < 1 || e > 5) throw new Error('אנרגיה חייבת להיות בין 1 ל-5')
      }
      const d = dateOf(date)
      await addRecord(await moods(), { mood: m, energy: e, note: opt(note), date: d })
      return `נרשם. ${await weekStats('mood', d)}`
    },
  },
  {
    name: 'life_water_add',
    description: 'מוסיף שתיית מים במ"ל ליום (0 רק להצגה), עם אפשרות לקבוע יעד יומי.',
    parameters: obj({ ml: num('מ"ל להוסיף'), goal: num('יעד יומי חדש במ"ל'), date: dateArg }, []),
    async run({ ml = 0, goal, date }) {
      const w = await water()
      const d = dateOf(date)
      const add = toNumber(ml, 'כמות')
      if (add < 0 || add > 10000) throw new Error('כמות לא סבירה')
      if (goal !== undefined && goal !== null && goal !== '') {
        const g = toNumber(goal, 'יעד')
        if (g <= 0 || g > 20000) throw new Error('יעד לא סביר')
        w.goal = g
      }
      if (!(d in w.days) && Object.keys(w.days).length >= MAX) throw new Error('יומן המים מלא')
      w.days[d] = (w.days[d] ?? 0) + add
      await persist()
      return `${d}: ${w.days[d]} מ"ל מתוך ${w.goal} (${Math.round((w.days[d] / w.goal) * 100)}%)`
    },
  },
  {
    name: 'life_workout_add',
    description: 'רושם אימון: סוג, משך בדקות והערה, ומחזיר סיכום שבועי.',
    parameters: obj({ type: str('סוג האימון'), minutes: num('משך בדקות'), note: str('הערה'), date: dateArg }, ['type', 'minutes']),
    async run({ type, minutes, note, date }) {
      const mins = toNumber(minutes, 'משך')
      if (mins <= 0 || mins > 1440) throw new Error('משך לא סביר')
      const d = dateOf(date)
      await addRecord(await workouts(), { type: clean(type, 'סוג', 100), minutes: mins, note: opt(note), date: d })
      return `נרשם. ${await weekStats('workout', d)}`
    },
  },
  {
    name: 'life_sleep_log',
    description: 'רושם שינה לפי שעת שכיבה והשכמה (HH:MM) ומחשב שעות, עם ממוצע שבועי.',
    parameters: obj({ bedtime: str('שעת שכיבה HH:MM'), wake: str('שעת השכמה HH:MM'), date: str('תאריך ההשכמה YYYY-MM-DD') }, ['bedtime', 'wake']),
    async run({ bedtime, wake, date }) {
      const b = timeMin(bedtime, 'שעת שכיבה')
      const w = timeMin(wake, 'שעת השכמה')
      if (b === w) throw new Error('שעת השכמה זהה לשעת שכיבה')
      const hours = round((((w - b) % 1440) + 1440) % 1440 / 60, 2)
      const d = dateOf(date)
      await addRecord(await sleeps(), { bedtime: String(bedtime).trim(), wake: String(wake).trim(), hours, date: d })
      return `נרשמו ${hours} שעות שינה. ${await weekStats('sleep', d)}`
    },
  },
  {
    name: 'life_week_stats',
    description: 'סיכום 7 ימים אחרונים של מצב רוח, מים, אימונים או שינה.',
    parameters: obj({ kind: oneOf(['mood', 'water', 'workout', 'sleep'], 'מה לסכם'), date: dateArg }, ['kind']),
    async run({ kind, date }) {
      return weekStats(kind, dateOf(date))
    },
  },

  // ---- journal
  {
    name: 'life_journal_add',
    description: 'מוסיף רשומת יומן אישי לתאריך.',
    parameters: obj({ text: str('מה כתבת'), date: dateArg }, ['text']),
    async run({ text, date }) {
      const rec = await addRecord(await journal(), { text: clean(text), date: dateOf(date) })
      return `נשמר ביומן (#${rec.id}) ב-${rec.date}`
    },
  },
  {
    name: 'life_journal_search',
    description: 'מחפש ביומן לפי תאריך, טווח תאריכים או טקסט.',
    parameters: obj({ date: str('תאריך מדויק'), from: str('מתאריך'), to: str('עד תאריך'), query: str('טקסט') }, []),
    async run({ date, from, to, query }) {
      let xs = await journal()
      if (date) xs = xs.filter((x) => x.date === dateOf(date))
      if (from) xs = xs.filter((x) => x.date >= dateOf(from))
      if (to) xs = xs.filter((x) => x.date <= dateOf(to))
      if (query) xs = xs.filter((x) => x.text.toLowerCase().includes(String(query).toLowerCase()))
      if (!xs.length) return 'לא נמצאו רשומות'
      return xs.slice(-15).map((x) => `#${x.id} [${x.date}] ${x.text}`).join('\n')
    },
  },

  // ---- goals
  {
    name: 'life_goal_create',
    description: 'יוצר יעד אישי עם ערך יעד מספרי (למשל 10 ספרים).',
    parameters: obj({ name: str('שם היעד'), target: num('ערך היעד'), unit: str('יחידה') }, ['name', 'target']),
    async run({ name, target, unit }) {
      const t = toNumber(target, 'יעד')
      if (t <= 0) throw new Error('ערך היעד חייב להיות חיובי')
      const rec = await addRecord(await goals(), { name: clean(name, 'שם', 200), target: t, unit: opt(unit, 30), current: 0 })
      return `היעד "${rec.name}" נוצר (#${rec.id}), יעד ${t} ${rec.unit}`
    },
  },
  {
    name: 'life_goal_update',
    description: 'מעדכן התקדמות ביעד: קובע ערך נוכחי או מוסיף, ומחזיר אחוז.',
    parameters: obj({ id: idArg, current: num('ערך נוכחי חדש'), add: num('כמה להוסיף') }, ['id']),
    async run({ id, current, add }) {
      const arr = await goals()
      const g = arr[byId(arr, id, 'יעד')]
      if (current !== undefined && current !== null && current !== '') g.current = toNumber(current, 'ערך')
      else if (add !== undefined && add !== null && add !== '') g.current += toNumber(add, 'תוספת')
      else throw new Error('חסר current או add')
      if (g.current < 0) g.current = 0
      await persist()
      return `${g.name}: ${g.current}/${g.target} ${g.unit} (${Math.round((g.current / g.target) * 100)}%)`
    },
  },
  {
    name: 'life_goal_list',
    description: 'מציג את כל היעדים עם אחוזי התקדמות.',
    parameters: obj({}),
    async run() {
      const arr = await goals()
      if (!arr.length) return 'אין יעדים'
      return arr.map((g) => `#${g.id} ${g.name}: ${g.current}/${g.target} ${g.unit} (${Math.round((g.current / g.target) * 100)}%)`).join('\n')
    },
  },

  // ---- overview
  {
    name: 'life_overview',
    description: 'סקירה כללית: כמה רשומות בכל תחום, רצפי הרגלים והתקדמות יעדים.',
    parameters: obj({ date: dateArg }, []),
    async run({ date }) {
      const d = dateOf(date)
      const hs = await habits()
      const w = await water()
      return [
        `סקירה ל-${d}`,
        `קניות פתוחות: ${(await shop()).filter((x) => !x.checked).length}`,
        `פריטים ברשימות: ${(await lists()).length}, פתקים: ${(await notes()).length}, יומן: ${(await journal()).length}`,
        `הוצאות החודש: ${round((await expenses()).filter((x) => x.date.startsWith(d.slice(0, 7))).reduce((s, x) => s + x.amount, 0), 2)}`,
        `מים היום: ${w.days[d] ?? 0}/${w.goal}`,
        hs.length ? `הרגלים: ${hs.map((h) => `${h.name} (רצף ${streak(h, d)})`).join(', ')}` : 'הרגלים: אין',
        (await goals()).length ? `יעדים: ${(await goals()).map((g) => `${g.name} ${Math.round((g.current / g.target) * 100)}%`).join(', ')}` : 'יעדים: אין',
        await weekStats('mood', d),
        await weekStats('workout', d),
        await weekStats('sleep', d),
      ].join('\n')
    },
  },
]

const ok = (s) => (r) => String(r).includes(s)

export const tests = [
  { tool: 'life_shopping_add', args: { items: 'חלב, לחם', quantity: '2' }, check: ok('נוספו 2') },
  { tool: 'life_shopping_list', args: {}, check: ok('חלב') },
  { tool: 'life_shopping_check', args: { name: 'חלב' }, check: ok('סומן') },
  { tool: 'life_shopping_clear_checked', args: {}, throws: true, check: () => false },
  { tool: 'life_shopping_clear_checked', args: { confirm: true }, check: ok('נוקו 1') },
  { tool: 'life_shopping_remove', args: { id: 'nope' }, throws: true, check: () => false },
  { tool: 'life_list_add', args: { list: 'סרטים', item: 'דיון' }, check: ok('סרטים') },
  { tool: 'life_list_show', args: { list: 'סרטים' }, check: ok('דיון') },
  { tool: 'life_list_update', args: { id: 'nope' }, throws: true, check: () => false },
  { tool: 'life_list_delete', args: { list: 'סרטים', confirm: true }, check: ok('נמחקה') },
  { tool: 'life_note_add', args: { text: 'רעיון לפרויקט', tags: 'Work, idea', date: '2026-03-01' }, check: ok('נשמר') },
  { tool: 'life_note_search', args: { tag: 'idea' }, check: ok('רעיון') },
  { tool: 'life_note_delete', args: { id: 'nope' }, throws: true, check: () => false },
  { tool: 'life_habit_create', args: { name: 'ריצה' }, check: ok('נוצר') },
  {
    tool: 'life_habit_checkin',
    args: { id: 'ריצה', date: '2026-03-01' },
    check: ok('רצף נוכחי 1'),
  },
  { tool: 'life_habit_stats', args: { date: '2026-03-01' }, check: ok('ריצה') },
  { tool: 'life_expense_add', args: { amount: 50.5, category: 'אוכל', note: 'פיצה', date: '2026-03-02' }, check: ok('50.5') },
  { tool: 'life_expense_add', args: { amount: -3 }, throws: true, check: () => false },
  { tool: 'life_expense_list', args: { month: '2026-03' }, check: ok('פיצה') },
  { tool: 'life_expense_summary', args: { month: '2026-03' }, check: ok('אוכל: 50.5') },
  { tool: 'life_expense_delete', args: { id: 'nope' }, throws: true, check: () => false },
  { tool: 'life_mood_log', args: { mood: 4, energy: 3, date: '2026-03-02' }, check: ok('ממוצע 4') },
  { tool: 'life_mood_log', args: { mood: 9 }, throws: true, check: () => false },
  { tool: 'life_water_add', args: { ml: 500, goal: 2000, date: '2026-03-02' }, check: ok('500 מ"ל מתוך 2000') },
  { tool: 'life_workout_add', args: { type: 'ריצה', minutes: 30, date: '2026-03-02' }, check: ok('30 דקות') },
  { tool: 'life_sleep_log', args: { bedtime: '23:30', wake: '07:00', date: '2026-03-02' }, check: ok('7.5') },
  { tool: 'life_week_stats', args: { kind: 'sleep', date: '2026-03-02' }, check: ok('7.5') },
  { tool: 'life_journal_add', args: { text: 'יום טוב', date: '2026-03-02' }, check: ok('נשמר') },
  { tool: 'life_journal_search', args: { date: '2026-03-02' }, check: ok('יום טוב') },
  { tool: 'life_goal_create', args: { name: 'ספרים', target: 10, unit: 'ספרים' }, check: ok('נוצר') },
  { tool: 'life_goal_list', args: {}, check: ok('0%') },
  { tool: 'life_goal_update', args: { id: 'ספרים', add: 5 }, check: ok('50%') },
  { tool: 'life_goal_update', args: { id: 'nope', add: 1 }, throws: true, check: () => false },
  { tool: 'life_overview', args: { date: '2026-03-02' }, check: ok('סקירה ל-2026-03-02') },
]
