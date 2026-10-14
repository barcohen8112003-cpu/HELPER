// Initiative: the assistant opens the conversation itself when it has something worth saying.
// The situation (calendar, homework, reminders, watches, new mail and files, weather, the recent conversation)
// is gathered here in code, so the model gets the whole picture in one go and spends its effort on what matters:
// noticing where two things meet ("exam tomorrow" + "class until 20:00 tonight"), and staying quiet otherwise.
// Three kinds of moment: a lead-up before an event out of the house, an evening look at tomorrow, and a regular
// sweep during the day. Every one may end in SKIP, and a topic already raised is never raised again.
import { config } from './config.js'
import { state, save } from './store.js'
import { inQuietHours } from './outbox.js'
import { listEvents, calendarOn } from './calendar.js'
import * as archive from './archive.js'
import { forecast } from './weather.js'

const FIRST_SWEEP = 3 * 60000
const startedAt = Date.now()
const HORIZON_HOURS = 36
// How long before an event with a place the lead-up check runs, and how many of those a day at most.
const LEAD = 90 * 60000
const MAX_LEADS = 3
const EVENTS_REFRESH = 10 * 60000
// A topic raised in this window is not raised again.
const TOPIC_MEMORY = 72 * 3600000
// The evening look at tomorrow is skipped if the assistant only comes up this long after its time.
const PREP_WINDOW = 3 * 60
const DEFAULT_PREP = '20:00'

const st = () => (state.initiative ??= { prefs: [], sent: [], leads: [], date: '', count: 0, lastAt: 0, prepDate: '' })

// What applies now: what the user set in chat wins over .env.
export function settings() {
  const s = st()
  return {
    perDay: s.perDay ?? config.proactive.maxPerDay,
    everyMinutes: s.everyMinutes ?? config.proactive.everyMinutes,
    prepTime: s.prepTime ?? (config.prepTime || DEFAULT_PREP),
    location: s.location ?? config.weatherLocation,
    prefs: s.prefs || [],
  }
}

