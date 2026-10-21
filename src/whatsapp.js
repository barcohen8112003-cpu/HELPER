import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import './secret-logs.js'
import pino from 'pino'
import QRCode from 'qrcode'
import baileys, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, normalizeMessageContent, jidNormalizedUser, downloadMediaMessage } from '@whiskeysockets/baileys'
import { DATA_DIR } from './config.js'
import { state as store, save } from './store.js'

const CATCH_UP = 12 * 3600
const MAX_SEEN = 500
const MAX_QR = 15
const MAX_SENT = 300

const makeWASocket = baileys.default ?? baileys
const AUTH_DIR = path.join(DATA_DIR, 'auth')
const QR_FILE = path.join(DATA_DIR, 'qr.png')
const CODE_FILE = path.join(DATA_DIR, 'pair-code.txt')
// Invisible prefix on everything the bot sends, so it never answers itself in a self-chat.
const BOT_MARK = '​'
const MAX_MEDIA = 15 * 1024 * 1024
const logger = pino({ level: 'silent' })

// While WhatsApp is not linked, the settings site shows the current QR and a code to type in. On a server there is
// no window to scan from, so this is the only way to link there without reading the logs.
const pairing = { qr: '', code: '', number: '' }
let askCode = null
export const pairingInfo = () => ({ ...pairing })
export async function requestPairing(raw) {
  if (!askCode) throw new Error('וואטסאפ עוד עולה, נסה שוב בעוד כמה שניות')
  return askCode(raw)
}

// "050-123-4567", "+972 50...", "00972..." or "972050..." -> "972501234567". WhatsApp wants the country code and
// no leading 0; a number typed the Israeli way is the most common reason a pairing code is refused.
export function pairingNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0')) d = '972' + d.slice(1)
  if (d.startsWith('9720')) d = '972' + d.slice(4)
  return d.length >= 10 && d.length <= 15 ? d : ''
}

