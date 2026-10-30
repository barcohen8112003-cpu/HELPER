// Proactive Helper: it offers to do the next thing for Naor, keeps track of what he left open, and comes back to it.
//
// Three parts, all with hard limits so it never turns into spam:
//  1. The offer. After an answer, when there is an obvious next thing Helper can do with its own tools (a reminder
//     the day before, adding it to the calendar, drafting the reply, comparing prices), it offers it in one short
//     line. One offer at most, never a generic "עוד משהו?" (style.js strips those), never the same offer twice.
//  2. Open loops. "אטפל בזה אחר כך", "מחכה לתשובה מהמורה", an errand left half done: Helper notes it in its own
//     notebook (open_loop) with a time to come back, and closes it once it is done. The open ones are in the prompt
//     on every turn, so a message that settles one closes it.
//  3. Coming back. When a loop's time comes, the scheduler runs Helper on it once: it checks whether the thing is
//     already settled (closes it quietly) or writes one short message offering to finish it. At most
//     FOLLOW_UPS_PER_DAY a day, never in quiet hours, never while he is mid-conversation, and it backs off when
//     he stops answering what it sends on its own.
//
// The notebook is Helper's own state: writing in it changes nothing outside Helper, so it needs no approval.
// Anything a follow-up wants to actually do (send, pay, add to his calendar) still goes through the usual approvals.
import { config } from './config.js'
import { state, save, newId } from './store.js'
import { obj, str } from './tool-helpers.js'

export const MAX_LOOPS = 20
// A loop nobody touched for this long is let go.
export const LOOP_TTL = 14 * 24 * 3600000
// How many times Helper comes back to the same loop before it stops asking.
export const MAX_NUDGES = 2
// A second nudge on the same loop waits at least this long after the first.
const RENUDGE_AFTER = 24 * 3600000
// He wrote this recently: he is in the conversation already, so nothing is started on Helper's own initiative.
export const ACTIVE_GAP = 20 * 60000
// Messages Helper sent on its own in a row with no answer from him. After this many it waits for him to write.
export const MAX_UNANSWERED = 2
// Two messages Helper starts on its own are at least this far apart (a check-in and a follow-up included).
export const MIN_GAP = 60 * 60000

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const sameText = (a, b) => clip(a, 200).toLowerCase() === clip(b, 200).toLowerCase()

const book = () => (state.loops ??= [])
const pace = () => (state.proactive ??= { lastUserAt: 0, unanswered: 0, lastOutAt: 0, followDay: '', followCount: 0 })

export function pruneLoops(now = Date.now()) {
  const before = book().length
  state.loops = book().filter((l) => now - (l.touchedAt || l.createdAt || 0) < LOOP_TTL)
  return before - state.loops.length
}

export const openLoops = (now = Date.now()) => (pruneLoops(now), book())

// when: local "YYYY-MM-DDTHH:MM" (or anything Date understands). A time in the past means "as soon as allowed".
export function addLoop(text, { when, kind = 'todo', now = Date.now() } = {}) {
  const t = clip(text, 200)
  if (!t) throw new Error('חסר תיאור')
  pruneLoops(now)
  const at = when ? new Date(when) : null
  if (at && isNaN(at)) throw new Error('זמן לא תקין, נדרש YYYY-MM-DDTHH:MM')
  const existing = book().find((l) => sameText(l.text, t))
  if (existing) {
    if (at) Object.assign(existing, { followUp: at.toISOString(), nudges: 0 })
    existing.touchedAt = now
    save()
    return { loop: existing, fresh: false }
  }
  if (book().length >= MAX_LOOPS) throw new Error(`יש כבר ${MAX_LOOPS} דברים פתוחים. צריך לסגור אחד קודם.`)
  const loop = { id: newId(), text: t, kind, createdAt: now, touchedAt: now, followUp: at ? at.toISOString() : null, nudges: 0 }
  book().push(loop)
  save()
  return { loop, fresh: true }
}

// By id, or by a piece of its text. Returns the loops it closed.
export function closeLoop(match) {
  const want = String(match ?? '').trim()
  if (!want) return []
  const hit = book().filter((l) => String(l.id) === want || l.text.includes(want))
  state.loops = book().filter((l) => !hit.includes(l))
  save()
  return hit
}

// Loops whose time to come back has come, oldest first.
export const dueLoops = (now = Date.now()) =>
  openLoops(now)
    .filter((l) => l.followUp && Date.parse(l.followUp) <= now && (l.nudges || 0) < MAX_NUDGES)
    .sort((a, b) => Date.parse(a.followUp) - Date.parse(b.followUp))

