// Planning and productivity tools. Mostly pure computation; a few keep small lists in Helper's own state.
import { str, num, obj, oneOf, toNumber, need, lines, clip, bucket, persist } from './_kit.js'

export const category = 'plan'
export const blurb = 'תכנון ופרודוקטיביות'

const MAX_ITEMS = 100
const DAY = 86400000
const arr = (description) => ({ type: 'array', items: { type: 'object' }, description })
const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description })

function list(value, name, max = MAX_ITEMS) {
  let v = value
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      throw new Error(`${name} חייב להיות רשימה`)
    }
  }
  if (!Array.isArray(v) || !v.length) throw new Error(`${name} חייב להיות רשימה לא ריקה`)
  if (v.length > max) throw new Error(`${name}: יותר מדי פריטים (מקסימום ${max})`)
  return v
}

const pad = (n) => String(n).padStart(2, '0')
const hm = (min) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}
function parseHM(value, name = 'שעה') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new Error(`${name} חייבת להיות בפורמט HH:MM`)
  return Number(m[1]) * 60 + Number(m[2])
}
function parseIso(value, name = 'תאריך') {
  const s = String(need(value, name)).trim()
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s)
  if (!Number.isFinite(ms)) throw new Error(`${name} לא תקין (נדרש ISO)`)
  return ms
}
const nowMs = (now) => (now ? parseIso(now, 'now') : Date.now())
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const r2 = (n) => Math.round(n * 100) / 100
const text = (v, name, max = 80) => {
  const s = String(need(v, name)).trim()
  if (!s) throw new Error(`חסר ${name}`)
  return s.slice(0, max)
}
const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s).trim())

// ---- day planner ----
function dayBlocks({ tasks, start, end, break_minutes = 10, break_every = 90 }) {
  const items = list(tasks, 'משימות').map((t, i) => ({
    name: text(t.name, 'שם משימה'),
    minutes: toNumber(t.minutes, 'משך'),
    priority: t.priority === undefined ? 0 : toNumber(t.priority, 'עדיפות'),
    i,
  }))
  if (items.some((t) => t.minutes <= 0 || t.minutes > 1440)) throw new Error('משך משימה חייב להיות בין 1 ל-1440 דקות')
  items.sort((a, b) => b.priority - a.priority || a.i - b.i)
  let cur = parseHM(start, 'שעת התחלה')
  const stop = parseHM(end, 'שעת סיום')
  if (stop <= cur) throw new Error('שעת הסיום חייבת להיות אחרי ההתחלה')
  const brk = toNumber(break_minutes, 'הפסקה')
  const every = toNumber(break_every, 'כל כמה עבודה')
  const out = []
  const left = []
  let worked = 0
  items.forEach((t, idx) => {
    if (cur + t.minutes > stop) {
      left.push(t.name)
      return
    }
    out.push(`${hm(cur)}-${hm(cur + t.minutes)} ${t.name}`)
    cur += t.minutes
    worked += t.minutes
    const more = items.slice(idx + 1).some((x) => cur + brk + x.minutes <= stop)
    if (brk > 0 && worked >= every && more) {
      out.push(`${hm(cur)}-${hm(cur + brk)} הפסקה`)
      cur += brk
      worked = 0
    }
  })
  return lines(out, left.length ? `לא נכנסו: ${left.join(', ')}` : '', `סיום עבודה: ${hm(cur)}`)
}

// ---- time zones ----
function tzOffsetMs(utc, tz) {
  let f
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    throw new Error(`אזור זמן לא מוכר: ${tz}`)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utc)).map((x) => [x.type, x.value]))
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utc / 1000) * 1000 - (utc % 1000)
}
const localMinutes = (utc, tz) => {
  const d = new Date(utc + tzOffsetMs(utc, tz))
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}
function localMidnightUtc(dateStr, tz) {
  const guess = parseIso(dateStr)
  let utc = guess - tzOffsetMs(guess, tz)
  utc = guess - tzOffsetMs(utc, tz)
  return utc
}

function meetingTimes({ zones, date }) {
  const zs = list(zones, 'אזורי זמן', 10).map((z) => {
    const o = typeof z === 'string' ? { zone: z } : z
    return { zone: text(o.zone, 'אזור זמן', 60), s: parseHM(o.start ?? '09:00', 'שעת התחלה'), e: parseHM(o.end ?? '17:00', 'שעת סיום') }
  })
  if (zs.length < 2) throw new Error('צריך לפחות שני אזורי זמן')
  const day = text(date, 'תאריך', 10)
  if (!isDateOnly(day)) throw new Error('תאריך חייב להיות YYYY-MM-DD')
  const t0 = localMidnightUtc(day, zs[0].zone)
  const ranges = []
  for (let k = 0; k < 48; k++) {
    const t = t0 + k * 30 * 60000
    const ok = zs.every((z) => {
      const a = localMinutes(t, z.zone)
      const e = a + 30
      return a >= z.s && e <= z.e
    })
    if (!ok) continue
    const last = ranges[ranges.length - 1]
    if (last && last.end === t) last.end = t + 30 * 60000
    else ranges.push({ start: t, end: t + 30 * 60000 })
  }
  if (!ranges.length) return 'אין חפיפה בשעות העבודה'
  return ranges
    .map((r) => zs.map((z) => `${z.zone} ${hm(localMinutes(r.start, z.zone))}-${hm(localMinutes(r.end, z.zone))}`).join(' | '))
    .join('\n')
}

