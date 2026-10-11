// Image, video, music and sound-effect generation through ElevenLabs. Every call spends account credits.
import { config } from './config.js'

const API = 'https://api.elevenlabs.io/v1'
const POLL_MS = 4000

export const createEnabled = () => Boolean(config.elevenlabs.apiKey)
export const imageEnabled = () => Boolean(config.imageModel || config.elevenlabs.apiKey)

async function call(path, body) {
  const res = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'xi-api-key': config.elevenlabs.apiKey, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  })
  if (res.status === 402) throw new Error('החבילה של המשתמש ב-ElevenLabs לא כוללת את היכולת הזאת (תמונות וסרטונים דורשים Pro ומעלה).')
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res
}

const SIZES = { '1:1': '1024x1024', '16:9': '1536x1024', '4:3': '1536x1024', '9:16': '1024x1536', '3:4': '1024x1536' }

// Images through the chat provider's OpenAI-style endpoint, for accounts whose ElevenLabs plan has no image generation.
async function providerImage({ prompt, aspect_ratio = '1:1' }) {
  const res = await fetch(config.llm.baseUrl + '/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
    body: JSON.stringify({ model: config.imageModel, prompt, size: SIZES[aspect_ratio] || SIZES['1:1'], n: 1 }),
    signal: AbortSignal.timeout(180000),
  })
  if (!res.ok) throw new Error(`יצירת התמונה נכשלה, HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const item = (await res.json()).data?.[0]
  if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, 'base64'), mime: 'image/png' }
  if (!item?.url) throw new Error('הספק לא החזיר תמונה')
  const file = await fetch(item.url, { signal: AbortSignal.timeout(180000) })
  return { buffer: Buffer.from(await file.arrayBuffer()), mime: file.headers.get('content-type') || 'image/png' }
}

// Starts an image or video generation and waits for the finished file.
async function generate(kind, body, timeoutMs) {
  const { id } = await (await call(`/flows/${kind}`, body)).json()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const job = await (await call(`/flows/${kind}/${id}`)).json()
    if (job.status === 'failed') throw new Error(job.error_message || job.failure_reason || 'היצירה נכשלה')
    if (job.status !== 'completed') continue
    const file = await fetch(job.content_url, { signal: AbortSignal.timeout(180000) })
    if (!file.ok) throw new Error(`הורדת התוצאה נכשלה, HTTP ${file.status}`)
    return { buffer: Buffer.from(await file.arrayBuffer()), mime: job.content_mime_type }
  }
  throw new Error('היצירה לא הסתיימה בזמן')
}

// IMAGE_MODEL, when set, wins: it names an image model at the chat provider.
export const createImage = (args) =>
  config.imageModel ? providerImage(args) : generate('image', { model_id: config.elevenlabs.imageModel, prompt: args.prompt, ...(args.aspect_ratio && { aspect_ratio: args.aspect_ratio }) }, 4 * 60000)

export const createVideo = ({ prompt, aspect_ratio }) =>
  generate('video', { model_id: config.elevenlabs.videoModel, prompt, ...(aspect_ratio && { aspect_ratio }) }, 15 * 60000)

export async function createMusic({ prompt, seconds = 30 }) {
  const res = await call('/music', { prompt, music_length_ms: Math.min(120, Math.max(10, seconds)) * 1000 })
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' }
}

export async function createSound({ prompt, seconds }) {
  const res = await call('/sound-generation', { text: prompt, ...(seconds && { duration_seconds: Math.min(30, Math.max(0.5, seconds)) }) })
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' }
}
