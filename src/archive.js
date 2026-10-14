// Long-term archive: every file, mail and old stretch of conversation the assistant has seen, cut into passages
// and searchable months later ("where is the history summary on the industrial revolution?").
// Pure JavaScript, one append-only file, no database server. Search is keyword ranking (BM25), plus meaning
// (embeddings) when EMBEDDING_MODEL is set; the two rankings are fused, so either alone still finds things.
import fs from 'node:fs'
import path from 'node:path'
import { config, DATA_DIR } from './config.js'

const FILE = path.join(DATA_DIR, 'archive.jsonl')
const CHUNK = 1000
const OVERLAP = 150
// A personal archive stays well under this; past it the oldest passages make room.
const MAX_CHUNKS = 60000
const EMBED_BATCH = 64
// Reciprocal rank fusion constant: how much a top rank in one ranking outweighs a middling one in both.
const RRF = 60
const K1 = 1.4
const B = 0.75

// Hebrew glues one-letter prefixes (ו, ה, ב, ל, מ, ש, כ) onto words: "בהיסטוריה" should match "היסטוריה".
// A word is indexed as written and with up to two prefix letters taken off.
const PREFIX = /^[והבלמשכ]/
export function tokens(text) {
  const out = []
  for (const word of String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 2) continue
    out.push(word)
    let w = word
    for (let i = 0; i < 2 && w.length > 3 && PREFIX.test(w); i++) out.push((w = w.slice(1)))
  }
  return out
}

// Paragraph-sized passages, each carrying the tail of the one before so a sentence cut in two is still found.
export function chunkText(text, size = CHUNK, overlap = OVERLAP) {
  const parts = String(text)
    .replace(/\r/g, '')
    .split(/\n\s*\n|\n(?=[•\-*\d])/)
    .flatMap((p) => (p.length <= size ? [p] : p.match(new RegExp(`[\\s\\S]{1,${size}}(?=\\s|$)|[\\s\\S]{1,${size}}`, 'g'))))
    .map((p) => p.trim())
    .filter(Boolean)
  const chunks = []
  let current = ''
  for (const p of parts) {
    if (current && current.length + p.length + 1 > size) {
      chunks.push(current)
      current = current.slice(-overlap).replace(/^\S*\s/, '')
    }
    current = current ? `${current}\n${p}` : p
  }
  if (current) chunks.push(current)
  return chunks
}

const toB64 = (vec) => Buffer.from(new Float32Array(vec).buffer).toString('base64')
const fromB64 = (s) => {
  const buf = Buffer.from(s, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
}

// Loaded once, kept in memory. Each passage also gets its token counts, which are not stored.
let chunks = null
let keys = null
let df = null
let totalLength = 0

function index(c) {
  c.tf = new Map()
  for (const t of tokens(`${c.title}\n${c.text}`)) c.tf.set(t, (c.tf.get(t) || 0) + 1)
  c.len = [...c.tf.values()].reduce((a, b) => a + b, 0)
  for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1)
  totalLength += c.len
  keys.add(c.key)
}

function unindex(c) {
  for (const t of c.tf.keys()) df.set(t, df.get(t) - 1)
  totalLength -= c.len
}

function load() {
  if (chunks) return
  chunks = []
  keys = new Set()
  df = new Map()
  totalLength = 0
  if (!fs.existsSync(FILE)) return
  for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const c = JSON.parse(line)
      if (c.vec) c.vec = fromB64(c.vec)
      chunks.push(c)
      index(c)
    } catch {
      // A line cut short by a crash mid-write is skipped; everything before and after it is intact.
    }
  }
}

const stored = ({ tf, len, vec, ...c }) => JSON.stringify(vec ? { ...c, vec: toB64(vec) } : c)

function rewrite() {
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, chunks.map(stored).join('\n') + (chunks.length ? '\n' : ''))
  fs.renameSync(tmp, FILE)
}

export const embeddingsOn = () => Boolean(config.embeddings.model && config.embeddings.apiKey)