// ---- free slots ----
function freeSlots({ busy, window_start, window_end, min_minutes = 15 }) {
  const timeMode = /^\d{1,2}:\d{2}$/.test(String(window_start).trim())
  const pt = (v, n) => (timeMode ? parseHM(v, n) : parseIso(v, n) / 60000)
  const show = (m) => (timeMode ? hm(m) : new Date(m * 60000).toISOString().slice(0, 16) + 'Z')
  const ws = pt(window_start, 'תחילת חלון')
  const we = pt(window_end, 'סוף חלון')
  if (we <= ws) throw new Error('סוף החלון חייב להיות אחרי ההתחלה')
  const min = toNumber(min_minutes, 'מינימום דקות')
  const bs = (Array.isArray(busy) && !busy.length ? [] : list(busy, 'פגישות תפוסות'))
    .map((b) => ({ s: pt(b.start, 'התחלה'), e: pt(b.end, 'סיום') }))
    .sort((a, b) => a.s - b.s)
  const free = []
  let cur = ws
  for (const b of bs) {
    if (b.e <= cur) continue
    if (b.s > cur) free.push([cur, Math.min(b.s, we)])
    cur = Math.max(cur, b.e)
    if (cur >= we) break
  }
  if (cur < we) free.push([cur, we])
  const ok = free.filter(([a, b]) => b - a >= min && b > a)
  return ok.length ? ok.map(([a, b]) => `${show(a)}-${show(b)} (${Math.round(b - a)} דק')`).join('\n') : 'אין חלונות פנויים'
}

// ---- prioritizer ----
function prioritize({ tasks, now }) {
  const t0 = nowMs(now)
  const rows = list(tasks, 'משימות').map((t) => {
    const days = (parseIso(t.deadline, 'דדליין') - t0) / DAY
    const urgency = 10 / (1 + Math.max(days, 0))
    const importance = toNumber(t.importance ?? 3, 'חשיבות')
    const effort = Math.max(0, toNumber(t.effort_hours ?? 1, 'מאמץ'))
    const score = 3 * importance + 2 * urgency + 5 / (1 + effort)
    return { name: text(t.name, 'שם משימה'), score: r2(score), days: r2(days) }
  })
  rows.sort((a, b) => b.score - a.score)
  return rows.map((r, i) => `${i + 1}. ${r.name} (ציון ${r.score}, ${r.days < 0 ? `באיחור ${-r.days} ימים` : `${r.days} ימים לדדליין`})`).join('\n')
}

// ---- counters stored in Helper state ----
const maxId = (items) => items.reduce((m, x) => Math.max(m, x.id), 0)
const dayNumber = (now) => {
  if (now) return Math.floor(parseIso(String(now).slice(0, 10)) / DAY)
  const d = new Date()
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY)
}

const BACKLOG_STATUS = ['todo', 'doing', 'done']
const STATUS_HE = { todo: 'לביצוע', doing: 'בעבודה', done: 'הושלם' }

const PACK = {
  beach: ['בגדי ים x2', 'מגבת חוף', 'קרם הגנה', 'כובע', 'כפכפים', 'משקפי שמש'],
  city: ['נעליים נוחות', 'מטען נייד', 'מפה/אפליקציית ניווט', 'תיק יום קטן', 'מטרייה מתקפלת'],
  hiking: ['נעלי הליכה', 'בקבוק מים', 'כובע', 'קרם הגנה', 'ערכת עזרה ראשונה', 'פנס ראש', 'חטיפי אנרגיה', 'מעיל קל'],
  business: ['חליפה/בגדים מכובדים', 'מחשב נייד ומטען', 'כרטיסי ביקור', 'נעליים אלגנטיות', 'מחברת ועט'],
  winter: ['מעיל חם', 'צעיף וכפפות', 'כובע צמר', 'גרביים תרמיות', 'נעליים אטומות', 'קרם לחות'],
}
const PACK_BASE = ['דרכון/תעודת זהות', 'ארנק וכרטיס אשראי', 'טלפון ומטען', 'תרופות אישיות', 'מברשת שיניים ומשחה', 'דאודורנט']

const GOALS = {
  health: ['אחרי שאני מכין קפה בבוקר, אשתה כוס מים', 'אחרי שאני מצחצח שיניים, אעשה 10 שכיבות סמיכה', 'אחרי שאני מסיים ארוחת צהריים, אצא להליכה של 10 דקות'],
  study: ['אחרי שאני מתיישב ליד השולחן, אפתח את החומר ואלמד 25 דקות', 'אחרי שאני חוזר מהלימודים, אסכם 5 נקודות מהשיעור', 'אחרי שאני מסיים תרגיל, אכתוב שאלה אחת לעצמי למחר'],
  focus: ['אחרי שאני מתיישב לעבוד, אשים את הטלפון במגירה', 'אחרי שאני מדליק את המחשב, אכתוב את שלוש המשימות של היום', 'אחרי שאני מסיים בלוק ריכוז, אקום למתוח'],
  sleep: ['אחרי שאני מצחצח שיניים בערב, אשים את הטלפון בטעינה מחוץ למיטה', 'אחרי שאני נכנס למיטה, אקרא 10 דקות', 'אחרי ארוחת ערב, אעמעם את האורות'],
  mood: ['אחרי שאני מתעורר, אכתוב דבר אחד שאני אסיר תודה עליו', 'אחרי שאני מסיים יום, אשלח הודעה טובה לחבר', 'אחרי שאני פותח חלון בבוקר, אנשום עמוק שלוש פעמים'],
}

