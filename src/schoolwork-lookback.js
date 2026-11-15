// One-time (and retried) lookback: homework from a school WhatsApp group over the last two weeks,
// written into the homework list and the Google Sheet. Historical items are not announced one-by-one.
import * as groups from './groups.js'

export const LOOKBACK_DAYS = 14

// Messages that look like homework, already extracted as items, for the watched school groups.
export function collectedHomework(nowMs = Date.now(), days = LOOKBACK_DAYS) {
  const wanted = String(process.env.SCHOOLWORK_GROUPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!wanted.length) return []
  const since = nowMs - days * 86400000
  const s = groups.load()
  const out = []
  for (const i of s.items || []) {
    if (i.type !== 'homework') continue
    if ((i.at || 0) < since && !(i.date && i.date >= ymd(new Date(since)))) continue
    const name = s.groups[i.g]?.name || ''
    if (!name || s.groups[i.g]?.muted) continue
    if (!wanted.some((q) => groups.groupNameMatches(name, q))) continue
    out.push(i)
  }
  return out
}

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function entriesFromItems(items) {
  const s = groups.load()
  return items.map((i) => ({
    sourceId: `${i.id}:${i.at}`,
    title: i.shortTitle || i.title,
    detail: i.title,
    course: s.groups[i.g]?.name || '',
    due: i.date ? { day: i.date, time: i.time || null } : null,
    confidence: i.date ? 'medium' : 'low',
    receivedAt: i.at,
  }))
}

export function groupJidFor(query) {
  const q = String(query || '').trim()
  if (!q) return ''
  const s = groups.load()
  const hits = Object.entries(s.groups || {}).filter(([, g]) => g.name && groups.groupNameMatches(g.name, q) && !g.muted)
  return hits.length === 1 ? hits[0][0] : hits.sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0))[0]?.[0] || ''
}

export function oldestCursor(jid) {
  const buf = (groups.load().buffer || []).filter((m) => m.g === jid && m.id && m.at)
  if (!buf.length) return null
  const oldest = buf.slice().sort((a, b) => a.at - b.at)[0]
  // Baileys wants the key of the oldest message we already have, and its time in ms.
  return { id: oldest.id, fromMe: false, at: oldest.at }
}

// For a details refresh: start from the newest buffered message so WhatsApp
// re-sends the recent homework messages (including photos), not only older ones.
export function newestCursor(jid) {
  const buf = (groups.load().buffer || []).filter((m) => m.g === jid && m.id && m.at)
  if (!buf.length) return null
  const newest = buf.slice().sort((a, b) => b.at - a.at)[0]
  return { id: newest.id, fromMe: false, at: newest.at }
}

// deps: {
//   fetchHistory(jid, { count, oldest, timeoutMs }) => Promise<{ timedOut?, n? }>,
//   extract() => Promise<items>,
//   holdPurge(on),
// }
export async function pullHistory(deps, nowMs = Date.now()) {
  const wanted = String(process.env.SCHOOLWORK_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!wanted.length || !deps.fetchHistory) return { pulled: false, reason: 'no-fetch' }
  const results = []
  deps.holdPurge?.(true)
  try {
    for (const q of wanted) {
      const jid = groupJidFor(q)
      if (!jid) {
        results.push({ group: q, pulled: false, reason: 'unknown-group' })
        continue
      }
      const oldest = deps.fromNewest ? (newestCursor(jid) || oldestCursor(jid)) : oldestCursor(jid)
      if (!oldest) {
        results.push({ group: q, pulled: false, reason: 'no-cursor' })
        continue
      }
      try {
        const DETAIL = /עמוד(?:ים)?|עמ[׳']\.?|שאלה|שאלות|סעיף|סעיפים|תרגיל/
        const resend = (groups.load().buffer || [])
          .filter((m) => m.g === jid && m.id && /שיעורי\s*בית/.test(m.text || '') && !DETAIL.test(m.text || ''))
          .map((m) => ({ id: m.id, fromMe: false, s: m.s }))
        const got = await deps.fetchHistory(jid, { count: 300, oldest, timeoutMs: deps.timeoutMs || 45000, resend })
        const ok = Boolean(got?.pulled)
        results.push({ group: q, pulled: ok, timedOut: Boolean(got?.timedOut), n: got?.n || 0, reason: got?.reason || '' })
        console.log(`[schoolwork] history ${q}: n=${got?.n || 0} pulled=${ok} reason=${got?.reason || (got?.timedOut ? 'timeout' : 'ok')}`)
      } catch (e) {
        results.push({ group: q, pulled: false, reason: e.message || 'fetch-failed' })
        console.log(`[schoolwork] lookback fetch: ${e.message}`)
      }
    }
    const fresh = deps.extract ? await deps.extract(nowMs).catch((e) => (console.log(`[schoolwork] lookback extract: ${e.message}`), [])) : []
    return { pulled: results.some((r) => r.pulled), results, extracted: fresh.length }
  } finally {
    deps.holdPurge?.(false)
  }
}
