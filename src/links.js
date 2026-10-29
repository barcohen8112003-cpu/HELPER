// Links in a reply that no tool opened this turn come from the model's memory, and a dead one turns Naor into the
// tester. Before a chat reply goes out, each such link is opened once; one that does not open is taken out, with
// one plain line saying so. Links a tool returned (search results, pages it read, settings site) pass untouched.
const URL_RE = /https?:\/\/[^\s<>"'()\[\]]+[^\s<>"'()\[\].,;:!?]/g
const MAX_CHECKS = 4
const TIMEOUT = 6000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export const urlsIn = (text) => [...new Set(String(text || '').match(URL_RE) || [])]

// A link the turn already "saw": it is in a tool result, his message, or the prompt the code wrote.
const seenIn = (url, seen) => seen.includes(url) || seen.includes(url.replace(/\/$/, ''))

// true = opens, false = dead. A site that answers at all but refuses robots (401/403/405/429) still exists.
export async function linkOpens(url, fetchFn = fetch) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetchFn(url, { method, redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT) })
      if (res.ok || [401, 403, 429].includes(res.status)) return true
      if (method === 'HEAD' && [405, 501, 400].includes(res.status)) continue
      return false
    } catch {
      if (method === 'GET') return false
    }
  }
  return false
}

// reply: what the model wrote. seen: all text the turn already has (tool results, his message).
export async function checkLinks(reply, seen = '', { fetchFn = fetch, offline = process.env.HELPER_OFFLINE === '1' } = {}) {
  if (typeof reply !== 'string' || offline) return reply
  const unknown = urlsIn(reply).filter((u) => !seenIn(u, seen)).slice(0, MAX_CHECKS)
  if (!unknown.length) return reply
  const results = await Promise.all(unknown.map(async (u) => [u, await linkOpens(u, fetchFn)]))
  const dead = results.filter(([, ok]) => !ok).map(([u]) => u)
  if (!dead.length) return reply
  for (const u of dead) console.log(`[links] removed a link that does not open: ${u}`)
  const out = reply
    .split('\n')
    .map((line) => {
      if (!dead.some((u) => line.includes(u))) return line
      let l = line
      for (const u of dead) l = l.split(u).join('')
      l = l.replace(/[\s:\-–,]+$/u, '')
      // Nothing left but a bullet, an emoji or a short label ("וגם:", "הנה"): the line was only the link.
      const words = l.replace(/^[\s•*\-]+/u, '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
      return words.length > 2 ? l : null
    })
    .filter((l) => l !== null)
    .join('\n')
    .trim()
  return `${out}\n${dead.length > 1 ? 'כמה קישורים לא נפתחו לי, אז הורדתי אותם.' : 'הקישור לא נפתח לי, אז הורדתי אותו.'}`.trim()
}
