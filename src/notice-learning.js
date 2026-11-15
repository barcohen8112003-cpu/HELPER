// Which of Helper's own notices deserve to buzz the phone. This is separate from follow-ups (src/proactive.js):
// that module's state.proactive pacing is never read or written here. Scores live in state.notices.
//
// Off by default (NOTICE_LEARNING is not "true"): every notice is sent exactly as before. The only change then
// is an explicit request, "תפסיק לשלוח לי חדשות" / "תחזור לשלוח", which mutes or restores that kind.
// With NOTICE_LEARNING=true, a kind the owner keeps ignoring moves down one step (send now -> next brief ->
// dropped) and gets one probe a week, so it can come back. Urgent messages and the protected kinds below are
// never touched, including loop follow-ups.
import { state, save } from './store.js'

const MIN = 60000
const DAY = 24 * 3600000
export const ENGAGED_WITHIN = 60 * MIN // a message of the owner within this long after a notice counts as a reaction
export const DEMOTE_AFTER = 3 // ignored in a row -> one step quieter
export const DROP_AFTER = 6 // ignored in a row -> dropped
const DECAY_EVERY = 7 * DAY // every week without a live send forgives three ignores, so the kind gets a probe
// loop: a follow-up from src/proactive.js. Its own pacing decides whether it goes out.
const PROTECTED = new Set(['cost-month', 'reminder', 'loop'])

export const learningOn = () => String(process.env.NOTICE_LEARNING || '').trim() === 'true'

export const KIND_LABELS = {
  news: 'חדשות הבוקר',
  weekly: 'הסיכום השבועי',
  'homework-new': 'מטלות חדשות',
  'homework-day': 'תזכורות הגשה',
  'homework-morning': 'תזכורות הגשה',
  checkin: 'בדיקות מיוזמתי',
}
// The words a person says, mapped to the kinds they cover.
const WORDS = [
  [/חדשות/, ['news']],
  [/(סיכום )?שבועי/, ['weekly']],
  [/(מטלות|שיעורי בית|classroom|קלאסרום)/i, ['homework-new', 'homework-day', 'homework-morning']],
  [/הגשה/, ['homework-day', 'homework-morning']],
  [/(בדיקות|הודעות יזומות|מיוזמתך|מיוזמתי)/, ['checkin']],
]

const store = () => (state.notices ??= { kinds: {}, pending: [], muted: [] })
const row = (kind) => (store().kinds[kind] ??= { sent: 0, answered: 0, streak: 0, lastAt: 0 })

// 'homework-new:abc' -> 'homework-new'; no key and no name -> 'general'.
export const kindOf = (key, name) => name || (key ? String(key).split(':')[0] : 'general')

// Pending notices older than the window were ignored.
function settle(now) {
  const p = store()
  const stale = p.pending.filter((n) => now - n.at >= ENGAGED_WITHIN)
  if (!stale.length) return
  for (const n of stale) row(n.kind).streak++
  p.pending = p.pending.filter((n) => now - n.at < ENGAGED_WITHIN)
}

// The owner wrote something: every notice sent inside the window gets credit, and its ignore count starts over.
export function noticeEngaged(now = Date.now()) {
  if (!state.notices && !learningOn()) return
  const p = store()
  settle(now)
  if (!p.pending.length) return
  for (const n of p.pending) Object.assign(row(n.kind), { streak: 0, answered: row(n.kind).answered + 1 })
  p.pending = []
  save()
}

// A non-urgent notice went out to the phone right now.
export function noticeSent(kind, now = Date.now()) {
  if (!learningOn() || PROTECTED.has(kind)) return
  settle(now)
  const r = row(kind)
  r.sent++
  r.lastAt = now
  store().pending.push({ kind, at: now })
  store().pending = store().pending.slice(-50)
  save()
}

const effectiveStreak = (r, now) => Math.max(0, r.streak - DEMOTE_AFTER * Math.floor((now - r.lastAt) / DECAY_EVERY))

// 'interrupt' = send now, 'batch' = wait for the next brief, 'drop' = say nothing.
export function noticeLevel(kind, urgent = false, now = Date.now()) {
  if (urgent || PROTECTED.has(kind)) return 'interrupt'
  if ((state.notices?.muted || []).includes(kind)) return 'drop'
  // Automatic quieting is opt-in. Until then a notice is sent the way it always was.
  if (!learningOn()) return 'interrupt'
  const p = store()
  settle(now)
  const r = p.kinds[kind]
  if (!r || !r.lastAt) return 'interrupt'
  const s = effectiveStreak(r, now)
  return s >= DROP_AFTER ? 'drop' : s >= DEMOTE_AFTER ? 'batch' : 'interrupt'
}

// "תפסיק לשלוח לי הודעות על חדשות" / "תחזור לשלוח לי חדשות" / "מה אתה שולח לי". Null when it is not about notices.
export function parseNoticeCommand(text) {
  const t = String(text || '').trim().replace(/[.!?]+$/, '')
  if (/^(מה (אתה )?שולח לי|סטטוס הודעות|מצב הודעות)$/.test(t)) return { action: 'status' }
  const m = t.match(/^(תפסיק|תפסיקי|הפסק|תחזור|תחזרי|חזור)( לשלוח)?( לי)?( הודעות| עדכונים)?( על| של)? (.+)$/)
  if (!m) return null
  const on = /^(תחזור|תחזרי|חזור)/.test(m[1])
  if (!on && !m[2] && !m[4]) return null
  const kinds = [...new Set(WORDS.filter(([re]) => re.test(m[6])).flatMap(([, k]) => k))]
  return kinds.length ? { action: on ? 'unmute' : 'mute', kinds } : null
}

export function runNoticeCommand(cmd) {
  const p = store()
  if (cmd.action === 'status') return noticeStatus()
  const names = [...new Set(cmd.kinds.map((k) => KIND_LABELS[k] || k))].join(', ')
  if (cmd.action === 'mute') {
    p.muted = [...new Set([...p.muted, ...cmd.kinds])]
    save()
    return `סבבה, לא אשלח יותר: ${names}. כדי להחזיר: "תחזור לשלוח ${names.split(', ')[0]}".`
  }
  p.muted = p.muted.filter((k) => !cmd.kinds.includes(k))
  for (const k of cmd.kinds) if (p.kinds[k]) p.kinds[k].streak = 0
  save()
  return `חזרתי לשלוח: ${names}.`
}

export function noticeStatus(now = Date.now()) {
  const p = store()
  settle(now)
  const lines = Object.entries(p.kinds)
    .filter(([k, r]) => r.sent && !PROTECTED.has(k))
    .map(([k, r]) => {
      const level = noticeLevel(k, false, now)
      const how = p.muted.includes(k) ? 'מושתק' : level === 'interrupt' ? 'נשלח מיד' : level === 'batch' ? 'רק בסיכום' : 'לא נשלח'
      return `• ${KIND_LABELS[k] || k}: ${how} (נשלחו ${r.sent}, הגבת ל-${r.answered})`
    })
  const muted = p.muted.filter((k) => !p.kinds[k]?.sent).map((k) => `• ${KIND_LABELS[k] || k}: מושתק`)
  const all = [...lines, ...muted]
  return all.length ? `ככה אני מתנהג עם הודעות יזומות:\n${all.join('\n')}` : 'עוד לא שלחתי הודעות יזומות שמהן אפשר ללמוד.'
}