export function describeSettings() {
  const s = settings()
  if (!s.perDay) return 'יוזמה כבויה.'
  return [
    `פונה אליך עד ${s.perDay} פעמים ביום, לפחות ${s.everyMinutes} דקות בין פנייה לפנייה, לא בשעות השקט.`,
    /^\d{1,2}:\d{2}$/.test(s.prepTime) ? `הכנה למחר: כל ערב ב-${s.prepTime}.` : 'הכנה למחר: כבויה.',
    `לפני אירוע עם מקום: בדיקה כשעה וחצי לפני.`,
    s.location ? `מזג אוויר: ${s.location}.` : 'מזג אוויר: לא הוגדר מיקום.',
    s.prefs.length ? `העדפות:\n${s.prefs.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

// Calendar reads cost a network round each, so the next two days are kept for a few minutes.
let events = { at: 0, list: [] }
async function upcoming() {
  if (!calendarOn()) return []
  if (Date.now() - events.at > EVENTS_REFRESH) events = { at: Date.now(), list: await listEvents(2).catch((e) => (console.log(`[initiative] ${e.message}`), events.list)) }
  return events.list
}

const time = (d) => new Date(d).toLocaleString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
const section = (title, rows, empty = '(אין)') => [`*${title}*`, ...(rows.length ? rows : [empty])].join('\n')

// Everything the model needs to judge whether a message is worth sending, as plain text.
export async function situation(now = Date.now()) {
  const s = settings()
  const end = now + HORIZON_HOURS * 3600000
  const wx = s.location ? await forecast(s.location, 2).catch((e) => (console.log(`[initiative] ${e.message}`), null)) : null
  const weatherAt = (d) => {
    const h = wx?.at(d)
    return h ? ` | מזג אוויר אז: ${h.temp}°, ${h.rainChance}% גשם` : ''
  }
  const events = (await upcoming()).filter((e) => e.start >= now && e.start <= end)
  const changed = state.watchers.flatMap((w) => (w.history || []).filter((h, i) => i > 0 && h.at > now - 86400000).map((h) => `• ${w.name}: ${h.value} (${time(h.at)})`))
  const recentChat = state.history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'הוא' : 'אתה'}: ${m.content.slice(0, 300)}`)
  const sent = st().sent.filter((x) => now - x.at < TOPIC_MEMORY).map((x) => `• ${time(x.at)}: ${x.topic}`)
  return [
    section(`יומן, ${HORIZON_HOURS} השעות הקרובות`, events.map((e) => `• ${e.when} ${e.title}${e.location ? ` @ ${e.location}` : ''}${weatherAt(e.start)}`), calendarOn() ? '(ריק)' : '(יומן לא מחובר)'),
    section('מטלות שלא הוגשו', state.homework.open.map((w) => `• ${w.title} (${w.course}) - להגשה ${w.due}`)),
    section('תזכורות ומשימות קרובות', [...state.reminders, ...state.tasks].filter((r) => Date.parse(r.at) <= end).map((r) => `• ${time(r.at)} ${r.text || r.instruction}`)),
    section('מעקבים שהשתנו ב-24 שעות', changed),
    section('מיילים שנכנסו ב-24 שעות', archive.recent(24, 'mail').slice(0, 12).map((m) => `• ${time(m.at)} ${m.title}: ${m.start.replace(/\s+/g, ' ').slice(0, 120)}`)),
    section('קבצים שקיבלת ב-3 ימים', archive.recent(72, 'whatsapp/file').slice(0, 6).map((f) => `• ${time(f.at)} ${f.title}`)),
    wx ? section(`מזג אוויר ב${wx.place}`, wx.daily.map((d) => `• ${d.date}: ${d.min}-${d.max}°, ${d.rainChance}% גשם${d.rainMm ? ` (${d.rainMm} מ"מ)` : ''}`)) : '',
    section('השיחה האחרונה', recentChat),
    section('נושאים שכבר העלית ביוזמתך (אל תחזור עליהם)', sent),
    section('העדפות שהמשתמש ביקש לגבי פניות', s.prefs.map((p) => `• ${p}`)),
  ]
    .filter(Boolean)
    .join('\n\n')
}

const PROMPT = (moment) => `יוזמה עצמית: המשתמש רוצה שתפנה אליו בעצמך כשיש משהו ששווה את זה. ${moment}
למטה תמונת מצב שנאספה עכשיו. חפש בה *הצלבות*, זה מה שהופך הודעה לשווה:
• משהו מתקרב שדורש הכנה, מול זמן פנוי או עמוס: מבחן או הגשה מחר, והערב היומן עמוס או פנוי.
• אירוע מחוץ לבית ומזג האוויר באותה שעה: גשם, חום כבד. המלץ מה לעשות. אל תמציא נתוני תנועה או פקקים.
• מייל או מעקב שהשתנה ונוגע למשהו שהוא עסוק בו עכשיו.
• נושא פתוח מהשיחה שהגיע הזמן לחזור אליו.
כלים רק אם הם מוסיפים משהו ממשי (למשל recall כדי למצוא את הסיכום שהוא שלח על החומר של המבחן), ובמשורה.
כתוב הודעה אחת קצרה ואישית, עם הצעה מעשית אחת או שאלה אחת. בשורה הראשונה כתוב רק "נושא: " ו-2 עד 4 מילים, ואחריה את ההודעה עצמה.
אסור: לחזור על נושא שכבר העלית, "היי מה קורה" ריק, להמציא עובדות, נושאים שהוא ביקש להימנע מהם, להציע פיצ'רים.
אם אין דבר שבאמת שווה הודעה עכשיו, החזר בדיוק SKIP. שתיקה עדיפה על הודעה בינונית.`

const MOMENT = {
  sweep: 'זה סבב בדיקה רגיל במהלך היום.',
  prep: 'זו ההכנה של הערב לקראת מחר: מה מחר דורש ממנו (שעות, מקומות, מבחנים והגשות, מזג אוויר) ומה כדאי לסדר כבר הערב. כאן מותר לשלוח גם בלי הצלבה, אם מחר יש משהו. אם מחר ריק, SKIP.',
  lead: (e) => `בעוד כ-${Math.round((e.start - Date.now()) / 60000)} דקות יש לו "${e.title}" ב${e.location}. בדוק אם יש משהו שכדאי לדעת לפני שהוא יוצא: מזג האוויר באותה שעה, מייל או קובץ שקשור לאירוע, משהו להביא. אם אין, SKIP.`,
}

const norm = (t) => t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// The model's answer is "נושא: ..." and then the message. A repeated topic counts as nothing to say.
export function parseReply(reply, sent = st().sent, now = Date.now()) {
  const m = reply.match(/^[\s*_]*נושא[*_]*\s*:\s*(.+?)[*_]*\s*\n+([\s\S]+)$/)
  const topic = (m?.[1] || '').replace(/[*_]/g, '').trim()
  const text = (m ? m[2] : reply).trim()
  if (topic && sent.some((x) => now - x.at < TOPIC_MEMORY && norm(x.topic) === norm(topic))) return null
  return { topic: topic || text.slice(0, 40), text }
}

async function run(kind, moment, notify, runTask) {
  const s = st()
  let picked = null
  const reply = await runTask(`${PROMPT(moment)}\n\n---\n${await situation()}`, {
    label: `יוזמה: ${kind}`,
    // Applied before the reply enters the history, so the history holds the message as the user saw it.
    accept: (r) => (picked = parseReply(r))?.text || '',
  })
  if (!reply || !picked) return false
  s.sent = [...s.sent.filter((x) => Date.now() - x.at < TOPIC_MEMORY), { at: Date.now(), topic: picked.topic }].slice(-40)
  save()
  await notify(picked.text, false, `initiative:${kind}:${norm(picked.topic)}:${new Date().toDateString()}`)
  return true
}

// One scheduler job. At most one model run per call, the most time-bound moment first.
export async function initiative(notify, runTask) {
  const cfg = settings()
  if (!cfg.perDay || inQuietHours()) return
  const s = st()
  const now = new Date()
  const today = now.toDateString()
  if (s.date !== today) Object.assign(s, { date: today, count: 0, leads: [] })

  // Before leaving for an event that has a place.
  if (s.leads.length < MAX_LEADS) {
    const lead = (await upcoming()).find((e) => e.location && e.start - now > 0 && e.start - now <= LEAD && !s.leads.includes(`${e.uid}@${+e.start}`))
    if (lead) {
      s.leads.push(`${lead.uid}@${+lead.start}`)
      save()
      return run('lead', MOMENT.lead(lead), notify, runTask)
    }
  }

  // The evening look at tomorrow, once a day.
  if (/^\d{1,2}:\d{2}$/.test(cfg.prepTime) && s.prepDate !== today) {
    const [h, m] = cfg.prepTime.split(':').map(Number)
    const late = now.getHours() * 60 + now.getMinutes() - (h * 60 + m)
    if (late >= 0) {
      s.prepDate = today
      save()
      if (late <= PREP_WINDOW) return run('prep', MOMENT.prep, notify, runTask)
    }
  }

  // The regular sweep, at the set pace and up to the daily count. Never in the first minutes after start-up,
  // when mail and calendar have not been read yet; after that the pace counts from the last sweep, restarts or not.
  if (s.count >= cfg.perDay || Date.now() - startedAt < FIRST_SWEEP || Date.now() - s.lastAt < cfg.everyMinutes * 60000) return
  s.lastAt = Date.now()
  save()
  if (await run('sweep', MOMENT.sweep, notify, runTask)) {
    s.count++
    save()
  }
}

// Changes from chat ("talk to me more", "not about the news", "I live in Haifa").
export function update({ per_day, every_minutes, prep_time, location, add_preference, remove_preference }) {
  const s = st()
  if (per_day !== undefined) s.perDay = Math.max(0, Math.min(12, Math.round(per_day)))
  if (every_minutes !== undefined) s.everyMinutes = Math.max(30, Math.round(every_minutes))
  if (prep_time !== undefined) {
    if (prep_time !== 'off' && !/^\d{1,2}:\d{2}$/.test(prep_time)) throw new Error('prep_time צריך להיות HH:MM או off')
    s.prepTime = prep_time
  }
  if (location !== undefined) s.location = location.trim()
  if (add_preference) s.prefs = [...(s.prefs || []), add_preference.trim()].slice(-20)
  if (remove_preference) s.prefs = (s.prefs || []).filter((_, i) => i !== remove_preference - 1)
  save()
  return describeSettings()
}
