// WhatsApp through Bird (bird.com, formerly MessageBird): an extra send path from a business number.
// The personal WhatsApp link stays on Baileys (src/whatsapp.js) and is never switched over.
// Off unless BIRD_ENABLED=true. A key alone (BIRD_API_KEY) does nothing, so a server that already
// has the key in .env keeps behaving exactly as before. The key is never logged or sent to the page.
import { BirdClient, BirdAPIError } from '@messagebird/sdk'
import { config } from './config.js'

// Read live: the settings page writes BIRD_ENABLED into the environment without a restart.
export const birdOptedIn = () => String(process.env.BIRD_ENABLED || '').trim() === 'true'
export const birdEnabled = () => birdOptedIn() && Boolean(config.bird.key)

// One client per key, so a key changed on the settings site is picked up without a restart.
let cached = null
function client(fetchFn) {
  if (!birdOptedIn()) throw new Error('Bird כבוי. כדי להפעיל צריך BIRD_ENABLED=true באתר ההגדרות (ברירת המחדל כבויה). הוואטסאפ האישי לא משתנה')
  if (!config.bird.key) throw new Error('Bird לא מחובר. צריך להדביק מפתח באתר ההגדרות, בכרטיס Bird (או BIRD_API_KEY ב-.env)')
  if (fetchFn) return new BirdClient({ apiKey: config.bird.key, fetch: fetchFn, maxRetries: 0 })
  if (cached?.key !== config.bird.key) cached = { key: config.bird.key, bird: new BirdClient({ apiKey: config.bird.key }) }
  return cached.bird
}

// Bird wants E.164 (+972...). People write 050-1234567, 972501234567 or +972 50 123 4567.
export function toE164(number) {
  const raw = String(number || '').trim()
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  if (raw.startsWith('+')) return `+${digits}`
  if (digits.startsWith('00')) return `+${digits.slice(2)}`
  if (digits.startsWith('0')) return `+972${digits.slice(1)}`
  return `+${digits}`
}

// Template values arrive as {name: value} or as "name=value, name=value"; Bird wants named text parameters.
export function templateParams(values) {
  let entries = []
  if (values && typeof values === 'object') entries = Object.entries(values)
  else if (typeof values === 'string' && values.trim()) {
    try {
      const parsed = JSON.parse(values)
      if (parsed && typeof parsed === 'object') entries = Object.entries(parsed)
    } catch {
      entries = values.split(/[,\n]/).map((p) => p.split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => [k, v.join('=')])
    }
  }
  return entries.map(([name, text]) => ({ type: 'text', name: String(name).trim(), text: String(text).trim() })).filter((p) => p.name)
}

function explain(e) {
  if (e instanceof BirdAPIError) {
    if (e.statusCode === 401) return new Error('Bird דחה את המפתח (401). בדוק את BIRD_API_KEY באתר ההגדרות')
    if (e.statusCode === 403) return new Error('למפתח של Bird אין הרשאה לוואטסאפ (403). צריך הרשאות whatsapp במפתח')
    return new Error(`Bird החזיר שגיאה ${e.statusCode}${e.code && e.code !== 'unknown' ? ` (${e.code})` : ''}: ${e.message || ''}`.trim())
  }
  return e
}

// Sends an approved WhatsApp template, e.g. slug "bird_delivery_update" with { ref: 'A1B2C3D4', date: '10 Jul 2026' }.
// Outside the 24-hour window after the recipient last wrote, a template is the only thing WhatsApp delivers.
export async function sendWhatsAppTemplate({ to, slug, params, language, from = config.bird.from }, { fetchFn } = {}) {
  const number = toE164(to)
  if (!number) throw new Error('אין מספר נמען')
  if (!slug) throw new Error('אין שם תבנית (slug)')
  const parameters = templateParams(params)
  const template = { slug: String(slug).trim(), ...(language && { language }), ...(parameters.length && { components: [{ type: 'body', parameters }] }) }
  try {
    const msg = await client(fetchFn).whatsapp.send({ to: number, ...(from && { from: toE164(from) }), template })
    return { id: msg.id, status: msg.status, to: number }
  } catch (e) {
    throw explain(e)
  }
}

// Free text: WhatsApp delivers it only inside an open 24-hour window, so it needs a business number (BIRD_WHATSAPP_FROM).
export async function sendWhatsAppText({ to, text, from = config.bird.from }, { fetchFn } = {}) {
  const number = toE164(to)
  if (!number) throw new Error('אין מספר נמען')
  if (!String(text || '').trim()) throw new Error('אין טקסט')
  if (!from) throw new Error('לשליחת טקסט חופשי צריך את המספר העסקי ב-Bird (BIRD_WHATSAPP_FROM באתר ההגדרות)')
  try {
    const msg = await client(fetchFn).whatsapp.send({ to: number, from: toE164(from), text: { body: String(text).slice(0, 4096) } })
    return { id: msg.id, status: msg.status, to: number }
  } catch (e) {
    throw explain(e)
  }
}

// ── Inbound: the user writes to Helper's own WhatsApp number and Helper answers in that chat ──
// Bird posts every event to /bird/webhook (signed, Standard Webhooks). Only a text message from BIRD_OWNER_NUMBER is
// answered; everything else (other senders, delivery receipts, media) is acknowledged and dropped.
const seen = new Map()
const alreadySeen = (id) => {
  const now = Date.now()
  for (const [k, t] of seen) if (now - t > 3600_000) seen.delete(k)
  if (!id || seen.has(id)) return Boolean(id)
  seen.set(id, now)
  return false
}

export const birdChatEnabled = () => birdEnabled() && Boolean(config.bird.webhookSecret && config.bird.owner)

function chunks(text, size = 3800) {
  const out = []
  let rest = String(text || '').trim()
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size / 2) cut = size
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

// Returns { status, body } for the HTTP route. `agent(text, { source })` is Helper's brain; `fetchFn` is for tests.
export async function handleBirdWebhook(raw, headers, { agent, fetchFn, wait = false } = {}) {
  if (!birdChatEnabled()) return { status: 404, body: { error: 'Bird chat is not set up' } }
  let event
  try {
    const verifier = new BirdClient({ apiKey: config.bird.key, webhooks: { secret: config.bird.webhookSecret }, ...(fetchFn && { fetch: fetchFn }) })
    event = verifier.webhooks.unwrap(raw, headers)
  } catch {
    return { status: 400, body: { error: 'bad signature' } }
  }
  if (event.type !== 'whatsapp.received') return { status: 200, body: { ignored: event.type } }
  const d = event.data || {}
  const text = String(d.text?.body || '').trim()
  const sender = toE164(d.from?.phone_number)
  if (d.direction !== 'inbound' || !text || !sender || sender !== toE164(config.bird.owner)) return { status: 200, body: { ignored: 'not the owner' } }
  if (alreadySeen(d.whatsapp_id)) return { status: 200, body: { ignored: 'duplicate' } }
  const from = toE164(d.to?.phone_number) || config.bird.from
  const work = (async () => {
    let reply
    try {
      reply = await agent(text, { voice: false, source: 'bird' })
    } catch (e) {
      reply = `משהו השתבש: ${e.message}`
    }
    for (const part of chunks(reply)) await sendWhatsAppText({ to: sender, text: part, from }, { fetchFn })
  })().catch((e) => console.log(`[bird] ${e.message}`))
  if (wait) await work
  return { status: 200, body: { ok: true } }
}
