// "תשאל את ג'מיני": one question to Google's Gemini through its official API, answer back as text.
// The key comes from Google AI Studio (aistudio.google.com/apikey) and lives in .env as GEMINI_API_KEY.
import { config } from './config.js'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
const MAX_QUESTION = 8000
const MAX_ANSWER = 6000

export const geminiApiEnabled = () => Boolean(config.geminiApi.key)

// Returns Gemini's answer as plain text. Throws with a short Hebrew reason.
// search: let Gemini look things up on the web while it answers. maxChars: how much of the answer to keep.
export async function askGemini(question, { fetchFn = fetch, search = false, maxChars = MAX_ANSWER } = {}) {
  const q = String(question || '').trim()
  if (!q) throw new Error('אין שאלה')
  if (!geminiApiEnabled()) throw new Error('Gemini לא מחובר. צריך להדביק מפתח באתר ההגדרות, בכרטיס Gemini (או GEMINI_API_KEY ב-.env)')
  const url = `${ENDPOINT}/${encodeURIComponent(config.geminiApi.model)}:generateContent`
  const call = (withSearch) =>
    fetchFn(url, {
      method: 'POST',
      // The key travels in a header, never in the address, so it does not end up in logs.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApi.key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: q.slice(0, MAX_QUESTION) }] }], ...(withSearch && { tools: [{ google_search: {} }] }) }),
      signal: AbortSignal.timeout(120000),
    })
  let res = await call(search)
  // A model that does not offer web search answers 400 to it: the question is asked again without.
  if (search && res.status === 400) res = await call(false)
  if (!res.ok) {
    if (res.status === 400 || res.status === 403) throw new Error(`Gemini דחה את הבקשה (${res.status}). כנראה המפתח לא תקין או לא הופעל`)
    if (res.status === 404) throw new Error(`המודל ${config.geminiApi.model} לא קיים. בדוק את GEMINI_MODEL`)
    if (res.status === 429) throw new Error('נגמרה המכסה של Gemini לעכשיו. נסה שוב בעוד כמה דקות')
    throw new Error(`Gemini החזיר שגיאה ${res.status}`)
  }
  const data = await res.json()
  const candidate = data.candidates?.[0]
  if (!candidate) throw new Error(data.promptFeedback?.blockReason ? 'Gemini סירב לענות על השאלה הזאת' : 'Gemini לא החזיר תשובה')
  const text = (candidate.content?.parts || []).map((p) => p.text || '').join('').trim()
  if (!text) throw new Error(candidate.finishReason === 'SAFETY' ? 'Gemini סירב לענות על השאלה הזאת' : 'Gemini החזיר תשובה ריקה')
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}
