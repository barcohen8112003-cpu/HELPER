import mammoth from 'mammoth'
import { extractText, getDocumentProxy } from 'unpdf'
import { config } from './config.js'

const TEXT_FILE = /\.(txt|md|csv|json|xml|html?|css|jsx?|tsx?|py|java|c|cpp|h|cs|go|rs|rb|php|sql|sh|ps1|ya?ml|ini|log)$/i

const MAX_FILE_TEXT = 20000

// Text of a text, PDF or Word file; null for a type that cannot be read.
async function fileText({ buffer, mime = '', name = '' }) {
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(buffer)), { mergePages: true })
    return text.trim()
  }
  if (/\.docx$/i.test(name) || mime.includes('wordprocessingml')) return (await mammoth.extractRawText({ buffer })).value.trim()
  if (mime.startsWith('text/') || TEXT_FILE.test(name)) return buffer.toString('utf8')
  return null
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

export async function elevenSpeakMp3(text) {
  if (!config.elevenlabs.apiKey) throw new Error('חסר ELEVENLABS_API_KEY בקובץ .env')
  if (!config.elevenlabs.voiceId) throw new Error('חסר ELEVENLABS_VOICE_ID בקובץ .env')
  const spoken = spokenText(text)
  const models = [config.elevenlabs.ttsModel, 'eleven_multilingual_v2', 'eleven_turbo_v2_5'].filter(Boolean)

  let lastErr = null
  for (const model_id of models) {
    try {
      const res = await fetch(`${ELEVEN}/text-to-speech/${config.elevenlabs.voiceId}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': config.elevenlabs.apiKey },
        body: JSON.stringify({ text: spoken, model_id }),
        signal: AbortSignal.timeout(120000),
      })
      if (res.ok) {
        return Buffer.from(await res.arrayBuffer())
      }
      const errText = await res.text()
      console.error(`[elevenlabs] Model ${model_id} failed (${res.status}): ${errText.slice(0, 150)}`)
      lastErr = new Error(`ElevenLabs HTTP ${res.status}: ${errText.slice(0, 150)}`)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('ElevenLabs speaking failed')
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
  const content = await fileText(media).catch((e) => `(קריאת הקובץ נכשלה: ${e.message})`)
  if (content !== null) return { text: `${text}\n\n[קובץ מצורף: ${media.name}]\n${content.slice(0, MAX_FILE_TEXT) || '(לא נמצא טקסט בקובץ - ייתכן שהוא סרוק כתמונה)'}`.trim() }
  return { text: `${text}\n\n[המשתמש שלח קובץ "${media.name}" מסוג ${media.mime}, אבל אין לך אפשרות לקרוא סוג כזה. אמור לו את זה.]`.trim() }
}
