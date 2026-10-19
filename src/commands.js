// Plain-language commands typed by the owner in WhatsApp. They are matched on the whole message, never inside a
// sentence: "תעצור את השיר" is a request for the model, only "עצור" on its own stops the assistant itself.
const STOP = new Set(['עצור', 'תעצור', 'עצרי', 'עצור עצור', 'stop', '/stop', 'תפסיק לחשוב', 'הפסק'])
const NEW_CONVERSATION = new Set(['שיחה חדשה', 'תתחיל שיחה חדשה', 'התחל שיחה חדשה', 'נקה שיחה', 'new chat', '/new', '/reset'])

// Trailing punctuation, emoji and extra spaces do not change what was meant.
const normalize = (text) =>
  String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+$/u, '')
    .replace(/\s+/g, ' ')

// 'stop' | 'new' | null
export function parseCommand(text) {
  const t = normalize(text)
  if (STOP.has(t)) return 'stop'
  if (NEW_CONVERSATION.has(t)) return 'new'
  return null
}