export const tools = [
  {
    name: 'plan_day_blocks',
    description: 'בונה לוח זמנים ליום מרשימת משימות עם משך ועדיפות, בתוך חלון שעות, כולל הפסקות.',
    parameters: obj(
      { tasks: arr('רשימת {name, minutes, priority} (עדיפות גבוהה קודם)'), start: str('שעת התחלה HH:MM'), end: str('שעת סיום HH:MM'), break_minutes: num('אורך הפסקה, ברירת מחדל 10'), break_every: num('הפסקה אחרי כמה דקות עבודה, ברירת מחדל 90') },
      ['tasks', 'start', 'end'],
    ),
    run: (a) => dayBlocks(a),
  },
  {
    name: 'plan_eisenhower',
    description: 'ממיין משימות למטריצת אייזנהואר לפי דחוף וחשוב.',
    parameters: obj({ tasks: arr('רשימת {name, urgent, important} עם true/false') }),
    run({ tasks }) {
      const q = { a: [], b: [], c: [], d: [] }
      for (const t of list(tasks, 'משימות')) {
        const name = text(t.name, 'שם משימה')
        const u = t.urgent === true || t.urgent === 'true'
        const i = t.important === true || t.important === 'true'
        q[u && i ? 'a' : i ? 'b' : u ? 'c' : 'd'].push(name)
      }
      const sec = (title, items) => `${title}: ${items.length ? items.join(', ') : '-'}`
      return lines(sec('עשה עכשיו (דחוף וחשוב)', q.a), sec('תזמן (חשוב, לא דחוף)', q.b), sec('האצל (דחוף, לא חשוב)', q.c), sec('בטל או דחה (לא דחוף ולא חשוב)', q.d))
    },
  },
  {
    name: 'plan_prioritize',
    description: 'מדרג משימות לפי ציון משוקלל של דדליין, חשיבות ומאמץ.',
    parameters: obj({ tasks: arr('רשימת {name, deadline ISO, importance 1-5, effort_hours}'), now: str('זמן נוכחי ISO, אופציונלי') }, ['tasks']),
    run: (a) => prioritize(a),
  },
  {
    name: 'plan_backward',
    description: 'מתכנן אחורה מתאריך יעד: מחשב מועדי התחלה וסיום לכל שלב.',
    parameters: obj({ due: str('תאריך יעד YYYY-MM-DD'), steps: strArr('שמות השלבים לפי הסדר'), days_each: num('ימים לכל שלב, ברירת מחדל 1'), now: str('זמן נוכחי ISO לבדיקת היתכנות, אופציונלי') }, ['due', 'steps']),
    run({ due, steps, days_each = 1, now }) {
      const names = list(steps, 'שלבים', 50).map((s) => text(typeof s === 'string' ? s : s?.name, 'שם שלב'))
      const d = toNumber(days_each, 'ימים לשלב')
      if (d <= 0 || d > 365) throw new Error('ימים לשלב חייב להיות בין 0 ל-365')
      let end = parseIso(due, 'תאריך יעד')
      const out = []
      for (let i = names.length - 1; i >= 0; i--) {
        const start = end - d * DAY
        out.unshift(`${i + 1}. ${names[i]}: ${isoDay(start)} עד ${isoDay(end)}`)
        end = start
      }
      const warn = now && end < Math.floor(nowMs(now) / DAY) * DAY ? `שים לב: ההתחלה (${isoDay(end)}) כבר עברה` : ''
      return lines(out, warn)
    },
  },
  {
    name: 'plan_meeting_times',
    description: 'מוצא חלונות פגישה משותפים בין כמה אזורי זמן לפי שעות העבודה של כל אחד.',
    parameters: obj({ zones: arr('רשימת {zone IANA, start HH:MM, end HH:MM}'), date: str('תאריך YYYY-MM-DD לפי האזור הראשון') }),
    run: (a) => meetingTimes(a),
  },
  {
    name: 'plan_free_slots',
    description: 'מחשב חלונות פנויים בתוך טווח זמן, בהינתן רשימת פגישות תפוסות.',
    parameters: obj({ busy: arr('רשימת {start, end} כ-HH:MM או ISO'), window_start: str('תחילת הטווח'), window_end: str('סוף הטווח'), min_minutes: num('אורך מינימלי לחלון, ברירת מחדל 15') }, ['busy', 'window_start', 'window_end']),
    run: (a) => freeSlots(a),
  },
  {
    name: 'plan_pert',
    description: 'אומדן PERT משלוש הערכות (אופטימי, סביר, פסימי) עם סטיית תקן ומרווח ביטחון.',
    parameters: obj({ optimistic: num('אופטימי'), likely: num('סביר'), pessimistic: num('פסימי'), unit: str('יחידה, למשל ימים') }, ['optimistic', 'likely', 'pessimistic']),
    run({ optimistic, likely, pessimistic, unit = '' }) {
      const o = toNumber(optimistic, 'אופטימי')
      const m = toNumber(likely, 'סביר')
      const p = toNumber(pessimistic, 'פסימי')
      if (!(o <= m && m <= p)) throw new Error('נדרש אופטימי ≤ סביר ≤ פסימי')
      const e = (o + 4 * m + p) / 6
      const sd = (p - o) / 6
      const u = unit ? ` ${unit}` : ''
      return lines(`אומדן: ${r2(e)}${u}`, `סטיית תקן: ${r2(sd)}`, `טווח 68%: ${r2(e - sd)}-${r2(e + sd)}${u}`, `עם מרווח ביטחון ל-95%: ${r2(e + 1.645 * sd)}${u}`)
    },
  },
  {
    name: 'plan_weekly_review',
    description: 'מייצר תבנית סיכום שבועי מתוך מספרים שמוסרים: משימות, שעות, שינה ואימונים.',
    parameters: obj(
      { tasks_done: num('משימות שבוצעו'), tasks_planned: num('משימות שתוכננו'), hours_worked: num('שעות עבודה/לימוד'), focus_hours: num('שעות ריכוז'), sleep_avg: num('שעות שינה בממוצע'), workouts: num('אימונים'), wins: strArr('הצלחות'), lessons: strArr('לקחים') },
      ['tasks_done', 'tasks_planned'],
    ),
    run(a) {
      const done = toNumber(a.tasks_done, 'בוצעו')
      const plan = toNumber(a.tasks_planned, 'תוכננו')
      if (plan <= 0 || done < 0) throw new Error('מספר המשימות לא תקין')
      const pct = Math.round((done / plan) * 100)
      const opt = (v, label, unit) => (v === undefined ? '' : `${label}: ${toNumber(v, label)}${unit}`)
      const wins = Array.isArray(a.wins) ? a.wins.slice(0, 10).map((w) => `+ ${clip(w, 100)}`) : []
      const lessons = Array.isArray(a.lessons) ? a.lessons.slice(0, 10).map((w) => `- ${clip(w, 100)}`) : []
      const verdict = pct >= 90 ? 'שבוע חזק' : pct >= 60 ? 'שבוע סביר, יש מקום לשיפור' : 'שבוע קשה, כדאי לצמצם את התכנון'
      return lines(
        `סיכום שבועי: ${done}/${plan} משימות (${pct}%) - ${verdict}`,
        opt(a.hours_worked, 'שעות עבודה', ''),
        opt(a.focus_hours, 'שעות ריכוז', ''),
        opt(a.sleep_avg, 'שינה בממוצע', ' שעות'),
        opt(a.workouts, 'אימונים', ''),
        wins.length ? ['הצלחות:', ...wins] : '',
        lessons.length ? ['לקחים:', ...lessons] : '',
        'שאלות לשבוע הבא: מה הדבר האחד החשוב ביותר? מה אפסיק לעשות? מה אתחיל?',
      )
    },
  },
  {
    name: 'plan_habit_stacks',
    description: 'מציע הרגלים מוצמדים ("אחרי X אעשה Y") לפי מטרה, מתוך תבניות מוכנות.',
    parameters: obj({ goal: oneOf(Object.keys(GOALS), 'מטרה'), anchor: str('הרגל קיים להצמיד אליו, אופציונלי') }, ['goal']),
    run({ goal, anchor }) {
      const g = GOALS[goal]
      if (!g) throw new Error('מטרה לא מוכרת')
      const a = anchor ? String(anchor).slice(0, 60) : ''
      const extra = a ? [`אחרי ${a}, אעשה פעולה קטנה של שתי דקות למען המטרה`] : []
      return [...extra, ...g].map((x, i) => `${i + 1}. ${x}`).join('\n')
    },
  },
  {
    name: 'plan_backlog',
    description: 'בקלוג פרויקט: הוספת פריט עם נקודות, שינוי סטטוס, רשימה לפי סטטוס וסיכום מהירות.',
    parameters: obj(
      { action: oneOf(['add', 'move', 'list', 'velocity'], 'פעולה'), title: str('כותרת (add)'), points: num('נקודות (add)'), status: oneOf(BACKLOG_STATUS, 'סטטוס (add/move/list)'), id: num('מזהה פריט (move)'), at: str('זמן ISO לסימון הושלם (move), אופציונלי') },
      ['action'],
    ),
    async run({ action, title, points = 1, status, id, at }) {
      const items = await bucket('plan_backlog', [])
      if (status && !BACKLOG_STATUS.includes(status)) throw new Error('סטטוס לא מוכר')
      if (action === 'add') {
        if (items.length >= 500) throw new Error('הבקלוג מלא')
        const pts = toNumber(points, 'נקודות')
        if (pts < 0 || pts > 1000) throw new Error('נקודות לא תקינות')
        const item = { id: maxId(items) + 1, title: text(title, 'כותרת', 120), points: pts, status: status ?? 'todo', done_at: null }
        items.push(item)
        await persist()
        return `נוסף #${item.id}: ${item.title} (${item.points} נק', ${STATUS_HE[item.status]})`
      }
      if (action === 'move') {
        const item = items.find((x) => x.id === Number(id))
        if (!item) throw new Error('פריט לא נמצא')
        item.status = need(status, 'סטטוס')
        item.done_at = status === 'done' ? new Date(nowMs(at)).toISOString() : null
        await persist()
        return `#${item.id} ${item.title} -> ${STATUS_HE[item.status]}`
      }
      if (action === 'list') {
        const rows = items.filter((x) => !status || x.status === status)
        return rows.length ? rows.slice(0, 60).map((x) => `#${x.id} [${STATUS_HE[x.status]}] ${x.title} (${x.points} נק')`).join('\n') : 'אין פריטים'
      }
      if (action === 'velocity') {
        const by = Object.fromEntries(BACKLOG_STATUS.map((s) => [s, items.filter((x) => x.status === s)]))
        const sum = (a) => a.reduce((t, x) => t + x.points, 0)
        const dn = by.done
        return lines(
          BACKLOG_STATUS.map((s) => `${STATUS_HE[s]}: ${by[s].length} פריטים, ${sum(by[s])} נק'`),
          dn.length ? `ממוצע לפריט שהושלם: ${r2(sum(dn) / dn.length)} נק'` : '',
          `התקדמות: ${items.length ? Math.round((sum(dn) / (sum(items) || 1)) * 100) : 0}% מהנקודות`,
        )
      }
      throw new Error('פעולה לא מוכרת')
    },
  },
  {
    name: 'plan_timer',
    description: 'מעקב זמן: התחלת טיימר, עצירה, ודוח סכומים לפי תווית בטווח תאריכים.',
    parameters: obj(
      { action: oneOf(['start', 'stop', 'report'], 'פעולה'), label: str('תווית (start/stop)'), at: str('זמן ISO (start/stop), ברירת מחדל עכשיו'), from: str('תחילת טווח (report)'), to: str('סוף טווח (report), תאריך בלבד כולל את כל היום') },
      ['action'],
    ),
    async run({ action, label, at, from, to }) {
      const timers = await bucket('plan_timers', [])
      if (action === 'start') {
        const l = text(label, 'תווית', 40)
        if (timers.some((t) => t.end === null && t.label === l)) throw new Error('כבר רץ טיימר עם התווית הזו')
        if (timers.length >= 1000) timers.splice(0, 200)
        const start = nowMs(at)
        timers.push({ id: maxId(timers) + 1, label: l, start, end: null })
        await persist()
        return `התחיל "${l}" ב-${new Date(start).toISOString()}`
      }
      if (action === 'stop') {
        const running = timers.filter((t) => t.end === null && (!label || t.label === String(label).trim()))
        const t = running[running.length - 1]
        if (!t) throw new Error('אין טיימר פעיל')
        const end = nowMs(at)
        if (end < t.start) throw new Error('זמן העצירה לפני ההתחלה')
        t.end = end
        await persist()
        return `נעצר "${t.label}": ${Math.round((end - t.start) / 60000)} דקות`
      }
      if (action === 'report') {
        const f = from ? parseIso(from, 'from') : -Infinity
        const t2 = to ? parseIso(to, 'to') + (isDateOnly(to) ? DAY : 0) : Infinity
        const totals = {}
        for (const t of timers) {
          if (t.end === null) continue
          const ms = Math.min(t.end, t2) - Math.max(t.start, f)
          if (ms > 0) totals[t.label] = (totals[t.label] ?? 0) + ms / 60000
        }
        const keys = Object.keys(totals).sort((a, b) => totals[b] - totals[a])
        if (!keys.length) return 'אין זמן רשום בטווח'
        return lines(keys.map((k) => `${k}: ${Math.round(totals[k])} דקות`), `סה"כ: ${Math.round(keys.reduce((s, k) => s + totals[k], 0))} דקות`)
      }
      throw new Error('פעולה לא מוכרת')
    },
  },
  {
    name: 'plan_focus_log',
    description: 'יומן סשנים של ריכוז: רישום סשן עם דירוג וסיכום לפי טווח תאריכים.',
    parameters: obj(
      { action: oneOf(['log', 'summary'], 'פעולה'), minutes: num('משך הסשן (log)'), task: str('על מה עבדת (log)'), rating: num('ריכוז 1-5 (log)'), at: str('זמן ISO (log)'), from: str('תחילת טווח (summary)'), to: str('סוף טווח (summary)') },
      ['action'],
    ),
    async run({ action, minutes, task, rating, at, from, to }) {
      const log = await bucket('plan_focus', [])
      if (action === 'log') {
        const m = toNumber(minutes, 'דקות')
        if (m <= 0 || m > 600) throw new Error('משך הסשן חייב להיות בין 1 ל-600 דקות')
        const r = rating === undefined ? null : toNumber(rating, 'דירוג')
        if (r !== null && (r < 1 || r > 5)) throw new Error('דירוג בין 1 ל-5')
        if (log.length >= 2000) log.splice(0, 500)
        log.push({ at: nowMs(at), minutes: m, task: text(task ?? 'כללי', 'משימה', 60), rating: r })
        await persist()
        return `נרשם סשן של ${m} דקות על "${String(task ?? 'כללי').slice(0, 60)}"`
      }
      if (action === 'summary') {
        const f = from ? parseIso(from, 'from') : -Infinity
        const t2 = to ? parseIso(to, 'to') + (isDateOnly(to) ? DAY : 0) : Infinity
        const rows = log.filter((x) => x.at >= f && x.at < t2)
        if (!rows.length) return 'אין סשנים בטווח'
        const total = rows.reduce((s, x) => s + x.minutes, 0)
        const rated = rows.filter((x) => x.rating !== null)
        const byTask = {}
        for (const x of rows) byTask[x.task] = (byTask[x.task] ?? 0) + x.minutes
        return lines(
          `${rows.length} סשנים, ${total} דקות (${r2(total / 60)} שעות)`,
          rated.length ? `דירוג ממוצע: ${r2(rated.reduce((s, x) => s + x.rating, 0) / rated.length)}` : '',
          Object.entries(byTask).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}: ${v} דקות`),
        )
      }
      throw new Error('פעולה לא מוכרת')
    },
  },
  {
    name: 'plan_countdown',
    description: 'רשימת ספירה לאחור לדדליינים: הוספה, הצגה עם ימים שנותרו, והסרה.',
    parameters: obj({ action: oneOf(['add', 'list', 'remove'], 'פעולה'), label: str('שם האירוע (add)'), date: str('תאריך YYYY-MM-DD (add)'), id: num('מזהה (remove)'), now: str('זמן נוכחי ISO, אופציונלי') }, ['action']),
    async run({ action, label, date, id, now }) {
      const items = await bucket('plan_countdowns', [])
      if (action === 'add') {
        if (items.length >= 100) throw new Error('הרשימה מלאה')
        const day = text(date, 'תאריך', 10)
        if (!isDateOnly(day)) throw new Error('תאריך חייב להיות YYYY-MM-DD')
        parseIso(day)
        const item = { id: maxId(items) + 1, label: text(label, 'שם', 80), date: day }
        items.push(item)
        await persist()
        return `נוסף #${item.id}: ${item.label} ב-${item.date}`
      }
      if (action === 'list') {
        const today = dayNumber(now)
        if (!items.length) return 'אין ספירות לאחור'
        return [...items]
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((x) => {
            const left = Math.floor(parseIso(x.date) / DAY) - today
            return `#${x.id} ${x.label}: ${left > 0 ? `עוד ${left} ימים` : left === 0 ? 'היום' : `עבר לפני ${-left} ימים`} (${x.date})`
          })
          .join('\n')
      }
      if (action === 'remove') {
        const i = items.findIndex((x) => x.id === Number(id))
        if (i < 0) throw new Error('פריט לא נמצא')
        const [gone] = items.splice(i, 1)
        await persist()
        return `הוסר: ${gone.label}`
      }
      throw new Error('פעולה לא מוכרת')
    },
  },
  {
    name: 'plan_decide_weighted',
    description: 'מטריצת החלטה משוקללת: מדרג אפשרויות לפי קריטריונים עם משקלים.',
    parameters: obj({ criteria: arr('רשימת {name, weight}'), options: arr('רשימת {name, scores} כמספרים לפי סדר הקריטריונים') }),
    run({ criteria, options }) {
      const cs = list(criteria, 'קריטריונים', 20).map((c) => ({ name: text(c.name, 'שם קריטריון'), w: toNumber(c.weight ?? 1, 'משקל') }))
      if (cs.some((c) => c.w < 0)) throw new Error('משקל לא יכול להיות שלילי')
      const total = cs.reduce((s, c) => s + c.w, 0)
      if (total <= 0) throw new Error('סכום המשקלים חייב להיות חיובי')
      const rows = list(options, 'אפשרויות', 30).map((o) => {
        const sc = list(o.scores, `ציונים של ${o.name}`, 20)
        if (sc.length !== cs.length) throw new Error(`ל-${o.name} חסרים ציונים (צריך ${cs.length})`)
        return { name: text(o.name, 'שם אפשרות'), score: r2(sc.reduce((s, v, i) => s + toNumber(v, 'ציון') * cs[i].w, 0) / total) }
      })
      rows.sort((a, b) => b.score - a.score)
      return lines(rows.map((r, i) => `${i + 1}. ${r.name}: ${r.score}`), `המנצחת: ${rows[0].name}`)
    },
  },
  {
    name: 'plan_okr',
    description: 'מעקב OKR: הוספת יעד ותוצאות מפתח, עדכון התקדמות, והצגת אחוזי התקדמות.',
    parameters: obj(
      { action: oneOf(['add_objective', 'add_kr', 'update_kr', 'list'], 'פעולה'), title: str('כותרת (add_objective/add_kr)'), objective_id: num('מזהה יעד (add_kr)'), target: num('ערך יעד (add_kr)'), current: num('ערך נוכחי'), kr_id: num('מזהה תוצאת מפתח (update_kr)') },
      ['action'],
    ),
    async run({ action, title, objective_id, target, current, kr_id }) {
      const okrs = await bucket('plan_okr', [])
      const pct = (k) => Math.max(0, Math.min(100, Math.round((k.current / k.target) * 100)))
      const allKrs = () => okrs.flatMap((o) => o.krs)
      if (action === 'add_objective') {
        if (okrs.length >= 30) throw new Error('יותר מדי יעדים')
        const o = { id: maxId(okrs) + 1, title: text(title, 'כותרת', 100), krs: [] }
        okrs.push(o)
        await persist()
        return `נוסף יעד #${o.id}: ${o.title}`
      }
      if (action === 'add_kr') {
        const o = okrs.find((x) => x.id === Number(objective_id))
        if (!o) throw new Error('יעד לא נמצא')
        if (o.krs.length >= 10) throw new Error('יותר מדי תוצאות מפתח ליעד')
        const tg = toNumber(target, 'ערך יעד')
        if (tg <= 0) throw new Error('ערך היעד חייב להיות חיובי')
        const k = { id: maxId(allKrs()) + 1, title: text(title, 'כותרת', 100), target: tg, current: current === undefined ? 0 : toNumber(current, 'ערך נוכחי') }
        o.krs.push(k)
        await persist()
        return `נוספה תוצאת מפתח #${k.id} ליעד #${o.id}: ${k.title} (יעד ${k.target})`
      }
      if (action === 'update_kr') {
        const k = allKrs().find((x) => x.id === Number(kr_id))
        if (!k) throw new Error('תוצאת מפתח לא נמצאה')
        k.current = toNumber(need(current, 'ערך נוכחי'), 'ערך נוכחי')
        await persist()
        return `#${k.id} ${k.title}: ${pct(k)}%`
      }
      if (action === 'list') {
        if (!okrs.length) return 'אין יעדים'
        return okrs
          .map((o) => {
            const avg = o.krs.length ? Math.round(o.krs.reduce((s, k) => s + pct(k), 0) / o.krs.length) : 0
            return lines(`יעד #${o.id} ${o.title}: ${avg}%`, o.krs.map((k) => `  KR #${k.id} ${k.title}: ${k.current}/${k.target} (${pct(k)}%)`))
          })
          .join('\n')
      }
      throw new Error('פעולה לא מוכרת')
    },
  },
  {
    name: 'plan_packing_list',
    description: 'מייצר רשימת אריזה לטיול לפי סוג הטיול ומספר הימים, מתבניות מוכנות.',
    parameters: obj({ trip_type: oneOf(Object.keys(PACK), 'סוג טיול'), days: num('מספר ימים'), abroad: { type: 'boolean', description: 'טיול לחו"ל' } }, ['trip_type', 'days']),
    run({ trip_type, days, abroad }) {
      const t = PACK[trip_type]
      if (!t) throw new Error('סוג טיול לא מוכר')
      const d = Math.floor(toNumber(days, 'ימים'))
      if (d < 1 || d > 60) throw new Error('מספר הימים חייב להיות בין 1 ל-60')
      const clothes = [`תחתונים x${Math.min(d + 1, 10)}`, `גרביים x${Math.min(d + 1, 10)}`, `חולצות x${Math.min(d, 7)}`, `מכנסיים x${Math.max(1, Math.min(Math.ceil(d / 2), 4))}`]
      if (d > 7) clothes.push('מומלץ לתכנן כביסה באמצע הטיול')
      const extra = abroad ? ['מתאם לשקע', 'ביטוח נסיעות', 'כרטיס/מזומן במטבע מקומי'] : []
      return lines('בגדים:', clothes.map((x) => `- ${x}`), `ציוד ל${trip_type}:`, t.map((x) => `- ${x}`), 'כללי:', [...PACK_BASE, ...extra].map((x) => `- ${x}`))
    },
  },
  {
    name: 'plan_routine',
    description: 'בונה שגרת בוקר או ערב עם שעות מדויקות משעת התחלה ורשימת פעילויות עם משך.',
    parameters: obj({ start: str('שעת התחלה HH:MM'), activities: arr('רשימת {name, minutes}'), buffer_minutes: num('מרווח בין פעילויות, ברירת מחדל 0') }, ['start', 'activities']),
    run({ start, activities, buffer_minutes = 0 }) {
      let cur = parseHM(start, 'שעת התחלה')
      const buf = toNumber(buffer_minutes, 'מרווח')
      if (buf < 0 || buf > 120) throw new Error('מרווח לא תקין')
      const out = list(activities, 'פעילויות', 30).map((a) => {
        const m = toNumber(a.minutes, 'משך')
        if (m <= 0 || m > 600) throw new Error('משך פעילות לא תקין')
        const row = `${hm(cur)}-${hm(cur + m)} ${text(a.name, 'שם פעילות')}`
        cur += m + buf
        return row
      })
      return lines(out, `סיום: ${hm(cur - buf)}`)
    },
  },
]