async function embed(texts) {
  const out = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const res = await fetch(config.embeddings.baseUrl + '/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.embeddings.apiKey}` },
      body: JSON.stringify({ model: config.embeddings.model, input: texts.slice(i, i + EMBED_BATCH) }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) throw new Error(`Embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = (await res.json()).data || []
    out.push(...data.sort((a, b) => a.index - b.index).map((d) => d.embedding))
  }
  return out
}

// Adds run one after another, so two copies of the same item arriving together are still stored once.
let queue = Promise.resolve()

// item: { key, source, title, text | pages, ref, at }. `key` names the item at its source (a mail id, a file's
// name and size); an item whose key is already archived is skipped. `pages` instead of `text` keeps page numbers.
// Returns how many passages were added. Never throws: a failed embedding only means keyword search for these.
export function add(item) {
  const run = queue.then(() => addNow(item))
  queue = run.catch(() => {})
  return run
}

async function addNow({ key, source, title = '', text = '', pages, ref = '', at = Date.now() }) {
  load()
  if (!key || keys.has(key)) return 0
  const parts = (pages || [text]).flatMap((p, i) => chunkText(p).map((t) => ({ text: t, page: pages ? i + 1 : undefined })))
  if (!parts.length) return 0
  let vecs = []
  if (embeddingsOn()) vecs = await embed(parts.map((p) => `${title}\n${p.text}`)).catch((e) => (console.log(`[archive] ${e.message}`), []))
  const time = new Date(at).toISOString()
  const fresh = parts.map((p, i) => ({ key, source, title, ref, at: time, page: p.page, text: p.text, vec: vecs[i] && new Float32Array(vecs[i]) }))
  for (const c of fresh) index(c)
  chunks.push(...fresh)
  if (chunks.length > MAX_CHUNKS) {
    for (const c of chunks.splice(0, chunks.length - MAX_CHUNKS)) unindex(c)
    keys = new Set(chunks.map((c) => c.key))
    rewrite()
  } else fs.appendFileSync(FILE, fresh.map(stored).join('\n') + '\n')
  return fresh.length
}

// Passages archived before EMBEDDING_MODEL was set (or while it was failing) get their vectors in the background.
export async function backfill() {
  load()
  if (!embeddingsOn()) return 0
  const missing = chunks.filter((c) => !c.vec)
  let done = 0
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH)
    const vecs = await embed(batch.map((c) => `${c.title}\n${c.text}`))
    batch.forEach((c, j) => vecs[j] && (c.vec = new Float32Array(vecs[j])))
    done += batch.length
  }
  if (done) rewrite()
  return done
}

function bm25(query, pool) {
  const terms = [...new Set(tokens(query))]
  const avg = totalLength / Math.max(1, chunks.length)
  return pool
    .map((c) => {
      let score = 0
      for (const t of terms) {
        const f = c.tf.get(t)
        if (!f) continue
        const idf = Math.log(1 + (chunks.length - df.get(t) + 0.5) / (df.get(t) + 0.5))
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * c.len) / avg))
      }
      return { c, score }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na * nb) || 1)
}

// { source, days, limit }: source matches by prefix ("mail" covers every mailbox), days looks back that far.
export async function search(query, { source, days, limit = 6 } = {}) {
  load()
  const since = days ? Date.now() - days * 86400000 : 0
  const pool = chunks.filter((c) => (!source || c.source.startsWith(source)) && (!since || Date.parse(c.at) >= since))
  if (!pool.length) return []
  const scores = new Map()
  const fuse = (ranked) => ranked.slice(0, 50).forEach(({ c }, rank) => scores.set(c, (scores.get(c) || 0) + 1 / (RRF + rank)))
  fuse(bm25(query, pool))
  if (embeddingsOn() && pool.some((c) => c.vec)) {
    const [q] = await embed([query]).catch((e) => (console.log(`[archive] ${e.message}`), []))
    if (q) fuse(pool.filter((c) => c.vec).map((c) => ({ c, score: cosine(q, c.vec) })).sort((a, b) => b.score - a.score))
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([c]) => ({ source: c.source, title: c.title, date: new Date(c.at).toLocaleDateString('he-IL'), page: c.page, ref: c.ref || undefined, text: c.text }))
}

export function stats() {
  load()
  return { passages: chunks.length, items: keys.size, withMeaning: chunks.filter((c) => c.vec).length }
}

// Removes every passage of the items whose key or title contains `match`. Returns how many items went.
export function remove(match) {
  load()
  if (!match) return 0
  const gone = new Set(chunks.filter((c) => c.key === match || c.title.includes(match)).map((c) => c.key))
  if (!gone.size) return 0
  for (const c of chunks.filter((c) => gone.has(c.key))) unindex(c)
  chunks = chunks.filter((c) => !gone.has(c.key))
  keys = new Set(chunks.map((c) => c.key))
  rewrite()
  return gone.size
}