const whenText = (iso) => new Date(iso).toLocaleString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })

export const loopTool = {
  name: 'open_loop',
  description:
    'הפנקס של הדברים הפתוחים של המשתמש. add: כשהוא אומר שיטפל במשהו אחר כך, מחכה לתשובה ממישהו, או כשמשימה נשארה חצי גמורה. רשום בלי לשאול, עם follow_up_when כשברור מתי כדאי לחזור לזה (אחרת תבחר זמן הגיוני), ואמור לו בכמה מילים שתחזור לזה. close: ברגע שזה נסגר (הוא אמר שסיים, או שראית שזה קרה). list: מה פתוח.',
  parameters: obj(
    {
      action: { type: 'string', enum: ['add', 'close', 'list'] },
      text: str('add: מה פתוח, במשפט קצר שמובן גם בעוד שבוע ("לשלוח למורה לכימיה את העבודה"). close: מזהה או מילה מהתיאור'),
      follow_up_when: str('add: מתי לחזור לזה, זמן מקומי YYYY-MM-DDTHH:MM'),
    },
    ['action']
  ),
  run({ action, text, follow_up_when }) {
    if (action === 'list') {
      const list = openLoops()
      return list.length ? list.map((l) => `#${l.id} ${l.text}${l.followUp ? ` (חוזר לזה ב${whenText(l.followUp)})` : ''}`).join('\n') : 'אין כרגע דברים פתוחים'
    }
    if (action === 'close') {
      const hit = closeLoop(text)
      return hit.length ? `נסגר: ${hit.map((l) => l.text).join('; ')}` : 'לא נמצא דבר פתוח כזה'
    }
    if (action === 'add') {
      try {
        const { loop, fresh } = addLoop(text, { when: follow_up_when })
        return `${fresh ? 'נרשם' : 'כבר רשום, עודכן'} (#${loop.id})${loop.followUp ? `. אחזור לזה ב${whenText(loop.followUp)}` : ''}`
      } catch (e) {
        return e.message
      }
    }
    return 'פעולה לא מוכרת'
  },
}

// The standing rules, in the prompt on every turn.
export function proactiveRules(english) {
  return english
    ? `Proactive: make his life easier, not just answer. (1) After you answer, if there is an obvious next thing you can do for him with your tools (a reminder before the deadline, add it to the calendar, draft the reply, compare prices, follow up), offer it in one short line ending in a question ("רוצה ש...?"). At most one, concrete, about his stuff. Not after small talk, thanks, a quick fact or when he is in a rush, never a generic "עוד משהו?", never an offer he already turned down or ignored. (2) He says yes to your offer ("כן", "יאללה", "סגור", "תעשה") → do it now, no second question. (3) He will deal with something later, is waiting for someone, or a task stays half done → open_loop add without asking (with follow_up_when), and say in a few words you will come back to it. When it is done, open_loop close. (4) Something harmless and clearly wanted (a reminder he would obviously want): do it and say so, rather than ask.`
    : `יוזמה: התפקיד שלך הוא להקל עליו, לא רק לענות. (1) אחרי שענית, אם יש דבר הבא ברור שאתה יכול לעשות בשבילו עם הכלים שלך (תזכורת לפני ההגשה, להוסיף ליומן, לנסח את התשובה, להשוות מחירים, לחזור לזה), הצע אותו בשורה אחת קצרה שנגמרת בשאלה ("רוצה ש...?"). לכל היותר הצעה אחת, קונקרטית, על הדברים שלו. לא אחרי שיחת חולין, תודה, עובדה מהירה או כשהוא ממהר; אף פעם לא "עוד משהו?" כללי, ולא הצעה שהוא כבר דחה או התעלם ממנה. (2) הוא עונה כן להצעה ("כן", "יאללה", "סגור", "תעשה") → בצע מיד, בלי שאלה נוספת. (3) הוא אומר שיטפל במשהו אחר כך, מחכה למישהו, או שמשימה נשארת חצי גמורה → open_loop add בלי לשאול (עם follow_up_when), ותגיד בכמה מילים שתחזור לזה. כשזה נסגר, open_loop close. (4) דבר לא מזיק שברור שהוא רוצה (תזכורת שכל אחד היה רוצה): עשה ותגיד, במקום לשאול.`
}