// onMessage({ jids, fromMe, selfChat, key, lateSeconds, text, getMedia, reaction?, location? })
// onReady({ jid, lid }): the linked account's own ids, each time the connection opens.
export async function startWhatsApp(onMessage, onReady = () => {}) {
  const bootedAt = Math.floor(Date.now() / 1000)
  // Handled message ids survive a restart, so nothing is answered twice. Messages sent while the assistant was
  // off are still picked up, as long as they are newer than the last one handled and not older than CATCH_UP.
  const seen = new Set(store.wa.seen)
  const since = store.wa.lastAt ? Math.max(store.wa.lastAt, bootedAt - CATCH_UP) : bootedAt
  let sock
  let ready = false
  let attempts = 0
  let qrShown = 0
  let openedAt = 0
  // What was sent lately, by message id. When the phone cannot decrypt a message it asks for it again, and without
  // this the resend has nothing to send, so the message stays on "waiting for this message" forever.
  const sent = new Map()

  // The "message yourself" chat lives under the account's lid. Sent to the phone number instead, the message
  // reaches the phone but it cannot decrypt it.
  function target(jid) {
    const [pn, lid] = ownIds()
    return lid && jidNormalizedUser(jid) === pn ? lid : jid
  }

  async function deliver(jid, content, options) {
    const msg = await sock.sendMessage(target(jid), content, options)
    if (msg?.key?.id && msg.message) {
      sent.set(msg.key.id, msg.message)
      if (sent.size > MAX_SENT) sent.delete(sent.keys().next().value)
    }
    return msg
  }

  // The account's own addresses: its phone-number id first, then its "lid". The "message yourself" chat can arrive
  // under either one. They are read from the saved credentials, because right after the first QR scan sock.user
  // does not carry the lid yet, and a self-chat message addressed to it would look like someone else's chat.
  function ownIds() {
    const me = { ...sock.user, ...sock.authState?.creds?.me }
    return [me.id, me.lid].filter(Boolean).map(jidNormalizedUser)
  }

  function remember(id, at = Math.floor(Date.now() / 1000)) {
    seen.add(id)
    store.wa.seen = [...store.wa.seen, id].slice(-MAX_SEEN)
    store.wa.lastAt = Math.max(store.wa.lastAt, at)
    save()
  }

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}))
    sock = makeWASocket({ auth: state, version, logger, markOnlineOnConnect: false, syncFullHistory: false, getMessage: async (key) => sent.get(key.id) })
    sock.ev.on('creds.update', saveCreds)
    let codeAsked = false
    askCode = async (raw) => {
      const number = pairingNumber(raw)
      if (!number) throw new Error('מספר לא תקין. כתוב אותו עם קידומת, למשל 0501234567 או 972501234567')
      if (ready) throw new Error('וואטסאפ כבר מחובר')
      codeAsked = true
      const code = await sock.requestPairingCode(number)
      Object.assign(pairing, { code, number })
      // Remembered so a restart offers a code for the same number right away.
      store.wa.pairNumber = number
      save()
      fs.writeFileSync(CODE_FILE, code)
      console.log(`קוד צימוד לוואטסאפ: ${code}`)
      return { code, number }
    }

    // Names for numbers, from the address book WhatsApp syncs and from the names people give themselves.
    // A saved name wins over a self-given one.
    const learn = (list, saved = true) => {
      let changed = false
      for (const c of list || []) {
        const id = c.id && jidNormalizedUser(c.id)
        const name = (saved && (c.name || c.verifiedName)) || c.notify
        if (!id || !name || !id.endsWith('@s.whatsapp.net') || (!saved && store.contacts[id])) continue
        if (store.contacts[id] !== name) (store.contacts[id] = name), (changed = true)
      }
      if (changed) save()
    }
    sock.ev.on('contacts.upsert', (list) => learn(list))
    sock.ev.on('contacts.update', (list) => learn(list))
    sock.ev.on('messaging-history.set', ({ contacts }) => learn(contacts))

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        pairing.qr = qr
        // Nobody is scanning: stop instead of printing codes forever. Exit code 2 tells start.bat not to restart.
        // Only in a window at home: on a server nobody would start it again, and the settings site needs it running.
        if (++qrShown > MAX_QR && process.stdout.isTTY) {
          console.log('\nהקוד לא נסרק. כשתהיה מוכן לסרוק, הפעל שוב את start.bat.')
          process.exit(2)
        }
        console.log('\nסרוק את הקוד: וואטסאפ בטלפון > מכשירים מקושרים > קישור מכשיר\n')
        console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
        await QRCode.toFile(QR_FILE, qr, { width: 420 })
        console.log(`(אם הקוד לא קריא כאן, פתח את התמונה: ${QR_FILE})\n`)
        // A phone cannot scan a code shown on its own screen. When the number is already known from an earlier
        // link, a code to type in is offered as well: Linked devices > Link a device > Link with phone number.
        // On a server there is no screen to scan at all, so the number can also be given up front:
        // WHATSAPP_PAIRING_NUMBER, digits only with the country code.
        const number = pairingNumber(process.env.WHATSAPP_PAIRING_NUMBER) || store.wa.pairNumber || (/^\d+@s\.whatsapp\.net$/.test(store.owner?.jid || '') && store.owner.jid.split('@')[0])
        if (number && !codeAsked) {
          try {
            const { code } = await askCode(number)
            console.log(`או בלי סריקה: מכשירים מקושרים > קישור מכשיר > קישור עם מספר טלפון, והקלד: ${code}\n`)
          } catch (e) {
            console.log(`[whatsapp] ${e.message}`)
          }
        }
      }
      if (connection === 'open') {
        ready = true
        attempts = 0
        openedAt = Date.now()
        qrShown = 0
        Object.assign(pairing, { qr: '', code: '', number: '' })
        fs.rmSync(QR_FILE, { force: true })
        fs.rmSync(CODE_FILE, { force: true })
        console.log('מחובר לוואטסאפ ✔')
        // The address book arrives only with the first sync after linking. A link made before names were collected
        // asks for that part again, once: the saved version is dropped so the whole list comes back.
        if (!store.wa.contactsSynced) {
          store.wa.contactsSynced = true
          save()
          sock.authState.keys
            .set({ 'app-state-sync-version': { critical_unblock_low: null } })
            .then(() => sock.resyncAppState(['critical_unblock_low'], true))
            .then(() => console.log(`[whatsapp] אנשי קשר: ${Object.keys(store.contacts).length}`))
            .catch((e) => console.log(`[whatsapp] אנשי קשר: ${e.message}`))
        }
        // Deferred a tick so the caller already holds the returned handle when this runs.
        setTimeout(() => Promise.resolve(onReady({ jid: ownIds()[0], lid: ownIds()[1] || null })).catch((e) => console.log(`[whatsapp] ${e.message}`)))
      }
      if (connection === 'close') {
        ready = false
        // A code belongs to the socket that asked for it; the next socket offers a new one.
        Object.assign(pairing, { qr: '', code: '' })
        const code = lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          console.log('החיבור נותק מהטלפון. מתחבר מחדש עם קוד QR חדש...')
        }
        // 3s, 6s, 12s ... up to a minute, so a long outage is not hammered with reconnects.
        const delay = Math.min(60000, 3000 * 2 ** attempts++)
        setTimeout(() => connect().catch((e) => console.log(`[whatsapp] ${e.message}`)), delay)
      }
    })

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        const jid = msg.key?.remoteJid
        if (!jid || !msg.message || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue
        if (!msg.key.fromMe && msg.pushName) learn([{ id: msg.key.senderPn || jid, notify: msg.pushName }], false)
        const sentAt = Number(msg.messageTimestamp)
        if (sentAt < since || seen.has(msg.key.id)) continue
        remember(msg.key.id, sentAt)
        const content = normalizeMessageContent(msg.message)
        const base = () => {
          const own = ownIds()
          const jids = [jid, msg.key.senderPn, msg.key.remoteJidAlt].filter(Boolean).map(jidNormalizedUser)
          // lateSeconds > 0: the message was written before this run started, while the assistant was off.
          return { jids, fromMe: Boolean(msg.key.fromMe), selfChat: jids.some((j) => own.includes(j)), key: msg.key, lateSeconds: Math.max(0, bootedAt - sentAt) }
        }
        // An emoji reaction arrives as its own message; an empty one means the reaction was removed.
        if (content?.reactionMessage) {
          const reaction = content.reactionMessage.text
          if (reaction) Promise.resolve(onMessage({ ...base(), text: '', reaction, getMedia: async () => null })).catch((e) => console.log(`[whatsapp] ${e.message}`))
          continue
        }
        // A shared 📍 or live location. Live location keeps sending updates; they arrive here the same way.
        const pin = content?.locationMessage || content?.liveLocationMessage
        const location = pin && Number.isFinite(pin.degreesLatitude) && Number.isFinite(pin.degreesLongitude)
          ? { lat: pin.degreesLatitude, lng: pin.degreesLongitude, name: pin.name || '', address: pin.address || '', live: Boolean(content.liveLocationMessage || pin.isLive) }
          : null
        const part = content?.imageMessage || content?.audioMessage || content?.documentMessage
        const text = content?.conversation || content?.extendedTextMessage?.text || part?.caption || pin?.comment || pin?.caption || ''
        if ((!text && !part && !location) || text.startsWith(BOT_MARK)) continue
        // Downloaded lazily, so media from chats the bot ignores is never fetched.
        const getMedia = async () => {
          if (!part) return null
          if (Number(part.fileLength) > MAX_MEDIA) throw new Error('הקובץ גדול מדי (מעל 15MB)')
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
          return { kind: content.imageMessage ? 'image' : content.audioMessage ? 'audio' : 'file', buffer, mime: part.mimetype || '', name: part.fileName || '' }
        }
        Promise.resolve(onMessage({ ...base(), text, getMedia, ...(location && { location }) })).catch((e) =>
          console.log(`[whatsapp] ${e.message}`)
        )
      }
    })
  }

  await connect()

  // Media cannot carry BOT_MARK, so its id is registered up front to keep the bot from answering itself.
  async function sendTracked(jid, content) {
    if (!ready) throw new Error('וואטסאפ לא מחובר כרגע')
    const messageId = '3EB0' + randomBytes(9).toString('hex').toUpperCase()
    remember(messageId)
    await deliver(jid, content, { messageId })
  }

  return {
    async send(jid, text) {
      if (!ready) throw new Error('וואטסאפ לא מחובר כרגע')
      let last
      for (let i = 0; i < text.length; i += 3500) last = await deliver(jid, { text: BOT_MARK + text.slice(i, i + 3500) })
      // The id WhatsApp knows the message by, for anyone who needs proof that it left.
      return last?.key?.id || null
    },
    sendVoice(jid, ogg) {
      return sendTracked(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true })
    },
    // media: { buffer, mime, caption? }. Images and videos show inline, audio plays, anything else arrives as a file.
    sendMedia(jid, { buffer, mime, caption, name }) {
      const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document'
      return sendTracked(jid, { [kind]: buffer, mimetype: mime, ...(kind !== 'audio' && caption && { caption }), ...(kind === 'document' && { fileName: name || 'file' }) })
    },
    // Puts an emoji on the message with this key; an empty string takes it off again.
    react(jid, key, emoji) {
      return sendTracked(jid, { react: { text: emoji, key } })
    },
    // A message to someone else, in the owner's name, exactly as written (no invisible bot mark).
    sendAs(jid, text) {
      return sendTracked(jid, { text })
    },
    // "דני" or "050-1234567" -> { jid, name, number }, { matches: [...] } when the name is ambiguous, or { error }.
    async findContact(query) {
      if (!ready) return { error: 'וואטסאפ לא מחובר כרגע' }
      const q = String(query || '').trim()
      let digits = q.replace(/\D/g, '')
      if (digits.length >= 9) {
        if (digits.startsWith('0')) digits = '972' + digits.slice(1)
        const [hit] = await sock.onWhatsApp(`${digits}@s.whatsapp.net`).catch(() => [])
        if (!hit?.exists) return { error: `למספר +${digits} אין וואטסאפ` }
        const jid = jidNormalizedUser(hit.jid)
        return { jid, number: `+${digits}`, name: store.contacts[jid] || `+${digits}` }
      }
      const lower = q.toLowerCase()
      const all = Object.entries(store.contacts).filter(([jid]) => !ownIds().includes(jid))
      const exact = all.filter(([, name]) => name.toLowerCase() === lower)
      const partial = exact.length ? exact : all.filter(([, name]) => name.toLowerCase().includes(lower))
      if (!partial.length) return { error: `לא מצאתי איש קשר בשם "${q}". צריך את המספר שלו.` }
      if (partial.length > 1) return { matches: partial.slice(0, 6).map(([jid, name]) => `${name} (+${jid.split('@')[0]})`) }
      const [jid, name] = partial[0]
      return { jid, name, number: `+${jid.split('@')[0]}` }
    },
    // When the current connection opened, or 0 while disconnected.
    connectedSince: () => (ready ? openedAt : 0),
    typing(jid) {
      if (ready) sock.sendPresenceUpdate('composing', target(jid)).catch(() => {})
    },
  }
}
