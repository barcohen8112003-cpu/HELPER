// WhatsApp through Bird (bird.com, formerly MessageBird): sends from a WhatsApp Business number over Bird's
// official API, next to the personal WhatsApp link (Baileys). The key lives in .env as BIRD_API_KEY (settings
// site, "Bird" card), never in code or in a chat. Every send waits for the user's approval (tool bird_whatsapp).
import { BirdClient, BirdAPIError } from '@messagebird/sdk'
import { config } from './config.js'

export const birdEnabled = () => Boolean(config.bird.key)

// One client per key, so a key changed on the settings site is picked up without a restart.
let cached = null
function client(fetchFn) {
  if (!birdEnabled()) throw new Error('Bird לא מחובר. צריך להדביק מפתח באתר ההגדרות, בכרטיס Bird (או BIRD_API_KEY ב-.env)')
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
