import { config, mailEnabled } from './config.js'
import { state } from './store.js'
import { googleAccounts } from './google.js'
import { calendarOn } from './calendar.js'
import { canHear, canSpeak } from './media.js'
import { chatModel } from './llm.js'
import { bridgeLabel } from './pc-bridge.js'

export function ago(ts) {
  if (!ts) return 'עוד לא נבדק'
  const min = Math.round((Date.now() - ts) / 60000)
  if (min < 1) return 'לפני פחות מדקה'
  if (min < 60) return `לפני ${min} דק׳`
  if (min < 48 * 60) return `לפני ${Math.round(min / 60)} שעות`
  return `לפני ${Math.round(min / 1440)} ימים`
}

// One line per source, saying when it last actually answered. "Connected" alone would hide a source that
// stopped working an hour ago.
function sourceLine(label, key) {
  const h = state.health[key]
  if (!h) return `• ${label}: עוד לא נבדק`
  if (h.down) return `• ⚠️ ${label}: לא עובד. הצלחה אחרונה: ${ago(h.lastOk)}`
  return `• ${label}: נבדק בהצלחה ${ago(h.lastOk)}${h.fails ? ` (${h.fails} כישלונות מאז)` : ''}`
}

export function status(connectedSince) {
  const google = googleAccounts()
  const time = (iso) => new Date(iso).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
  const lines = [
    `*${config.botName}* | מודל: ${chatModel()}${config.llm.cheapModel ? ` | רקע: ${config.llm.cheapModel}` : ''}`,
    `וואטסאפ: ${connectedSince ? `מחובר ברצף ${ago(connectedSince).replace('לפני ', '')}` : 'לא מחובר'} | אזור זמן: ${process.env.TZ}`,
    `הודעות קוליות: ${canHear() ? 'מבין' : 'כבוי'}${canSpeak() ? ' ועונה בקול' : ''} | מחשב: ${config.computerMode}${bridgeLabel()} | GitHub: ${config.githubToken ? 'מחובר' : 'לא מחובר'}`,
    `שעות שקט: ${process.env.QUIET_HOURS?.trim() || 'כבוי'}${state.outbox.length ? ` | ${state.outbox.length} הודעות ממתינות לשליחה` : ''}`,
    '',
    '*מקורות*',
    ...google.flatMap((a) => [sourceLine(`Gmail ${a}`, `gmail ${a}`), sourceLine(`Classroom ${a}`, `classroom ${a}`)]),
    ...(mailEnabled() ? config.mail.accounts.map((a) => sourceLine(`מייל ${a.user}`, `mail ${a.user}`)) : []),
    calendarOn() ? `• יומן: נבדק ${ago(state.calendar.lastPoll)}` : '• יומן: לא מחובר',
    !google.length && !mailEnabled() && '• אין חשבון מייל מחובר',
    '',
    `*תזכורות (${state.reminders.length})*`,
    ...state.reminders.slice(0, 10).map((r) => `• ${r.text} - ${time(r.at)}${r.repeat !== 'none' ? ` (${r.repeat})` : ''}`),
    `*משימות מתוזמנות (${state.tasks.length})*`,
    ...state.tasks.slice(0, 10).map((t) => `• ${t.instruction.slice(0, 60)} - ${time(t.at)}${t.repeat !== 'none' ? ` (${t.repeat})` : ''}`),
    `*מעקבים (${state.watchers.length})*`,
    ...state.watchers.map((w) => `• ${(w.fails || 0) >= 3 ? '⚠️ ' : ''}${w.name}: ${w.lastValue} | נבדק בהצלחה ${ago(w.lastOk)}, כל ${w.intervalMin} דק׳`),
    `*מטלות שלא הוגשו (${state.homework.open.length})*`,
    ...state.homework.open.slice(0, 10).map((w) => `• ${w.title} (${w.course}) - ${w.due}`),
    `*זיכרון:* ${state.memory.length} עובדות`,
  ]
  return lines.filter((l) => l !== false).join('\n')
}
