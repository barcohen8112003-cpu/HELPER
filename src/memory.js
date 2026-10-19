// Long-term memory about the user.
//
// What a plain list of facts gets wrong, and what this does about it:
//  - Every fact was pasted into every prompt, so the prompt grew with the memory. Now only the facts that matter to
//    the message at hand are included (relevance + importance + recency), and the rest stay one tool call away.
//  - The same thing was stored again and again, and a changed fact lived next to the old one. Now a new fact is
//    compared with the old ones: a duplicate is dropped, a near-match updates the old fact in place.
//  - It only remembered what it was told to. Facts the user mentions in passing become *candidates* (memory-learn.js)
//    that are saved only after the user approves them.
//  - Secrets must never end up here. Anything that looks like a password, key, card or ID number is refused.
//
// Records stay compatible with the old { id, fact } shape.
import { state, save, newId } from './store.js'

export const CATEGORIES = ['preference', 'person', 'school', 'routine', 'goal', 'health', 'tech', 'other']
const MAX_FACTS = 300
const MAX_CANDIDATES = 20
const FACT_MIN = 4
const FACT_MAX = 200

// ── text handling ───────────────────────────────────────────────────────────

const NIQQUD = /[֑-ׇ]/g
const STOP = new Set(['את', 'של', 'על', 'עם', 'אני', 'הוא', 'היא', 'זה', 'זו', 'לא', 'כן', 'גם', 'או', 'אבל', 'כי', 'מה', 'יש', 'אין', 'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'in', 'on', 'at', 'for', 'with', 'he', 'she', 'it', 'user'])
const PREFIXES = new Set(['ו', 'ה', 'ב', 'ל', 'מ', 'ש', 'כ'])

// Hebrew words carry their prefixes ("בבית", "והבית"): strip up to two so "בית" matches all of them.
export function stem(word) {
  let w = word
  for (let i = 0; i < 2 && w.length > 3 && PREFIXES.has(w[0]); i++) w = w.slice(1)
  return w
}

export function tokens(text) {
  return String(text)
    .toLowerCase()
    .replace(NIQQUD, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem)
    .filter((w) => !STOP.has(w))
}

// Overlap of two token sets: 1 = same words, 0 = nothing shared. The smaller set counts for half, so "likes coffee"
// is recognised inside "likes coffee with milk" as well as the other way round.
export function similarity(a, b) {
  const A = new Set(tokens(a))
  const B = new Set(tokens(b))
  if (!A.size || !B.size) return 0
  let shared = 0
  for (const t of A) if (B.has(t)) shared++
  const jaccard = shared / (A.size + B.size - shared)
  const containment = shared / Math.min(A.size, B.size)
  return 0.5 * jaccard + 0.5 * containment
}

// Never store these, whoever asks: a memory is pasted into prompts and sent to model providers.
const SECRET = /(סיסמ|password|passwd|\bpin\b|קוד אימות|token|api[\s_-]?key|secret|מפתח גישה|otp|cvv|\b\d{9}\b|\b(?:\d[ -]?){13,19}\b|[A-Za-z0-9_\-]{32,})/i
export const looksSecret = (text) => SECRET.test(String(text))

function clean(fact) {
  return String(fact ?? '').replace(/\s+/g, ' ').trim()
}

function check(fact) {
  const f = clean(fact)
  if (f.length < FACT_MIN) throw new Error('העובדה קצרה מדי')
  if (f.length > FACT_MAX) throw new Error(`העובדה ארוכה מדי (מעל ${FACT_MAX} תווים). נסח אותה קצר יותר`)
  if (looksSecret(f)) throw new Error('לא שומר סיסמאות, קודים, מפתחות או מספרי זהות/כרטיס בזיכרון')
  return f
}

// Old records have only { id, fact }. Fill in the rest the first time they are touched.
function norm(m) {
  m.category ??= 'other'
  m.importance ??= 3
  m.created ??= 0
  m.lastUsed ??= 0
  m.uses ??= 0
  m.source ??= 'explicit'
  return m
}

const clampImportance = (n) => Math.min(5, Math.max(1, Math.round(Number(n) || 3)))
const safeCategory = (c) => (CATEGORIES.includes(c) ? c : 'other')

// ── saving facts ────────────────────────────────────────────────────────────

const SAME = 0.85 // the same fact said again
const UPDATE = 0.55 // the same subject, probably newer information

// Facts that answer one question about the user ("where does he live", "what does he study"). A new one of the
// same kind replaces the old one even when they share no words: "גר בתל אביב" after "גר בראשון לציון".
const SLOT_WORDS = new Set(['גר', 'גרה', 'לומד', 'לומדת', 'עובד', 'עובדת', 'בן', 'בת', 'נולד', 'נולדה', 'מתגורר', 'מתגוררת'])
const slotOf = (fact) => {
  const first = tokens(fact)[0]
  return first && SLOT_WORDS.has(first) ? first.replace(/ת$|ה$/, '') : ''
}

// Returns { status: 'added' | 'duplicate' | 'updated', id, previous? }.
export function addFact(fact, { category = 'other', importance = 3, source = 'explicit', now = Date.now() } = {}) {
  const f = check(fact)
  let best = null
  let bestScore = 0
  for (const m of state.memory) {
    const s = similarity(f, m.fact)
    if (s > bestScore) {
      best = m
      bestScore = s
    }
  }
  if (best && bestScore >= SAME) {
    norm(best).lastUsed = now
    save()
    return { status: 'duplicate', id: best.id }
  }
  const slot = slotOf(f)
  const sameSlot = slot ? state.memory.find((m) => slotOf(m.fact) === slot) : null
  if (!best || bestScore < UPDATE) best = sameSlot ?? best
  if (best && (bestScore >= UPDATE || best === sameSlot) && (best === sameSlot || safeCategory(category) === norm(best).category)) {
    const previous = best.fact
    best.fact = f
    best.importance = Math.max(best.importance, clampImportance(importance))
    best.lastUsed = now
    save()
    return { status: 'updated', id: best.id, previous }
  }
  if (state.memory.length >= MAX_FACTS) evict(now)
  const id = newId()
  state.memory.push({ id, fact: f, category: safeCategory(category), importance: clampImportance(importance), created: now, lastUsed: now, uses: 0, source })
  save()
  return { status: 'added', id }
}

// Makes room by dropping the least valuable automatic fact, or failing that the least valuable one.
function evict(now) {
  const worth = (m) => norm(m).importance * 10 + Math.min(m.uses, 10) - (now - (m.lastUsed || m.created)) / 864e5 / 10
  const pool = state.memory.filter((m) => norm(m).source === 'auto')
  const list = pool.length ? pool : state.memory
  const worst = list.reduce((a, b) => (worth(b) < worth(a) ? b : a))
  state.memory = state.memory.filter((m) => m !== worst)
}

export function removeFact(id) {
  const before = state.memory.length
  state.memory = state.memory.filter((m) => m.id !== id)
  save()
  return before !== state.memory.length
}

// ── retrieval ───────────────────────────────────────────────────────────────

const ALWAYS_AT = 5 // importance 5 facts (name, allergies...) go into every prompt
const SMALL_MEMORY = 15 // below this, everything is included: selection would only lose information

// How much a fact matters for this query: shared words count most, then importance, then how recent it is.
export function score(m, queryTokens, now = Date.now()) {
  norm(m)
  const own = new Set(tokens(m.fact))
  let shared = 0
  for (const t of queryTokens) if (own.has(t)) shared++
  const overlap = queryTokens.length ? shared / Math.sqrt(queryTokens.length * Math.max(own.size, 1)) : 0
  const ageDays = (now - (m.lastUsed || m.created || now)) / 864e5
  return overlap * 10 + m.importance + Math.max(0, 1 - ageDays / 180) + Math.min(m.uses, 5) * 0.1
}

export function retrieve(query = '', limit = 14, now = Date.now()) {
  const all = state.memory
  if (all.length <= Math.max(limit, SMALL_MEMORY)) return all.map(norm)
  const q = tokens(query)
  const ranked = all.map((m) => ({ m, s: score(m, q, now) })).sort((a, b) => b.s - a.s)
  const chosen = new Map()
  for (const { m } of ranked) if (m.importance >= ALWAYS_AT) chosen.set(m.id, m)
  for (const { m } of ranked) {
    if (chosen.size >= limit) break
    chosen.set(m.id, m)
  }
  return [...chosen.values()]
}

// For the "search" tool: no limit on what is in memory, only on what comes back.
export function search(query, limit = 10, now = Date.now()) {
  const q = tokens(query)
  if (!q.length) return []
  return state.memory
    .map((m) => ({ m, s: score(m, q, now), hit: tokens(m.fact).some((t) => q.includes(t)) }))
    .filter((x) => x.hit)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.m)
}

// Marks the facts that went into a prompt as used, so frequently useful ones survive eviction.
export function touch(list, now = Date.now()) {
  for (const m of list) {
    norm(m).lastUsed = now
    m.uses++
  }
}

// ── candidates: facts waiting for the user's approval ────────────────────────

function candidates() {
  state.memoryCandidates ??= []
  return state.memoryCandidates
}

export const pending = () => candidates()

export function addCandidate(fact, { category = 'other', importance = 3, now = Date.now() } = {}) {
  const f = check(fact)
  const list = candidates()
  if (state.memory.some((m) => similarity(f, m.fact) >= SAME)) return { status: 'known' }
  if (list.some((c) => similarity(f, c.fact) >= SAME)) return { status: 'queued' }
  if (list.length >= MAX_CANDIDATES) list.shift()
  const id = newId()
  list.push({ id, fact: f, category: safeCategory(category), importance: clampImportance(importance), at: now })
  save()
  return { status: 'proposed', id }
}

// Saves the approved candidates (all of them, or the given ids) as real facts.
export function confirmCandidates(ids) {
  const list = candidates()
  const take = ids?.length ? list.filter((c) => ids.includes(c.id)) : [...list]
  const done = take.map((c) => ({ fact: c.fact, ...addFact(c.fact, { category: c.category, importance: c.importance, source: 'auto' }) }))
  state.memoryCandidates = list.filter((c) => !take.includes(c))
  save()
  return done
}

export function rejectCandidates(ids) {
  const list = candidates()
  const drop = ids?.length ? list.filter((c) => ids.includes(c.id)) : [...list]
  state.memoryCandidates = list.filter((c) => !drop.includes(c))
  save()
  return drop.length
}

// ── the prompt ──────────────────────────────────────────────────────────────

const ASK_EVERY_MS = 4 * 3600e3

// The memory section of the system prompt for this message.
export function memoryBlock(query = '', { now = Date.now(), english = false } = {}) {
  if (!state.memory.length && !pending().length) return '(ריק)'
  const shown = retrieve(query, 14, now)
  touch(shown, now)
  const lines = shown.map((m) => `#${m.id} ${m.fact}`)
  const hidden = state.memory.length - shown.length
  if (hidden > 0) lines.push(english ? `(${hidden} more facts are stored; memory_search finds them)` : `(עוד ${hidden} עובדות שמורות; memory_search מחפש בהן)`)
  const waiting = pending()
  if (waiting.length && now - (state.memoryAskedAt || 0) > ASK_EVERY_MS) {
    lines.push(
      english
        ? `Waiting for approval (learned from his own messages): ${waiting.map((c) => `#${c.id} ${c.fact}`).join('; ')}. At a natural moment in this conversation call memory_confirm once; the system asks him to approve, so do not ask in text first.`
        : `ממתינות לאישור המשתמש (נלמדו מההודעות שלו): ${waiting.map((c) => `#${c.id} ${c.fact}`).join('; ')}. ברגע טבעי בשיחה הזאת קרא פעם אחת ל-memory_confirm; המערכת מבקשת ממנו אישור, אז אל תשאל בטקסט קודם.`
    )
  }
  return lines.length ? lines.join('\n') : '(ריק)'
}
