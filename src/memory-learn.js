// Learns lasting facts from what the user writes, as candidates the user must approve (see memory.js).
//
// Two rules keep this from becoming a way to poison the memory:
//  - the only input is the user's own message. Web pages, mail, files and tool results never reach this module;
//  - nothing is saved here. A candidate becomes a fact only through memory_confirm, which the user approves.
import { config } from './config.js'
import { addCandidate, CATEGORIES, looksSecret } from './memory.js'

const MIN_CHARS = 18
const MAX_CHARS = 1500
const MIN_GAP_MS = 20_000

// Cheap pre-filter: most messages ("תזכיר לי מחר ב-8", "מה השעה") carry nothing worth remembering, and every
// extraction is a model call. These are the first-person and "lasting" markers of Hebrew and English statements.
const SIGNAL = /(\bאני\b|\bשלי\b|\bאצלי\b|קוראים לי|נולדתי|גר ב|גרה ב|לומד|לומדת|עובד ב|עובדת ב|אוהב|אוהבת|שונא|שונאת|מעדיף|מעדיפה|אלרגי|צמחוני|טבעוני|יש לי|החבר שלי|החברה שלי|אח שלי|אחות שלי|אמא שלי|אבא שלי|המורה|המבחן|תמיד|בדרך כלל|כל יום|כל בוקר|\bI am\b|\bI'm\b|\bmy\b|\bI like\b|\bI love\b|\bI hate\b|\bI live\b|\bI work\b|\bI study\b)/i

let lastRun = 0

export const worthLearningFrom = (text) => {
  const t = String(text || '').trim()
  return t.length >= MIN_CHARS && t.length <= MAX_CHARS && SIGNAL.test(t) && !t.startsWith('/')
}

const INSTRUCTIONS = `אתה מחלץ עובדות לטווח ארוך על המשתמש מתוך הודעה אחת שהוא כתב.
החזר JSON בלבד: מערך של עד 3 אובייקטים {"fact": string, "category": string, "importance": 1-5}.
קטגוריות: ${CATEGORIES.join(', ')}.
כללים:
- רק דברים שנשארים נכונים הרבה זמן (שם, מקום מגורים, לימודים, העדפות, אנשים קרובים, שגרה קבועה, מטרות, אלרגיות). לא אירועים חד-פעמיים, לא תכניות ליום מסוים, לא שאלות.
- כל עובדה במשפט קצר אחד בעברית, בגוף שלישי ("אוהב קפה שחור", "לומד מדעי המחשב").
- importance 5 רק לדברים קריטיים כמו שם ואלרגיות; 3 ברירת מחדל.
- לעולם לא סיסמאות, קודים, מפתחות, מספרי זהות או כרטיס.
- אם אין שום דבר ששווה לזכור: []`

// Pulls the JSON array out of a model reply that may wrap it in text or a code fence.
export function parseFacts(reply) {
  const m = String(reply || '').match(/\[[\s\S]*\]/)
  if (!m) return []
  try {
    const list = JSON.parse(m[0])
    return Array.isArray(list) ? list.filter((x) => x && typeof x.fact === 'string').slice(0, 3) : []
  } catch {
    return []
  }
}

// `askFn(system, user) => string` is injectable so tests never call a model. Returns the candidates it queued.
export async function learnFrom(userText, { askFn, now = Date.now(), force = false } = {}) {
  if (!force && (config.llm?.light || config.memoryLearn === false)) return []
  if (!worthLearningFrom(userText)) return []
  if (!force && now - lastRun < MIN_GAP_MS) return []
  lastRun = now
  const ask = askFn ?? (await import('./llm.js')).ask
  const proposed = []
  for (const item of parseFacts(await ask(INSTRUCTIONS, userText))) {
    if (looksSecret(item.fact)) continue
    try {
      const r = addCandidate(item.fact, { category: item.category, importance: item.importance, now })
      if (r.status === 'proposed') proposed.push({ id: r.id, fact: item.fact })
    } catch {
      // A fact that fails the checks (too long, looks like a secret) is simply not proposed.
    }
  }
  return proposed
}

// For tests: forget the rate-limit clock.
export const _resetLearnClock = () => {
  lastRun = 0
}
