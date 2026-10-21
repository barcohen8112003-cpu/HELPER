// The last pass over every reply before it is sent: removes the stock phrases that make a message read like a bot
// (call-center openers, "anything else?" closers), and turns Markdown the model sometimes writes into WhatsApp
// formatting. It only trims and reformats; it never rewrites what the reply says. The voice itself is in persona.md.

// Whole openers, at the very start of a reply, with the punctuation after them.
const OPENERS = [
  'בטח', 'כמובן', 'בהחלט', 'בשמחה', 'בכיף', 'אין בעיה', 'אשמח לעזור', 'אשמח לעזור לך', 'שאלה מצוינת', 'שאלה טובה', 'שאלה מעולה',
  'הבנתי', 'הבנתי אותך', 'קיבלתי', 'Sure', 'Of course', 'Certainly', 'Absolutely', 'Great question', 'Good question',
]
const OPENER = new RegExp(`^(?:${OPENERS.map(escape).join('|')})(?:\\s*[!.,:]+\\s*(?:😊|🙂)?|\\s+(?:😊|🙂))\\s*`, 'u')

// A last line made only of an offer to keep chatting, or of hoping it helped.
const CLOSER = new RegExp(
  '^(?:' +
    [
      'עוד משהו', 'יש עוד משהו(?: ש)?(?:אוכל|אפשר)(?: לעזור| לעשות)?(?: בו| לך)?', 'במה עוד אוכל לעזור(?: לך)?', 'צריך עוד משהו',
      '(?:אם )?(?:תצטרך|צריך|תרצה) (?:עוד )?(?:משהו|עזרה)(?: נוסף| נוספת)?,? (?:אני כאן|תגיד|רק תגיד|אני פה|אשמח לעזור)',
      'תגיד(?: לי)? אם (?:צריך|תצטרך|תרצה) (?:עוד )?(?:משהו|עזרה)(?: נוסף| נוספת)?', 'אשמח לעזור (?:בכל|עם כל) (?:דבר|שאלה) (?:נוסף|נוספת)',
      'מקווה שזה (?:עוזר|עזר|עוזר לך|עזר לך)', 'Let me know if you need anything else', 'Hope this helps', 'Anything else',
    ].join('|') +
    ')\\s*[!?.]*\\s*(?:😊|🙂|🙏)?\\s*$',
  'u'
)

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Markdown that WhatsApp shows as raw symbols, turned into what WhatsApp renders.
function whatsappFormat(text) {
  return text
    .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, (_, title) => `*${title.replace(/\*+/g, '')}*`)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^(\s*)[-*]\s+(?=\S)/gm, '$1• ')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => (label === url ? url : `${label}: ${url}`))
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
}

// One block of prose (never code).
function polishProse(text, { first, last }) {
  let out = whatsappFormat(text)
    // A spaced dash between clauses is the clearest machine tell in Hebrew text; people write a comma there.
    .replace(/ [—–] /g, ', ')
  if (first) out = out.replace(OPENER, '')
  if (last) {
    const lines = out.replace(/\s+$/, '').split('\n')
    while (lines.length > 1 && CLOSER.test(lines.at(-1).trim())) lines.pop()
    // The same offer tacked onto the end of the last sentence.
    lines[lines.length - 1] = lines.at(-1).replace(/\s+(?:עוד משהו|צריך עוד משהו|במה עוד אוכל לעזור)\s*\?\s*(?:😊|🙂)?\s*$/u, '')
    out = lines.join('\n')
  }
  return out
}

export function polish(reply) {
  if (typeof reply !== 'string' || !reply.trim() || /^SKIP\b/.test(reply.trim())) return reply
  // Code blocks pass through untouched.
  const parts = reply.split(/(```[\s\S]*?```)/g)
  const prose = parts.map((p, i) => ({ p, i })).filter(({ p }) => !p.startsWith('```'))
  const firstProse = prose[0]?.i
  const lastProse = prose.at(-1)?.i
  const out = parts
    .map((p, i) => (p.startsWith('```') ? p : polishProse(p, { first: i === firstProse && i === 0, last: i === lastProse && i === parts.length - 1 })))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // Never polish a reply into nothing.
  return out || reply.trim()
}

// A failure as Naor should read it: plain words and what to do, never a raw HTTP code or stack message.
// Messages already written in Hebrew for him pass through.
export function humanError(e) {
  const msg = String(e?.message || e || '')
  if (/LLM HTTP (?:5\d\d|429)/.test(msg)) return 'המודל עמוס כרגע ולא ענה. נסה שוב בעוד דקה.'
  if (/LLM HTTP 40[13]/.test(msg)) return 'המפתח של מודל ה-AI לא עובד (פג או שגוי). אפשר לעדכן אותו באתר ההגדרות, בכרטיס "מודל AI".'
  if (/HTTP \d{3}|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|aborted due to timeout|TimeoutError/i.test(msg))
    return 'שירות חיצוני לא ענה, אז לא הצלחתי לסיים. נסה שוב בעוד רגע.'
  if (/[\u0590-\u05FF]/.test(msg)) return msg
  return 'משהו השתבש ולא הצלחתי לסיים. נסה שוב, ואם זה חוזר, תגיד לי מה ביקשת.'
}

// What still reads like a bot after polishing, for the style check set (src/style-selftest.js).
const TELLS = [/כמודל שפה/, /אני (?:רק )?(?:מודל|בינה מלאכותית|AI)\b/, /חשוב לציין ש/, /בסופו של דבר,/, /לסיכום,/, /אשמח לעזור/, /במה אוכל לעזור/, /^#{1,6} /m, /\*\*/, / [—–] /]
export const styleTells = (text) => TELLS.filter((r) => r.test(text)).map((r) => r.source)