// The open loops, for the prompt: so a message that settles one closes it, and nothing he left open is forgotten.
export function loopsBlock(english, now = Date.now()) {
  const list = openLoops(now)
  if (!list.length) return ''
  const lines = list.slice(-6).map((l) => `- #${l.id} ${l.text}${l.followUp ? ` (${english ? 'follow up' : 'לחזור'}: ${whenText(l.followUp)})` : ''}`)
  return `${english ? 'Open loops he left (close with open_loop when one is settled; do not list them unless it helps):' : 'דברים פתוחים שלו (סגור עם open_loop כשאחד נסגר; אל תפרט אותם סתם):'}\n${lines.join('\n')}`
}

// ── pacing: when Helper may start a conversation on its own ─────────────────
// Called for every message he writes: he answered, so the back-off resets.
export function noteUserMessage(now = Date.now()) {
  Object.assign(pace(), { lastUserAt: now, unanswered: 0 })
}

// Not in quiet hours is the caller's check. This one: he is not mid-conversation, Helper did not just write to him,
// and he answered the last ones.
export function mayReachOut(now = Date.now()) {
  const p = pace()
  if (now - (p.lastUserAt || 0) < ACTIVE_GAP) return false
  if (now - (p.lastOutAt || 0) < MIN_GAP) return false
  return (p.unanswered || 0) < MAX_UNANSWERED
}

export function markReachedOut(now = Date.now()) {
  const p = pace()
  p.unanswered = (p.unanswered || 0) + 1
  p.lastOutAt = now
  save()
}

const day = (now) => new Date(now).toLocaleDateString('en-CA')

// How many loop follow-ups may still go out today. FOLLOW_UPS_PER_DAY=0 turns them off.
export function followUpSlot(now = Date.now()) {
  const max = config.proactive?.followUpsPerDay ?? 3
  const p = pace()
  if (p.followDay !== day(now)) Object.assign(p, { followDay: day(now), followCount: 0 })
  return p.followCount < max
}

// Picks the loop to come back to now and books the attempt before it runs, so a crash cannot make it loop.
export function takeDueLoop(now = Date.now()) {
  if (!followUpSlot(now) || !mayReachOut(now)) return null
  const loop = dueLoops(now)[0]
  if (!loop) return null
  loop.nudges = (loop.nudges || 0) + 1
  loop.lastNudgeAt = now
  loop.followUp = loop.nudges < MAX_NUDGES ? new Date(now + RENUDGE_AFTER).toISOString() : null
  pace().followCount++
  save()
  return loop
}

export function followUpPrompt(loop) {
  return `[חזרה לדבר פתוח - יוזמה שלך, המשתמש לא כתב עכשיו.]
הדבר הפתוח (#${loop.id}, נרשם ב${whenText(loop.createdAt)}): ${loop.text}
${loop.nudges > 1 ? 'כבר שאלת עליו פעם אחת ולא נסגר. זאת הפעם האחרונה שאתה מעלה אותו.\n' : ''}קודם בדוק עם הכלים אם זה כבר נסגר (למשל הגיעה תשובה במייל, המטלה הוגשה, האירוע ביומן). אם נסגר: open_loop close והחזר בדיוק SKIP.
אם לא: כתוב לו הודעה אחת קצרה שמזכירה במה מדובר ומציעה דבר אחד קונקרטי שאתה יכול לעשות עכשיו כדי לסגור את זה ("רוצה שאנסח לה תזכורת?"). לא נאום, לא רשימה.
אם הוא כבר אמר שזה לא רלוונטי: open_loop close והחזר SKIP.`
}

// Added to the check-in instruction: what is open, so a check-in closes loops instead of making small talk.
export function checkInContext(now = Date.now()) {
  const parts = []
  const list = openLoops(now)
  if (list.length) parts.push(`דברים פתוחים שלו:\n${list.slice(-6).map((l) => `- #${l.id} ${l.text}`).join('\n')}`)
  const plan = state.plan
  if (plan?.steps?.some((s) => s.status === 'pending' || s.status === 'doing')) parts.push(`משימה שהתחלתם ולא נגמרה: ${plan.goal}`)
  const hw = state.homework?.open || []
  if (hw.length) parts.push(`מטלות שעוד לא הוגשו: ${hw.slice(0, 4).map((w) => `${w.title} (${w.due})`).join('; ')}`)
  if (!parts.length) return ''
  return `\n\nמה שפתוח אצלו עכשיו (הכי טוב להציע לסגור אחד מאלה, עם דבר קונקרטי שאתה יכול לעשות):\n${parts.join('\n')}`
}
