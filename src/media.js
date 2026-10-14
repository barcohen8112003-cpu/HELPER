import { createHash } from 'node:crypto'
import mammoth from 'mammoth'
import { extractText, getDocumentProxy } from 'unpdf'
import { config } from './config.js'
import * as archive from './archive.js'

const TEXT_FILE = /\.(txt|md|csv|json|xml|html?|css|jsx?|tsx?|py|java|c|cpp|h|cs|go|rs|rb|php|sql|sh|ps1|ya?ml|ini|log)$/i

const MAX_FILE_TEXT = 20000

// Pages of a text, PDF or Word file (a PDF has its real pages, anything else is one); null for a type that cannot be read.
async function filePages({ buffer, mime = '', name = '' }) {
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(buffer)), { mergePages: false })
    return text.map((t) => t.trim())
  }
  if (/\.docx$/i.test(name) || mime.includes('wordprocessingml')) return [(await mammoth.extractRawText({ buffer })).value.trim()]
  if (mime.startsWith('text/') || TEXT_FILE.test(name)) return [buffer.toString('utf8')]
  return null
}

// Every file the user sends is kept in the long-term archive, so it can be found again months later.
// The key is the file's content, so the same file sent twice is stored once.
function archiveFile(media, pages) {
  if (!pages.some(Boolean)) return
  const key = `file:${createHash('sha1').update(media.buffer).digest('hex')}`
  archive.add({ key, source: 'whatsapp/file', title: media.name || 'קובץ', pages: pages.length > 1 ? pages : undefined, text: pages[0] }).catch((e) => console.log(`[archive] ${e.message}`))
}

const ELEVEN = 'https://api.elevenlabs.io/v1'

async function elevenTranscribe({ buffer, mime }) {
  const form = new FormData()
  form.append('model_id', config.elevenlabs.sttModel)
  form.append('file', new Blob([buffer], { type: mime || 'audio/ogg' }), 'voice.ogg')
  const res = await fetch(`${ELEVEN}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': config.elevenlabs.apiKey }, body: form, signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error(`תמלול נכשל, HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return ((await res.json()).text || '').trim()
}

async function elevenSpeak(text) {
  if (!config.elevenlabs.voiceId) throw new Error('חסר ELEVENLABS_VOICE_ID בקובץ .env')
  // Ogg/Opus straight from the API, so no local audio conversion is needed.
  const res = await fetch(`${ELEVEN}/text-to-speech/${config.elevenlabs.voiceId}?output_format=opus_48000_32`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': config.elevenlabs.apiKey },
    body: JSON.stringify({ text, model_id: config.elevenlabs.ttsModel }),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error(`הקראה נכשלה, HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return Buffer.from(await res.arrayBuffer())
}

export const canHear = () => Boolean(config.elevenlabs.apiKey || config.voice.sttModel)
export const canSpeak = () => Boolean(config.elevenlabs.apiKey || config.voice.ttsModel)

async function transcribe(media) {
  // STT_MODEL, when set, wins over ElevenLabs for understanding speech: it names a transcription model at the
  // voice provider (Whisper on Groq answers in under a second). ElevenLabs still does the speaking.
  const text = config.voice.sttModel || !config.elevenlabs.apiKey ? await openaiTranscribe(media) : await elevenTranscribe(media)
  if (!text) throw new Error('לא הצלחתי להבין את ההודעה הקולית')
  return text
}

async function openaiTranscribe({ buffer, mime }) {
  if (!config.voice.sttModel) throw new Error('קיבלתי הודעה קולית, אבל תמלול לא מוגדר. צריך למלא STT_MODEL בקובץ .env')
  const form = new FormData()
  form.append('model', config.voice.sttModel)
  form.append('file', new Blob([buffer], { type: mime || 'audio/ogg' }), 'voice.ogg')
  const res = await fetch(config.voice.baseUrl + '/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.voice.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error(`תמלול נכשל, HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return ((await res.json()).text || '').trim()
}

const MAX_SPOKEN = 1500

// What is worth saying aloud: no WhatsApp markup, and links replaced by a word.
export const spokenText = (text) =>
  text
    .replace(/https?:\/\/\S+/g, 'קישור')
    .replace(/[*_~`]/g, '')
    .replace(/^[•\-]\s*/gm, '')
    .slice(0, MAX_SPOKEN)
    .trim()

// Text to an Ogg/Opus buffer, the format WhatsApp plays as a voice note. Null when voice replies are off.
export async function speak(text) {
  if (!canSpeak() || !spokenText(text)) return null
  if (config.elevenlabs.apiKey) return elevenSpeak(spokenText(text))
  const res = await fetch(config.voice.baseUrl + '/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.voice.apiKey}` },
    body: JSON.stringify({ model: config.voice.ttsModel, voice: config.voice.ttsVoice, input: spokenText(text), response_format: 'opus' }),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error(`הקראה נכשלה, HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return Buffer.from(await res.arrayBuffer())
}

// Turns an incoming message into what the model gets: text, plus an image data URL if one was sent.
// `voice` marks a message that was spoken, so the reply can be spoken too.
export async function prepare({ text, media }) {
  text = text.trim()
  if (!media) return { text }
  if (media.kind === 'audio') return { text: `[הודעה קולית, תמלול] ${await transcribe(media)}`, voice: true }
  if (media.kind === 'image') return { text: text || 'מה יש בתמונה?', image: `data:${media.mime || 'image/jpeg'};base64,${media.buffer.toString('base64')}` }
  let content = null
  try {
    const pages = await filePages(media)
    if (pages) {
      archiveFile(media, pages)
      content = pages.filter(Boolean).join('\n\n')
    }
  } catch (e) {
    content = `(קריאת הקובץ נכשלה: ${e.message})`
  }
  if (content !== null) return { text: `${text}\n\n[קובץ מצורף: ${media.name}]\n${content.slice(0, MAX_FILE_TEXT) || '(לא נמצא טקסט בקובץ - ייתכן שהוא סרוק כתמונה)'}`.trim() }
  return { text: `${text}\n\n[המשתמש שלח קובץ "${media.name}" מסוג ${media.mime}, אבל אין לך אפשרות לקרוא סוג כזה. אמור לו את זה.]`.trim() }
}
