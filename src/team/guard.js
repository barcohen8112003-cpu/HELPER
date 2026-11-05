// Shared guards for the team (src/team/). Worker text and tool data are untrusted: a phrase that reads like an
// order is dropped, and JSON is taken only from the first object in the reply.

export const INJECTION = /ignore (all |any |your |the )?(previous|prior|above)|disregard (the |your )?(rules|instructions)|system prompt|you are now|התעלם מ|תתעלם מ|הוראות חדשות|send_(whatsapp|mail|message)|שלח הודעה|תשלח הודעה|\bapproved?\b|אושר|book (it|now)|הזמן עכשיו|transfer money/i

export const clean = (s, max = 400) => String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').slice(0, max)

export function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}