export const tests = [
  { tool: 'plan_day_blocks', args: { tasks: [{ name: 'A', minutes: 60, priority: 1 }, { name: 'B', minutes: 30, priority: 3 }], start: '09:00', end: '12:00', break_every: 60 }, check: (r) => r.includes('09:00-09:30 B') && r.includes('09:30-10:30 A') && !r.includes('הפסקה') },
  { tool: 'plan_day_blocks', args: { tasks: [{ name: 'A', minutes: 60, priority: 1 }, { name: 'B', minutes: 30, priority: 3 }, { name: 'C', minutes: 20 }], start: '09:00', end: '12:00', break_every: 60 }, check: (r) => r.includes('10:30-10:40 הפסקה') && r.includes('10:40-11:00 C') },
  { tool: 'plan_day_blocks', args: { tasks: [{ name: 'ארוך', minutes: 300 }], start: '09:00', end: '10:00' }, check: (r) => r.includes('לא נכנסו: ארוך') },
  { tool: 'plan_day_blocks', args: { tasks: [], start: '09:00', end: '10:00' }, throws: true, check: () => false },
  { tool: 'plan_eisenhower', args: { tasks: [{ name: 'x', urgent: true, important: true }, { name: 'y', urgent: false, important: true }, { name: 'z', urgent: true, important: false }, { name: 'w' }] }, check: (r) => r.includes('עשה עכשיו (דחוף וחשוב): x') && r.includes('תזמן (חשוב, לא דחוף): y') && r.includes('האצל (דחוף, לא חשוב): z') && r.includes('לא חשוב): w') },
  {
    tool: 'plan_prioritize',
    args: { now: '2026-01-01T00:00:00Z', tasks: [{ name: 'B', deadline: '2026-01-31', importance: 5, effort_hours: 4 }, { name: 'A', deadline: '2026-01-02', importance: 3, effort_hours: 1 }] },
    check: (r) => r.startsWith('1. A (ציון 21.5') && r.includes('2. B (ציון 16.65'),
  },
  { tool: 'plan_backward', args: { due: '2026-03-10', steps: ['a', 'b', 'c'], days_each: 2 }, check: (r) => r.includes('3. c: 2026-03-08 עד 2026-03-10') && r.includes('1. a: 2026-03-04 עד 2026-03-06') },
  {
    tool: 'plan_meeting_times',
    args: { zones: [{ zone: 'Asia/Jerusalem', start: '09:00', end: '17:00' }, { zone: 'UTC', start: '08:00', end: '16:00' }], date: '2026-01-15' },
    check: (r) => r.includes('Asia/Jerusalem 10:00-17:00') && r.includes('UTC 08:00-15:00'),
  },
  { tool: 'plan_meeting_times', args: { zones: [{ zone: 'Asia/Tokyo', start: '09:00', end: '12:00' }, { zone: 'America/New_York', start: '09:00', end: '12:00' }], date: '2026-01-15' }, check: (r) => r === 'אין חפיפה בשעות העבודה' },
  {
    tool: 'plan_free_slots',
    args: { window_start: '09:00', window_end: '17:00', min_minutes: 30, busy: [{ start: '14:00', end: '15:00' }, { start: '10:00', end: '11:00' }, { start: '10:30', end: '12:00' }] },
    check: (r) => r === "09:00-10:00 (60 דק')\n12:00-14:00 (120 דק')\n15:00-17:00 (120 דק')",
  },
  { tool: 'plan_pert', args: { optimistic: 2, likely: 4, pessimistic: 12, unit: 'ימים' }, check: (r) => r.includes('אומדן: 5 ימים') && r.includes('סטיית תקן: 1.67') && r.includes('7.74') },
  { tool: 'plan_pert', args: { optimistic: 5, likely: 4, pessimistic: 12 }, throws: true, check: () => false },
  { tool: 'plan_weekly_review', args: { tasks_done: 8, tasks_planned: 10, sleep_avg: 7, wins: ['סיימתי פרויקט'] }, check: (r) => r.includes('8/10 משימות (80%)') && r.includes('שינה בממוצע: 7 שעות') && r.includes('+ סיימתי פרויקט') },
  { tool: 'plan_habit_stacks', args: { goal: 'study', anchor: 'ארוחת בוקר' }, check: (r) => r.startsWith('1. אחרי ארוחת בוקר') && r.split('\n').length === 4 },
  { tool: 'plan_backlog', args: { action: 'add', title: 'לוגין', points: 5 }, check: (r) => r.startsWith('נוסף #1: לוגין') },
  { tool: 'plan_backlog', args: { action: 'add', title: 'דשבורד', points: 3 }, check: (r) => r.startsWith('נוסף #2') },
  { tool: 'plan_backlog', args: { action: 'move', id: 1, status: 'done', at: '2026-01-05T10:00:00Z' }, check: (r) => r.includes('#1 לוגין -> הושלם') },
  { tool: 'plan_backlog', args: { action: 'list', status: 'todo' }, check: (r) => r.includes('#2') && !r.includes('#1') },
  { tool: 'plan_backlog', args: { action: 'velocity' }, check: (r) => r.includes("הושלם: 1 פריטים, 5 נק'") && r.includes('התקדמות: 63%') },
  { tool: 'plan_timer', args: { action: 'start', label: 'work', at: '2026-01-01T09:00:00Z' }, check: (r) => r.includes('התחיל "work"') },
  { tool: 'plan_timer', args: { action: 'stop', label: 'work', at: '2026-01-01T10:30:00Z' }, check: (r) => r.includes('90 דקות') },
  { tool: 'plan_timer', args: { action: 'start', label: 'study', at: '2026-01-01T11:00:00Z' }, check: (r) => r.includes('study') },
  { tool: 'plan_timer', args: { action: 'stop', at: '2026-01-01T11:45:00Z' }, check: (r) => r.includes('45 דקות') },
  { tool: 'plan_timer', args: { action: 'report', from: '2026-01-01', to: '2026-01-01' }, check: (r) => r.includes('work: 90 דקות') && r.includes('study: 45 דקות') && r.includes('סה"כ: 135 דקות') },
  { tool: 'plan_timer', args: { action: 'report', from: '2026-01-02', to: '2026-01-03' }, check: (r) => r === 'אין זמן רשום בטווח' },
  { tool: 'plan_focus_log', args: { action: 'log', minutes: 25, task: 'מתמטיקה', rating: 4, at: '2026-02-01T10:00:00Z' }, check: (r) => r.includes('25 דקות') },
  { tool: 'plan_focus_log', args: { action: 'log', minutes: 50, task: 'מתמטיקה', rating: 2, at: '2026-02-01T12:00:00Z' }, check: (r) => r.includes('50 דקות') },
  { tool: 'plan_focus_log', args: { action: 'summary', from: '2026-02-01', to: '2026-02-01' }, check: (r) => r.includes('2 סשנים, 75 דקות (1.25 שעות)') && r.includes('דירוג ממוצע: 3') },
  { tool: 'plan_countdown', args: { action: 'add', label: 'מבחן', date: '2026-03-10' }, check: (r) => r.startsWith('נוסף #1') },
  { tool: 'plan_countdown', args: { action: 'list', now: '2026-03-01T08:00:00Z' }, check: (r) => r.includes('עוד 9 ימים') },
  { tool: 'plan_countdown', args: { action: 'remove', id: 1 }, check: (r) => r.includes('מבחן') },
  { tool: 'plan_decide_weighted', args: { criteria: [{ name: 'מחיר', weight: 3 }, { name: 'איכות', weight: 2 }], options: [{ name: 'A', scores: [8, 5] }, { name: 'B', scores: [5, 9] }] }, check: (r) => r.includes('1. A: 6.8') && r.includes('2. B: 6.6') && r.includes('המנצחת: A') },
  { tool: 'plan_okr', args: { action: 'add_objective', title: 'כושר' }, check: (r) => r.includes('#1') },
  { tool: 'plan_okr', args: { action: 'add_kr', objective_id: 1, title: 'ריצות', target: 10 }, check: (r) => r.includes('#1') },
  { tool: 'plan_okr', args: { action: 'update_kr', kr_id: 1, current: 5 }, check: (r) => r.includes('50%') },
  { tool: 'plan_okr', args: { action: 'list' }, check: (r) => r.includes('יעד #1 כושר: 50%') && r.includes('5/10') },
  { tool: 'plan_packing_list', args: { trip_type: 'beach', days: 3, abroad: true }, check: (r) => r.includes('תחתונים x4') && r.includes('חולצות x3') && r.includes('בגדי ים x2') && r.includes('מתאם לשקע') },
  { tool: 'plan_packing_list', args: { trip_type: 'beach', days: 0 }, throws: true, check: () => false },
  { tool: 'plan_routine', args: { start: '07:00', activities: [{ name: 'מים', minutes: 5 }, { name: 'תרגיל', minutes: 20 }, { name: 'מקלחת', minutes: 15 }], buffer_minutes: 5 }, check: (r) => r.includes('07:00-07:05 מים') && r.includes('07:10-07:30 תרגיל') && r.includes('07:35-07:50 מקלחת') && r.includes('סיום: 07:50') },
]
