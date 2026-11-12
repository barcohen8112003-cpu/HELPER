// What a raw WhatsApp group message carries, for src/mathwork.js, worked out BEFORE the message is unwrapped.
// normalizeMessageContent (Baileys) strips viewOnceMessage / viewOnceMessageV2 / viewOnceMessageV2Extension and
// ephemeralMessage, after which a view-once photo looks like any other imageMessage. So privacy is read from the raw
// message here, for the message itself and for the message it quotes (contextInfo.quotedMessage, also raw).
//
// - view-once or disappearing (ephemeral) media: no image, no fetcher, no file metadata. Only `blocked` says what it
//   was, so the report can say the photo is unavailable. It is never downloaded, stored or replayed.
// - a photo (imageMessage): its declared mimetype and size, and a fetcher that reads at most maxBytes.
// - anything else attached (PDF, document, video, voice, audio): mimetype and file name only, never downloaded, so the
//   report can say there is a file it did not read.
// Pure: no socket, no send. The fetcher is made by the caller (src/whatsapp.js).

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage', 'deviceSentMessage']
const VIEW_ONCE = new Set(['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'])
const MEDIA = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage']

// -> { viewOnce, ephemeral, content (unwrapped) } from a raw message. Walks every wrapper, nested in any order.
export function unwrap(raw) {
  let content = raw
  let viewOnce = false
  let ephemeral = false
  for (let i = 0; i < 8 && content && typeof content === 'object'; i++) {
    const key = WRAPPERS.find((k) => content[k])
    if (!key) break
    if (VIEW_ONCE.has(key)) viewOnce = true
    if (key === 'ephemeralMessage') ephemeral = true
    content = content[key]?.message
  }
  for (const k of MEDIA) {
    const part = content?.[k]
    if (part?.viewOnce === true) viewOnce = true
    if (Number(part?.contextInfo?.expiration) > 0) ephemeral = true
  }
  if (Number(content?.extendedTextMessage?.contextInfo?.expiration) > 0) ephemeral = true
  return { viewOnce, ephemeral, content: content || null }
}

const KIND = (k, part) => (k === 'documentMessage' ? 'file' : k === 'videoMessage' || k === 'ptvMessage' ? 'video' : k === 'audioMessage' ? (part.ptt ? 'voice' : 'audio') : k === 'imageMessage' ? 'image' : k === 'stickerMessage' ? 'sticker' : 'file')
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

// The media facts of one raw message: { blocked, image, files }.
export function facts(raw) {
  const { viewOnce, ephemeral, content } = unwrap(raw)
  const part = MEDIA.map((k) => [k, content?.[k]]).find(([, p]) => p)
  if (!part) return { blocked: null, image: null, files: [], content }
  const [k, p] = part
  const kind = KIND(k, p)
  if (kind === 'sticker') return { blocked: null, image: null, files: [], content }
  // Sender ephemerality survives: nothing about the media leaves this function but what kind it was.
  if (viewOnce || ephemeral) return { blocked: { reason: viewOnce ? 'view-once' : 'ephemeral', kind }, image: null, files: [], content }
  if (kind === 'image') return { blocked: null, image: { mimetype: clip(p.mimetype, 40) || 'image/jpeg', fileLength: Number(p.fileLength) || 0 }, files: [], content }
  return { blocked: null, image: null, files: [{ kind, mimetype: clip(p.mimetype, 80), fileName: clip(p.fileName, 60) }], content }
}

const contextOf = (content) => {
  for (const k of ['extendedTextMessage', ...MEDIA]) if (content?.[k]?.contextInfo) return content[k].contextInfo
  return null
}

// The payload for mathwork.onGroupMessage. fetchFor(rawMessage) -> ({ maxBytes }) => Promise<Buffer>, called only for
// a photo that is neither view-once nor ephemeral.
export function homeworkPayload(msg, { jid, sentAt, text, groupName, fetchFor }) {
  const own = facts(msg.message)
  const ctx = contextOf(own.content)
  let quoted = null
  if (ctx?.stanzaId) {
    const q = ctx.quotedMessage ? facts(ctx.quotedMessage) : { blocked: null, image: null, files: [] }
    quoted = {
      id: ctx.stanzaId,
      sender: ctx.participant || '',
      blocked: q.blocked,
      image: q.image,
      files: q.files,
      download: q.image ? fetchFor({ key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: ctx.quotedMessage }) : null,
    }
  }
  return {
    group: jid,
    groupName,
    id: msg.key.id,
    sender: msg.key.participant || msg.participant || '',
    senderName: msg.pushName || '',
    at: sentAt,
    text,
    fromMe: Boolean(msg.key.fromMe),
    blocked: own.blocked,
    image: own.image,
    files: own.files,
    download: own.image ? fetchFor(msg) : null,
    quoted,
  }
}

// Reads a download stream, stopping (and destroying it) as soon as it passes maxBytes.
export async function readCapped(stream, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.length
    if (total > maxBytes) {
      stream.destroy?.()
      throw Object.assign(new Error('too big'), { tooBig: true })
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
