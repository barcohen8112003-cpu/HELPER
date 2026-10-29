// Every chat message Naor sends gets an answer. This keeps a small ledger of the messages that went into the queue
// (id, time, first words) and whether an answer left, so a message that never got one is noticed within minutes:
// a log line, and one short note to him, instead of silence. Pure: the caller passes the list it keeps in state.
const KEEP = 50

const clip = (text) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > 40 ? `${t.slice(0, 40)}…` : t
}
const hhmm = (ms) => new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })

export function received(list, id, text, at = Date.now()) {
  if (!id || list.some((e) => e.id === id)) return list
  console.log(`[inbox] in ${id} "${clip(text)}"`)
  return [...list, { id, text: clip(text), at, answered: false, alerted: false }].slice(-KEEP)
}

// how: 'reply', 'reaction', 'error', 'stopped', 'skipped'. Anything that ends the wait counts.
export function answered(list, id, how = 'reply', now = Date.now()) {
  const e = list.find((x) => x.id === id)
  if (!e || e.answered) return list
  e.answered = true
  e.how = how
  console.log(`[inbox] answered ${id} by ${how} after ${Math.round((now - e.at) / 1000)}s`)
  return list
}

// Messages still waiting after `minutes`, each returned once (marked alerted), with the note to send him.
// `busy`: a turn is running right now, so a waiting message is in the queue behind it, not lost.
// `active`: the id of the message that turn is answering; it is being worked on, just slowly.
export function overdue(list, { minutes = 5, now = Date.now(), busy = false, active = null } = {}) {
  if (!minutes) return []
  const late = list.filter((e) => !e.answered && !e.alerted && now - e.at >= minutes * 60000)
  return late.map((e) => {
    e.alerted = true
    console.log(`[inbox] no answer to ${e.id} from ${hhmm(e.at)} after ${Math.round((now - e.at) / 60000)} min${busy ? ' (a turn is still running)' : ''}`)
    const quote = e.text ? ` ("${e.text}")` : ''
    return {
      id: e.id,
      text: e.id === active
        ? `עוד עובד על זה, לוקח יותר זמן מהרגיל. אני כאן.`
        : busy
        ? `עוד עובד על משהו קודם, ההודעה שלך מ-${hhmm(e.at)}${quote} בתור ואני עונה עליה מיד אחריו.`
        : `ההודעה שלך מ-${hhmm(e.at)}${quote} נתקעה אצלי ולא עניתי עליה. תשלח אותה שוב?`,
    }
  })
}

// What a chat turn sends when the model came back with nothing: a short question, never silence.
export const NO_ANSWER = 'לא הבנתי עד הסוף, על מה מדובר?'
