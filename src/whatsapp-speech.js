// WhatsApp-only speech preparation. Pure: no models, services, state, or provider settings.
export const MAX_WHATSAPP_SPEECH = 1500
export const TEXT_ONLY_SPEECH = 'את התשובה הזאת עדיף לקרוא בטקסט. היא מופיעה בהודעה המצורפת.'

export const WHATSAPP_SPOKEN_NOTE = `התשובה הזאת מיועדת להודעה קולית בוואטסאפ. כתוב בעברית טבעית לשיחה, אלא אם המשתמש ביקש שפה אחרת. השתמש במשפטים קצרים ובפיסוק רגיל שמאפשר הפסקות. בלי פתיח של דו"ח, כותרות מיותרות, תגיות רגש או הוראות משחק לקול. אל תוסיף סלנג או מילות מילוי בכוח. היה קצר כשאפשר, אבל אל תקצר על חשבון תשובה שלמה או הסתייגות חשובה. שמור בדיוק על שמות, סכומים, מספרים, תאריכים, שעות, יחידות, שלילה ומידת הוודאות. אל תשנה קול, מודל או הגדרות קול. אם צריך קישור, קוד, טבלה או פרטים לעיון, כלול אותם בתשובה: הם יישארו בטקסט, ולא חייבים להישמע בקול. אל תטען ששלחת קולית או טקסט: השולח מטפל בכך אחרי התשובה.`

export function spokenReplySystem(system, ctx = {}) {
  // Never alter a task, bridge, group, or isolated actor's instructions.
  return ctx.source === 'whatsapp' && ctx.spokenReply && !ctx.isolated
    ? `${system}\n\n${WHATSAPP_SPOKEN_NOTE}`
    : system
}

export function prepareWhatsAppSpeech(value) {
  const text = String(value ?? '').trim()
  if (!text) return { speech: '', companion: false, reason: 'empty' }
  // Do not read code/table syntax or an excerpt that might omit a condition or negation.
  // A full text companion preserves the answer. There is no extra summary-model call.
  if (/```|~~~|^\s*\|.+\||^\s*\S.*\|.*\|/m.test(text)) {
    return { speech: TEXT_ONLY_SPEECH, companion: true, reason: 'structured' }
  }
  const hasLinks = /https?:\/\/\S+/i.test(text)
  const speech = text
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/gi, '$1 (הקישור בטקסט)')
    .replace(/https?:\/\/\S+/gi, '(הקישור בטקסט)')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*•\s+/gm, '')
    .replace(/^\s*[-*]\s+(?=[\p{L}])/gmu, '')
    .replace(/(?<![\p{L}\p{N}])\*\*([^*\n]+)\*\*(?![\p{L}\p{N}])/gu, '$1')
    .replace(/(?<![\p{L}\p{N}*])\*([^*\n]+)\*(?![\p{L}\p{N}*])/gu, '$1')
    .replace(/\r\n/g, '\n')
    .trim()
  // Never slice a sentence, split a number, or speak a misleading partial answer.
  // Keep the existing maximum billed input length, using a fixed notice for long answers.
  if (speech.length > MAX_WHATSAPP_SPEECH) {
    return { speech: TEXT_ONLY_SPEECH, companion: true, reason: 'long' }
  }
  return { speech, companion: hasLinks || speech !== text, reason: 'complete' }
}

// Opt-in WhatsApp transport, injected for offline failure tests. A notice that refers to
// attached text must never be sent before that text has actually landed.
export async function deliverWhatsAppSpeech({ reply, delivery, audio, sendText, sendVoice, onVoiceError = () => {} }) {
  let textSent = false
  const sendConfirmedText = async () => {
    // wa.send resolves to its last chunk's WhatsApp ID, or null when unverified.
    // Resolution alone is not evidence. Do not retry an ambiguous partial send.
    let id
    try { id = await sendText(reply) } catch (cause) {
      const error = new Error(cause?.message || 'WhatsApp text delivery failed', { cause })
      error.deliveryUncertain = true
      throw error
    }
    if (typeof id !== 'string' || !id.trim()) {
      const error = new Error('WhatsApp text delivery could not be confirmed')
      error.deliveryUncertain = true
      throw error
    }
  }
  if (reply && (!audio || delivery.companion)) {
    await sendConfirmedText()
    textSent = true
  }
  if (!audio) return { textSent, voiceSent: false }
  try {
    await sendVoice(audio)
    return { textSent, voiceSent: true }
  } catch (error) {
    // Logging must not prevent the answer from reaching him.
    try { onVoiceError(error) } catch {}
    if (!textSent && reply) {
      await sendConfirmedText()
      textSent = true
    }
    return { textSent, voiceSent: false }
  }
}
